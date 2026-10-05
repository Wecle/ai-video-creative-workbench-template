import type { Metadata } from "next";
import { AuthForm } from "../../features/auth/auth-form";
import { safeNext } from "../../features/auth/safe-next";

export const metadata: Metadata = {
  title: "Create account · Creative Workbench",
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  return <AuthForm mode="signup" next={safeNext(next)} />;
}
