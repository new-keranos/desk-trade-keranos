import "server-only";
import { z } from "zod";
import type { ModelChoice } from "../nova/config";
import { chartImage, type ChartRow } from "./chart";
import { askJson, type RefImage } from "./llm";
import type { Length } from "./match";
import type { Template } from "./templates";

// The AI reads each stock's daily bars and decides whether the chosen pattern is there.
// No shape maths: the model looks at the numbers the way an analyst reads a chart, and marks the
// turning points and lines it used, so the chart can show its reasoning.

export type Bars = { t: number[]; o?: number[]; h: number[]; l: number[]; c: number[]; v?: number[] };
/** The user's verdict on an earlier match, shown to the AI as an example of what they count as this pattern. */
export type Feedback = { symbol: string; good: boolean; note: string };
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
You are given daily bars as rows "i,high,low,close,vol" (i is the row number, oldest first; vol is the row's volume relative to the stock's average, 1.0 = normal) for several stocks.
Each stock also has a "Swings" line: its swing highs (H) and lows (L) as row:price, found by code with a minimum move. Use them as the candidate turning points and check the pattern against their sequence; small wiggles between swings are noise. Use vol where the pattern needs it (volume drying up in a base, expanding on a breakout).
Judge each stock on its own: does the requested pattern appear, finished recently or still forming at the latest bar? It must end within the last 15 rows.
Be strict, like a professional: proportions matter (similar levels where the pattern needs them, real depth, enough touches on each line). Do not force a match; most stocks will not match.
Before you answer for a stock, check every rule in the pattern definition against the actual rows. Set match true only if every rule holds; if any rule fails or is unclear, set match false. Confidence 80+ means a textbook example; 70-79 a clear but imperfect one.
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

/** Minimum move for a swing, by pattern length. */
const SWING_PCT: Record<Length, number> = { short: 4, medium: 6, long: 8 };

/** Rows the AI reads: the last VIEW days, grouped `step` days per row. `idx[r]` is the last daily bar of row r. */
export function rowsFor(b: Bars, length: Length) {
  const { days, step } = VIEW[length];
  const from = Math.max(0, b.c.length - days);
  const avgV = b.v?.length ? b.v.slice(from).reduce((x, y) => x + y, 0) / (b.c.length - from) : 0;
  const lines: string[] = [], idx: number[] = [], rows: ChartRow[] = [];
  for (let k = from; k < b.c.length; k += step) {
    const e = Math.min(b.c.length, k + step);
    const h = Math.max(...b.h.slice(k, e)), l = Math.min(...b.l.slice(k, e));
    const v = b.v?.length ? b.v.slice(k, e).reduce((x, y) => x + y, 0) : undefined;
    const rel = v != null && avgV > 0 ? (v / (avgV * (e - k))).toFixed(1) : "";
    lines.push(`${idx.length},${sig(h)},${sig(l)},${sig(b.c[e - 1])}${rel ? "," + rel : ""}`);
    rows.push({ o: b.o?.[k] ?? b.c[Math.max(0, k - 1)], h, l, c: b.c[e - 1], v });
    idx.push(e - 1);
  }
  return { text: lines.join("\n"), idx, rows, swings: swingsOf(rows, SWING_PCT[length]) };
}

/** Zigzag swing points over the rows: a high or low that price then moved away from by at least pct %. */
export function swingsOf(rows: ChartRow[], pct: number) {
  const out: { i: number; kind: "H" | "L"; price: number }[] = [];
  if (!rows.length) return out;
  let dir: 0 | 1 | -1 = 0, hiI = 0, loI = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].h > rows[hiI].h) hiI = i;
    if (rows[i].l < rows[loI].l) loI = i;
    if (dir >= 0 && rows[i].l <= rows[hiI].h * (1 - pct / 100) && hiI < i) {
      if (dir === 0 && loI < hiI) out.push({ i: loI, kind: "L", price: rows[loI].l });
      out.push({ i: hiI, kind: "H", price: rows[hiI].h }); dir = -1; loI = i;
    } else if (dir <= 0 && rows[i].h >= rows[loI].l * (1 + pct / 100) && loI < i) {
      if (dir === 0 && hiI < loI) out.push({ i: hiI, kind: "H", price: rows[hiI].h });
      out.push({ i: loI, kind: "L", price: rows[loI].l }); dir = 1; hiI = i;
    }
  }
  // The leg still running at the latest bar.
  if (dir === 1) out.push({ i: hiI, kind: "H", price: rows[hiI].h });
  if (dir === -1) out.push({ i: loI, kind: "L", price: rows[loI].l });
  return out;
}
const swingText = (sw: ReturnType<typeof swingsOf>) => sw.map((p) => `${p.i}:${p.kind} ${sig(p.price)}`).join(", ") || "none";

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
  return Math.abs(best.price - price) / price <= 0.03 ? { k: best.k, price: best.price, near: true } : { k, price, near: false };
}

export function patternBrief(template?: Template) {
  return template ? `Pattern: ${DEFINITIONS[template.id] ?? template.name}` : "Pattern: the chart pattern in the attached reference image. Judge by the pattern's structure (its sequence of highs, lows and lines), not by its exact size or length.";
}

export type JudgeOptions = { ai: ModelChoice; template?: Template; image?: RefImage; length: Length; feedback?: Feedback[]; signal?: AbortSignal };
type View = { s: Stock } & ReturnType<typeof rowsFor>;

