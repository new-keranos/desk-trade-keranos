"use client";

import { useEffect, useRef } from "react";

// TradingView's free Advanced Chart widget: an interactive candle chart in an iframe served by TradingView.
// It shows TradingView's public data, so it doesn't use the signed-in MCP connection.
const SRC = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

export type TvRange = "1M" | "3M" | "6M" | "12M" | "60M";

/** Smallest widget range that shows everything since `from` (YYYY-MM-DD), with some margin.
 *  The widget picks the bar size from the range, and only 12M and longer give daily bars. */
export function rangeSince(from: string): TvRange {
  const months = (Date.now() - Date.parse(from + "T00:00:00Z")) / (30.4 * 86400e3) * 1.25;
  return months <= 12 ? "12M" : "60M";
}

export default function TvChart({ symbol, range, height = 460 }: { symbol: string; range?: TvRange; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const dark = document.documentElement.dataset.theme !== "light";
    el.innerHTML = `<div class="tradingview-widget-container__widget" style="height:${height}px;width:100%"></div>`;
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.type = "text/javascript";
    s.innerHTML = JSON.stringify({
      symbol, interval: "D", ...(range && { range }), timezone: "Asia/Bangkok", theme: dark ? "dark" : "light", style: "1", locale: "en",
      // Fixed height: with autosize the widget can collapse to a thin strip.
      autosize: false, width: "100%", height, allow_symbol_change: false, hide_side_toolbar: false, withdateranges: true, details: false,
      ...(dark && { backgroundColor: "rgba(30, 31, 32, 1)", gridColor: "rgba(255, 255, 255, 0.05)" }),
      support_host: "https://www.tradingview.com",
    });
    el.appendChild(s);
    return () => { el.innerHTML = ""; };
  }, [symbol, range, height]);
  return <div ref={box} className="tradingview-widget-container tv-chart" style={{ height }} />;
}
