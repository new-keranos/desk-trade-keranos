import "server-only";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Tool names as the TradingView MCP server exposes them.
export const TV = {
  watchlist: "mcp-watchlist-get-active-watchlist",
  watchAdd: "mcp-watchlist-add-to-watchlist",
  watchRemove: "mcp-watchlist-remove-from-watchlist",
  quotes: "mcp-tv-get-symbol-data-batch",
  ohlcv: "mcp-tv-get-ohlcv",
  technicals: "mcp-tv-get-technicals-rating",
  news: "mcp-tv-get-news",
  financials: "mcp-tv-get-financials",
  forecasts: "mcp-tv-get-forecasts",
  screener: "mcp-tv-run-screener",
  earnings: "mcp-tv-get-earnings-calendar",
  dividends: "mcp-tv-get-dividends-calendar",
  economic: "mcp-tv-get-economic-calendar",
  search: "mcp-tv-search-symbols",
  alerts: "mcp-tv-list-alerts",
  createAlert: "mcp-tv-create-alert",
} as const;

export type TvTool = (typeof TV)[keyof typeof TV];

// Read-only tools the browser may call through /api/tv.
export const READ_TOOLS: ReadonlySet<string> = new Set([
  TV.watchlist, TV.quotes, TV.ohlcv, TV.technicals, TV.news, TV.financials, TV.forecasts,
  TV.screener, TV.earnings, TV.dividends, TV.economic, TV.search, TV.alerts,
]);
// Tools that change TradingView state. Only run after the user presses Confirm.
export const WRITE_TOOLS: ReadonlySet<string> = new Set([TV.watchAdd, TV.watchRemove, TV.createAlert]);

let clientPromise: Promise<Client> | null = null;

async function connect(): Promise<Client> {
  const url = process.env.TRADINGVIEW_MCP_URL;
  if (!url) throw new Error("TRADINGVIEW_MCP_URL is not set");
  const token = process.env.TRADINGVIEW_MCP_TOKEN;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: "nova-desk", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = connect().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

export class TvError extends Error {}

/** Call a TradingView MCP tool and return its JSON payload. */
export async function callTv(tool: TvTool | string, args: Record<string, unknown> = {}): Promise<unknown> {
  let client: Client;
  try {
    client = await getClient();
  } catch (err) {
    throw new TvError(`Could not connect to TradingView MCP: ${(err as Error).message}`);
  }
  let res;
  try {
    res = await client.callTool({ name: tool, arguments: args });
  } catch (err) {
    // A dropped session: reconnect once on the next call.
    clientPromise = null;
    throw new TvError(`TradingView call failed: ${(err as Error).message}`);
  }
  if (res.isError) {
    throw new TvError(`TradingView returned an error: ${textOf(res.content).slice(0, 300)}`);
  }
  if (res.structuredContent !== undefined) return res.structuredContent;
  const text = textOf(res.content);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => !!b && (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join("\n");
}
