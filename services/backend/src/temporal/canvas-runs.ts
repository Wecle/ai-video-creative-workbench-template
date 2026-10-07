import type { Client, Connection } from "@temporalio/client";
import {
  CANVAS_DAG_WORKFLOW_TYPE,
  CANVAS_RUN_EXECUTION_TIMEOUT,
  ORCHESTRATOR_TASK_QUEUE,
  canvasRunWorkflowId,
} from "@creative/workflows/constants";
import {
  providerCallbackSignal,
  type ProviderCallbackPayload,
} from "@creative/workflows/signals";

const CALL_TIMEOUT_MS = 5000;

export interface CanvasRunService {
  start(input: {
    canvasId: string;
    runId: string;
    mockMode?: "polling" | "callback";
    region?: string;
  }): Promise<void>;
  sendCallbackSignal(
    workflowId: string,
    payload: ProviderCallbackPayload,
  ): Promise<void>;
}

export function createTemporalCanvasRuns({
  client,
  connection,
}: {
  client: Client;
  connection: Connection;
}): CanvasRunService {
  const withDeadline = <T>(fn: () => Promise<T>, ms = CALL_TIMEOUT_MS) =>
    connection.withDeadline(Date.now() + ms, fn);

  return {
    async start(input) {
      await withDeadline(() =>
        client.workflow.start(CANVAS_DAG_WORKFLOW_TYPE, {
          taskQueue: ORCHESTRATOR_TASK_QUEUE,
          workflowId: canvasRunWorkflowId(input.canvasId, input.runId),
          args: [{ runId: input.runId }],
          workflowExecutionTimeout: CANVAS_RUN_EXECUTION_TIMEOUT,
        }),
      );
    },

    async sendCallbackSignal(workflowId, payload) {
      const handle = client.workflow.getHandle(workflowId);
      await withDeadline(() => handle.signal(providerCallbackSignal, payload));
    },
  };
}
