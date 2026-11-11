// Indicator-only analysis: the scanner's "AI off" mode. Pure functions, no I/O, no AI.
//
// A stock's daily bars run through the pivot pattern detector (./pivots.ts), then four plain indicators
// (close vs SMA50, SMA50 vs SMA200, RSI 14, MACD 12/26/9 histogram, volume vs its 50-day average) check
// whether the trend agrees with the pattern's direction. `backtest` replays the same rules bar by bar over the
// bars already loaded, so each scan also reports how often the rule's past signals worked, at no extra
// TradingView call.

import { rsi } from "./indicators";
import { detect, step, newState, type Detection } from "./pivots";
import type { Bias } from "./templates";

export type RuleBars = { t: number[]; o?: number[]; h: number[]; l: number[]; c: number[]; v?: number[] };
export type Confirm = { name: string; ok: boolean; text: string };
export type RuleHit = Detection & {
  /** Detector score blended with the indicator checks, 0-100. */
  final: number;
  confirms: Confirm[];
};
/** One past signal and what price did over the next `horizon` bars. */
export type Trade = { at: number; entry: number; outcome: "win" | "loss"; ret: number; how: "target" | "stop" | "horizon" };
export type Backtest = { signals: number; wins: number; losses: number; open: number; sumRet: number; trades: Trade[] };

export const MIN_RULE = 70;
export const HORIZON = 20;

const sma = (v: number[], n: number, at = v.length - 1) => (at + 1 < n ? undefined : v.slice(at + 1 - n, at + 1).reduce((s, x) => s + x, 0) / n);
function ema(v: number[], n: number) {
  const out: number[] = [], k = 2 / (n + 1);
  v.forEach((x, i) => out.push(i ? x * k + out[i - 1] * (1 - k) : x));
  return out;
}

/** The indicator checks for the pattern's direction at the latest bar. Missing data is left out, not failed. */
export function confirms(b: RuleBars, bias: Bias): Confirm[] {
  const c = b.c, n = c.length, last = c[n - 1], up = bias !== "bearish";
  const out: Confirm[] = [];
  const s50 = sma(c, 50), s200 = sma(c, 200);
  if (s50 != null) out.push({ name: "SMA50", ok: up ? last > s50 : last < s50, text: `Close ${last > s50 ? "above" : "below"} SMA50 (${round(s50)})` });
  if (s50 != null && s200 != null) out.push({ name: "SMA200", ok: up ? s50 > s200 : s50 < s200, text: `SMA50 ${s50 > s200 ? "above" : "below"} SMA200` });
  const r = rsi(c).at(-1);
  // Room to run: not already stretched in the pattern's direction.
  if (r != null) out.push({ name: "RSI", ok: up ? r >= 40 && r <= 70 : r >= 30 && r <= 60, text: `RSI ${Math.round(r)}` });
  if (n >= 35) {
    const e26 = ema(c, 26), macd = ema(c, 12).map((x, i) => x - e26[i]), sig = ema(macd, 9);
    const h = macd[n - 1] - sig[n - 1], h0 = macd[n - 2] - sig[n - 2];
    out.push({ name: "MACD", ok: up ? h > 0 || h > h0 : h < 0 || h < h0, text: `MACD histogram ${h >= 0 ? "positive" : "negative"}, ${h > h0 ? "rising" : "falling"}` });
  }
  const v = b.v;
  if (v && v.length >= 55 && v.some((x) => x > 0)) {
    const recent = sma(v, 5)!, base = sma(v, 50, v.length - 6)!;
    if (base > 0) out.push({ name: "Volume", ok: recent >= base, text: `Volume ${Math.round((recent / base) * 100)}% of its 50-day average` });
  }
  return out;
}

const round = (x: number) => Math.round(x * 100) / 100;

function stateFrom(b: RuleBars, upTo = b.c.length) {
  const s = newState();
  for (let k = 0; k < upTo; k++) step(s, { t: b.t[k], o: b.o?.[k] ?? b.c[k], h: b.h[k], l: b.l[k], c: b.c[k], v: b.v?.[k] ?? 0 });
  return s;
}

/** Blend: the pattern's shape counts 70%, the share of indicator checks that agree 30%. */
const blend = (score: number, cs: Confirm[]) => Math.round(0.7 * score + 0.3 * (cs.length ? (100 * cs.filter((x) => x.ok).length) / cs.length : 50));

/** The pattern at the latest bar, judged by the detector and the indicators only. */
export function analyze(b: RuleBars, template: string, bias: Bias): RuleHit | null {
  if (b.c.length < 80) return null;
  const d = detect(stateFrom(b), template);
  if (!d || d.score < MIN_RULE) return null;
  const cs = confirms(b, bias);
  return { ...d, final: blend(d.score, cs), confirms: cs };
}

/**
 * Walk the bars one day at a time (no look-ahead: each day sees only the bars up to it). The first day a new
 * instance of the pattern scores MIN_RULE+ is a signal, entered at that day's close. Over the next `horizon`
 * bars: the target reached before the stop is a win, the stop first is a loss; otherwise the return after
 * `horizon` bars decides (in the pattern's direction). Signals with fewer than `horizon` bars after them are open.
 */
export function backtest(b: RuleBars, template: string, bias: Bias, horizon = HORIZON): Backtest {
  const out: Backtest = { signals: 0, wins: 0, losses: 0, open: 0, sumRet: 0, trades: [] };
  const n = b.c.length;
  if (n < 80) return out;
  const s = newState(), seen = new Set<number>(), up = bias !== "bearish";
  for (let k = 0; k < n; k++) {
    step(s, { t: b.t[k], o: b.o?.[k] ?? b.c[k], h: b.h[k], l: b.l[k], c: b.c[k], v: b.v?.[k] ?? 0 });
    if (k < 60) continue;
    const d = detect(s, template);
    if (!d || d.score < MIN_RULE || seen.has(d.from)) continue;
    seen.add(d.from);
    // Already broken the wrong way: not a signal anyone would take.
    if (d.stage === "failed") continue;
    out.signals++;
    if (k + horizon >= n) { out.open++; continue; }
    const entry = b.c[k];
    let how: Trade["how"] = "horizon", outcome: Trade["outcome"] | null = null;
    for (let j = k + 1; j <= k + horizon && !outcome; j++) {
      const hitStop = d.stop != null && (up ? b.l[j] <= d.stop : b.h[j] >= d.stop);
      const hitTarget = d.target != null && (up ? b.h[j] >= d.target : b.l[j] <= d.target);
      // Both on one bar: count the stop (the cautious reading).
      if (hitStop) { outcome = "loss"; how = "stop"; } else if (hitTarget) { outcome = "win"; how = "target"; }
    }
    const exit = how === "stop" ? d.stop! : how === "target" ? d.target! : b.c[k + horizon];
    const ret = ((up ? exit - entry : entry - exit) / entry) * 100;
    outcome ??= ret > 0 ? "win" : "loss";
    out[outcome === "win" ? "wins" : "losses"]++;
    out.sumRet += ret;
    out.trades.push({ at: k, entry, outcome, ret: Math.round(ret * 10) / 10, how });
  }
  return out;
}

export function addBacktest(a: Backtest, b: Backtest): Backtest {
  return { signals: a.signals + b.signals, wins: a.wins + b.wins, losses: a.losses + b.losses, open: a.open + b.open, sumRet: a.sumRet + b.sumRet, trades: [] };
}
