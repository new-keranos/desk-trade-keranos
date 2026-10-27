import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { ApiError, GoogleGenAI } from "@google/genai";
import { CLAUDE_MODEL, GEMINI_MODEL, provider } from "../nova/config";

export type RefImage = { mime: "image/jpeg" | "image/png" | "image/webp"; data: string };

/** The AI hit a rate limit or quota and the caller may retry later. */
export class AiBusy extends Error {}

let gemini: GoogleGenAI | null = null;
let claude: Anthropic | null = null;

/** Short, user-safe description of why an AI call failed. */
export function aiReason(err: unknown): string {
  if (err instanceof ApiError) return `Gemini error ${err.status}${/API key/i.test(err.message) ? " (check GEMINI_API_KEY)" : /model/i.test(err.message) && err.status === 404 ? " (check GEMINI_MODEL)" : ""}`;
  if (err instanceof Anthropic.APIError) return `Claude error ${err.status ?? ""}`.trim();
  if (err instanceof SyntaxError) return "the AI's reply wasn't valid JSON";
  return err instanceof Error ? err.message.slice(0, 160) : "unknown error";
}

/** Overloaded or rate-limited: worth waiting and retrying. */
const RETRY = new Set([429, 500, 502, 503, 504]);

/** One JSON request to the configured AI (Gemini by default, Claude with AI_PROVIDER=claude). Returns the parsed object. */
export async function askJson(o: { system: string; prompt: string; image?: RefImage; schema: object; signal?: AbortSignal }): Promise<unknown> {
  let text: string;
  try {
    if (provider() === "claude") {
      claude ??= new Anthropic();
      const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: o.prompt + "\n\nReply with JSON only, matching this JSON Schema:\n" + JSON.stringify(o.schema) }];
      if (o.image) content.unshift({ type: "image", source: { type: "base64", media_type: o.image.mime, data: o.image.data } });
      const res = await claude.messages.create({ model: CLAUDE_MODEL, max_tokens: 16000, system: o.system, messages: [{ role: "user", content }] }, { signal: o.signal });
      if (res.stop_reason === "max_tokens") throw new Error("the AI's reply was cut off");
      text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    } else {
      gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const parts = [...(o.image ? [{ inlineData: { mimeType: o.image.mime, data: o.image.data } }] : []), { text: o.prompt }];
      const res = await gemini.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts }],
        // Thinking tokens count toward the output limit, so leave plenty of room for the JSON.
        config: { systemInstruction: o.system, responseMimeType: "application/json", responseJsonSchema: o.schema, maxOutputTokens: 60000, abortSignal: o.signal },
      });
      text = res.text ?? "";
      const finish = res.candidates?.[0]?.finishReason;
      if (!text.trim()) throw new Error(res.promptFeedback?.blockReason ? `Gemini blocked the request (${res.promptFeedback.blockReason})` : `Gemini returned an empty reply (${finish ?? "no reason"})`);
      if (finish === "MAX_TOKENS") throw new Error("the AI's reply was cut off");
    }
  } catch (err) {
    if (err instanceof ApiError && RETRY.has(err.status)) throw new AiBusy(err.status === 429 ? "Gemini free-tier limit reached." : "Gemini is overloaded.");
    if (err instanceof Anthropic.APIError && err.status != null && RETRY.has(err.status)) throw new AiBusy("Claude is busy.");
    throw err;
  }
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}
