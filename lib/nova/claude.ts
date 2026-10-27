import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { contextLine, executeTool, MAX_ROUNDS, OUT_OF_ROUNDS, PERSONA, TOOL_SPECS, type RunOptions } from "./tools";

const TOOLS: Anthropic.Tool[] = TOOL_SPECS;
let client: Anthropic | null = null;

export async function runClaude(opts: RunOptions): Promise<void> {
  client ??= new Anthropic();
  const { emit } = opts;
  const messages: Anthropic.MessageParam[] = [...opts.history];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Server-side fallback on refusal; the SDK types may not list `fallbacks` yet.
    const params = {
      model: opts.ai.model,
      max_tokens: 16000,
      system: [
        { type: "text" as const, text: PERSONA, cache_control: { type: "ephemeral" as const } },
        { type: "text" as const, text: contextLine(opts) },
      ],
      tools: TOOLS,
      messages,
      // Haiku has no effort setting.
      ...(opts.ai.model.includes("haiku") ? {} : { output_config: { effort: opts.effort } }),
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
    const response = (await client.beta.messages.create(params as any, { signal: opts.signal })) as unknown as Anthropic.Message;

    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) emit({ type: "text", text: block.text });
    }
    if (response.stop_reason === "refusal") {
      emit({ type: "error", message: "Nova declined that request. Try rephrasing it." });
      return;
    }
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || uses.length === 0) return;

    messages.push({ role: "assistant", content: response.content });
    const results = await Promise.all(
      uses.map(async (u): Promise<Anthropic.ToolResultBlockParam> => {
        const r = await executeTool(u.name, u.input, emit, opts);
        return { type: "tool_result", tool_use_id: u.id, is_error: r.isError || undefined, content: r.content };
      }),
    );
    messages.push({ role: "user", content: results });
  }
  emit({ type: "text", text: OUT_OF_ROUNDS });
}
