// Pivot-based chart-pattern detector. Pure functions, no I/O, so it runs anywhere (server, tests, a worker).
//
// Each stock keeps a small running state instead of its full history: the last 21 daily bars, the last 14
// confirmed pivots (swing highs/lows, 10 bars on each side), ATR(14) and RSI(14). `step` adds one completed
// daily bar, so after one seed from get_ohlcv the state is kept current from the screener (one call per
// market a day). Each detector reads the pivot sequence and scores how well it matches its pattern, 0-100.
// Bearish patterns run the bullish rules on a mirrored view (price -> 1/price), which keeps every ratio.

export const LEFT = 10, RIGHT = 10, KEEP_PIVOTS = 14, ATR_N = 14, RSI_N = 14;
const WIN = LEFT + RIGHT + 1;

export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
/** k: H(igh) or L(ow); i: bar number since the seed; p: price; r: RSI at that bar. */
export type Pivot = { k: "H" | "L"; i: number; t: number; p: number; r: number };
/** Extremes since the last confirmed pivot (the swing still forming). */
type Post = { hi: number; hiI: number; hiT: number; hiR: number; lo: number; loI: number; loT: number; loR: number; maxC: number; minC: number };
export type TrackState = {
  v: 1;
  /** Bars seen. */
  n: number;
  win: Bar[]; rsiWin: number[];
  atr: number; pc: number; g: number; ls: number;
  piv: Pivot[];
  post: Post;
};

const emptyPost = (): Post => ({ hi: -Infinity, hiI: -1, hiT: 0, hiR: 50, lo: Infinity, loI: -1, loT: 0, loR: 50, maxC: -Infinity, minC: Infinity });
export const newState = (): TrackState => ({ v: 1, n: 0, win: [], rsiWin: [], atr: 0, pc: 0, g: 0, ls: 0, piv: [], post: emptyPost() });

function grow(p: Post, b: Bar, i: number, r: number) {
  if (b.h > p.hi) { p.hi = b.h; p.hiI = i; p.hiT = b.t; p.hiR = r; }
  if (b.l < p.lo) { p.lo = b.l; p.loI = i; p.loT = b.t; p.loR = r; }
  if (b.c > p.maxC) p.maxC = b.c;
  if (b.c < p.minC) p.minC = b.c;
}

/** Add one completed daily bar. Mutates and returns the state. */
export function step(s: TrackState, b: Bar): TrackState {
  const tr = s.n ? Math.max(b.h - b.l, Math.abs(b.h - s.pc), Math.abs(b.l - s.pc)) : b.h - b.l;
  s.atr = s.n < ATR_N ? (s.atr * s.n + tr) / (s.n + 1) : (s.atr * (ATR_N - 1) + tr) / ATR_N;
  let r = 50;
  if (s.n) {
    const d = b.c - s.pc, up = Math.max(d, 0), dn = Math.max(-d, 0);
    const m = Math.min(s.n, RSI_N);
    s.g = (s.g * (m - 1) + up) / m; s.ls = (s.ls * (m - 1) + dn) / m;
    r = s.ls === 0 ? (s.g === 0 ? 50 : 100) : 100 - 100 / (1 + s.g / s.ls);
  }
  s.win.push(b); s.rsiWin.push(r);
  if (s.win.length > WIN) { s.win.shift(); s.rsiWin.shift(); }
  grow(s.post, b, s.n, r);
  s.n++; s.pc = b.c;
  if (s.win.length === WIN) {
    const c = s.win[LEFT], ci = s.n - 1 - RIGHT;
    let hi = true, lo = true;
    for (let k = 0; k < WIN; k++) {
      if (k === LEFT) continue;
      const x = s.win[k];
      if (k < LEFT ? x.h >= c.h : x.h > c.h) hi = false;
      if (k < LEFT ? x.l <= c.l : x.l < c.l) lo = false;
    }
    // An outside bar can be both: take the one that continues the alternation first.
    const order: ("H" | "L")[] = s.piv.at(-1)?.k === "H" ? ["L", "H"] : ["H", "L"];
    for (const k of order) if (k === "H" ? hi : lo) addPivot(s, { k, i: ci, t: c.t, p: k === "H" ? c.h : c.l, r: s.rsiWin[LEFT] });
  }
  return s;
}

