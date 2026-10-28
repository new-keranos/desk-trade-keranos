import "server-only";
import OpenAI from "openai";
import { reasons } from "./config";
import { openaiResponsesUsage, traceGeneration } from "../telemetry";
import { contextLine, executeTool, MAX_ROUNDS, OUT_OF_ROUNDS, PERSONA, TOOL_SPECS, type RunOptions } from "./tools";

// The Responses API: newer GPT-5 models reject function tools together with reasoning on Chat Completions.
const TOOLS: OpenAI.Responses.FunctionTool[] = TOOL_SPECS.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema, strict: false }));
let client: OpenAI | null = null;

export async function runOpenAI(opts: RunOptions): Promise<void> {
  client ??= new OpenAI();
  const { emit } = opts;
  const think = reasons(opts.ai.model);
  const input: OpenAI.Responses.ResponseInputItem[] = opts.history.map((t) => ({ role: t.role, content: t.content }));

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await traceGeneration("chat", opts.ai, input.at(-1), () => client!.responses.create({
      model: opts.ai.model, instructions: PERSONA + "\n\n" + contextLine(opts), input, tools: TOOLS,
      // Nothing is stored at OpenAI; reasoning is handed back encrypted so it carries across tool rounds.
      store: false,
      ...(think ? { reasoning: { effort: opts.effort }, include: ["reasoning.encrypted_content" as const] } : {}),
    }, { signal: opts.signal }), (r) => ({ model: r.model, usage: openaiResponsesUsage(r.usage), output: r.output_text }));

    const refused = res.output.some((o) => o.type === "message" && o.content.some((c) => c.type === "refusal"));
    if (refused) { emit({ type: "error", message: "OpenAI declined that request. Try rephrasing it." }); return; }
    const text = res.output_text?.trim();
    if (text) emit({ type: "text", text });

    const calls = res.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call");
    if (!calls.length) {
      if (!text) emit({ type: "error", message: res.incomplete_details?.reason ? `OpenAI stopped early (${res.incomplete_details.reason}). Send again to retry.` : "OpenAI returned no answer. Send again to retry." });
      return;
    }
    input.push(...(res.output as OpenAI.Responses.ResponseInputItem[]));
    const results = await Promise.all(calls.map(async (c) => {
      let args: unknown = {};
      try { args = JSON.parse(c.arguments || "{}"); } catch { /* the tool's validation reports it */ }
      const r = await executeTool(c.name, args, emit, opts);
      return { type: "function_call_output" as const, call_id: c.call_id, output: r.isError ? `Error: ${r.content}` : r.content };
    }));
    input.push(...results);
  }
  emit({ type: "text", text: OUT_OF_ROUNDS });
}
