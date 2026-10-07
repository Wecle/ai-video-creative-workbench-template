/** Plain constants shared by the backend (client side) and the agent-runner (worker side). No imports allowed here. */

/** Task queue served by `services/agent-runner`. Orchestration (P2) gets its own queue. */
export const AGENT_TASK_QUEUE = "agent";

/** Workflow type name, equal to the exported workflow function name. */
export const ECHO_WORKFLOW_TYPE = "echoWorkflow";

/** Safety net so a stuck run cannot hang forever. Set by the starter, not by the workflow. */
export const AGENT_RUN_EXECUTION_TIMEOUT = "5 minutes";

/**
 * Temporal CLI used by `TestWorkflowEnvironment.createLocal()` in tests. Pinned because the
 * SDK otherwise downloads the latest release (CLI 1.9.1 / Server 1.32.0 at the time of writing).
 * v1.8.3 embeds Server 1.31.2, the closest stable CLI to the compose server (temporalio/server 1.31.3).
 * The leading "v" is required: the SDK builds https://temporal.download/cli/<version> and "1.8.3" is a 404.
 */
export const TEMPORAL_DEV_CLI_VERSION = "v1.8.3";

/**
 * Ownership is encoded in the id: a run is only reachable by recomputing this id from the
 * authenticated user, so userId must never contain the separator.
 */
export function agentRunWorkflowId(userId: string, runId: string): string {
  if (!userId || !runId || userId.includes(":") || runId.includes(":")) {
    throw new Error("Invalid agent run identifiers");
  }
  return `agent-run:${userId}:${runId}`;
}

/** Task queue served by `services/orchestrator-worker`. */
export const ORCHESTRATOR_TASK_QUEUE = "orchestrator";

/** Canvas DAG workflow type name. */
export const CANVAS_DAG_WORKFLOW_TYPE = "canvasDagWorkflow";

/** Execution timeout for canvas workflow. */
export const CANVAS_RUN_EXECUTION_TIMEOUT = "10 minutes";

/**
 * Canvas workflow ID derived from canvasId and runId.
 */
export function canvasRunWorkflowId(canvasId: string, runId: string): string {
  if (!canvasId || !runId || canvasId.includes(":") || runId.includes(":")) {
    throw new Error("Invalid canvas run identifiers");
  }
  return `canvas-run:${canvasId}:${runId}`;
}

/** Task queue served by `workers/media-worker-python`. */
export const MEDIA_TASK_QUEUE = "media";

/** Media probe workflow type name. */
export const MEDIA_PROBE_WORKFLOW_TYPE = "mediaProbeWorkflow";

/** Media probe activity name. */
export const MEDIA_PROBE_ACTIVITY = "media.probe";

/**
 * Media probe workflow ID derived from assetId.
 */
export function assetProbeWorkflowId(assetId: string): string {
  if (!assetId || assetId.includes(":")) {
    throw new Error("Invalid asset identifier");
  }
  return `asset-probe:${assetId}`;
}
