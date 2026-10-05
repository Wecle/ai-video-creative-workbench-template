"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@creative/ui";
import { api } from "../../lib/api";
import { authClient } from "../../lib/auth-client";
import { useT } from "../../i18n/client";
import { LocaleSwitcher } from "../../i18n/locale-switcher";
import { UserMenu } from "../auth/user-menu";

export function ProjectsPage() {
  const t = useT();
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = authClient.useSession();
  // The middleware only sees the cookie; an expired session is caught here.
  useEffect(() => {
    if (!session.isPending && !session.data) router.replace("/login");
  }, [session.isPending, session.data, router]);

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
    enabled: !!session.data,
    retry: false,
  });
  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    enabled: !!session.data,
    retry: false,
  });

  const schema = useMemo(
    () =>
      z.object({
        name: z
          .string()
          .trim()
          .min(1, t("projects.nameRequired"))
          .max(120, t("projects.nameTooLong")),
      }),
    [t],
  );
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });
  const create = useMutation({
    mutationFn: (values: z.infer<typeof schema>) =>
      api.createProject({ name: values.name }),
    onSuccess: async ({ project }) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      const canvas = project.canvases[0];
      if (canvas) router.push(`/p/${project.id}/canvas/${canvas.id}`);
    },
  });

  return (
    <main className="mx-auto min-h-dvh max-w-3xl space-y-8 p-6 text-neutral-100">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{t("projects.title")}</h1>
          <p className="text-sm text-neutral-400">
            {t("projects.description")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LocaleSwitcher />
          <UserMenu
            email={session.data?.user.email}
            workspace={me.data?.workspaces[0]?.name}
          />
        </div>
      </header>

      <form
        onSubmit={handleSubmit((values) => create.mutate(values))}
        noValidate
        className="flex flex-wrap items-start gap-3"
      >
        <div className="min-w-60 flex-1 space-y-1">
          <label htmlFor="project-name" className="block text-sm">
            {t("projects.nameLabel")}
          </label>
          <input
            id="project-name"
            placeholder={t("projects.namePlaceholder")}
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "project-name-error" : undefined}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            {...register("name")}
          />
          {errors.name && (
            <p
              id="project-name-error"
              role="alert"
              className="text-xs text-red-400"
            >
              {errors.name.message}
            </p>
          )}
          {create.isError && (
            <p role="alert" className="text-xs text-red-400">
              {t("projects.createError")}
            </p>
          )}
        </div>
        <Button type="submit" className="mt-6" disabled={create.isPending}>
          {create.isPending ? t("projects.creating") : t("projects.create")}
        </Button>
      </form>

      <section aria-label={t("projects.listLabel")}>
        {projects.isPending ? (
          <p className="text-sm text-neutral-400">{t("common.loading")}</p>
        ) : projects.isError ? (
          <p role="alert" className="text-sm text-red-400">
            {t("projects.loadError")}
          </p>
        ) : projects.data.projects.length === 0 ? (
          <p className="text-sm text-neutral-400">{t("projects.empty")}</p>
        ) : (
          <ul className="divide-y divide-white/10 rounded-lg border border-white/10">
            {projects.data.projects.map((project) => (
              <li
                key={project.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <span className="truncate text-sm font-medium">
                  {project.name}
                </span>
                {project.canvases[0] && (
                  <Link
                    href={`/p/${project.id}/canvas/${project.canvases[0].id}`}
                    className="text-sm text-brand underline"
                  >
                    {t("projects.open")}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
