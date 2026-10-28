import "server-only";
import { Resvg } from "@resvg/resvg-js";
import type { RefImage } from "./llm";

// A plain candlestick picture of the rows the AI reads, for the verify pass: models judge shapes
// better from a picture than from numbers alone. No text, so no fonts are needed on the server.
// Faint vertical lines mark every 10th row and stronger ones every 50th, so the picture lines up
// with the row numbers in the prompt.

export type ChartRow = { o: number; h: number; l: number; c: number; v?: number };

const W = 1200, H = 640, PAD = 16, VOL = 0.16;

export function chartImage(rows: ChartRow[]): RefImage {
  const n = rows.length;
  const hi = Math.max(...rows.map((r) => r.h)), lo = Math.min(...rows.map((r) => r.l)), span = hi - lo || 1;
  const priceH = (H - 2 * PAD) * (1 - VOL), volTop = PAD + priceH + 8, volH = H - PAD - volTop;
  const slot = (W - 2 * PAD) / n, body = Math.max(1, slot * 0.7);
  const x = (i: number) => PAD + slot * (i + 0.5);
  const y = (p: number) => PAD + (1 - (p - lo) / span) * priceH;
  const vmax = Math.max(1, ...rows.map((r) => r.v ?? 0));

  const parts: string[] = [`<rect width="${W}" height="${H}" fill="#ffffff"/>`];
  for (let k = 1; k < 8; k++) parts.push(`<line x1="${PAD}" x2="${W - PAD}" y1="${(PAD + (k / 8) * priceH).toFixed(1)}" y2="${(PAD + (k / 8) * priceH).toFixed(1)}" stroke="#eeeeee"/>`);
  for (let i = 0; i < n; i += 10) parts.push(`<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${PAD}" y2="${H - PAD}" stroke="${i % 50 === 0 ? "#b0b0b0" : "#e4e4e4"}"/>`);
  rows.forEach((r, i) => {
    const up = r.c >= r.o, col = up ? "#1e9e57" : "#d93f3f", cx = x(i).toFixed(1);
    parts.push(`<line x1="${cx}" x2="${cx}" y1="${y(r.h).toFixed(1)}" y2="${y(r.l).toFixed(1)}" stroke="${col}" stroke-width="1"/>`);
    const top = y(Math.max(r.o, r.c)), bot = y(Math.min(r.o, r.c));
    parts.push(`<rect x="${(x(i) - body / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${body.toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}" fill="${col}"/>`);
    if (r.v) {
      const vh = (r.v / vmax) * volH;
      parts.push(`<rect x="${(x(i) - body / 2).toFixed(1)}" y="${(volTop + volH - vh).toFixed(1)}" width="${body.toFixed(1)}" height="${vh.toFixed(1)}" fill="${col}" fill-opacity="0.35"/>`);
    }
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;
  const png = new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();
  return { mime: "image/png", data: Buffer.from(png).toString("base64") };
}