/** The user's thumbs up and down on earlier matches of this pattern, so the AI learns what they count as one. */
function feedbackBrief(f?: Feedback[]) {
  if (!f?.length) return "";
  const good = f.filter((x) => x.good), bad = f.filter((x) => !x.good);
  return `\n\nThe user reviewed earlier matches of this pattern. Match their judgement.${good.length ? `\nThey agreed with:\n${good.map((x) => `- ${x.symbol}: ${x.note}`).join("\n")}` : ""}${bad.length ? `\nThey said these were NOT the pattern, so do not match charts like them:\n${bad.map((x) => `- ${x.symbol}: ${x.note}`).join("\n")}` : ""}`;
}
const stockBlock = (v: View) => `### ${v.s.symbol} (${v.s.name}), ${v.idx.length} rows, last row = latest bar\nSwings: ${swingText(v.swings)}\n${v.text}`;
const rowNote = (step: number) => `Each row covers ${step === 1 ? "one trading day" : `${step} trading days`}.`;

/** Ask the AI about one batch of stocks. Returns verdicts for the matches only. */
export async function judgeBatch(stocks: Stock[], o: JudgeOptions): Promise<Verdict[]> {
  const views = stocks.map((s) => ({ s, ...rowsFor(s.bars, o.length) }));
  const step = VIEW[o.length].step;
  const prompt = `${patternBrief(o.template)}${feedbackBrief(o.feedback)}\n${rowNote(step)}\n\n${views.map(stockBlock).join("\n\n")}`;
  const raw = Reply.parse(await askJson({ ai: o.ai, system: SYSTEM, prompt, images: o.image ? [o.image] : [], schema: SCHEMA, signal: o.signal,
    label: `${o.template?.name ?? "image pattern"} · ${stocks.map((s) => s.symbol).join(", ")}` }));
  return toVerdicts(raw, views, step);
}

/** Second opinion on one match: a (possibly stronger) model sees the rows and a picture of the chart, and confirms or rejects it. */
export async function verifyMatch(stock: Stock, first: Verdict, o: JudgeOptions): Promise<Verdict | null> {
  const view = { s: stock, ...rowsFor(stock.bars, o.length) };
  const step = VIEW[o.length].step;
  const row = (k: number) => { const r = view.idx.findIndex((x) => x >= k); return r < 0 ? view.idx.length - 1 : r; };
  const marks = [...first.points.map((p) => `${p.label || "point"} at row ${row(p.k)} ${sig(p.price)}`),
    ...first.lines.map((l) => `${l.label || l.role} line row ${row(l.k1)} ${sig(l.p1)} to row ${row(l.k2)} ${sig(l.p2)}`)].join("; ");
  const prompt = `${patternBrief(o.template)}${feedbackBrief(o.feedback)}
${rowNote(step)}
A first reader flagged ${stock.symbol} as this pattern (${first.confidence}% sure), marking: ${marks}.
Verify it independently, as a strict senior reviewer. ${o.image ? "The first image is the reference pattern; the last image" : "The image"} is this stock's chart drawn from the same rows: one candle per row, the rightmost candle is the last row, faint vertical lines every 10 rows and darker ones every 50 rows (row 0 is the leftmost darker line), volume along the bottom.
If it really is the pattern, return one result with match true, your own confidence and corrected points and lines (row numbers and prices from the rows). If not, return match false.

${stockBlock(view)}`;
  const raw = Reply.parse(await askJson({ ai: o.ai, system: SYSTEM, prompt, images: [...(o.image ? [o.image] : []), chartImage(view.rows)], schema: SCHEMA, signal: o.signal,
    label: `verify ${o.template?.name ?? "image pattern"} · ${stock.symbol}` }));
  return toVerdicts(raw, [view], step)[0] ?? null;
}

function toVerdicts(raw: z.infer<typeof Reply>, views: View[], step: number): Verdict[] {
  const out: Verdict[] = [];
  for (const r of raw.results) {
    const v = views.find((x) => x.s.symbol === r.symbol || x.s.symbol.endsWith(":" + r.symbol)) ?? (views.length === 1 ? views[0] : undefined);
    if (!v || !r.match || !r.points.length) continue;
    const at = (i: number) => v.idx[Math.max(0, Math.min(v.idx.length - 1, i))];
    const b = v.s.bars, rad = step + 2;
    const snapped = r.points.map((p) => ({ ...snap(b, at(p.i!), p.price!, rad), label: p.label ?? "" }));
    // Turning points must sit on real highs and lows; a reply whose points mostly don't is reading the chart wrong.
    if (snapped.filter((p) => p.near).length < Math.ceil(snapped.length * 0.75)) continue;
    const points = snapped.map(({ near: _n, ...p }) => p).sort((a, c) => a.k - c.k);
    const lines = r.lines.map((l) => {
      const a = snap(b, at(l.i1!), l.p1!, rad), c = snap(b, at(l.i2!), l.p2!, rad);
      return { k1: a.k, p1: a.price, k2: c.k, p2: c.price, role: l.role, label: l.label ?? "", extend: l.extend };
    }).filter((l) => l.k2 > l.k1);
    const ks = [...points.map((p) => p.k), ...lines.flatMap((l) => [l.k1, l.k2])];
    const start = Math.min(r.start != null ? at(r.start) : Infinity, ...ks), end = Math.max(r.end != null ? at(r.end) : -Infinity, ...ks);
    // The pattern must reach the recent bars (the prompt asks for the last 15 rows).
    if (end < b.c.length - 1 - 16 * step) continue;
    out.push({ symbol: v.s.symbol, confidence: Math.round(r.confidence), stage: r.stage, start, end, points, lines,
      evidence: r.evidence, summary: r.summary, breakout: r.breakout, invalidation: r.invalidation });
  }
  return out;
}
