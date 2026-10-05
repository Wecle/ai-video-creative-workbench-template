import { defaultLocale, isLocale, type Locale } from "./config";

/** Maps one language tag from Accept-Language ("zh", "zh-Hans-CN", "en-US") to a locale. */
function matchTag(tag: string): Locale | undefined {
  const lower = tag.trim().toLowerCase();
  if (lower === "zh-cn") return "zh-CN";
  if (lower === "en") return "en";
  if (lower === "zh" || lower.startsWith("zh-")) return "zh-CN";
  if (lower.startsWith("en-")) return "en";
  return undefined;
}

/**
 * Cookie first (an explicit choice), then the first Accept-Language entry (highest q, in
 * header order) that matches a supported locale, then the default. Pure and synchronous so
 * it is trivially testable; reading cookies and headers is done by the caller.
 */
export function resolveLocale(
  cookie: string | null | undefined,
  acceptLanguage: string | null | undefined,
): Locale {
  if (isLocale(cookie)) return cookie;
  const candidates = (acceptLanguage ?? "")
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.split(";");
      const q = params
        .map((param) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(param)?.[1])
        .find((value) => value !== undefined);
      return { tag, q: q === undefined ? 1 : Number(q), index };
    })
    .filter((entry) => entry.tag.trim() !== "" && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of candidates) {
    const match = matchTag(tag);
    if (match) return match;
  }
  return defaultLocale;
}
