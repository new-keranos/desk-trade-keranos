// Formatting helpers shared by the dashboard components.

const CRYPTO_EX = ["BINANCE", "COINBASE", "BYBIT", "OKX", "KRAKEN", "BITSTAMP", "CRYPTOCAP", "CRYPTO", "BITGET", "KUCOIN"];
export type Market = "US" | "SET" | "CRYPTO";
export function market(sym: string): Market {
  const ex = sym.split(":")[0].toUpperCase();
  if (ex === "SET" || ex === "MAI" || ex === "TFEX") return "SET";
  if (CRYPTO_EX.includes(ex)) return "CRYPTO";
  return "US";
}
export const ccy = (s: string) => ({ SET: "THB", CRYPTO: "USDT", US: "USD" })[market(s)];
export function fmtPx(v?: number | null) {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v);
  const d = a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
export const fmtPct = (v?: number | null) => (v == null || !isFinite(v) ? "—" : (v > 0 ? "+" : "") + v.toFixed(2) + "%");
export function fmtBig(v?: number | null) {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}
export const cls = (v?: number | null) => (v == null ? "muted" : v > 0 ? "up" : v < 0 ? "down" : "muted");
