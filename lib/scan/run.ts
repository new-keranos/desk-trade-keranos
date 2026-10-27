import "server-only";
import { TV, type TvCaller } from "../tradingview";
import { judgeBatch, type Bars, type Stock } from "./judge";
import { AiBusy, aiReason, type RefImage } from "./llm";
import { resample, type Length } from "./match";
import type { Template } from "./templates";
import { loadUniverse, THEMES, UNIVERSES, type ThemeId, type UniverseId } from "./universe";

/** TradingView allows about 100 tool calls a minute, so one scan checks at most this many stocks (largest first). */
export const MAX_SCAN = 80;
const CONCURRENCY = 6;
const BARS = 260;
/** Stocks per AI request, and AI requests at once (the Gemini free tier allows only a few a minute). */
const BATCH = 8;
const AI_CONCURRENCY = 2;
const MIN_CONFIDENCE = 60;
const BUSY_WAIT_MS = 35_000;

export type ScanPoint = { k: number; date: string; price: number; label?: string };
export type ScanLine = { from: { date: string; price: number }; to: { date: string; price: number }; role: "upper" | "lower" | "level"; label: string; extend: boolean };
export type ScanRow = {
  symbol: string; name: string; description?: string; sector?: string; close?: number; change?: number;
  /** The AI's confidence that this is the pattern, 0-100. */
  score: number; bars: number; from: string; to: string; heightPct: number; closes: number[];
  /** The AI's evidence, the turning points (k = bar offset inside the pattern) and lines it marked. */
  checks: string[]; points: ScanPoint[]; lines: ScanLine[];
  stage?: string; summary?: string; breakout?: number; invalidation?: number;
};
export type ScanEvent =
  | { type: "status"; text: string; done?: number; total?: number }
  | { type: "results"; rows: ScanRow[]; checked: number; skipped: number; note?: string }
  | { type: "error"; message: string }
  | { type: "done" };

export type ScanOptions = { tv: TvCaller; universe: UniverseId; themes: ThemeId[]; length: Length; template?: Template; image?: RefImage; limit?: number; signal?: AbortSignal };

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((ok) => { const id = setTimeout(ok, ms); signal?.addEventListener("abort", () => { clearTimeout(id); ok(); }, { once: true }); });

