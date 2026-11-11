import "server-only";
import type { ModelChoice } from "../nova/config";
import { hasRedis, TV, TvQuotaError, type TvCaller } from "../tradingview";
import { cachedBars, cachedJson, storeBars } from "./cache";
import { judgeBatch, verifyMatch, type Bars, type Feedback, type Stock, type Verdict } from "./judge";
import { AiBusy, aiReason, type RefImage } from "./llm";
import { resample, type Length } from "./match";
import type { Template } from "./templates";
import { rank } from "./prefilter";
import { DETECTORS, detect, type Detection, type TrackState } from "./pivots";
import { advance, forget, loadStates, saveStates, seedFromBars, seedsToday, SEEDS_PER_DAY } from "./tracker";
import { loadUniverse, THEMES, UNIVERSES, type ThemeId, type UniverseId } from "./universe";
import { MIN_SCREEN, passes, screen, type Screen } from "./screen";
import { addBacktest, analyze, backtest, HORIZON, type Backtest, type RuleHit } from "./rules";

/** Charts fetched per request; the browser asks for the next page a minute later. Small pages keep TradingView
 * calls spread out and each request well inside the server's time limit. */
export const PAGE = 20;
/** Stop starting AI work this long into a request, so it returns its results before the 300 s limit cuts it off. */
const BUDGET_MS = 230_000;
/** Most charts (one get_ohlcv call each) one scan fetches: the best fits from the quote data.
 * TradingView suspended an account after full S&P 500 scans (about 500 chart calls in a few minutes). */
export const MAX_CHARTS = 60;
const CONCURRENCY = 3;
const BARS = 260;
/** Stocks per AI request, and AI requests at once (the Gemini free tier allows only a few a minute). */
const BATCH = 6;
const AI_CONCURRENCY = 2;
const MIN_CONFIDENCE = 70;
/** Pattern-detector score a tracked stock needs before the AI reads its chart, and most such stocks per scan. */
const MIN_DETECT = 70;
const MAX_DETECTED = 20;
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
  /** Who found it: the AI, the indicator rules, or both (compare mode). Missing on AI-only scans. */
  by?: "ai" | "rule" | "both";
  /** The indicator rules' score for the same stock, when the AI found it too (compare mode). */
  rule?: number;
  /** Indicator checks at the latest bar (rules and compare modes). */
  indicators?: { ok: boolean; text: string }[];
  /** This stock's past signals from the same rules, over the bars loaded. */
  bt?: BtSummary;
};
/** Backtest totals without the trade list, small enough to send and save. */
export type BtSummary = { signals: number; wins: number; losses: number; open: number; avgRet: number; horizon: number };
/** How the charts are judged: by the AI, by the indicator rules only (no AI call), both side by side, or the AI
 * reading only the stocks that pass an indicator screen from the screener columns (screen_ai). */
export type Analyzer = "ai" | "rules" | "compare" | "screen_ai";
/** Most stocks the indicator screen passes to get_ohlcv and the AI in one scan (one page). */
export const MAX_SCREENED = 20;
export type ScanEvent =
  | { type: "status"; text: string; done?: number; total?: number; phase?: "load" | "ai" }
  /** Sent first: where this page sits in the market, so the browser can carry on if the page fails later. */
  | { type: "page"; total: number; next?: number }
  /** Matches from one AI batch, sent as soon as the AI has read it. */
  | { type: "match"; rows: ScanRow[] }
  | { type: "results"; rows: ScanRow[]; checked: number; skipped: number; note?: string; total: number; next?: number;
      /** Indicator rules replayed over this page's charts (rules and compare modes). */
      backtest?: BtSummary;
      /** Matches by who found them (compare mode). */
      compare?: { ai: number; rule: number; both: number } }
  | { type: "error"; message: string; stop?: boolean; until?: number }
  | { type: "done" };

