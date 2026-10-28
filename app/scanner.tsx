"use client";

import { useEffect, useRef, useState } from "react";
import { cls, fmtPct, fmtPx, market } from "./format";
import { currentModel, currentVerify, ModelSelect, VerifySelect } from "./model";
import { N } from "@/lib/scan/match";
import { sampleAnchors, TEMPLATES, type Bias } from "@/lib/scan/templates";

type Row = { id?: string; symbol: string; name: string; description?: string; sector?: string; close?: number; change?: number;
  score: number; bars: number; from: string; to: string; heightPct: number; closes: number[];
  checks?: string[]; points?: { k: number; date: string; price: number; label?: string }[];
  lines?: { from: { date: string; price: number }; to: { date: string; price: number }; role: "upper" | "lower" | "level"; label: string; extend: boolean }[];
  stage?: string; summary?: string; breakout?: number; invalidation?: number; verified?: boolean };
type Img = { mime: "image/jpeg"; data: string; preview: string };
type Result = { rows: Row[]; checked: number; note?: string; shape: number[]; label: string; pattern?: string };
/** A scanner match opened on the dashboard. */
export type PatternHit = Row & { id: string; label: string; shape: number[]; pattern: string };
/** Scans saved before rows had ids get one from the symbol and start date. */
const hitsOf = (res: Result): PatternHit[] => res.rows.map((r) => ({ ...r, id: r.id ?? `${r.symbol}@${r.from}`, label: res.label, shape: res.shape,
  pattern: res.pattern ?? TEMPLATES.find((t) => t.name === res.label)?.id ?? "image" }));

