import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { ApiError, GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { reasons, type ModelChoice } from "../nova/config";
import { claudeUsage, geminiUsage, openaiUsage, traceGeneration } from "../telemetry";

export type RefImage = { mime: "image/jpeg" | "image/png" | "image/webp"; data: string };

/** The AI hit a rate limit or quota and the caller may retry later. */
export class AiBusy extends Error {}

let gemini: GoogleGenAI | null = null;
let claude: Anthropic | null = null;
let openai: OpenAI | null = null;

/** Short, user-safe description of why an AI call failed. */
export function aiReason(err: unknown): string {
  if (err instanceof ApiError) return `Gemini error ${err.status}${err.status === 402 ? " (this API key needs billing; check Google AI Studio or pick another model)" : ""}${/API key/i.test(err.message) ? " (check GEMINI_API_KEY)" : /model/i.test(err.message) && err.status === 404 ? " (check GEMINI_MODEL)" : ""}`;
  if (err instanceof Anthropic.APIError) return `Claude error ${err.status ?? ""}${err.status === 401 ? " (check ANTHROPIC_API_KEY)" : ""}`.trim();
  if (err instanceof OpenAI.APIError) return `OpenAI error ${err.status ?? ""}${err.status === 401 ? " (check OPENAI_API_KEY)" : err.code === "insufficient_quota" ? " (no credit left on the OpenAI account)" : `: ${((err.error as { message?: string } | undefined)?.message ?? err.message).slice(0, 200)}`}`.trim();
  if (err instanceof SyntaxError) return "the AI's reply wasn't valid JSON";
  return err instanceof Error ? err.message.slice(0, 160) : "unknown error";
}

/** Overloaded or rate-limited: worth waiting and retrying. */
const RETRY = new Set([429, 500, 502, 503, 504]);

/** One JSON request to the configured AI (Gemini by default, Claude with AI_PROVIDER=claude). Returns the parsed object. */
export async function askJson(o: { ai: ModelChoice; system: string; prompt: string; image?: RefImage; schema: object; signal?: AbortSignal; label?: string }): Promise<unknown> {
  let text: string;
  const input = { request: o.label, image: !!o.image };
  try {
    const withSchema = o.prompt + "\n\nReply with JSON only, matching this JSON Schema:\n" + JSON.stringify(o.schema);
    if (o.ai.provider === "openai") {
      openai ??= new OpenAI();
      const content: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: "text", text: withSchema }];
      if (o.image) content.unshift({ type: "image_url", image_url: { url: `data:${o.image.mime};base64,${o.image.data}` } });
      const res = await traceGeneration("scan", o.ai, input, () => openai!.chat.completions.create({
        model: o.ai.model, response_format: { type: "json_object" }, max_completion_tokens: 32000,
        ...(reasons(o.ai.model) ? { reasoning_effort: "medium" as const } : {}),
        messages: [{ role: "system", content: o.system }, { role: "user", content }],
      }, { signal: o.signal }), (r) => ({ model: r.model, usage: openaiUsage(r.usage), output: r.choices[0]?.message?.content }));
      if (res.choices[0]?.finish_reason === "length") throw new Error("the AI's reply was cut off");
      text = res.choices[0]?.message?.content ?? "";
      if (!text.trim()) throw new Error("OpenAI returned an empty reply");
    } else if (o.ai.provider === "claude") {
      claude ??= new Anthropic();
      const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: withSchema }];
      if (o.image) content.unshift({ type: "image", source: { type: "base64", media_type: o.image.mime, data: o.image.data } });
      const res = await traceGeneration("scan", o.ai, input,
        () => claude!.messages.create({ model: o.ai.model, max_tokens: 16000, system: o.system, messages: [{ role: "user", content }] }, { signal: o.signal }),
        (r) => ({ model: r.model, usage: claudeUsage(r.usage), output: r.content }));
      if (res.stop_reason === "max_tokens") throw new Error("the AI's reply was cut off");
      text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    } else {
      gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const parts = [...(o.image ? [{ inlineData: { mimeType: o.image.mime, data: o.image.data } }] : []), { text: o.prompt }];
      const res = await traceGeneration("scan", o.ai, input, () => gemini!.models.generateContent({
        model: o.ai.model,
        contents: [{ role: "user", parts }],
        // Thinking tokens count toward the output limit, so leave plenty of room for the JSON.
        config: { systemInstruction: o.system, responseMimeType: "application/json", responseJsonSchema: o.schema, maxOutputTokens: 60000, abortSignal: o.signal },
      }), (r) => ({ model: r.modelVersion, usage: geminiUsage(r), output: r.text }));
      text = res.text ?? "";
      const finish = res.candidates?.[0]?.finishReason;
      if (!text.trim()) throw new Error(res.promptFeedback?.blockReason ? `Gemini blocked the request (${res.promptFeedback.blockReason})` : `Gemini returned an empty reply (${finish ?? "no reason"})`);
      if (finish === "MAX_TOKENS") throw new Error("the AI's reply was cut off");
    }
  } catch (err) {
    if (err instanceof ApiError && RETRY.has(err.status)) throw new AiBusy(err.status === 429 ? "Gemini free-tier limit reached." : "Gemini is overloaded.");
    if (err instanceof Anthropic.APIError && err.status != null && RETRY.has(err.status)) throw new AiBusy("Claude is busy.");
    // An empty OpenAI account also answers 429; waiting won't fix that.
    if (err instanceof OpenAI.APIError && err.status != null && RETRY.has(err.status) && err.code !== "insufficient_quota") throw new AiBusy("OpenAI is busy.");
    throw err;
  }
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}
