import "server-only";
import { TV, type TvCaller } from "../tradingview";
import type { Stock } from "./universe";

// Before any chart is fetched, one get_symbol_data_batch call per 50 stocks reads a snapshot of each
// (price against its 1/3/6-month range, moving averages, RSI, recent performance). Stocks that can't
// hold the pattern right now are left out, so only the likely ones cost a chart call each.

const COLS = ["close", "RSI", "SMA50", "Perf.1M", "Perf.3M", "High.3M", "Low.3M", "High.6M", "Low.6M"];
const BATCH = 50;

export type Snap = { close?: number; RSI?: number; SMA50?: number; "Perf.1M"?: number; "Perf.3M"?: number;
  "High.3M"?: number; "Low.3M"?: number; "High.6M"?: number; "Low.6M"?: number };

export async function snapshots(tv: TvCaller, symbols: string[]): Promise<Record<string, Snap>> {
  const out: Record<string, Snap> = {};
  for (let k = 0; k < symbols.length; k += BATCH) {
    const r = (await tv(TV.quotes, { symbols: symbols.slice(k, k + BATCH), columns: COLS })) as { data?: Record<string, Snap> };
    Object.assign(out, r?.data ?? {});
  }
  return out;
}

const pos = (s: Snap, hi?: number, lo?: number) => (s.close != null && hi != null && lo != null && hi > lo ? (s.close - lo) / (hi - lo) : undefined);
/** The 6-month range is wide enough to hold a pattern (8%+). */
const ranged = (s: Snap) => s["High.6M"] != null && s["Low.6M"] != null && s["High.6M"] > s["Low.6M"] * 1.08;

/** How well a snapshot fits the pattern: null = leave out, higher = check first. Unknown data is kept. */
export function fit(pattern: string | undefined, s: Snap | undefined): number | null {
  if (!pattern || !s || s.close == null) return 0;
  const p6 = pos(s, s["High.6M"], s["Low.6M"]), p3 = pos(s, s["High.3M"], s["Low.3M"]);
  const above = s.SMA50 != null ? s.close > s.SMA50 : undefined, perf3 = s["Perf.3M"], rsi = s.RSI;
  const within = (v: number | undefined, a: number, b: number) => v == null || (v >= a && v <= b);
  switch (pattern) {
    case "double_bottom": case "triple_bottom": case "inverse_head_shoulders":
      return ranged(s) && within(p6, 0.08, 0.8) ? 1 - Math.abs((p6 ?? 0.45) - 0.45) : null;
    case "rounding_bottom": return ranged(s) && within(p6, 0.2, 0.9) ? p6 ?? 0.5 : null;
    case "v_bottom": return (s["Perf.1M"] ?? 0) > 5 && s["Low.3M"] != null && s["Low.3M"] < s.close * 0.88 ? (s["Perf.1M"] ?? 0) / 100 : null;
    case "cup_handle": return ranged(s) && within(p6, 0.65, 1) ? p6 ?? 0.7 : null;
    case "double_top": case "head_shoulders": return ranged(s) && within(p6, 0.2, 0.95) ? 1 - Math.abs((p6 ?? 0.6) - 0.6) : null;
    case "ascending_triangle": return above !== false && within(p3, 0.55, 1) ? p3 ?? 0.6 : null;
    case "descending_triangle": return above !== true && within(p3, 0, 0.45) ? 1 - (p3 ?? 0.4) : null;
    case "bull_flag": return (perf3 ?? 0) > 10 && within(p3, 0.5, 0.97) ? (perf3 ?? 0) / 100 : null;
    case "bear_flag": return (perf3 ?? 0) < -10 && within(p3, 0.03, 0.5) ? -(perf3 ?? 0) / 100 : null;
    case "falling_wedge": case "descending_channel": return above === false || (perf3 ?? 0) < 0 ? -(perf3 ?? 0) / 100 : null;
    case "rising_wedge": case "ascending_channel": return above === true || (perf3 ?? 0) > 0 ? (perf3 ?? 0) / 100 : null;
    case "rsi_bullish_divergence": return within(rsi, 0, 50) && s["Low.3M"] != null && s["Low.3M"] >= s.close / 1.1 ? 50 - (rsi ?? 40) : null;
    case "rsi_bearish_divergence": return within(rsi, 50, 100) && s["High.3M"] != null && s["High.3M"] <= s.close * 1.1 ? (rsi ?? 60) - 50 : null;
    default: return 0;
  }
}

/** The stocks worth a chart call for this pattern, best fits first (ties keep the largest first). */
export function rank(stocks: Stock[], snaps: Record<string, Snap>, pattern: string | undefined) {
  return stocks.map((s, i) => ({ s, i, f: fit(pattern, snaps[s.symbol]) }))
    .filter((x) => x.f != null).sort((a, b) => b.f! - a.f! || a.i - b.i).map((x) => x.s);
}
