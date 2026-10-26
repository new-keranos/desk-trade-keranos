import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { provider } from "../nova";
import { CLAUDE_MODEL } from "../nova/claude";
import { GEMINI_MODEL } from "../nova/gemini";
import { N, normalize, resample } from "./match";

export type RefImage = { mime: "image/jpeg" | "image/png" | "image/webp"; data: string };
export type Shape = { name: string; bias: "bullish" | "bearish" | "neutral"; points: number[] };

const PROMPT = `The image is a reference chart pattern: a price chart screenshot, a hand drawing or a textbook diagram.
Trace the main price path from left to right. Follow the price line or candle bodies; ignore axes, labels, volume bars, indicators, trend lines and annotations.
Return 32 y-values at evenly spaced x positions from the left edge of the pattern to the right edge, where 0 is the lowest price in the pattern and 1 is the highest.
Also name the pattern in English (for example "Double bottom") and give its usual bias.
If the image does not show a price pattern, set is_chart to false.
Reply with JSON only: {"is_chart": boolean, "name": string, "bias": "bullish" | "bearish" | "neutral", "points": number[]}`;

const SCHEMA = {
  type: "object",
  properties: {
    is_chart: { type: "boolean" },
    name: { type: "string" },
    bias: { type: "string", enum: ["bullish", "bearish", "neutral"] },
    points: { type: "array", items: { type: "number" } },
  },
  required: ["is_chart", "name", "bias", "points"],
};
const Reply = z.object({ is_chart: z.boolean(), name: z.string().max(80), bias: z.enum(["bullish", "bearish", "neutral"]), points: z.array(z.number()).max(200) });

export class ShapeError extends Error {}

let gemini: GoogleGenAI | null = null;
let claude: Anthropic | null = null;

/** Ask the AI to trace the pattern in a reference image, returned as an N-point shape in 0..1. */
export async function shapeFromImage(img: RefImage, signal?: AbortSignal): Promise<Shape> {
  let text: string;
  if (provider() === "claude") {
    claude ??= new Anthropic();
    const res = await claude.messages.create({
      model: CLAUDE_MODEL, max_tokens: 2000,
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } }, { type: "text", text: PROMPT }] }],
    }, { signal });
    text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  } else {
    gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const res = await gemini.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: img.mime, data: img.data } }, { text: PROMPT }] }],
      config: { responseMimeType: "application/json", responseJsonSchema: SCHEMA, abortSignal: signal },
    });
    text = res.text ?? "";
  }
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let parsed;
  try { parsed = Reply.parse(JSON.parse(json)); } catch { throw new ShapeError("Couldn't read a pattern from that image. Try a clearer picture of the price line."); }
  const pts = parsed.points.filter((p) => Number.isFinite(p));
  if (!parsed.is_chart || pts.length < 8) throw new ShapeError("That image doesn't look like a price pattern. Try a chart or a drawing of the shape you want.");
  if (Math.max(...pts) - Math.min(...pts) < 0.3) throw new ShapeError("The traced shape is almost flat. Try a picture with a clearer pattern.");
  return { name: parsed.name.trim() || "Your pattern", bias: parsed.bias, points: normalize(resample(pts, N)) };
}
