"use client";

// Watchlist signals: tell the user when an early bullish RSI divergence starts on a stock they picked. Nothing is
// traded and no entry is suggested; the user times the entry.
//
// TradingView call budget (an account was suspended for many per-symbol calls, 2026-10-28):
// - live prices ride on the desk's existing quote call (one get_symbol_data_batch a minute for the whole list);
// - daily bars are fetched at most once a day per watchlist stock, one at a time with a pause, capped per day,
//   and kept in this browser. Opening a stock on the desk stores its bars too, so that one costs nothing extra.

import { useCallback, useEffect, useMemo, useState } from "react";
import { earlyBullish, freshness, RANK, withLive, type Bars, type EarlySignal, type LiveQuote, type SignalState } from "@/lib/scan/early";
import { fmtPx, market } from "./format";
import { currentLang, useLang } from "./lang";

export type TvFn = <T = any>(tool: string, input?: Record<string, unknown>) => Promise<T>;
export type WatchQuote = LiveQuote & { relative_volume_10d_calc?: number; update_mode?: string };

const BARS_KEY = (s: string) => `keranos.bars.v1:${s}`;
const BUDGET_KEY = "keranos.barsbudget.v1", SEEN_KEY = "keranos.watchsig.v1", NOTIFIED_KEY = "keranos.watchnotified.v1", NOTIFY_KEY = "keranos.notify.v1";
/** Bars kept per stock (RSI warm-up plus the 60-bar lookback), chart fetches a day, and the pause between them. */
const KEEP = 300, MAX_FETCH_DAY = 40, GAP_MS = 1500;

const today = () => new Date().toLocaleDateString("en-CA");
const read = <T,>(k: string): T | null => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked: kept in memory only */ } };

const mem = new Map<string, Bars>();
const trim = (b: Bars): Bars => { const s = Math.max(0, b.c.length - KEEP); return { t: b.t.slice(s), o: b.o.slice(s), h: b.h.slice(s), l: b.l.slice(s), c: b.c.slice(s) }; };

/** Keep a stock's daily bars for today (the desk calls this after loading a chart). */
export function rememberBars(symbol: string, b?: Bars | null) {
  if (!b?.c?.length) return;
  const t = trim(b);
  mem.set(symbol, t);
  write(BARS_KEY(symbol), { day: today(), b: t });
  window.dispatchEvent(new CustomEvent("keranos:bars", { detail: symbol }));
}

function barsFor(symbol: string): Bars | null {
  const s = read<{ day: string; b: Bars }>(BARS_KEY(symbol));
  if (s?.day === today()) { mem.set(symbol, s.b); return s.b; }
  return null;
}

function budgetLeft(): number {
  const b = read<{ day: string; n: number }>(BUDGET_KEY);
  return MAX_FETCH_DAY - (b?.day === today() ? b.n : 0);
}
function spend() { const b = read<{ day: string; n: number }>(BUDGET_KEY); write(BUDGET_KEY, { day: today(), n: (b?.day === today() ? b.n : 0) + 1 }); }

// One queue for the whole page: one chart call at a time.
let queue: Promise<void> = Promise.resolve();
const queued = new Set<string>();
function fetchBars(tv: TvFn, symbol: string) {
  if (queued.has(symbol)) return;
  queued.add(symbol);
  queue = queue.then(async () => {
    try {
      if (barsFor(symbol) || budgetLeft() <= 0) return;
      spend();
      const d = await tv<{ bars?: Bars }>("mcp-tv-get-ohlcv", { symbol, interval: "1D", count: KEEP, format: "columns" });
      rememberBars(symbol, d.bars);
      await new Promise((ok) => setTimeout(ok, GAP_MS));
    } catch { /* tried again tomorrow or when the stock is opened */ } finally { queued.delete(symbol); }
  });
}

export type WatchSignal = EarlySignal & { symbol: string; rv?: number; mode?: string; fresh?: boolean };

