import {
  ApplicationFailure,
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import type {
  OrchestratorActivities,
  ProviderCallbackPayload,
} from "./activities";

const {
  loadRunGraph,
  recordNodeRunStarted,
  executeNode,
  pollJob,
  recordNodeRunCompleted,
  updateRunStatus,
} = proxyActivities<OrchestratorActivities>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "1s",
    backoffCoefficient: 2,
    maximumInterval: "15s",
    maximumAttempts: 3,
  },
});

export const providerCallbackSignal =
  defineSignal<[ProviderCallbackPayload]>("providerCallback");

export type CanvasDagWorkflowInput = {
  runId: string;
};

export async function canvasDagWorkflow(
  input: CanvasDagWorkflowInput,
): Promise<{ status: "succeeded" | "failed" }> {
  try {
    const graphData = await loadRunGraph(input.runId);
    await updateRunStatus({ runId: input.runId, status: "running" });

    let waitingJobId: string | null = null;
    let receivedCallback: ProviderCallbackPayload | null = null;

    setHandler(providerCallbackSignal, (payload) => {
      // Deduplication: only accept signal matching the currently waiting externalJobId
      if (waitingJobId !== null && payload.externalJobId === waitingJobId) {
        receivedCallback = payload;
      }
    });

    const { nodes, edges } = graphData.snapshot;
    const nodesById = new Map(nodes.map((n) => [n.id, n]));
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    const incomingEdges = new Map<string, typeof edges>();

    for (const node of nodes) {
      inDegree.set(node.id, 0);
      dependents.set(node.id, []);
      incomingEdges.set(node.id, []);
    }

    for (const edge of edges) {
      if (nodesById.has(edge.source) && nodesById.has(edge.target)) {
        inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
        dependents.get(edge.source)!.push(edge.target);
        incomingEdges.get(edge.target)!.push(edge);
      }
    }

    const readyQueue: string[] = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) {
        readyQueue.push(id);
      }
    }

    const outputsByNode = new Map<string, Record<string, unknown>>();
    let completedCount = 0;

    while (completedCount < nodes.length) {
      if (readyQueue.length === 0) {
        const err = "DAG_CYCLE_OR_DEADLOCK";
        await updateRunStatus({
          runId: input.runId,
          status: "failed",
          error: err,
        });
        throw ApplicationFailure.create({ message: err, nonRetryable: true });
      }

      const nodeId = readyQueue.shift()!;
      const node = nodesById.get(nodeId)!;

      const nodeInputs: Record<string, unknown> = {};
      for (const edge of incomingEdges.get(nodeId)!) {
        const sourceOutputs = outputsByNode.get(edge.source);
        if (sourceOutputs && edge.sourceHandle in sourceOutputs) {
          nodeInputs[edge.targetHandle] = sourceOutputs[edge.sourceHandle];
        }
      }

      await recordNodeRunStarted({
        runId: input.runId,
        nodeId: node.id,
        nodeType: node.type,
        inputs: nodeInputs,
      });

      let nodeOutputs: Record<string, unknown> = {};

      const execResult = await executeNode({
        runId: input.runId,
        nodeId: node.id,
        nodeType: node.type,
        version: node.version,
        config: node.config,
        inputs: nodeInputs,
        mockMode: graphData.mockMode,
        region: graphData.region,
      });

      const usedProvider = execResult.provider;
      const usedExternalJobId = execResult.externalJobId;

      if (execResult.status === "failed") {
        await recordNodeRunCompleted({
          runId: input.runId,
          nodeId: node.id,
          status: "failed",
          error: execResult.error,
          provider: usedProvider,
          externalJobId: usedExternalJobId,
        });
        await updateRunStatus({
          runId: input.runId,
          status: "failed",
          error: execResult.error,
        });
        throw ApplicationFailure.create({
          message: execResult.error,
          nonRetryable: true,
        });
      } else if (execResult.status === "succeeded") {
        nodeOutputs = execResult.outputs;
      } else if (execResult.status === "pending") {
        if (execResult.mode === "callback") {
          waitingJobId = execResult.externalJobId;
          receivedCallback = null;

          const received = await condition(
            () => receivedCallback !== null,
            "5 minutes",
          );
          waitingJobId = null;

          if (!received || !receivedCallback) {
            const err = "CALLBACK_TIMEOUT";
            await recordNodeRunCompleted({
              runId: input.runId,
              nodeId: node.id,
              status: "failed",
              error: err,
              provider: usedProvider,
              externalJobId: usedExternalJobId,
            });
            await updateRunStatus({
              runId: input.runId,
              status: "failed",
              error: err,
            });
            throw ApplicationFailure.create({
              message: err,
              nonRetryable: true,
            });
          }

          const callback: ProviderCallbackPayload = receivedCallback;
          if (callback.status === "failed") {
            const err = callback.error || "NODE_EXECUTION_FAILED";
            await recordNodeRunCompleted({
              runId: input.runId,
              nodeId: node.id,
              status: "failed",
              error: err,
              provider: usedProvider,
              externalJobId: usedExternalJobId,
            });
            await updateRunStatus({
              runId: input.runId,
              status: "failed",
              error: err,
            });
            throw ApplicationFailure.create({
              message: err,
              nonRetryable: true,
            });
          }

          nodeOutputs = callback.output ?? {};
        } else {
          // Polling mode: poll activity + sleep loop
          const MAX_POLLS = 30;
          let pollSucceeded = false;
          for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
            await sleep("1 second");
            const pollResult = await pollJob({
              provider: execResult.provider,
              externalJobId: execResult.externalJobId,
            });

            if (pollResult.status === "succeeded") {
              nodeOutputs = pollResult.outputs;
              pollSucceeded = true;
              break;
            }
            if (pollResult.status === "failed") {
              await recordNodeRunCompleted({
                runId: input.runId,
                nodeId: node.id,
                status: "failed",
                error: pollResult.error,
                provider: usedProvider,
                externalJobId: usedExternalJobId,
              });
              await updateRunStatus({
                runId: input.runId,
                status: "failed",
                error: pollResult.error,
              });
              throw ApplicationFailure.create({
                message: pollResult.error,
                nonRetryable: true,
              });
            }
          }

          if (!pollSucceeded) {
            const err = "POLLING_TIMEOUT";
            await recordNodeRunCompleted({
              runId: input.runId,
              nodeId: node.id,
              status: "failed",
              error: err,
              provider: usedProvider,
              externalJobId: usedExternalJobId,
            });
            await updateRunStatus({
              runId: input.runId,
              status: "failed",
              error: err,
            });
            throw ApplicationFailure.create({
              message: err,
              nonRetryable: true,
            });
          }
        }
      }

      await recordNodeRunCompleted({
        runId: input.runId,
        nodeId: node.id,
        status: "succeeded",
        outputs: nodeOutputs,
        provider: usedProvider,
        externalJobId: usedExternalJobId,
      });

      outputsByNode.set(node.id, nodeOutputs);
      completedCount++;

      for (const depId of dependents.get(node.id)!) {
        const currentDeg = inDegree.get(depId)! - 1;
        inDegree.set(depId, currentDeg);
        if (currentDeg === 0) {
          readyQueue.push(depId);
        }
      }
    }

    await updateRunStatus({ runId: input.runId, status: "succeeded" });
    return { status: "succeeded" };
  } catch (error) {
    if (!(error instanceof ApplicationFailure)) {
      const message =
        error instanceof Error ? error.message : "WORKFLOW_FAILED";
      await updateRunStatus({
        runId: input.runId,
        status: "failed",
        error: message,
      }).catch(() => undefined);
    }
    throw error;
  }
}
