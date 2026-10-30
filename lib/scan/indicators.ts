// RSI and RSI divergence, shared by the chart (browser), the scanner and Agent (server).

/** Wilder's RSI; null until there are n changes. */
export function rsi(c: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = [null];
  let up = 0, dn = 0;
  for (let k = 1; k < c.length; k++) {
    const d = c[k] - c[k - 1], u = Math.max(d, 0), w = Math.max(-d, 0);
    if (k <= n) { up += u / n; dn += w / n; out.push(k === n ? (dn ? 100 - 100 / (1 + up / dn) : 100) : null); continue; }
    up = (up * (n - 1) + u) / n; dn = (dn * (n - 1) + w) / n;
    out.push(dn ? 100 - 100 / (1 + up / dn) : 100);
  }
  return out;
}

export type DivKind = "bullish" | "bearish" | "hidden_bullish" | "hidden_bearish";
export type DivPoint = { k: number; price: number; rsi: number };
export type Divergence = { kind: DivKind; a: DivPoint; b: DivPoint };

export const DIV_LABEL: Record<DivKind, string> = {
  bullish: "Bullish divergence", bearish: "Bearish divergence", hidden_bullish: "Hidden bullish", hidden_bearish: "Hidden bearish",
};

/** Bars whose low (or high) is the extreme of `left` bars before and `right` bars after. */
function pivots(v: number[], low: boolean, left: number, right: number) {
  const out: number[] = [];
  for (let k = left; k < v.length - right; k++) {
    let ok = true;
    for (let j = k - left; j <= k + right && ok; j++) if (j !== k && (low ? v[j] < v[k] : v[j] > v[k])) ok = false;
    if (ok && (!out.length || k - out[out.length - 1] > right)) out.push(k);
  }
  return out;
}

/**
 * RSI divergences between consecutive swing lows (bullish) and swing highs (bearish).
 * Regular: price makes a lower low but RSI a higher low (bullish), or a higher high with a lower RSI high (bearish).
 * Hidden: the reverse, a sign the trend continues. Pairs are 5 to 60 bars apart and RSI must differ by at least
 * `minRsi` points. Only pairs whose second point is within the last `recent` bars are returned, newest first.
 */
export function findDivergences(b: { h: number[]; l: number[]; c: number[] }, o: { recent?: number; minRsi?: number; hidden?: boolean } = {}): Divergence[] {
  const r = rsi(b.c), n = b.c.length, recent = o.recent ?? 60, minRsi = o.minRsi ?? 3;
  const out: Divergence[] = [];
  const pair = (ks: number[], low: boolean) => {
    for (let j = 1; j < ks.length; j++) {
      const ka = ks[j - 1], kb = ks[j], ra = r[ka], rb = r[kb];
      if (ra == null || rb == null || kb - ka < 5 || kb - ka > 60 || kb < n - recent) continue;
      const pa = low ? b.l[ka] : b.h[ka], pb = low ? b.l[kb] : b.h[kb];
      const a = { k: ka, price: pa, rsi: ra }, bb = { k: kb, price: pb, rsi: rb };
      if (Math.abs(rb - ra) < minRsi) continue;
      if (low && pb < pa && rb > ra) out.push({ kind: "bullish", a, b: bb });
      else if (!low && pb > pa && rb < ra) out.push({ kind: "bearish", a, b: bb });
      else if (o.hidden && low && pb > pa && rb < ra) out.push({ kind: "hidden_bullish", a, b: bb });
      else if (o.hidden && !low && pb < pa && rb > ra) out.push({ kind: "hidden_bearish", a, b: bb });
    }
  };
  // Swings need 5 bars on the left; 2 on the right so a divergence still forming near the latest bar shows up.
  pair(pivots(b.l, true, 5, 2), true);
  pair(pivots(b.h, false, 5, 2), false);
  return out.sort((x, y) => y.b.k - x.b.k);
}
