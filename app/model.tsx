"use client";

import { useEffect, useState } from "react";

// The AI model picker, shared by the Agent console and the pattern scanner.
// The choice lives in this browser and goes with every Agent and scan request.

export type ModelOption = { provider: "gemini" | "claude" | "openai"; model: string; label: string };
type Choice = Pick<ModelOption, "provider" | "model">;

const STORE = "keranos.model.v1";
const EVENT = "keranos:model";
let cache: { models: ModelOption[]; default: Choice } | null = null;

function readStored(): Choice | null {
  try { const v = JSON.parse(localStorage.getItem(STORE) ?? "null"); return v?.provider && v?.model ? v : null; } catch { return null; }
}

/** The model to send with a request; the server falls back to its default if it no longer offers it. */
export const currentModel = (): Choice | undefined => readStored() ?? undefined;

export function useModel() {
  const [models, setModels] = useState<ModelOption[]>(cache?.models ?? []);
  const [choice, setChoice] = useState<Choice | null>(null);
  useEffect(() => {
    let live = true;
    const sync = () => setChoice(readStored() ?? cache?.default ?? null);
    (cache ? Promise.resolve(cache) : fetch("/api/models").then((r) => r.json()).then((j) => (cache = j)))
      .then((c) => { if (!live) return; setModels(c.models ?? []); sync(); })
      .catch(() => {});
    window.addEventListener(EVENT, sync);
    return () => { live = false; window.removeEventListener(EVENT, sync); };
  }, []);
  const pick = (c: Choice) => {
    try { localStorage.setItem(STORE, JSON.stringify(c)); } catch { /* blocked storage: this tab only */ }
    window.dispatchEvent(new Event(EVENT));
  };
  return { models, choice, pick };
}

export function ModelSelect({ className }: { className?: string }) {
  const { models, choice, pick } = useModel();
  if (!models.length) return null;
  const value = choice ? `${choice.provider}|${choice.model}` : "";
  return (
    <select className={className} value={value} aria-label="AI model" title="AI model for Agent and the scanner"
      onChange={(e) => { const [provider, ...rest] = e.target.value.split("|"); pick({ provider: provider as Choice["provider"], model: rest.join("|") }); }}>
      {models.map((m) => <option key={`${m.provider}|${m.model}`} value={`${m.provider}|${m.model}`}>{m.label}</option>)}
    </select>
  );
}