export type ScanOptions = { analyzer?: Analyzer; ai: ModelChoice; verify?: ModelChoice; feedback?: Feedback[]; tv: TvCaller; universe: UniverseId; themes: ThemeId[]; length: Length; template?: Template; image?: RefImage; limit?: number; offset?: number; signal?: AbortSignal };

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((ok) => { const id = setTimeout(ok, ms); signal?.addEventListener("abort", () => { clearTimeout(id); ok(); }, { once: true }); });

export async function runScan(o: ScanOptions, emit: (e: ScanEvent) => void): Promise<Extract<ScanEvent, { type: "results" }>> {
  const deadline = Date.now() + BUDGET_MS;
  const where = UNIVERSES[o.universe].label + (o.themes.length ? " · " + o.themes.map((t) => THEMES[t].label).join(", ") : "");
  emit({ type: "status", text: `Loading ${where} from TradingView` });
  // One run_screener call lists the market with each stock's quote snapshot (cached 4 h).
  const { stocks: members, snaps, prev, inds = {} } = await cachedJson(`universe4:${o.universe}:${o.themes.join(",")}`, () => loadUniverse(o.tv, o.universe, o.themes));
  const likely = rank(members, snaps, o.template?.id);
  // Needs Redis: on serverless hosting each request may run in a fresh instance, so states kept only in memory
  // would be lost between pages and every stock would be seeded again and again.
  // Compare mode skips it, so the AI and the rules read the same charts (the tracker would pick them by rule).
  if (o.analyzer === "screen_ai" && o.template && members.length) return runScreened(o, emit, { members, likely, inds, where, deadline });
  const tracked = !o.image && !!o.template && !!DETECTORS[o.template.id] && o.analyzer !== "compare" && process.env.PATTERN_TRACKER !== "0" && hasRedis();
  if (tracked && members.length) return runTracked(o, emit, { members, likely, prev, where, deadline });
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
    if (stocks.length < members.length) notes.push(`Quote data narrowed ${members.length} stocks to ${likely.length} that could fit this pattern; the ${stocks.length} best fits were checked chart by chart.`);
  }
  emit({ type: "page", total: stocks.length, next: nextPage });

  return readCharts(o, emit, { list, total: stocks.length, next: nextPage, notes, deadline });
}

type Member = Awaited<ReturnType<typeof loadUniverse>>["stocks"][number];
type Plan = { list: Member[]; total: number; next?: number; notes: string[]; deadline: number;
  /** Indicator screen results for the listed stocks (screen_ai), shown on their rows. */
  screened?: Map<string, Screen>;
  /** Runs on the loaded charts before the AI reads them; returns the ones the AI should read. */
  pick?: (loaded: Stock[]) => Promise<Stock[]> };

/** Indicator screen → AI: the screener columns (already on the call that listed the market) score every stock's
 * indicators against the pattern's direction. Only the best that pass the screen and fit the pattern's shape
 * from the quote data get a get_ohlcv call and an AI read: at most MAX_SCREENED, in one page. */
async function runScreened(o: ScanOptions, emit: (e: ScanEvent) => void, c: { members: Member[]; likely: Member[]; inds: Record<string, Awaited<ReturnType<typeof loadUniverse>>["inds"][string]>; where: string; deadline: number }) {
  const t = o.template!;
  emit({ type: "status", text: `Screening ${c.members.length} stocks by indicators` });
  const results = new Map<string, Screen>();
  const order = new Map(c.likely.map((m, i) => [m.symbol, i]));
  for (const m of c.likely) { const r = screen(c.inds[m.symbol] ?? {}, t.id, t.bias); if (passes(r)) results.set(m.symbol, r); }
  // Best screen score first; ties keep the quote-data fit order.
  const passed = c.likely.filter((m) => results.has(m.symbol))
    .sort((a, b) => results.get(b.symbol)!.score - results.get(a.symbol)!.score || order.get(a.symbol)! - order.get(b.symbol)!);
  const list = passed.slice(0, MAX_SCREENED);
  const notes = [`Indicator screen: ${c.likely.length} of ${c.members.length} stocks in ${c.where} could fit ${t.name} from their quote data, ${passed.length} also passed the indicator screen (score ${MIN_SCREEN}+); ${list.length < passed.length ? `the best ${list.length} were` : list.length === 1 ? "it was" : `all ${list.length} were`} charted and read by the AI.`];
  emit({ type: "page", total: list.length });
  if (!list.length) {
    const r = { type: "results" as const, rows: [], checked: 0, skipped: 0, total: 0, note: notes[0] };
    emit(r);
    return r;
  }
  return readCharts({ ...o, offset: 0 }, emit, { list, total: list.length, notes, deadline: c.deadline, screened: new Map(list.map((m) => [m.symbol, results.get(m.symbol)!])) });
}

