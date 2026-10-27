import Anthropic from "@anthropic-ai/sdk";
import { ApiError } from "@google/genai";
import { z } from "zod";
import OpenAI from "openai";
import { resolveChoice, runNova, type NovaEvent } from "@/lib/nova";
import { openTv, originOf, TvAuthError } from "@/lib/tradingview";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(20000) })).min(1).max(20),
  effort: z.enum(["low", "medium", "high"]).default("medium"),
  watchlist: z.array(z.string().max(64)).max(200).default([]),
  selected: z.string().max(64).nullable().default(null),
  ai: z.object({ provider: z.enum(["gemini", "claude", "openai"]), model: z.string().max(80) }).optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad request" }, { status: 400 });
  const { messages, effort, watchlist, selected } = parsed.data;
  const ai = resolveChoice(parsed.data.ai);
  if (messages[messages.length - 1].role !== "user") return Response.json({ error: "Last message must be from the user" }, { status: 400 });

  // Open TradingView before streaming: a token refresh may need to update the login cookie.
  let tv: Awaited<ReturnType<typeof openTv>>;
  try {
    tv = await openTv(originOf(req));
  } catch (err) {
    return Response.json({ error: (err as Error).message, connect: err instanceof TvAuthError }, { status: err instanceof TvAuthError ? 409 : 502 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: NovaEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      try {
        await runNova({ history: messages, effort, ai, watchlist, selected, tv: tv.call, emit, signal: req.signal });
      } catch (err) {
        let message = "Agent was interrupted. Send again to retry.";
        if (err instanceof ApiError) {
          message = err.status === 429 ? "Gemini free-tier limit reached. Wait a minute, or try again tomorrow if the daily quota is used up."
            : err.status === 400 || err.status === 403 ? "Gemini rejected the request. Check GEMINI_API_KEY and GEMINI_MODEL."
            : err.status === 402 ? "Gemini needs billing on this API key (error 402). Check Google AI Studio billing, or pick another model."
            : `Gemini API error ${err.status}. Try again.`;
        } else if (err instanceof Anthropic.RateLimitError) message = "Rate limited by the Claude API. Wait a minute and try again.";
        else if (err instanceof Anthropic.AuthenticationError) message = "The Anthropic API key is missing or invalid. Check ANTHROPIC_API_KEY.";
        else if (err instanceof Anthropic.APIUserAbortError || err instanceof OpenAI.APIUserAbortError) message = "Stopped.";
        else if (err instanceof OpenAI.APIError) {
          message = err.status === 401 ? "The OpenAI API key is missing or invalid. Check OPENAI_API_KEY."
            : err.code === "insufficient_quota" ? "The OpenAI account has no credit left. Add billing on platform.openai.com."
            : err.status === 429 ? "Rate limited by OpenAI. Wait a minute and try again."
            : err.status === 404 ? `OpenAI doesn't offer ${ai.model} to this key. Pick another model.`
            : `OpenAI API error ${err.status ?? ""}. Try again.`;
        }
        else if (err instanceof Anthropic.APIError) message = `Claude API error ${err.status ?? ""}. Try again.`;
        else if (err instanceof Error && err.message.includes("TradingView")) message = err.message;
        emit({ type: "error", message });
      } finally {
        emit({ type: "done" });
        controller.close();
        await tv.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
