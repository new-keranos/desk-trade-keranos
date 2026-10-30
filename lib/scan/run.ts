import "server-only";
import type { ModelChoice } from "../nova/config";
import { TV, TvQuotaError, type TvCaller } from "../tradingview";
import { cachedBars, cachedJson, storeBars } from "./cache";
import { judgeBatch, verifyMatch, type Bars, type Feedback, type Stock, type Verdict } from "./judge";
import { AiBusy, aiReason, type RefImage } from "./llm";
import { resample, type Length } from "./match";
import type { Template } from "./templates";
import { rank, snapshots } from "./prefilter";
import { loadUniverse, THEMES, UNIVERSES, type ThemeId, type UniverseId } from "./universe";

/** Charts fetched per request; the browser asks for the next page a minute later. Small pages keep TradingView
 * calls spread out and each request well inside the server's time limit. */
export const PAGE = 20;
/** Stop starting AI work this long into a request, so it returns its results before the 300 s limit cuts it off. */
const BUDGET_MS = 230_000;
/** Most stocks one scan reads quote data for (largest first), 50 per get_symbol_data_batch call.
 * TradingView suspended an account after full S&P 500 scans (about 500 chart calls in a few minutes). */
export const MAX_STOCKS = 200;
/** Most charts (one get_ohlcv call each) one scan fetches: the best fits from the quote data. */
export const MAX_CHARTS = 60;
const CONCURRENCY = 3;
const BARS = 260;
/** Stocks per AI request, and AI requests at once (the Gemini free tier allows only a few a minute). */
const BATCH = 6;
const AI_CONCURRENCY = 2;
const MIN_CONFIDENCE = 70;
const BUSY_WAIT_MS = 35_000;

export type ScanPoint = { k: number; date: string; price: number; label?: string };
export type ScanLine = { from: { date: string; price: number }; to: { date: string; price: number }; role: "upper" | "lower" | "level"; label: string; extend: boolean };
export type ScanRow = {
  /** Unique per match: one stock can hold the pattern more than once. */
  id: string;
  symbol: string; name: string; description?: string; sector?: string; close?: number; change?: number;
  /** The AI's confidence that this is the pattern, 0-100. */
  score: number; bars: number; from: string; to: string; heightPct: number; closes: number[];
  /** The AI's evidence, the turning points (k = bar offset inside the pattern) and lines it marked. */
  checks: string[]; points: ScanPoint[]; lines: ScanLine[];
  stage?: string; summary?: string; breakout?: number; invalidation?: number;
  /** true: a second model confirmed it; false: the check couldn't run, so this is the first read only. */
  verified?: boolean;
};
export type ScanEvent =
  | { type: "status"; text: string; done?: number; total?: number; phase?: "load" | "ai" }
  /** Sent first: where this page sits in the market, so the browser can carry on if the page fails later. */
  | { type: "page"; total: number; next?: number }
  /** Matches from one AI batch, sent as soon as the AI has read it. */
  | { type: "match"; rows: ScanRow[] }
  | { type: "results"; rows: ScanRow[]; checked: number; skipped: number; note?: string; total: number; next?: number }
  | { type: "error"; message: string; stop?: boolean; until?: number }
  | { type: "done" };

export type ScanOptions = { ai: ModelChoice; verify?: ModelChoice; feedback?: Feedback[]; tv: TvCaller; universe: UniverseId; themes: ThemeId[]; length: Length; template?: Template; image?: RefImage; limit?: number; offset?: number; signal?: AbortSignal };

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((ok) => { const id = setTimeout(ok, ms); signal?.addEventListener("abort", () => { clearTimeout(id); ok(); }, { once: true }); });

