import "server-only";
import { TV, type TvCaller } from "../tradingview";
import { bestMatch, resample, type Length } from "./match";
import type { Template } from "./templates";
import { loadUniverse, THEMES, UNIVERSES, type ThemeId, type UniverseId } from "./universe";

/** TradingView allows about 100 tool calls a minute, so one scan checks at most this many stocks (largest first). */
export const MAX_SCAN = 80;
const CONCURRENCY = 6;
const BARS = 260;
const MIN_SCORE = 0.6;

export type ScanRow = {
  symbol: string; name: string; description?: string; sector?: string; close?: number; change?: number;
  score: number; bars: number; from: string; to: string; heightPct: number; closes: number[];
  /** Rules the match passed, and the real turning points (k = bar offset inside the window). */
  checks: string[]; points: { k: number; date: string; price: number }[];
};
export type ScanEvent =
  | { type: "status"; text: string; done?: number; total?: number }
  | { type: "shape"; name: string; bias: string; points: number[] }
  | { type: "results"; rows: ScanRow[]; checked: number; skipped: number; note?: string }
  | { type: "error"; message: string }
  | { type: "done" };

export type ScanOptions = { tv: TvCaller; universe: UniverseId; themes: ThemeId[]; length: Length; shape: number[]; template?: Template; limit?: number; signal?: AbortSignal };

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

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
  const note = stocks.length > MAX_SCAN ? `Checked the ${MAX_SCAN} largest of ${stocks.length} stocks. Pick a theme to narrow the list.` : undefined;

  const rows: ScanRow[] = [];
  let done = 0, skipped = 0, next = 0;
  emit({ type: "status", text: `Checking ${list.length} charts`, done: 0, total: list.length });
  const worker = async () => {
    while (next < list.length && !o.signal?.aborted) {
      const s = list[next++];
      try {
        const p = (await o.tv(TV.ohlcv, { symbol: s.symbol, interval: "1D", count: BARS, format: "columns" })) as { bars?: { t: number[]; c: number[] } };
        const c = p?.bars?.c ?? [], t = p?.bars?.t ?? [];
        const m = c.length >= 30 ? bestMatch(c, o.shape, o.length, o.template) : null;
        if (m && m.score >= MIN_SCORE) {
          const win = c.slice(m.start, m.end);
          rows.push({ symbol: s.symbol, name: s.name, description: s.description, sector: s.sector, close: s.close, change: s.change,
            score: Math.round(m.score * 100), bars: m.end - m.start, from: day(t[m.start]), to: day(t[m.end - 1]),
            heightPct: Math.round(m.heightPct * 10) / 10, closes: win.length > 96 ? resample(win, 96) : win,
            checks: m.checks, points: m.points.map((p) => ({ k: p.k, date: day(t[m.start + p.k]), price: p.price })) });
        }
      } catch {
        skipped++;
      }
      done++;
      if (done % 4 === 0 || done === list.length) emit({ type: "status", text: `Checked ${done} of ${list.length} charts`, done, total: list.length });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  rows.sort((a, b) => b.score - a.score);
  const skipNote = skipped ? `${skipped} charts couldn't be loaded, likely TradingView's per-minute limit. Wait a minute and scan again to include them.` : undefined;
  const r = { type: "results" as const, rows: rows.slice(0, o.limit ?? 20), checked: done - skipped, skipped, note: [note, skipNote].filter(Boolean).join(" ") || undefined };
  emit(r);
  return r;
}