function addPivot(s: TrackState, p: Pivot) {
  const last = s.piv.at(-1);
  if (last && last.k === p.k) {
    // Same side twice: keep the more extreme one.
    if (p.k === "H" ? p.p <= last.p : p.p >= last.p) return;
    s.piv[s.piv.length - 1] = p;
  } else {
    // Swings smaller than one ATR are noise.
    if (last && Math.abs(p.p - last.p) < s.atr) return;
    s.piv.push(p);
    if (s.piv.length > KEEP_PIVOTS) s.piv.shift();
  }
  s.post = emptyPost();
  for (let k = LEFT + 1; k < s.win.length; k++) grow(s.post, s.win[k], s.n - s.win.length + k, s.rsiWin[k]);
}

/** A state from a run of daily bars, oldest first. */
export function seed(bars: { t: number[]; o?: number[]; h: number[]; l: number[]; c: number[]; v?: number[] }, upTo = bars.c.length): TrackState {
  const s = newState();
  for (let k = 0; k < upTo; k++) step(s, { t: bars.t[k], o: bars.o?.[k] ?? bars.c[k], h: bars.h[k], l: bars.l[k], c: bars.c[k], v: bars.v?.[k] ?? 0 });
  return s;
}

// ---------------------------------------------------------------------------------------------------------
// Detection

export type Stage = "forming" | "breakout" | "failed";
export type DPoint = { i: number; t: number; price: number; label: string };
export type DLine = { i1: number; t1: number; p1: number; i2: number; t2: number; p2: number; role: "upper" | "lower" | "level"; label: string };
export type Detection = { id: string; score: number; stage: Stage; points: DPoint[]; lines: DLine[]; checks: string[]; trigger?: number; target?: number; stop?: number; from: number; to: number };

/** A pivot in the view: p is the view price (mirrored for bearish rules), op the real price. prov = still forming. */
type VP = { k: "H" | "L"; i: number; t: number; p: number; op: number; r: number; prov?: boolean };
type View = { P: VP[]; c: number; a: number; now: number; nowT: number; minC: number; maxC: number; un: (p: number) => number };

function viewOf(s: TrackState, mirror: boolean): View | null {
  if (s.n < 60 || !s.win.length || s.atr <= 0) return null;
  const last = s.win.at(-1)!, a = s.atr / last.c;
  const f = (p: number) => (mirror ? 1 / p : p);
  const flip = (k: "H" | "L"): "H" | "L" => (mirror ? (k === "H" ? "L" : "H") : k);
  const P: VP[] = s.piv.map((x) => ({ k: flip(x.k), i: x.i, t: x.t, p: f(x.p), op: x.p, r: mirror ? 100 - x.r : x.r }));
  // The swing that is still forming after the last confirmed pivot.
  const lp = s.piv.at(-1), q = s.post;
  if (lp) {
    if (lp.k === "H" && q.loI > lp.i && lp.p - q.lo >= s.atr) P.push({ k: flip("L"), i: q.loI, t: q.loT, p: f(q.lo), op: q.lo, r: mirror ? 100 - q.loR : q.loR, prov: true });
    if (lp.k === "L" && q.hiI > lp.i && q.hi - lp.p >= s.atr) P.push({ k: flip("H"), i: q.hiI, t: q.hiT, p: f(q.hi), op: q.hi, r: mirror ? 100 - q.hiR : q.hiR, prov: true });
  }
  const minC = Math.min(q.minC, last.c), maxC = Math.max(q.maxC, last.c);
  return { P, c: f(last.c), a, now: s.n - 1, nowT: last.t, minC: mirror ? 1 / maxC : minC, maxC: mirror ? 1 / minC : maxC, un: f };
}

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
/** Fraction difference of two prices against the smaller. */
const diff = (x: number, y: number) => Math.abs(x - y) / Math.min(x, y);
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const ramp = (x: number, lo: number, hi: number) => clamp((x - lo) / (hi - lo));
/** Index of the last pivot of kind k, if it is the last pivot or followed by at most `after` more. */
function lastOf(P: VP[], k: "H" | "L", after = 1) {
  for (let j = P.length - 1; j >= Math.max(0, P.length - 1 - after); j--) if (P[j].k === k) return j;
  return -1;
}
/** Lowest view close since pivot j (approximate: lows of later pivots and the forming swing). */
const minSince = (V: View, j: number) => Math.min(V.minC, V.c, ...V.P.slice(j + 1).filter((x) => x.k === "L").map((x) => x.p));
const pt = (V: View, x: VP, label: string): DPoint => ({ i: x.i, t: x.t, price: x.op, label });
const line = (V: View, i1: number, t1: number, p1: number, i2: number, t2: number, p2: number, role: DLine["role"], label: string): DLine =>
  ({ i1, t1, p1: V.un(p1), i2, t2, p2: V.un(p2), role, label });
