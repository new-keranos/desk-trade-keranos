import "server-only";
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import { geminiUsage, traceGeneration } from "../telemetry";
import { contextLine, executeTool, MAX_ROUNDS, OUT_OF_ROUNDS, PERSONA, TOOL_SPECS, type RunOptions } from "./tools";


const FUNCTIONS = TOOL_SPECS.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema }));
let ai: GoogleGenAI | null = null;

export async function runGemini(opts: RunOptions): Promise<void> {
  ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const { emit } = opts;
  const contents: Content[] = opts.history.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] }));

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await traceGeneration("chat", opts.ai, contents.at(-1), () => ai!.models.generateContent({
      model: opts.ai.model,
      contents,
      config: {
        systemInstruction: PERSONA + "\n\n" + contextLine(opts),
        tools: [{ functionDeclarations: FUNCTIONS }],
        abortSignal: opts.signal,
      },
    }), (r) => ({ model: r.modelVersion, usage: geminiUsage(r), output: r.candidates?.[0]?.content }));

    const modelContent = res.candidates?.[0]?.content;
    const parts = modelContent?.parts ?? [];
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
    if (text) emit({ type: "text", text });

    const calls = res.functionCalls ?? [];
    if (!calls.length) {
      if (!text) {
        const reason = res.candidates?.[0]?.finishReason ?? res.promptFeedback?.blockReason;
        emit({ type: "error", message: reason === "SAFETY" || res.promptFeedback?.blockReason ? "Gemini declined that request. Try rephrasing it." : "Gemini returned no answer. Send again to retry." });
      }
      return;
    }

    // Send the model turn back unchanged so thought signatures are kept.
    contents.push(modelContent ?? { role: "model", parts: calls.map((c) => ({ functionCall: c })) });
    const responses: Part[] = await Promise.all(
      calls.map(async (c) => {
        const r = await executeTool(c.name ?? "", c.args, emit, opts);
        return { functionResponse: { id: c.id, name: c.name, response: r.isError ? { error: r.content } : { output: r.content } } };
      }),
    );
    contents.push({ role: "user", parts: responses });
  }
  emit({ type: "text", text: OUT_OF_ROUNDS });
}