/** Pattern-detector scan: every stock in the market keeps a small pivot state, brought up to date from the
 * screener call that listed the market. Only stocks whose state scores a match cost a chart call and an AI read.
 * Stocks without a state yet are seeded from their chart, a page at a time (and at most SEEDS_PER_DAY a day). */
async function runTracked(o: ScanOptions, emit: (e: ScanEvent) => void, c: { members: Member[]; likely: Member[]; prev: Record<string, Awaited<ReturnType<typeof loadUniverse>>["prev"][string]>; where: string; deadline: number }) {
  const id = o.template!.id, offset = Math.max(0, o.offset ?? 0);
  emit({ type: "status", text: "Updating pattern tracker from the screener" });
  const states = await loadStates(c.members.map((m) => m.symbol));
  const changed = new Map<string, TrackState>(), stale: string[] = [];
  for (const [sym, st] of states) {
    const p = c.prev[sym];
    if (!p) continue;
    const r = advance(st, p);
    if (r === "added") changed.set(sym, st);
    else if (r === "stale") { stale.push(sym); states.delete(sym); }
  }
  await saveStates(changed);
  if (stale.length) await forget(stale);

  // Matches among stocks already tracked: reported on the first page only.
  const found = new Map<string, Detection>();
  if (offset === 0) {
    for (const m of c.members) {
      const st = states.get(m.symbol), d = st && detect(st, id);
      if (d && d.score >= MIN_DETECT) found.set(m.symbol, d);
    }
  }
  const hits = [...found].sort((a, b) => b[1].score - a[1].score).slice(0, MAX_DETECTED).map(([s]) => s);
  const bySymbol = new Map(c.members.map((m) => [m.symbol, m]));
  // Stocks still to seed: the likely fits from the quote data first, then the rest of the market. `offset` is a
  // cursor into this fixed order, so the pages always end (at most one pass over the market), even if a state
  // didn't stick.
  const order = [...c.likely, ...c.members.filter((m) => !c.likely.includes(m))];
  const unseeded = order.filter((m) => !states.has(m.symbol));
  const budget = Math.max(0, SEEDS_PER_DAY - (await seedsToday()));
  const room = Math.min(budget, Math.max(0, PAGE - hits.length));
  const toSeed: Member[] = [];
  let k = offset;
  for (; k < order.length && toSeed.length < room; k++) if (!states.has(order[k].symbol)) toSeed.push(order[k]);
  const left = order.slice(k).filter((m) => !states.has(m.symbol)).length;
  const next = left > 0 && budget > toSeed.length ? k : undefined;
  const list = [...hits.map((s) => bySymbol.get(s)!), ...toSeed];
  const notes: string[] = [];
  if (offset === 0) {
    notes.push(`Pattern detector: ${states.size} of ${c.members.length} stocks in ${c.where} are tracked; ${found.size} look like ${o.template!.name} (score ${MIN_DETECT}+)${found.size > hits.length ? `, the best ${hits.length} were checked` : ""}.`);
    if (unseeded.length) notes.push(`${unseeded.length} stocks aren't tracked yet; up to ${Math.min(unseeded.length, budget)} are being added in this scan${unseeded.length > budget ? ` (up to ${SEEDS_PER_DAY} a day, the rest on later days)` : ""}.`);
    if (stale.length) notes.push(`${stale.length} stocks had a gap in their daily bars and will be added again.`);
  }
  const total = order.length;
  emit({ type: "page", total, next });
  emit({ type: "status", text: `${found.size} tracked stocks match; adding ${toSeed.length} new ones` });
  if (!list.length) {
    const r = { type: "results" as const, rows: [], checked: 0, skipped: 0, total, next, note: notes.join(" ") || `No stock in ${c.where} looks like ${o.template!.name} right now.` };
    emit(r);
    return r;
  }
  const seedSet = new Set(toSeed.map((m) => m.symbol));
  return readCharts(o, emit, { list, total, next, notes, deadline: c.deadline,
    pick: async (loaded) => {
      const seeded = new Map<string, TrackState>();
      const keep = loaded.filter((s) => {
        if (!seedSet.has(s.symbol)) return true;
        const st = seedFromBars(s.bars, c.prev[s.symbol]);
        if (!st) return false;
        seeded.set(s.symbol, st);
        const d = detect(st, id);
        return !!d && d.score >= MIN_DETECT;
      });
      await saveStates(seeded);
      await seedsToday(seeded.size);
      return keep;
    } });
}

