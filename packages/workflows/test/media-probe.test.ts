import { fileURLToPath } from "node:url";
import {
  bundleWorkflowCode,
  Worker,
  type WorkflowBundle,
} from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/workflow";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MediaProbeInput, MediaProbeResult } from "@creative/contracts";
import type {
  LoadAssetResult,
  MediaActivities,
  OrchestratorAssetActivities,
} from "../src/activities";
import {
  MEDIA_PROBE_WORKFLOW_TYPE,
  MEDIA_TASK_QUEUE,
  ORCHESTRATOR_TASK_QUEUE,
  assetProbeWorkflowId,
} from "../src/constants";
import { createTemporalTestEnv } from "./helpers";

const workflowsPath = fileURLToPath(
  new URL("../src/index.ts", import.meta.url),
);

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundle;

beforeAll(async () => {
  env = await createTemporalTestEnv();
  workflowBundle = await bundleWorkflowCode({
    workflowsPath,
  });
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

describe("mediaProbeWorkflow", () => {
  it("coordinates loadAsset, media.probe, and saveAssetMetadata across task queues", async () => {
    let loadAssetCalledWith: string | null = null;
    let probeInputReceived: MediaProbeInput | null = null;
    let savedMetadata: { assetId: string; metadata: MediaProbeResult } | null =
      null;

    const orchestratorActivities: OrchestratorAssetActivities = {
      async loadAsset(input): Promise<LoadAssetResult> {
        loadAssetCalledWith = input.assetId;
        return {
          assetKey: "workspaces/ws-1/assets/asset-1",
          contentType: "image/png",
          sizeBytes: 12345,
        };
      },
      async saveAssetMetadata(input): Promise<void> {
        savedMetadata = input;
      },
    };

    const mediaActivities: MediaActivities = {
      "media.probe": async (
        input: MediaProbeInput,
      ): Promise<MediaProbeResult> => {
        probeInputReceived = input;
        return {
          assetKey: input.assetKey,
          kind: "image",
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          probedBy: "media-worker-python",
          pythonVersion: "3.12.0",
        };
      },
    };

    const orchestratorWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: ORCHESTRATOR_TASK_QUEUE,
      workflowBundle,
      activities: { ...orchestratorActivities },
    });

    const mediaWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: MEDIA_TASK_QUEUE,
      activities: { ...mediaActivities },
    });

    const mediaWorkerPromise = mediaWorker.run();

    try {
      const result = await orchestratorWorker.runUntil(
        env.client.workflow.execute(MEDIA_PROBE_WORKFLOW_TYPE, {
          taskQueue: ORCHESTRATOR_TASK_QUEUE,
          workflowId: assetProbeWorkflowId("asset-1"),
          args: [{ assetId: "asset-1" }],
        }),
      );

      expect(loadAssetCalledWith).toBe("asset-1");
      expect(probeInputReceived).toEqual({
        assetKey: "workspaces/ws-1/assets/asset-1",
        contentType: "image/png",
        sizeBytes: 12345,
      });
      expect(result).toEqual({
        assetKey: "workspaces/ws-1/assets/asset-1",
        kind: "image",
        contentType: "image/png",
        sizeBytes: 12345,
        probedBy: "media-worker-python",
        pythonVersion: "3.12.0",
      });
      expect(savedMetadata).toEqual({
        assetId: "asset-1",
        metadata: result,
      });
    } finally {
      mediaWorker.shutdown();
      await mediaWorkerPromise;
    }
  }, 30_000);

  it("does not retry when media.probe throws non-retryable InvalidInput error", async () => {
    let probeAttempts = 0;

    const orchestratorActivities: OrchestratorAssetActivities = {
      async loadAsset(): Promise<LoadAssetResult> {
        return {
          assetKey: "workspaces/ws-1/assets/asset-2",
          contentType: "image/jpeg",
          sizeBytes: 500,
        };
      },
      async saveAssetMetadata(): Promise<void> {},
    };

    const mediaActivities: MediaActivities = {
      "media.probe": async (): Promise<MediaProbeResult> => {
        probeAttempts++;
        throw ApplicationFailure.nonRetryable(
          "Unsupported image header",
          "InvalidInput",
        );
      },
    };

    const orchestratorWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: ORCHESTRATOR_TASK_QUEUE,
      workflowBundle,
      activities: { ...orchestratorActivities },
    });

    const mediaWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: MEDIA_TASK_QUEUE,
      activities: { ...mediaActivities },
    });

    const mediaWorkerPromise = mediaWorker.run();

    try {
      await expect(
        orchestratorWorker.runUntil(
          env.client.workflow.execute(MEDIA_PROBE_WORKFLOW_TYPE, {
            taskQueue: ORCHESTRATOR_TASK_QUEUE,
            workflowId: assetProbeWorkflowId("asset-2"),
            args: [{ assetId: "asset-2" }],
          }),
        ),
      ).rejects.toThrow();

      // Non-retryable error should only be attempted once
      expect(probeAttempts).toBe(1);
    } finally {
      mediaWorker.shutdown();
      await mediaWorkerPromise;
    }
  }, 30_000);

  it("does not retry when orchestrator.loadAsset throws non-retryable AssetNotFound error", async () => {
    let loadAttempts = 0;

    const orchestratorActivities: OrchestratorAssetActivities = {
      async loadAsset(): Promise<LoadAssetResult> {
        loadAttempts++;
        throw ApplicationFailure.nonRetryable(
          "Asset not found: missing",
          "AssetNotFound",
        );
      },
      async saveAssetMetadata(): Promise<void> {},
    };

    const orchestratorWorker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: ORCHESTRATOR_TASK_QUEUE,
      workflowBundle,
      activities: { ...orchestratorActivities },
    });

    await expect(
      orchestratorWorker.runUntil(
        env.client.workflow.execute(MEDIA_PROBE_WORKFLOW_TYPE, {
          taskQueue: ORCHESTRATOR_TASK_QUEUE,
          workflowId: assetProbeWorkflowId("missing"),
          args: [{ assetId: "missing" }],
        }),
      ),
    ).rejects.toThrow();

    expect(loadAttempts).toBe(1);
  }, 30_000);
});
