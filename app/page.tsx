"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---------- helpers ----------
type Quote = { description?: string; close?: number; change?: number; change_abs?: number; volume?: number | null;
  market_cap_basic?: number | null; price_earnings_ttm?: number | null; sector?: string | null; high?: number; low?: number };
type Bars = { t: number[]; c: number[] };
type Tech = { price?: number; summary?: { recommendation?: string; value?: number; ma?: string };
  oscillators?: Record<string, number>; moving_averages?: Record<string, number> };
type Headline = { title: string; link?: string; storyPath?: string; published: number; provider?: { name?: string } };
type Alert = { alert_id: number; symbol: string; condition_type: string; threshold: number; name?: string; expiration?: string };
type Proposal =
  | { kind: "alert"; symbol: string; condition: string; price: number; name: string }
  | { kind: "watchlist"; action: "add" | "remove"; symbols: string[] };
type LogItem =
  | { id: number; kind: "me"; text: string }
  | { id: number; kind: "nova"; text: string; steps: string[]; pending: boolean; error?: string }
  | { id: number; kind: "confirm"; proposal: Proposal; status: "open" | "working" | "done" | "cancelled" | "failed"; note?: string };

const CRYPTO_EX = ["BINANCE", "COINBASE", "BYBIT", "OKX", "KRAKEN", "BITSTAMP", "CRYPTOCAP", "CRYPTO", "BITGET", "KUCOIN"];
type Market = "US" | "SET" | "CRYPTO";
function market(sym: string): Market {
  const ex = sym.split(":")[0].toUpperCase();
  if (ex === "SET" || ex === "MAI" || ex === "TFEX") return "SET";
  if (CRYPTO_EX.includes(ex)) return "CRYPTO";
  return "US";
}
const ccy = (s: string) => ({ SET: "THB", CRYPTO: "USDT", US: "USD" })[market(s)];
function fmtPx(v?: number | null) {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v);
  const d = a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
const fmtPct = (v?: number | null) => (v == null || !isFinite(v) ? "—" : (v > 0 ? "+" : "") + v.toFixed(2) + "%");
function fmtBig(v?: number | null) {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}
const cls = (v?: number | null) => (v == null ? "muted" : v > 0 ? "up" : v < 0 ? "down" : "muted");
function ago(unix: number) {
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}
const CONDITION_WORD: Record<string, string> = { cross_up: "crosses above", cross_down: "crosses below", cross: "crosses", greater: "is above", less: "is below" };

async function tv<T = any>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch("/api/tv", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool, input }) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { location.href = "/login"; throw new Error("Signed out"); }
  if (r.status === 409 && j.connect) window.dispatchEvent(new CustomEvent("nova:tv-connect", { detail: j.error }));
  if (!r.ok) throw new Error(j.error || `TradingView request failed (${r.status})`);
  return j.data as T;
}

// Minimal, escaped Markdown for Nova's replies.
function md(text: string) {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const inline = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/(^|[^*])[*_]([^*_]+)[*_]/g, "$1<i>$2</i>");
  let out = "", list = false;
  for (const raw of esc(text).split("\n")) {
    const l = raw.trimEnd();
    const li = l.match(/^\s*[-*•]\s+(.*)/) || l.match(/^\s*\d+\.\s+(.*)/);
    if (li) { if (!list) { out += "<ul>"; list = true; } out += `<li>${inline(li[1])}</li>`; continue; }
    if (list) { out += "</ul>"; list = false; }
    const h = l.match(/^#{1,4}\s+(.*)/);
    if (h) out += `<h4>${inline(h[1])}</h4>`; else if (l.trim()) out += `<p>${inline(l)}</p>`;
  }
  return list ? out + "</ul>" : out;
}

const PULSE: [string, string][] = [["SP:SPX", "S&P 500"], ["NASDAQ:NDX", "Nasdaq 100"], ["SET:SET", "SET"], ["BINANCE:BTCUSDT", "BTC"], ["CRYPTOCAP:TOTAL", "Crypto cap"]];
const QUOTE_COLS = ["name", "description", "close", "change", "change_abs", "volume", "market_cap_basic", "price_earnings_ttm", "sector", "high", "low"];
const CMDS: [string, string][] = [["brief", "brief"], ["analyze", "analyze"], ["compare", "compare NASDAQ:AAPL NASDAQ:MSFT"], ["scan", "scan momentum US"],
  ["SET dividends", "dividends SET"], ["earnings", "earnings this week"], ["macro US", "macro US"], ["macro TH", "macro TH"]];

