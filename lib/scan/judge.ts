import "server-only";
import { z } from "zod";
import type { ModelChoice } from "../nova/config";
import { askJson, type RefImage } from "./llm";
import type { Length } from "./match";
import type { Template } from "./templates";

// The AI reads each stock's daily bars and decides whether the chosen pattern is there.
// No shape maths: the model looks at the numbers the way an analyst reads a chart, and marks the
// turning points and lines it used, so the chart can show its reasoning.

export type Bars = { t: number[]; h: number[]; l: number[]; c: number[] };
export type Stock = { symbol: string; name: string; bars: Bars };

/** How many daily bars the AI sees, and how many days each row it reads covers. */
export const VIEW: Record<Length, { days: number; step: number }> = {
  short: { days: 90, step: 1 },
  medium: { days: 180, step: 1 },
  long: { days: 260, step: 2 },
};

/** Textbook definitions, so every model judges against the same rules. */
const DEFINITIONS: Record<string, string> = {
  double_bottom: "Double bottom (W): a decline, a first low, a rally to a peak (the neckline), a second low at about the same price (within ~3-4%), then a rise toward or through the neckline.",
  double_top: "Double top (M): a rise, a first high, a pullback to a trough (the neckline), a second high at about the same price, then a fall toward or below the neckline.",
  triple_bottom: "Triple bottom: three distinct lows at about the same price separated by two rallies, then a rise toward the resistance formed by the rallies.",
  inverse_head_shoulders: "Inverse head and shoulders: a low (left shoulder), a deeper low (head), a higher low near the left shoulder's level (right shoulder), with a neckline across the two rally highs between them.",
  head_shoulders: "Head and shoulders: a high (left shoulder), a higher high (head), a lower high near the left shoulder's level (right shoulder), with a neckline across the two troughs between them.",
  cup_handle: "Cup and handle: a rounded U-shaped base 12-50% deep whose left and right rims are at similar prices (within ~10%), then a small pullback (handle) in the upper half of the cup, ideally drifting slightly down, before a breakout above the rim.",
  rounding_bottom: "Rounding bottom (saucer): a long, gradual decline that flattens into a wide base and turns into a gradual rise, with no sharp V.",
  v_bottom: "V-shaped recovery: a sharp decline of 10% or more followed by an equally sharp rise that wins back most of the fall.",
  ascending_triangle: "Ascending triangle: a flat resistance line touched at least twice at about the same price, and a rising support line of higher lows converging toward it.",
  descending_triangle: "Descending triangle: a flat support line touched at least twice at about the same price, and a falling resistance line of lower highs converging toward it.",
  bull_flag: "Bull flag: a strong, fast rise (the pole, 12% or more) followed by a short, orderly pullback or sideways drift in a small parallel channel that gives back no more than half the pole.",
  bear_flag: "Bear flag: a strong, fast fall (the pole, 12% or more) followed by a short, orderly bounce or sideways drift in a small parallel channel that wins back no more than half the pole.",
  falling_wedge: "Falling wedge: lower highs and lower lows inside two falling lines that converge (the range narrows), usually resolving upward.",
  rising_wedge: "Rising wedge: higher highs and higher lows inside two rising lines that converge (the range narrows), usually resolving downward.",
  ascending_channel: "Rising channel: price moving up between two roughly parallel rising lines, each touched at least twice (higher highs on the upper line, higher lows on the lower line).",
  descending_channel: "Falling channel: price moving down between two roughly parallel falling lines, each touched at least twice (lower highs on the upper line, lower lows on the lower line).",
};

