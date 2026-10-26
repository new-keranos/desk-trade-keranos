"use client";

import { useEffect, useRef } from "react";

// TradingView's free Advanced Chart widget: an interactive candle chart in an iframe served by TradingView.
// It shows TradingView's public data, so it doesn't use the signed-in MCP connection.
const SRC = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

export type TvRange = "1M" | "3M" | "6M" | "12M" | "60M";

/** Smallest widget range that shows everything since `from` (YYYY-MM-DD), with some margin. */
export function rangeSince(from: string): TvRange {
  const months = (Date.now() - Date.parse(from + "T00:00:00Z")) / (30.4 * 86400e3) * 1.25;
  return months <= 1 ? "1M" : months <= 3 ? "3M" : months <= 6 ? "6M" : months <= 12 ? "12M" : "60M";
}

export default function TvChart({ symbol, range = "6M", height = 440 }: { symbol: string; range?: TvRange; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light";
    el.innerHTML = '<div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>';
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.type = "text/javascript";
    s.innerHTML = JSON.stringify({
      symbol, interval: "D", range, timezone: "Asia/Bangkok", theme: dark ? "dark" : "light", style: "1", locale: "en",
      autosize: true, allow_symbol_change: false, hide_side_toolbar: false, withdateranges: true, details: false,
      support_host: "https://www.tradingview.com",
    });
    el.appendChild(s);
    return () => { el.innerHTML = ""; };
  }, [symbol, range]);
  return <div ref={box} className="tradingview-widget-container tv-chart" style={{ height }} />;
}
