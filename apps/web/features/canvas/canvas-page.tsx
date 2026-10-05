"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@creative/api-client";
import { api } from "../../lib/api";
import { useT } from "../../i18n/client";
import { CanvasProvider } from "./provider";
import { CanvasWorkbench } from "./workbench";

export function CanvasPage({
  projectId,
  canvasId,
}: {
  projectId: string;
  canvasId: string;
}) {
  const t = useT();
  // The loaded state seeds an editing session; refetching it behind the session's back
  // would be wrong, so this is fetched once per visit and never refreshed on its own.
  const canvas = useQuery({
    queryKey: ["canvas", projectId, canvasId],
    queryFn: () => api.getCanvas(projectId, canvasId),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  if (canvas.isPending)
    return (
      <p className="p-6 text-sm text-neutral-400">{t("canvas.loading")}</p>
    );
  if (canvas.isError) {
    const notFound =
      canvas.error instanceof ApiError && canvas.error.status === 404;
    return (
      <main className="space-y-3 p-6 text-sm">
        <p role="alert" className="text-red-400">
          {notFound ? t("canvas.notFound") : t("canvas.loadError")}
        </p>
        <Link href="/projects" className="text-brand underline">
          {t("canvas.backToProjects")}
        </Link>
      </main>
    );
  }
  const { canvas: meta, state } = canvas.data;
  return (
    <CanvasProvider
      state={state}
      version={meta.version}
      save={({ baseVersion, state }) =>
        api.saveCanvas(projectId, canvasId, { baseVersion, state })
      }
    >
      <CanvasWorkbench projectId={projectId} canvasName={meta.name} />
    </CanvasProvider>
  );
}
