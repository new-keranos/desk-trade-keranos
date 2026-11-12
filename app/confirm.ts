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

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

export type Confirmed = PatternHit & { chart?: { ok: boolean; score: number } };

/** The match with the detector's marks from the loaded bars, or unchanged if it already has marks (AI or
 * bar-based rows) or the detector finds nothing. */
export function confirmOnChart(hit: PatternHit, bars: { t: number[]; o?: number[]; h: number[]; l: number[]; c: number[]; v?: number[] }): Confirmed {
  if (hit.bars || hit.pattern === "image" || bars.c.length < 80) return hit;
  const d = detect(seed(bars), hit.pattern);
  if (!d) return { ...hit, chart: { ok: false, score: 0 } };
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