/** Role names for the real chart: a mirrored "upper" is the real lower line. */
const role = (m: boolean, r: "upper" | "lower"): "upper" | "lower" => (m ? (r === "upper" ? "lower" : "upper") : r);
const score = (parts: [number, number][]) => Math.round(parts.reduce((s, [w, q]) => s + w * clamp(q), 0));
const breakStage = (V: View, trigger: number, failAt: number, minC: number): Stage => (minC < failAt ? "failed" : V.c > trigger * (1 + V.a) ? "breakout" : "forming");
const stageQ = (st: Stage, V: View, trigger: number, base: number) => (st === "breakout" ? 1 : st === "failed" ? 0 : 0.4 + 0.5 * ramp(V.c, base, trigger));

type Words = { bottom: string; neck: string; id: string };

function doubleBottom(V: View, m: boolean, w: Words): Detection | null {
  const P = V.P, j2 = lastOf(P, "L");
  if (j2 < 3) return null;
  const [H0, L1, N, L2] = [P[j2 - 3], P[j2 - 2], P[j2 - 1], P[j2]];
  const span = L2.i - L1.i, sim = diff(L1.p, L2.p), lo = Math.min(L1.p, L2.p), hiB = Math.max(L1.p, L2.p);
  if (sim > 0.03 || span < 22 || span > 130) return null;
  if (N.p < hiB * 1.1 || N.p < hiB * (1 + V.a)) return null;
  if (H0.p < L1.p * 1.1) return null;
  const minC = minSince(V, j2), height = N.p - lo, target = N.p + height;
  const st = breakStage(V, N.p, lo * 0.97, minC);
  if (V.c > target) return null; // already played out
  const sc = score([[25, 1 - sim / 0.03], [20, ramp(N.p / hiB - 1, 0.08, 0.25)], [15, span >= 30 && span <= 100 ? 1 : 0.5], [15, ramp(H0.p / L1.p - 1, 0.08, 0.25)], [25, stageQ(st, V, N.p, lo)]]) - (L2.prov ? 10 : 0);
  return { id: w.id, score: sc, stage: st, from: L1.i, to: V.now,
    points: [pt(V, L1, `${w.bottom} 1`), pt(V, N, w.neck), pt(V, L2, `${w.bottom} 2`)],
    lines: [line(V, N.i, N.t, N.p, V.now, V.nowT, N.p, "level", w.neck)],
    checks: [`${w.bottom}s within ${pct(sim)}`, `${span} bars apart`, `${w.neck} ${pct(N.p / hiB - 1)} from the ${w.bottom.toLowerCase()}s`, `Prior move ${pct(H0.p / L1.p - 1)}`, `Stage: ${st}`],
    trigger: V.un(N.p), target: V.un(target), stop: V.un(lo) };
}

function tripleBottom(V: View, m: boolean, w: Words): Detection | null {
  const P = V.P, j3 = lastOf(P, "L");
  if (j3 < 5) return null;
  const [H0, L1, N1, L2, N2, L3] = P.slice(j3 - 5, j3 + 1);
  const bs = [L1.p, L2.p, L3.p], lo = Math.min(...bs), hi = Math.max(...bs), spread = hi / lo - 1, span = L3.i - L1.i;
  const neck = Math.max(N1.p, N2.p);
  if (spread > 0.04 || span < 30 || span > 200 || neck < hi * 1.08 || H0.p < L1.p * 1.1) return null;
  const st = breakStage(V, neck, lo * 0.97, minSince(V, j3)), target = neck + (neck - lo);
  if (V.c > target) return null;
  const sc = score([[25, 1 - spread / 0.04], [20, ramp(neck / hi - 1, 0.06, 0.2)], [15, 1], [15, ramp(H0.p / L1.p - 1, 0.08, 0.25)], [25, stageQ(st, V, neck, lo)]]) - (L3.prov ? 10 : 0);
  return { id: w.id, score: sc, stage: st, from: L1.i, to: V.now,
    points: [pt(V, L1, `${w.bottom} 1`), pt(V, L2, `${w.bottom} 2`), pt(V, L3, `${w.bottom} 3`)],
    lines: [line(V, N1.i, N1.t, neck, V.now, V.nowT, neck, "level", w.neck)],
    checks: [`Three ${w.bottom.toLowerCase()}s within ${pct(spread)}`, `${span} bars`, `Stage: ${st}`], trigger: V.un(neck), target: V.un(target), stop: V.un(lo) };
}

