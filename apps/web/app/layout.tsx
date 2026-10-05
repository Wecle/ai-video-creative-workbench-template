import type { Metadata } from "next";
import "./globals.css";
import { I18nProvider } from "../i18n/client";
import { getMessages } from "../i18n/messages";
import { getLocale, getT } from "../i18n/server";
import { Providers } from "./providers";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return {
    title: t("common.appName"),
    description: "AI video creative workbench starter",
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Reading the locale (cookie, then Accept-Language) makes every page dynamic.
  const locale = await getLocale();
  return (
    <html lang={locale}>
      <body>
        <I18nProvider locale={locale} messages={getMessages(locale)}>
          <Providers>{children}</Providers>
        </I18nProvider>
      </body>
    </html>
  );
}
