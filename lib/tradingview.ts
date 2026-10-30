import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
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

// ---------- OAuth state ----------
// Kept encrypted in one of two places:
// - by default, httpOnly cookies in each browser (every browser connects its own TradingView account);
// - with TV_SHARED_LOGIN=1 and an Upstash Redis database, one server-side login that every user of the app shares.
type Stored = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; state?: string };
type Store = { load(): Promise<Stored>; save(s: Stored): Promise<void>; clear(): Promise<void>; shared: boolean };

/** TradingView refused calls for this account (quota or suspension). Nothing should call it again until `until`. */
export class TvQuotaError extends TvError {
  constructor(message: string, readonly until: number) { super(message); }
}
/** Account-level refusals: stop calling until the pause ends. */
const QUOTA = /TOOL_QUOTA_EXCEEDED|quota exceeded|access to MCP is suspended/i;
/** Short per-minute limits: wait and try once more. */
const RATE = /\b429\b|rate.?limit|too many requests/i;
/** At most this many TradingView calls a minute from one server instance, well under TradingView's ~100. */
const PER_MINUTE = 30;
const recent: number[] = [];
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/** Wait until a call fits under PER_MINUTE in the last 60 s, then record it. */
async function slot() {
  for (;;) {
    const now = Date.now();
    while (recent.length && now - recent[0] > 60_000) recent.shift();
    if (recent.length < PER_MINUTE) { recent.push(now); return; }
    await sleep(60_000 - (now - recent[0]) + 50);
  }
}
/** Next 00:00 UTC, when TradingView lifts a day's suspension. */
const nextUtcMidnight = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };
// After a refusal, this server instance stops calling TradingView: more calls during a suspension risk a longer one.
let blockedUntil = 0;
export const tvBlockedUntil = () => (blockedUntil > Date.now() ? blockedUntil : 0);
function quotaError(text: string): TvQuotaError {
  // A suspension lasts until midnight UTC; any other quota refusal, an hour to be safe.
  const until = /suspend/i.test(text) ? nextUtcMidnight() : Date.now() + 3_600_000;
  blockedUntil = Math.max(blockedUntil, until);
  return new TvQuotaError(`TradingView paused this account's MCP access until ${new Date(until).toISOString().slice(11, 16)} UTC: ${text.slice(0, 240)}`, until);
}

/** TradingView's per-minute limit; handled inside the caller by waiting and retrying once. */
class TvRateError extends TvError {}

/** Thrown when this request lost a token-refresh race to a parallel request; retrying a moment later works. */
export class TvRetryError extends TvError {}

function key(): Buffer {
  const secret = process.env.SESSION_SECRET || process.env.APP_PASSWORD;
  if (!secret) throw new TvError("Set SESSION_SECRET (or APP_PASSWORD) to store the TradingView login.");
  return createHash("sha256").update("keranos-desk-tv:" + secret).digest();
}
// Compressed before encryption: TradingView's tokens are long, and a browser drops any cookie over 4 KB.
function seal(data: Stored): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(deflateRawSync(Buffer.from(JSON.stringify(data), "utf8"))), c.final()]);
  return "z" + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}
function unseal(raw: string | undefined | null): Stored {
  if (!raw) return {};
  try {
    const packed = raw.startsWith("z");
    const buf = Buffer.from(packed ? raw.slice(1) : raw, "base64url");
    const d = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    const plain = Buffer.concat([d.update(buf.subarray(28)), d.final()]);
    return JSON.parse((packed ? inflateRawSync(plain) : plain).toString("utf8"));
  } catch {
    return {};
  }
}
/** Keep only what refreshing needs: an id_token or other extras would only make the cookie bigger. */
function slim(s: Stored): Stored {
  const t = s.tokens;
  if (!t) return s;
  const { access_token, token_type, expires_in, refresh_token, scope } = t;
  const issuer = (t as { issuer?: string }).issuer;
  return { ...s, tokens: { access_token, token_type, expires_in, refresh_token, scope, ...(issuer ? { issuer } : {}) } as OAuthTokens };
}

