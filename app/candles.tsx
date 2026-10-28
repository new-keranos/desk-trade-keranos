"use client";

import { useEffect, useRef, useState } from "react";
import { createChart, CrosshairMode, LineStyle, type IChartApi, type Logical, type LogicalRange, type UTCTimestamp } from "lightweight-charts";

// Candlestick chart drawn in the page with TradingView's open-source Lightweight Charts library,
// from the OHLCV bars the signed-in TradingView connection returns. It works for every market,
// including SET, which TradingView's free embedded widget doesn't show.
// SMA 50/200 sit on the price, RSI 14 in its own panel, and a scanner match is drawn on top:
// the AI's turning points with their prices, its pattern lines, and the channel between them.

export type Ohlcv = { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v?: number[] };
type At = { date: string; price: number };
export type Overlay = { from: string; to: string; shape: number[]; label: string;
  points?: (At & { label?: string })[]; lines?: { from: At; to: At; role: "upper" | "lower" | "level"; label: string; extend: boolean }[] };

const isoDay = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
/** Hex colour plus alpha, for the volume bars. */
const alpha = (hex: string, a: number) => {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
const ANN = "#f6ad55", REF = "#7fd8d0", SMA50 = "#8ab4f8", SMA200 = "#c58af9", RSI = "#c58af9";
const PRICE_W = 64;
const fmt = (v: number) => (v >= 1000 ? v.toFixed(0) : v >= 100 ? v.toFixed(1) : v.toFixed(2));

function sma(c: number[], n: number) {
  const out: (number | null)[] = [];
  let s = 0;
  for (let k = 0; k < c.length; k++) { s += c[k]; if (k >= n) s -= c[k - n]; out.push(k >= n - 1 ? s / n : null); }
  return out;
}
/** Wilder's RSI. */
function rsi(c: number[], n = 14) {
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

const SVG = "http://www.w3.org/2000/svg";
function el(tag: string, attrs: Record<string, string | number>, text?: string) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text != null) e.textContent = text;
  return e;
}

