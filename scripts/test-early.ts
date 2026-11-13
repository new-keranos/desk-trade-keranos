// Checks for lib/scan/early.ts on made-up daily bars and screener rows. No network.
// Run: npm run test:early
import { earlySetup, earlyBullish, freshness, withLive, type Bars } from "../lib/scan/early.ts";

let fail = 0;
const check = (ok: boolean, name: string, detail = "") => { if (!ok) fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${detail}`); };

/** Bars from a list of closes; highs/lows 0.5% around the close. */
function bars(closes: number[]): Bars {
  const t = closes.map((_, k) => 1_700_000_000 + k * 86400);
  return { t, o: closes.map((c, k) => (k ? closes[k - 1] : c)), h: closes.map((c) => c * 1.005), l: closes.map((c) => c * 0.995), c: closes };
}
const line = (from: number, to: number, steps: number) => Array.from({ length: steps }, (_, k) => from + ((to - from) * (k + 1)) / steps);

// Steady rise, then a sharp fall to a first low (RSI deep), a bounce, then a slow drift down.
const base = [...line(100, 120, 40), ...line(120, 90, 10), ...line(90, 99, 8)];
// Slow drift to just under the first low: RSI stays much higher than at the first (sharp) low.
const forming = bars([...base, ...line(99, 89.5, 12)]);
const f = earlyBullish(forming);
check(f?.state === "forming", "slow new low under a sharp earlier low is 'forming'", JSON.stringify(f && { s: f.state, ref: f.ref, low: f.low }));
check(!!f && f.low!.price < f.ref.price && f.low!.rsi > f.ref.rsi + 3, "forming: lower price, RSI 3+ higher");

// Drifting down but still ~3% above the first low: 'near', with the level at the first low.
const nearBars = bars([...base, ...line(99, 92.5, 10)]);
const nr = earlyBullish(nearBars);
check(nr?.state === "near", "drifting toward the earlier low is 'near'", JSON.stringify(nr && { s: nr.state, level: nr.level, rl: nr.rsiAtLevel, ref: nr.ref.rsi }));
check(!!nr && Math.abs(nr.level! - 90 * 0.995) < 0.01 && nr.rsiAtLevel! > nr.ref.rsi + 3, "near: level is the earlier low, RSI there still higher");

// A crash through the earlier low: RSI falls below the first low's, so no divergence.
const crash = bars([...base, ...line(99, 75, 4)]);
const c = earlyBullish(crash);
check(!c || c.state !== "forming", "a crash to a new low with lower RSI is not 'forming'", JSON.stringify(c?.state));

// A steady uptrend: nothing.
check(earlyBullish(bars(line(50, 120, 120))) === null, "uptrend has no signal");

// Live quote: same session updates the last bar, a new open adds one.
const b = bars([10, 11, 12]);
const same = withLive(b, { open: b.o[2], high: 13, low: 11.5, close: 12.8 });
check(same.c.length === 3 && same.c[2] === 12.8 && same.h[2] === 13, "live quote with the same open updates today's bar");
const next = withLive(b, { open: 12.4, high: 12.6, low: 12.1, close: 12.5 });
check(next.c.length === 4 && next.c[3] === 12.5, "live quote with a new open adds a bar");

// Screener rows (shaped like the live SET rows seen 2026-11-13).
const ptt = { symbol: "SET:PTT", name: "PTT", close: 38, open: 38.25, low: 37.75, RSI: 34.2, "RSI[1]": 30.8, "Low.1M": 37.75, "Low.3M": 37.75,
  relative_volume_10d_calc: 1.8, average_volume_30d_calc: 87e6, update_mode: "streaming" };
const d = earlySetup(ptt);
check(d?.stage === "forming" && Math.round(d.value! / 1e9) === 3, "new 3-month low with RSI 34 is a forming setup, value ≈ 3.3B", JSON.stringify(d && { s: d.stage, sc: d.score, v: d.value }));
check(earlySetup({ ...ptt, RSI: 24 }) === null, "RSI 24 at the new low (no divergence) is left out");
const near = earlySetup({ ...ptt, low: 38.6, close: 38.8, open: 39.2, RSI: 41, "RSI[1]": 43, "Perf.W": -3.5 });
check(near?.stage === "near", "3% above the low, down this week, RSI 41 is 'near' (before the new low)", JSON.stringify(near?.checks));
check(earlySetup({ ...ptt, low: 38.6, close: 38.8, open: 38.5, RSI: 41, "Perf.W": 2 }) === null, "already bouncing this week is left out (too late)");
check(earlySetup({ ...ptt, low: 45, close: 46, open: 45 }) === null, "far above the low is left out");

check(freshness("streaming")?.realtime === true && freshness("delayed_streaming_900")?.delayMin === 15, "update_mode reads as realtime / 15 min delay");

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