function headShoulders(V: View, m: boolean, id: string): Detection | null {
  const P = V.P, j = lastOf(P, "L");
  if (j < 5) return null;
  const [H0, S1, N1, Hd, N2, S2] = P.slice(j - 5, j + 1);
  const sh = Math.min(S1.p, S2.p);
  if (sh / Hd.p < 1 + Math.max(V.a, 0.03) || diff(S1.p, S2.p) > 0.06) return null;
  const sym = Math.abs((Hd.i - S1.i) - (S2.i - Hd.i)) / (S2.i - S1.i), span = S2.i - S1.i;
  if (sym > 0.5 || span < 25 || span > 200 || H0.p < S1.p * 1.1) return null;
  const slope = (N2.p - N1.p) / (N2.i - N1.i), neckAt = (i: number) => N1.p + slope * (i - N1.i);
  const height = neckAt(Hd.i) - Hd.p;
  if (height < Hd.p * 0.08) return null;
  const trig = neckAt(V.now), target = trig + height;
  const st = breakStage(V, trig, Hd.p * 0.97, minSince(V, j));
  if (V.c > target) return null;
  const sc = score([[25, 1 - diff(S1.p, S2.p) / 0.06], [20, ramp(sh / Hd.p - 1, 0.03, 0.12)], [15, 1 - sym / 0.5], [15, ramp(height / Hd.p, 0.08, 0.25)], [25, stageQ(st, V, trig, S2.p)]]) - (S2.prov ? 10 : 0);
  const names = m ? ["Left shoulder", "Head", "Right shoulder"] : ["Left shoulder", "Head", "Right shoulder"];
  return { id, score: sc, stage: st, from: S1.i, to: V.now,
    points: [pt(V, S1, names[0]), pt(V, Hd, names[1]), pt(V, S2, names[2])],
    lines: [line(V, N1.i, N1.t, N1.p, V.now, V.nowT, trig, "level", "Neckline")],
    checks: [`Head ${pct(sh / Hd.p - 1)} beyond the shoulders`, `Shoulders within ${pct(diff(S1.p, S2.p))}`, `Time symmetry off by ${pct(sym)}`, `Stage: ${st}`],
    trigger: V.un(trig), target: V.un(target), stop: V.un(Hd.p) };
}

function cupHandle(V: View): Detection | null {
  const P = V.P, jr = lastOf(P, "H");
  if (jr < 3) return null;
  const [L0, R1, B, R2] = P.slice(jr - 3, jr + 1);
  const depth = (R1.p - B.p) / R1.p, rims = diff(R1.p, R2.p), span = R2.i - R1.i;
  const sym = Math.abs((B.i - R1.i) - (R2.i - B.i)) / span;
  if (depth < 0.12 || depth > 0.33 || rims > 0.03 || span < 35 || span > 325 || sym > 0.35 || R1.p < L0.p * 1.2) return null;
  const rim = Math.max(R1.p, R2.p), half = B.p + (R2.p - B.p) / 2;
  const hl = P[jr + 1], handleLow = hl ? hl.p : Math.min(V.minC, V.c), handleLen = V.now - R2.i;
  const drop = (R2.p - handleLow) / R2.p;
  if (drop > 0.12) return null;
  const minC = Math.min(V.minC, V.c, hl?.p ?? Infinity);
  const st: Stage = minC < half ? "failed" : V.c > rim * (1 + V.a) ? "breakout" : "forming";
  const target = rim + (R1.p - B.p);
  if (V.c > target) return null;
  const handled = handleLen >= 5 && drop >= V.a;
  const sc = score([[20, ramp(depth, 0.1, 0.18) * (1 - ramp(depth, 0.3, 0.36))], [20, 1 - rims / 0.03], [15, 1 - sym / 0.35], [15, ramp(R1.p / L0.p - 1, 0.15, 0.4)], [10, handled ? 1 : 0.3], [20, stageQ(st, V, rim, half)]]);
  const points = [pt(V, R1, "Left rim"), pt(V, B, "Cup bottom"), pt(V, R2, "Right rim")];
  if (hl) points.push(pt(V, hl, "Handle"));
  return { id: "cup_handle", score: sc, stage: st, from: R1.i, to: V.now, points,
    lines: [line(V, R1.i, R1.t, rim, V.now, V.nowT, rim, "level", "Rim")],
    checks: [`Cup depth ${pct(depth)}`, `Rims within ${pct(rims)}`, `${span}-bar cup, symmetry off by ${pct(sym)}`, handled ? `Handle ${pct(drop)} over ${handleLen} bars` : "Handle not formed yet", `Prior rise ${pct(R1.p / L0.p - 1)}`, `Stage: ${st}`],
    trigger: rim, target, stop: handleLow };
}

