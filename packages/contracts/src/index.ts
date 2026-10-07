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

export const canvasRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const nodeRunStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export const startCanvasRunRequestSchema = z.strictObject({
  mockMode: z.enum(["polling", "callback"]).optional(),
});
export const nodeRunSummarySchema = z.object({
  id: z.uuid(),
  nodeId: canvasIdSchema,
  nodeType: z.string().min(1).max(100),
  provider: z.string().nullable().optional(),
  externalJobId: z.string().nullable().optional(),
  status: nodeRunStatusSchema,
  inputs: z.record(z.string(), z.unknown()).nullable().optional(),
  outputs: z.record(z.string(), z.unknown()).nullable().optional(),
  error: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
});
export const canvasRunSummarySchema = z.object({
  id: z.uuid(),
  canvasId: z.uuid(),
  projectId: z.uuid(),
  status: canvasRunStatusSchema,
  canvasVersion: z.number().int().nonnegative(),
  error: z.string().nullable().optional(),
  createdBy: z.uuid().nullable().optional(),
  createdAt: z.string(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  nodeRuns: z.array(nodeRunSummarySchema),
});
export const startCanvasRunResponseSchema = z.object({
  run: canvasRunSummarySchema,
});
export const getCanvasRunResponseSchema = z.object({
  run: canvasRunSummarySchema,
});

export type CanvasRunStatus = z.infer<typeof canvasRunStatusSchema>;
export type NodeRunStatus = z.infer<typeof nodeRunStatusSchema>;
export type StartCanvasRunRequest = z.infer<typeof startCanvasRunRequestSchema>;
export type NodeRunSummary = z.infer<typeof nodeRunSummarySchema>;
export type CanvasRunSummary = z.infer<typeof canvasRunSummarySchema>;
export type StartCanvasRunResponse = z.infer<
  typeof startCanvasRunResponseSchema
>;
export type GetCanvasRunResponse = z.infer<typeof getCanvasRunResponseSchema>;

export function toNodeRuntime(
  status: NodeRunStatus,
): import("./runtime").NodeRuntimeStatus {
  switch (status) {
    case "pending":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
    case "cancelled":
      return "failed";
  }
}

export function runEventsChannel(runId: string): string {
  return `run-events:${runId}`;
}

export function runEventsSeqKey(runId: string): string {
  return `run-events:${runId}:seq`;
}

export const runStatusEventSchema = z.strictObject({
  type: z.literal("run.status"),
  runId: z.string().uuid(),
  seq: z.number().int().positive(),
  status: canvasRunStatusSchema,
  error: z.string().nullable().optional(),
});
export type RunStatusEvent = z.infer<typeof runStatusEventSchema>;

export const nodeStatusEventSchema = z.strictObject({
  type: z.literal("node.status"),
  runId: z.string().uuid(),
  seq: z.number().int().positive(),
  nodeId: canvasIdSchema,
  status: nodeRunStatusSchema,
  error: z.string().nullable().optional(),
});
export type NodeStatusEvent = z.infer<typeof nodeStatusEventSchema>;

export const runEventSchema = z.discriminatedUnion("type", [
  runStatusEventSchema,
  nodeStatusEventSchema,
]);
export type RunEvent = z.infer<typeof runEventSchema>;

export const runSnapshotNodeSchema = z.strictObject({
  nodeId: canvasIdSchema,
  status: nodeRunStatusSchema,
  error: z.string().nullable().optional(),
});
export type RunSnapshotNode = z.infer<typeof runSnapshotNodeSchema>;

export const runSnapshotEventSchema = z.strictObject({
  type: z.literal("snapshot"),
  runId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  status: canvasRunStatusSchema,
  error: z.string().nullable().optional(),
  nodes: z.array(runSnapshotNodeSchema),
});
export type RunSnapshotEvent = z.infer<typeof runSnapshotEventSchema>;

export const runPingEventSchema = z.strictObject({
  type: z.literal("ping"),
  seq: z.number().int().nonnegative(),
});
export type RunPingEvent = z.infer<typeof runPingEventSchema>;

export const runDoneEventSchema = z.strictObject({
  type: z.literal("done"),
  status: canvasRunStatusSchema,
});
export type RunDoneEvent = z.infer<typeof runDoneEventSchema>;

export const realtimeStreamEventSchema = z.discriminatedUnion("type", [
  runSnapshotEventSchema,
  runPingEventSchema,
  runDoneEventSchema,
  runStatusEventSchema,
  nodeStatusEventSchema,
]);
export type RealtimeStreamEvent = z.infer<typeof realtimeStreamEventSchema>;

export const realtimeTicketRequestSchema = z.union([
  z.strictObject({
    runId: z.string().uuid(),
  }),
  z.strictObject({
    agentRunId: z.string().uuid(),
  }),
]);
export type RealtimeTicketRequest = z.infer<typeof realtimeTicketRequestSchema>;

export const realtimeTicketResponseSchema = z.strictObject({
  ticket: z.string(),
  expiresIn: z.number().int().positive(),
  baseUrl: z.string().url(),
});
export type RealtimeTicketResponse = z.infer<
  typeof realtimeTicketResponseSchema
>;

export * from "./assets";
export * from "./media";

// ==========================================
// Agent Loop schemas and types
// ==========================================

export const AGENT_PATCH_MAX_OPS = 50;

export const canvasPatchAddNodeOpSchema = z.strictObject({
  op: z.literal("addNode"),
  id: canvasIdSchema,
  type: z.string().min(1).max(100),
  version: z.number().int().positive().optional(),
  title: z.string().min(1).max(200).optional(),
  position: z.strictObject({
    x: z.number(),
    y: z.number(),
  }),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const canvasPatchUpdateConfigOpSchema = z.strictObject({
  op: z.literal("updateConfig"),
  id: canvasIdSchema,
  patch: z.record(z.string(), z.unknown()),
});

export const canvasPatchConnectOpSchema = z.strictObject({
  op: z.literal("connect"),
  source: canvasIdSchema,
  sourceHandle: z.string().min(1).max(100),
  target: canvasIdSchema,
  targetHandle: z.string().min(1).max(100),
});

export const canvasPatchOpSchema = z.discriminatedUnion("op", [
  canvasPatchAddNodeOpSchema,
  canvasPatchUpdateConfigOpSchema,
  canvasPatchConnectOpSchema,
]);

export const canvasPatchSchema = z.strictObject({
  summary: z.string().min(1).max(200),
  ops: z.array(canvasPatchOpSchema).min(1).max(AGENT_PATCH_MAX_OPS),
});

export type CanvasPatchOp = z.infer<typeof canvasPatchOpSchema>;
export type CanvasPatch = z.infer<typeof canvasPatchSchema>;

export const agentLoopStartRequestSchema = z.strictObject({
  projectId: z.string().uuid(),
  canvasId: z.string().uuid(),
  canvasVersion: z.number().int().nonnegative(),
  prompt: z.string().trim().min(1).max(10000),
  profileId: z.string().min(1).max(64).optional(),
  selectedSkills: z.array(z.string().min(1).max(64)).max(5).optional(),
  selectedNodeIds: z.array(canvasIdSchema).max(50).optional(),
});
export type AgentLoopStartRequest = z.infer<typeof agentLoopStartRequestSchema>;

export const agentLoopRunStatusSchema = z.enum([
  "running",
  "waiting_approval",
  "completed",
  "failed",
]);
export type AgentLoopRunStatus = z.infer<typeof agentLoopRunStatusSchema>;

export const agentLoopOutcomeSchema = z.enum([
  "finished",
  "approval_timeout",
  "budget_exceeded",
  "max_steps",
]);
export type AgentLoopOutcome = z.infer<typeof agentLoopOutcomeSchema>;

export const agentLoopProposalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "timeout",
]);
export type AgentLoopProposalStatus = z.infer<
  typeof agentLoopProposalStatusSchema
>;

export const agentLoopProposalResultSchema = z.strictObject({
  ok: z.boolean(),
  summary: z.string(),
  patch: canvasPatchSchema.optional(),
});
export type AgentLoopProposalResult = z.infer<
  typeof agentLoopProposalResultSchema
>;

export const agentLoopProposalSchema = z.strictObject({
  toolCallId: z.string().min(1).max(128),
  toolName: z.string().min(1).max(128),
  input: z.record(z.string(), z.unknown()),
  summary: z.string(),
  risk: z.enum(["read", "write", "expensive", "destructive"]),
  status: agentLoopProposalStatusSchema,
  result: agentLoopProposalResultSchema.optional(),
  createdAt: z.string().optional(),
});
export type AgentLoopProposal = z.infer<typeof agentLoopProposalSchema>;

export const agentLoopStepSchema = z.strictObject({
  stepId: z.string().min(1).max(64),
  index: z.number().int().nonnegative(),
  text: z.string(),
  finishReason: z.string().optional(),
  toolCalls: z
    .array(
      z.strictObject({
        toolCallId: z.string(),
        toolName: z.string(),
        input: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
});
export type AgentLoopStep = z.infer<typeof agentLoopStepSchema>;

export const agentLoopRunSchema = z.strictObject({
  id: z.string().uuid(),
  profileId: z.string().min(1).max(64),
  projectId: z.string().uuid(),
  canvasId: z.string().uuid(),
  canvasVersion: z.number().int().nonnegative(),
  status: agentLoopRunStatusSchema,
  outcome: agentLoopOutcomeSchema.nullable().optional(),
  error: z.string().nullable().optional(),
  createdAt: z.string(),
  completedAt: z.string().nullable().optional(),
  steps: z.array(agentLoopStepSchema),
  proposals: z.array(agentLoopProposalSchema),
});
export type AgentLoopRun = z.infer<typeof agentLoopRunSchema>;

export const agentLoopApprovalRequestSchema = z.strictObject({
  toolCallId: z.string().min(1).max(128),
  decision: z.enum(["approve", "reject"]),
});
export type AgentLoopApprovalRequest = z.infer<
  typeof agentLoopApprovalRequestSchema
>;

export const agentStarterSchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(100),
  prompt: z.string().min(1).max(1000),
});
export type AgentStarter = z.infer<typeof agentStarterSchema>;

export const agentProfileSummarySchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  starters: z.array(agentStarterSchema),
});
export type AgentProfileSummary = z.infer<typeof agentProfileSummarySchema>;

