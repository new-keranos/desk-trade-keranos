// Checks for lib/scan/screen.ts on the SET50 screener rows seen live 2026-11-11. No network.
// Run: npm run test:screen
import { passes, screen } from "../lib/scan/screen.ts";

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

console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
