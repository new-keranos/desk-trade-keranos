// Synthetic checks for lib/scan/pivots.ts. No network. Run: node --experimental-strip-types scripts/test-pivots.ts
import { detect, seed, step, DETECTORS, type TrackState } from "../lib/scan/pivots.ts";

/** Daily bars through the anchor prices [bar, price], linear in between, with a small deterministic wiggle. */
function series(anchors: [number, number][], noise = 0.004) {
  const t: number[] = [], o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [], v: number[] = [];
  let seedR = 7;
  const rnd = () => ((seedR = (seedR * 16807) % 2147483647) / 2147483647 - 0.5);
  let prev = anchors[0][1];
  for (let k = 0; k < anchors.length - 1; k++) {
    const [i0, p0] = anchors[k], [i1, p1] = anchors[k + 1];
    for (let i = i0; i < i1; i++) {
      const base = p0 + ((p1 - p0) * (i - i0)) / (i1 - i0), close = base * (1 + rnd() * noise);
      t.push(1_700_000_000 + i * 86400); o.push(prev); c.push(close);
      h.push(Math.max(prev, close) * (1 + Math.abs(rnd()) * noise)); l.push(Math.min(prev, close) * (1 - Math.abs(rnd()) * noise)); v.push(1e6);
      prev = close;
    }
  }
  return { t, o, h, l, c, v };
}
const mirror = (a: [number, number][]) => a.map(([i, p]) => [i, 10000 / p] as [number, number]);

const cases: { name: string; expect: string; anchors: [number, number][]; mirrorOf?: boolean }[] = [
  { name: "double bottom, forming", expect: "double_bottom", anchors: [[0, 80], [40, 120], [80, 90], [110, 105], [140, 90.5], [165, 101]] },
  { name: "double bottom, breakout", expect: "double_bottom", anchors: [[0, 80], [40, 120], [80, 90], [110, 105], [140, 90.5], [175, 110]] },
  { name: "cup and handle", expect: "cup_handle", anchors: [[0, 70], [15, 60], [50, 100], [95, 78], [140, 100], [150, 96], [160, 98.5]] },
  { name: "triple bottom", expect: "triple_bottom", anchors: [[0, 80], [30, 120], [60, 90], [80, 101], [100, 90.8], [120, 101], [140, 90.3], [165, 99]] },
  { name: "inverse head & shoulders", expect: "inverse_head_shoulders", anchors: [[0, 80], [30, 120], [60, 95], [80, 106], [105, 85], [130, 106], [155, 95.5], [175, 104]] },
  { name: "ascending triangle", expect: "ascending_triangle", anchors: [[0, 70], [40, 85], [60, 100], [80, 88], [100, 100.5], [120, 92], [140, 100.2], [160, 95], [170, 99]] },
  { name: "falling wedge", expect: "falling_wedge", anchors: [[0, 90], [30, 120], [50, 100], [70, 112], [90, 97], [110, 105], [130, 94.5], [150, 100], [160, 98]] },
  { name: "rising channel", expect: "ascending_channel", anchors: [[0, 70], [30, 80], [50, 92], [70, 86], [90, 100], [110, 94], [130, 108], [150, 102], [165, 112]] },
  { name: "bull flag", expect: "bull_flag", anchors: [[0, 80], [60, 82], [100, 80], [120, 100], [130, 95], [140, 97], [150, 94]] },
  { name: "V bottom", expect: "v_bottom", anchors: [[0, 90], [60, 100], [85, 75], [105, 95]] },
  { name: "flat noise (no pattern)", expect: "none", anchors: [[0, 100], [170, 101]] },
  { name: "straight uptrend (no bottom)", expect: "none", anchors: [[0, 50], [170, 110]] },
];
// Bearish mirrors of the bullish shapes.
for (const [from, to] of [["double bottom, forming", "double_top"], ["inverse head & shoulders", "head_shoulders"], ["ascending triangle", "descending_triangle"], ["falling wedge", "rising_wedge"], ["rising channel", "descending_channel"], ["bull flag", "bear_flag"]]) {
  const c = cases.find((x) => x.name === from)!;
  cases.push({ name: `${to} (mirror of ${from})`, expect: to, anchors: mirror(c.anchors) });
}

let fail = 0;
for (const c of cases) {
  const s = seed(series(c.anchors));
  const hits = Object.keys(DETECTORS).map((id) => detect(s, id)).filter((d) => d && d.score >= 70) as NonNullable<ReturnType<typeof detect>>[];
  const ok = c.expect === "none" ? hits.length === 0 : hits.some((d) => d.id === c.expect);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(48)} -> ${hits.map((d) => `${d.id}:${d.score}(${d.stage})`).join(", ") || "none"}`);
  if (!ok || process.env.V) {
    const d = detect(s, c.expect);
    console.log("      pivots:", s.piv.map((p) => `${p.k}${p.i}@${p.p.toFixed(1)}`).join(" "), d ? `| ${d.score} ${d.checks.join("; ")}` : "| no detection");
  }
}

// Incremental == batch: feeding bars one by one through JSON round-trips gives the same state as a seed.
const b = series(cases[0].anchors);
let s: TrackState = seed(b, 100);
for (let k = 100; k < b.c.length; k++) s = step(JSON.parse(JSON.stringify(s)), { t: b.t[k], o: b.o[k], h: b.h[k], l: b.l[k], c: b.c[k], v: b.v[k] });
const same = JSON.stringify(s) === JSON.stringify(seed(b));
console.log(`${same ? "PASS" : "FAIL"}  incremental update matches a full seed`);
if (!same) fail++;
console.log(`state size: ${JSON.stringify(s).length} bytes`);
console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
