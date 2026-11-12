// Chart-pattern shapes read from screener columns only: no bars, no get_ohlcv. Pure functions, no I/O.
//
// The screener gives each stock's high and low over 1, 3 and 6 months, its performance over a week to six
// months, and its averages. Those are enough to see the outline of most patterns: a flat top with rising lows
// (ascending triangle), a retest of an old low (double bottom), a deep base with price back near the old
// high (cup), a fast rise then a shallow pause (flag). They can't place exact turning points or dates, so this
// is a screen for "looks like it could be", read with the indicator signals of ./screen.ts.

import type { Ind } from "./screen";

export type ShapeCheck = { ok: boolean; text: string };
export type Shape = { ok: boolean; checks: ShapeCheck[]; heightPct?: number };

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** The pattern's outline from the screener columns. ok = every check holds. Missing columns fail the check. */
export function shapeOf(x: Ind, pattern: string): Shape {
  const c = x.close, h1 = x["High.1M"], l1 = x["Low.1M"], h3 = x["High.3M"], l3 = x["Low.3M"], h6 = x["High.6M"], l6 = x["Low.6M"];
  const p1 = x["Perf.1M"], p3 = x["Perf.3M"], pw = x["Perf.W"];
  if (c == null || h1 == null || l1 == null || h3 == null || l3 == null) return { ok: false, checks: [{ ok: false, text: "Screener range data missing" }] };
  const out: ShapeCheck[] = [];
  const need = (ok: boolean | undefined, text: string) => out.push({ ok: !!ok, text });
  const pos1 = h1 > l1 ? (c - l1) / (h1 - l1) : 0.5;
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) / Math.min(a, b) <= tol;
  const narrowing = (h3 - l3) > 0 ? (h1 - l1) / (h3 - l3) : 1;
  // A retest needs an earlier extreme: when this month's high IS the 3-month high (h1 == h3) the stock is just
  // making new highs, and "within 3% of the 3-month high" would pass every uptrend. So the earlier one must be
  // strictly beyond this month's, which means it was set 1-3 months ago, and this month came back close to it.
  const topRetest = (tol: number) => h1 < h3 * 0.999 && h1 >= h3 * (1 - tol);
  const lowRetest = (tol: number) => l1 > l3 * 1.001 && l1 <= l3 * (1 + tol);

  switch (pattern) {
    case "ascending_triangle":
      need(topRetest(0.03), h1 >= h3 * 0.999 ? "Flat top: no, this month set a new 3-month high (an uptrend, not a retest of an earlier top)" : `Flat top: 1-month high ${pct(1 - h1 / h3)} under the earlier 3-month high (3% max)`);
      need(l1 > l3 * 1.03, `Rising lows: 1-month low ${pct(l1 / l3 - 1)} above the 3-month low`);
      need(pos1 >= 0.5, `Close in the upper ${pos1 >= 0.5 ? "half" : "part"} of the month's range (${pct(pos1)})`);
      break;
    case "descending_triangle":
      need(lowRetest(0.03), l1 <= l3 * 1.001 ? "Flat bottom: no, this month set a new 3-month low (a downtrend, not a retest)" : `Flat bottom: 1-month low ${pct(l1 / l3 - 1)} above the earlier 3-month low (3% max)`);
      need(h1 < h3 * 0.97, `Falling highs: 1-month high ${pct(1 - h1 / h3)} under the 3-month high`);
      need(pos1 <= 0.5, `Close in the lower half of the month's range (${pct(pos1)})`);
      break;
    case "double_bottom": case "triple_bottom":
      need(h6 != null && l6 != null && h6 > l6 * 1.12, "6-month range wide enough for a base (12%+)");
      need(lowRetest(0.04), l1 <= l3 * 1.001 ? "Retest: no, this month's low is the 3-month low (one bottom, not two)" : `Retest: 1-month low ${pct(l1 / l3 - 1)} above the earlier 3-month low (4% max)`);
      need(c > l1 * 1.03, `Bounced ${pct(c / l1 - 1)} off the low`);
      need(c < h3 * 0.97, "Still under the 3-month high (neckline not cleared)");
      break;
    case "double_top": case "head_shoulders":
      need(h6 != null && l6 != null && h6 > l6 * 1.12, "6-month range wide enough for a top (12%+)");
      need(pattern === "double_top" ? topRetest(0.04) : h1 < h3 && h1 > h3 * 0.9, pattern === "double_top" ? (h1 >= h3 * 0.999 ? "Retest: no, this month's high is the 3-month high (one top, not two)" : `Retest: 1-month high ${pct(1 - h1 / h3)} under the earlier 3-month high (4% max)`) : `Lower right shoulder: 1-month high ${pct(1 - h1 / h3)} under the 3-month high`);
      need(c < h1 * 0.97, `Turned down ${pct(1 - c / h1)} from the high`);
      need(c > l3 * 1.03, "Still above the 3-month low (neckline not broken)");
      break;
    case "inverse_head_shoulders":
      need(l1 > l3 && l1 < l3 * 1.1, `Higher right shoulder: 1-month low ${pct(l1 / l3 - 1)} above the 3-month low`);
      need(c > l1 * 1.03, `Bounced ${pct(c / l1 - 1)} off the right shoulder`);
      need(c < h3 * 1.02, "Near or under the neckline");
      break;
    case "cup_handle": {
      const depth = h6 != null && l6 != null ? (h6 - l6) / h6 : undefined;
      need(depth != null && depth >= 0.12 && depth <= 0.4, `Cup depth ${depth != null ? pct(depth) : "?"} (12-40%)`);
      need(h6 != null && h1 >= h6 * 0.95, "Right rim: 1-month high back within 5% of the 6-month high");
      need(c <= h1 * 0.97 && c >= h1 * 0.85, `Handle: close ${pct(1 - c / h1)} under the rim (3-15%)`);
      need(p3 != null && p3 > 5, `Rising into the rim (3-month ${p3 != null ? pct(p3 / 100) : "?"})`);
      break;
    }
    case "rounding_bottom":
      need(l6 != null && l3 > l6 * 1.02, "Lowest point was 3-6 months ago, lows rising since");
      need(h6 != null && l6 != null && c >= l6 + 0.5 * (h6 - l6), "Recovered at least half of the 6-month range");
      need(p3 != null && p3 > 0 && p1 != null && p1 > -5, "Gradual recovery: 3-month gain, no sharp drop this month");
      break;
    case "v_bottom":
      need(p1 != null && p1 > 8, `Sharp rebound: +${p1 != null ? pct(p1 / 100) : "?"} in a month`);
      need(near(l1, l3, 0.02), "The low was set this month");
      need(c >= l1 * 1.1, `Up ${pct(c / l1 - 1)} from the low`);
      break;
    case "bull_flag":
      need(p3 != null && p3 > 15, `Pole: +${p3 != null ? pct(p3 / 100) : "?"} over 3 months`);
      need(pw != null && pw > -6 && pw < 2, `Pause: ${pw != null ? pct(pw / 100) : "?"} this week`);
      need(c >= h1 * 0.88 && c < h1 * 0.99, `Shallow pullback: ${pct(1 - c / h1)} under the month's high`);
      break;
    case "bear_flag":
      need(p3 != null && p3 < -15, `Pole: ${p3 != null ? pct(p3 / 100) : "?"} over 3 months`);
      need(pw != null && pw < 6 && pw > -2, `Pause: ${pw != null ? pct(pw / 100) : "?"} this week`);
      need(c <= l1 * 1.12 && c > l1 * 1.01, `Shallow bounce: ${pct(c / l1 - 1)} over the month's low`);
      break;
    case "falling_wedge":
      need(h1 < h3 * 0.97, "Falling highs");
      need(l1 <= l3 * 1.02, "Lows still falling or at the low");
      need(narrowing < 0.55, `Range narrowing: this month ${pct(narrowing)} of the 3-month range`);
      break;
    case "rising_wedge":
      need(l1 > l3 * 1.03, "Rising lows");
      need(h1 >= h3 * 0.98, "Highs still rising or at the high");
      need(narrowing < 0.55, `Range narrowing: this month ${pct(narrowing)} of the 3-month range`);
      break;
    case "ascending_channel":
      need(p3 != null && p3 > 5, "Rising over 3 months");
      need(l1 > l3 * 1.03 && h1 >= h3 * 0.98, "Higher lows and highs");
      need(narrowing >= 0.3 && narrowing <= 0.8, "Steady range (not a squeeze or a blow-off)");
      break;
    case "descending_channel":
      need(p3 != null && p3 < -5, "Falling over 3 months");
      need(h1 < h3 * 0.97 && l1 <= l3 * 1.02, "Lower highs and lows");
      need(narrowing >= 0.3 && narrowing <= 0.8, "Steady range (not a squeeze or a capitulation)");
      break;
    case "rsi_bullish_divergence":
      need(near(l1, l3, 0.02), "Price at or near a new 3-month low");
      need(x.RSI != null && x.RSI >= 35, `RSI ${x.RSI != null ? Math.round(x.RSI) : "?"} held above 35 (not making a new low)`);
      break;
    case "rsi_bearish_divergence":
      need(near(h1, h3, 0.02), "Price at or near a new 3-month high");
      need(x.RSI != null && x.RSI <= 65, `RSI ${x.RSI != null ? Math.round(x.RSI) : "?"} held under 65 (not making a new high)`);
      break;
    default:
      return { ok: false, checks: [{ ok: false, text: "No screener rule for this pattern" }] };
  }
  return { ok: out.every((v) => v.ok), checks: out, heightPct: l3 > 0 ? Math.round(((h3 - l3) / l3) * 1000) / 10 : undefined };
}
