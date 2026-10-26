# Nova Desk

A web app for commanding an AI market analyst ("Nova") over your TradingView data. Covers US stocks, the Thai SET and crypto.

- **Dashboard:** your TradingView watchlist with live quotes, a market pulse strip (S&P 500, Nasdaq 100, SET, BTC, total crypto cap), a daily chart, technical rating, news and active alerts.
- **Nova console:** type commands such as `brief`, `analyze SET:PTT`, `scan dividend SET`, `macro TH` or `alert BTC below 75000`. Nova calls TradingView tools for every number.
- **Safe by design:** Nova can only *propose* alerts and watchlist changes. Nothing changes in TradingView until you press Confirm. There is no trading.

## How it works

```
Browser (client) ──> /api/tv    ──> TradingView MCP server (read tools, confirmed writes)
                 └─> /api/nova  ──> Gemini or Claude ── tool calls ──> TradingView MCP server
```

- `lib/tradingview.ts` connects to TradingView's official MCP server (`https://mcp.tradingview.com/mcp`, Streamable HTTP) and signs in with OAuth 2.1. The login is kept in an encrypted httpOnly cookie. Needs a TradingView Essential plan or higher.
- `lib/nova/tools.ts` holds the persona prompt and the TradingView tools. Edit `PERSONA` to change how Nova talks.
- `lib/nova/gemini.ts` runs Nova on Gemini (default, `gemini-flash-latest`, free tier). `lib/nova/claude.ts` runs it on Claude (`claude-opus-5-5`). Pick with `AI_PROVIDER`. API keys stay on the server.
- `middleware.ts` puts the whole app behind one password.
- On Claude, refusal fallback is on (`fallbacks: "default"`), so a declined request is retried on a fallback model automatically.

### About the Gemini free tier

- It has per-minute and per-day request limits. One Nova answer can use several requests (one per round of data lookups), so heavy use may hit the limit. The app shows a clear message when it does.
- Google may use prompts sent on the free tier to improve its products. Don't type anything private into Nova while on the free tier.

## Setup

1. Copy `.env.example` to `.env.local` and fill in:
   - `GEMINI_API_KEY` from https://aistudio.google.com/apikey (free).
   - Optional: `AI_PROVIDER=claude` plus `ANTHROPIC_API_KEY` from https://console.anthropic.com to run Nova on Claude (billed per token).
   - `APP_PASSWORD`: any password you choose, and `SESSION_SECRET`: a long random string.
   - On a deployed site, `APP_URL` with its public address.
2. `npm install`
3. `npm run dev` and open http://localhost:3000
4. Sign in, then press **Connect TradingView** and log in with your TradingView account. You only do this once per browser.

## Deploy on Vercel

1. Push this folder to a GitHub repo.
2. In Vercel, choose **Add New → Project**, import the repo and keep the Next.js defaults.
3. Add the environment variables from `.env.example` under **Settings → Environment Variables**.
4. Deploy. Nova's route allows up to 300 s per answer, which needs a Vercel plan that supports that duration.

## Commands

| Command | Example |
| --- | --- |
| brief | `brief` |
| analyze | `analyze NVDA` |
| compare | `compare AAPL MSFT` |
| scan | `scan momentum US`, `scan dividend SET` |
| news | `news BTC` |
| earnings | `earnings this week` |
| dividends | `dividends SET` |
| macro | `macro US`, `macro TH` |
| alert | `alert TSLA below 200` |
| watch | `watch add SET:KBANK` |

Not financial advice.
