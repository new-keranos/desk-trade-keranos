// Langfuse tracing: one trace per chat message or scan, one generation per AI call with its model, tokens and cost.
// Off unless LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY are set; then every call below is a no-op.
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startActiveObservation, startObservation } from "@langfuse/tracing";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { GenerateContentResponse } from "@google/genai";
import type { ModelChoice } from "./nova/config";

export type Feature = "chat" | "scan";
type Usage = Record<string, number>;

// Each route bundle gets its own copy of this module, so the processor lives on globalThis.
const g = globalThis as { langfuse?: LangfuseSpanProcessor | null };

/** Called once from instrumentation.ts when the server starts. */
export function startTelemetry() {
  if (g.langfuse !== undefined) return;
  g.langfuse = null;
  if (!process.env.LANGFUSE_SECRET_KEY || !process.env.LANGFUSE_PUBLIC_KEY) return;
  // Reads LANGFUSE_SECRET_KEY, LANGFUSE_PUBLIC_KEY and LANGFUSE_BASE_URL. Only Langfuse spans are exported, not Next.js's own.
  g.langfuse = new LangfuseSpanProcessor({ environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV });
  new NodeTracerProvider({ spanProcessors: [g.langfuse] }).register();
}

/** Send buffered traces. Serverless functions freeze after the response, so routes call this from after(). */
export async function flushTelemetry() {
  await g.langfuse?.forceFlush().catch((err) => console.error("langfuse: flush failed", err));
}

/** Run one request (a chat message or a scan) as a Langfuse trace tagged with its feature and provider. */
export function traceRequest<T>(feature: Feature, ai: ModelChoice, input: unknown, fn: () => Promise<T>): Promise<T> {
  const name = feature === "chat" ? "agent-chat" : "pattern-scan";
  const run = () => startActiveObservation(name, async (span) => {
    span.update({ input });
    return fn();
  });
  return propagateAttributes({ traceName: name, tags: [feature, ai.provider], metadata: { provider: ai.provider, model: ai.model } }, run);
}

/** Record one AI call as a generation. `read` pulls the served model, token usage and output from the reply. */
export async function traceGeneration<T>(
  feature: Feature, ai: ModelChoice, input: unknown, call: () => Promise<T>,
  read: (res: T) => { model?: string; usage?: Usage; output?: unknown },
): Promise<T> {
  const gen = startObservation(`${feature}-${ai.provider}`, { model: ai.model, input, metadata: { feature, provider: ai.provider } }, { asType: "generation" });
  try {
    const res = await call();
    const r = read(res);
    // The served model (e.g. what gemini-flash-latest points at today) is what Langfuse prices by.
    gen.update({ model: r.model || ai.model, usageDetails: r.usage, output: r.output });
    return res;
  } catch (err) {
    gen.update({ level: "ERROR", statusMessage: err instanceof Error ? err.message.slice(0, 300) : String(err) });
    throw err;
  } finally {
    gen.end();
  }
}

const clean = (u: Record<string, number | null | undefined>): Usage =>
  Object.fromEntries(Object.entries(u).filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0));

/** Gemini bills thinking tokens as output. */
export function geminiUsage(res: GenerateContentResponse): Usage {
  const u = res.usageMetadata;
  if (!u) return {};
  const output = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  return clean({ input: u.promptTokenCount, output, total: u.totalTokenCount ?? (u.promptTokenCount ?? 0) + output });
}

/** Claude's input_tokens already leaves out cache reads and writes, which are priced separately. */
export function claudeUsage(u?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): Usage {
  if (!u) return {};
  return clean({ input: u.input_tokens, output: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens });
}

/** OpenAI's prompt_tokens includes cached tokens, and completion_tokens includes reasoning. */
export function openaiUsage(u?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } }): Usage {
  if (!u) return {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return clean({ input: u.prompt_tokens - cached, input_cached_tokens: cached, output: u.completion_tokens, total: u.total_tokens });
}
