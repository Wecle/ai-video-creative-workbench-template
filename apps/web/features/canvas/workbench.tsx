"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Download,
  Play,
  Plus,
  Redo2,
  Save,
  Sparkles,
  Undo2,
  Upload,
} from "lucide-react";
import { Badge, Button } from "@creative/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { registry } from "@creative/node-registry";
import { api } from "../../lib/api";
import { authClient } from "../../lib/auth-client";
import { useT } from "../../i18n/client";
import { LocaleSwitcher } from "../../i18n/locale-switcher";
import type { MessageKey } from "../../i18n/messages";
import { UserMenu } from "../auth/user-menu";
import { Canvas } from "./canvas";
import { NodeConfigForm } from "./node-ui";
import { useCanvasPersistence, useCanvasStore } from "./provider";
import { trackRun } from "./run-tracker";
import { uploadAsset, AssetValidationError } from "../assets/upload";
import type { CanvasFlowNode } from "./store";

function NodeTitleForm({ node }: { node: CanvasFlowNode }) {
  const t = useT();
  const renameNode = useCanvasStore((state) => state.renameNode);
  const schema = z.object({
    title: z
      .string()
      .trim()
      .min(1, t("canvas.inspector.titleRequired"))
      .max(120, t("canvas.inspector.titleTooLong")),
  });
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitSuccessful },
  } = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { title: node.data.title },
  });
  return (
    <form
      onSubmit={handleSubmit(({ title }) => renameNode(node.id, title))}
      className="space-y-3"
    >
      <label htmlFor="node-title" className="block text-sm">
        {t("canvas.inspector.nodeTitle")}
      </label>
      <input
        id="node-title"
        {...register("title")}
        aria-invalid={!!errors.title}
        aria-describedby="title-feedback"
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
      <div
        id="title-feedback"
        role="status"
        className="text-xs text-neutral-300"
      >
        {errors.title?.message ??
          (isSubmitSuccessful ? t("canvas.inspector.saved") : "")}
      </div>
      <Button type="submit" variant="outline" className="w-full">
        {t("canvas.inspector.applyTitle")}
      </Button>
    </form>
  );
}

function NodeEditor({ node }: { node: CanvasFlowNode }) {
  const t = useT();
  return (
    <div className="space-y-6">
      <p className="text-xs text-neutral-400">
        {t("canvas.inspector.type", { type: node.type ?? "" })}
      </p>
      <NodeTitleForm node={node} />
      {/* Remount when the config changes from outside (undo, another writer). */}
      <NodeConfigForm
        key={`${node.id}:${JSON.stringify(node.data.config)}`}
        nodeId={node.id}
        type={node.type ?? ""}
        config={node.data.config}
      />
    </div>
  );
}

