import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { ApiError, GoogleGenAI } from "@google/genai";
import { CLAUDE_MODEL, GEMINI_MODEL, provider } from "../nova/config";

export type RefImage = { mime: "image/jpeg" | "image/png" | "image/webp"; data: string };

/** The AI hit a rate limit or quota and the caller may retry later. */
export class AiBusy extends Error {}

let gemini: GoogleGenAI | null = null;
let claude: Anthropic | null = null;

/** One JSON request to the configured AI (Gemini by default, Claude with AI_PROVIDER=claude). Returns the parsed object. */
export async function askJson(o: { system: string; prompt: string; image?: RefImage; schema: object; signal?: AbortSignal }): Promise<unknown> {
  let text: string;
  try {
    if (provider() === "claude") {
      claude ??= new Anthropic();
      const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: o.prompt + "\n\nReply with JSON only, matching this JSON Schema:\n" + JSON.stringify(o.schema) }];
      if (o.image) content.unshift({ type: "image", source: { type: "base64", media_type: o.image.mime, data: o.image.data } });
      const res = await claude.messages.create({ model: CLAUDE_MODEL, max_tokens: 16000, system: o.system, messages: [{ role: "user", content }] }, { signal: o.signal });
      text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    } else {
      gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const parts = [...(o.image ? [{ inlineData: { mimeType: o.image.mime, data: o.image.data } }] : []), { text: o.prompt }];
      const res = await gemini.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts }],
        config: { systemInstruction: o.system, responseMimeType: "application/json", responseJsonSchema: o.schema, abortSignal: o.signal },
      });
      text = res.text ?? "";
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) throw new AiBusy("Gemini free-tier limit reached.");
    if (err instanceof Anthropic.RateLimitError) throw new AiBusy("Claude rate limit reached.");
    throw err;
  }
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}
