import "server-only";
import { hasRedis, redis } from "../tradingview";
import type { Bars } from "./judge";

// Daily bars change at most once a day, so a scan reuses the ones it fetched in the last few hours instead of
// asking TradingView again. Kept in Upstash Redis when it is set up (shared by every server instance), and in
// this instance's memory either way.

const TTL_S = 4 * 3600;
const mem = new Map<string, { at: number; value: unknown }>();
const key = (symbol: string, count: number) => `keranos:ohlcv:${count}:${symbol}`;

export async function cachedBars(symbol: string, count: number): Promise<Bars | null> {
  const k = key(symbol, count), m = mem.get(k);
  if (m && Date.now() - m.at < TTL_S * 1000) return m.value as Bars;
  if (!hasRedis()) return null;
  try {
    const v = (await redis(["GET", k])) as string | null;
    if (!v) return null;
    const bars = JSON.parse(v) as Bars;
    mem.set(k, { at: Date.now(), value: bars });
    return bars;
  } catch { return null; }
}

export async function storeBars(symbol: string, count: number, bars: Bars): Promise<void> {
  const k = key(symbol, count);
  mem.set(k, { at: Date.now(), value: bars });
  if (mem.size > 2000) mem.delete(mem.keys().next().value!);
  if (hasRedis()) await redis(["SET", k, JSON.stringify(bars), "EX", String(TTL_S)]).catch(() => {});
}

/** Any small JSON result (e.g. a market's member list), cached the same way. */
export async function cachedJson<T>(name: string, load: () => Promise<T>): Promise<T> {
  const k = `keranos:json:${name}`, m = mem.get(k);
  if (m && Date.now() - m.at < TTL_S * 1000) return m.value as T;
  if (hasRedis()) {
    try { const v = (await redis(["GET", k])) as string | null; if (v) { const value = JSON.parse(v) as T; mem.set(k, { at: Date.now(), value }); return value; } } catch { /* fetch it */ }
  }
  const value = await load();
  mem.set(k, { at: Date.now(), value });
  if (hasRedis()) await redis(["SET", k, JSON.stringify(value), "EX", String(TTL_S)]).catch(() => {});
  return value;
}
