"use client";

// A screener-only match (no bars at scan time) is checked on the chart the desk loads when the user opens it:
// the pivot pattern detector runs on those bars in the browser and its turning points and lines are drawn.
// Each check is kept in this browser, so the scanner can say how often the chart confirmed the screener.

import { detect, seed } from "@/lib/scan/pivots";
import type { PatternHit } from "./scanner";

/** Score the detector needs to count as a confirmation (same as the scanner's). */
const MIN = 70;
const STORE = "keranos.confirm.v1", EVENT = "keranos:confirm", MAX = 500;
export type Check = { id: string; pattern: string; symbol: string; ok: boolean; score: number; at: string };

const round = (x: number) => Math.round(x * 100) / 100;
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

export type Confirmed = PatternHit & { chart?: { ok: boolean; score: number; outline?: boolean } };

type B = { t: number[]; h: number[]; l: number[]; c: number[] };
type Pt = { i: number; price: number; label: string };
type Ln = { a: Pt; b: Pt; role: "upper" | "lower" | "level"; label: string };
const hiIn = (b: B, s: number, e: number): Pt => { let k = Math.min(Math.max(0, s), b.h.length - 1); for (let j = k; j < e; j++) if (b.h[j] > b.h[k]) k = j; return { i: k, price: b.h[k], label: "" }; };
const loIn = (b: B, s: number, e: number): Pt => { let k = Math.min(Math.max(0, s), b.l.length - 1); for (let j = k; j < e; j++) if (b.l[j] < b.l[k]) k = j; return { i: k, price: b.l[k], label: "" }; };
const lab = (p: Pt, label: string): Pt => ({ ...p, label });
/** Carry a line from a to b on to the last bar, so the outline reaches today. */
const toEnd = (b: B, a: Pt, z: Pt): Pt => { const n = b.c.length - 1; if (z.i === a.i) return { i: n, price: z.price, label: "" };
  return { i: n, price: a.price + ((z.price - a.price) * (n - a.i)) / (z.i - a.i), label: "" }; };

/**
 * The outline the screener saw, drawn on the loaded bars: the same 1/3/6-month highs and lows the screener rule
 * reads (./lib/scan/shape.ts), placed on the days they happened. Used when the stricter pattern detector finds
 * nothing, so an opened match always shows what it was picked for.
 */