export function agentEventsChannel(runId: string): string {
  return `agent-events:${runId}`;
}

export function agentEventsSeqKey(runId: string): string {
  return `agent-events:${runId}:seq`;
}

export const agentRunStatusEventSchema = z.strictObject({
  type: z.literal("agent.run.status"),
  runId: z.string().uuid(),
  seq: z.number().int().positive(),
  status: agentLoopRunStatusSchema,
  outcome: agentLoopOutcomeSchema.optional(),
  error: z.string().nullable().optional(),
});
export type AgentRunStatusEvent = z.infer<typeof agentRunStatusEventSchema>;

export const agentStepStartedEventSchema = z.strictObject({
  type: z.literal("agent.step.started"),
  runId: z.string().uuid(),
  seq: z.number().int().positive(),
  stepId: z.string().min(1).max(64),
  index: z.number().int().nonnegative(),
  attempt: z.number().int().positive(),
});
export type AgentStepStartedEvent = z.infer<typeof agentStepStartedEventSchema>;

export const agentTextDeltaEventSchema = z.strictObject({
  type: z.literal("agent.text.delta"),
  runId: z.string().uuid(),
  seq: z.number().int().positive(),
  stepId: z.string().min(1).max(64),
  attempt: z.number().int().positive(),
  text: z.string().max(4096),
});
export type AgentTextDeltaEvent = z.infer<typeof agentTextDeltaEventSchema>;

