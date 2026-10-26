"use client";

import { useEffect, useRef } from "react";
import { createChart, CrosshairMode, LineStyle, type IChartApi, type UTCTimestamp } from "lightweight-charts";

// Candlestick chart drawn in the page with TradingView's open-source Lightweight Charts library,
// from the OHLCV bars the signed-in TradingView connection returns. It works for every market,
// including SET, which TradingView's free embedded widget doesn't show.

export type Ohlcv = { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v?: number[] };
export type Overlay = { from: string; to: string; shape: number[]; label: string };

const isoDay = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
/** Hex colour plus alpha, for the volume bars. */
const alpha = (hex: string, a: number) => {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

export default function Candles({ bars, visible, overlay }: { bars: Ohlcv; visible: number; overlay?: Overlay | null }) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const n = bars.t.length;

  useEffect(() => {
    const el = box.current;
    if (!el || !n) return;
    const up = cssVar("--up") || "#6dd58c", down = cssVar("--down") || "#f28b82";
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: cssVar("--surface") || "#1e1f20" }, textColor: cssVar("--muted") || "#a8abb0", fontFamily: "Roboto Mono, monospace", fontSize: 11 },
      grid: { vertLines: { color: alpha(cssVar("--line") || "#2f3133", 0.6) }, horzLines: { color: alpha(cssVar("--line") || "#2f3133", 0.6) } },
      rightPriceScale: { borderColor: cssVar("--line") || "#2f3133" },
      timeScale: { borderColor: cssVar("--line") || "#2f3133", rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    chartRef.current = chart;
    const time = (k: number) => bars.t[k] as UTCTimestamp;

    const candles = chart.addCandlestickSeries({ upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down });
    candles.setData(bars.t.map((_, k) => ({ time: time(k), open: bars.o[k], high: bars.h[k], low: bars.l[k], close: bars.c[k] })));
    if (bars.v?.length) {
      const vol = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "", lastValueVisible: false, priceLineVisible: false });
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vol.setData(bars.t.map((_, k) => ({ time: time(k), value: bars.v![k], color: alpha(bars.c[k] >= bars.o[k] ? up : down, 0.35) })));
    }

    // The scanner's pattern: dashed shape across the matched bars, scaled to their high and low, with start and end markers.
    let i0 = -1, i1 = -1;
    if (overlay) {
      i0 = bars.t.findIndex((x) => isoDay(x) >= overlay.from);
      i1 = n - 1;
      while (i1 > 0 && isoDay(bars.t[i1]) > overlay.to) i1--;
      if (i0 >= 0 && i1 > i0) {
        const lo = Math.min(...bars.l.slice(i0, i1 + 1)), hi = Math.max(...bars.h.slice(i0, i1 + 1));
        const s = overlay.shape, m = s.length - 1;
        const line = chart.addLineSeries({ color: cssVar("--accent") || "#8ab4f8", lineWidth: 2, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        line.setData(Array.from({ length: i1 - i0 + 1 }, (_, j) => {
          const x = (j / (i1 - i0)) * m, a = Math.floor(x), f = x - a;
          const y = a + 1 <= m ? s[a] * (1 - f) + s[a + 1] * f : s[m];
          return { time: time(i0 + j), value: lo + y * (hi - lo) };
        }));
        candles.setMarkers([
          { time: time(i0), position: "belowBar", color: cssVar("--accent") || "#8ab4f8", shape: "arrowUp", text: overlay.label },
          { time: time(i1), position: "aboveBar", color: cssVar("--accent") || "#8ab4f8", shape: "arrowDown", text: "end" },
        ]);
      } else i0 = -1;
    }
    const first = i0 >= 0 ? Math.max(0, i0 - 15) : Math.max(0, n - visible);
    chart.timeScale().setVisibleLogicalRange({ from: first, to: n + 3 });
    return () => { chart.remove(); chartRef.current = null; };
  }, [bars, n, overlay, visible]);

  return <div ref={box} className="candles" role="img" aria-label={`Daily candlestick chart, ${n} bars${overlay ? `, ${overlay.label} marked` : ""}`} />;
}
