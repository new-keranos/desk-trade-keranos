// Synthetic checks for lib/scan/rules.ts (the scanner's indicator-only mode). No network.
// Run: node --experimental-strip-types scripts/test-rules.ts
import { analyze, backtest, confirms, HORIZON } from "../lib/scan/rules.ts";

function series(anchors: [number, number][], noise = 0.004) {
  const t: number[] = [], o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [], v: number[] = [];
  let seedR = 7;
  const rnd = () => ((seedR = (seedR * 16807) % 2147483647) / 2147483647 - 0.5);
  let prev = anchors[0][1];
  for (let k = 0; k < anchors.length - 1; k++) {
    const [i0, p0] = anchors[k], [i1, p1] = anchors[k + 1];
    for (let i = i0; i < i1; i++) {
      const base = p0 + ((p1 - p0) * (i - i0)) / (i1 - i0), close = base * (1 + rnd() * noise);
      t.push(1_700_000_000 + i * 86400); o.push(prev); c.push(close);
      h.push(Math.max(prev, close) * (1 + Math.abs(rnd()) * noise)); l.push(Math.min(prev, close) * (1 - Math.abs(rnd()) * noise)); v.push(1e6 * (1 + (i % 7) / 10));
      prev = close;
    }
  }
  return { t, o, h, l, c, v };
}

let fail = 0;
const check = (ok: boolean, name: string, detail = "") => { if (!ok) fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(56)} ${detail}`); };

// 1. A double bottom at the latest bar is found, with indicator checks attached.
const db = series([[0, 80], [40, 120], [80, 90], [110, 105], [140, 90.5], [165, 101]]);
const hit = analyze(db, "double_bottom", "bullish");
check(!!hit && hit.final >= 0 && hit.final <= 100 && hit.confirms.length >= 3, "double bottom found, scored, with indicator checks",
  hit ? `final ${hit.final} (pattern ${hit.score}); ${hit.confirms.map((c) => `${c.ok ? "+" : "-"}${c.name}`).join(" ")}` : "none");

// 2. Flat noise: nothing.
check(!analyze(series([[0, 100], [170, 101]]), "double_bottom", "bullish"), "flat noise gives no match");

// 3. Backtest: a double bottom that breaks out and runs to its target counts as a win.
const run = series([[0, 80], [40, 120], [80, 90], [110, 105], [140, 90.5], [175, 110], [200, 125], [230, 126]]);
const bt = backtest(run, "double_bottom", "bullish");
check(bt.signals >= 1 && bt.wins >= 1, "double bottom that played out is a win", JSON.stringify({ ...bt, trades: bt.trades }));

// 4. Backtest: the same base that breaks down instead is a loss.
const down = series([[0, 80], [40, 120], [80, 90], [110, 105], [140, 90.5], [160, 100], [185, 75], [230, 74]]);
const bd = backtest(down, "double_bottom", "bullish");
check(bd.losses >= 1 && bd.wins === 0, "double bottom that failed is a loss", JSON.stringify({ ...bd, trades: bd.trades }));

// 5. No look-ahead: changing bars after a signal never changes whether that signal fired or where it entered.
const cut = run.c.length - HORIZON - 1;
const a = backtest(run, "double_bottom", "bullish").trades.filter((x) => x.at < cut).map((x) => `${x.at}:${x.entry}`);
const alt = { ...run, c: run.c.map((x, k) => (k > cut ? x * 0.5 : x)), h: run.h.map((x, k) => (k > cut ? x * 0.5 : x)), l: run.l.map((x, k) => (k > cut ? x * 0.5 : x)) };
const b = backtest(alt, "double_bottom", "bullish").trades.filter((x) => x.at < cut - HORIZON).map((x) => `${x.at}:${x.entry}`);
check(a.filter((x) => Number(x.split(":")[0]) < cut - HORIZON).join() === b.join(), "signals don't depend on later bars");

// 6. Confirmations follow the pattern's direction.
const upTrend = series([[0, 50], [260, 110]]);
const bull = confirms(upTrend, "bullish"), bear = confirms(upTrend, "bearish");
check(bull.find((c) => c.name === "SMA50")!.ok && !bear.find((c) => c.name === "SMA50")!.ok, "SMA checks flip with the pattern's direction");

console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
