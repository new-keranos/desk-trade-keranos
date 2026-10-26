import "server-only";
import { runClaude } from "./claude";
import { runGemini } from "./gemini";
import type { RunOptions } from "./tools";

export type { NovaEvent, Proposal, ChatTurn } from "./tools";

import { provider } from "./config";
export { provider } from "./config";

export function runNova(opts: RunOptions): Promise<void> {
  return provider() === "claude" ? runClaude(opts) : runGemini(opts);
}
