"use client";

import { useRouter } from "next/navigation";
import {
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  isLocale,
  locales,
} from "./config";
import { useLocale, useT } from "./client";

export function LocaleSwitcher() {
  const router = useRouter();
  const locale = useLocale();
  const t = useT();
  return (
    <select
      aria-label={t("locale.label")}
      value={locale}
      onChange={(event) => {
        if (!isLocale(event.target.value)) return;
        document.cookie = `${LOCALE_COOKIE}=${event.target.value}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
        router.refresh();
      }}
      className="h-9 rounded-md border border-input bg-background px-2 text-sm"
    >
      {locales.map((value) => (
        <option key={value} value={value}>
          {t(`locale.${value}`)}
        </option>
      ))}
    </select>
  );
}
