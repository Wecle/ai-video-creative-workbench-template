import {
  WorkflowNotFoundError,
  type Client,
  type Connection,
  type WorkflowExecutionDescription,
} from "@temporalio/client";
import {
  AGENT_LOOP_EXECUTION_TIMEOUT,
  AGENT_TASK_QUEUE,
  AGENT_LOOP_WORKFLOW_TYPE,
  agentLoopWorkflowId,
} from "@creative/workflows/constants";
import {
  agentApprovalSignal,
  type AgentApprovalPayload,
} from "@creative/workflows/signals";

const CALL_TIMEOUT_MS = 3000;
const PING_TIMEOUT_MS = 2000;

export interface AgentLoopService {
  start(userId: string, runId: string): Promise<{ workflowId: string }>;
  signalApproval(
    userId: string,
    runId: string,
    signal: AgentApprovalPayload,
  ): Promise<void>;
  describe(
    userId: string,
    runId: string,
  ): Promise<WorkflowExecutionDescription | null>;
  ping(): Promise<void>;
}

export function createTemporalAgentLoops({
  client,
  connection,
}: {
  client: Client;
  connection: Connection;
}): AgentLoopService {
  const withDeadline = <T>(fn: () => Promise<T>, ms = CALL_TIMEOUT_MS) =>
    connection.withDeadline(Date.now() + ms, fn);

  return {
    async start(userId: string, runId: string) {
      const workflowId = agentLoopWorkflowId(userId, runId);
      await withDeadline(() =>
        client.workflow.start(AGENT_LOOP_WORKFLOW_TYPE, {
          taskQueue: AGENT_TASK_QUEUE,
          workflowId,
          args: [{ runId, userId }],
          memo: { userId, runId },
          workflowExecutionTimeout: AGENT_LOOP_EXECUTION_TIMEOUT,
        }),
      );
      return { workflowId };
    },

    async signalApproval(userId, runId, signal) {
      const handle = client.workflow.getHandle(
        agentLoopWorkflowId(userId, runId),
      );
      await withDeadline(() => handle.signal(agentApprovalSignal, signal));
    },

    async describe(userId, runId) {
      const handle = client.workflow.getHandle(
        agentLoopWorkflowId(userId, runId),
      );
      try {
        return await withDeadline(() => handle.describe());
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return null;
        throw error;
      }
    },

    async ping() {
      const { status } = await withDeadline(
        () => connection.healthService.check({}),
        PING_TIMEOUT_MS,
      );
      if (status !== 1) throw new Error("Temporal is not serving");
    },
  };
}
