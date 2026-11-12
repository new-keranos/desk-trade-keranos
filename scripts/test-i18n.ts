// Every English sentence the indicator rules write has a Thai version. No network.
// Run: npm run test:i18n
import { tr, trLabel, trNote } from "../lib/i18n.ts";
import { shapeOf } from "../lib/scan/shape.ts";
import { screen } from "../lib/scan/screen.ts";
import { TEMPLATES } from "../lib/scan/templates.ts";

const seen = new Set<string>();
const A = { close: 345, "High.1M": 350.6, "Low.1M": 325.33, "High.3M": 355.91, "Low.3M": 302.94, "High.6M": 355.91, "Low.6M": 273.75, "Perf.W": 4.1, "Perf.1M": 5.1, "Perf.3M": 16.9, RSI: 40, "RSI[1]": 35 };
const B = { ...A, "High.1M": 355.91, "Low.1M": 302.94, close: 310, "Perf.3M": -20, "Perf.W": -1, "Perf.1M": 12, RSI: 70, "RSI[1]": 75 };
const IND = { close: 100, RSI: 31, "RSI[1]": 28, "MACD.macd": 1, "MACD.signal": 0, EMA20: 90, SMA50: 95, SMA200: 99, ADX: 25, "Stoch.K": 20, "BB.lower": 95, "BB.upper": 120,
  relative_volume_10d_calc: 1.5, "Recommend.All": 0.3, "Candle.Hammer": 1, "Candle.ShootingStar": 1 };
for (const t of TEMPLATES) for (const x of [A, B, { close: 1 }]) {
  shapeOf(x, t.id).checks.forEach((c) => seen.add(c.text));
  for (const bias of ["bullish", "bearish"] as const) for (const y of [IND, { ...IND, RSI: 75, "RSI[1]": 72, ADX: 10, "Stoch.K": 80 }, { ...IND, RSI: 60, "RSI[1]": 50 }]) screen(y, t.id, bias).signals.forEach((s) => seen.add(s.text));
}
seen.add("Screener only: the Ascending triangle outline from the 1/3/6-month ranges, 5 indicator signals agree. Open it to check the chart.");
seen.add("Drawn: the 1/3/6-month highs and lows the screener read, on the days they happened. The pattern detector didn't find the Double bottom on the daily chart.");
seen.add("Chart: Bottoms within 1.5%"); seen.add("Chart: Stage: forming"); for (const c of ["Bottoms within 1.5%", "Stage: forming", "3 touches over 40 bars", "Neckline 8.1% from the bottoms", "Prior move -12%", "Head 4% beyond the shoulders",
  "60-bar cup, symmetry off by 10%", "Handle 5% over 8 bars", "Lines converge 40%", "Price fell 3% while RSI rose 6 points", "MACD histogram positive, rising", "Volume 120% of its 50-day average",
  "Close above SMA50 (123.4)"]) seen.add("Chart: " + c);
let fail = 0;
// Already the same in both languages: just an indicator and its value.
const NEUTRAL = /^(Stochastic|RSI) [\d?]+$/;
for (const s of seen) { const t = tr(s, "th"); if (t === s && !NEUTRAL.test(s)) { fail++; console.log("NO THAI  " + s); } }
const note = "Indicators read all 503 stocks in S&P 500 from one screener call (no chart calls, no AI): 21 show the Ascending triangle outline in their price ranges, 20 of them also pass the indicator screen (score 45+). Screener columns give ranges, not turning points, so open a match to confirm it on the chart.";
if (trNote(note, "th") === note) { fail++; console.log("NO THAI  note"); }
const n2 = "Indicator screen: 21 of 503 stocks in S&P 500 show the Ascending triangle outline in their screener ranges, 20 also passed the indicator screen (score 45+); the best 10 were charted and read by the AI.";
if (trNote(n2, "th") === n2) { fail++; console.log("NO THAI  screen_ai note"); }
for (const l of ["Bottom 1", "Neckline", "High 1 (RSI 67)", "Flat top", "Pole start"]) if (trLabel(l, "th") === l) { fail++; console.log("NO THAI  label " + l); }
if (tr("RSI rising (28 → 31)", "en") !== "RSI rising (28 → 31)") { fail++; console.log("EN changed"); }
console.log(`${seen.size} sentences, ${fail ? `${fail} without Thai` : "all have Thai"}`);
console.log(tr("Flat top: 1-month high 1.5% under the earlier 3-month high (3% max)", "th"));
console.log(trNote(note, "th"));
process.exit(fail ? 1 : 0);
