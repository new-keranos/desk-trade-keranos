# Keranos Desk

A web app for commanding an AI market analyst ("Agent") over your TradingView data. Covers US stocks, the Thai SET and crypto.

- **Dashboard:** your TradingView watchlist with live quotes, a market pulse strip (S&P 500, Nasdaq 100, SET, BTC, total crypto cap), a daily chart, technical rating, news and active alerts.
- **Agent console:** type commands such as `brief`, `analyze SET:PTT`, `scan dividend SET`, `macro TH` or `alert BTC below 75000`. Agent calls TradingView tools for every number.
- **Pattern scanner:** pick a chart pattern (double bottom, cup and handle, head and shoulders, triangles, flags, wedges, channels and more) or upload a picture of the pattern you want. Choose S&P 500, Nasdaq 100, SET50 or SET100, and narrow by theme (Tech, Medical, Finance, Energy, Fintech). The scanner loads each stock's daily bars from TradingView and the AI reads them against the pattern's textbook definition (or your image), returning its confidence, the turning points and lines it used, its evidence, and breakout and invalidation levels. Open a match to see those marks drawn on the stock's candles with SMA 50/200 and RSI 14, then press **Analyze with Agent** to have Agent check the swing points, breakout level, volume and invalidation level.
- **Safe by design:** Agent can only *propose* alerts and watchlist changes. Nothing changes in TradingView until you press Confirm. There is no trading.

## How it works

```
Browser (client) ──> /api/tv    ──> TradingView MCP server (read tools, confirmed writes)
                 └─> /api/nova  ──> Gemini or Claude ── tool calls ──> TradingView MCP server
```

- `lib/tradingview.ts` connects to TradingView's official MCP server (`https://mcp.tradingview.com/mcp`, Streamable HTTP) and signs in with OAuth 2.1. The login is kept in an encrypted httpOnly cookie. Needs a TradingView Essential plan or higher.
- `lib/nova/tools.ts` holds the persona prompt and the TradingView tools. Edit `PERSONA` to change how Agent talks.
- `lib/nova/gemini.ts`, `openai.ts` and `claude.ts` run Agent on Gemini (default, `gemini-flash-latest`), OpenAI or Claude. `lib/nova/config.ts` lists the models; the picker in the Agent panel (also on the scanner) offers every provider whose API key is set, and `AI_PROVIDER` sets the default. API keys stay on the server.
- `lib/scan/` is the pattern scanner. `templates.ts` lists the patterns, `judge.ts` sends batches of 8 stocks' daily bars to the AI with the pattern's definition and maps its marks back onto real candles, `llm.ts` makes the JSON call to the chosen Gemini, OpenAI or Claude model, and `universe.ts` maps markets and themes to TradingView screener filters. One scan checks up to 80 stocks, largest first, to stay inside TradingView's limit of about 100 calls a minute; that is about 10 AI requests, which the Gemini free tier allows a few times an hour.
- `middleware.ts` puts the whole app behind one password.
- On Claude, refusal fallback is on (`fallbacks: "default"`), so a declined request is retried on a fallback model automatically.

### About the Gemini free tier

- It has per-minute and per-day request limits. One Agent answer can use several requests (one per round of data lookups), so heavy use may hit the limit. The app shows a clear message when it does.
- Google may use prompts sent on the free tier to improve its products. Don't type anything private into Agent while on the free tier.

## Setup

1. Copy `.env.example` to `.env.local` and fill in:
   - `GEMINI_API_KEY` from https://aistudio.google.com/apikey (free).
   - Optional: `OPENAI_API_KEY` from https://platform.openai.com and/or `ANTHROPIC_API_KEY` from https://console.anthropic.com (both billed per token). Each key adds that provider's models to the picker. `AI_PROVIDER=openai` or `claude` makes it the default.
   - `APP_PASSWORD`: any password you choose, and `SESSION_SECRET`: a long random string.
   - On a deployed site, `APP_URL` with its public address.
2. `npm install`
3. `npm run dev` and open http://localhost:3000
4. Sign in, then press **Connect TradingView** and log in with your TradingView account. You only do this once per browser.

## Deploy on Vercel

1. Push this folder to a GitHub repo.
2. In Vercel, choose **Add New → Project**, import the repo and keep the Next.js defaults.
3. Add the environment variables from `.env.example` under **Settings → Environment Variables**.
4. Deploy. Agent's route allows up to 300 s per answer, which needs a Vercel plan that supports that duration.

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
| pattern | `pattern double bottom SET100 energy` |
| analyze pattern | `analyze pattern SET:PTTGC cup_handle 2026-05-03 2026-10-26` |

Not financial advice.
