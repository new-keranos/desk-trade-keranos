// Early bullish RSI divergence: flag it while it forms, not after the swing low is confirmed and price has run.
// Pure functions, no I/O. Used by the early-signal scan (server, screener rows, run when the user presses Scan) and the watchlist signals (browser, bars).
//
// A textbook divergence needs a confirmed swing low (2-5 bars after the low), so by the time it shows the stock has
// often bounced already. Here a divergence is "forming" as soon as price makes a new low below the last swing low
// while RSI stays clearly above where it was at that swing low, and "near" when price is a few percent above that
// swing low and would still leave RSI higher if it closed there.

import { findDivergences, pivots, rsi } from "./indicators";

// ---------- scan: screener rows, whole market, no chart calls ----------

/** Screener columns the scan reads (all checked live on SET and NASDAQ 2026-11-13). */
export const EARLY_COLS = ["name", "description", "close", "change", "open", "low", "sector", "industry", "market_cap_basic",
  "RSI", "RSI[1]", "Low.1M", "Low.3M", "Perf.W", "Perf.1M", "relative_volume_10d_calc", "average_volume_30d_calc", "update_mode"] as const;

/** forming: making the new low now, RSI not following. near: sliding toward the earlier low, RSI still firm. */
export type EarlyStage = "forming" | "near";
export type EarlyRow = {
  symbol: string; name: string; description?: string; sector?: string; industry?: string;
  close: number; change?: number; rsi: number; rsi1?: number;
  /** Volume against its 10-day average. */
  rv?: number;
  /** Average money traded a day over 30 days, in the stock's currency (close × 30-day average volume). */
  value?: number;
  /** % above the 3-month low. */
  fromLow: number; low3: number; perf1?: number;
  stage: EarlyStage; score: number; checks: string[]; mode?: string;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * A stock's early-divergence setup from its screener row, or null. Both stages are BEFORE price turns up, so the
 * user sees them while the stock is still at or falling toward its low, not after it has run:
 * - forming: today's low is a new 1-month low within 2% of the 3-month low, yet RSI is 33-55 (a fresh 3-month low
 *   normally drags RSI under 30, so a firm RSI there usually means it is higher than at the earlier low);
 * - near: still 0-4% above the 3-month low and down over the week, with RSI 35-50: if it slides to the old low
 *   without RSI breaking down, a divergence forms there.
 * Screener columns hold today's values and the 1/3-month lows, not the RSI at the earlier low, so this is a
 * shortlist to confirm on the chart (the watchlist signals check the chart itself).
 */
export function earlySetup(row: Record<string, unknown>): EarlyRow | null {
  const close = num(row.close), low = num(row.low) ?? close, r = num(row.RSI), r1 = num(row["RSI[1]"]);
  const low1 = num(row["Low.1M"]), low3 = num(row["Low.3M"]), perfW = num(row["Perf.W"]);
  if (close == null || low == null || r == null || low1 == null || low3 == null || low3 <= 0) return null;
  const fromLow = ((close - low3) / low3) * 100, rv = num(row.relative_volume_10d_calc), avgVol = num(row.average_volume_30d_calc);
  const newLow = low <= low1 * 1.005, at3M = low <= low3 * 1.02;
  let stage: EarlyStage | null = null;
  const checks: string[] = [];
  if (newLow && at3M && r >= 33 && r <= 55) {
    stage = "forming";
    checks.push(`New 1-month low at ${round(low)} (3-month low ${round(low3)})`, `RSI ${Math.round(r)} held above oversold at the new low`);
  } else if (!newLow && fromLow >= 0 && fromLow <= 4 && r >= 35 && r <= 50 && perfW != null && perfW < 0) {
    stage = "near";
    checks.push(`${fromLow.toFixed(1)}% above the 3-month low ${round(low3)}`, `Down ${Math.abs(perfW).toFixed(1)}% this week`, `RSI ${Math.round(r)} still firm`);
  }
  if (!stage) return null;
  if (rv != null) checks.push(`Volume ${rv.toFixed(1)}× its 10-day average`);
  // Higher for a firmer RSI at the low, heavier volume, and forming over near (the low is being tested now).
  const score = Math.round(Math.min(100, (stage === "forming" ? 50 : 40) + Math.min(25, (r - 30) * 1.5) + Math.min(20, ((rv ?? 1) - 1) * 20) + (r1 != null && r >= r1 ? 5 : 0)));
  return { symbol: String(row.symbol), name: String(row.name ?? row.symbol), description: row.description as string | undefined,
    sector: row.sector as string | undefined, industry: row.industry as string | undefined,
    close, change: num(row.change), rsi: round(r, 1), rsi1: r1 == null ? undefined : round(r1, 1), rv: rv == null ? undefined : round(rv, 2),
    value: avgVol == null ? undefined : close * avgVol, fromLow: round(fromLow, 1), low3, perf1: num(row["Perf.1M"]),
    stage, score, checks, mode: typeof row.update_mode === "string" ? row.update_mode : undefined };
}

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

// ---------- data freshness ----------

/** TradingView's update_mode as words: "streaming" is realtime, "delayed_streaming_900" is 15 minutes late. */
export function freshness(mode?: string): { realtime: boolean; delayMin?: number; eod?: boolean } | null {
  if (!mode) return null;
  if (mode === "streaming") return { realtime: true };
  const m = mode.match(/delayed_streaming_(\d+)/);
  if (m) return { realtime: false, delayMin: Math.round(Number(m[1]) / 60) };
  if (/endofday/i.test(mode)) return { realtime: false, eod: true };
  return { realtime: false };
}

