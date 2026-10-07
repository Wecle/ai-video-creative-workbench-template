import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CanvasSnapshot } from "@creative/contracts";
import type {
  ExecuteNodeInput,
  ExecuteNodeResult,
  OrchestratorActivities,
  PollJobResult,
  RunGraphData,
} from "../src/activities";
import {
  CANVAS_DAG_WORKFLOW_TYPE,
  canvasRunWorkflowId,
} from "../src/constants";
import { providerCallbackSignal } from "../src/dag";
import { createTemporalTestEnv } from "./helpers";

const workflowsPath = fileURLToPath(
  new URL("../src/index.ts", import.meta.url),
);

let env: TestWorkflowEnvironment;
beforeAll(async () => {
  env = await createTemporalTestEnv();
}, 120_000);
afterAll(async () => {
  await env?.teardown();
});

function createSampleSnapshot(): CanvasSnapshot {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: "text-node",
        type: "text",
        version: 1,
        title: "Prompt Text",
        position: { x: 0, y: 0 },
        config: { text: "Futuristic city with flying cars" },
      },
      {
        id: "image-node",
        type: "image.generate",
        version: 1,
        title: "Generate Image",
        position: { x: 300, y: 0 },
        config: { prompt: "", aspectRatio: "16:9" },
      },
    ],
    edges: [
      {
        id: "edge-1",
        source: "text-node",
        sourceHandle: "text",
        target: "image-node",
        targetHandle: "prompt",
      },
    ],
  };
}