// 👍/👎 on matches, kept in this browser and sent with later scans of the same pattern so the AI learns what the user counts as one.
type Vote = { id: string; pattern: string; symbol: string; good: boolean; note: string; at: string };
const VOTES = "keranos.feedback.v1", VOTES_EVENT = "keranos:feedback", MAX_VOTES = 200;
const loadVotes = (): Vote[] => { try { const v = JSON.parse(localStorage.getItem(VOTES) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
function vote(hit: PatternHit, good: boolean | null) {
  const rest = loadVotes().filter((v) => v.id !== hit.id || v.pattern !== hit.pattern);
  const marks = (hit.points ?? []).map((p) => `${p.label || "point"} ${p.price} (${p.date})`).join(", ");
  const note = `${hit.stage ?? "stage?"}, ${hit.from} to ${hit.to}, ${hit.bars} days, height ${hit.heightPct}%; marks: ${marks}${hit.summary ? `; AI said: ${hit.summary}` : ""}`.slice(0, 600);
  const next = good == null ? rest : [{ id: hit.id, pattern: hit.pattern, symbol: hit.symbol, good, note, at: new Date().toISOString() }, ...rest].slice(0, MAX_VOTES);
  try { localStorage.setItem(VOTES, JSON.stringify(next)); } catch { /* blocked storage */ }
  window.dispatchEvent(new Event(VOTES_EVENT));
}
/** The latest 6 agreements and 6 rejections for a pattern, for the scan request. */
const feedbackFor = (pattern: string) => {
  const v = loadVotes().filter((x) => x.pattern === pattern);
  return [...v.filter((x) => x.good).slice(0, 6), ...v.filter((x) => !x.good).slice(0, 6)].map(({ symbol, good, note }) => ({ symbol, good, note }));
};

/** Thumbs up / down for one match. Pressing the same thumb again clears the vote. */
export function Thumbs({ hit }: { hit: PatternHit }) {
  const [mine, setMine] = useState<boolean | null>(null);
  useEffect(() => {
    const sync = () => setMine(loadVotes().find((v) => v.id === hit.id && v.pattern === hit.pattern)?.good ?? null);
    sync();
    window.addEventListener(VOTES_EVENT, sync);
    return () => window.removeEventListener(VOTES_EVENT, sync);
  }, [hit.id, hit.pattern]);
  return (
    <span className="thumbs" role="group" aria-label="Is this the pattern?">
      <button type="button" aria-pressed={mine === true} title="Correct: show the AI more like this" onClick={() => vote(hit, mine === true ? null : true)}>👍</button>
      <button type="button" aria-pressed={mine === false} title="Wrong: the AI will avoid charts like this" onClick={() => vote(hit, mine === false ? null : false)}>👎</button>
    </span>
  );
}
type Saved = Result & { id: string; at: string; universe: string; themes: string[]; length: string };

const UNIVERSES: [string, string][] = [["SP500", "S&P 500"], ["NDX", "Nasdaq 100"], ["SET50", "SET50"], ["SET100", "SET100"]];
const THEMES: [string, string][] = [["TECH", "Tech"], ["MEDICAL", "Medical"], ["FINANCE", "Finance"], ["ENERGY", "Energy"], ["FINTECH", "Fintech"]];
const LENGTHS: [string, string, string][] = [["short", "Short", "1–3 months"], ["medium", "Medium", "3–6 months"], ["long", "Long", "6–12 months"]];
// Finished scans are kept in this browser so they survive reloads and tab switches.
const STORE = "keranos.scans.v1";
const MAX_SAVED = 30;
function loadSaved(): Saved[] {
  try { const v = JSON.parse(localStorage.getItem(STORE) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function storeSaved(list: Saved[]) {
  try { localStorage.setItem(STORE, JSON.stringify(list)); } catch { /* storage full or blocked: keep in memory only */ }
}
const uniLabel = (id: string) => UNIVERSES.find((u) => u[0] === id)?.[1] ?? id;
const themeLabel = (ids: string[]) => (ids.length ? ids.map((t) => THEMES.find((x) => x[0] === t)?.[1] ?? t).join(", ") : "All themes");
const fmtWhen = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function downloadCsv(s: Saved) {
  const esc = (v: unknown) => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const head = ["symbol", "name", "description", "sector", "ai_confidence_pct", "stage", "days", "from", "to", "height_pct", "breakout", "invalidation", "close", "change_pct", "summary"];
  const lines = s.rows.map((r) => [r.symbol, r.name, r.description, r.sector, r.score, r.stage, r.bars, r.from, r.to, r.heightPct, r.breakout, r.invalidation, r.close, r.change?.toFixed(2), r.summary].map(esc).join(","));
  const blob = new Blob(["\ufeff" + [head.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `scan-${s.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${s.universe}-${s.at.slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const BIAS_CLS: Record<Bias, string> = { bullish: "up", bearish: "down", neutral: "muted" };
const STAGE: Record<string, string> = { forming: "forming", complete: "complete", breakout: "breakout", failed: "failed" };

/** Downsize an image in the browser so the upload stays small. */
async function readImage(file: File): Promise<Img> {
  if (!file.type.startsWith("image/")) throw new Error("Pick an image file (PNG, JPG or WebP).");
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * k); canvas.height = Math.round(bmp.height * k);
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#fff"; g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", 0.85);
  return { mime: "image/jpeg", data: url.slice(url.indexOf(",") + 1), preview: url };
}

/** Rows from a page, replacing the same matches already shown while the page streamed. */
const mergeRows = (have: Row[], add: Row[]) => [...have.filter((x) => !add.some((r) => (r.id ?? r.symbol) === (x.id ?? x.symbol))), ...add];

/** One page of a scan, streamed. Resolves with the page's final results, or null when the server reported an error. */
async function scanPage(body: object, signal: AbortSignal, on: (ev: any) => void): Promise<{ rows: Row[]; checked: number; note?: string; total: number; next?: number } | null> {
  const res = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, signal, body: JSON.stringify(body) });
  if (res.status === 401) { location.href = "/login"; return null; }
  if (res.status === 409) {
    const j = await res.json().catch(() => ({}));
    window.dispatchEvent(new CustomEvent("nova:tv-connect", { detail: j.error }));
    throw new Error(j.error || "Connect TradingView first.");
  }
  if (!res.ok || !res.body) throw new Error("The scanner is unavailable right now.");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", out = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      const ev = JSON.parse(part.slice(6));
      if (ev.type === "results") out = ev;
      else on(ev);
    }
  }
  return out;
}

export default function Scanner({ onOpen, hidden }: { onOpen: (hit: PatternHit, same: PatternHit[]) => void; hidden?: boolean }) {
  const [pattern, setPattern] = useState<string>("double_bottom");
  const [img, setImg] = useState<Img | null>(null);
  const [universe, setUniverse] = useState("SET100");
  const [themes, setThemes] = useState<string[]>([]);
  const [length, setLength] = useState("medium");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; done?: number; total?: number } | null>(null);
  const [result, setResult] = useState<Saved | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  // Reopen the latest scan after a reload.
  useEffect(() => { const list = loadSaved(); setSaved(list); setResult((r) => r ?? list[0] ?? null); }, []);
  const save = (s: Saved) => setSaved((list) => { const next = [s, ...list.filter((x) => x.id !== s.id)].slice(0, MAX_SAVED); storeSaved(next); return next; });
  const remove = (id: string) => setSaved((list) => { const next = list.filter((x) => x.id !== id); storeSaved(next); return next; });
  const [error, setError] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const fileEl = useRef<HTMLInputElement>(null);

  const usingImage = pattern === "image";
  const toggleTheme = (t: string) => setThemes((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]));

  async function pick(file?: File | null) {
    if (!file) return;
    try { setImg(await readImage(file)); setPattern("image"); setError(null); }
    catch (e) { setError((e as Error).message); }
  }

  async function scan() {
    if (busy) return;
    if (usingImage && !img) { setError("Add a reference image first."); return; }
    setBusy(true); setError(null); setResult(null); setStatus({ text: "Starting" });
    const t = TEMPLATES.find((x) => x.id === pattern);
    const shape = t ? sampleAnchors(t.anchors, N) : [];
    const label = t?.name ?? "Your image pattern";
    ctl.current = new AbortController();
    const signal = ctl.current.signal;
    const body = { ai: currentModel(), verify: currentVerify(), feedback: feedbackFor(usingImage ? "image" : pattern), universe, themes, length, pattern: usingImage ? { image: { mime: img!.mime, data: img!.data } } : { template: pattern } };
    // One saved scan grows as matches arrive, page after page.
    const s: Saved = { id: Date.now().toString(36), at: new Date().toISOString(), universe, themes, length, rows: [], checked: 0, shape, label, pattern: usingImage ? "image" : pattern };
    const notes: string[] = [];
    const show = () => setResult({ ...s, rows: [...s.rows].sort((x, y) => y.score - x.score), note: notes.join(" ") || undefined });
    try {
      for (let offset: number | undefined = 0; offset != null;) {
        const started = Date.now();
        const page = await scanPage({ ...body, offset }, signal, (ev) => {
          if (ev.type === "status") setStatus(ev);
          else if (ev.type === "match") { s.rows.push(...ev.rows.filter((r: Row) => !s.rows.some((x) => (x.id ?? x.symbol) === (r.id ?? r.symbol)))); show(); }
          else if (ev.type === "error") setError(ev.message);
        });
        if (!page) break;
        s.checked += page.checked;
        if (page.note) notes.push(page.note);
        s.rows = mergeRows(s.rows, page.rows);
        show(); save({ ...s, note: notes.join(" ") || undefined });
        offset = page.next;
        // TradingView allows about 100 calls a minute, so pages start at least a minute apart.
        if (offset != null) {
          const left = 62_000 - (Date.now() - started);
          for (let t = left; t > 0 && !signal.aborted; t -= 1000) {
            setStatus({ text: `Checked ${offset} of ${page.total} stocks · next ${Math.ceil(t / 1000)} s (TradingView's per-minute limit)`, done: offset, total: page.total });
            await new Promise((ok) => setTimeout(ok, Math.min(1000, t)));
          }
          if (signal.aborted) throw new DOMException("Stopped", "AbortError");
        }
      }
    } catch (e) {
      setError((e as Error).name === "AbortError" ? (s.rows.length || s.checked ? "Stopped. The matches so far are saved." : "Stopped.") : (e as Error).message);
      if (s.checked || s.rows.length) save({ ...s, note: notes.join(" ") || undefined });
    } finally {
      setBusy(false); setStatus(null);
    }
  }

  return (
    <section className="pane scanner" aria-labelledby="scan-h" hidden={hidden}
      onPaste={(e) => { const f = Array.from(e.clipboardData.files).find((x) => x.type.startsWith("image/")); if (f) pick(f); }}>
      <div className="pane-h"><h2 id="scan-h">Find stocks by chart pattern</h2><span className="label">Daily charts · read by AI</span></div>

      <div className="scan-sec">
        <div className="label">Pattern</div>
        <div className="tpl-grid" role="group" aria-label="Pattern">
          {TEMPLATES.map((t) => (
            <button key={t.id} type="button" className="tpl" aria-pressed={pattern === t.id} onClick={() => setPattern(t.id)}>
              <Spark points={sampleAnchors(t.anchors, 24)} bias={t.bias} />
              <span className="tpl-n">{t.name}</span>
              <span className="tpl-s">{t.thai} · <span className={BIAS_CLS[t.bias]}>{t.bias}</span></span>
            </button>
          ))}
          <div className={"tpl tpl-img" + (usingImage ? " on" : "")}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files[0]); }}>
            {img ? (
              <button type="button" className="tpl-img-pick" aria-pressed={usingImage} onClick={() => setPattern("image")}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.preview} alt="Your reference pattern" />
                <span className="tpl-n">Your image</span>
              </button>
            ) : (
              <button type="button" className="tpl-img-pick" onClick={() => fileEl.current?.click()}>
                <span className="tpl-plus" aria-hidden="true">+</span>
                <span className="tpl-n">Use your own image</span>
                <span className="tpl-s">Upload, drop or paste a chart</span>
              </button>
            )}
            {img && <button type="button" className="linkish" onClick={() => fileEl.current?.click()}>Change image</button>}
            <input ref={fileEl} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
        </div>
      </div>

      <div className="scan-opts">
        <div className="scan-sec">
          <div className="label">Market</div>
          <div className="chips" role="group" aria-label="Market">
            {UNIVERSES.map(([id, l]) => <button key={id} type="button" className="chip" aria-pressed={universe === id} onClick={() => setUniverse(id)}>{l}</button>)}
          </div>
        </div>
        <div className="scan-sec">
          <div className="label">Theme</div>
          <div className="chips" role="group" aria-label="Theme">
            <button type="button" className="chip" aria-pressed={!themes.length} onClick={() => setThemes([])}>All</button>
            {THEMES.map(([id, l]) => <button key={id} type="button" className="chip" aria-pressed={themes.includes(id)} onClick={() => toggleTheme(id)}>{l}</button>)}
          </div>
        </div>
        <div className="scan-sec">
          <div className="label">Pattern length</div>
          <div className="chips" role="group" aria-label="Pattern length">
            {LENGTHS.map(([id, l, hint]) => <button key={id} type="button" className="chip" title={hint} aria-pressed={length === id} onClick={() => setLength(id)}>{l} <span className="muted">{hint}</span></button>)}
          </div>
        </div>
      </div>

      <div className="scan-run">
        {busy ? <button className="btn" type="button" onClick={() => ctl.current?.abort()}>Stop</button>
          : <button className="btn primary" type="button" onClick={scan}>Scan</button>}
        {!busy && <ModelSelect className="scan-model" />}
        {!busy && <VerifySelect className="scan-model" />}
        {status && (
          <div className="scan-status" role="status">
            <span>{status.text}</span>
            {status.total ? <progress max={status.total} value={status.done ?? 0} /> : null}
          </div>
        )}
        {!busy && <span className="muted" style={{ fontSize: 12 }}>AI reads each chart and judges it against {usingImage ? "your image" : "the pattern's textbook rules"}</span>}
      </div>

      {error && <div className="note warn">{error}</div>}
      {result && (
        <div className="scan-results">
          <div className="pane-h sub">
            <div><h2>{result.rows.length ? `${result.rows.length} matches · ${result.label}` : `No close matches · ${result.label}`}</h2>
              <div className="muted" style={{ fontSize: 12 }}>{uniLabel(result.universe)} · {themeLabel(result.themes)} · {result.checked} charts checked · saved {fmtWhen(result.at)}</div></div>
            {result.rows.length > 0 && <button type="button" className="btn" onClick={() => downloadCsv(result)}>Download CSV</button>}
          </div>
          {result.note && <div className="note">{result.note}</div>}
          {!result.rows.length && <div className="note">{busy ? "No matches yet. They appear here as the AI reads each batch of charts." : <>The AI wasn&apos;t at least 70% sure about any chart. Try another pattern length, market or theme.</>}</div>}
          <ul className="hits">
            {hitsOf(result).map((r, _i, all) => {
              const same = all.filter((x) => x.symbol === r.symbol);
              return (
              <li key={r.id} className="hit">
                <button type="button" onClick={() => onOpen(r, same)} aria-label={`Open ${r.symbol}, AI ${r.score}% sure`}>
                  <span className="hit-t"><b>{r.name}</b>{same.length > 1 && <span className="stage">{same.indexOf(r) + 1} of {same.length}</span>}<span className="mkt">{market(r.symbol)}</span>{r.stage && <span className="stage">{STAGE[r.stage] ?? r.stage}</span>}{r.verified === true && <span className="stage ok" title="A second AI pass looked at the chart picture and confirmed it">✓ checked</span>}{r.verified === false && <span className="stage" title="The second check couldn't run, so this is the first read only">unchecked</span>}<span className="hit-d">{r.description}</span></span>
                  <span className="hit-score num">{r.score}%</span>
                  <MatchChart closes={r.closes} shape={result.shape} points={r.points} bars={r.bars} />
                  <span className="hit-meta">
                    <span className="num">{fmtPx(r.close)} <span className={cls(r.change)}>{fmtPct(r.change)}</span></span>
                    <span>{r.bars} days · {fmtDay(r.from)} – {fmtDay(r.to)} · height {r.heightPct}%</span>
                    {r.sector && <span className="muted">{r.sector}</span>}
                    {r.summary && <span className="hit-ai">{r.summary}</span>}
                    {!!r.checks?.length && <span className="hit-checks">{r.checks.map((c) => <span key={c}>✓ {c}</span>)}</span>}
                    {(r.breakout != null || r.invalidation != null) && <span className="hit-levels num">
                      {r.breakout != null && <span>Breakout level <b>{fmtPx(r.breakout)}</b></span>}
                      {r.invalidation != null && <span className="muted">Invalid past {fmtPx(r.invalidation)}</span>}</span>}
                  </span>
                </button>
                <Thumbs hit={r} />
              </li>
            ); })}
          </ul>
          <p className="note">The % is the AI&apos;s confidence after reading the daily bars. It is a starting point for your own chart reading, not a confirmed setup or advice.</p>
        </div>
      )}
      <div className="scan-saved">
        <div className="pane-h sub"><h2>Saved scans</h2><span className="label">{saved.length ? `${saved.length} in this browser` : ""}</span></div>
        {!saved.length ? <div className="note">Every finished scan is saved here automatically.</div> : (
          <ul className="saved">
            {saved.map((s) => (
              <li key={s.id} aria-current={result?.id === s.id}>
                <button type="button" className="saved-open" onClick={() => { setResult(s); setError(null); }}>
                  <b>{s.label}</b> <span className="muted">· {uniLabel(s.universe)} · {themeLabel(s.themes)}</span>
                  <span className="saved-meta">{fmtWhen(s.at)} · {s.rows.length} matches{s.rows[0] ? ` · top ${s.rows.slice(0, 3).map((r) => r.name).join(", ")}` : ""}</span>
                </button>
                <button type="button" className="saved-x" aria-label={`Delete saved scan from ${fmtWhen(s.at)}`} onClick={() => { remove(s.id); if (result?.id === s.id) setResult(null); }}>×</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

const fmtDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function Spark({ points, bias }: { points: number[]; bias: Bias }) {
  const W = 64, H = 28, P = 3;
  const pts = points.map((y, i) => `${(P + (i / (points.length - 1)) * (W - 2 * P)).toFixed(1)},${(P + (1 - y) * (H - 2 * P)).toFixed(1)}`).join(" ");
  const col = bias === "bullish" ? "var(--up)" : bias === "bearish" ? "var(--down)" : "var(--muted)";
  return <svg className="spark" viewBox={`0 0 ${W} ${H}`} aria-hidden="true"><polyline points={pts} fill="none" stroke={col} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

/** The matched price window with the pattern drawn over it, dashed: through the real turning points when known. */
function MatchChart({ closes, shape, points, bars }: { closes: number[]; shape: number[]; points?: Row["points"]; bars: number }) {
  const W = 220, H = 64, P = 4;
  const lo = Math.min(...closes), hi = Math.max(...closes), d = hi - lo || 1;
  const line = (ys: number[]) => ys.map((y, i) => `${(P + (i / (ys.length - 1)) * (W - 2 * P)).toFixed(1)},${(P + (1 - y) * (H - 2 * P)).toFixed(1)}`).join(" ");
  return (
    <svg className="hit-chart" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {points?.length ? (
        <polyline points={points.map((p) => `${(P + (p.k / Math.max(1, bars - 1)) * (W - 2 * P)).toFixed(1)},${(P + (1 - (p.price - lo) / d) * (H - 2 * P)).toFixed(1)}`).join(" ")}
          fill="none" stroke="var(--accent-fill)" strokeWidth="1.5" strokeDasharray="4 3" opacity=".9" />
      ) : <polyline points={line(shape)} fill="none" stroke="var(--accent-fill)" strokeWidth="1.5" strokeDasharray="4 3" opacity=".9" />}
      <polyline points={line(closes.map((c) => (c - lo) / d))} fill="none" stroke="var(--ink)" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
