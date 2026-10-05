/**
 * Runtime layer of a canvas: what is happening to a node right now (execution status).
 * Never persisted in the canvas document. Types only: the store keeps a
 * `CanvasRuntime` ({} until execution exists) and renderers read `runtime[id]?.status`.
 */
export type NodeRuntimeStatus =
  "idle" | "queued" | "running" | "succeeded" | "failed";

export type NodeRuntime = {
  status: NodeRuntimeStatus;
  /** Localizable error code, not free text. */
  error?: string;
};

export type CanvasRuntime = Record<string, NodeRuntime>;
