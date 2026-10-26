import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

// TradingView's official MCP server: Streamable HTTP + OAuth 2.1 (https://www.tradingview.com/mcp/docs).
export const TV_MCP_URL = process.env.TRADINGVIEW_MCP_URL || "https://mcp.tradingview.com/mcp";

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

// Read-only tools the browser may call through /api/tv.
export const READ_TOOLS: ReadonlySet<string> = new Set([
  TV.watchlist, TV.quotes, TV.ohlcv, TV.technicals, TV.news, TV.financials, TV.forecasts,
  TV.screener, TV.earnings, TV.dividends, TV.economic, TV.search, TV.alerts,
]);
// Tools that change TradingView state. Only run after the user presses Confirm.
export const WRITE_TOOLS: ReadonlySet<string> = new Set([TV.watchAdd, TV.watchRemove, TV.createAlert]);

export class TvError extends Error {}
/** The user has not connected TradingView yet, or the connection expired. */
export class TvAuthError extends TvError {}

// ---------- OAuth state, kept in one encrypted httpOnly cookie ----------
const COOKIE = "tv_oauth";
type Stored = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; state?: string };

function key(): Buffer {
  const secret = process.env.SESSION_SECRET || process.env.APP_PASSWORD;
  if (!secret) throw new TvError("Set SESSION_SECRET (or APP_PASSWORD) to store the TradingView login.");
  return createHash("sha256").update("keranos-desk-tv:" + secret).digest();
}
function seal(data: Stored): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(data), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}
function unseal(raw: string | undefined): Stored {
  if (!raw) return {};
  try {
    const buf = Buffer.from(raw, "base64url");
    const d = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
  } catch {
    return {};
  }
}

/** OAuth provider for the MCP SDK, backed by the request's cookies. Must run before a response starts streaming. */
class CookieProvider implements OAuthClientProvider {
  authUrl: URL | null = null;
  constructor(private store: Stored, private origin: string, private persist: (s: Stored) => Promise<void>) {}

  get redirectUrl() { return `${this.origin}/api/tv/callback`; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Keranos Desk",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  state() { const s = randomBytes(16).toString("hex"); this.store.state = s; return s; }
  clientInformation() { return this.store.client; }
  async saveClientInformation(info: OAuthClientInformationMixed) { this.store.client = info; await this.persist(this.store); }
  tokens() { return this.store.tokens; }
  async saveTokens(tokens: OAuthTokens) { this.store.tokens = tokens; await this.persist(this.store); }
  async redirectToAuthorization(url: URL) { this.authUrl = url; await this.persist(this.store); }
  async saveCodeVerifier(v: string) { this.store.verifier = v; await this.persist(this.store); }
  codeVerifier() {
    if (!this.store.verifier) throw new TvAuthError("TradingView login expired. Connect again.");
    return this.store.verifier;
  }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "client") delete this.store.client;
    if (scope === "all" || scope === "tokens") delete this.store.tokens;
    if (scope === "all" || scope === "verifier") delete this.store.verifier;
    await this.persist(this.store);
  }
  get expectedState() { return this.store.state; }
}

async function provider(origin: string): Promise<CookieProvider> {
  const jar = await cookies();
  const store = unseal(jar.get(COOKIE)?.value);
  return new CookieProvider(store, origin, async (s) => {
    jar.set(COOKIE, seal(s), { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 60 });
  });
}

/** Start the OAuth flow. Returns the TradingView login URL, or null when already connected. */
export async function beginTvLogin(origin: string): Promise<URL | null> {
  const p = await provider(origin);
  const result = await auth(p, { serverUrl: TV_MCP_URL });
  return result === "REDIRECT" ? p.authUrl : null;
}

/** Finish the OAuth flow from the callback's code and state. */
export async function finishTvLogin(origin: string, code: string, state: string | null): Promise<void> {
  const p = await provider(origin);
  if (p.expectedState && state !== p.expectedState) throw new TvAuthError("TradingView login didn't match. Connect again.");
  const result = await auth(p, { serverUrl: TV_MCP_URL, authorizationCode: code });
  if (result !== "AUTHORIZED") throw new TvAuthError("TradingView didn't authorize the app. Connect again.");
}

export type TvCaller = (tool: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * Open a TradingView MCP session for this request. Call it before streaming a response,
 * because a token refresh may need to update the login cookie.
 */
export async function openTv(origin: string): Promise<{ call: TvCaller; close: () => Promise<void> }> {
  const p = await provider(origin);
  if (!p.tokens()) throw new TvAuthError("Connect TradingView first.");
  const transport = new StreamableHTTPClientTransport(new URL(TV_MCP_URL), { authProvider: p });
  const client = new Client({ name: "keranos-desk", version: "0.2.0" });
  try {
    await client.connect(transport);
  } catch (err) {
    if (err instanceof UnauthorizedError || p.authUrl) throw new TvAuthError("TradingView login expired. Connect again.");
    throw new TvError(`Could not connect to TradingView: ${(err as Error).message}`);
  }
  const call: TvCaller = async (tool, args = {}) => {
    let res;
    try {
      res = await client.callTool({ name: tool, arguments: args });
    } catch (err) {
      if (err instanceof UnauthorizedError) throw new TvAuthError("TradingView login expired. Connect again.");
      throw new TvError(`TradingView call failed: ${(err as Error).message}`);
    }
    if (res.isError) throw new TvError(`TradingView returned an error: ${textOf(res.content).slice(0, 300)}`);
    if (res.structuredContent !== undefined) return res.structuredContent;
    const text = textOf(res.content);
    try { return JSON.parse(text); } catch { return text; }
  };
  return { call, close: () => client.close().catch(() => {}) };
}

/** Forget the TradingView login. */
export async function disconnectTv(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => !!b && (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Public origin of the app, for the OAuth redirect URL. */
export function originOf(req: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const u = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? u.host;
  return `${proto}://${host}`;
}
