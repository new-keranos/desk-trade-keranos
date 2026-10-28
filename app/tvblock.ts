// When TradingView pauses the account, this browser stops calling it until the pause ends:
// more calls during a suspension risk a longer one.
const KEY = "keranos.tvblock.v1";

export function tvBlocked(): number {
  try { const until = Number(localStorage.getItem(KEY) ?? 0); return until > Date.now() ? until : 0; } catch { return 0; }
}
export function blockTv(until: number) {
  try { localStorage.setItem(KEY, String(until)); } catch { /* blocked storage: the server still refuses */ }
}
export const blockedText = (until: number) =>
  `TradingView paused this account's MCP access until ${new Date(until).toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}. The app won't call TradingView before then.`;