const COOKIE = "tv_oauth";
const CHUNK = 3800;
const MAX_CHUNKS = 4;
async function cookieStore(): Promise<Store> {
  const jar = await cookies();
  const read = () => {
    const parts = [];
    for (let i = 0; i < MAX_CHUNKS; i++) { const v = jar.get(`${COOKIE}.${i}`)?.value; if (!v) break; parts.push(v); }
    return parts.length ? parts.join("") : jar.get(COOKIE)?.value; // older single-cookie logins
  };
  const opts = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge: 60 * 60 * 24 * 60 };
  const clear = async () => { jar.delete(COOKIE); for (let i = 0; i < MAX_CHUNKS; i++) jar.delete(`${COOKIE}.${i}`); };
  return {
    shared: false,
    load: async () => unseal(read()),
    save: async (s) => {
      const v = seal(slim(s));
      const n = Math.ceil(v.length / CHUNK);
      if (n > MAX_CHUNKS) throw new TvError("The TradingView login is too large to keep in a cookie. Use the shared login (TV_SHARED_LOGIN) instead.");
      for (let i = 0; i < MAX_CHUNKS; i++) {
        if (i < n) jar.set(`${COOKIE}.${i}`, v.slice(i * CHUNK, (i + 1) * CHUNK), opts);
        else if (jar.get(`${COOKIE}.${i}`)) jar.delete(`${COOKIE}.${i}`);
      }
      if (jar.get(COOKIE)) jar.delete(COOKIE);
    },
    clear,
  };
}

// Upstash Redis over its REST API (Vercel Marketplace sets KV_REST_API_* or UPSTASH_REDIS_REST_*).
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const REDIS_KEY = "keranos:tv_oauth";
/** One TradingView login for everyone who can open the app. */
export const sharedLogin = () => process.env.TV_SHARED_LOGIN === "1" && !!REDIS_URL && !!REDIS_TOKEN;
/** Redis is configured (for the shared login or the scan cache). */
export const hasRedis = () => !!REDIS_URL && !!REDIS_TOKEN;
export async function redis(cmd: string[]): Promise<unknown> {
  const r = await fetch(REDIS_URL!, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd), cache: "no-store" });
  const j = (await r.json().catch(() => ({}))) as { result?: unknown; error?: string };
  if (!r.ok || j.error) throw new TvError(`Couldn't reach the login store (Redis): ${j.error ?? r.status}`);
  return j.result;
}
const redisStore: Store = {
  shared: true,
  load: async () => unseal((await redis(["GET", REDIS_KEY])) as string | null),
  save: async (s) => { await redis(["SET", REDIS_KEY, seal(slim(s))]); },
  clear: async () => { await redis(["DEL", REDIS_KEY]); },
};

const openStore = async (): Promise<Store> => (sharedLogin() ? redisStore : cookieStore());

/** OAuth provider for the MCP SDK, backed by the login store. Must run before a response starts streaming. */
class StoreProvider implements OAuthClientProvider {
  authUrl: URL | null = null;
  /** Set when a parallel request already used our refresh token (TradingView rotates it on every refresh). */
  raced = false;
  constructor(private store: Stored, private origin: string, private db: Store) {}
  private persist() { return this.db.save(this.store); }

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
  async saveClientInformation(info: OAuthClientInformationMixed) { this.store.client = info; await this.persist(); }
  tokens() { return this.store.tokens; }
  async saveTokens(tokens: OAuthTokens) { this.store.tokens = tokens; this.raced = false; await this.persist(); }
  async redirectToAuthorization(url: URL) {
    this.authUrl = url;
    // A request that lost a refresh race must not overwrite the login the winning request just saved.
    if (!this.raced) await this.persist();
  }
  async saveCodeVerifier(v: string) { this.store.verifier = v; if (!this.raced) await this.persist(); }
  codeVerifier() {
    if (!this.store.verifier) throw new TvAuthError("TradingView login expired. Connect again.");
    return this.store.verifier;
  }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "tokens" && this.store.tokens?.refresh_token) {
      // Our refresh token was rejected. Usually a parallel request refreshed first and rotated it.
      // In the shared store the winner may still be saving, so look again a few times.
      for (let i = 0; i < (this.db.shared ? 4 : 1); i++) {
        if (i) await new Promise((ok) => setTimeout(ok, 700));
        const latest = await this.db.load();
        if (latest.tokens?.refresh_token && latest.tokens.refresh_token !== this.store.tokens.refresh_token) {
          this.store = latest; // a parallel request already refreshed: carry on with its tokens
          return;
        }
      }
      if (!this.db.shared) { this.raced = true; delete this.store.tokens; return; } // cookies: the winner's Set-Cookie will land
    }
    if (scope === "all" || scope === "client") delete this.store.client;
    if (scope === "all" || scope === "tokens") delete this.store.tokens;
    if (scope === "all" || scope === "verifier") delete this.store.verifier;
    await this.persist();
  }
  get expectedState() { return this.store.state; }
}

