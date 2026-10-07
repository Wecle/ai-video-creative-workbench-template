import {
  WorkflowExecutionAlreadyStartedError,
  type Client,
  type Connection,
} from "@temporalio/client";
import {
  MEDIA_PROBE_WORKFLOW_TYPE,
  ORCHESTRATOR_TASK_QUEUE,
  assetProbeWorkflowId,
} from "@creative/workflows/constants";

const CALL_TIMEOUT_MS = 3000;

export interface AssetProbeService {
  start(assetId: string): Promise<{ queued: boolean; workflowId: string }>;
}

export function createTemporalAssetProbes({
  client,
  connection,
}: {
  client: Client;
  connection: Connection;
}): AssetProbeService {
  const withDeadline = <T>(fn: () => Promise<T>, ms = CALL_TIMEOUT_MS) =>
    connection.withDeadline(Date.now() + ms, fn);

  return {
    async start(assetId: string) {
      const workflowId = assetProbeWorkflowId(assetId);
      try {
        await withDeadline(() =>
          client.workflow.start(MEDIA_PROBE_WORKFLOW_TYPE, {
            taskQueue: ORCHESTRATOR_TASK_QUEUE,
            workflowId,
            args: [{ assetId }],
            workflowExecutionTimeout: "5 minutes",
          }),
        );
        return { queued: true, workflowId };
      } catch (error) {
        if (
          error instanceof WorkflowExecutionAlreadyStartedError ||
          (error as Error).name === "WorkflowExecutionAlreadyStartedError"
        ) {
          return { queued: true, workflowId };
        }
        throw error;
      }
    },
  };
}