/** Signals for the watchlist, recomputed whenever quotes or bars change. */
export function useWatchSignals(tv: TvFn, symbols: string[], quotes: Record<string, WatchQuote>) {
  const [version, setVersion] = useState(0);
  const [seen, setSeen] = useState<Record<string, number>>({});
  useEffect(() => { setSeen(read<Record<string, number>>(SEEN_KEY) ?? {}); }, []);
  useEffect(() => {
    const on = () => setVersion((v) => v + 1);
    window.addEventListener("keranos:bars", on);
    return () => window.removeEventListener("keranos:bars", on);
  }, []);
  useEffect(() => {
    for (const s of symbols) if (!mem.has(s) && !barsFor(s)) fetchBars(tv, s);
    setVersion((v) => v + 1);
  }, [symbols, tv]);

  const { signals, missing } = useMemo(() => {
    const out: WatchSignal[] = [];
    let missing = 0;
    for (const s of symbols) {
      const b = mem.get(s);
      if (!b) { missing++; continue; }
      const q = quotes[s];
      const sig = earlyBullish(withLive(b, q));
      if (sig) out.push({ ...sig, symbol: s, rv: q?.relative_volume_10d_calc, mode: q?.update_mode });
    }
    return { signals: out.sort((a, b) => RANK[b.state] - RANK[a.state] || (b.rv ?? 0) - (a.rv ?? 0)), missing };
  }, [symbols, quotes, version]); // eslint-disable-line react-hooks/exhaustive-deps

  // A stock that moves up a step (none → near → forming → confirmed) is new: notify once, then remember it.
  const fresh = useMemo(() => new Set(signals.filter((s) => RANK[s.state] > (seen[s.symbol] ?? 0)).map((s) => s.symbol)), [signals, seen]);
  // Notified once per step, across reloads.
  useEffect(() => {
    const done = read<Record<string, number>>(NOTIFIED_KEY) ?? {};
    let changed = false;
    for (const s of signals) if (RANK[s.state] > (done[s.symbol] ?? 0)) { done[s.symbol] = RANK[s.state]; changed = true; notify(s); }
    if (changed) write(NOTIFIED_KEY, done);
  }, [signals]);
  const ack = useCallback(() => {
    const next: Record<string, number> = {};
    for (const s of symbols) next[s] = 0;
    for (const s of signals) next[s.symbol] = RANK[s.state];
    write(SEEN_KEY, next);
    setSeen(next);
  }, [signals, symbols]);
  // A signal that went away resets, so it notifies again if it comes back.
  useEffect(() => {
    const cur = read<Record<string, number>>(SEEN_KEY) ?? {}, done = read<Record<string, number>>(NOTIFIED_KEY) ?? {};
    let changed = false;
    for (const s of symbols) if ((cur[s] || done[s]) && !signals.some((x) => x.symbol === s) && mem.has(s)) { cur[s] = 0; done[s] = 0; changed = true; }
    if (changed) { write(SEEN_KEY, cur); write(NOTIFIED_KEY, done); setSeen(cur); }
  }, [signals, symbols]);

  return { signals: signals.map((s) => ({ ...s, fresh: fresh.has(s.symbol) })), missing, budgetOut: missing > 0 && budgetLeft() <= 0, ack };
}

// ---------- browser notifications ----------

const ticker = (s: string) => s.split(":")[1] ?? s;
const STATE_TH: Record<SignalState, string> = { confirmed: "ยืนยันแล้ว", forming: "กำลังก่อตัว", near: "ใกล้เกิด" };
const STATE_EN: Record<SignalState, string> = { confirmed: "Confirmed", forming: "Forming", near: "Near" };

