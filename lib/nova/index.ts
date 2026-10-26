import "server-only";
import { runClaude } from "./claude";
import { runGemini } from "./gemini";
import type { RunOptions } from "./tools";

export type { NovaEvent, Proposal, ChatTurn } from "./tools";

/** AI_PROVIDER picks Nova's model: "gemini" (default, free tier) or "claude". */
export function provider(): "gemini" | "claude" {
  return process.env.AI_PROVIDER === "claude" ? "claude" : "gemini";
}

export function runNova(opts: RunOptions): Promise<void> {
  return provider() === "claude" ? runClaude(opts) : runGemini(opts);
}
