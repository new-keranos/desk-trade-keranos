// Small series helpers shared by the scanner and its charts. Pure functions, no I/O.

export const N = 48;

export type Length = "short" | "medium" | "long";

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
