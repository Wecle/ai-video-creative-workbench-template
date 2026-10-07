"use client";

import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@creative/ui";
import {
  imageGenerateNode,
  registry,
  textNode,
  type AnyNodeDefinition,
  type NodeType,
  type PortDef,
} from "@creative/node-registry";
import { useT } from "../../i18n/client";
import type { MessageKey } from "../../i18n/messages";
import type { Translate } from "../../i18n/translate";
import { useCanvasStore } from "./provider";
import type { CanvasFlowNode } from "./store";

/*
 * Extension point: what a node looks like and how it is configured. Every registry type
 * maps to a renderer (the box on the canvas) and a config form (the inspector); a type
 * without an entry still works and shows `FallbackNode`. Names and port labels come from
 * the message catalog: nodes.<type>.title and nodes.<type>.ports.<portId>.
 */

export type ConfigFormProps = {
  nodeId: string;
  config: Record<string, unknown>;
};
export type NodeUi = {
  Renderer: React.ComponentType<NodeProps<CanvasFlowNode>>;
  ConfigForm: React.ComponentType<ConfigFormProps>;
};

/** `nodes.<type>.<rest>` or a readable fallback when the catalog has no such entry. */
function nodeText(t: Translate, type: string, rest: string, fallback: string) {
  const key = `nodes.${type}.${rest}`;
  const text = t(key as MessageKey);
  return text === key ? fallback : text;
}

const fieldClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

function PortRow({
  type,
  port,
  side,
}: {
  type: string;
  port: PortDef;
  side: "input" | "output";
}) {
  const t = useT();
  return (
    <div
      className={
        "relative px-3 py-1 text-xs text-neutral-300 " +
        (side === "output" ? "text-right" : "")
      }
      title={port.type}
    >
      <Handle
        type={side === "input" ? "target" : "source"}
        position={side === "input" ? Position.Left : Position.Right}
        id={port.id}
        className="!size-3 !bg-brand"
      />
      {nodeText(t, type, `ports.${port.id}`, port.id)}
    </div>
  );
}

function NodeShell({
  id,
  type,
  data,
  selected,
  definition,
  children,
}: NodeProps<CanvasFlowNode> & {
  definition?: AnyNodeDefinition;
  children?: React.ReactNode;
}) {
  const t = useT();
  const select = useCanvasStore((state) => state.select);
  // Runtime layer: nothing writes it yet, so every node is "idle".
  const status = useCanvasStore((state) => state.runtime[id]?.status ?? "idle");
  return (
    <div
      className={
        "w-[230px] rounded-xl border bg-surface shadow-xl " +
        (selected
          ? "border-brand"
          : status === "running"
            ? "border-brand/70"
            : status === "failed"
              ? "border-red-500/70"
              : status === "succeeded"
                ? "border-emerald-500/70"
                : "border-white/15")
      }
    >
      <div className="border-b border-white/10 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-sm font-semibold">{data.title}</div>
          {status !== "idle" && (
            <span
              className={
                "text-xs font-medium " +
                (status === "failed"
                  ? "text-red-400"
                  : status === "succeeded"
                    ? "text-emerald-400"
                    : status === "running"
                      ? "text-brand animate-pulse"
                      : "text-neutral-400")
              }
            >
              {t(`canvas.node.status.${status}`)}
            </span>
          )}
        </div>
        <div className="mt-1 text-xs text-neutral-400">
          {nodeText(t, type, "title", type)}
        </div>
      </div>
      {definition?.inputs.map((port) => (
        <PortRow key={port.id} type={type} port={port} side="input" />
      ))}
      <div className="p-3">
        {children}
        <Button
          variant="outline"
          size="sm"
          className="nodrag nopan mt-3 w-full"
          onClick={() => select(id)}
        >
          {t("canvas.node.configure")}
        </Button>
      </div>
      {definition?.outputs.map((port) => (
        <PortRow key={port.id} type={type} port={port} side="output" />
      ))}
    </div>
  );
}

const preview = "rounded-lg bg-white/5 p-3 text-xs leading-5 text-neutral-400";

function TextNodeView(props: NodeProps<CanvasFlowNode>) {
  const t = useT();
  const text = String(props.data.config.text ?? "");
  return (
    <NodeShell
      {...props}
      definition={registry.get(props.type, props.data.version)}
    >
      <p className={preview + " line-clamp-4 whitespace-pre-wrap"}>
        {text || t("canvas.node.empty")}
      </p>
    </NodeShell>
  );
}

function ImageNodeView(props: NodeProps<CanvasFlowNode>) {
  const t = useT();
  const { prompt, aspectRatio } = props.data.config;
  return (
    <NodeShell
      {...props}
      definition={registry.get(props.type, props.data.version)}
    >
      <p className={preview + " line-clamp-3"}>
        {String(prompt ?? "") || t("canvas.node.empty")}
      </p>
      <p className="mt-2 text-xs text-neutral-500">
        {String(aspectRatio ?? "")}
      </p>
    </NodeShell>
  );
}

