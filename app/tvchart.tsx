"use client";

// TradingView's free chart widget: an interactive candle chart in an iframe served by TradingView.
// It shows TradingView's public data, so it doesn't use the signed-in MCP connection.
// We render the iframe ourselves (instead of TradingView's loader script) so its size is ours to set:
// the loader script kept collapsing the chart to a short strip.

export type TvRange = "1M" | "3M" | "6M" | "12M" | "60M";

/** Smallest widget range that shows everything since `from` (YYYY-MM-DD), with some margin.
 *  The widget picks the bar size from the range, and only 12M and longer give daily bars. */
export function rangeSince(from: string): TvRange {
  const months = (Date.now() - Date.parse(from + "T00:00:00Z")) / (30.4 * 86400e3) * 1.25;
  return months <= 12 ? "12M" : "60M";
}

export default function TvChart({ symbol, range }: { symbol: string; range?: TvRange }) {
  const dark = typeof document === "undefined" || document.documentElement.dataset.theme !== "light";
  const q = new URLSearchParams({
    symbol, interval: "D", ...(range && { range }), theme: dark ? "dark" : "light", style: "1", timezone: "Asia/Bangkok", locale: "en",
    hidesidetoolbar: "0", symboledit: "0", saveimage: "1", withdateranges: "1", toolbarbg: dark ? "1e1f20" : "f1f3f6",
  });
  return (
    <div className="tv-chart">
      <iframe key={symbol + (range ?? "")} title={`TradingView chart for ${symbol}`} src={`https://s.tradingview.com/widgetembed/?${q}`}
        allow="clipboard-write; fullscreen" allowFullScreen />
    </div>
  );
}

/** The full TradingView chart page for a symbol. */
export const tvChartUrl = (symbol: string) => `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`;
