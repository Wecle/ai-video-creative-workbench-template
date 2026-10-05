import type { Locale } from "../config";
import { en } from "./en";
import { zhCN } from "./zh-CN";

export type { MessageKey, Messages, DeepPartial } from "./types";

/** Flattens a nested catalog to { "a.b.c": "text" }. */
export function flatten(
  tree: object,
  prefix = "",
  out: Record<string, string> = {},
): Record<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === "string") out[prefix + key] = value;
    else if (value && typeof value === "object")
      flatten(value, `${prefix}${key}.`, out);
  }
  return out;
}

const catalogs = { en: flatten(en), "zh-CN": flatten(zhCN) } as const;
export const englishMessages: Readonly<Record<string, string>> = catalogs.en;
export function localeCatalog(
  locale: Locale,
): Readonly<Record<string, string>> {
  return catalogs[locale];
}

/** The locale's catalog over the English one: what a client needs for one language. */
export function getMessages(locale: Locale): Record<string, string> {
  return { ...catalogs.en, ...catalogs[locale] };
}