function roundingBottom(V: View): Detection | null {
  const P = V.P;
  // The rim: the highest pivot high of the last 8 pivots, with the low after it as the base.
  const recent = P.slice(-8);
  let R = -1;
  for (let j = 0; j < recent.length; j++) if (recent[j].k === "H" && (R < 0 || recent[j].p > recent[R].p)) R = j;
  if (R < 0) return null;
  const R1 = recent[R], after = recent.slice(R + 1), lows = after.filter((x) => x.k === "L");
  if (!lows.length) return null;
  const B = lows.reduce((a, b) => (b.p < a.p ? b : a));
  const depth = (R1.p - B.p) / R1.p, dur = V.now - R1.i, mid = (B.i - R1.i) / dur, rec = (V.c - B.p) / (R1.p - B.p);
  if (depth < 0.15 || depth > 0.5 || dur < 40 || mid < 0.25 || mid > 0.75 || rec < 0.5 || rec > 1.15) return null;
  // Smooth: no swing inside the bowl retraces more than a quarter of its depth.
  for (let j = 1; j < after.length; j++) if (Math.abs(after[j].p - after[j - 1].p) > 0.3 * (R1.p - B.p)) return null;
  const st: Stage = V.c > R1.p * (1 + V.a) ? "breakout" : "forming";
  const sc = score([[25, 1 - Math.abs(mid - 0.5) / 0.25], [20, ramp(depth, 0.12, 0.25)], [20, ramp(dur, 40, 90)], [35, st === "breakout" ? 1 : rec]]);
  return { id: "rounding_bottom", score: sc, stage: st, from: R1.i, to: V.now, points: [pt(V, R1, "Left rim"), pt(V, B, "Base")],
    lines: [line(V, R1.i, R1.t, R1.p, V.now, V.nowT, R1.p, "level", "Rim")],
    checks: [`Depth ${pct(depth)}`, `${dur} bars`, `Recovered ${pct(rec)} of the drop`, `Stage: ${st}`], trigger: R1.p, target: R1.p + (R1.p - B.p), stop: B.p };
}

function vBottom(V: View): Detection | null {
  const P = V.P, j = lastOf(P, "L");
  if (j < 1) return null;
  const H0 = P[j - 1], L = P[j], drop = (H0.p - L.p) / H0.p, down = L.i - H0.i, up = V.now - L.i, rec = (V.c - L.p) / (H0.p - L.p);
  if (drop < 0.15 || down > 40 || up < 3 || up > down * 1.5 + 5 || rec < 0.6) return null;
  const st: Stage = V.c >= H0.p ? "breakout" : "forming";
  const sc = score([[30, ramp(drop, 0.12, 0.3)], [30, ramp(rec, 0.5, 0.9)], [20, 1 - ramp(up / Math.max(down, 1), 0.8, 1.6)], [20, ramp(40 - down, 0, 15)]]);
  return { id: "v_bottom", score: sc, stage: st, from: H0.i, to: V.now, points: [pt(V, H0, "Start"), pt(V, L, "Low")],
    lines: [line(V, H0.i, H0.t, H0.p, V.now, V.nowT, H0.p, "level", "Prior high")],
    checks: [`Fell ${pct(drop)} in ${down} bars`, `Recovered ${pct(rec)} in ${up} bars`, `Stage: ${st}`], trigger: H0.p, stop: L.p };
}