export default function Candles({ bars, visible, overlay }: { bars: Ohlcv; visible: number; overlay?: Overlay | null }) {
  const box = useRef<HTMLDivElement>(null);
  const rsiBox = useRef<HTMLDivElement>(null);
  const ann = useRef<SVGSVGElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [legend, setLegend] = useState<{ s50?: number; s200?: number; rsi?: number }>({});
  const n = bars.t.length;

  useEffect(() => {
    const el0 = box.current, el1 = rsiBox.current, svg = ann.current;
    if (!el0 || !el1 || !svg || !n) return;
    const up = cssVar("--up") || "#6dd58c", down = cssVar("--down") || "#f28b82", line = cssVar("--line") || "#2f3133";
    const base = {
      autoSize: true,
      layout: { background: { color: cssVar("--surface") || "#1e1f20" }, textColor: cssVar("--muted") || "#a8abb0", fontFamily: "Roboto Mono, monospace", fontSize: 11 },
      grid: { vertLines: { color: alpha(line, 0.6) }, horzLines: { color: alpha(line, 0.6) } },
      rightPriceScale: { borderColor: line, minimumWidth: PRICE_W },
      crosshair: { mode: CrosshairMode.Normal },
    };
    const chart = createChart(el0, { ...base, timeScale: { borderColor: line, rightOffset: 4, visible: false } });
    const lower = createChart(el1, { ...base, timeScale: { borderColor: line, rightOffset: 4 }, handleScale: { axisPressedMouseMove: { price: false } } });
    chartRef.current = chart;
    const time = (k: number) => bars.t[k] as UTCTimestamp;
    const series = (v: (number | null)[]) => v.flatMap((x, k) => (x == null ? [] : [{ time: time(k), value: x }]));

    const candles = chart.addCandlestickSeries({ upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down });
    candles.setData(bars.t.map((_, k) => ({ time: time(k), open: bars.o[k], high: bars.h[k], low: bars.l[k], close: bars.c[k] })));
    if (bars.v?.length) {
      const vol = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "", lastValueVisible: false, priceLineVisible: false });
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
      vol.setData(bars.t.map((_, k) => ({ time: time(k), value: bars.v![k], color: alpha(bars.c[k] >= bars.o[k] ? up : down, 0.25) })));
    }
    const s50 = sma(bars.c, 50), s200 = sma(bars.c, 200), r14 = rsi(bars.c);
    const quiet = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    chart.addLineSeries({ ...quiet, color: SMA50, lineWidth: 1 }).setData(series(s50));
    chart.addLineSeries({ ...quiet, color: SMA200, lineWidth: 1, lineStyle: LineStyle.Dashed }).setData(series(s200));
    const rs = lower.addLineSeries({ ...quiet, color: RSI, lineWidth: 1, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
    rs.setData(series(r14));
    for (const p of [70, 30]) rs.createPriceLine({ price: p, color: alpha(cssVar("--muted") || "#a8abb0", 0.5), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "" });
    rs.createPriceLine({ price: 50, color: alpha(line, 1), lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false, title: "" });
    setLegend({ s50: s50[n - 1] ?? undefined, s200: s200[n - 1] ?? undefined, rsi: r14[n - 1] ?? undefined });

    // Map the overlay's dates to bar indexes; a date without a bar takes the next bar.
    const byDay = new Map(bars.t.map((x, k) => [isoDay(x), k]));
    const idx = (d: string) => byDay.get(d) ?? bars.t.findIndex((x) => isoDay(x) >= d);
    let i0 = -1, i1 = -1;
    const pts = (overlay?.points ?? []).map((p) => ({ k: idx(p.date), price: p.price, label: p.label })).filter((p) => p.k >= 0);
    const lines = (overlay?.lines ?? []).map((l) => ({ ...l, k1: idx(l.from.date), k2: idx(l.to.date), p1: l.from.price, p2: l.to.price })).filter((l) => l.k1 >= 0 && l.k2 > l.k1);
    const drawn = !!overlay && (lines.length > 0 || pts.some((p) => p.label));
    if (overlay) {
      i0 = idx(overlay.from);
      i1 = n - 1;
      while (i1 > 0 && isoDay(bars.t[i1]) > overlay.to) i1--;
      if (!(i0 >= 0 && i1 > i0)) i0 = -1;
      else if (!drawn) {
        // Scans saved before the AI read: a dashed line through the turning points, or the template shape.
        const lo = Math.min(...bars.l.slice(i0, i1 + 1)), hi = Math.max(...bars.h.slice(i0, i1 + 1));
        const s = overlay.shape, m = s.length - 1;
        const dash = chart.addLineSeries({ ...quiet, color: cssVar("--accent") || "#8ab4f8", lineWidth: 2, lineStyle: LineStyle.Dashed });
        const uniq = pts.filter((p, j) => j === 0 || p.k > pts[j - 1].k);
        dash.setData(uniq.length >= 2 ? uniq.map((p) => ({ time: time(p.k), value: p.price }))
          : m > 0 ? Array.from({ length: i1 - i0 + 1 }, (_, j) => {
            const x = (j / (i1 - i0)) * m, a = Math.floor(x), f = x - a;
            const y = a + 1 <= m ? s[a] * (1 - f) + s[a + 1] * f : s[m];
            return { time: time(i0 + j), value: lo + y * (hi - lo) };
          }) : []);
        candles.setMarkers([
          { time: time(i0), position: "belowBar", color: cssVar("--accent") || "#8ab4f8", shape: "arrowUp", text: overlay.label },
          { time: time(i1), position: "aboveBar", color: cssVar("--accent") || "#8ab4f8", shape: "arrowDown", text: "end" },
        ]);
      }
    }

    // The reference pattern, stretched over the match's dates and price range, for comparing with the AI's marks.
    const ref: [number, number][] = [];
    if (drawn && i0 >= 0 && overlay!.shape.length > 1) {
      const lo = Math.min(...bars.l.slice(i0, i1 + 1)), hi = Math.max(...bars.h.slice(i0, i1 + 1)), s = overlay!.shape, m = s.length - 1;
      // Whole bars only: the time scale maps fractional indexes wrongly.
      for (let j = 0; j <= m; j++) ref.push([Math.round(i0 + (j / m) * (i1 - i0)), lo + s[j] * (hi - lo)]);
    }

    // The AI's marks, redrawn in an SVG layer whenever the chart moves.
    const lineEnd = (l: (typeof lines)[number]) => (l.extend ? n - 1 + 3 : l.k2);
    const valueAt = (l: (typeof lines)[number], k: number) => l.p1 + ((l.p2 - l.p1) * (k - l.k1)) / (l.k2 - l.k1);
    let frame = 0;
    const draw = () => {
      frame = 0;
      svg.replaceChildren();
      if (!drawn) return;
      const w = el0.clientWidth - chart.priceScale("right").width(), h = el0.clientHeight;
      svg.setAttribute("viewBox", `0 0 ${el0.clientWidth} ${h}`);
      const clip = el("clipPath", { id: "ann-clip" });
      clip.append(el("rect", { x: 0, y: 0, width: Math.max(0, w), height: h }));
      const g = el("g", { "clip-path": "url(#ann-clip)" });
      svg.append(clip, g);
      const X = (k: number) => chart.timeScale().logicalToCoordinate(k as Logical);
      const Y = (p: number) => candles.priceToCoordinate(p);
      const xy = (k: number, p: number) => { const x = X(k), y = Y(p); return x == null || y == null ? null : [x, y] as const; };

      const refXY = ref.map(([k, p]) => xy(k, p));
      if (refXY.length && refXY.every(Boolean)) {
        g.append(el("polyline", { points: refXY.map((p) => p!.join(",")).join(" "), fill: "none", stroke: REF, "stroke-width": 1.4, "stroke-dasharray": "3 4", "stroke-opacity": 0.75 }));
        const e = refXY[0]!;
        g.append(el("text", { x: e[0] + 4, y: e[1] - 6, fill: REF, "font-size": 11, class: "ann-t" }, "Ref pattern"));
      }
      const upper = lines.find((l) => l.role === "upper"), lowerL = lines.find((l) => l.role === "lower");
      if (upper && lowerL) {
        const s = Math.min(upper.k1, lowerL.k1), e = Math.max(lineEnd(upper), lineEnd(lowerL));
        const c = [xy(s, valueAt(upper, s)), xy(e, valueAt(upper, e)), xy(e, valueAt(lowerL, e)), xy(s, valueAt(lowerL, s))];
        if (c.every(Boolean)) g.append(el("polygon", { points: c.map((p) => p!.join(",")).join(" "), fill: ANN, "fill-opacity": 0.08 }));
      }
      for (const l of lines) {
        const e = lineEnd(l), a = xy(l.k1, l.p1), b = xy(e, valueAt(l, e));
        if (!a || !b) continue;
        g.append(el("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: ANN, "stroke-width": 1.6, "stroke-dasharray": l.role === "level" ? "6 4" : "" }));
        const last = valueAt(l, Math.min(e, n - 1)), lx = Math.min(b[0], w - 4), ly = Y(last);
        if (ly != null) g.append(el("text", { x: lx, y: ly - 6, fill: ANN, "font-size": 12, "font-weight": 600, "text-anchor": "end", class: "ann-t" }, `${l.label} ${fmt(last)}`));
      }
      for (const p of pts) {
        const q = xy(p.k, p.price);
        if (!q) continue;
        const high = Math.abs(bars.h[p.k] - p.price) <= Math.abs(bars.l[p.k] - p.price);
        g.append(el("circle", { cx: q[0], cy: q[1], r: 4.5, fill: "none", stroke: ANN, "stroke-width": 1.6 }));
        if (p.label) g.append(el("text", { x: q[0] + 7, y: q[1] + (high ? -8 : 18), fill: ANN, "font-size": 12, "font-weight": 600, class: "ann-t" }, `${p.label} ${fmt(p.price)}`));
      }
    };
    const redraw = () => { if (!frame) frame = requestAnimationFrame(draw); };

    // Keep the two panels on the same bars.
    let syncing = false;
    const follow = (to: IChartApi) => (r: LogicalRange | null) => {
      if (!r || syncing) return;
      syncing = true; to.timeScale().setVisibleLogicalRange(r); syncing = false;
      redraw();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(follow(lower));
    lower.timeScale().subscribeVisibleLogicalRangeChange(follow(chart));
    chart.timeScale().subscribeSizeChange(redraw);
    const ro = new ResizeObserver(redraw);
    ro.observe(el0);

    const lastK = drawn ? Math.max(...pts.map((p) => p.k), ...lines.map((l) => l.k2), i1) : i1;
    const firstK = drawn ? Math.min(...pts.map((p) => p.k), ...lines.map((l) => l.k1), i0 >= 0 ? i0 : n) : i0;
    const first = firstK >= 0 && overlay ? Math.max(0, firstK - 25) : Math.max(0, n - visible);
    chart.timeScale().setVisibleLogicalRange({ from: first, to: Math.max(n + 3, lastK + 3) });
    redraw();
    return () => { cancelAnimationFrame(frame); ro.disconnect(); chart.remove(); lower.remove(); chartRef.current = null; svg.replaceChildren(); };
  }, [bars, n, overlay, visible]);

  return (
    <div className="candles" role="img" aria-label={`Daily candlestick chart, ${n} bars, with SMA 50, SMA 200 and RSI 14${overlay ? `, ${overlay.label} marked` : ""}`}>
      <div className="candles-main">
        <div ref={box} className="candles-pane" />
        <svg ref={ann} className="candles-ann" aria-hidden="true" />
        <div className="candles-legend">
          <span style={{ color: SMA50 }}>SMA 50 {legend.s50 != null ? fmt(legend.s50) : "—"}</span>
          <span style={{ color: SMA200 }}>SMA 200 {legend.s200 != null ? fmt(legend.s200) : "—"}</span>
          {!!overlay?.shape?.length && !!(overlay.lines?.length || overlay.points?.length) && <span style={{ color: REF }}>┄ Ref pattern</span>}
        </div>
      </div>
      <div className="candles-rsi">
        <div ref={rsiBox} className="candles-pane" />
        <div className="candles-legend"><span style={{ color: RSI }}>RSI 14 {legend.rsi != null ? legend.rsi.toFixed(1) : "—"}</span></div>
      </div>
    </div>
  );
}
