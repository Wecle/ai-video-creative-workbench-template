import { z } from "zod";
export type * from "./events";
export type * from "./tasks";
export type * from "./runtime";

export const healthSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
});
export const meResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
  }),
  workspaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      role: z.string(),
    }),
  ),
});
export type MeResponse = z.infer<typeof meResponseSchema>;
export const agentRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(10000),
  projectId: z.string().max(200).optional(),
  canvasId: z.string().max(200).optional(),
});

export const agentRunStatusSchema = z.enum([
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);
export const agentRunSchema = z.object({
  id: z.uuid(),
  status: agentRunStatusSchema,
  createdAt: z.string(),
  result: z.object({ message: z.string() }).optional(),
  error: z.object({ message: z.string() }).optional(),
});
export const agentRunResponseSchema = z.object({ run: agentRunSchema });
export type AgentRequest = z.infer<typeof agentRequestSchema>;
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;
export type AgentRunView = z.infer<typeof agentRunSchema>;

/** Node and edge ids: short and free of the separators used in derived edge ids. */
export const canvasIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/**
 * Plain-JSON view of a canvas document, derived on the server from the Yjs state.
 * Strict: execution status and viewport are not part of it. Which node types and config
 * values exist is decided by @creative/canvas-doc against the node registry, not here.
 */
export const canvasSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  nodes: z.array(
    z.strictObject({
      id: canvasIdSchema,
      type: z.string().min(1).max(100),
      version: z.number().int().positive(),
      title: z.string().min(1).max(120),
      position: z.strictObject({ x: z.number(), y: z.number() }),
      config: z.record(z.string(), z.unknown()),
    }),
  ),
  edges: z.array(
    z.strictObject({
      id: z.string().min(1).max(300),
      source: canvasIdSchema,
      sourceHandle: z.string().min(1).max(100),
      target: canvasIdSchema,
      targetHandle: z.string().min(1).max(100),
    }),
  ),
});
export type CanvasSnapshot = z.infer<typeof canvasSnapshotSchema>;

export const projectNameSchema = z.string().trim().min(1).max(120);
export const createProjectRequestSchema = z.object({
  name: projectNameSchema,
  /** Default: the caller's oldest workspace. */
  workspaceId: z.uuid().optional(),
});
export const projectSummarySchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  name: z.string(),
  createdAt: z.string(),
  canvases: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
export const projectListResponseSchema = z.object({
  projects: z.array(projectSummarySchema),
});
export const createProjectResponseSchema = z.object({
  project: projectSummarySchema,
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

/**
 * The canvas state travels as base64 inside JSON (one parsing path, validated like every
 * other body). Raw state is therefore limited to roughly 750 KB by the 1 MB body limit.
 */
export const MAX_CANVAS_STATE_CHARS = 1_000_000;
export const canvasMetaSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  version: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export const getCanvasResponseSchema = z.object({
  canvas: canvasMetaSchema,
  /** Yjs document state, base64. */
  state: z.string(),
});
export const saveCanvasRequestSchema = z.object({
  /** The version this state was derived from; the save fails with 409 if it is stale. */
  baseVersion: z.number().int().nonnegative(),
  state: z.base64().max(MAX_CANVAS_STATE_CHARS),
});
export const saveCanvasResponseSchema = z.object({
  version: z.number().int().positive(),
  updatedAt: z.string(),
});
export const canvasSnapshotResponseSchema = z.object({
  version: z.number().int().nonnegative(),
  snapshot: canvasSnapshotSchema,
});
export const canvasConflictSchema = z.object({
  error: z.string(),
  currentVersion: z.number().int().nonnegative(),
});
export const canvasInvalidSchema = z.object({
  error: z.string(),
  /** Codes and paths only; never the offending content. */
  issues: z.array(
    z.object({
      code: z.string(),
      path: z.array(z.union([z.string(), z.number()])),
    }),
  ),
});
export type CanvasMeta = z.infer<typeof canvasMetaSchema>;
export type GetCanvasResponse = z.infer<typeof getCanvasResponseSchema>;
export type SaveCanvasRequest = z.infer<typeof saveCanvasRequestSchema>;
export type SaveCanvasResponse = z.infer<typeof saveCanvasResponseSchema>;
