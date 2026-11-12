// Checks for lib/scan/screen.ts on the SET50 screener rows seen live 2026-11-11. No network.
// Run: npm run test:screen
import { passes, screen } from "../lib/scan/screen.ts";
import { shapeOf } from "../lib/scan/shape.ts";

const DELTA = { close: 194, RSI: 33.18, "RSI[1]": 32.39, SMA50: 242.17, SMA200: 271.1, EMA20: 213.3, EMA50: 237.4, "MACD.macd": -18.43, "MACD.signal": -15.84,
  relative_volume_10d_calc: 0.38, ADX: 37.8, "Stoch.K": 20.7, "BB.lower": 164.5, "BB.upper": 274.9, "Recommend.All": -0.45 };
const ADVANC = { close: 343, RSI: 55.0, "RSI[1]": 47.6, SMA50: 342.96, SMA200: 359.4, EMA20: 338.9, EMA50: 343.8, "MACD.macd": -0.75, "MACD.signal": -1.9,
  relative_volume_10d_calc: 0.81, ADX: 23.4, "Stoch.K": 74.5, "BB.lower": 330.8, "BB.upper": 342.5, "Recommend.All": 0.22 };

let fail = 0;
const check = (ok: boolean, name: string, detail: string) => { if (!ok) fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(58)} ${detail}`); };
const show = (r: ReturnType<typeof screen>) => `score ${r.score}, ${r.passed} ok: ${r.signals.map((s) => (s.ok ? "+" : "-") + s.text).join("; ")}`;

// DELTA: deep oversold, RSI hooking up, near the lower band: a bottom candidate, not a trend continuation.
const dRev = screen(DELTA, "double_bottom", "bullish"), dTrend = screen(DELTA, "ascending_triangle", "bullish");
check(dRev.score > dTrend.score, "oversold stock scores higher for a bottom than a trend pattern", `${dRev.score} vs ${dTrend.score}`);
// ADVANC: RSI up 47→55, MACD above signal, above EMA20/SMA50: fits a bullish trend pattern, not a bearish one.
const aUp = screen(ADVANC, "bull_flag", "bullish"), aDown = screen(ADVANC, "bear_flag", "bearish");
check(passes(aUp) && aUp.score > aDown.score, "momentum stock passes a bullish trend screen, beats bearish", `${show(aUp)} | bearish ${aDown.score}`);
// A bullish engulfing candle adds a signal.
const withCandle = screen({ ...DELTA, "Candle.Engulfing.Bullish": 1 }, "double_bottom", "bullish");
check(withCandle.score > dRev.score && withCandle.signals.some((s) => /engulfing/i.test(s.text)), "a bullish candle raises the score", `${dRev.score} -> ${withCandle.score}`);
// RSI crossing up through 30 counts.
const cross = screen({ ...DELTA, "RSI[1]": 28, RSI: 31 }, "double_bottom", "bullish");
check(cross.signals.some((s) => /crossed above 30/.test(s.text)), "RSI crossing above 30 is a signal", show(cross));
// No data: no pass.
check(!passes(screen({}, "double_bottom", "bullish")), "a stock with no indicator data never passes", "");

// Shapes from screener ranges (S&P 500 rows seen live 2026-11-12).
const AAPL = { close: 355.63, "High.1M": 355.91, "Low.1M": 325.33, "High.3M": 355.91, "Low.3M": 302.94, "High.6M": 355.91, "Low.6M": 273.75, "Perf.W": 4.1, "Perf.1M": 5.1, "Perf.3M": 16.9 };
const NVDA = { close: 173.73, "High.1M": 228.64, "Low.1M": 165.89, "High.3M": 243.37, "Low.3M": 165.89, "High.6M": 243.37, "Low.6M": 165.89, "Perf.W": -14.6, "Perf.1M": -24.0, "Perf.3M": -22.8 };
const at = shapeOf(AAPL, "ascending_triangle");
check(at.ok, "AAPL: flat top + rising lows reads as an ascending triangle", at.checks.map((v) => (v.ok ? "+" : "-") + v.text).join("; "));
check(!shapeOf(NVDA, "ascending_triangle").ok, "NVDA (falling, new low) is not an ascending triangle", "");
check(!shapeOf(AAPL, "descending_triangle").ok && !shapeOf(AAPL, "bear_flag").ok, "AAPL is not a bearish shape", "");
check(!shapeOf({ close: 10 }, "double_bottom").ok, "missing range data never matches", "");

console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