export async function runScan(o: ScanOptions, emit: (e: ScanEvent) => void): Promise<Extract<ScanEvent, { type: "results" }>> {
  const where = UNIVERSES[o.universe].label + (o.themes.length ? " · " + o.themes.map((t) => THEMES[t].label).join(", ") : "");
  emit({ type: "status", text: `Loading ${where} from TradingView` });
  const { stocks } = await loadUniverse(o.tv, o.universe, o.themes);
  if (!stocks.length) {
    const r = { type: "results" as const, rows: [], checked: 0, skipped: 0, note: `No stocks in ${where}.` };
    emit(r);
    return r;
  }
  const list = stocks.slice(0, MAX_SCAN);
  const notes: string[] = [];
  if (stocks.length > MAX_SCAN) notes.push(`Checked the ${MAX_SCAN} largest of ${stocks.length} stocks. Pick a theme to narrow the list.`);

  // 1. Daily bars from TradingView.
  const loaded: Stock[] = [];
  let done = 0, skipped = 0, next = 0;
  emit({ type: "status", text: `Loading ${list.length} charts`, done: 0, total: list.length });
  const fetcher = async () => {
    while (next < list.length && !o.signal?.aborted) {
      const s = list[next++];
      try {
        const p = (await o.tv(TV.ohlcv, { symbol: s.symbol, interval: "1D", count: BARS, format: "columns" })) as { bars?: Bars };
        const b = p?.bars;
        if (b?.c?.length && b.c.length >= 30) loaded.push({ symbol: s.symbol, name: s.name, bars: { t: b.t, h: b.h, l: b.l, c: b.c } });
      } catch {
        skipped++;
      }
      done++;
      if (done % 4 === 0 || done === list.length) emit({ type: "status", text: `Loaded ${done} of ${list.length} charts`, done, total: list.length });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, fetcher));
  if (skipped) notes.push(`${skipped} charts couldn't be loaded, likely TradingView's per-minute limit. Wait a minute and scan again to include them.`);

  // 2. The AI reads the charts in batches and judges each one against the pattern.
  const batches: Stock[][] = [];
  for (let k = 0; k < loaded.length; k += BATCH) batches.push(loaded.slice(k, k + BATCH));
  const verdicts: Awaited<ReturnType<typeof judgeBatch>> = [];
  let read = 0, unread = 0, nb = 0, failed = 0, reason = "";
  emit({ type: "status", text: `AI is reading ${loaded.length} charts`, done: 0, total: loaded.length });
  const reader = async () => {
    while (nb < batches.length && !o.signal?.aborted) {
      const batch = batches[nb++];
      for (let attempt = 0; ; attempt++) {
        try {
          verdicts.push(...(await judgeBatch(batch, o)));
          break;
        } catch (err) {
          if (o.signal?.aborted) return;
          if (err instanceof AiBusy && attempt < 2) {
            emit({ type: "status", text: "AI rate limit reached, waiting a moment", done: read, total: loaded.length });
            await wait(BUSY_WAIT_MS, o.signal);
            continue;
          }
          console.error("scan: AI batch failed", err);
          unread += batch.length;
          if (!(err instanceof AiBusy)) { failed++; reason ||= aiReason(err); }
          break;
        }
      }
      read += batch.length;
      emit({ type: "status", text: `AI read ${read} of ${loaded.length} charts`, done: read, total: loaded.length });
    }
  };
  await Promise.all(Array.from({ length: AI_CONCURRENCY }, reader));
  if (unread) notes.push(`The AI couldn't read ${unread} charts (${reason || "rate limit"}). Scan again in a minute to include them.`);
  if (unread === loaded.length && loaded.length) throw new Error(failed ? `The AI couldn't read the charts: ${reason}.` : "AI rate limit reached. Wait a minute and try again.");

  const info = new Map(list.map((s) => [s.symbol, s]));
  const rows: ScanRow[] = verdicts.filter((v) => v.confidence >= MIN_CONFIDENCE).map((v) => {
    const s = info.get(v.symbol)!, b = loaded.find((x) => x.symbol === v.symbol)!.bars;
    const win = b.c.slice(v.start, v.end + 1);
    const lo = Math.min(...b.l.slice(v.start, v.end + 1)), hi = Math.max(...b.h.slice(v.start, v.end + 1));
    const at = (k: number, price: number) => ({ date: day(b.t[k]), price });
    return { symbol: s.symbol, name: s.name, description: s.description, sector: s.sector, close: s.close, change: s.change,
      score: v.confidence, bars: v.end - v.start + 1, from: day(b.t[v.start]), to: day(b.t[v.end]),
      heightPct: lo > 0 ? Math.round(((hi - lo) / lo) * 1000) / 10 : 0, closes: win.length > 96 ? resample(win, 96) : win,
      checks: v.evidence, points: v.points.map((p) => ({ k: p.k - v.start, date: day(b.t[p.k]), price: p.price, label: p.label })),
      lines: v.lines.map((l) => ({ from: at(l.k1, l.p1), to: at(l.k2, l.p2), role: l.role, label: l.label, extend: l.extend })),
      stage: v.stage, summary: v.summary, breakout: v.breakout, invalidation: v.invalidation };
  });
  rows.sort((a, b) => b.score - a.score);
  const r = { type: "results" as const, rows: rows.slice(0, o.limit ?? 20), checked: loaded.length - unread, skipped: skipped + unread, note: notes.join(" ") || undefined };
  emit(r);
  return r;
}