export async function runScan(o: ScanOptions, emit: (e: ScanEvent) => void): Promise<Extract<ScanEvent, { type: "results" }>> {
  const deadline = Date.now() + BUDGET_MS;
  const where = UNIVERSES[o.universe].label + (o.themes.length ? " · " + o.themes.map((t) => THEMES[t].label).join(", ") : "");
  emit({ type: "status", text: `Loading ${where} from TradingView` });
  const { stocks: all } = await cachedJson(`universe:${o.universe}:${o.themes.join(",")}`, () => loadUniverse(o.tv, o.universe, o.themes));
  const members = all.slice(0, MAX_STOCKS);
  if (members.length) emit({ type: "status", text: `Reading quote data for ${members.length} stocks` });
  const snaps = members.length ? await cachedJson(`snap:${o.universe}:${o.themes.join(",")}`, () => snapshots(o.tv, members.map((s) => s.symbol))) : {};
  const likely = rank(members, snaps, o.template?.id);
  const stocks = likely.slice(0, MAX_CHARTS);
  if (!stocks.length) {
    const r = { type: "results" as const, rows: [], checked: 0, skipped: 0, total: 0, note: members.length ? `None of the ${members.length} stocks in ${where} fit ${o.template?.name ?? "the pattern"} from their quote data.` : `No stocks in ${where}.` };
    emit(r);
    return r;
  }
  const offset = Math.max(0, o.offset ?? 0);
  const list = stocks.slice(offset, offset + PAGE);
  const nextPage = offset + PAGE < stocks.length ? offset + PAGE : undefined;
  const notes: string[] = [];
  if (offset === 0) {
    if (all.length > MAX_STOCKS) notes.push(`Read the ${MAX_STOCKS} largest of ${all.length} stocks, to stay inside TradingView's limits. Pick a theme to reach the others.`);
    if (stocks.length < members.length) notes.push(`Quote data narrowed ${members.length} stocks to ${likely.length} that could fit this pattern; the ${stocks.length} best fits were checked chart by chart.`);
  }
  emit({ type: "page", total: stocks.length, next: nextPage });

  // 1. Daily bars from TradingView.
  const loaded: Stock[] = [];
  let done = 0, skipped = 0, next = 0;
  const part = stocks.length > PAGE ? ` (${offset + 1}-${offset + list.length} of ${stocks.length})` : "";
  emit({ type: "status", text: `Loading ${list.length} charts${part}`, done: 0, total: list.length, phase: "load" });
  let refused: TvQuotaError | null = null, fetched = 0;
  const fetcher = async () => {
    while (next < list.length && !o.signal?.aborted && !refused) {
      const s = list[next++];
      try {
        let b = await cachedBars(s.symbol, BARS);
        if (!b) {
          fetched++;
          const p = (await o.tv(TV.ohlcv, { symbol: s.symbol, interval: "1D", count: BARS, format: "columns" })) as { bars?: Bars };
          b = p?.bars ? { t: p.bars.t, o: p.bars.o, h: p.bars.h, l: p.bars.l, c: p.bars.c, v: p.bars.v } : null;
          if (b?.c?.length) await storeBars(s.symbol, BARS, b);
        }
        if (b?.c?.length && b.c.length >= 30) loaded.push({ symbol: s.symbol, name: s.name, bars: b });
      } catch (err) {
        // TradingView refused the account: stop at once, every further call makes it worse.
        if (err instanceof TvQuotaError) { refused = err; return; }
        skipped++;
      }
      done++;
      if (done % 4 === 0 || done === list.length) emit({ type: "status", text: `Loaded ${done} of ${list.length} charts`, done, total: list.length, phase: "load" });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, fetcher));
  if (refused) throw refused;
  if (skipped) notes.push(`${skipped} charts couldn't be loaded, likely TradingView's per-minute limit. Wait a minute and scan again to include them.`);

  // AI verdicts to result rows. One stock can match more than once; a match that mostly overlaps a stronger one for the same stock is dropped.
  const info = new Map(list.map((s) => [s.symbol, s]));
  const toRows = (vs: (Verdict & { verified?: boolean })[]): ScanRow[] => {
    const kept: typeof vs = [];
    for (const v of vs.filter((x) => x.confidence >= MIN_CONFIDENCE).sort((a, b) => b.confidence - a.confidence)) {
      const dup = kept.some((k) => k.symbol === v.symbol && Math.min(k.end, v.end) - Math.max(k.start, v.start) > 0.6 * Math.min(k.end - k.start, v.end - v.start));
      if (!dup) kept.push(v);
    }
    return kept.map((v) => {
      const s = info.get(v.symbol)!, b = loaded.find((x) => x.symbol === v.symbol)!.bars;
      const win = b.c.slice(v.start, v.end + 1);
      const lo = Math.min(...b.l.slice(v.start, v.end + 1)), hi = Math.max(...b.h.slice(v.start, v.end + 1));
      const at = (k: number, price: number) => ({ date: day(b.t[k]), price });
      return { id: `${v.symbol}@${day(b.t[v.start])}`, symbol: s.symbol, name: s.name, description: s.description, sector: s.sector, close: s.close, change: s.change,
        score: v.confidence, bars: v.end - v.start + 1, from: day(b.t[v.start]), to: day(b.t[v.end]),
        heightPct: lo > 0 ? Math.round(((hi - lo) / lo) * 1000) / 10 : 0, closes: win.length > 96 ? resample(win, 96) : win,
        checks: v.evidence, points: v.points.map((p) => ({ k: p.k - v.start, date: day(b.t[p.k]), price: p.price, label: p.label })),
        lines: v.lines.map((l) => ({ from: at(l.k1, l.p1), to: at(l.k2, l.p2), role: l.role, label: l.label, extend: l.extend })),
        stage: v.stage, summary: v.summary, breakout: v.breakout, invalidation: v.invalidation, verified: v.verified };
    });
  };

  // 2. The AI reads the charts in batches and judges each one against the pattern.
  const batches: Stock[][] = [];
  for (let k = 0; k < loaded.length; k += BATCH) batches.push(loaded.slice(k, k + BATCH));
  const verdicts: (Verdict & { verified?: boolean })[] = [];
  let read = 0, unread = 0, unreadLate = 0, nb = 0, failed = 0, reason = "";
  emit({ type: "status", text: `AI is reading ${loaded.length} charts`, done: 0, total: loaded.length, phase: "ai" });
  // 3. A second model double-checks each candidate with a picture of its chart. A rejected one is dropped;
  // if the check itself fails (rate limit, error), the first read is kept and shown as unverified.
  const verify = async (vs: Verdict[], batch: Stock[]): Promise<(Verdict & { verified?: boolean })[]> => {
    if (!o.verify) return vs;
    if (Date.now() > deadline) return vs.map((v) => ({ ...v, verified: false }));
    const out = await Promise.all(vs.filter((v) => v.confidence >= MIN_CONFIDENCE).map(async (v) => {
      try {
        const r = await verifyMatch(batch.find((s) => s.symbol === v.symbol)!, v, { ...o, ai: o.verify! });
        return r && r.confidence >= MIN_CONFIDENCE ? { ...r, verified: true } : null;
      } catch (err) {
        if (o.signal?.aborted) return null;
        console.error("scan: verify failed", err);
        return { ...v, verified: false };
      }
    }));
    return out.filter((v) => v != null);
  };
  const reader = async () => {
    while (nb < batches.length && !o.signal?.aborted) {
      if (Date.now() > deadline) { unreadLate += batches.slice(nb).reduce((n, b) => n + b.length, 0); nb = batches.length; break; }
      const batch = batches[nb++];
      for (let attempt = 0; ; attempt++) {
        try {
          const got = await verify(await judgeBatch(batch, o), batch);
          verdicts.push(...got);
          const rows = toRows(got);
          if (rows.length) emit({ type: "match", rows });
          break;
        } catch (err) {
          if (o.signal?.aborted) return;
          if (err instanceof AiBusy && attempt < 2 && Date.now() + BUSY_WAIT_MS < deadline) {
            emit({ type: "status", text: "AI rate limit reached, waiting a moment", done: read, total: loaded.length, phase: "ai" });
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
      emit({ type: "status", text: `AI read ${read} of ${loaded.length} charts${o.verify ? " (and double-checked the matches)" : ""}`, done: read, total: loaded.length, phase: "ai" });
    }
  };
  await Promise.all(Array.from({ length: AI_CONCURRENCY }, reader));
  unread += unreadLate;
  if (unreadLate) notes.push(`${unreadLate} charts were left unread because the request ran out of time.`);
  if (unread - unreadLate) notes.push(`The AI couldn't read ${unread - unreadLate} charts (${reason || "rate limit"}). Scan again in a minute to include them.`);
  // On a market scanned in pages, a bad page is reported and the browser carries on with the next one.
  if (unread === loaded.length && loaded.length && stocks.length <= PAGE) throw new Error(failed ? `The AI couldn't read the charts: ${reason}.` : "AI rate limit reached. Wait a minute and try again.");

  const rows = toRows(verdicts);
  rows.sort((a, b) => b.score - a.score);
  const r = { type: "results" as const, rows: o.limit ? rows.slice(0, o.limit) : rows, checked: loaded.length - unread, skipped: skipped + unread,
    note: notes.join(" ") || undefined, total: stocks.length, next: nextPage };
  emit(r);
  return r;
}
