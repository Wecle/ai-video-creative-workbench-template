"use client";
import { useEffect } from "react";
import { Download, Plus, RotateCcw, Sparkles } from "lucide-react";
import { Badge, Button } from "@creative/ui";
import { useQuery } from "@tanstack/react-query";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter } from "next/navigation";
import { api } from "../../lib/api";
import { authClient } from "../../lib/auth-client";
import { UserMenu } from "../auth/user-menu";
import { Canvas } from "../canvas/canvas";
import {
  exportDocument,
  useCanvasStore,
  type StarterNode,
} from "../canvas/store";

const titleSchema = z.object({
  title: z.string().trim().min(1, "Enter a title").max(120),
});
function NodeEditor({ node }: { node: StarterNode }) {
  const rename = useCanvasStore((state) => state.rename);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitSuccessful },
  } = useForm<z.infer<typeof titleSchema>>({
    resolver: zodResolver(titleSchema),
    defaultValues: { title: node.data.title },
  });
  return (
    <form
      onSubmit={handleSubmit(({ title }) => rename(node.id, title))}
      className="space-y-4"
    >
      <p className="text-xs text-neutral-400">{node.data.kind}</p>
      <label htmlFor="node-title" className="block text-sm">
        Node title
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
          (isSubmitSuccessful
            ? "Updated for this session"
            : "Maximum 120 characters")}
      </div>
      <Button type="submit" className="w-full">
        Apply title
      </Button>
      <p className="text-xs leading-5 text-neutral-400">
        Connect provider settings and task execution here when extending the
        template.
      </p>
    </form>
  );
}
function Workbench() {
  const health = useQuery({
    queryKey: ["gateway", "health"],
    queryFn: api.health,
    retry: 1,
    refetchInterval: 30000,
  });
  const router = useRouter();
  const session = authClient.useSession();
  // Exercises the whole chain: access token -> gateway JWT check -> backend identity.
  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    enabled: !!session.data,
    retry: false,
  });
  // The middleware only sees the cookie; an expired session is caught here.
  useEffect(() => {
    if (!session.isPending && !session.data) router.replace("/login");
  }, [session.isPending, session.data, router]);
  const selected = useCanvasStore((state) =>
    state.nodes.find((node) => node.id === state.selectedId),
  );
  const addNode = useCanvasStore((state) => state.addNode);
  const reset = useCanvasStore((state) => state.reset);
  const { getViewport } = useReactFlow();
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(exportDocument(getViewport()), null, 2)], {
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
    <main className="flex h-dvh min-h-[480px] flex-col overflow-hidden bg-[#090909] text-neutral-100">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-3">
          <Sparkles className="size-5 text-violet-300" />
          <div>
            <h1 className="text-sm font-semibold">Creative Workbench</h1>
            <p className="text-xs text-neutral-400">
              Template playground · session only
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge role="status">
            {health.isPending
              ? "Connecting gateway…"
              : health.isError
                ? "Gateway offline"
                : "Gateway connected"}
          </Badge>
          <Button variant="outline" onClick={download}>
            <Download />
            Export JSON
          </Button>
          <UserMenu
            email={session.data?.user.email}
            workspace={me.data?.workspaces[0]?.name}
          />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          aria-label="Node palette"
          className="flex shrink-0 flex-row gap-2 border-b border-white/10 p-3 md:w-40 md:flex-col md:border-r md:border-b-0"
        >
          {(["text", "image.generate", "video.generate"] as const).map(
            (kind) => (
              <Button
                key={kind}
                variant="ghost"
                className="justify-start"
                onClick={() => addNode(kind)}
              >
                <Plus />
                {kind.split(".")[0]}
              </Button>
            ),
          )}
          <Button variant="outline" className="md:mt-auto" onClick={reset}>
            <RotateCcw />
            Reset demo
          </Button>
        </aside>
        <section
          aria-label="Creative canvas"
          className="relative min-h-[260px] min-w-0 flex-1"
        >
          <Canvas />
        </section>
        <aside
          aria-label="Node inspector"
          className="max-h-56 w-full overflow-auto border-t border-white/10 bg-[#0d0d0d] p-4 md:max-h-none md:w-72 md:border-t-0 md:border-l"
        >
          <h2 className="mb-4 text-sm font-semibold">Inspector</h2>
          {selected ? (
            <NodeEditor key={selected.id} node={selected} />
          ) : (
            <p className="text-sm leading-6 text-neutral-400">
              Select a node to edit its title. Drag nodes, connect ports, or use
              the palette to add examples.
            </p>
          )}
          <p className="mt-6 text-xs leading-5 text-neutral-400">
            Changes stay in memory until you export. Generation execution is an
            extension point.
          </p>
        </aside>
      </div>
    </main>
  );
}
export function Workspace() {
  return (
    <ReactFlowProvider>
      <Workbench />
    </ReactFlowProvider>
  );
}