const SYSTEM = `You are a senior technical analyst who reads daily price charts for chart patterns.
You are given daily bars as rows "i,high,low,close" (i is the row number, oldest first) for several stocks.
Judge each stock on its own: does the requested pattern appear, finished recently or still forming at the latest bar? It must end within the last 15 rows.
Be strict, like a professional: proportions matter (similar levels where the pattern needs them, real depth, enough touches on each line). Do not force a match; most stocks will not match.
For each match, mark what you used so it can be drawn on the chart:
- points: the pattern's key turning points, with the row i and the bar's high or low price there. Short Thai labels, e.g. "ยอด", "ก้น 1", "ก้น 2", "หัว", "ไหล่ซ้าย", "ขอบซ้าย", "หูจับ".
- lines: the lines that define the pattern (neckline, resistance, support, channel or wedge sides), each from (i1,p1) to (i2,p2) on real touches. role is "upper", "lower" or "level". Thai label, e.g. "เส้นคอ", "แนวต้าน", "บน", "ล่าง". extend true if the line should be projected to the latest bar.
- evidence: 2 to 4 short Thai bullet points with the actual prices that make it this pattern.
- summary: one Thai sentence on where price is now relative to the pattern.
- breakout: the price that would confirm the pattern; invalidation: the price that would cancel it.
Each result is one instance of the pattern. If a stock shows it more than once (e.g. two separate channels), return a separate result for each, at most 3, each with only its own points and lines. Never mix the marks of two instances in one result.
Use real prices from the rows. For a stock with no match, give only symbol, match false and confidence.`;

const Point = { type: "object", properties: { i: { type: "integer" }, price: { type: "number" }, label: { type: "string" } }, required: ["i", "price", "label"] };
const Line = { type: "object", properties: { i1: { type: "integer" }, p1: { type: "number" }, i2: { type: "integer" }, p2: { type: "number" }, role: { type: "string", enum: ["upper", "lower", "level"] }, label: { type: "string" }, extend: { type: "boolean" } }, required: ["i1", "p1", "i2", "p2", "role", "label"] };
const SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          symbol: { type: "string" }, match: { type: "boolean" }, confidence: { type: "integer" },
          stage: { type: "string", enum: ["forming", "complete", "breakout", "failed"] },
          start: { type: "integer" }, end: { type: "integer" },
          points: { type: "array", items: Point }, lines: { type: "array", items: Line },
          evidence: { type: "array", items: { type: "string" } }, summary: { type: "string" },
          breakout: { type: "number" }, invalidation: { type: "number" },
        },
        required: ["symbol", "match", "confidence"],
      },
    },
  },
  required: ["results"],
};

// Lenient on purpose: models send floats for integers, nulls for missing fields and long labels.
// Anything odd is fixed or dropped here so one stray field never loses the whole batch.
const num = z.preprocess((v) => (v == null || v === "" ? undefined : typeof v === "string" ? Number(v) : v), z.number().finite().optional());
const int = num.transform((v) => (v == null ? undefined : Math.round(v)));
const text = (max: number) => z.preprocess((v) => (v == null ? undefined : String(v)), z.string().optional()).transform((v) => v?.slice(0, max));
const list = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.unknown())).transform((v) => v.flatMap((x) => { const r = item.safeParse(x); return r.success ? [r.data as z.infer<T>] : []; }).slice(0, max));
const PointR = z.object({ i: int, price: num, label: text(40) }).refine((p) => p.i != null && p.price != null);
const LineR = z.object({ i1: int, p1: num, i2: int, p2: num, role: z.enum(["upper", "lower", "level"]).catch("level"), label: text(40), extend: z.boolean().catch(false) })
  .refine((l) => l.i1 != null && l.p1 != null && l.i2 != null && l.p2 != null);
const ResultR = z.object({
  symbol: z.string(), match: z.preprocess((v) => v === true || v === "true", z.boolean()), confidence: num.transform((v) => Math.max(0, Math.min(100, v ?? 0))),
  stage: z.enum(["forming", "complete", "breakout", "failed"]).optional().catch(undefined),
  start: int, end: int, points: list(PointR, 16), lines: list(LineR, 6),
  evidence: list(z.string().transform((v) => v.slice(0, 240)), 6), summary: text(500), breakout: num, invalidation: num,
});
const Reply = z.object({ results: list(ResultR, 50) });

/** A match in daily-bar indexes of the stock's own bars. */
export type Verdict = {
  symbol: string; confidence: number; stage?: string; start: number; end: number;
  points: { k: number; price: number; label: string }[];
  lines: { k1: number; p1: number; k2: number; p2: number; role: "upper" | "lower" | "level"; label: string; extend: boolean }[];
  evidence: string[]; summary?: string; breakout?: number; invalidation?: number;
};

const sig = (v: number) => Number(v.toPrecision(5));