// ---------- watchlist signals: daily bars plus the live quote ----------

export type Bars = { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v?: number[] };
export type LiveQuote = { open?: number; high?: number; low?: number; close?: number };

/** Daily bars with today's bar brought up to the live quote. The quote belongs to the last bar when the opens match
 * (the same session); otherwise it is a new session and is added as a bar of its own. */
export function withLive(b: Bars, q?: LiveQuote): Bars {
  const n = b.c.length;
  if (!q || q.close == null || !n) return b;
  const o = q.open ?? q.close, h = Math.max(q.high ?? q.close, q.close), l = Math.min(q.low ?? q.close, q.close);
  const same = Math.abs(o - b.o[n - 1]) <= Math.abs(o) * 1e-6;
  if (same) {
    if (q.close === b.c[n - 1] && h <= b.h[n - 1] && l >= b.l[n - 1]) return b;
    return { t: b.t, o: b.o, h: [...b.h.slice(0, -1), Math.max(h, b.h[n - 1])], l: [...b.l.slice(0, -1), Math.min(l, b.l[n - 1])], c: [...b.c.slice(0, -1), q.close] };
  }
  return { t: [...b.t, Math.floor(Date.now() / 1000)], o: [...b.o, o], h: [...b.h, h], l: [...b.l, l], c: [...b.c, q.close] };
}

export type SignalState = "confirmed" | "forming" | "near";
export type Point = { t: number; price: number; rsi: number };
export type EarlySignal = {
  state: SignalState;
  /** The earlier swing low the divergence is measured against. */
  ref: Point;
  /** The new low (forming, confirmed). */
  low?: Point;
  /** Price that would form the divergence (near): the earlier swing low. */
  level?: number;
  /** RSI if price closed at `level` (near). */
  rsiAtLevel?: number;
  rsiNow: number; close: number;
};

/** Signal strength, for spotting when a stock moves up a step. */
export const RANK: Record<SignalState | "none", number> = { none: 0, near: 1, forming: 2, confirmed: 3 };

/** RSI gap (points) that counts as a divergence, as in findDivergences. */
const MIN_GAP = 3;
/** Earlier swing lows up to this many bars back, and at least this many bars before the new low. */
const LOOKBACK = 60, MIN_APART = 5;
/** The earlier swing low should be a weak spot: RSI at most this. */
const MAX_REF_RSI = 45;
/** "near": price within this % above the earlier swing low. */
const NEAR_PCT = 4;

/**
 * Early bullish divergence on daily bars (with today's bar from the live quote, see withLive):
 * - confirmed: a regular bullish divergence whose second swing low is within the last 8 bars;
 * - forming: the low of the last 3 bars undercuts (or matches within 0.5%) an earlier swing low 5-60 bars back that
 *   is still the lowest point since, while RSI at the new low is 3+ points higher; the new low isn't a confirmed
 *   swing yet, which is the point: it shows days before the textbook signal;
 * - near: price is within 4% above such a swing low, has not broken it, and RSI would still be 3+ points higher if
 *   price closed right at it. `level` is that price: a TradingView alert there catches the new low as it happens.
 */
export function earlyBullish(b: Bars): EarlySignal | null {
  const n = b.c.length;
  if (n < 30) return null;
  const r = rsi(b.c), rsiNow = r[n - 1];
  if (rsiNow == null) return null;
  const close = b.c[n - 1];
  const pt = (k: number): Point => ({ t: b.t[k], price: b.l[k], rsi: Math.round(r[k]! * 10) / 10 });

  const conf = findDivergences(b, { recent: 8 }).find((d) => d.kind === "bullish");
  if (conf && conf.a.rsi <= MAX_REF_RSI + 5) return { state: "confirmed", ref: pt(conf.a.k), low: pt(conf.b.k), rsiNow, close };

  const swings = pivots(b.l, true, 5, 2).filter((k) => r[k] != null && k >= n - LOOKBACK);
  // The new low: the lowest bar of the last three.
  let kLow = n - 1;
  for (let k = n - 3; k < n; k++) if (b.l[k] < b.l[kLow]) kLow = k;
  const minBetween = (a: number, z: number) => { let m = Infinity; for (let k = a; k < z; k++) m = Math.min(m, b.l[k]); return m; };

  for (let j = swings.length - 1; j >= 0; j--) {
    const k = swings[j];
    if (k > kLow - MIN_APART) continue;
    // A lower low since this swing means a later one is the real reference.
    if (minBetween(k + 1, kLow) < b.l[k]) continue;
    if (r[k]! > MAX_REF_RSI) continue;
    if (b.l[kLow] <= b.l[k] * 1.005 && r[kLow]! >= r[k]! + MIN_GAP) return { state: "forming", ref: pt(k), low: pt(kLow), rsiNow, close };
    break;
  }

  // Near: the latest weak swing low that price has not broken since.
  for (let j = swings.length - 1; j >= 0; j--) {
    const k = swings[j];
    if (k > n - 1 - MIN_APART) continue;
    if (minBetween(k + 1, n) < b.l[k]) continue;
    if (r[k]! > MAX_REF_RSI) break;
    const level = b.l[k], above = ((close - level) / level) * 100;
    if (above < 0 || above > NEAR_PCT) break;
    const rl = rsi([...b.c.slice(0, -1), level])[n - 1];
    if (rl == null || rl < r[k]! + MIN_GAP) break;
    return { state: "near", ref: pt(k), level, rsiAtLevel: Math.round(rl * 10) / 10, rsiNow, close };
  }
  return null;
}
