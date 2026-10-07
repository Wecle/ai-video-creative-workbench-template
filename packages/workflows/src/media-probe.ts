import { proxyActivities } from "@temporalio/workflow";
import type { MediaProbeResult } from "@creative/contracts";
import type {
  MediaActivities,
  OrchestratorAssetActivities,
} from "./activities";
import { MEDIA_PROBE_ACTIVITY, MEDIA_TASK_QUEUE } from "./constants";

const orchestrator = proxyActivities<OrchestratorAssetActivities>({
  startToCloseTimeout: "1 minute",
  retry: {
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["AssetNotFound", "AssetNotReady"],
  },
});

const media = proxyActivities<MediaActivities>({
  taskQueue: MEDIA_TASK_QUEUE,
  startToCloseTimeout: "1 minute",
  retry: {
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["InvalidInput"],
  },
});

export interface MediaProbeWorkflowInput {
  assetId: string;
}

export async function mediaProbeWorkflow(
  input: MediaProbeWorkflowInput,
): Promise<MediaProbeResult> {
  const loaded = await orchestrator.loadAsset({ assetId: input.assetId });
  const probeResult = await media[MEDIA_PROBE_ACTIVITY]({
    assetKey: loaded.assetKey,
    contentType: loaded.contentType,
    sizeBytes: loaded.sizeBytes,
  });
  await orchestrator.saveAssetMetadata({
    assetId: input.assetId,
    metadata: probeResult,
  });
  return probeResult;
}