function isEditable(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function SaveStatusBadge() {
  const t = useT();
  const status = useCanvasStore((state) => state.saveStatus);
  return (
    <Badge role="status" data-save-status={status}>
      {t(`canvas.saveStatus.${status}`)}
    </Badge>
  );
}

export function resolveWorkspaceIdForProject(
  cachedData:
    | {
        projects: Array<{ id: string; workspaceId: string }>;
      }
    | undefined,
  projectId: string,
): string | undefined {
  return cachedData?.projects.find((p) => p.id === projectId)?.workspaceId;
}

function Workbench({
  projectId,
  canvasId,
  canvasName,
}: {
  projectId: string;
  canvasId: string;
  canvasName: string;
}) {
  const t = useT();
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = authClient.useSession();
  const persistence = useCanvasPersistence();
  const health = useQuery({
    queryKey: ["gateway", "health"],
    queryFn: api.health,
    retry: 1,
    refetchInterval: 30000,
  });
  // Exercises the whole chain: access token -> gateway JWT check -> backend identity.
  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    enabled: !!session.data,
    retry: false,
  });
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
    enabled: !!session.data,
  });
  // The middleware only sees the cookie; an expired session is caught here.
  useEffect(() => {
    if (!session.isPending && !session.data) router.replace("/login");
  }, [session.isPending, session.data, router]);

  const selected = useCanvasStore((state) =>
    state.nodes.find((node) => node.id === state.selectedId),
  );
  const addNode = useCanvasStore((state) => state.addNode);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const canUndo = useCanvasStore((state) => state.canUndo);
  const canRedo = useCanvasStore((state) => state.canRedo);
  const saveStatus = useCanvasStore((state) => state.saveStatus);
  const exportSnapshot = useCanvasStore((state) => state.exportSnapshot);
  const notice = useCanvasStore((state) => state.notice);
  const dismissNotice = useCanvasStore((state) => state.dismissNotice);
  const setCanvasRuntime = useCanvasStore((state) => state.setCanvasRuntime);
  const updateNodeRuntime = useCanvasStore((state) => state.updateNodeRuntime);

  const [isRunning, setIsRunning] = useState(false);
  const trackCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      trackCleanupRef.current?.();
    };
  }, []);

  async function handleRun() {
    if (isRunning) return;
    setIsRunning(true);
    try {
      if (saveStatus !== "saved" && saveStatus !== "conflict") {
        await persistence.flush();
      }

      const startRes = await api.startCanvasRun(projectId, canvasId);
      const runId = startRes.run.id;

      const tracker = trackRun({
        projectId,
        canvasId,
        runId,
        api,
        setCanvasRuntime,
        updateNodeRuntime,
        onComplete: () => {
          setIsRunning(false);
        },
        onError: (err) => {
          console.error("Failed to track canvas run", err);
          setIsRunning(false);
        },
      });

      trackCleanupRef.current = tracker.stop;
    } catch (err) {
      console.error("Failed to start canvas run", err);
      setIsRunning(false);
    }
  }

  const [isUploading, setIsUploading] = useState(false);
  const [assetMessage, setAssetMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const cachedProjects =
      queryClient.getQueryData<{
        projects: Array<{ id: string; workspaceId: string }>;
      }>(["projects"]) ?? projectsQuery.data;
    const workspaceId = resolveWorkspaceIdForProject(cachedProjects, projectId);
    if (!workspaceId) {
      setAssetMessage({
        type: "error",
        text: t("canvas.assets.uploadFailed"),
      });
      return;
    }

    setIsUploading(true);
    setAssetMessage(null);
    try {
      await uploadAsset({
        file,
        workspaceId,
        api,
      });
      setAssetMessage({
        type: "success",
        text: t("canvas.assets.uploadSuccess"),
      });
    } catch (err) {
      if (err instanceof AssetValidationError) {
        if (err.code === "INVALID_TYPE") {
          setAssetMessage({
            type: "error",
            text: t("canvas.assets.invalidType"),
          });
        } else if (err.code === "FILE_TOO_LARGE") {
          setAssetMessage({
            type: "error",
            text: t("canvas.assets.fileTooLarge"),
          });
        } else {
          setAssetMessage({
            type: "error",
            text: t("canvas.assets.uploadFailed"),
          });
        }
      } else {
        setAssetMessage({
          type: "error",
          text: t("canvas.assets.uploadFailed"),
        });
      }
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismissNotice, 4000);
    return () => clearTimeout(timer);
  }, [notice, dismissNotice]);

  // Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z (and Ctrl+Y); typing in a field keeps its own undo.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || isEditable(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        (event.shiftKey ? redo : undo)();
      } else if (key === "y") {
        event.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo]);

  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(exportSnapshot(), null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "canvas.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <main className="flex h-dvh min-h-[480px] flex-col overflow-hidden bg-background text-neutral-100">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-3">
          <Sparkles className="size-5 text-brand" />
          <div>
            <h1 className="text-sm font-semibold">{canvasName}</h1>
            <Link
              href="/projects"
              className="text-xs text-neutral-400 underline"
              data-project-id={projectId}
            >
              {t("canvas.backToProjects")}
            </Link>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge role="status">
            {health.isPending
              ? t("canvas.gateway.connecting")
              : health.isError
                ? t("canvas.gateway.offline")
                : t("canvas.gateway.connected")}
          </Badge>
          <Button variant="outline" onClick={undo} disabled={!canUndo}>
            <Undo2 />
            {t("canvas.toolbar.undo")}
          </Button>
          <Button variant="outline" onClick={redo} disabled={!canRedo}>
            <Redo2 />
            {t("canvas.toolbar.redo")}
          </Button>
          <SaveStatusBadge />
          <Button
            variant="outline"
            onClick={() => void persistence.flush()}
            disabled={saveStatus === "saved" || saveStatus === "conflict"}
          >
            <Save />
            {t("canvas.toolbar.save")}
          </Button>
          <Button
            variant="outline"
            onClick={handleRun}
            disabled={isRunning || saveStatus === "conflict"}
          >
            <Play className="size-4 text-brand" />
            {isRunning ? t("canvas.toolbar.running") : t("canvas.toolbar.run")}
          </Button>
          <Button variant="outline" onClick={download}>
            <Download />
            {t("canvas.toolbar.exportJson")}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept="image/png,image/jpeg,image/webp,video/mp4,audio/mpeg,audio/wav"
            onChange={handleFileSelected}
            data-testid="asset-upload-input"
          />
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            data-testid="asset-upload-button"
          >
            <Upload className="size-4" />
            {isUploading
              ? t("canvas.toolbar.uploading")
              : t("canvas.toolbar.uploadAsset")}
          </Button>
          <LocaleSwitcher />
          <UserMenu
            email={session.data?.user.email}
            workspace={me.data?.workspaces[0]?.name}
          />
        </div>
      </header>
      {saveStatus === "conflict" && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-200"
        >
          <span>{t("canvas.conflict")}</span>
          <Button size="sm" onClick={() => window.location.reload()}>
            {t("canvas.reload")}
          </Button>
        </div>
      )}
      {saveStatus === "error" && (
        <div
          role="alert"
          className="border-b border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200"
        >
          {t("canvas.saveError")}
        </div>
      )}
      {assetMessage && (
        <div
          role="alert"
          className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2 text-sm ${
            assetMessage.type === "success"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/40 bg-red-500/10 text-red-200"
          }`}
        >
          <span>{assetMessage.text}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAssetMessage(null)}
          >
            ✕
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          aria-label={t("canvas.paletteLabel")}
          className="flex shrink-0 flex-row gap-2 border-b border-white/10 p-3 md:w-44 md:flex-col md:border-r md:border-b-0"
        >
          {registry.latest().map((definition) => {
            const name = t(`nodes.${definition.type}.title` as MessageKey);
            return (
              <Button
                key={definition.type}
                variant="ghost"
                className="justify-start"
                onClick={() => addNode(definition.type, { title: name })}
              >
                <Plus />
                {name}
              </Button>
            );
          })}
        </aside>
        <section
          aria-label={t("canvas.canvasLabel")}
          className="relative min-h-[260px] min-w-0 flex-1"
        >
          <Canvas />
          {notice && (
            <div
              role="alert"
              className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md border border-red-500/40 bg-panel px-3 py-2 text-sm text-red-300 shadow-lg"
            >
              {t(`canvas.connection.${notice.code}`)}
            </div>
          )}
        </section>
        <aside
          aria-label={t("canvas.inspector.title")}
          className="max-h-56 w-full overflow-auto border-t border-white/10 bg-panel p-4 md:max-h-none md:w-72 md:border-t-0 md:border-l"
        >
          <h2 className="mb-4 text-sm font-semibold">
            {t("canvas.inspector.title")}
          </h2>
          {selected ? (
            <NodeEditor key={selected.id} node={selected} />
          ) : (
            <p className="text-sm leading-6 text-neutral-400">
              {t("canvas.inspector.empty")}
            </p>
          )}
        </aside>
      </div>
    </main>
  );
}

export function CanvasWorkbench(props: {
  projectId: string;
  canvasId: string;
  canvasName: string;
}) {
  return (
    <ReactFlowProvider>
      <Workbench {...props} />
    </ReactFlowProvider>
  );
}
