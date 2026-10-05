import type { MessageKey } from "./messages";

export type TranslateVars = Record<string, string | number>;
export type Translate = (key: MessageKey, vars?: TranslateVars) => string;

/** `{name}` placeholders; an unknown placeholder is left as written. */
export function interpolate(template: string, vars?: TranslateVars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** `messages` is already merged with the fallback; a key missing from it returns the key. */
export function createTranslator(
  messages: Readonly<Record<string, string>>,
): Translate {
  return (key, vars) => interpolate(messages[key] ?? key, vars);
}
