import type { Metadata } from "next";
import { AuthForm } from "../../features/auth/auth-form";
import { safeNext } from "../../features/auth/safe-next";
import { getT } from "../../i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("auth.signup.metaTitle") };
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  return <AuthForm mode="signup" next={safeNext(next)} />;
}
