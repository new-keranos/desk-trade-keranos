// Price-level checks for each template, run on a window that already matches the shape.
// The shape score works on prices squeezed to 0..1, so it can't tell that a "cup" has a left rim far below
// its right rim. These rules look at real prices at the template's turning points.
import type { Template } from "./templates";

export type KeyPoint = { k: number; price: number };
export type Verdict = { ok: boolean; checks: string[]; points: KeyPoint[] };

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const gap = (a: number, b: number) => Math.abs(a - b) / Math.min(a, b);
const spread = (v: number[]) => Math.max(...v) / Math.min(...v) - 1;

/** Real price at each template anchor: the highest close near a peak anchor, the lowest near a trough, the close itself elsewhere. */
export function keyPoints(win: number[], anchors: [number, number][]): KeyPoint[] {
  const n = win.length, r = Math.max(2, Math.round(n * 0.08));
  return anchors.map(([x, y], a) => {
    const c = Math.round(x * (n - 1));
    const prev = anchors[a - 1]?.[1], next = anchors[a + 1]?.[1];
    const peak = (prev === undefined || y > prev) && (next === undefined || y > next);
    const trough = (prev === undefined || y < prev) && (next === undefined || y < next);
    if (!peak && !trough) return { k: c, price: win[c] };
    let best = c;
    for (let k = Math.max(0, c - r); k <= Math.min(n - 1, c + r); k++) {
      if (peak ? win[k] > win[best] : win[k] < win[best]) best = k;
    }
    return { k: best, price: win[best] };
  });
}

type Rule = (p: number[]) => [boolean, string][];

// p[i] is the price at anchor i of the template (see TEMPLATES for the anchor order).
const RULES: Record<string, Rule> = {
  double_bottom: (p) => [
    [gap(p[1], p[3]) <= 0.04, `two lows within ${pct(gap(p[1], p[3]))} of each other`],
    [p[2] >= Math.max(p[1], p[3]) * 1.05, `neckline ${pct(p[2] / Math.max(p[1], p[3]) - 1)} above the lows`],
    [p[0] >= p[2], "came down from above the neckline"],
  ],
  double_top: (p) => [
    [gap(p[1], p[3]) <= 0.04, `two highs within ${pct(gap(p[1], p[3]))} of each other`],
    [p[2] <= Math.min(p[1], p[3]) * 0.95, `neckline ${pct(1 - p[2] / Math.min(p[1], p[3]))} below the highs`],
    [p[0] <= p[2], "rose from below the neckline"],
  ],
  triple_bottom: (p) => [
    [spread([p[1], p[3], p[5]]) <= 0.05, `three lows within ${pct(spread([p[1], p[3], p[5]]))}`],
    [Math.min(p[2], p[4]) >= Math.max(p[1], p[3], p[5]) * 1.04, "rallies between the lows of 4% or more"],
  ],
  inverse_head_shoulders: (p) => [
    [p[3] <= Math.min(p[1], p[5]) * 0.97, `head ${pct(1 - p[3] / Math.min(p[1], p[5]))} below the shoulders`],
    [gap(p[1], p[5]) <= 0.08, `shoulders within ${pct(gap(p[1], p[5]))} of each other`],
    [Math.min(p[2], p[4]) >= Math.max(p[1], p[5]) * 1.03, "neckline above both shoulders"],
  ],
  head_shoulders: (p) => [
    [p[3] >= Math.max(p[1], p[5]) * 1.03, `head ${pct(p[3] / Math.max(p[1], p[5]) - 1)} above the shoulders`],
    [gap(p[1], p[5]) <= 0.08, `shoulders within ${pct(gap(p[1], p[5]))} of each other`],
    [Math.max(p[2], p[4]) <= Math.min(p[1], p[5]) * 0.97, "neckline below both shoulders"],
  ],
  cup_handle: (p) => {
    const rim = Math.min(p[0], p[8]), depth = (rim - p[4]) / rim, handle = (p[8] - p[9]) / p[8];
    return [
      [gap(p[0], p[8]) <= 0.1, `left and right rims within ${pct(gap(p[0], p[8]))} of each other`],
      [depth >= 0.12 && depth <= 0.5, `cup depth ${pct(depth)} (12–50%)`],
      [handle <= 0.15 && p[9] > p[4] + 0.5 * (p[8] - p[4]), `handle pullback ${pct(handle)}, in the upper half of the cup`],
    ];
  },
  rounding_bottom: (p) => {
    const depth = (Math.min(p[0], p[6]) - p[3]) / Math.min(p[0], p[6]);
    return [
      [depth >= 0.1, `base depth ${pct(depth)}`],
      [gap(p[0], p[6]) <= 0.15, `start and end within ${pct(gap(p[0], p[6]))} of each other`],
    ];
  },
  v_bottom: (p) => {
    const drop = (p[0] - p[1]) / p[0], back = (p[2] - p[1]) / (p[0] - p[1] || 1);
    return [
      [drop >= 0.1, `fell ${pct(drop)}`],
      [back >= 0.7, back >= 1 ? "won back the whole fall" : `won back ${pct(back)} of the fall`],
    ];
  },
  ascending_triangle: (p) => [
    [spread([p[1], p[3], p[5]]) <= 0.04, `flat top: highs within ${pct(spread([p[1], p[3], p[5]]))}`],
    [p[4] >= p[2] * 1.01 && p[6] >= p[4] * 1.01, "each low higher than the last"],
  ],
  descending_triangle: (p) => [
    [spread([p[1], p[3], p[5]]) <= 0.04, `flat bottom: lows within ${pct(spread([p[1], p[3], p[5]]))}`],
    [p[4] <= p[2] * 0.99 && p[6] <= p[4] * 0.99, "each high lower than the last"],
  ],
  bull_flag: (p) => {
    const pole = (p[1] - p[0]) / p[0], low = Math.min(p[2], p[4], p[6]);
    return [
      [pole >= 0.12, `pole up ${pct(pole)}`],
      [low >= p[1] - 0.5 * (p[1] - p[0]), `flag gave back ${pct((p[1] - low) / (p[1] - p[0] || 1))} of the pole (max 50%)`],
    ];
  },
  bear_flag: (p) => {
    const pole = (p[0] - p[1]) / p[0], high = Math.max(p[2], p[4], p[6]);
    return [
      [pole >= 0.12, `pole down ${pct(pole)}`],
      [high <= p[1] + 0.5 * (p[0] - p[1]), `flag won back ${pct((high - p[1]) / (p[0] - p[1] || 1))} of the pole (max 50%)`],
    ];
  },
  falling_wedge: (p) => [
    [p[2] < p[0] && p[4] < p[2], "lower highs"],
    [p[3] < p[1] && p[5] < p[3], "lower lows"],
    [p[4] - p[5] < (p[0] - p[1]) * 0.8, "range narrowing"],
  ],
  rising_wedge: (p) => [
    [p[2] > p[0] && p[4] > p[2], "higher lows"],
    [p[3] > p[1] && p[5] > p[3], "higher highs"],
    [p[5] - p[4] < (p[1] - p[0]) * 0.8, "range narrowing"],
  ],
};

/** Check a price window against a template. Patterns without rules (an uploaded image) always pass. */
export function checkPattern(win: number[], t?: Template): Verdict {
  if (!t) return { ok: true, checks: [], points: [] };
  const points = keyPoints(win, t.anchors);
  const rule = RULES[t.id];
  if (!rule) return { ok: true, checks: [], points };
  const results = rule(points.map((x) => x.price));
  return { ok: results.every(([pass]) => pass), checks: results.map(([, text]) => text), points };
}
