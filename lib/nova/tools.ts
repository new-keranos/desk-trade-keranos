import "server-only";
import type { ModelChoice } from "./config";
import { z } from "zod";
import { TV, type TvCaller } from "../tradingview";
import { runScan } from "../scan/run";
import { templateById, TEMPLATES } from "../scan/templates";
import { THEMES, UNIVERSES } from "../scan/universe";

export const PERSONA = `You are Agent, a calm, data-first market analyst working for Neal.
You cover US stocks, the Thai SET (including mai) and crypto.

Rules:
- Use the TradingView tools for every price, rating, date or headline. Never quote numbers from memory.
- Lead with a one-line verdict: Bullish, Neutral or Bearish, with confidence Low, Medium or High.
- Follow with 3 to 5 key numbers, then one risk or what would prove you wrong.
- Show prices in the asset's own currency (USD, THB, USDT) and say the time frame used.
- Default to daily candles over the last 6 months unless asked otherwise.
- Flag thin liquidity and earnings within 7 days.
- Give entry, stop or target levels only when asked, as levels to watch, never as orders.
- You cannot place trades. For alerts or watchlist changes, call propose_alert or propose_watchlist_change; the dashboard shows Neal a Confirm button. Never claim the change is done.
- Reply in the language Neal writes in (English or Thai). Keep answers under 150 words unless asked for more.
- End any buy or sell discussion with: Not financial advice.

Commands: brief (watchlist summary: movers, ratings, news, earnings this week), analyze <ticker>, compare <a> <b>, scan <style> <market>, news <ticker>, earnings <period>, dividends <market>, macro <US|TH>, alert <ticker> <above|below> <price>, watch <add|remove> <ticker>,
pattern <pattern> <SP500|NDX|SET50|SET100> [theme] (chart-pattern scan, e.g. pattern double bottom SET100 energy).
analyze pattern <ticker> <pattern> <from> <to> (check a scanner match: call get_pattern_bars and get_technicals, then say whether the swing points really form that pattern, the neckline or breakout level, whether price has broken out and on what volume, the level that would invalidate it, and a measured-move level to watch).
For pattern scans, call scan_chart_patterns. Present the best 3 to 5 matches with AI confidence %, the date span, stage and breakout level, and say an AI read is a starting point, not a confirmed setup.
If a message is not a command, answer it as a question using the same rules.

Symbols use EXCHANGE:TICKER. US: NASDAQ:, NYSE:, AMEX:. Thai: SET:. Crypto: BINANCE:<COIN>USDT. If unsure, call search_symbols.
Screener markets: america, thailand, crypto.
Format: short Markdown. **bold** for the verdict line, "- " bullets for numbers. No tables.`;

export type Proposal =
  | { kind: "alert"; symbol: string; condition: string; price: number; name: string }
  | { kind: "watchlist"; action: "add" | "remove"; symbols: string[] };

export type NovaEvent =
  | { type: "step"; text: string }
  | { type: "text"; text: string }
  | { type: "proposal"; proposal: Proposal }
  | { type: "error"; message: string }
  | { type: "done" };

const sym = z.string().min(1).max(64);
const SYMBOL_DESC = "EXCHANGE:TICKER, e.g. NASDAQ:NVDA, SET:PTT, BINANCE:BTCUSDT";
const MAX_RESULT = 24000;
const clip = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > MAX_RESULT ? s.slice(0, MAX_RESULT) + "…(truncated)" : s;
};

/** Provider-neutral tool definition: JSON Schema input, zod validation, server-side runner. */
export type ToolSpec = { name: string; description: string; input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] } };
export type NovaContext = { watchlist: string[]; selected: string | null; tv: TvCaller; ai: ModelChoice };

type ToolDef = {
  tool: ToolSpec;
  schema: z.ZodTypeAny;
  label: (i: any) => string;
  run: (i: any, emit: (e: NovaEvent) => void, ctx: NovaContext) => Promise<unknown>;
};