export const agentStepCompletedEventSchema = z.strictObject({
  type: z.literal("agent.step.completed"),
  runId: z.string().uuid(),
  seq: z.number().int().positive(),
  stepId: z.string().min(1).max(64),
  text: z.string(),
  finishReason: z.string(),
});
export type AgentStepCompletedEvent = z.infer<
  typeof agentStepCompletedEventSchema
>;

export const agentToolProposedEventSchema = z.strictObject({
  type: z.literal("agent.tool.proposed"),
  runId: z.string().uuid(),
  seq: z.number().int().positive(),
  proposal: agentLoopProposalSchema,
});
export type AgentToolProposedEvent = z.infer<
  typeof agentToolProposedEventSchema
>;

export const agentToolDecidedEventSchema = z.strictObject({
  type: z.literal("agent.tool.decided"),
  runId: z.string().uuid(),
  seq: z.number().int().positive(),
  toolCallId: z.string().min(1).max(128),
  decision: z.enum(["approved", "rejected", "timeout"]),
});
export type AgentToolDecidedEvent = z.infer<typeof agentToolDecidedEventSchema>;

export const agentToolResultEventSchema = z.strictObject({
  type: z.literal("agent.tool.result"),
  runId: z.string().uuid(),
  seq: z.number().int().positive(),
  toolCallId: z.string().min(1).max(128),
  toolName: z.string().min(1).max(128),
  ok: z.boolean(),
  summary: z.string(),
  patch: canvasPatchSchema.optional(),
});
export type AgentToolResultEvent = z.infer<typeof agentToolResultEventSchema>;

export const agentEventSchema = z.discriminatedUnion("type", [
  agentRunStatusEventSchema,
  agentStepStartedEventSchema,
  agentTextDeltaEventSchema,
  agentStepCompletedEventSchema,
  agentToolProposedEventSchema,
  agentToolDecidedEventSchema,
  agentToolResultEventSchema,
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

export const agentSnapshotEventSchema = z.strictObject({
  type: z.literal("snapshot"),
  runId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  run: agentLoopRunSchema,
});
export type AgentSnapshotEvent = z.infer<typeof agentSnapshotEventSchema>;

export const agentPingEventSchema = z.strictObject({
  type: z.literal("ping"),
  seq: z.number().int().nonnegative(),
});
export type AgentPingEvent = z.infer<typeof agentPingEventSchema>;

export const agentDoneEventSchema = z.strictObject({
  type: z.literal("done"),
  status: agentLoopRunStatusSchema,
  outcome: agentLoopOutcomeSchema.optional(),
});
export type AgentDoneEvent = z.infer<typeof agentDoneEventSchema>;

export const agentStreamEventSchema = z.discriminatedUnion("type", [
  agentSnapshotEventSchema,
  agentPingEventSchema,
  agentDoneEventSchema,
  agentRunStatusEventSchema,
  agentStepStartedEventSchema,
  agentTextDeltaEventSchema,
  agentStepCompletedEventSchema,
  agentToolProposedEventSchema,
  agentToolDecidedEventSchema,
  agentToolResultEventSchema,
]);
export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;
