// Which AI runs Agent and the scanner. No imports, so any module can read it without import cycles.
// The server default comes from AI_PROVIDER; each request can pick another model the server has a key for.

export type Provider = "gemini" | "claude" | "openai";
export type ModelChoice = { provider: Provider; model: string };
export type ModelOption = ModelChoice & { label: string };

const PROVIDERS: Record<Provider, { name: string; key: string; env: string; fallback: string; models: [string, string][] }> = {
  // gemini-flash-latest always points at Google's current Flash model. Override with GEMINI_MODEL.
  gemini: { name: "Gemini", key: "GEMINI_API_KEY", env: "GEMINI_MODEL", fallback: "gemini-flash-latest",
    models: [["gemini-flash-latest", "Flash"], ["gemini-flash-lite-latest", "Flash-Lite"], ["gemini-pro-latest", "Pro"]] },
  openai: { name: "OpenAI", key: "OPENAI_API_KEY", env: "OPENAI_MODEL", fallback: "gpt-5.4-mini",
    models: [["gpt-5.4-mini", "GPT-5.4 mini"], ["gpt-5.5", "GPT-5.5"], ["gpt-6-luna", "GPT-6 Luna"], ["gpt-6.1-terra", "GPT-6.1 Terra"], ["gpt-6.1-sol", "GPT-6.1 Sol"]] },
  claude: { name: "Claude", key: "ANTHROPIC_API_KEY", env: "CLAUDE_MODEL", fallback: "claude-opus-5-5",
    models: [["claude-haiku-5-5", "Haiku 5.5"], ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-opus-5-5", "Opus 5.5"]] },
};

/** AI_PROVIDER picks the default: "gemini" (default, free tier), "openai" or "claude". */
export function provider(): Provider {
  const p = process.env.AI_PROVIDER;
  return p === "claude" || p === "openai" ? p : "gemini";
}
const envModel = (p: Provider) => process.env[PROVIDERS[p].env] || PROVIDERS[p].fallback;
export const CLAUDE_MODEL = envModel("claude");
export const GEMINI_MODEL = envModel("gemini");

/** Models the server can run: every provider with an API key set, plus the default even without one (so errors name the missing key). */
export function availableModels(): ModelOption[] {
  const def = provider();
  return (Object.keys(PROVIDERS) as Provider[]).filter((p) => p === def || process.env[PROVIDERS[p].key]).flatMap((p) => {
    const list = [...PROVIDERS[p].models];
    const own = envModel(p);
    if (!list.some(([id]) => id === own)) list.unshift([own, own]);
    return list.map(([model, label]) => ({ provider: p, model, label: `${PROVIDERS[p].name} · ${label}` }));
  });
}

export const defaultChoice = (): ModelChoice => ({ provider: provider(), model: envModel(provider()) });

/** The model a request asked for, if the server offers it; otherwise the default. */
export function resolveChoice(v?: Partial<ModelChoice> | null): ModelChoice {
  const hit = v && availableModels().find((m) => m.provider === v.provider && m.model === v.model);
  return hit ? { provider: hit.provider, model: hit.model } : defaultChoice();
}

/** OpenAI's GPT-5 and o-series models take a reasoning effort; older chat models reject it. */
export const reasons = (model: string) => /^(gpt-5|gpt-6|o\d)/.test(model);
