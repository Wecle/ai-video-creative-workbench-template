const BASE = "http://safe-next.invalid";

function hasUnsafeChar(value: string) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x5c /* \ */ || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Where to go after signing in. Only same-origin paths are allowed so that
 * `/login?next=https://evil.example` cannot become an open redirect.
 */
export function safeNext(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000)
    return "/";
  // "//host" and "/\host" are protocol-relative for browsers; control characters
  // are stripped by URL parsers and can hide a second slash.
  if (value.startsWith("//") || !value.startsWith("/") || hasUnsafeChar(value))
    return "/";
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return "/";
  }
  if (url.origin !== BASE) return "/";
  // Returning to the login pages would only bounce the user around.
  if (/^\/(login|signup)(\/|$)/.test(url.pathname)) return "/";
  return value;
}
