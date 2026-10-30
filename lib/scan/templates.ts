// Chart-pattern templates as normalized shapes. Shared by the scanner (server) and the template picker (client).
// Each shape is a list of [x, y] anchors, x and y in 0..1, drawn left to right. y = 1 is the highest price in the pattern.

export type Bias = "bullish" | "bearish" | "neutral";
export type Template = { id: string; name: string; thai: string; bias: Bias; anchors: [number, number][] };

export const TEMPLATES: Template[] = [
  { id: "double_bottom", name: "Double bottom", thai: "ฐานคู่ (W)", bias: "bullish",
    anchors: [[0, 1], [0.25, 0.02], [0.5, 0.6], [0.75, 0], [1, 0.8]] },
  { id: "double_top", name: "Double top", thai: "ยอดคู่ (M)", bias: "bearish",
    anchors: [[0, 0], [0.25, 0.98], [0.5, 0.4], [0.75, 1], [1, 0.2]] },
  { id: "triple_bottom", name: "Triple bottom", thai: "ฐานสามจุด", bias: "bullish",
    anchors: [[0, 1], [0.17, 0.02], [0.33, 0.55], [0.5, 0], [0.67, 0.55], [0.83, 0.03], [1, 0.8]] },
  { id: "inverse_head_shoulders", name: "Inverse head & shoulders", thai: "หัวไหล่กลับหัว", bias: "bullish",
    anchors: [[0, 0.95], [0.17, 0.3], [0.32, 0.65], [0.5, 0], [0.68, 0.65], [0.83, 0.32], [1, 1]] },
  { id: "head_shoulders", name: "Head & shoulders", thai: "หัวและไหล่", bias: "bearish",
    anchors: [[0, 0.05], [0.17, 0.7], [0.32, 0.35], [0.5, 1], [0.68, 0.35], [0.83, 0.68], [1, 0]] },
  { id: "cup_handle", name: "Cup and handle", thai: "ถ้วยและหูจับ", bias: "bullish",
    anchors: [[0, 1], [0.08, 0.72], [0.18, 0.38], [0.3, 0.1], [0.4, 0.02], [0.5, 0.1], [0.6, 0.38], [0.7, 0.8], [0.76, 0.96], [0.84, 0.8], [0.92, 0.84], [1, 1]] },
  { id: "rounding_bottom", name: "Rounding bottom", thai: "ฐานกระทะ", bias: "bullish",
    anchors: [[0, 1], [0.15, 0.55], [0.3, 0.2], [0.5, 0], [0.7, 0.2], [0.85, 0.55], [1, 1]] },
  { id: "v_bottom", name: "V-shaped recovery", thai: "ฟื้นตัวทรง V", bias: "bullish",
    anchors: [[0, 1], [0.5, 0], [1, 0.95]] },
  { id: "ascending_triangle", name: "Ascending triangle", thai: "สามเหลี่ยมขาขึ้น", bias: "bullish",
    anchors: [[0, 0], [0.15, 0.9], [0.3, 0.3], [0.45, 0.9], [0.6, 0.52], [0.75, 0.9], [0.88, 0.72], [1, 1]] },
  { id: "descending_triangle", name: "Descending triangle", thai: "สามเหลี่ยมขาลง", bias: "bearish",
    anchors: [[0, 1], [0.15, 0.1], [0.3, 0.7], [0.45, 0.1], [0.6, 0.48], [0.75, 0.1], [0.88, 0.28], [1, 0]] },
  { id: "bull_flag", name: "Bull flag", thai: "ธงขาขึ้น", bias: "bullish",
    anchors: [[0, 0], [0.4, 0.95], [0.5, 0.78], [0.6, 0.88], [0.7, 0.7], [0.8, 0.8], [0.9, 0.64], [1, 1]] },
  { id: "bear_flag", name: "Bear flag", thai: "ธงขาลง", bias: "bearish",
    anchors: [[0, 1], [0.4, 0.05], [0.5, 0.22], [0.6, 0.12], [0.7, 0.3], [0.8, 0.2], [0.9, 0.36], [1, 0]] },
  { id: "falling_wedge", name: "Falling wedge", thai: "ลิ่มขาลง", bias: "bullish",
    anchors: [[0, 1], [0.15, 0.45], [0.3, 0.8], [0.45, 0.3], [0.6, 0.6], [0.75, 0.2], [0.88, 0.42], [1, 0.75]] },
  { id: "rising_wedge", name: "Rising wedge", thai: "ลิ่มขาขึ้น", bias: "bearish",
    anchors: [[0, 0], [0.15, 0.55], [0.3, 0.2], [0.45, 0.7], [0.6, 0.4], [0.75, 0.8], [0.88, 0.58], [1, 0.25]] },
  { id: "ascending_channel", name: "Rising channel", thai: "ช่องขาขึ้น", bias: "bullish",
    anchors: [[0, 0.1], [0.15, 0.4], [0.3, 0.2], [0.5, 0.65], [0.65, 0.45], [0.85, 0.9], [1, 0.7]] },
  { id: "descending_channel", name: "Falling channel", thai: "ช่องขาลง", bias: "bearish",
    anchors: [[0, 1], [0.15, 0.62], [0.3, 0.82], [0.5, 0.38], [0.65, 0.58], [0.85, 0.12], [1, 0.32]] },
  // Price shape only; the point of these is that RSI moves the other way (drawn in the RSI panel).
  { id: "rsi_bullish_divergence", name: "RSI bullish divergence", thai: "RSI แยกทางขาขึ้น", bias: "bullish",
    anchors: [[0, 1], [0.35, 0.15], [0.6, 0.55], [0.85, 0], [1, 0.3]] },
  { id: "rsi_bearish_divergence", name: "RSI bearish divergence", thai: "RSI แยกทางขาลง", bias: "bearish",
    anchors: [[0, 0], [0.35, 0.85], [0.6, 0.45], [0.85, 1], [1, 0.7]] },
];

/** Templates judged on RSI against price rather than on price shape alone. */
export const isDivergence = (id?: string) => !!id && id.startsWith("rsi_");

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);

/** Sample a shape's anchors at n evenly spaced points (piecewise linear). */
export function sampleAnchors(anchors: [number, number][], n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : i / (n - 1);
    let k = 0;
    while (k < anchors.length - 2 && anchors[k + 1][0] < x) k++;
    const [x0, y0] = anchors[k], [x1, y1] = anchors[k + 1];
    out.push(x1 === x0 ? y1 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0));
  }
  return out;
}