/** The last 4-6 confirmed pivots, split into highs and lows, with a line through the first and last of each. */
function sides(V: View) {
  const conf = V.P.filter((x) => !x.prov), last = conf.slice(-6);
  const H = last.filter((x) => x.k === "H"), L = last.filter((x) => x.k === "L");
  if (H.length < 2 || L.length < 2) return null;
  const fit = (xs: VP[]) => {
    const a = xs[0], b = xs.at(-1)!, s = (b.p - a.p) / (b.i - a.i);
    return { a, b, s, rel: s / ((a.p + b.p) / 2), at: (i: number) => a.p + s * (i - a.i),
      err: Math.max(...xs.map((x) => Math.abs(x.p - (a.p + s * (x.i - a.i))) / x.p)) };
  };
  return { H, L, hi: fit(H), lo: fit(L), from: last[0].i, span: V.now - last[0].i };
}

function triangle(V: View, m: boolean): Detection | null {
  const S = sides(V);
  if (!S || S.span < 20 || S.span > 200) return null;
  const res = Math.max(...S.H.map((x) => x.p)), flat = res / Math.min(...S.H.map((x) => x.p)) - 1;
  const rising = S.L.every((x, k) => k === 0 || x.p > S.L[k - 1].p);
  const rise = S.L.at(-1)!.p / S.L[0].p - 1;
  if (flat > 0.03 || !rising || rise < 2 * V.a) return null;
  const sup = S.lo.at(V.now), st: Stage = V.c < sup * 0.97 ? "failed" : V.c > res * (1 + V.a) ? "breakout" : "forming";
  const target = res + (res - S.L[0].p);
  if (V.c > target) return null;
  const sc = score([[30, 1 - flat / 0.03], [20, ramp(rise, 0.02, 0.06)], [15, ramp(S.H.length + S.L.length, 3, 5)], [10, 1 - ramp(S.lo.err, 0.01, 0.04)], [25, stageQ(st, V, res, sup)]]);
  return { id: m ? "descending_triangle" : "ascending_triangle", score: sc, stage: st, from: S.from, to: V.now,
    points: [...S.H.map((x, k) => pt(V, x, `${m ? "Low" : "High"} ${k + 1}`)), ...S.L.map((x, k) => pt(V, x, `${m ? "High" : "Low"} ${k + 1}`))],
    lines: [line(V, S.H[0].i, S.H[0].t, res, V.now, V.nowT, res, role(m, "upper"), m ? "Support" : "Resistance"),
      line(V, S.lo.a.i, S.lo.a.t, S.lo.a.p, V.now, V.nowT, sup, role(m, "lower"), m ? "Falling highs" : "Rising lows")],
    checks: [`${m ? "Lows" : "Highs"} flat within ${pct(flat)}`, `${m ? "Highs fell" : "Lows rose"} ${pct(rise)}`, `${S.H.length + S.L.length} touches over ${S.span} bars`, `Stage: ${st}`],
    trigger: V.un(res), target: V.un(target), stop: V.un(sup) };
}

function wedge(V: View, m: boolean): Detection | null {
  const S = sides(V);
  if (!S || S.span < 20 || S.span > 200) return null;
  // Falling wedge: both lines fall, the highs faster, so they converge.
  if (S.hi.rel >= -0.0005 || S.lo.rel >= -0.0003 || S.hi.rel >= S.lo.rel || S.hi.err > 0.04 || S.lo.err > 0.04) return null;
  const top = S.hi.at(V.now), bot = S.lo.at(V.now);
  if (top <= bot) return null;
  const st: Stage = V.c < bot * 0.97 ? "failed" : V.c > top * (1 + V.a / 2) ? "breakout" : "forming";
  const target = S.H[0].p;
  if (V.c > target) return null;
  const conv = 1 - (top - bot) / (S.hi.at(S.from) - S.lo.at(S.from));
  if (conv < 0.15) return null;
  const sc = score([[25, ramp(conv, 0.2, 0.6)], [20, 1 - ramp(Math.max(S.hi.err, S.lo.err), 0.01, 0.04)], [15, ramp(S.H.length + S.L.length, 4, 6)], [15, ramp(S.span, 20, 60)], [25, stageQ(st, V, top, bot)]]);
  return { id: m ? "rising_wedge" : "falling_wedge", score: sc, stage: st, from: S.from, to: V.now,
    points: [...S.H.map((x, k) => pt(V, x, `${m ? "Low" : "High"} ${k + 1}`)), ...S.L.map((x, k) => pt(V, x, `${m ? "High" : "Low"} ${k + 1}`))],
    lines: [line(V, S.hi.a.i, S.hi.a.t, S.hi.a.p, V.now, V.nowT, top, role(m, "upper"), "Upper line"), line(V, S.lo.a.i, S.lo.a.t, S.lo.a.p, V.now, V.nowT, bot, role(m, "lower"), "Lower line")],
    checks: [`Lines converge ${pct(conv)}`, `${S.H.length + S.L.length} touches over ${S.span} bars`, `Stage: ${st}`], trigger: V.un(top), target: V.un(target), stop: V.un(bot) };
}