/** Rows the AI reads: the last VIEW days, grouped `step` days per row. `idx[r]` is the last daily bar of row r. */
export function rowsFor(b: Bars, length: Length) {
  const { days, step } = VIEW[length];
  const from = Math.max(0, b.c.length - days);
  const lines: string[] = [], idx: number[] = [];
  for (let k = from; k < b.c.length; k += step) {
    const e = Math.min(b.c.length, k + step);
    const h = Math.max(...b.h.slice(k, e)), l = Math.min(...b.l.slice(k, e));
    lines.push(`${idx.length},${sig(h)},${sig(l)},${sig(b.c[e - 1])}`);
    idx.push(e - 1);
  }
  return { text: lines.join("\n"), idx };
}

/** Move a point to the nearby daily bar whose high or low is closest to the AI's price, so marks sit on real candles. */
function snap(b: Bars, k: number, price: number, radius: number) {
  let best = { k, price, d: Infinity };
  for (let j = Math.max(0, k - radius); j <= Math.min(b.c.length - 1, k + radius); j++) {
    for (const v of [b.h[j], b.l[j]]) {
      const d = Math.abs(v - price) + Math.abs(j - k) * price * 0.001;
      if (d < best.d) best = { k: j, price: v, d };
    }
  }
  // Keep the AI's own number when no candle is near it (e.g. a projected line level).
  return Math.abs(best.price - price) / price <= 0.03 ? { k: best.k, price: best.price } : { k, price };
}

export function patternBrief(template?: Template) {
  return template ? `Pattern: ${DEFINITIONS[template.id] ?? template.name}` : "Pattern: the chart pattern in the attached reference image. Judge by the pattern's structure (its sequence of highs, lows and lines), not by its exact size or length.";
}

/** Ask the AI about one batch of stocks. Returns verdicts for the matches only. */
export async function judgeBatch(stocks: Stock[], o: { ai: ModelChoice; template?: Template; image?: RefImage; length: Length; signal?: AbortSignal }): Promise<Verdict[]> {
  const views = stocks.map((s) => ({ s, ...rowsFor(s.bars, o.length) }));
  const step = VIEW[o.length].step;
  const prompt = `${patternBrief(o.template)}
Each row covers ${step === 1 ? "one trading day" : `${step} trading days`}.

${views.map((v) => `### ${v.s.symbol} (${v.s.name}), ${v.idx.length} rows, last row = latest bar\n${v.text}`).join("\n\n")}`;
  const raw = Reply.parse(await askJson({ ai: o.ai, system: SYSTEM, prompt, image: o.image, schema: SCHEMA, signal: o.signal,
    label: `${o.template?.name ?? "image pattern"} · ${stocks.map((s) => s.symbol).join(", ")}` }));

  const out: Verdict[] = [];
  for (const r of raw.results) {
    const v = views.find((x) => x.s.symbol === r.symbol || x.s.symbol.endsWith(":" + r.symbol));
    if (!v || !r.match || !r.points.length) continue;
    const at = (i: number) => v.idx[Math.max(0, Math.min(v.idx.length - 1, i))];
    const b = v.s.bars, rad = step + 2;
    const points = r.points.map((p) => ({ ...snap(b, at(p.i!), p.price!, rad), label: p.label ?? "" })).sort((a, c) => a.k - c.k);
    const lines = r.lines.map((l) => {
      const a = snap(b, at(l.i1!), l.p1!, rad), c = snap(b, at(l.i2!), l.p2!, rad);
      return { k1: a.k, p1: a.price, k2: c.k, p2: c.price, role: l.role, label: l.label ?? "", extend: l.extend };
    }).filter((l) => l.k2 > l.k1);
    const ks = [...points.map((p) => p.k), ...lines.flatMap((l) => [l.k1, l.k2])];
    const start = Math.min(r.start != null ? at(r.start) : Infinity, ...ks), end = Math.max(r.end != null ? at(r.end) : -Infinity, ...ks);
    out.push({ symbol: v.s.symbol, confidence: Math.round(r.confidence), stage: r.stage, start, end, points, lines,
      evidence: r.evidence, summary: r.summary, breakout: r.breakout, invalidation: r.invalidation });
  }
  return out;
}
