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

/** Show the bar that asks to log in to TradingView again (a fresh login, not another refresh). */
export const askRelogin = (message?: string) =>
  window.dispatchEvent(new CustomEvent("nova:tv-connect", { detail: { text: message || "TradingView login didn't refresh. Log in to TradingView again.", fresh: true } }));

/** POST to a streaming route; when the TradingView login is mid-refresh, wait a moment and try once more. */
export async function postWithRelogin(url: string, init: RequestInit): Promise<Response> {
  let res = await fetch(url, init);
  if (res.status === 503) {
    // Usually a parallel request just refreshed the login and its new cookie has landed by now.
    await new Promise((ok) => setTimeout(ok, 1500));
    res = await fetch(url, init);
    if (res.status === 503) {
      const j = await res.clone().json().catch(() => ({}));
      if (j.relogin) askRelogin(j.error);
    }
  }
  return res;
}