function channel(V: View, m: boolean): Detection | null {
  const S = sides(V);
  if (!S || S.span < 30 || S.span > 250) return null;
  const up = (xs: VP[]) => xs.every((x, k) => k === 0 || x.p > xs[k - 1].p);
  if (!up(S.H) || !up(S.L) || S.hi.rel <= 0.0005 || S.lo.rel <= 0.0005) return null;
  const par = Math.abs(S.hi.rel - S.lo.rel) / Math.max(S.hi.rel, S.lo.rel);
  if (par > 0.4 || S.hi.err > 0.04 || S.lo.err > 0.04) return null;
  const top = S.hi.at(V.now), bot = S.lo.at(V.now);
  if (V.c < bot * 0.97) return null; // broke down: no longer a channel
  const pos = clamp((V.c - bot) / (top - bot));
  const sc = score([[30, 1 - par / 0.4], [25, 1 - ramp(Math.max(S.hi.err, S.lo.err), 0.01, 0.04)], [20, ramp(S.H.length + S.L.length, 4, 6)], [25, ramp(S.span, 30, 90)]]);
  return { id: m ? "descending_channel" : "ascending_channel", score: sc, stage: V.c > top * (1 + V.a) ? "breakout" : "forming", from: S.from, to: V.now,
    points: [...S.H.map((x, k) => pt(V, x, `${m ? "Low" : "High"} ${k + 1}`)), ...S.L.map((x, k) => pt(V, x, `${m ? "High" : "Low"} ${k + 1}`))],
    lines: [line(V, S.hi.a.i, S.hi.a.t, S.hi.a.p, V.now, V.nowT, top, role(m, "upper"), "Upper line"), line(V, S.lo.a.i, S.lo.a.t, S.lo.a.p, V.now, V.nowT, bot, role(m, "lower"), "Lower line")],
    checks: [`Lines parallel within ${pct(par)}`, `${S.H.length + S.L.length} touches over ${S.span} bars`, `Price at ${pct(m ? 1 - pos : pos)} of the channel`],
    trigger: V.un(top), stop: V.un(bot) };
}

function flag(V: View, m: boolean): Detection | null {
  const P = V.P.filter((x) => !x.prov), j = lastOf(P, "H");
  if (j < 1) return null;
  const L0 = P[j - 1], H1 = P[j], pole = H1.p / L0.p - 1, poleLen = H1.i - L0.i, len = V.now - H1.i;
  if (pole < 0.15 || poleLen > 30 || len < 5 || len > 30) return null;
  const low = minSince(V, j), retr = (H1.p - low) / (H1.p - L0.p);
  if (retr > 0.5 || (H1.p - low) / H1.p < V.a) return null;
  const st: Stage = V.c > H1.p * (1 + V.a) ? "breakout" : "forming", target = H1.p + (H1.p - L0.p);
  const sc = score([[30, ramp(pole, 0.12, 0.3)], [25, 1 - ramp(retr, 0.25, 0.5)], [20, 1 - ramp(len / Math.max(poleLen, 1), 1, 2.5)], [25, st === "breakout" ? 1 : 0.6]]);
  return { id: m ? "bear_flag" : "bull_flag", score: sc, stage: st, from: L0.i, to: V.now, points: [pt(V, L0, "Pole start"), pt(V, H1, "Pole top")],
    lines: [line(V, H1.i, H1.t, H1.p, V.now, V.nowT, H1.p, "level", "Flag top")],
    checks: [`Pole ${pct(pole)} in ${poleLen} bars`, `Flag retraced ${pct(retr)} over ${len} bars`, `Stage: ${st}`], trigger: V.un(H1.p), target: V.un(target), stop: V.un(low) };
}

