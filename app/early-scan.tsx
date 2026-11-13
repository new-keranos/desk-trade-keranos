"use client";

// Early signals: when the user presses Scan, list liquid stocks with heavy volume where a bullish RSI divergence is
// forming (new low, RSI not following) or about to (sliding toward the old low, RSI firm): before price turns up,
// not after. The user picks which ones go into the watchlist; the watchlist signals panel (./watch.tsx) then says
// when a divergence actually starts on them. Nothing runs on a schedule.

import { useEffect, useMemo, useState } from "react";
import type { EarlyRow, EarlyStage } from "@/lib/scan/early";
import { cls, fmtBig, fmtPct, fmtPx } from "./format";
import { useLang } from "./lang";
import { tr } from "@/lib/i18n";
import { askRelogin, blockTv, blockedText, tvBlocked } from "./tvblock";
import { freshText, type TvFn } from "./watch";

type Result = { rows: EarlyRow[]; total: number; at: string; universe: string };
type Uni = { id: string; label: string; ccy: "THB" | "USD" };
const UNIS: Uni[] = [
  { id: "SET_LARGE", label: "SET ฿5B+", ccy: "THB" }, { id: "SET100", label: "SET100", ccy: "THB" },
  { id: "US_LARGE", label: "US $10B+", ccy: "USD" }, { id: "SP500", label: "S&P 500", ccy: "USD" }, { id: "NDX", label: "Nasdaq 100", ccy: "USD" },
];
/** Least average money traded a day (30 days), per currency. */
const VALUE_STEPS: Record<Uni["ccy"], number[]> = { THB: [0, 50e6, 100e6, 300e6, 1e9], USD: [0, 20e6, 50e6, 100e6, 500e6] };
const VALUE_DEFAULT: Record<Uni["ccy"], number> = { THB: 100e6, USD: 50e6 };
const RV_STEPS = [0, 1.2, 1.5, 2];
const SAVE = "keranos.early.v1", PREFS = "keranos.earlyprefs.v1";

