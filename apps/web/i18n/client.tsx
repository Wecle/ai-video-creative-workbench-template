"use client";

import { createContext, useContext, useMemo } from "react";
import type { Locale } from "./config";
import { createTranslator, type Translate } from "./translate";

type I18n = { locale: Locale; t: Translate };
const I18nContext = createContext<I18n | null>(null);

/** Receives the current language's merged catalog from the server layout. */
export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Record<string, string>;
  children: React.ReactNode;
}) {
  const value = useMemo(
    () => ({ locale, t: createTranslator(messages) }),
    [locale, messages],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useT must be used inside <I18nProvider>");
  return value;
}
export const useT = (): Translate => useI18n().t;
export const useLocale = (): Locale => useI18n().locale;
