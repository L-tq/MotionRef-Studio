/** Tiny dependency-free i18n: flat dotted keys, EN source of truth, zh mirror. */
import { en } from "./en";
import { zh } from "./zh";

export type Locale = "en" | "zh";

const STORAGE_KEY = "mrs.locale";

function detectLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "en" || saved === "zh") return saved;
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

let locale: Locale = detectLocale();
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return locale;
}

export function setLocale(next: Locale): void {
  if (next === locale) return;
  locale = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode */
  }
  document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  listeners.forEach((fn) => fn());
}

export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = locale === "zh" ? zh : en;
  let value = dict[key] ?? en[key] ?? key;
  if (vars) {
    for (const [name, v] of Object.entries(vars)) {
      value = value.replaceAll(`{${name}}`, String(v));
    }
  }
  return value;
}

/** Resolve a stored toast/archive message of the form "key|arg1|arg2…".
 *  Args fill the template's {placeholders} in order of first appearance. */
export function translateMessage(
  message: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const [key, ...args] = message.split("|");
  if (args.length === 0) return t(message);
  const template = t(key);
  const names: string[] = [];
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  const vars: Record<string, string | number> = {};
  names.forEach((name, i) => {
    vars[name] = args[i] ?? "";
  });
  return t(key, vars);
}

// React binding -----------------------------------------------------------
import { useCallback, useSyncExternalStore } from "react";

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, () => "en" as Locale);
}

export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  useLocale();
  return useCallback((key: string, vars?: Record<string, string | number>) => t(key, vars), []);
}