const read = <T,>(k: string): T | null => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } };
const ago = (iso: string, th: boolean) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return th ? "เมื่อสักครู่" : "just now";
  if (m < 60) return th ? `${m} นาทีก่อน` : `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 36 ? (th ? `${h} ชม.ก่อน` : `${h} h ago`) : new Date(iso).toLocaleDateString(th ? "th-TH" : "en-GB", { day: "numeric", month: "short" });
};

export default function EarlyScan({ hidden, tv, inWatchlist, targetName, targetId, onWatchlistChanged, onOpen }: {
  hidden: boolean; tv: TvFn; inWatchlist: Set<string>; targetName?: string; targetId: string | null; onWatchlistChanged: () => void; onOpen: (symbol: string) => void }) {
  const th = useLang() === "th";
  const [uni, setUni] = useState("SET_LARGE");
  const [minValue, setMinValue] = useState<Record<string, number>>(VALUE_DEFAULT);
  const [minRv, setMinRv] = useState(1.5);
  const [stage, setStage] = useState<EarlyStage | "all">("all");
  const [results, setResults] = useState<Record<string, Result>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setResults(read<Record<string, Result>>(SAVE) ?? {});
    const p = read<{ uni?: string; minValue?: Record<string, number>; minRv?: number }>(PREFS);
    if (p?.uni && UNIS.some((u) => u.id === p.uni)) setUni(p.uni);
    if (p?.minValue) setMinValue({ ...VALUE_DEFAULT, ...p.minValue });
    if (p?.minRv != null) setMinRv(p.minRv);
  }, []);
  const savePrefs = (next: Partial<{ uni: string; minValue: Record<string, number>; minRv: number }>) => write(PREFS, { uni, minValue, minRv, ...next });

  const u = UNIS.find((x) => x.id === uni)!;
  const result = results[uni];
  const floor = minValue[u.ccy] ?? 0;
  const view = useMemo(() => (result?.rows ?? []).filter((r) => (r.value ?? 0) >= floor && (r.rv ?? 0) >= minRv && (stage === "all" || r.stage === stage)), [result, floor, minRv, stage]);
  const mode = result?.rows.find((r) => r.mode)?.mode;

  const run = async () => {
    const until = tvBlocked();
    if (until) { setError(blockedText(until)); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/early", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ universe: uni }) });
      const j = await res.json().catch(() => ({}));
      if (res.status === 429 && j.quota) blockTv(j.until);
      if (res.status === 503 && j.relogin) askRelogin(j.error);
      if (res.status === 409 && j.connect) window.dispatchEvent(new CustomEvent("nova:tv-connect", { detail: j.error }));
      if (!res.ok) throw new Error(j.error || `Scan failed (${res.status})`);
      const next = { ...results, [uni]: j as Result };
      setResults(next); write(SAVE, next);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const add = async (symbol: string) => {
    if (!targetId) { setMsg({ ok: false, text: th ? "ไม่พบ watchlist แบบตั้งชื่อใน TradingView ให้สร้างสักอันก่อน" : "No named TradingView watchlist found. Create one first." }); return; }
    setAdding(symbol); setMsg(null);
    try {
      await tv("mcp-watchlist-add-to-watchlist", { watchlist_id: targetId, symbols: [symbol] });
      onWatchlistChanged();
      setMsg({ ok: true, text: th ? `เพิ่ม ${symbol.split(":")[1]} เข้า “${targetName ?? "watchlist"}” แล้ว ระบบจะเฝ้าสัญญาณให้` : `Added ${symbol.split(":")[1]} to “${targetName ?? "watchlist"}”; its signals are watched now.` });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    setAdding(null);
  };

  const STAGE: Record<EarlyStage, string> = th ? { forming: "กำลังก่อตัว", near: "ใกล้เกิด" } : { forming: "Forming", near: "Near" };
  const valLabel = (v: number) => (v ? `${u.ccy === "THB" ? "฿" : "$"}${fmtBig(v)}+` : th ? "ทั้งหมด" : "Any");
  const fresh = freshText(mode, th);

  return (
    <section className="pane daily" hidden={hidden} aria-labelledby="early-h">
      <div className="pane-h">
        <div><h2 id="early-h">{th ? "สัญญาณก่อนขึ้น · Bullish divergence ช่วงต้น" : "Early signals · bullish divergence before the turn"}</h2>
          <div className="muted" style={{ fontSize: 12 }}>{th
            ? "หาหุ้นสภาพคล่องสูง วอลุ่มเข้า ที่ราคายังอยู่ที่ low หรือกำลังลงไปหา low เดิม แต่ RSI ไม่ลงตาม จับได้ก่อนราคาเด้ง ไม่ใช่หลังวิ่งไปแล้ว เลือกตัวที่ชอบเข้า watchlist แล้วระบบจะแจ้งเมื่อสัญญาณเกิดจริง คุณจับจังหวะเข้าเอง"
            : "Liquid stocks on heavy volume still at, or sliding toward, their low while RSI doesn't follow: caught before the bounce, not after the run. Pick the ones you like into the watchlist; you're told when the signal actually starts and time the entry yourself."}</div></div>
      </div>
      <div className="scan-sec">
        <div className="flt-row"><span className="flt-l">{th ? "ตลาด" : "Market"}</span><span className="chips">
          {UNIS.map((x) => <button key={x.id} type="button" className="chip" aria-pressed={uni === x.id} onClick={() => { setUni(x.id); savePrefs({ uni: x.id }); }}>{x.label}</button>)}</span></div>
        <div className="flt-row"><span className="flt-l">{th ? "มูลค่าซื้อขายเฉลี่ย/วัน" : "Avg value traded/day"}</span><span className="chips">
          {VALUE_STEPS[u.ccy].map((v) => <button key={v} type="button" className="chip" aria-pressed={floor === v} onClick={() => { const m = { ...minValue, [u.ccy]: v }; setMinValue(m); savePrefs({ minValue: m }); }}>{valLabel(v)}</button>)}</span></div>
        <div className="flt-row"><span className="flt-l">{th ? "วอลุ่มเทียบเฉลี่ย 10 วัน" : "Relative volume"}</span><span className="chips">
          {RV_STEPS.map((v) => <button key={v} type="button" className="chip" aria-pressed={minRv === v} onClick={() => { setMinRv(v); savePrefs({ minRv: v }); }}>{v ? `≥ ${v}×` : th ? "ทั้งหมด" : "Any"}</button>)}</span></div>
        <div className="flt-row"><span className="flt-l">{th ? "ระยะ" : "Stage"}</span><span className="chips">
          {(["all", "forming", "near"] as const).map((s) => <button key={s} type="button" className="chip" aria-pressed={stage === s} onClick={() => setStage(s)}>{s === "all" ? (th ? "ทั้งหมด" : "All") : STAGE[s]}</button>)}</span></div>
      </div>
      <div className="scan-run">
        <button type="button" className="btn primary" onClick={run} disabled={busy}>{busy ? (th ? "กำลังสแกน…" : "Scanning…") : (th ? "สแกน" : "Scan")}</button>
        <span className="muted" style={{ fontSize: 12 }}>{th ? "อ่านทั้งตลาดจาก screener 1–2 ครั้ง ไม่ดึงกราฟรายตัว ไม่ใช้ AI" : "Reads the whole market in 1–2 screener calls: no chart calls, no AI"}</span>
      </div>
      {error && <div className="note warn">{error}</div>}
      {msg && <div className={msg.ok ? "note" : "note warn"} role="status">{msg.text}</div>}
      {result && (
        <div className="scan-results">
          <div className="pane-h sub"><div>
            <h2>{th ? `${view.length} ตัวผ่านเกณฑ์` : `${view.length} pass`}</h2>
            <div className="muted" style={{ fontSize: 12 }}>
              {th ? `${result.rows.length} setup จาก ${result.total} หุ้นใน ${u.label} · สแกน ${ago(result.at, th)}` : `${result.rows.length} setups among ${result.total} stocks in ${u.label} · scanned ${ago(result.at, th)}`}
              {fresh && <> · <b className={mode === "streaming" ? "" : "warn-t"}>{fresh}</b></>}
            </div></div></div>
          {!view.length && <div className="note">{result.rows.length
            ? (th ? "ไม่มีตัวที่ผ่านเกณฑ์มูลค่า/วอลุ่มนี้ ลองลดเกณฑ์วอลุ่มหรือมูลค่าซื้อขาย" : "None pass these value/volume limits. Try lower ones.")
            : (th ? "ตอนนี้ไม่มีหุ้นที่เข้าเงื่อนไข divergence ในตลาดนี้" : "No stock in this market fits the divergence setup right now.")}</div>}
          <ul className="hits daily-hits">
            {view.map((r) => {
              const has = inWatchlist.has(r.symbol);
              return (
                <li key={r.symbol} className="daily-hit">
                  <button type="button" className="daily-open" onClick={() => onOpen(r.symbol)} aria-label={`${th ? "เปิดกราฟ" : "Open chart"} ${r.name}`}>
                    <span className="hit-t"><b>{r.name}</b><span className={`stage sig-${r.stage}`}>{STAGE[r.stage]}</span><span className="hit-d">{r.description}</span></span>
                    <span className="hit-score num" title={th ? "คะแนน setup" : "Setup score"}>{r.score}</span>
                    <span className="hit-meta">
                      <span className="num">{fmtPx(r.close)} <span className={cls(r.change)}>{fmtPct(r.change)}</span></span>
                      <span className="num">RSI {r.rsi1 != null ? `${Math.round(r.rsi1)} → ` : ""}{Math.round(r.rsi)} · <span className={(r.rv ?? 0) >= 1.5 ? "sig-rv hi" : ""}>Vol {r.rv?.toFixed(1) ?? "—"}×</span> · {th ? "มูลค่า/วัน" : "value/day"} {r.value ? fmtBig(r.value) : "—"} · {th ? "เหนือ low 3 เดือน" : "above 3M low"} {r.fromLow}%</span>
                      {r.sector && <span className="muted">{r.sector}</span>}
                      <span className="hit-checks">{r.checks.map((c) => <span key={c}>✓ {tr(c, th ? "th" : "en")}</span>)}</span>
                    </span>
                  </button>
                  <button type="button" className="btn daily-add" disabled={has || adding === r.symbol} onClick={() => add(r.symbol)}>
                    {has ? (th ? "✓ อยู่ใน Watchlist" : "✓ In watchlist") : adding === r.symbol ? "…" : (th ? "☆ เพิ่มเข้า Watchlist" : "☆ Add to watchlist")}</button>
                </li>
              );
            })}
          </ul>
          <div className="note">{th
            ? "Screener ให้ค่า RSI วันนี้แต่ไม่มี RSI ณ low เดิม รายการนี้จึงเป็น shortlist: เปิดกราฟเพื่อดูเส้น divergence จริง หุ้นที่เพิ่มเข้า watchlist จะถูกตรวจจากกราฟรายวันและแจ้งในแผง “สัญญาณ Divergence” เมื่อกำลังก่อตัวหรือยืนยัน"
            : "The screener has today's RSI but not the RSI at the earlier low, so this is a shortlist: open a chart to see the actual divergence. Stocks you add to the watchlist are checked on their daily chart and flagged in the “Divergence signals” panel when one forms or is confirmed."}</div>
        </div>
      )}
    </section>
  );
}