function notify(s: WatchSignal) {
  try {
    if (read<boolean>(NOTIFY_KEY) !== true || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const th = currentLang() === "th";
    const title = `${ticker(s.symbol)} · Bullish divergence ${th ? STATE_TH[s.state] : STATE_EN[s.state]}`;
    new Notification(title, { body: describe(s, th), tag: `keranos-${s.symbol}` });
  } catch { /* notifications unavailable */ }
}

const day = (t: number, th: boolean) => new Date(t * 1000).toLocaleDateString(th ? "th-TH" : "en-GB", { day: "numeric", month: "short" });

export function describe(s: EarlySignal, th: boolean): string {
  const r = Math.round;
  if (s.state === "near") {
    const pct = (((s.close - s.level!) / s.level!) * 100).toFixed(1);
    return th ? `อยู่เหนือ low เดิม ${fmtPx(s.level)} (${day(s.ref.t, th)}) ${pct}% · ถ้าลงไปปิดที่ระดับนั้น RSI ≈ ${r(s.rsiAtLevel!)} ยังสูงกว่า ${r(s.ref.rsi)} ตอน low เดิม`
      : `${pct}% above the earlier low ${fmtPx(s.level)} (${day(s.ref.t, th)}) · a close there leaves RSI ≈ ${r(s.rsiAtLevel!)}, above ${r(s.ref.rsi)} at that low`;
  }
  const lo = s.low!;
  if (s.state === "forming") return th ? `ทำ low ใหม่ ${fmtPx(lo.price)} ต่ำกว่า ${fmtPx(s.ref.price)} (${day(s.ref.t, th)}) แต่ RSI ${r(lo.rsi)} สูงกว่า ${r(s.ref.rsi)} · ยังไม่ยืนยันจุดกลับตัว`
    : `New low ${fmtPx(lo.price)} under ${fmtPx(s.ref.price)} (${day(s.ref.t, th)}) while RSI ${r(lo.rsi)} is above ${r(s.ref.rsi)} · turn not confirmed yet`;
  return th ? `low ${fmtPx(lo.price)} (${day(lo.t, th)}) ต่ำกว่า ${fmtPx(s.ref.price)} (${day(s.ref.t, th)}) แต่ RSI ${r(lo.rsi)} > ${r(s.ref.rsi)} · swing low ยืนยันแล้ว`
    : `Low ${fmtPx(lo.price)} (${day(lo.t, th)}) under ${fmtPx(s.ref.price)} (${day(s.ref.t, th)}) with RSI ${r(lo.rsi)} > ${r(s.ref.rsi)} · swing low confirmed`;
}

/** "Realtime" / "15 min delay" for a TradingView update_mode. */
export function freshText(mode: string | undefined, th: boolean): string | null {
  const f = freshness(mode);
  if (!f) return null;
  if (f.realtime) return th ? "ราคาเรียลไทม์" : "Realtime prices";
  if (f.delayMin) return th ? `ราคาดีเลย์ ${f.delayMin} นาที` : `Prices ${f.delayMin} min delayed`;
  if (f.eod) return th ? "ราคาปิดวันก่อน" : "End-of-day prices";
  return th ? "ราคาอาจดีเลย์" : "Prices may be delayed";
}

// ---------- side panel ----------

export function SignalsPanel({ tv, symbols, quotes, onSelect }: { tv: TvFn; symbols: string[]; quotes: Record<string, WatchQuote>; onSelect: (s: string) => void }) {
  const th = useLang() === "th";
  const { signals, missing, budgetOut, ack } = useWatchSignals(tv, symbols, quotes);
  const [notifyOn, setNotifyOn] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => { setNotifyOn(read<boolean>(NOTIFY_KEY) === true && typeof Notification !== "undefined" && Notification.permission === "granted"); }, []);
  const freshCount = signals.filter((s) => s.fresh).length;
  // Data freshness per market (SET is often 15 minutes late without a realtime add-on).
  const byMarket = new Map<string, string>();
  for (const s of symbols) { const m = quotes[s]?.update_mode; if (m && !byMarket.has(market(s))) byMarket.set(market(s), m); }
  const delayed = [...byMarket].map(([mk, m]) => { const t = freshText(m, th); return t && `${mk}: ${t}`; }).filter((t): t is string => !!t);

  const toggleNotify = async () => {
    if (notifyOn) { write(NOTIFY_KEY, false); setNotifyOn(false); return; }
    if (typeof Notification === "undefined") { setMsg({ ok: false, text: th ? "เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน" : "This browser has no notifications." }); return; }
    const p = await Notification.requestPermission();
    write(NOTIFY_KEY, p === "granted");
    setNotifyOn(p === "granted");
    if (p !== "granted") setMsg({ ok: false, text: th ? "ยังไม่ได้อนุญาตการแจ้งเตือนในเบราว์เซอร์" : "Notifications weren't allowed in the browser." });
  };

  // A TradingView price alert at the earlier low fires on TradingView's servers (phone app included), even when
  // this page is closed: the moment price makes the new low that starts the divergence.
  const alertAt = async (s: WatchSignal) => {
    const k = ticker(s.symbol), level = Number(s.level!.toPrecision(6));
    if (confirm !== s.symbol) { setConfirm(s.symbol); return; }
    setConfirm(null); setMsg(null);
    try {
      await tv("mcp-tv-create-alert", { symbol: s.symbol, condition: "cross_down", price: level, name: `${k} early bullish divergence: new low under ${level}`, resolution: "1D" });
      window.dispatchEvent(new Event("nova:alerts-changed"));
      setMsg({ ok: true, text: th ? `ตั้ง alert แล้ว: ${k} หลุด ${fmtPx(level)}` : `Alert set: ${k} crosses below ${fmtPx(level)}` });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };

  return (
    <section className="side-sec sig" aria-labelledby="sig-h">
      <div className="side-h"><h2 id="sig-h">{th ? "สัญญาณ Divergence" : "Divergence signals"}</h2>
        <span className="label">{freshCount ? <button type="button" className="sig-new" onClick={ack} title={th ? "รับทราบแล้ว" : "Mark as seen"}>{freshCount} {th ? "ใหม่" : "new"} ✓</button> : signals.length ? `${signals.length}` : ""}</span></div>
      <div className="sig-tools">
        <button type="button" className="chip" aria-pressed={notifyOn} onClick={toggleNotify}>{notifyOn ? "🔔 " : "🔕 "}{th ? "แจ้งเตือนบนเครื่อง" : "Desktop alerts"}</button>
        {delayed.map((t) => <span key={t} className="muted sig-fresh">{t}</span>)}
      </div>
      <ul className="sig-list">
        {!symbols.length ? <li className="note">{th ? "เพิ่มหุ้นเข้า watchlist ก่อน แล้วสัญญาณจะขึ้นที่นี่" : "Add stocks to the watchlist and their signals show here."}</li>
          : !signals.length ? <li className="note">{missing ? (th ? `กำลังโหลดกราฟรายวัน ${missing} ตัว…` : `Loading daily charts for ${missing}…`) : (th ? "ยังไม่มีหุ้นใน watchlist ที่กำลังเกิด bullish divergence" : "No watchlist stock is forming a bullish divergence.")}</li>
          : signals.map((s) => (
            <li key={s.symbol} className={s.fresh ? "fresh" : ""}>
              <button type="button" className="sig-row" onClick={() => onSelect(s.symbol)}>
                <span className="sig-t"><b>{ticker(s.symbol)}</b><span className={`stage sig-${s.state}`}>{th ? STATE_TH[s.state] : STATE_EN[s.state]}</span>
                  {s.rv != null && <span className={"num sig-rv" + (s.rv >= 1.5 ? " hi" : "")} title={th ? "วอลุ่มเทียบค่าเฉลี่ย 10 วัน" : "Volume vs its 10-day average"}>Vol {s.rv.toFixed(1)}×</span>}</span>
                <span className="sig-d">{describe(s, th)}</span>
              </button>
              {s.state === "near" && s.level != null && <button type="button" className="chip sig-alert" onClick={() => alertAt(s)}>
                {confirm === s.symbol ? (th ? `ยืนยันตั้ง alert ที่ ${fmtPx(s.level)}?` : `Confirm alert at ${fmtPx(s.level)}?`) : `🔔 ${th ? "Alert ใน TradingView เมื่อหลุด" : "TradingView alert below"} ${fmtPx(s.level)}`}</button>}
            </li>
          ))}
      </ul>
      {msg && <p className={msg.ok ? "tv-ok sig-msg" : "tv-err sig-msg"} role="status">{msg.text}</p>}
      {!!symbols.length && <p className="muted sig-foot">{th ? `ตรวจ ${symbols.length - missing} จาก ${symbols.length} ตัวใน watchlist ทุกครั้งที่ราคาอัปเดต · โหลดกราฟรายวันวันละครั้งต่อตัว` : `Checking ${symbols.length - missing} of ${symbols.length} watchlist stocks on every price update · daily charts load once a day per stock`}{budgetOut ? (th ? ` · ครบโควตาโหลดกราฟวันนี้ (${MAX_FETCH_DAY}) แล้ว เปิดหุ้นบน Desk เพื่อโหลดเพิ่ม` : ` · today's chart budget (${MAX_FETCH_DAY}) is used; open a stock on the desk to load it`) : ""}</p>}
    </section>
  );
}
