import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, type Locale } from "./config";
import { getMessages } from "./messages";
import { resolveLocale } from "./resolve";
import { createTranslator } from "./translate";

/** Next 15: `cookies()` and `headers()` are async. Using them makes the route dynamic. */
export async function getLocale(): Promise<Locale> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return resolveLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerStore.get("accept-language"),
  );
}

export async function getT() {
  const locale = await getLocale();
  return { locale, t: createTranslator(getMessages(locale)) };
}