export function outline(b: B, pattern: string): { from: number; points: Pt[]; lines: Ln[] } | null {
  const n = b.c.length;
  if (n < 70) return null;
  const m1 = n - 21, m3 = n - 63, m6 = n - 126, last: Pt = { i: n - 1, price: b.c[n - 1], label: "Now" };
  const hA = hiIn(b, m3, m1), hB = hiIn(b, m1, n), lA = loIn(b, m3, m1), lB = loIn(b, m1, n);
  const twoLines = (u: string, l: string): Ln[] => [
    { a: hA, b: toEnd(b, hA, hB), role: "upper", label: u }, { a: lA, b: toEnd(b, lA, lB), role: "lower", label: l }];
  const flat = (p: Pt, label: string, role: Ln["role"] = "level"): Ln => ({ a: p, b: { i: n - 1, price: p.price, label: "" }, role, label });
  const from = (...ps: Pt[]) => Math.min(...ps.map((p) => p.i));
  switch (pattern) {
    case "ascending_triangle": case "descending_triangle": case "falling_wedge": case "rising_wedge":
    case "ascending_channel": case "descending_channel": {
      const names: Record<string, [string, string]> = { ascending_triangle: ["Flat top", "Rising lows"], descending_triangle: ["Falling highs", "Flat bottom"],
        falling_wedge: ["Falling highs", "Falling lows"], rising_wedge: ["Rising highs", "Rising lows"], ascending_channel: ["Channel top", "Channel bottom"], descending_channel: ["Channel top", "Channel bottom"] };
      const [u, l] = names[pattern];
      // Triangles have one flat side: drawn level at the earlier extreme, not sloped through this month's.
      const lines = pattern === "ascending_triangle" ? [flat(hA, u, "upper"), twoLines(u, l)[1]]
        : pattern === "descending_triangle" ? [twoLines(u, l)[0], flat(lA, l, "lower")] : twoLines(u, l);
      return { from: from(hA, lA), points: [lab(hA, "High"), lab(hB, "High"), lab(lA, "Low"), lab(lB, "Low")], lines };
    }
    case "double_bottom": case "triple_bottom": case "rsi_bullish_divergence": {
      const neck = hiIn(b, lA.i + 1, Math.max(lA.i + 2, lB.i));
      return { from: lA.i, points: [lab(lA, pattern.startsWith("rsi") ? "Low 1" : "Bottom 1"), lab(lB, pattern.startsWith("rsi") ? "Low 2" : "Bottom 2"), lab(neck, "Neck")],
        lines: pattern.startsWith("rsi") ? [{ a: lA, b: lB, role: "lower", label: "Lows" }] : [flat(neck, "Neckline"), { a: lA, b: lB, role: "lower", label: "Bottoms" }] };
    }
    case "double_top": case "rsi_bearish_divergence": {
      const neck = loIn(b, hA.i + 1, Math.max(hA.i + 2, hB.i));
      return { from: hA.i, points: [lab(hA, pattern.startsWith("rsi") ? "High 1" : "Top 1"), lab(hB, pattern.startsWith("rsi") ? "High 2" : "Top 2"), lab(neck, "Neck")],
        lines: pattern.startsWith("rsi") ? [{ a: hA, b: hB, role: "upper", label: "Highs" }] : [flat(neck, "Neckline"), { a: hA, b: hB, role: "upper", label: "Tops" }] };
    }
    case "head_shoulders": {
      const head = hiIn(b, m3, n), ls = hiIn(b, m3 - 21, Math.max(m3 - 20, head.i - 5)), rs = hiIn(b, Math.min(n - 1, head.i + 5), n);
      const n1 = loIn(b, ls.i + 1, Math.max(ls.i + 2, head.i)), n2 = loIn(b, head.i + 1, Math.max(head.i + 2, rs.i));
      return { from: ls.i, points: [lab(ls, "Left shoulder"), lab(head, "Head"), lab(rs, "Right shoulder")], lines: [{ a: n1, b: toEnd(b, n1, n2), role: "level", label: "Neckline" }] };
    }
    case "inverse_head_shoulders": {
      const head = loIn(b, m3, n), ls = loIn(b, m3 - 21, Math.max(m3 - 20, head.i - 5)), rs = loIn(b, Math.min(n - 1, head.i + 5), n);
      const n1 = hiIn(b, ls.i + 1, Math.max(ls.i + 2, head.i)), n2 = hiIn(b, head.i + 1, Math.max(head.i + 2, rs.i));
      return { from: ls.i, points: [lab(ls, "Left shoulder"), lab(head, "Head"), lab(rs, "Right shoulder")], lines: [{ a: n1, b: toEnd(b, n1, n2), role: "level", label: "Neckline" }] };
    }
    case "cup_handle": case "rounding_bottom": {
      const bottom = loIn(b, m6, n), left = hiIn(b, m6 - 21, Math.max(m6 - 20, bottom.i)), right = hiIn(b, bottom.i + 1, n);
      const pts = [lab(left, "Left rim"), lab(bottom, "Bottom"), lab(right, pattern === "cup_handle" ? "Right rim" : "Recovery")];
      if (pattern === "cup_handle" && right.i < n - 2) pts.push(lab(loIn(b, right.i + 1, n), "Handle"));
      return { from: left.i, points: pts, lines: [flat(left, "Rim")] };
    }
    case "v_bottom": {
      const top = hiIn(b, m3, lB.i);
      return { from: top.i, points: [lab(top, "Start"), lab(lB, "Low"), last], lines: [{ a: top, b: lB, role: "upper", label: "Drop" }, { a: lB, b: last, role: "lower", label: "Rebound" }] };
    }
    case "bull_flag": {
      const top = hiIn(b, m1 - 21, n), base = loIn(b, m3, top.i), lo = loIn(b, top.i + 1, n);
      return { from: base.i, points: [lab(base, "Pole start"), lab(top, "Pole top"), lab(lo, "Flag low")],
        lines: [{ a: base, b: top, role: "level", label: "Pole" }, flat(top, "Flag top", "upper"), flat(lo, "Flag bottom", "lower")] };
    }
    case "bear_flag": {
      const bot = loIn(b, m1 - 21, n), base = hiIn(b, m3, bot.i), hi = hiIn(b, bot.i + 1, n);
      return { from: base.i, points: [lab(base, "Pole start"), lab(bot, "Pole bottom"), lab(hi, "Flag high")],
        lines: [{ a: base, b: bot, role: "level", label: "Pole" }, flat(hi, "Flag top", "upper"), flat(bot, "Flag bottom", "lower")] };
    }
  }
  return null;
}