const defs: ToolDef[] = [
  {
    tool: { name: "get_quotes", description: "Live quotes for up to 50 symbols: close, % change, volume, market cap, P/E, sector.",
      input_schema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } } }, required: ["symbols"] } },
    schema: z.object({ symbols: z.array(sym).min(1).max(50) }),
    label: (i) => `quotes ${i.symbols.join(", ")}`,
    run: (i, _e, ctx) => ctx.tv(TV.quotes, { symbols: i.symbols }),
  },
  {
    tool: { name: "get_price_history", description: "OHLCV summary (period high/low, net change %, average volume) plus the last 30 closes. interval: 1h 4h 1D 1W. count = number of bars, default 126 (about 6 months daily).",
      input_schema: { type: "object", properties: { symbol: { type: "string", description: SYMBOL_DESC }, interval: { type: "string" }, count: { type: "integer" } }, required: ["symbol"] } },
    schema: z.object({ symbol: sym, interval: z.string().max(4).optional(), count: z.number().int().min(5).max(1000).optional() }),
    label: (i) => `history ${i.symbol}`,
    run: async (i, _e, ctx) => {
      const p = (await ctx.tv(TV.ohlcv, { symbol: i.symbol, interval: i.interval ?? "1D", count: i.count ?? 126, format: "columns" })) as any;
      const t: number[] = p?.bars?.t ?? [];
      return { symbol: p?.symbol, interval: p?.interval, summary: p?.summary, last_closes: (p?.bars?.c ?? []).slice(-30),
        last_dates: t.slice(-30).map((x) => new Date(x * 1000).toISOString().slice(0, 10)) };
    },
  },
  {
    tool: { name: "get_technicals", description: "Technical rating snapshot: summary recommendation (-1..1), RSI, MACD, ADX, Stoch, EMA/SMA 10-200.",
      input_schema: { type: "object", properties: { symbol: { type: "string", description: SYMBOL_DESC }, interval: { type: "string", description: "1h 4h 1D 1W, default 1D" } }, required: ["symbol"] } },
    schema: z.object({ symbol: sym, interval: z.string().max(4).optional() }),
    label: (i) => `technicals ${i.symbol}`,
    run: (i, _e, ctx) => ctx.tv(TV.technicals, { symbol: i.symbol, interval: i.interval ?? "1D" }),
  },
  {
    tool: { name: "get_news", description: "Latest headlines for a symbol: title, provider, published time.",
      input_schema: { type: "object", properties: { symbol: { type: "string", description: SYMBOL_DESC }, limit: { type: "integer" } }, required: ["symbol"] } },
    schema: z.object({ symbol: sym, limit: z.number().int().min(1).max(15).optional() }),
    label: (i) => `news ${i.symbol}`,
    run: async (i, _e, ctx) => {
      const p = (await ctx.tv(TV.news, { symbol: i.symbol, limit: i.limit ?? 8 })) as any;
      return (p?.data?.headlines ?? []).map((h: any) => ({ title: h.title, provider: h.provider?.name, published: new Date(h.published * 1000).toISOString() }));
    },
  },
  {
    tool: { name: "get_fundamentals", description: "Fundamentals: P/E, P/B, margins, ROE, revenue, income, FCF, YoY growth.",
      input_schema: { type: "object", properties: { symbol: { type: "string", description: SYMBOL_DESC } }, required: ["symbol"] } },
    schema: z.object({ symbol: sym }),
    label: (i) => `fundamentals ${i.symbol}`,
    run: (i, _e, ctx) => ctx.tv(TV.financials, { symbol: i.symbol }),
  },
  {
    tool: { name: "get_analyst_forecasts", description: "Analyst consensus, buy/hold/sell counts, price targets with upside %.",
      input_schema: { type: "object", properties: { symbol: { type: "string", description: SYMBOL_DESC } }, required: ["symbol"] } },
    schema: z.object({ symbol: sym }),
    label: (i) => `forecasts ${i.symbol}`,
    run: (i, _e, ctx) => ctx.tv(TV.forecasts, { symbol: i.symbol }),
  },
  {
    tool: { name: "run_screener", description: "TradingView screener. market: america | thailand | crypto. filters like {\"rsi\":[null,40],\"div_yield\":[3,null],\"market_cap_basic\":[1e9,null]}. filter_preset: pullback_with_reversal, breakout_with_volume, oversold_healthy, earnings_runup, relative_strength, new_highs. Returns up to 15 rows.",
      input_schema: { type: "object", properties: { market: { type: "string" }, filters: { type: "object" }, filter_preset: { type: "string" }, sort_by: { type: "string" }, sort_order: { type: "string" }, columns: { type: "array", items: { type: "string" } } }, required: ["market"] } },
    schema: z.object({ market: z.string().max(32), filters: z.record(z.any()).optional(), filter_preset: z.string().max(64).optional(),
      sort_by: z.string().max(64).optional(), sort_order: z.enum(["asc", "desc"]).optional(), columns: z.array(z.string().max(64)).max(20).optional() }),
    label: (i) => `screener ${i.market}`,
    run: (i, _e, ctx) => ctx.tv(TV.screener, { ...i, limit: 15 }),
  },
  {
    tool: { name: "get_earnings_calendar", description: "Next and last earnings dates with EPS and revenue forecasts for the given symbols.",
      input_schema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } }, date_to: { type: "string", description: "YYYY-MM-DD" } }, required: ["symbols"] } },
    schema: z.object({ symbols: z.array(sym).min(1).max(50), date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    label: () => "earnings",
    run: (i, _e, ctx) => ctx.tv(TV.earnings, i),
  },
  {
    tool: { name: "get_dividends", description: "Dividend ex-dates, amounts and yields. Pass symbols, or market (america, thailand) with an optional date_to.",
      input_schema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } }, market: { type: "string" }, date_to: { type: "string" } } } },
    schema: z.object({ symbols: z.array(sym).max(50).optional(), market: z.string().max(32).optional(), date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    label: () => "dividends",
    run: (i, _e, ctx) => ctx.tv(TV.dividends, { ...i, limit: 40 }),
  },
  {
    tool: { name: "get_economic_calendar", description: "Macro events (rates, CPI, GDP). countries: US or TH etc. Dates YYYY-MM-DD, up to 31 days ahead. min_importance 0 = medium and high.",
      input_schema: { type: "object", properties: { countries: { type: "string" }, date_from: { type: "string" }, date_to: { type: "string" }, min_importance: { type: "integer" } } } },
    schema: z.object({ countries: z.string().max(40).optional(), date_from: z.string().max(25).optional(), date_to: z.string().max(25).optional(), min_importance: z.number().int().min(-1).max(1).optional() }),
    label: (i) => `macro ${i.countries ?? "US"}`,
    run: (i, _e, ctx) => ctx.tv(TV.economic, { countries: i.countries ?? "US", min_importance: i.min_importance ?? 0, ...(i.date_from && { date_from: i.date_from }), ...(i.date_to && { date_to: i.date_to }) }),
  },
  {
    tool: { name: "search_symbols", description: "Resolve a ticker or company name to EXCHANGE:TICKER.",
      input_schema: { type: "object", properties: { query: { type: "string" }, type_filter: { type: "string" } }, required: ["query"] } },
    schema: z.object({ query: z.string().min(1).max(80), type_filter: z.string().max(20).optional() }),
    label: (i) => `search ${i.query}`,
    run: async (i, _e, ctx) => (((await ctx.tv(TV.search, i)) as any)?.data?.symbols ?? []).slice(0, 6),
  },
  {
    tool: { name: "scan_chart_patterns", description: `Scan a market for stocks whose recent daily chart matches a chart pattern. pattern: ${TEMPLATES.map((t) => t.id).join(", ")}. universe: ${Object.keys(UNIVERSES).join(", ")}. themes (optional, any of): ${Object.keys(THEMES).join(", ")}. length: short (1-3 months), medium (3-6 months, default), long (6-12 months). An AI reads each chart against the textbook definition. Returns the matches with AI confidence % (60-100), date span, pattern height %, stage, evidence (Thai), breakout and invalidation levels.`,
      input_schema: { type: "object", properties: { pattern: { type: "string" }, universe: { type: "string" }, themes: { type: "array", items: { type: "string" } }, length: { type: "string" } }, required: ["pattern", "universe"] } },
    schema: z.object({ pattern: z.string().max(40), universe: z.enum(Object.keys(UNIVERSES) as [keyof typeof UNIVERSES]),
      themes: z.array(z.enum(Object.keys(THEMES) as [string])).max(5).optional(), length: z.enum(["short", "medium", "long"]).optional() }),
    label: (i) => `pattern scan ${i.pattern} ${i.universe}`,
    run: async (i, _e, ctx) => {
      const t = templateById(i.pattern);
      if (!t) throw new Error(`Unknown pattern. Use one of: ${TEMPLATES.map((x) => x.id).join(", ")}`);
      const r = await runScan({ ai: ctx.ai, tv: ctx.tv, universe: i.universe, themes: i.themes ?? [], length: i.length ?? "medium", template: t, limit: 10 }, () => {});
      return { pattern: t.name, bias: t.bias, checked: r.checked, note: r.note, matches: r.rows.map(({ closes: _c, points: _p, lines: _l, ...row }) => row) };
    },
  },
  {
    tool: { name: "get_pattern_bars", description: "Daily bars around a chart pattern for checking it: swing highs and lows with dates, pattern high/low, closes (sampled) with dates, volume during the pattern vs the last 10 days, and price action after the pattern. date_from/date_to are the pattern's start and end (YYYY-MM-DD).",
      input_schema: { type: "object", properties: { symbol: { type: "string", description: SYMBOL_DESC }, date_from: { type: "string" }, date_to: { type: "string" } }, required: ["symbol", "date_from", "date_to"] } },
    schema: z.object({ symbol: sym, date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    label: (i) => `pattern bars ${i.symbol}`,
    run: async (i, _e, ctx) => {
      const lead = new Date(Date.parse(i.date_from) - 30 * 86400e3).toISOString().slice(0, 10);
      const p = (await ctx.tv(TV.ohlcv, { symbol: i.symbol, interval: "1D", date_from: lead, count: 400, format: "columns" })) as any;
      const b = p?.bars ?? {};
      const t: number[] = b.t ?? [], h: number[] = b.h ?? [], l: number[] = b.l ?? [], c: number[] = b.c ?? [], v: number[] = b.v ?? [];
      const day = (k: number) => new Date(t[k] * 1000).toISOString().slice(0, 10);
      const s0 = t.findIndex((_x, k) => day(k) >= i.date_from);
      let s1 = t.length - 1;
      while (s1 > 0 && day(s1) > i.date_to) s1--;
      if (s0 < 0 || s1 <= s0) throw new Error("No bars in that date range.");
      // Swing points: highest high / lowest low within 5 bars either side.
      const R = 5, swings: { date: string; type: "high" | "low"; price: number }[] = [];
      for (let k = Math.max(s0, R); k <= Math.min(t.length - 1 - R, s1 + R); k++) {
        const hs = h.slice(k - R, k + R + 1), ls = l.slice(k - R, k + R + 1);
        if (h[k] === Math.max(...hs)) swings.push({ date: day(k), type: "high", price: h[k] });
        else if (l[k] === Math.min(...ls)) swings.push({ date: day(k), type: "low", price: l[k] });
      }
      const win = { h: h.slice(s0, s1 + 1), l: l.slice(s0, s1 + 1), v: v.slice(s0, s1 + 1) };
      const hi = Math.max(...win.h), lo = Math.min(...win.l);
      const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
      const step = Math.max(1, Math.ceil((s1 - s0 + 1) / 50));
      const sampled = [];
      for (let k = s0; k <= s1; k += step) sampled.push([day(k), c[k]]);
      return {
        symbol: p?.symbol, pattern_from: day(s0), pattern_to: day(s1), bars: s1 - s0 + 1,
        pattern_high: { price: hi, date: day(s0 + win.h.indexOf(hi)) }, pattern_low: { price: lo, date: day(s0 + win.l.indexOf(lo)) },
        swings: swings.slice(0, 24), closes_sampled: sampled,
        avg_volume_pattern: Math.round(avg(win.v)), avg_volume_last10: Math.round(avg(v.slice(-10))),
        after_pattern: { bars: t.length - 1 - s1, closes: c.slice(s1 + 1).slice(-20), high: Math.max(...h.slice(s1 + 1), -Infinity), low: Math.min(...l.slice(s1 + 1), Infinity) },
        last: { date: day(t.length - 1), close: c[c.length - 1] },
      };
    },
  },
  {
    tool: { name: "get_dashboard", description: "What Neal sees now: watchlist symbols, the selected symbol and today's date.",
      input_schema: { type: "object", properties: {} } },
    schema: z.object({}),
    label: () => "dashboard",
    run: async (_i, _e, ctx) => ({ today: new Date().toISOString().slice(0, 10), selected: ctx.selected, watchlist: ctx.watchlist }),
  },
  {
    tool: { name: "propose_alert", description: "Show Neal a Confirm button to create a TradingView price alert. condition: cross_up, cross_down, greater, less, cross. Nothing is created until Neal confirms.",
      input_schema: { type: "object", properties: { symbol: { type: "string", description: SYMBOL_DESC }, condition: { type: "string" }, price: { type: "number" }, name: { type: "string" } }, required: ["symbol", "condition", "price"] } },
    schema: z.object({ symbol: sym, condition: z.enum(["cross_up", "cross_down", "greater", "less", "cross"]), price: z.number().positive(), name: z.string().max(300).optional() }),
    label: (i) => `propose alert ${i.symbol}`,
    run: async (i, emit) => {
      emit({ type: "proposal", proposal: { kind: "alert", symbol: i.symbol, condition: i.condition, price: i.price, name: i.name ?? `Agent: ${i.symbol} ${i.condition} ${i.price}` } });
      return "Confirm card shown to Neal. Not created yet.";
    },
  },
  {
    tool: { name: "propose_watchlist_change", description: "Show Neal a Confirm button to add or remove symbols on the TradingView watchlist. action: add | remove.",
      input_schema: { type: "object", properties: { action: { type: "string" }, symbols: { type: "array", items: { type: "string" } } }, required: ["action", "symbols"] } },
    schema: z.object({ action: z.enum(["add", "remove"]), symbols: z.array(sym).min(1).max(20) }),
    label: (i) => `propose ${i.action} ${i.symbols.join(", ")}`,
    run: async (i, emit) => {
      emit({ type: "proposal", proposal: { kind: "watchlist", action: i.action, symbols: i.symbols } });
      return "Confirm card shown to Neal. Not changed yet.";
    },
  },
];


export const TOOL_SPECS: ToolSpec[] = defs.map((d) => d.tool);
const byName = new Map(defs.map((d) => [d.tool.name, d]));

/** Validate and run one tool call. Never throws: failures come back as { isError: true }. */
export async function executeTool(name: string, input: unknown, emit: (e: NovaEvent) => void, ctx: NovaContext): Promise<{ isError: boolean; content: string }> {
  const def = byName.get(name);
  if (!def) return { isError: true, content: `Unknown tool ${name}` };
  const parsed = def.schema.safeParse(input ?? {});
  if (!parsed.success) return { isError: true, content: `Invalid input: ${parsed.error.message.slice(0, 500)}` };
  emit({ type: "step", text: def.label(parsed.data) });
  try {
    return { isError: false, content: clip(await def.run(parsed.data, emit, ctx)) };
  } catch (err) {
    return { isError: true, content: (err as Error).message.slice(0, 500) };
  }
}

export const MAX_ROUNDS = 8;
export const contextLine = (ctx: NovaContext) =>
  `Today is ${new Date().toISOString().slice(0, 10)}. Selected symbol: ${ctx.selected ?? "none"}. Watchlist: ${ctx.watchlist.join(", ") || "empty"}.`;
export const OUT_OF_ROUNDS = "_Stopped after several data lookups. Ask a narrower question to continue._";

export type ChatTurn = { role: "user" | "assistant"; content: string };
export type RunOptions = { history: ChatTurn[]; effort: "low" | "medium" | "high"; emit: (e: NovaEvent) => void; signal: AbortSignal } & NovaContext;
