import "server-only";
import { hasRedis, redis } from "../tradingview";
import type { Bars } from "./judge";
import { step, seed, type TrackState } from "./pivots";

// Per-stock pivot state for the pattern detector (lib/scan/pivots.ts), about 3.5 KB a stock. Kept in Upstash
// Redis without expiry when it is set up (shared by every server instance), and in this instance's memory
// either way. A stock is seeded once from get_ohlcv; after that each day's completed bar comes from the
// screener call that lists the market, so a tracked stock costs no chart call until it looks like a match.

/** The last two completed daily bars from the screener: open/high/low/close/volume[1] and close[2]. */
export type PrevBar = { o: number; h: number; l: number; c: number; v: number; c2?: number };
export const PREV_COLS = ["open[1]", "high[1]", "low[1]", "close[1]", "volume[1]", "close[2]"] as const;

export function prevOf(row: Record<string, unknown>): PrevBar | undefined {
  const n = (k: string) => (typeof row[k] === "number" ? (row[k] as number) : undefined);
  const o = n("open[1]"), h = n("high[1]"), l = n("low[1]"), c = n("close[1]");
  if (o == null || h == null || l == null || c == null) return undefined;
  return { o, h, l, c, v: n("volume[1]") ?? 0, c2: n("close[2]") };
}

/** New stocks seeded (one get_ohlcv call each) per day at most, across all scans. */
export const SEEDS_PER_DAY = Number(process.env.TRACK_SEEDS_PER_DAY) || 100;

const VERSION = 1;
const key = (symbol: string) => `keranos:track:v${VERSION}:${symbol}`;
const mem = new Map<string, TrackState>();
const today = () => new Date().toISOString().slice(0, 10);

export async function loadStates(symbols: string[]): Promise<Map<string, TrackState>> {
  const out = new Map<string, TrackState>(), missing: string[] = [];
  for (const s of symbols) { const m = mem.get(s); if (m) out.set(s, m); else missing.push(s); }
  if (!hasRedis() || !missing.length) return out;
  for (let k = 0; k < missing.length; k += 100) {
    const part = missing.slice(k, k + 100);
    try {
      const vals = (await redis(["MGET", ...part.map(key)])) as (string | null)[];
      vals.forEach((v, j) => {
        if (!v) return;
        try { const st = JSON.parse(v) as TrackState; if (st.v === 1) { out.set(part[j], st); mem.set(part[j], st); } } catch { /* reseed */ }
      });
    } catch { /* Redis unreachable: those stocks look unseeded */ }
  }
  return out;
}

export async function saveStates(states: Map<string, TrackState>): Promise<void> {
  for (const [s, st] of states) mem.set(s, st);
  if (!hasRedis() || !states.size) return;
  const all = [...states];
  for (let k = 0; k < all.length; k += 50) {
    const args = all.slice(k, k + 50).flatMap(([s, st]) => [key(s), JSON.stringify(st)]);
    await redis(["MSET", ...args]).catch(() => {});
  }
}

export async function forget(symbols: string[]): Promise<void> {
  for (const s of symbols) mem.delete(s);
  if (hasRedis() && symbols.length) await redis(["DEL", ...symbols.map(key)]).catch(() => {});
}

/** Same price from two TradingView calls (they agree to rounding; ordinary days move more than this). */
const near = (a: number, b: number) => Math.abs(a - b) <= 0.0005 * Math.abs(b);
const sameBar = (x: { o: number; h: number; l: number; c: number }, p: PrevBar) => near(x.o, p.o) && near(x.h, p.h) && near(x.l, p.l) && near(x.c, p.c);
/** The next weekday after t (seconds). Exchange holidays aren't known here; only the order of bars matters. */
const nextDay = (t: number) => { let d = t + 86400; while ([0, 6].includes(new Date(d * 1000).getUTCDay())) d += 86400; return d; };

/** Bring a state up to the screener's last completed bar. "stale": the bars don't join up (a missed day,
 * a split, a data fix), so the stock must be seeded again. */
export function advance(s: TrackState, p: PrevBar): "same" | "added" | "stale" {
  const last = s.win.at(-1);
  if (!last) return "stale";
  if (sameBar(last, p)) return "same";
  if (p.c2 != null && near(last.c, p.c2)) { step(s, { t: nextDay(last.t), o: p.o, h: p.h, l: p.l, c: p.c, v: p.v }); return "added"; }
  return "stale";
}

/** A state from get_ohlcv bars, leaving out today's bar if it is still forming (bars after the screener's
 * last completed bar). */
export function seedFromBars(b: Bars, p?: PrevBar): TrackState | null {
  const n = b.c.length;
  if (n < 80) return null;
  let upTo = n - 1;
  if (p) for (const k of [n - 1, n - 2]) if (sameBar({ o: b.o?.[k] ?? b.c[k], h: b.h[k], l: b.l[k], c: b.c[k] }, p)) { upTo = k + 1; break; }
  return seed(b, upTo);
}

const seedMem = new Map<string, number>();
/** Stocks seeded so far today; add to count new ones. */
export async function seedsToday(add = 0): Promise<number> {
  const k = `keranos:track:seeds:${today()}`;
  if (hasRedis()) {
    try {
      const v = add ? await redis(["INCRBY", k, String(add)]) : await redis(["GET", k]);
      if (add) await redis(["EXPIRE", k, String(2 * 86400)]);
      return Number(v) || 0;
    } catch { /* fall back to memory */ }
  }
  const v = (seedMem.get(k) ?? 0) + add;
  seedMem.set(k, v);
  return v;
}
