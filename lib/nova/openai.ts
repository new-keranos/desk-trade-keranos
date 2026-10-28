import "server-only";
import OpenAI from "openai";
import { reasons } from "./config";
import { openaiUsage, traceGeneration } from "../telemetry";
import { contextLine, executeTool, MAX_ROUNDS, OUT_OF_ROUNDS, PERSONA, TOOL_SPECS, type RunOptions } from "./tools";

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = TOOL_SPECS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
let client: OpenAI | null = null;

export async function runOpenAI(opts: RunOptions): Promise<void> {
  client ??= new OpenAI();
  const { emit } = opts;
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: PERSONA + "\n\n" + contextLine(opts) },
    ...opts.history.map((t) => ({ role: t.role, content: t.content }) as OpenAI.Chat.ChatCompletionMessageParam),
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await traceGeneration("chat", opts.ai, messages.at(-1), () => client!.chat.completions.create({
      model: opts.ai.model, messages, tools: TOOLS,
      ...(reasons(opts.ai.model) ? { reasoning_effort: opts.effort } : {}),
    }, { signal: opts.signal }), (r) => ({ model: r.model, usage: openaiUsage(r.usage), output: r.choices[0]?.message }));
    const choice = res.choices[0];
    const msg = choice?.message;
    if (msg?.content?.trim()) emit({ type: "text", text: msg.content });
    if (msg?.refusal) { emit({ type: "error", message: "OpenAI declined that request. Try rephrasing it." }); return; }

    const calls = (msg?.tool_calls ?? []).filter((c): c is OpenAI.Chat.ChatCompletionMessageFunctionToolCall => c.type === "function");
    if (!calls.length) {
      if (!msg?.content?.trim()) emit({ type: "error", message: "OpenAI returned no answer. Send again to retry." });
      return;
    }
    messages.push(msg);
    const results = await Promise.all(calls.map(async (c) => {
      let input: unknown = {};
      try { input = JSON.parse(c.function.arguments || "{}"); } catch { /* the tool's validation reports it */ }
      const r = await executeTool(c.function.name, input, emit, opts);
      return { role: "tool" as const, tool_call_id: c.id, content: r.isError ? `Error: ${r.content}` : r.content };
    }));
    messages.push(...results);
  }
  emit({ type: "text", text: OUT_OF_ROUNDS });
}
