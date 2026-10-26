import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { callTv, TV } from "./tradingview";

export const MODEL = "claude-opus-5-5";

export const PERSONA = `You are Nova, a calm, data-first market analyst working for Neal.
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

Commands: brief (watchlist summary: movers, ratings, news, earnings this week), analyze <ticker>, compare <a> <b>, scan <style> <market>, news <ticker>, earnings <period>, dividends <market>, macro <US|TH>, alert <ticker> <above|below> <price>, watch <add|remove> <ticker>.
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

type ToolDef = {
  tool: Anthropic.Tool;
  schema: z.ZodTypeAny;
  label: (i: any) => string;
  run: (i: any, emit: (e: NovaEvent) => void, ctx: { watchlist: string[]; selected: string | null }) => Promise<unknown>;
};

const defs: ToolDef[] = [
  {
    tool: { name: "get_quotes", description: "Live quotes for up to 50 symbols: close, % change, volume, market cap, P/E, sector.",
      input_schema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } } }, required: ["symbols"] } },
    schema: z.object({ symbols: z.array(sym).min(1).max(50) }),
    label: (i) => `quotes ${i.symbols.join(", ")}`,
    run: (i) => callTv(TV.quotes, { symbols: i.symbols }),
  },
  {
    tool: { name: "get_price_history", description: "OHLCV summary (period high/low, net change %, average volume) plus the last 30 closes. interval: 1h 4h 1D 1W. count = number of bars, default 126 (about 6 months daily).",
      input_schema: { type: "object", properties: { symbol: { type: "string", description: SYMBOL_DESC }, interval: { type: "string" }, count: { type: "integer" } }, required: ["symbol"] } },
    schema: z.object({ symbol: sym, interval: z.string().max(4).optional(), count: z.number().int().min(5).max(1000).optional() }),
    label: (i) => `history ${i.symbol}`,
    run: async (i) => {
      const p = (await callTv(TV.ohlcv, { symbol: i.symbol, interval: i.interval ?? "1D", count: i.count ?? 126, format: "columns" })) as any;
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
    run: (i) => callTv(TV.technicals, { symbol: i.symbol, interval: i.interval ?? "1D" }),
  },
  {
    tool: { name: "get_news", description: "Latest headlines for a symbol: title, provider, published time.",
      input_schema: { type: "object", properties: { symbol: { type: "string", description: SYMBOL_DESC }, limit: { type: "integer" } }, required: ["symbol"] } },
    schema: z.object({ symbol: sym, limit: z.number().int().min(1).max(15).optional() }),
    label: (i) => `news ${i.symbol}`,
    run: async (i) => {
      const p = (await callTv(TV.news, { symbol: i.symbol, limit: i.limit ?? 8 })) as any;
      return (p?.data?.headlines ?? []).map((h: any) => ({ title: h.title, provider: h.provider?.name, published: new Date(h.published * 1000).toISOString() }));
    },
  },
  {
    tool: { name: "get_fundamentals", description: "Fundamentals: P/E, P/B, margins, ROE, revenue, income, FCF, YoY growth.",
      input_schema: { type: "object", properties: { symbol: { type: "string", description: SYMBOL_DESC } }, required: ["symbol"] } },
    schema: z.object({ symbol: sym }),
    label: (i) => `fundamentals ${i.symbol}`,
    run: (i) => callTv(TV.financials, { symbol: i.symbol }),
  },
  {
    tool: { name: "get_analyst_forecasts", description: "Analyst consensus, buy/hold/sell counts, price targets with upside %.",
      input_schema: { type: "object", properties: { symbol: { type: "string", description: SYMBOL_DESC } }, required: ["symbol"] } },
    schema: z.object({ symbol: sym }),
    label: (i) => `forecasts ${i.symbol}`,
    run: (i) => callTv(TV.forecasts, { symbol: i.symbol }),
  },
  {
    tool: { name: "run_screener", description: "TradingView screener. market: america | thailand | crypto. filters like {\"rsi\":[null,40],\"div_yield\":[3,null],\"market_cap_basic\":[1e9,null]}. filter_preset: pullback_with_reversal, breakout_with_volume, oversold_healthy, earnings_runup, relative_strength, new_highs. Returns up to 15 rows.",
      input_schema: { type: "object", properties: { market: { type: "string" }, filters: { type: "object" }, filter_preset: { type: "string" }, sort_by: { type: "string" }, sort_order: { type: "string" }, columns: { type: "array", items: { type: "string" } } }, required: ["market"] } },
    schema: z.object({ market: z.string().max(32), filters: z.record(z.any()).optional(), filter_preset: z.string().max(64).optional(),
      sort_by: z.string().max(64).optional(), sort_order: z.enum(["asc", "desc"]).optional(), columns: z.array(z.string().max(64)).max(20).optional() }),
    label: (i) => `screener ${i.market}`,
    run: (i) => callTv(TV.screener, { ...i, limit: 15 }),
  },
  {
    tool: { name: "get_earnings_calendar", description: "Next and last earnings dates with EPS and revenue forecasts for the given symbols.",
      input_schema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } }, date_to: { type: "string", description: "YYYY-MM-DD" } }, required: ["symbols"] } },
    schema: z.object({ symbols: z.array(sym).min(1).max(50), date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    label: () => "earnings",
    run: (i) => callTv(TV.earnings, i),
  },
  {
    tool: { name: "get_dividends", description: "Dividend ex-dates, amounts and yields. Pass symbols, or market (america, thailand) with an optional date_to.",
      input_schema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } }, market: { type: "string" }, date_to: { type: "string" } } } },
    schema: z.object({ symbols: z.array(sym).max(50).optional(), market: z.string().max(32).optional(), date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    label: () => "dividends",
    run: (i) => callTv(TV.dividends, { ...i, limit: 40 }),
  },
  {
    tool: { name: "get_economic_calendar", description: "Macro events (rates, CPI, GDP). countries: US or TH etc. Dates YYYY-MM-DD, up to 31 days ahead. min_importance 0 = medium and high.",
      input_schema: { type: "object", properties: { countries: { type: "string" }, date_from: { type: "string" }, date_to: { type: "string" }, min_importance: { type: "integer" } } } },
    schema: z.object({ countries: z.string().max(40).optional(), date_from: z.string().max(25).optional(), date_to: z.string().max(25).optional(), min_importance: z.number().int().min(-1).max(1).optional() }),
    label: (i) => `macro ${i.countries ?? "US"}`,
    run: (i) => callTv(TV.economic, { countries: i.countries ?? "US", min_importance: i.min_importance ?? 0, ...(i.date_from && { date_from: i.date_from }), ...(i.date_to && { date_to: i.date_to }) }),
  },
  {
    tool: { name: "search_symbols", description: "Resolve a ticker or company name to EXCHANGE:TICKER.",
      input_schema: { type: "object", properties: { query: { type: "string" }, type_filter: { type: "string" } }, required: ["query"] } },
    schema: z.object({ query: z.string().min(1).max(80), type_filter: z.string().max(20).optional() }),
    label: (i) => `search ${i.query}`,
    run: async (i) => (((await callTv(TV.search, i)) as any)?.data?.symbols ?? []).slice(0, 6),
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
      emit({ type: "proposal", proposal: { kind: "alert", symbol: i.symbol, condition: i.condition, price: i.price, name: i.name ?? `Nova: ${i.symbol} ${i.condition} ${i.price}` } });
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

const TOOLS: Anthropic.Tool[] = defs.map((d) => d.tool);
const byName = new Map(defs.map((d) => [d.tool.name, d]));

const anthropic = new Anthropic();
const MAX_ROUNDS = 8;

export async function runNova(opts: {
  history: Anthropic.MessageParam[];
  effort: "low" | "medium" | "high";
  watchlist: string[];
  selected: string | null;
  emit: (e: NovaEvent) => void;
  signal: AbortSignal;
}): Promise<void> {
  const { emit } = opts;
  const messages: Anthropic.MessageParam[] = [...opts.history];
  const context = `Today is ${new Date().toISOString().slice(0, 10)}. Selected symbol: ${opts.selected ?? "none"}. Watchlist: ${opts.watchlist.join(", ") || "empty"}.`;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Server-side fallback on refusal; the SDK types may not list `fallbacks` yet.
    const params = {
      model: MODEL,
      max_tokens: 16000,
      system: [
        { type: "text" as const, text: PERSONA, cache_control: { type: "ephemeral" as const } },
        { type: "text" as const, text: context },
      ],
      tools: TOOLS,
      messages,
      output_config: { effort: opts.effort },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
    const response = (await anthropic.beta.messages.create(params as any, { signal: opts.signal })) as unknown as Anthropic.Message;

    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) emit({ type: "text", text: block.text });
    }
    if (response.stop_reason === "refusal") {
      emit({ type: "error", message: "Nova declined that request. Try rephrasing it." });
      return;
    }
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || uses.length === 0) return;

    messages.push({ role: "assistant", content: response.content });
    const results = await Promise.all(
      uses.map(async (u): Promise<Anthropic.ToolResultBlockParam> => {
        const def = byName.get(u.name);
        if (!def) return { type: "tool_result", tool_use_id: u.id, is_error: true, content: `Unknown tool ${u.name}` };
        const parsed = def.schema.safeParse(u.input);
        if (!parsed.success) return { type: "tool_result", tool_use_id: u.id, is_error: true, content: `Invalid input: ${parsed.error.message.slice(0, 500)}` };
        emit({ type: "step", text: def.label(parsed.data) });
        try {
          const out = await def.run(parsed.data, emit, { watchlist: opts.watchlist, selected: opts.selected });
          return { type: "tool_result", tool_use_id: u.id, content: clip(out) };
        } catch (err) {
          return { type: "tool_result", tool_use_id: u.id, is_error: true, content: (err as Error).message.slice(0, 500) };
        }
      }),
    );
    messages.push({ role: "user", content: results });
  }
  emit({ type: "text", text: "_Stopped after several data lookups. Ask a narrower question to continue._" });
}
