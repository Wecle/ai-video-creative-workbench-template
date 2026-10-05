"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@creative/ui";
import { authClient } from "../../lib/auth-client";
import { clearAccessToken } from "../../lib/access-token";
import { authCopy as copy } from "./copy";

type Mode = "login" | "signup";

const fieldClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

const loginSchema = z.object({
  email: z.string().trim().pipe(z.email(copy.validation.email)),
  password: z
    .string()
    .min(8, copy.validation.passwordMin)
    .max(128, copy.validation.passwordMax),
});
const signupSchema = loginSchema.extend({
  name: z.string().trim().min(1, copy.validation.name).max(100),
});
type FormValues = z.infer<typeof signupSchema>;

export function AuthForm({ mode, next }: { mode: Mode; next: string }) {
  const router = useRouter();
  const text = copy[mode];
  const [serverError, setServerError] = useState<string>();
  const [googlePending, setGooglePending] = useState(false);
  const session = authClient.useSession();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(
      mode === "signup" ? signupSchema : loginSchema,
    ) as never,
  });

  // The cookie alone proves nothing (it may be expired), so ask the server.
  useEffect(() => {
    if (session.data) router.replace(next);
  }, [session.data, next, router]);

  async function onSubmit(values: FormValues) {
    setServerError(undefined);
    clearAccessToken();
    try {
      const { error } =
        mode === "signup"
          ? await authClient.signUp.email({
              name: values.name,
              email: values.email,
              password: values.password,
            })
          : await authClient.signIn.email({
              email: values.email,
              password: values.password,
            });
      if (error) {
        setServerError(error.message || copy.genericError);
        return;
      }
      router.replace(next);
      router.refresh();
    } catch {
      setServerError(copy.genericError);
    }
  }

  async function google() {
    setServerError(undefined);
    setGooglePending(true);
    try {
      const { error } = await authClient.signIn.social({
        provider: "google",
        callbackURL: next,
      });
      if (error) setServerError(error.message || copy.genericError);
    } catch {
      setServerError(copy.genericError);
    } finally {
      setGooglePending(false);
    }
  }

  const other = mode === "login" ? "/signup" : "/login";
  const otherHref =
    next === "/" ? other : `${other}?next=${encodeURIComponent(next)}`;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#090909] p-4 text-neutral-100">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">{text.title}</h1>
          <p className="text-sm text-neutral-400">{text.description}</p>
        </div>
        <form
          onSubmit={handleSubmit(onSubmit)}
          noValidate
          className="space-y-4"
        >
          {mode === "signup" && (
            <div className="space-y-1">
              <label htmlFor="name" className="block text-sm">
                {copy.fields.name}
              </label>
              <input
                id="name"
                autoComplete="name"
                aria-invalid={!!errors.name}
                aria-describedby={errors.name ? "name-error" : undefined}
                className={fieldClass}
                {...register("name")}
              />
              {errors.name && (
                <p
                  id="name-error"
                  role="alert"
                  className="text-xs text-red-400"
                >
                  {errors.name.message}
                </p>
              )}
            </div>
          )}
          <div className="space-y-1">
            <label htmlFor="email" className="block text-sm">
              {copy.fields.email}
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? "email-error" : undefined}
              className={fieldClass}
              {...register("email")}
            />
            {errors.email && (
              <p id="email-error" role="alert" className="text-xs text-red-400">
                {errors.email.message}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <label htmlFor="password" className="block text-sm">
              {copy.fields.password}
            </label>
            <input
              id="password"
              type="password"
              autoComplete={
                mode === "signup" ? "new-password" : "current-password"
              }
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? "password-error" : undefined}
              className={fieldClass}
              {...register("password")}
            />
            {errors.password && (
              <p
                id="password-error"
                role="alert"
                className="text-xs text-red-400"
              >
                {errors.password.message}
              </p>
            )}
          </div>
          {serverError && (
            <p role="alert" className="text-sm text-red-400">
              {serverError}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? text.submitting : text.submit}
          </Button>
        </form>
        <div className="flex items-center gap-3 text-xs text-neutral-500">
          <span className="h-px flex-1 bg-white/10" />
          {copy.or}
          <span className="h-px flex-1 bg-white/10" />
        </div>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={googlePending}
          onClick={google}
        >
          {copy.google}
        </Button>
        <p className="text-center text-sm text-neutral-400">
          {text.switchPrompt}{" "}
          <Link href={otherHref} className="text-violet-300 underline">
            {text.switchLink}
          </Link>
        </p>
      </div>
    </main>
  );
}
