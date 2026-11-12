// Indicator screen for the "Indicator screen → AI" scan. Pure functions, no I/O.
//
// TradingView computes these indicators server-side and returns them as screener columns, so they ride on the
// one run_screener call that lists the market: no get_ohlcv. Each stock is scored by how many indicator signals
// point the pattern's way. Only the stocks that pass cost a get_ohlcv call and an AI read.

import { isDivergence, type Bias } from "./templates";

/** Screener columns the screen reads (checked live on SET50 2026-11-11 and S&P 500 2026-11-12). */
export const SCREEN_COLS = ["RSI[1]", "SMA200", "EMA20", "EMA50", "MACD.macd", "MACD.signal", "relative_volume_10d_calc", "ADX", "Stoch.K",
  "BB.lower", "BB.upper", "Recommend.All", "Candle.Hammer", "Candle.Engulfing.Bullish", "Candle.MorningStar", "Candle.3WhiteSoldiers",
  "Candle.ShootingStar", "Candle.Engulfing.Bearish", "Candle.EveningStar", "Candle.3BlackCrows", "High.1M", "Low.1M", "Perf.W", "Perf.6M"] as const;
/** Columns the screen also reads that the prefilter already asks for. */
const SHARED = ["close", "RSI", "SMA50", "Perf.1M", "Perf.3M", "High.3M", "Low.3M", "High.6M", "Low.6M"] as const;

export type Ind = Partial<Record<(typeof SCREEN_COLS)[number] | (typeof SHARED)[number], number>>;

export function indOf(row: Record<string, unknown>): Ind {
  const out: Record<string, number> = {};
  for (const k of [...SCREEN_COLS, ...SHARED]) if (typeof row[k] === "number") out[k] = row[k] as number;
  return out as Ind;
}

/** Bottoms and tops (price turning) vs. patterns that continue a trend. */
const REVERSAL = new Set(["double_bottom", "double_top", "triple_bottom", "inverse_head_shoulders", "head_shoulders", "rounding_bottom", "v_bottom",
  "falling_wedge", "rising_wedge", "rsi_bullish_divergence", "rsi_bearish_divergence"]);

export type Signal = { ok: boolean; text: string; w: number };
export type Screen = { score: number; passed: number; signals: Signal[] };

/** Least screen score (0-100) a stock needs, and least signals that agree. */
export const MIN_SCREEN = 45, MIN_SIGNALS = 2;

/**
 * Indicator signals for a pattern. Bullish patterns read the columns as they are; bearish ones the mirror
 * (RSI falling instead of rising, below a line instead of above). Missing columns are left out, not failed.
 * Reversal patterns look for a turn (oversold, RSI hooking up, MACD crossing, a reversal candle); trend
 * patterns for strength (above the averages, MACD above signal, ADX trending).
 */