/** The match with the detector's marks from the loaded bars, or unchanged if it already has marks (AI or
 * bar-based rows) or the detector finds nothing. */
export function confirmOnChart(hit: PatternHit, bars: { t: number[]; o?: number[]; h: number[]; l: number[]; c: number[]; v?: number[] }): Confirmed {
  if (hit.bars || hit.pattern === "image" || bars.c.length < 80) return hit;
  const d = detect(seed(bars), hit.pattern);
  if (!d) {
    // The detector only tracks patterns still in play; fall back to drawing the screener's outline.
    const o = outline(bars, hit.pattern);
    if (!o) return { ...hit, chart: { ok: false, score: 0 } };
    const n = bars.c.length - 1;
    return { ...hit, from: day(bars.t[o.from]), to: day(bars.t[n]), bars: n - o.from + 1,
      points: o.points.filter((p, j, a) => a.findIndex((q) => q.i === p.i && q.label === p.label) === j).map((p) => ({ k: p.i - o.from, date: day(bars.t[p.i]), price: round(p.price), label: p.label })),
      lines: o.lines.filter((l) => l.b.i > l.a.i).map((l) => ({ from: { date: day(bars.t[l.a.i]), price: round(l.a.price) }, to: { date: day(bars.t[l.b.i]), price: round(l.b.price) }, role: l.role, label: l.label, extend: false })),
      summary: `Drawn: the 1/3/6-month highs and lows the screener read, on the days they happened. The pattern detector didn't find the ${hit.label} on the daily chart.`,
      chart: { ok: false, score: 0, outline: true } };
  }
  const ok = d.score >= MIN;
  return { ...hit, from: day(bars.t[d.from]), to: day(bars.t[d.to]), bars: d.to - d.from + 1, stage: d.stage,
    points: d.points.map((p) => ({ k: p.i - d.from, date: day(p.t), price: p.price, label: p.label })),
    lines: d.lines.map((l) => ({ from: { date: day(l.t1), price: l.p1 }, to: { date: day(l.t2), price: l.p2 }, role: l.role, label: l.label, extend: false })),
    breakout: d.trigger ?? hit.breakout, invalidation: d.stop ?? hit.invalidation,
    checks: [...(hit.checks ?? []), ...d.checks.map((c) => `Chart: ${c}`)], chart: { ok, score: d.score } };
}

export const loadChecks = (): Check[] => { try { const v = JSON.parse(localStorage.getItem(STORE) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };

/** Remember one chart check (the latest per match). */
export function recordCheck(hit: Confirmed) {
  if (!hit.chart) return;
  const rest = loadChecks().filter((c) => !(c.id === hit.id && c.pattern === hit.pattern));
  const next = [{ id: hit.id, pattern: hit.pattern, symbol: hit.symbol, ok: hit.chart.ok, score: hit.chart.score, at: new Date().toISOString() }, ...rest].slice(0, MAX);
  try { localStorage.setItem(STORE, JSON.stringify(next)); } catch { /* blocked storage */ }
  window.dispatchEvent(new Event(EVENT));
}

export const CHECK_EVENT = EVENT;