function divergence(V: View, m: boolean): Detection | null {
  const P = V.P, j2 = lastOf(P, "L");
  if (j2 < 2) return null;
  const L2 = P[j2], N = P[j2 - 1], L1 = P[j2 - 2], gap = L2.i - L1.i;
  if (L1.k !== "L" || L2.p >= L1.p || L2.r <= L1.r + 3 || gap < 5 || gap > 60 || L1.r > 40) return null;
  if (V.now - L2.i > 25) return null; // stale
  const st: Stage = V.c > N.p ? "breakout" : "forming";
  const sc = score([[35, ramp(L2.r - L1.r, 3, 12)], [25, ramp(40 - L1.r, 0, 15)], [15, ramp(L1.p / L2.p - 1, 0.01, 0.06)], [25, st === "breakout" ? 1 : 0.6]]) - (L2.prov ? 10 : 0);
  const lab = m ? "High" : "Low";
  return { id: m ? "rsi_bearish_divergence" : "rsi_bullish_divergence", score: sc, stage: st, from: L1.i, to: V.now,
    points: [pt(V, L1, `${lab} 1 (RSI ${Math.round(m ? 100 - L1.r : L1.r)})`), pt(V, L2, `${lab} 2 (RSI ${Math.round(m ? 100 - L2.r : L2.r)})`)],
    lines: [line(V, L1.i, L1.t, L1.p, L2.i, L2.t, L2.p, role(m, "lower"), `Price ${m ? "higher high" : "lower low"}`)],
    checks: [`Price ${m ? "rose" : "fell"} ${pct(L1.p / L2.p - 1)} while RSI ${m ? "fell" : "rose"} ${Math.round(L2.r - L1.r)} points`, `${gap} bars apart`, `Stage: ${st}`],
    trigger: V.un(N.p), stop: V.un(L2.p) };
}

/** Templates the detector covers. Others (and "use your own image") go to the AI as before. */
export const DETECTORS: Record<string, (s: TrackState) => Detection | null> = {
  double_bottom: (s) => run(s, false, (V) => doubleBottom(V, false, { bottom: "Bottom", neck: "Neckline", id: "double_bottom" })),
  double_top: (s) => run(s, true, (V) => doubleBottom(V, true, { bottom: "Top", neck: "Neckline", id: "double_top" })),
  triple_bottom: (s) => run(s, false, (V) => tripleBottom(V, false, { bottom: "Bottom", neck: "Neckline", id: "triple_bottom" })),
  inverse_head_shoulders: (s) => run(s, false, (V) => headShoulders(V, false, "inverse_head_shoulders")),
  head_shoulders: (s) => run(s, true, (V) => headShoulders(V, true, "head_shoulders")),
  cup_handle: (s) => run(s, false, cupHandle),
  rounding_bottom: (s) => run(s, false, roundingBottom),
  v_bottom: (s) => run(s, false, vBottom),
  ascending_triangle: (s) => run(s, false, (V) => triangle(V, false)),
  descending_triangle: (s) => run(s, true, (V) => triangle(V, true)),
  falling_wedge: (s) => run(s, false, (V) => wedge(V, false)),
  rising_wedge: (s) => run(s, true, (V) => wedge(V, true)),
  ascending_channel: (s) => run(s, false, (V) => channel(V, false)),
  descending_channel: (s) => run(s, true, (V) => channel(V, true)),
  bull_flag: (s) => run(s, false, (V) => flag(V, false)),
  bear_flag: (s) => run(s, true, (V) => flag(V, true)),
  rsi_bullish_divergence: (s) => run(s, false, (V) => divergence(V, false)),
  rsi_bearish_divergence: (s) => run(s, true, (V) => divergence(V, true)),
};

function run(s: TrackState, mirror: boolean, f: (V: View) => Detection | null): Detection | null {
  const V = viewOf(s, mirror);
  if (!V) return null;
  const d = f(V);
  return d ? { ...d, score: clamp(d.score, 0, 100) } : null;
}

export const detect = (s: TrackState, template: string) => DETECTORS[template]?.(s) ?? null;