export function screen(x: Ind, pattern: string, bias: Bias): Screen {
  const up = bias !== "bearish", rev = REVERSAL.has(pattern) || isDivergence(pattern);
  const s: Signal[] = [];
  const add = (cond: boolean | undefined, w: number, yes: string, no: string) => { if (cond !== undefined) s.push({ ok: cond, w, text: cond ? yes : no }); };
  const has = (...ks: (keyof Ind)[]) => ks.every((k) => x[k] != null);
  const c = x.close, r = x.RSI, r1 = x["RSI[1]"];
  const r0 = (v: number) => Math.round(v);

  if (has("RSI", "RSI[1]")) {
    add(up ? r! > r1! : r! < r1!, 2, `RSI ${up ? "rising" : "falling"} (${r0(r1!)} → ${r0(r!)})`, `RSI ${up ? "not rising" : "not falling"} (${r0(r1!)} → ${r0(r!)})`);
    if (rev) add(up ? r! <= 45 : r! >= 55, 1, `RSI ${r0(r!)}: room to turn`, `RSI ${r0(r!)}: already stretched`);
    else add(up ? r! >= 50 && r! <= 72 : r! <= 50 && r! >= 28, 1, `RSI ${r0(r!)} in the trend zone`, `RSI ${r0(r!)} outside the trend zone`);
    if (up ? r1! < 30 && r! >= 30 : r1! > 70 && r! <= 70) s.push({ ok: true, w: 2, text: `RSI crossed ${up ? "above 30" : "below 70"}` });
  }
  if (has("MACD.macd", "MACD.signal")) {
    const m = x["MACD.macd"]!, sg = x["MACD.signal"]!;
    add(up ? m > sg : m < sg, 2, `MACD ${up ? "above" : "below"} its signal`, `MACD ${up ? "below" : "above"} its signal`);
  }
  if (has("close", "EMA20")) add(up ? c! > x.EMA20! : c! < x.EMA20!, 1, `Close ${up ? "above" : "below"} EMA20`, `Close ${up ? "below" : "above"} EMA20`);
  if (!rev && has("close", "SMA50")) add(up ? c! > x.SMA50! : c! < x.SMA50!, 2, `Close ${up ? "above" : "below"} SMA50`, `Close ${up ? "below" : "above"} SMA50`);
  if (!rev && has("SMA50", "SMA200")) add(up ? x.SMA50! > x.SMA200! : x.SMA50! < x.SMA200!, 1, `SMA50 ${up ? "above" : "below"} SMA200`, `SMA50 ${up ? "below" : "above"} SMA200`);
  if (!rev && x.ADX != null) add(x.ADX >= 20, 1, `ADX ${r0(x.ADX)}: trending`, `ADX ${r0(x.ADX)}: no trend`);
  if (rev && x["Stoch.K"] != null) add(up ? x["Stoch.K"] <= 35 : x["Stoch.K"] >= 65, 1, `Stochastic ${r0(x["Stoch.K"])}: ${up ? "oversold" : "overbought"} zone`, `Stochastic ${r0(x["Stoch.K"])}`);
  if (rev && has("close", "BB.lower", "BB.upper")) {
    const lo = x["BB.lower"]!, hi = x["BB.upper"]!, pos = hi > lo ? (c! - lo) / (hi - lo) : 0.5;
    add(up ? pos <= 0.35 : pos >= 0.65, 1, `Close in the ${up ? "lower" : "upper"} Bollinger band`, `Close mid-band or beyond`);
  }
  if (x.relative_volume_10d_calc != null) add(x.relative_volume_10d_calc >= 1.2, 1, `Volume ${x.relative_volume_10d_calc.toFixed(1)}× its 10-day average`, `Volume ${x.relative_volume_10d_calc.toFixed(1)}× its 10-day average`);
  if (x["Recommend.All"] != null) add(up ? x["Recommend.All"] > 0 : x["Recommend.All"] < 0, 1, `TradingView rating leans ${up ? "buy" : "sell"}`, `TradingView rating leans ${up ? "sell" : "buy"}`);
  // Candles only count when they appear (a missing candle isn't a failed check).
  const candles: [keyof Ind, string][] = up
    ? [["Candle.Hammer", "Hammer"], ["Candle.Engulfing.Bullish", "Bullish engulfing"], ["Candle.MorningStar", "Morning star"], ["Candle.3WhiteSoldiers", "Three white soldiers"]]
    : [["Candle.ShootingStar", "Shooting star"], ["Candle.Engulfing.Bearish", "Bearish engulfing"], ["Candle.EveningStar", "Evening star"], ["Candle.3BlackCrows", "Three black crows"]];
  for (const [k, name] of candles) if (x[k] === 1) s.push({ ok: true, w: 2, text: `${name} candle on the last bar` });

  const total = s.reduce((n, v) => n + v.w, 0), got = s.filter((v) => v.ok).reduce((n, v) => n + v.w, 0);
  return { score: total ? Math.round((100 * got) / total) : 0, passed: s.filter((v) => v.ok).length, signals: s };
}

export const passes = (r: Screen) => r.score >= MIN_SCREEN && r.passed >= MIN_SIGNALS;