async function provider(origin: string): Promise<StoreProvider> {
  const db = await openStore();
  return new StoreProvider(await db.load(), origin, db);
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
  if (tvBlockedUntil()) throw new TvQuotaError(`TradingView paused this account's MCP access until ${new Date(blockedUntil).toISOString().slice(11, 16)} UTC. The app won't call it again before then.`, blockedUntil);
  const p = await provider(origin);
  if (!p.tokens()) throw new TvAuthError("Connect TradingView first.");
  const transport = new StreamableHTTPClientTransport(new URL(TV_MCP_URL), { authProvider: p });
  const client = new Client({ name: "keranos-desk", version: "0.2.0" });
  try {
    await client.connect(transport);
  } catch (err) {
    if (p.raced) throw new TvRetryError("TradingView login is refreshing. Try again in a moment.");
    if (err instanceof UnauthorizedError || p.authUrl) throw new TvAuthError("TradingView login expired. Connect again.");
    throw new TvError(`Could not connect to TradingView: ${(err as Error).message}`);
  }
  const once = async (tool: string, args: Record<string, unknown>) => {
    if (tvBlockedUntil()) throw new TvQuotaError(`TradingView paused this account's MCP access until ${new Date(blockedUntil).toISOString().slice(11, 16)} UTC. The app won't call it again before then.`, blockedUntil);
    await slot();
    let res;
    try {
      res = await client.callTool({ name: tool, arguments: args });
    } catch (err) {
      if (p.raced) throw new TvRetryError("TradingView login is refreshing. Try again in a moment.");
      if (err instanceof UnauthorizedError) throw new TvAuthError("TradingView login expired. Connect again.");
      const m = (err as Error).message;
      if (QUOTA.test(m)) throw quotaError(m);
      if (RATE.test(m)) throw new TvRateError(m);
      throw new TvError(`TradingView call failed: ${m}`);
    }
    const text = textOf(res.content);
    if ((res.isError || text.includes("TOOL_QUOTA_EXCEEDED")) && QUOTA.test(text)) throw quotaError(text);
    if (res.isError && RATE.test(text)) throw new TvRateError(text);
    if (res.isError) throw new TvError(`TradingView returned an error: ${text.slice(0, 300)}`);
    const out = res.structuredContent !== undefined ? res.structuredContent : (() => { try { return JSON.parse(text); } catch { return text; } })();
    // The batch and screener tools report their own 429s as success: false.
    if ((out as { success?: boolean })?.success === false && RATE.test(JSON.stringify(out).slice(0, 2000))) throw new TvRateError(JSON.stringify(out).slice(0, 300));
    return out;
  };
  // A per-minute limit: wait a minute and try once more. A second refusal pauses this instance for an hour.
  const call: TvCaller = async (tool, args = {}) => {
    try { return await once(tool, args); } catch (err) {
      if (!(err instanceof TvRateError)) throw err;
      await sleep(61_000);
      try { return await once(tool, args); } catch (again) {
        if (again instanceof TvRateError) throw quotaError(`rate limit twice in a row: ${again.message}`);
        throw again;
      }
    }
  };
  return { call, close: () => client.close().catch(() => {}) };
}

/** Forget the TradingView login. */
export async function disconnectTv(): Promise<void> {
  await (await openStore()).clear();
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