// ---------- page ----------
export default function Desk() {
  const [watchlistId, setWatchlistId] = useState<string | null>(null);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [wlError, setWlError] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [filter, setFilter] = useState<"all" | Market>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [connect, setConnect] = useState<string | null>(null);

  useEffect(() => {
    const err = new URLSearchParams(location.search).get("tv_error");
    if (err) { setConnect(err); history.replaceState(null, "", "/"); }
    const on = (e: Event) => setConnect((e as CustomEvent<string>).detail || "Connect TradingView to load your data.");
    window.addEventListener("nova:tv-connect", on);
    return () => window.removeEventListener("nova:tv-connect", on);
  }, []);

  const loadWatchlist = useCallback(async () => {
    try {
      const d = await tv<{ watchlist?: { id?: number; symbols?: string[] } }>("mcp-watchlist-get-active-watchlist");
      const w = d.watchlist ?? {};
      setWatchlistId(w.id != null ? String(w.id) : null);
      const syms = w.symbols ?? [];
      setSymbols(syms);
      setSelected((cur) => cur ?? syms.find((s) => market(s) === "US") ?? syms[0] ?? null);
      setWlError(null);
    } catch (e) { setWlError((e as Error).message); }
  }, []);
  useEffect(() => { loadWatchlist(); }, [loadWatchlist]);

  const quoteSet = useMemo(() => Array.from(new Set([...symbols, ...PULSE.map((p) => p[0]), ...(selected ? [selected] : [])])).slice(0, 50), [symbols, selected]);
  useEffect(() => {
    let live = true;
    const load = () => tv<{ data?: Record<string, Quote> }>("mcp-tv-get-symbol-data-batch", { symbols: quoteSet, columns: QUOTE_COLS })
      .then((d) => live && setQuotes((q) => ({ ...q, ...(d.data ?? {}) }))).catch(() => {});
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 60_000);
    return () => { live = false; clearInterval(id); };
  }, [quoteSet]);

  return (
    <>
      <header className="top">
        <div className="brand"><h1>Keranos <span>Desk</span></h1><small>US · SET · Crypto</small></div>
        <div className="pulse" aria-label="Market pulse">
          {PULSE.map(([s, n]) => {
            const q = quotes[s];
            return (
              <div key={s}><b>{n}</b>
                <span className="num">{q ? (s === "CRYPTOCAP:TOTAL" ? "$" + fmtBig(q.close) : fmtPx(q.close)) : "—"}</span>
                {q && <span className={"num " + cls(q.change)}>{fmtPct(q.change)}</span>}
              </div>
            );
          })}
        </div>
      </header>
      {connect && (
        <div className="connect-bar" role="alert">
          <span>{connect}</span>
          <a className="btn primary" href="/api/tv/connect">Connect TradingView</a>
        </div>
      )}
      <main className="desk">
        <Watchlist symbols={symbols} quotes={quotes} filter={filter} setFilter={setFilter} selected={selected} onSelect={setSelected}
          error={wlError} watchlistId={watchlistId} onChanged={(s) => { if (s) setSelected(s); loadWatchlist(); }} />
        <Focus symbol={selected} quote={selected ? quotes[selected] : undefined} />
        <section className="stack console-col" aria-label="Nova console">
          <Console symbols={symbols} selected={selected} watchlistId={watchlistId} onWatchlistChanged={loadWatchlist} />
          <Alerts />
        </section>
      </main>
      <p className="foot">Data from TradingView, delayed or realtime per your plan. Nova&apos;s answers are research, not financial advice.</p>
    </>
  );
}

