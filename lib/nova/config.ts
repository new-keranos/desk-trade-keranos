// Which AI runs Nova and the scanner. No imports, so any module can read it without import cycles.

/** AI_PROVIDER picks the model: "gemini" (default, free tier) or "claude". */
export function provider(): "gemini" | "claude" {
  return process.env.AI_PROVIDER === "claude" ? "claude" : "gemini";
}
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
// gemini-flash-latest always points at Google's current Flash model, which is on the free tier. Override with GEMINI_MODEL.
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
