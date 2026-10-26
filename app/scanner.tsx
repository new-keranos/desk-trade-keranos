"use client";

import { useRef, useState } from "react";
import { cls, fmtPct, fmtPx, market } from "./format";
import { N } from "@/lib/scan/match";
import { sampleAnchors, TEMPLATES, type Bias } from "@/lib/scan/templates";

type Row = { symbol: string; name: string; description?: string; sector?: string; close?: number; change?: number;
  score: number; bars: number; from: string; to: string; heightPct: number; closes: number[] };
type Img = { mime: "image/jpeg"; data: string; preview: string };

const UNIVERSES: [string, string][] = [["SP500", "S&P 500"], ["NDX", "Nasdaq 100"], ["SET50", "SET50"], ["SET100", "SET100"]];
const THEMES: [string, string][] = [["TECH", "Tech"], ["MEDICAL", "Medical"], ["FINANCE", "Finance"], ["ENERGY", "Energy"], ["FINTECH", "Fintech"]];
const LENGTHS: [string, string, string][] = [["short", "Short", "1–3 months"], ["medium", "Medium", "3–6 months"], ["long", "Long", "6–12 months"]];
const BIAS_CLS: Record<Bias, string> = { bullish: "up", bearish: "down", neutral: "muted" };

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

export default function Scanner({ onOpen }: { onOpen: (symbol: string) => void }) {
  const [pattern, setPattern] = useState<string>("double_bottom");
  const [img, setImg] = useState<Img | null>(null);
  const [universe, setUniverse] = useState("SET100");
  const [themes, setThemes] = useState<string[]>([]);
  const [length, setLength] = useState("medium");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; done?: number; total?: number } | null>(null);
  const [traced, setTraced] = useState<{ name: string; bias: Bias; points: number[] } | null>(null);
  const [result, setResult] = useState<{ rows: Row[]; checked: number; note?: string; shape: number[]; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const fileEl = useRef<HTMLInputElement>(null);

  const usingImage = pattern === "image";
  const toggleTheme = (t: string) => setThemes((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]));

  async function pick(file?: File | null) {
    if (!file) return;
    try { setImg(await readImage(file)); setPattern("image"); setTraced(null); setError(null); }
    catch (e) { setError((e as Error).message); }
  }

  async function scan() {
    if (busy) return;
    if (usingImage && !img) { setError("Add a reference image first."); return; }
    setBusy(true); setError(null); setResult(null); setStatus({ text: "Starting" });
    if (usingImage) setTraced(null);
    const t = TEMPLATES.find((x) => x.id === pattern);
    let shape = t ? sampleAnchors(t.anchors, N) : [];
    let label = t?.name ?? "Your pattern";
    ctl.current = new AbortController();
    try {
      const res = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.current.signal,
        body: JSON.stringify({ universe, themes, length, pattern: usingImage ? { image: { mime: img!.mime, data: img!.data } } : { template: pattern } }) });
      if (res.status === 401) { location.href = "/login"; return; }
      if (res.status === 409) {
        const j = await res.json().catch(() => ({}));
        window.dispatchEvent(new CustomEvent("nova:tv-connect", { detail: j.error }));
        throw new Error(j.error || "Connect TradingView first.");
      }
      if (!res.ok || !res.body) throw new Error("The scanner is unavailable right now.");
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
          if (ev.type === "status") setStatus(ev);
          else if (ev.type === "shape") { setTraced(ev); shape = ev.points; label = ev.name; }
          else if (ev.type === "results") setResult({ rows: ev.rows, checked: ev.checked, note: ev.note, shape, label });
          else if (ev.type === "error") setError(ev.message);
        }
      }
    } catch (e) {
      setError((e as Error).name === "AbortError" ? "Stopped." : (e as Error).message);
    } finally {
      setBusy(false); setStatus(null);
    }
  }

  return (
    <section className="pane scanner" aria-labelledby="scan-h"
      onPaste={(e) => { const f = Array.from(e.clipboardData.files).find((x) => x.type.startsWith("image/")); if (f) pick(f); }}>
      <div className="pane-h"><h2 id="scan-h">Pattern scanner</h2><span className="label">Daily charts</span></div>

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
        {status && (
          <div className="scan-status" role="status">
            <span>{status.text}</span>
            {status.total ? <progress max={status.total} value={status.done ?? 0} /> : null}
          </div>
        )}
        {traced && (
          <div className="scan-traced">
            <Spark points={traced.points} bias={traced.bias} />
            <span>Read your image as <b>{traced.name}</b> <span className={BIAS_CLS[traced.bias]}>({traced.bias})</span></span>
          </div>
        )}
      </div>

      {error && <div className="note warn">{error}</div>}
      {result && (
        <div className="scan-results">
          <div className="pane-h sub"><h2>{result.rows.length ? `${result.rows.length} matches · ${result.label}` : "No close matches"}</h2><span className="label">{result.checked} charts checked</span></div>
          {result.note && <div className="note">{result.note}</div>}
          {!result.rows.length && <div className="note">Nothing scored 60% or more. Try another pattern length, market or theme.</div>}
          <ul className="hits">
            {result.rows.map((r) => (
              <li key={r.symbol}>
                <button type="button" onClick={() => onOpen(r.symbol)} aria-label={`Open ${r.symbol}, ${r.score}% match`}>
                  <span className="hit-t"><b>{r.name}</b><span className="mkt">{market(r.symbol)}</span><span className="hit-d">{r.description}</span></span>
                  <span className="hit-score num">{r.score}%</span>
                  <MatchChart closes={r.closes} shape={result.shape} />
                  <span className="hit-meta">
                    <span className="num">{fmtPx(r.close)} <span className={cls(r.change)}>{fmtPct(r.change)}</span></span>
                    <span>{r.bars} days · {fmtDay(r.from)} – {fmtDay(r.to)} · height {r.heightPct}%</span>
                    {r.sector && <span className="muted">{r.sector}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="note">Shape match on daily closes. A match is a starting point for your own chart reading, not a confirmed setup or advice.</p>
        </div>
      )}
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

/** The matched price window with the pattern drawn over it, dashed. */
function MatchChart({ closes, shape }: { closes: number[]; shape: number[] }) {
  const W = 220, H = 64, P = 4;
  const lo = Math.min(...closes), hi = Math.max(...closes), d = hi - lo || 1;
  const line = (ys: number[]) => ys.map((y, i) => `${(P + (i / (ys.length - 1)) * (W - 2 * P)).toFixed(1)},${(P + (1 - y) * (H - 2 * P)).toFixed(1)}`).join(" ");
  return (
    <svg className="hit-chart" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <polyline points={line(shape)} fill="none" stroke="var(--accent-fill)" strokeWidth="1.5" strokeDasharray="4 3" opacity=".9" />
      <polyline points={line(closes.map((c) => (c - lo) / d))} fill="none" stroke="var(--ink)" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