// ---------- watchlist ----------
function Watchlist(p: { symbols: string[]; quotes: Record<string, Quote>; filter: "all" | Market; setFilter: (f: "all" | Market) => void;
  selected: string | null; onSelect: (s: string) => void; error: string | null; watchlistId: string | null; onChanged: (s?: string) => void }) {
  const [value, setValue] = useState("");
  const [hint, setHint] = useState("Add ticker, e.g. SET:KBANK");
  const [busy, setBusy] = useState(false);
  const list = p.symbols.filter((s) => p.filter === "all" || market(s) === p.filter);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!p.watchlistId || !value.trim()) return;
    setBusy(true);
    try {
      let sym = value.trim().toUpperCase();
      if (!sym.includes(":")) {
        const r = await tv<{ data?: { symbols?: { symbol: string; type: string }[] } }>("mcp-tv-search-symbols", { query: value.trim() });
        const hits = r.data?.symbols ?? [];
        sym = (hits.find((h) => ["stock", "crypto", "etf", "index", "spot"].includes(h.type)) ?? hits[0])?.symbol ?? "";
      }
      if (!sym) { setHint("No match. Try EXCHANGE:TICKER"); return; }
      await tv("mcp-watchlist-add-to-watchlist", { watchlist_id: p.watchlistId, symbols: [sym] });
      setValue(""); setHint("Added " + sym); p.onChanged(sym);
    } catch (err) { setHint((err as Error).message.slice(0, 60)); }
    finally { setBusy(false); }
  }

  return (
    <aside className="pane" aria-labelledby="wl-h">
      <div className="pane-h"><h2 id="wl-h">Watchlist</h2><span className="label">{p.symbols.length ? `${p.symbols.length} symbols` : ""}</span></div>
      <div className="wl-filter chips" role="group" aria-label="Market filter">
        {(["all", "US", "SET", "CRYPTO"] as const).map((f) => (
          <button key={f} className="chip" aria-pressed={p.filter === f} onClick={() => p.setFilter(f)}>{f === "all" ? "All" : f === "CRYPTO" ? "Crypto" : f}</button>
        ))}
      </div>
      <ul className="wl">
        {p.error ? <li className="note warn">{p.error}</li>
          : !p.symbols.length ? <li className="note">Loading your TradingView watchlist…</li>
          : !list.length ? <li className="note">No symbols in this market yet.</li>
          : list.map((s) => {
            const q = p.quotes[s] ?? {};
            return (
              <li key={s}>
                <button aria-current={s === p.selected} onClick={() => p.onSelect(s)}>
                  <span className="t">{s.split(":")[1] ?? s}<span className="mkt">{market(s)}</span></span>
                  <span className="p num">{fmtPx(q.close)}</span>
                  <span className="d">{q.description ?? s}</span>
                  <span className={"c num " + cls(q.change)}>{fmtPct(q.change)}</span>
                </button>
              </li>
            );
          })}
      </ul>
      <form className="wl-add" onSubmit={add}>
        <input id="wl-add-in" value={value} onChange={(e) => setValue(e.target.value)} placeholder={hint} aria-label="Add a symbol to the watchlist" autoComplete="off" />
        <button className="btn" type="submit" disabled={busy}>Add</button>
      </form>
    </aside>
  );
}

