import { randomUUID } from "node:crypto";
import {
  WorkflowNotFoundError,
  type Client,
  type Connection,
} from "@temporalio/client";
import type {
  AgentRequest,
  AgentRunStatus,
  AgentRunView,
} from "@creative/contracts";
import type { EchoInput } from "@creative/workflows/activities";
import {
  AGENT_RUN_EXECUTION_TIMEOUT,
  AGENT_TASK_QUEUE,
  ECHO_WORKFLOW_TYPE,
  agentRunWorkflowId,
} from "@creative/workflows/constants";

/** Every Temporal call gets a deadline: an unreachable server otherwise blocks for ~20 s. */
const CALL_TIMEOUT_MS = 3000;
const PING_TIMEOUT_MS = 2000;

/**
 * The backend's view of agent runs. Routes depend on this interface only, so tests can
 * swap it. Temporal failures surface as `ServiceError` from @temporalio/client.
 */
export interface AgentRunService {
  start(userId: string, input: AgentRequest): Promise<AgentRunView>;
  /** Null when the run does not exist or belongs to someone else (indistinguishable on purpose). */
  get(userId: string, runId: string): Promise<AgentRunView | null>;
  /** Resolves when the execution engine answers its health check. */
  ping(): Promise<void>;
}

const STATUS: Record<string, AgentRunStatus> = {
  RUNNING: "running",
  CONTINUED_AS_NEW: "running",
  PAUSED: "waiting",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
};

export function createTemporalAgentRuns({
  client,
  connection,
}: {
  client: Client;
  connection: Connection;
}): AgentRunService {
  const withDeadline = <T>(fn: () => Promise<T>, ms = CALL_TIMEOUT_MS) =>
    // The argument is an absolute timestamp, not a duration.
    connection.withDeadline(Date.now() + ms, fn);

  return {
    async start(userId, input) {
      const runId = randomUUID();
      const args: EchoInput = {
        runId,
        userId,
        prompt: input.prompt,
        projectId: input.projectId,
        canvasId: input.canvasId,
      };
      await withDeadline(() =>
        client.workflow.start(ECHO_WORKFLOW_TYPE, {
          taskQueue: AGENT_TASK_QUEUE,
          workflowId: agentRunWorkflowId(userId, runId),
          args: [args],
          memo: { userId },
          workflowExecutionTimeout: AGENT_RUN_EXECUTION_TIMEOUT,
        }),
      );
      return {
        id: runId,
        status: "running",
        createdAt: new Date().toISOString(),
      };
    },

    async get(userId, runId) {
      // Ownership: the id is recomputed from the authenticated user, so another user's
      // run id points at a workflow that does not exist.
      const handle = client.workflow.getHandle(
        agentRunWorkflowId(userId, runId),
      );
      let description;
      try {
        description = await withDeadline(() => handle.describe());
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return null;
        throw error;
      }
      // Defense in depth; cannot differ unless the id scheme is broken.
      if (description.memo?.userId !== userId) return null;

      const status = STATUS[description.status.name] ?? "failed";
      const run: AgentRunView = {
        id: runId,
        status,
        createdAt: description.startTime.toISOString(),
      };
      if (status === "completed")
        run.result = await withDeadline(() => handle.result());
      // Fixed text: activity error messages stay out of API responses.
      if (status === "failed") run.error = { message: "Run failed" };
      return run;
    },

    async ping() {
      const { status } = await withDeadline(
        () => connection.healthService.check({}),
        PING_TIMEOUT_MS,
      );
      // 1 = SERVING
      if (status !== 1) throw new Error("Temporal is not serving");
    },
  };
}