describe("canvasDagWorkflow", () => {
  it("executes text -> image.generate chain in polling mode", async () => {
    const taskQueue = `orch-${randomUUID().slice(0, 8)}`;
    const runId = randomUUID();
    const canvasId = randomUUID();
    const snapshot = createSampleSnapshot();

    const nodeExecutions: ExecuteNodeInput[] = [];
    const runStatuses: string[] = [];

    const activities: OrchestratorActivities = {
      loadRunGraph: async (): Promise<RunGraphData> => ({
        runId,
        canvasId,
        projectId: randomUUID(),
        canvasVersion: 1,
        snapshot,
        mockMode: "polling",
      }),
      recordNodeRunStarted: async () => {},
      executeNode: async (input): Promise<ExecuteNodeResult> => {
        nodeExecutions.push(input);
        if (input.nodeType === "text") {
          return {
            status: "succeeded",
            outputs: { text: input.config.text },
          };
        }
        return {
          status: "pending",
          provider: "mock",
          externalJobId: "job-poll-1",
          mode: "polling",
        };
      },
      pollJob: async (): Promise<PollJobResult> => ({
        status: "succeeded",
        outputs: {
          image: { url: "https://mock.test/img.png", width: 1024, height: 576 },
        },
      }),
      recordNodeRunCompleted: async () => {},
      updateRunStatus: async ({ status }) => {
        runStatuses.push(status);
      },
    };

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: { ...activities },
    });

    const result = await worker.runUntil(
      env.client.workflow.execute(CANVAS_DAG_WORKFLOW_TYPE, {
        taskQueue,
        workflowId: canvasRunWorkflowId(canvasId, runId),
        args: [{ runId }],
      }),
    );

    expect(result).toEqual({ status: "succeeded" });
    expect(nodeExecutions).toHaveLength(2);
    expect(nodeExecutions[0]?.nodeId).toBe("text-node");
    expect(nodeExecutions[1]?.nodeId).toBe("image-node");
    expect(nodeExecutions[1]?.inputs).toEqual({
      prompt: "Futuristic city with flying cars",
    });
    expect(runStatuses).toContain("running");
    expect(runStatuses).toContain("succeeded");
  }, 20_000);

  it("handles callback mode and deduplicates unexpected signals", async () => {
    const taskQueue = `orch-${randomUUID().slice(0, 8)}`;
    const runId = randomUUID();
    const canvasId = randomUUID();
    const snapshot = createSampleSnapshot();

    let nodeStartedCallback: (() => void) | undefined;
    const nodeStartedPromise = new Promise<void>((resolve) => {
      nodeStartedCallback = resolve;
    });

    const activities: OrchestratorActivities = {
      loadRunGraph: async (): Promise<RunGraphData> => ({
        runId,
        canvasId,
        projectId: randomUUID(),
        canvasVersion: 1,
        snapshot,
        mockMode: "callback",
      }),
      recordNodeRunStarted: async () => {},
      executeNode: async (input): Promise<ExecuteNodeResult> => {
        if (input.nodeType === "text") {
          return {
            status: "succeeded",
            outputs: { text: input.config.text },
          };
        }
        // Signal that image.generate has been executed and is waiting
        nodeStartedCallback?.();
        return {
          status: "pending",
          provider: "mock",
          externalJobId: "job-cb-target",
          mode: "callback",
        };
      },
      pollJob: async (): Promise<PollJobResult> => ({ status: "running" }),
      recordNodeRunCompleted: async (input) => {
        if (input.nodeId === "image-node") {
          nodeRunOutputs = input.outputs ?? null;
        }
      },
      updateRunStatus: async () => {},
    };

    let nodeRunOutputs: Record<string, unknown> | null = null;

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: { ...activities },
    });

    const workflowId = canvasRunWorkflowId(canvasId, runId);
    const handle = await env.client.workflow.start(CANVAS_DAG_WORKFLOW_TYPE, {
      taskQueue,
      workflowId,
      args: [{ runId }],
    });

    const executionPromise = worker.runUntil(handle.result());

    // Wait until the workflow reaches image-node and sets waitingJobId
    await nodeStartedPromise;
    // Allow workflow microtask to enter condition()
    await new Promise((r) => setTimeout(r, 100));

    // Send unexpected signal first (should be ignored due to deduplication)
    await handle.signal(providerCallbackSignal, {
      provider: "mock",
      externalJobId: "wrong-external-id",
      status: "failed",
      error: "SHOULD_BE_IGNORED",
    });

    // Send the correct signal for the target job
    await handle.signal(providerCallbackSignal, {
      provider: "mock",
      externalJobId: "job-cb-target",
      status: "succeeded",
      output: { image: { url: "correct.png" } },
    });

    const result = await executionPromise;
    expect(result).toEqual({ status: "succeeded" });
    expect(nodeRunOutputs).toEqual({ image: { url: "correct.png" } });
  }, 20_000);

  it("detects cycle or deadlock and fails", async () => {
    const taskQueue = `orch-${randomUUID().slice(0, 8)}`;
    const runId = randomUUID();
    const canvasId = randomUUID();
    const snapshot: CanvasSnapshot = {
      schemaVersion: 1,
      nodes: [
        {
          id: "node-a",
          type: "text",
          version: 1,
          title: "Node A",
          position: { x: 0, y: 0 },
          config: { text: "A" },
        },
        {
          id: "node-b",
          type: "text",
          version: 1,
          title: "Node B",
          position: { x: 100, y: 0 },
          config: { text: "B" },
        },
      ],
      edges: [
        {
          id: "edge-ab",
          source: "node-a",
          sourceHandle: "text",
          target: "node-b",
          targetHandle: "text",
        },
        {
          id: "edge-ba",
          source: "node-b",
          sourceHandle: "text",
          target: "node-a",
          targetHandle: "text",
        },
      ],
    };

    let failedStatusRecorded = false;
    const activities: OrchestratorActivities = {
      loadRunGraph: async (): Promise<RunGraphData> => ({
        runId,
        canvasId,
        projectId: randomUUID(),
        canvasVersion: 1,
        snapshot,
      }),
      recordNodeRunStarted: async () => {},
      executeNode: async () => ({ status: "succeeded", outputs: {} }),
      pollJob: async () => ({ status: "succeeded", outputs: {} }),
      recordNodeRunCompleted: async () => {},
      updateRunStatus: async ({ status }) => {
        if (status === "failed") failedStatusRecorded = true;
      },
    };

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: { ...activities },
    });

    await expect(
      worker.runUntil(
        env.client.workflow.execute(CANVAS_DAG_WORKFLOW_TYPE, {
          taskQueue,
          workflowId: canvasRunWorkflowId(canvasId, runId),
          args: [{ runId }],
        }),
      ),
    ).rejects.toThrow();

    expect(failedStatusRecorded).toBe(true);
  }, 20_000);
});