// ---------- focus ----------
function Focus({ symbol, quote }: { symbol: string | null; quote?: Quote }) {
  const [bars, setBars] = useState<Bars | null>(null);
  const [tech, setTech] = useState<Tech | null>(null);
  const [news, setNews] = useState<Headline[] | null>(null);
  const [err, setErr] = useState<{ chart?: string; tech?: string; news?: string }>({});
  const [range, setRange] = useState(126);

  useEffect(() => {
    if (!symbol) return;
    let live = true;
    setBars(null); setTech(null); setNews(null); setErr({});
    const fail = (k: "chart" | "tech" | "news") => (e: Error) => live && setErr((x) => ({ ...x, [k]: e.message }));
    tv<{ bars?: Bars }>("mcp-tv-get-ohlcv", { symbol, interval: "1D", count: 252, format: "columns" }).then((d) => live && setBars(d.bars ?? null)).catch(fail("chart"));
    tv<{ data?: Tech }>("mcp-tv-get-technicals-rating", { symbol, interval: "1D" }).then((d) => live && setTech(d.data ?? null)).catch(fail("tech"));
    tv<{ data?: { headlines?: Headline[] } }>("mcp-tv-get-news", { symbol, limit: 6 }).then((d) => live && setNews(d.data?.headlines ?? [])).catch(fail("news"));
    return () => { live = false; };
  }, [symbol]);

  const q = quote ?? {};
  const stats: [string, string][] = symbol ? [
    ["Day range", q.low != null && q.high != null ? `${fmtPx(q.low)} – ${fmtPx(q.high)}` : "—"],
    ["Volume", fmtBig(q.volume)],
    ["Market cap", q.market_cap_basic ? `${fmtBig(q.market_cap_basic)} ${ccy(symbol)}` : "—"],
    ["P/E (TTM)", q.price_earnings_ttm != null ? q.price_earnings_ttm.toFixed(1) : "—"],
    ["Sector", q.sector || (market(symbol) === "CRYPTO" ? "Crypto" : "—")],
  ] : [];

  return (
    <section className="stack" aria-label="Selected symbol">
      <div className="pane">
        <div className="focus-h">
          <div>
            <h2>{symbol ? symbol.split(":")[1] ?? symbol : "—"}</h2>
            <div className="sub">{symbol ? `${q.description ?? symbol} · ${symbol} · ${ccy(symbol)}` : "Pick a symbol from the watchlist"}</div>
          </div>
          {q.close != null && (
            <div className="px">{fmtPx(q.close)}<small className={cls(q.change)}>{q.change_abs != null ? `${q.change_abs > 0 ? "+" : ""}${fmtPx(q.change_abs)} ` : ""}{fmtPct(q.change)}</small></div>
          )}
        </div>
        <div className="ranges chips" role="group" aria-label="Chart range">
          {([["1M", 22], ["3M", 66], ["6M", 126], ["1Y", 252]] as const).map(([l, n]) => (
            <button key={l} className="chip" aria-pressed={range === n} onClick={() => setRange(n)}>{l}</button>
          ))}
        </div>
        <div className="chart-wrap">
          {err.chart ? <div className="note warn">{err.chart}</div> : bars?.c?.length ? <Chart bars={bars} range={range} /> : <div className="note">Loading chart…</div>}
        </div>
        <dl className="stats" style={{ margin: 0 }}>
          {stats.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
      </div>
      <div className="pane">
        <div className="pane-h"><h2>Technicals · daily</h2>{tech && <TechPill rec={tech.summary?.recommendation} />}</div>
        {err.tech ? <div className="note warn">{err.tech}</div> : tech ? <TechBody t={tech} /> : <div className="note">Loading technicals…</div>}
      </div>
      <div className="pane">
        <div className="pane-h"><h2>News</h2><span className="label">{symbol}</span></div>
        <ul className="news">
          {err.news ? <li className="note warn">{err.news}</li>
            : !news ? <li className="note">Loading headlines…</li>
            : !news.length ? <li className="note">No recent headlines.</li>
            : news.slice(0, 6).map((h) => (
              <li key={h.link ?? h.title}>
                <a href={h.link ?? "https://www.tradingview.com" + (h.storyPath ?? "")} target="_blank" rel="noopener noreferrer">{h.title}</a>
                <div className="meta">{h.provider?.name} · {ago(h.published)}</div>
              </li>
            ))}
        </ul>
      </div>
    </section>
  );
}

function Chart({ bars, range }: { bars: Bars; range: number }) {
  const n = Math.min(range, bars.c.length);
  const c = bars.c.slice(-n), t = bars.t.slice(-n);
  const W = 640, H = 230, L = 8, R = 62, T = 12, B = 24;
  let lo = Math.min(...c), hi = Math.max(...c);
  const pad = (hi - lo) * 0.08 || hi * 0.01; lo -= pad; hi += pad;
  const x = (i: number) => L + (i / Math.max(1, n - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const pts = c.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const up = c[n - 1] >= c[0];
  const col = up ? "var(--up)" : "var(--down)";
  const chg = (c[n - 1] / c[0] - 1) * 100;
  const dl = (i: number) => new Date(t[i] * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Daily closes over ${n} sessions, ${fmtPct(chg)}`}>
      <defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={col} stopOpacity=".18" /><stop offset="1" stopColor={col} stopOpacity="0" /></linearGradient></defs>
      {[0, 1, 2, 3, 4].map((k) => {
        const v = lo + (k / 4) * (hi - lo), yy = y(v);
        return <g key={k}><line x1={L} x2={W - R} y1={yy} y2={yy} stroke="var(--line)" /><text x={W - R + 6} y={yy + 4} fontSize="11" fill="var(--muted)" fontFamily="IBM Plex Mono, monospace">{fmtPx(v)}</text></g>;
      })}
      <polygon points={`${x(0)},${H - B} ${pts} ${x(n - 1)},${H - B}`} fill="url(#fill)" />
      <polyline points={pts} fill="none" stroke={col} strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx={x(n - 1)} cy={y(c[n - 1])} r="3.5" fill={col} />
      {[0, Math.floor((n - 1) / 2), n - 1].map((i, k) => (
        <text key={k} x={x(i)} y={H - 6} fontSize="11" fill="var(--muted)" textAnchor={(["start", "middle", "end"] as const)[k]}>{dl(i)}</text>
      ))}
      <text x={L} y={T + 2} fontSize="11" fill={col} fontFamily="IBM Plex Mono, monospace" dominantBaseline="hanging">{fmtPct(chg)} over range</text>
    </svg>
  );
}

function TechPill({ rec = "NEUTRAL" }: { rec?: string }) {
  const kind = rec.includes("BUY") ? "buy" : rec.includes("SELL") ? "sell" : "neutral";
  return <span className={"pill " + kind}>{rec.replace("_", " ")}</span>;
}
function TechBody({ t }: { t: Tech }) {
  const v = t.summary?.value ?? 0, o = t.oscillators ?? {}, m = t.moving_averages ?? {}, px = t.price;
  const vs = (ma?: number) => (ma != null && px != null ? <b className={"num " + cls(px - ma)}>{fmtPx(ma)}</b> : "—");
  return (
    <div className="tech">
      <div><div className="label">Overall</div><div className="num" style={{ fontSize: 20 }}>{v.toFixed(2)}</div></div>
      <div><div className="meter"><i style={{ left: `${((v + 1) / 2) * 100}%` }} /></div><div className="meter-scale"><span>Strong sell −1</span><span>0</span><span>+1 Strong buy</span></div></div>
      <div className="tech-grid">
        <div><span>RSI 14</span><b className="num">{o.rsi != null ? o.rsi.toFixed(1) : "—"}</b></div>
        <div><span>MACD − signal</span><b className={"num " + cls((o.macd ?? 0) - (o.macd_signal ?? 0))}>{o.macd != null ? (o.macd - (o.macd_signal ?? 0)).toFixed(2) : "—"}</b></div>
        <div><span>ADX</span><b className="num">{o.adx != null ? o.adx.toFixed(1) : "—"}</b></div>
        <div><span>SMA 50</span>{vs(m.sma50)}</div>
        <div><span>SMA 200</span>{vs(m.sma200)}</div>
        <div><span>MA rating</span><b>{(t.summary?.ma ?? "—").replace("_", " ")}</b></div>
      </div>
    </div>
  );
}

// ---------- alerts ----------
function Alerts() {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => tv<{ alerts?: Alert[] }>("mcp-tv-list-alerts", { active: true }).then((d) => { if (live) { setAlerts(d.alerts ?? []); setErr(null); } }).catch((e) => live && setErr(e.message));
    load();
    const onChange = () => load();
    window.addEventListener("nova:alerts-changed", onChange);
    const id = setInterval(() => { if (!document.hidden) load(); }, 300_000);
    return () => { live = false; clearInterval(id); window.removeEventListener("nova:alerts-changed", onChange); };
  }, []);
  return (
    <div className="pane">
      <div className="pane-h"><h2>Active alerts</h2><span className="label">{alerts?.length ? `${alerts.length} active` : ""}</span></div>
      <ul className="alerts">
        {err ? <li className="note warn">{err}</li>
          : !alerts ? <li className="note">Loading alerts…</li>
          : !alerts.length ? <li className="note">No active alerts. Ask Nova, e.g. <code>alert TSLA below 200</code>.</li>
          : alerts.map((a) => (
            <li key={a.alert_id}>
              <span className="n"><b>{a.symbol.split(":")[1] ?? a.symbol}</b> {CONDITION_WORD[a.condition_type] ?? a.condition_type} <span className="num">{fmtPx(a.threshold)}</span></span>
              <span className="muted num">{a.expiration ? "until " + new Date(a.expiration).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""}</span>
              <span className="muted" style={{ gridColumn: "1/-1", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}

// ---------- Nova console ----------
function Console({ symbols, selected, watchlistId, onWatchlistChanged }: { symbols: string[]; selected: string | null; watchlistId: string | null; onWatchlistChanged: () => void }) {
  const [log, setLog] = useState<LogItem[]>([]);
  const [input, setInput] = useState("");
  const [effort, setEffort] = useState<"low" | "medium" | "high">("medium");
  const [busy, setBusy] = useState(false);
  const turns = useRef<{ role: "user" | "assistant"; content: string }[]>([]);
  const ctl = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const logEl = useRef<HTMLDivElement>(null);
  useEffect(() => { logEl.current?.scrollTo({ top: logEl.current.scrollHeight }); }, [log]);

  const patch = (id: number, f: (i: LogItem) => LogItem) => setLog((l) => l.map((i) => (i.id === id ? f(i) : i)));

  async function ask(text: string) {
    text = text.trim();
    if (!text || busy) return;
    setInput(""); setBusy(true);
    const meId = nextId.current++, novaId = nextId.current++;
    setLog((l) => [...l, { id: meId, kind: "me", text }, { id: novaId, kind: "nova", text: "", steps: [], pending: true }]);
    turns.current.push({ role: "user", content: text });
    const history = turns.current.slice(-8);
    while (history.length && history[0].role !== "user") history.shift();
    ctl.current = new AbortController();
    let answer = "";
    try {
      const res = await fetch("/api/nova", { method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.current.signal,
        body: JSON.stringify({ messages: history, effort, watchlist: symbols, selected }) });
      if (res.status === 401) { location.href = "/login"; return; }
      if (res.status === 409) {
        const j = await res.json().catch(() => ({}));
        window.dispatchEvent(new CustomEvent("nova:tv-connect", { detail: j.error }));
        throw new Error(j.error || "Connect TradingView first.");
      }
      if (!res.ok || !res.body) throw new Error("Nova is unavailable right now.");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.startsWith("data: ")) continue;
          const ev = JSON.parse(part.slice(6));
          if (ev.type === "step") patch(novaId, (i) => (i.kind === "nova" ? { ...i, steps: [...i.steps, ev.text] } : i));
          else if (ev.type === "text") { answer = answer ? answer + "\n\n" + ev.text : ev.text; const a = answer; patch(novaId, (i) => (i.kind === "nova" ? { ...i, text: a } : i)); }
          else if (ev.type === "proposal") setLog((l) => [...l, { id: nextId.current++, kind: "confirm", proposal: ev.proposal, status: "open" }]);
          else if (ev.type === "error") patch(novaId, (i) => (i.kind === "nova" ? { ...i, error: ev.message } : i));
        }
      }
      if (answer) turns.current.push({ role: "assistant", content: answer }); else turns.current.pop();
    } catch (e) {
      turns.current.pop();
      const msg = (e as Error).name === "AbortError" ? "Stopped." : (e as Error).message;
      patch(novaId, (i) => (i.kind === "nova" ? { ...i, error: msg } : i));
    } finally {
      patch(novaId, (i) => (i.kind === "nova" ? { ...i, pending: false } : i));
      setBusy(false);
    }
  }

  async function confirm(item: Extract<LogItem, { kind: "confirm" }>) {
    patch(item.id, (i) => ({ ...i, status: "working" }) as LogItem);
    const p = item.proposal;
    try {
      if (p.kind === "alert") {
        await tv("mcp-tv-create-alert", { symbol: p.symbol, condition: p.condition, price: p.price, name: p.name.slice(0, 300), resolution: "1D" });
        window.dispatchEvent(new Event("nova:alerts-changed"));
      } else {
        if (!watchlistId) throw new Error("No active watchlist found.");
        await tv(p.action === "add" ? "mcp-watchlist-add-to-watchlist" : "mcp-watchlist-remove-from-watchlist", { watchlist_id: watchlistId, symbols: p.symbols });
        onWatchlistChanged();
      }
      patch(item.id, (i) => ({ ...i, status: "done" }) as LogItem);
    } catch (e) {
      patch(item.id, (i) => ({ ...i, status: "failed", note: (e as Error).message + " Check TradingView before trying again." }) as LogItem);
    }
  }

  return (
    <div className="pane console">
      <div className="persona">
        <div className="mark" aria-hidden="true">N</div>
        <div><h2>Nova</h2><p>Data-first analyst · research and alerts, no trading</p></div>
        <select value={effort} onChange={(e) => setEffort(e.target.value as typeof effort)} aria-label="Answer depth">
          <option value="low">Fast</option><option value="medium">Balanced</option><option value="high">Deep</option>
        </select>
      </div>
      <div className="cmds chips" aria-label="Quick commands">
        {CMDS.map(([l, c]) => (
          <button key={l} className="chip" type="button" onClick={() => ask(c === "analyze" ? `analyze ${selected ?? "NASDAQ:NVDA"}` : c)}>{l}</button>
        ))}
      </div>
      <div className="log" ref={logEl} aria-live="polite">
        <div className="msg nova"><p>Type a command or a question. Try <code>brief</code>, <code>analyze NVDA</code>, <code>scan dividend SET</code> or <code>alert BTC below 75000</code>. I pull every number live from TradingView and ask you before changing alerts or your watchlist.</p></div>
        {log.map((i) => {
          if (i.kind === "me") return <div key={i.id} className="msg me">{i.text}</div>;
          if (i.kind === "nova") return (
            <div key={i.id} className="msg nova">
              {i.text ? <div dangerouslySetInnerHTML={{ __html: md(i.text) }} /> : i.pending && <p className="muted thinking">Thinking</p>}
              {i.error && <p className="down">{i.error}</p>}
              {i.pending && i.steps.length > 0 && <div className="steps">↳ {i.steps[i.steps.length - 1]}</div>}
            </div>
          );
          const p = i.proposal;
          const title = p.kind === "alert" ? `Create alert: ${p.symbol} ${CONDITION_WORD[p.condition] ?? p.condition} ${fmtPx(p.price)}`
            : `${p.action === "add" ? "Add to" : "Remove from"} watchlist: ${p.symbols.join(", ")}`;
          return (
            <div key={i.id} className="confirm">
              <div><b>{title}</b><div className="muted" style={{ fontSize: 13 }}>{p.kind === "alert" ? "TradingView price alert, daily resolution, 30 days, mobile push and popup." : "Changes your active TradingView watchlist."}</div></div>
              {i.status === "open" || i.status === "working" ? (
                <div className="row">
                  <button className="btn primary" type="button" disabled={i.status === "working"} onClick={() => confirm(i)}>{i.status === "working" ? "Working…" : "Confirm"}</button>
                  <button className="btn" type="button" disabled={i.status === "working"} onClick={() => patch(i.id, (x) => ({ ...x, status: "cancelled" }) as LogItem)}>Cancel</button>
                </div>
              ) : <span className={i.status === "done" ? "up" : i.status === "failed" ? "down" : "muted"}>{i.status === "done" ? "Done." : i.status === "cancelled" ? "Cancelled." : i.note}</span>}
            </div>
          );
        })}
      </div>
      <form className="ask" onSubmit={(e) => { e.preventDefault(); ask(input); }}>
        <input id="ask-in" value={input} onChange={(e) => setInput(e.target.value)} placeholder="analyze SET:PTT" aria-label="Command for Nova" autoComplete="off" />
        {busy ? <button className="btn" type="button" onClick={() => ctl.current?.abort()}>Stop</button>
          : <button className="btn primary" type="submit">Send</button>}
      </form>
    </div>
  );
}