/** Used for node types without an entry in `nodeUi` (e.g. a new definition not wired up yet). */
function FallbackNode(props: NodeProps<CanvasFlowNode>) {
  const t = useT();
  return (
    <NodeShell
      {...props}
      definition={registry.get(props.type, props.data.version)}
    >
      <p className={preview}>
        {t("canvas.node.unknown", { type: props.type })}
      </p>
    </NodeShell>
  );
}

/** Shared by config forms: validates with the node's own zod schema, applies via the store. */
function useConfigForm<V extends Record<string, unknown>>(
  definition: AnyNodeDefinition,
  { nodeId, config }: ConfigFormProps,
) {
  const t = useT();
  const updateConfig = useCanvasStore((state) => state.updateConfig);
  const [applied, setApplied] = useState(false);
  const form = useForm<V>({
    resolver: zodResolver(definition.config as never) as never,
    defaultValues: config as never,
  });
  const submit = form.handleSubmit((values) => {
    const result = updateConfig(nodeId, values);
    setApplied(result.ok);
    if (!result.ok)
      form.setError("root", { message: t("canvas.inspector.invalid") });
  });
  return { t, form, submit, applied, setApplied };
}

function FormFooter({
  t,
  applied,
  rootError,
}: {
  t: Translate;
  applied: boolean;
  rootError?: string;
}) {
  return (
    <>
      <div role="status" className="text-xs text-neutral-300">
        {rootError ?? (applied ? t("canvas.inspector.saved") : "")}
      </div>
      <Button type="submit" className="w-full">
        {t("canvas.inspector.applyConfig")}
      </Button>
    </>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} role="alert" className="text-xs text-red-400">
      {message}
    </p>
  ) : null;
}

function TextConfigForm(props: ConfigFormProps) {
  const { t, form, submit, applied, setApplied } = useConfigForm<{
    text: string;
  }>(textNode, props);
  const { errors } = form.formState;
  return (
    <form
      onSubmit={submit}
      onChange={() => setApplied(false)}
      className="space-y-3"
    >
      <label htmlFor="config-text" className="block text-sm">
        {t("nodes.text.fields.text")}
      </label>
      <textarea
        id="config-text"
        rows={6}
        aria-invalid={!!errors.text}
        aria-describedby={errors.text ? "config-text-error" : undefined}
        className={fieldClass}
        {...form.register("text")}
      />
      <FieldError id="config-text-error" message={errors.text?.message} />
      <FormFooter t={t} applied={applied} rootError={errors.root?.message} />
    </form>
  );
}

function ImageConfigForm(props: ConfigFormProps) {
  const { t, form, submit, applied, setApplied } = useConfigForm<{
    prompt: string;
    aspectRatio: string;
  }>(imageGenerateNode, props);
  const { errors } = form.formState;
  return (
    <form
      onSubmit={submit}
      onChange={() => setApplied(false)}
      className="space-y-3"
    >
      <label htmlFor="config-prompt" className="block text-sm">
        {t("nodes.image.generate.fields.prompt")}
      </label>
      <textarea
        id="config-prompt"
        rows={5}
        aria-invalid={!!errors.prompt}
        aria-describedby={errors.prompt ? "config-prompt-error" : undefined}
        className={fieldClass}
        {...form.register("prompt")}
      />
      <FieldError id="config-prompt-error" message={errors.prompt?.message} />
      <label htmlFor="config-aspect" className="block text-sm">
        {t("nodes.image.generate.fields.aspectRatio")}
      </label>
      <select
        id="config-aspect"
        aria-invalid={!!errors.aspectRatio}
        className={fieldClass}
        {...form.register("aspectRatio")}
      >
        {["1:1", "16:9", "9:16"].map((ratio) => (
          <option key={ratio} value={ratio}>
            {ratio}
          </option>
        ))}
      </select>
      <FieldError
        id="config-aspect-error"
        message={errors.aspectRatio?.message}
      />
      <FormFooter t={t} applied={applied} rootError={errors.root?.message} />
    </form>
  );
}

export const nodeUi: Record<NodeType, NodeUi> = {
  text: { Renderer: TextNodeView, ConfigForm: TextConfigForm },
  "image.generate": { Renderer: ImageNodeView, ConfigForm: ImageConfigForm },
};

export function uiFor(type: string): NodeUi | undefined {
  return (nodeUi as Record<string, NodeUi | undefined>)[type];
}

/** React Flow `nodeTypes`: one stable object, built once from the registry. */
export const nodeTypes: Record<string, NodeUi["Renderer"]> = Object.fromEntries(
  registry
    .list()
    .map((definition) => [
      definition.type,
      uiFor(definition.type)?.Renderer ?? FallbackNode,
    ]),
);

/** Inspector body for a node, falling back to a short note for unmapped types. */
export function NodeConfigForm({
  nodeId,
  type,
  config,
}: ConfigFormProps & { type: string }) {
  const t = useT();
  const ui = uiFor(type);
  if (!ui)
    return (
      <p className="text-sm text-neutral-400">
        {t("canvas.node.unknown", { type })}
      </p>
    );
  return <ui.ConfigForm nodeId={nodeId} config={config} />;
}