async function readCharts(o: ScanOptions, emit: (e: ScanEvent) => void, plan: Plan): Promise<Extract<ScanEvent, { type: "results" }>> {
  const { list, notes, deadline } = plan, stocks = { length: plan.total }, nextPage = plan.next, offset = Math.max(0, o.offset ?? 0);
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
  const info = new Map(list.map((s) => [s.symbol, s]));
  if (plan.pick) { const keep = await plan.pick(loaded); loaded.splice(0, loaded.length, ...keep); }
  if (skipped) notes.push(`${skipped} charts couldn't be loaded, likely TradingView's per-minute limit. Wait a minute and scan again to include them.`);

  // Indicator rules: instant and free, so they run on every loaded chart before (or instead of) the AI.
  const mode: Analyzer = (o.analyzer === "rules" || o.analyzer === "compare") && o.template && DETECTORS[o.template.id] ? o.analyzer : "ai";
  const ruleHits = new Map<string, { hit: RuleHit; bt: Backtest }>();
  let bt: Backtest | undefined;
  if (mode !== "ai") {
    emit({ type: "status", text: `Indicators are reading ${loaded.length} charts`, done: 0, total: loaded.length, phase: "ai" });
    bt = { signals: 0, wins: 0, losses: 0, open: 0, sumRet: 0, trades: [] };
    for (const s of loaded) {
      const one = backtest(s.bars, o.template!.id, o.template!.bias);
      bt = addBacktest(bt, one);
      const hit = analyze(s.bars, o.template!.id, o.template!.bias);
      if (hit) ruleHits.set(s.symbol, { hit, bt: one });
    }
  }
  const ruleRow = (sym: string, extra: Partial<ScanRow> = {}): ScanRow => {
    const { hit: d, bt: one } = ruleHits.get(sym)!, s = info.get(sym)!, b = loaded.find((x) => x.symbol === sym)!.bars;
    const win = b.c.slice(d.from, d.to + 1), lo = Math.min(...b.l.slice(d.from, d.to + 1)), hi = Math.max(...b.h.slice(d.from, d.to + 1));
    const agree = d.confirms.filter((x) => x.ok).length;
    return { id: `${sym}@${day(b.t[d.from])}`, symbol: s.symbol, name: s.name, description: s.description, sector: s.sector, close: s.close, change: s.change,
      score: d.final, bars: d.to - d.from + 1, from: day(b.t[d.from]), to: day(b.t[d.to]),
      heightPct: lo > 0 ? Math.round(((hi - lo) / lo) * 1000) / 10 : 0, closes: win.length > 96 ? resample(win, 96) : win,
      checks: [`Pattern score ${d.score}`, ...d.checks], points: d.points.map((p) => ({ k: p.i - d.from, date: day(p.t), price: p.price, label: p.label })),
      lines: d.lines.map((l) => ({ from: { date: day(l.t1), price: l.p1 }, to: { date: day(l.t2), price: l.p2 }, role: l.role, label: l.label, extend: false })),
      stage: d.stage, summary: `Indicators: ${agree} of ${d.confirms.length} agree with the ${o.template!.bias} pattern.${one.signals - one.open ? ` Past signals on this stock: ${one.wins} of ${one.signals - one.open} worked within ${HORIZON} days.` : ""}`,
      breakout: d.trigger, invalidation: d.stop, by: "rule", indicators: d.confirms.map(({ ok, text }) => ({ ok, text })), bt: summary(one), ...extra };
  };
  const btNote = (b: Backtest) => {
    const closed = b.signals - b.open;
    return closed ? `Indicator backtest on ${loaded.length} charts: ${b.signals} past ${o.template!.name} signals, ${b.wins} of ${closed} worked within ${HORIZON} days (${Math.round((100 * b.wins) / closed)}%), average ${(b.sumRet / closed).toFixed(1)}% per signal.`
      : `Indicator backtest on ${loaded.length} charts: no finished past signals.`;
  };

  if (mode === "rules") {
    const rows = [...ruleHits.keys()].map((sym) => ruleRow(sym)).sort((a, b) => b.score - a.score);
    if (rows.length) emit({ type: "match", rows });
    notes.push(btNote(bt!));
    const r = { type: "results" as const, rows: o.limit ? rows.slice(0, o.limit) : rows, checked: loaded.length, skipped, note: notes.join(" ") || undefined,
      total: stocks.length, next: nextPage, backtest: summary(bt!) };
    emit(r);
    return r;
  }

  // AI verdicts to result rows. One stock can match more than once; a match that mostly overlaps a stronger one for the same stock is dropped.
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
        stage: v.stage, summary: v.summary, breakout: v.breakout, invalidation: v.invalidation, verified: v.verified, ...compared(v), ...screenedOf(v.symbol) };
    });
  };
  const screenedOf = (sym: string): Partial<ScanRow> => {
    const r = plan.screened?.get(sym);
    return r ? { indicators: r.signals.map(({ ok, text }) => ({ ok, text })), rule: r.score } : {};
  };
  // Compare mode: an AI match whose span overlaps the rules' match on the same stock was found by both.
  const ruleSeen = new Set<string>();
  const compared = (v: Verdict): Partial<ScanRow> => {
    if (mode !== "compare") return {};
    const r = ruleHits.get(v.symbol);
    if (!r || Math.min(r.hit.to, v.end) < Math.max(r.hit.from, v.start)) return { by: "ai" };
    ruleSeen.add(v.symbol);
    return { by: "both", rule: r.hit.final, indicators: r.hit.confirms.map(({ ok, text }) => ({ ok, text })), bt: summary(r.bt) };
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
  let compare: { ai: number; rule: number; both: number } | undefined;
  if (mode === "compare") {
    // Rule matches the AI didn't confirm, as their own rows (id marked so they never replace an AI row).
    const ruleOnly = [...ruleHits.keys()].filter((sym) => !ruleSeen.has(sym)).map((sym) => ruleRow(sym, { id: `${sym}@rule` }));
    if (ruleOnly.length) emit({ type: "match", rows: ruleOnly });
    rows.push(...ruleOnly);
    compare = { ai: rows.filter((x) => x.by === "ai").length, rule: ruleOnly.length, both: rows.filter((x) => x.by === "both").length };
    notes.push(`AI and indicators on the same ${loaded.length} charts: both found ${compare.both}, AI only ${compare.ai}, indicators only ${compare.rule}.`, btNote(bt!));
  }
  rows.sort((a, b) => b.score - a.score);
  const r = { type: "results" as const, rows: o.limit ? rows.slice(0, o.limit) : rows, checked: loaded.length - unread, skipped: skipped + unread,
    note: notes.join(" ") || undefined, total: stocks.length, next: nextPage, backtest: bt && summary(bt), compare };
  emit(r);
  return r;
}

const summary = (b: Backtest): BtSummary => {
  const closed = b.signals - b.open;
  return { signals: b.signals, wins: b.wins, losses: b.losses, open: b.open, avgRet: closed ? Math.round((b.sumRet / closed) * 10) / 10 : 0, horizon: HORIZON };
};
