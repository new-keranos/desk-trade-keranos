// Shape matching for the pattern scanner. Pure functions, no I/O.
// A price window is squeezed to N points, scaled to 0..1, and compared with the pattern shape by
// correlation (overall form) and banded dynamic time warping (lets swings land a few points early or late).

export const N = 48;

export type Length = "short" | "medium" | "long";
/** Window lengths in daily bars tried for each pattern length. */
export const WINDOWS: Record<Length, number[]> = {
  short: [20, 30, 40, 55],
  medium: [55, 75, 95, 120],
  long: [120, 150, 185, 230],
};
/** The pattern may have finished up to this many bars ago. */
const END_OFFSETS = [0, 3, 6];
/** Below this price range the window is noise, not a pattern. */
const MIN_HEIGHT_PCT = 5;

/** Resample to n points: bucket means when shrinking, linear interpolation when stretching. */
export function resample(v: number[], n: number): number[] {
  if (v.length === n) return v.slice();
  const out: number[] = [];
  if (v.length > n) {
    for (let i = 0; i < n; i++) {
      const a = Math.floor((i * v.length) / n), b = Math.max(a + 1, Math.floor(((i + 1) * v.length) / n));
      let s = 0;
      for (let k = a; k < b; k++) s += v[k];
      out.push(s / (b - a));
    }
    return out;
  }
  for (let i = 0; i < n; i++) {
    const x = (i * (v.length - 1)) / (n - 1), k = Math.floor(x), f = x - k;
    out.push(k + 1 < v.length ? v[k] * (1 - f) + v[k + 1] * f : v[k]);
  }
  return out;
}

export function normalize(v: number[]): number[] {
  const lo = Math.min(...v), hi = Math.max(...v), d = hi - lo || 1;
  return v.map((x) => (x - lo) / d);
}

export function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Mean absolute gap along the best warping path, with a Sakoe-Chiba band. Inputs in 0..1. */
export function dtwGap(a: number[], b: number[], band = Math.round(N / 10)): number {
  const n = a.length, m = b.length;
  const INF = Number.POSITIVE_INFINITY;
  let prev = new Float64Array(m + 1).fill(INF), prevLen = new Float64Array(m + 1);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    const cur = new Float64Array(m + 1).fill(INF), curLen = new Float64Array(m + 1);
    const lo = Math.max(1, i - band), hi = Math.min(m, i + band);
    for (let j = lo; j <= hi; j++) {
      const c = Math.abs(a[i - 1] - b[j - 1]);
      let best = prev[j - 1], len = prevLen[j - 1];
      if (prev[j] < best) { best = prev[j]; len = prevLen[j]; }
      if (cur[j - 1] < best) { best = cur[j - 1]; len = curLen[j - 1]; }
      cur[j] = best + c; curLen[j] = len + 1;
    }
    prev = cur; prevLen = curLen;
  }
  return prev[m] / Math.max(1, prevLen[m]);
}

/** 0..1 similarity between two normalized N-point shapes. */
export function similarity(window: number[], shape: number[]): number {
  const r = pearson(window, shape);
  const gap = dtwGap(window, shape);
  return 0.5 * Math.max(0, r) + 0.5 * Math.max(0, 1 - 2 * gap);
}

export type Match = { score: number; start: number; end: number; heightPct: number };

/** Best match of a normalized N-point shape anywhere near the end of a close series. */
export function bestMatch(closes: number[], shape: number[], length: Length): Match | null {
  let best: Match | null = null;
  for (const w of WINDOWS[length]) {
    for (const off of END_OFFSETS) {
      const end = closes.length - off, start = end - w;
      if (start < 0) continue;
      const win = closes.slice(start, end);
      const lo = Math.min(...win), hi = Math.max(...win);
      const heightPct = lo > 0 ? ((hi - lo) / lo) * 100 : 0;
      if (heightPct < MIN_HEIGHT_PCT) continue;
      // Slight preference for patterns that end on the latest bar.
      const score = similarity(normalize(resample(win, N)), shape) - off * 0.004;
      if (!best || score > best.score) best = { score, start, end, heightPct };
    }
  }
  return best;
}
