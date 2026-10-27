import "server-only";
import { runClaude } from "./claude";
import { runGemini } from "./gemini";
import { runOpenAI } from "./openai";
import type { RunOptions } from "./tools";

export type { NovaEvent, Proposal, ChatTurn } from "./tools";

export { availableModels, defaultChoice, provider, resolveChoice, type ModelChoice } from "./config";

export function runNova(opts: RunOptions): Promise<void> {
  const p = opts.ai.provider;
  return p === "claude" ? runClaude(opts) : p === "openai" ? runOpenAI(opts) : runGemini(opts);
}
