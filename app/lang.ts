"use client";

// The reader's language for rule text, AI scan text and the Agent: Thai unless they pick English. Kept in this
// browser and shared by every component through a window event.

import { useEffect, useState } from "react";
import { LANG_EVENT, LANG_STORE, type Lang } from "@/lib/i18n";

export function currentLang(): Lang {
  try { return localStorage.getItem(LANG_STORE) === "en" ? "en" : "th"; } catch { return "th"; }
}

export function setLang(l: Lang) {
  try { localStorage.setItem(LANG_STORE, l); } catch { /* this tab only */ }
  window.dispatchEvent(new CustomEvent(LANG_EVENT, { detail: l }));
}

export function useLang(): Lang {
  const [lang, set] = useState<Lang>("th");
  useEffect(() => {
    set(currentLang());
    const on = (e: Event) => set((e as CustomEvent<Lang>).detail ?? currentLang());
    window.addEventListener(LANG_EVENT, on);
    return () => window.removeEventListener(LANG_EVENT, on);
  }, []);
  return lang;
}
