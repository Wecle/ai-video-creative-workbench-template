import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { schema } from "@creative/database";
import type { CanvasSnapshot } from "@creative/contracts";
import type { ProviderRegistry } from "@creative/providers";
import type { RunEventPublisher } from "./events";
import { ApplicationFailure } from "@temporalio/activity";
import type {
  ExecuteNodeInput,
  ExecuteNodeResult,
  LoadAssetInput,
  LoadAssetResult,
  OrchestratorActivities,
  OrchestratorAssetActivities,
  PollJobInput,
  PollJobResult,
  RecordNodeRunCompletedInput,
  RecordNodeRunStartedInput,
  RunGraphData,
  SaveAssetMetadataInput,
  UpdateRunStatusInput,
} from "@creative/workflows/activities";

const { runs, node_runs, assets } = schema;

export type Database = PostgresJsDatabase<typeof schema>;

export interface ActivityContext {
  db: Database;
  registry: ProviderRegistry;
  events?: RunEventPublisher;
}

export function createActivities({
  db,
  registry,
  events,
}: ActivityContext): OrchestratorActivities & OrchestratorAssetActivities {
  return {
    async loadRunGraph(runId: string): Promise<RunGraphData> {
      const [run] = await db
        .select()
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1);

      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      const snap = run.snapshot as Record<string, unknown> | null;
      const snapshot: CanvasSnapshot =
        snap && typeof snap === "object" && "nodes" in snap && "edges" in snap
          ? {
              schemaVersion: (snap.schemaVersion ??
                1) as CanvasSnapshot["schemaVersion"],
              nodes: snap.nodes as CanvasSnapshot["nodes"],
              edges: snap.edges as CanvasSnapshot["edges"],
            }
          : ((snap?.snapshot ?? snap) as CanvasSnapshot);

      const options = run.options as Record<string, unknown> | null;
      const mockMode = (options?.mockMode ?? snap?.mockMode) as
        "polling" | "callback" | undefined;
      const region = (options?.region ?? snap?.region) as string | undefined;

      return {
        runId: run.id,
        canvasId: run.canvasId,
        projectId: run.projectId,
        canvasVersion: run.canvasVersion,
        snapshot,
        mockMode,
        region,
      };
    },

    async recordNodeRunStarted(
      input: RecordNodeRunStartedInput,
    ): Promise<void> {
      await db
        .insert(node_runs)
        .values({
          runId: input.runId,
          nodeId: input.nodeId,
          nodeType: input.nodeType,
          status: "running",
          inputs: input.inputs ?? null,
          startedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [node_runs.runId, node_runs.nodeId],
          set: {
            status: "running",
            inputs: input.inputs ?? null,
            startedAt: new Date(),
          },
        });

      await events?.publish({
        type: "node.status",
        runId: input.runId,
        nodeId: input.nodeId,
        status: "running",
      });
    },

    async executeNode(input: ExecuteNodeInput): Promise<ExecuteNodeResult> {
      if (input.nodeType === "text") {
        const text = String(input.config.text ?? "");
        return {
          status: "succeeded",
          outputs: { text },
        };
      }

      if (input.nodeType === "image.generate") {
        const prompt = String(input.inputs.prompt ?? input.config.prompt ?? "");
        const adapter = registry.resolve("image.generate", input.region);
        if (!adapter) {
          return { status: "failed", error: "PROVIDER_NOT_FOUND" };
        }

        const submitResult = await adapter.submit({
          jobId: `${input.runId}-${input.nodeId}`,
          capability: "image.generate",
          prompt,
          params: input.config,
          mockMode: input.mockMode,
        });

        if (submitResult.status === "succeeded") {
          return {
            status: "succeeded",
            outputs: submitResult.output ?? {},
            provider: adapter.id,
            externalJobId: submitResult.externalId,
          };
        }

        if (db) {
          await db
            .update(node_runs)
            .set({
              provider: adapter.id,
              externalJobId: submitResult.externalId,
              status: "running",
              startedAt: new Date(),
            })
            .where(
              and(
                eq(node_runs.runId, input.runId),
                eq(node_runs.nodeId, input.nodeId),
              ),
            );
        }

        return {
          status: "pending",
          provider: adapter.id,
          externalJobId: submitResult.externalId,
          mode: input.mockMode === "callback" ? "callback" : "polling",
        };
      }

      return {
        status: "failed",
        error: `UNKNOWN_NODE_TYPE_${input.nodeType}`,
      };
    },

    async pollJob(input: PollJobInput): Promise<PollJobResult> {
      const adapter = registry.get(input.provider);
      if (!adapter) {
        return { status: "failed", error: "PROVIDER_NOT_FOUND" };
      }

      const pollResult = await adapter.poll(input.externalJobId);
      if (pollResult.status === "succeeded") {
        return { status: "succeeded", outputs: pollResult.output ?? {} };
      }
      if (pollResult.status === "failed") {
        return { status: "failed", error: pollResult.error ?? "POLL_FAILED" };
      }
      return { status: "running" };
    },

    async recordNodeRunCompleted(
      input: RecordNodeRunCompletedInput,
    ): Promise<void> {
      await db
        .insert(node_runs)
        .values({
          runId: input.runId,
          nodeId: input.nodeId,
          nodeType: "unknown",
          provider: input.provider ?? null,
          externalJobId: input.externalJobId ?? null,
          status: input.status,
          outputs: input.outputs ?? null,
          error: input.error ?? null,
          completedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [node_runs.runId, node_runs.nodeId],
          set: {
            status: input.status,
            outputs: input.outputs ?? null,
            error: input.error ?? null,
            provider: input.provider ?? null,
            externalJobId: input.externalJobId ?? null,
            completedAt: new Date(),
          },
        });

      await events?.publish({
        type: "node.status",
        runId: input.runId,
        nodeId: input.nodeId,
        status: input.status,
        error: input.error ?? undefined,
      });
    },

    async updateRunStatus(input: UpdateRunStatusInput): Promise<void> {
      const setObj: Record<string, unknown> = {
        status: input.status,
      };
      if (input.status === "running") {
        setObj.startedAt = new Date();
      } else if (input.status === "succeeded" || input.status === "failed") {
        setObj.completedAt = new Date();
      }
      if (input.error) {
        setObj.error = input.error;
      }

      await db.update(runs).set(setObj).where(eq(runs.id, input.runId));

      await events?.publish({
        type: "run.status",
        runId: input.runId,
        status: input.status,
        error: input.error ?? undefined,
      });
    },

    async loadAsset(input: LoadAssetInput): Promise<LoadAssetResult> {
      const [asset] = await db
        .select()
        .from(assets)
        .where(eq(assets.id, input.assetId))
        .limit(1);

      if (!asset) {
        throw ApplicationFailure.nonRetryable(
          `Asset not found: ${input.assetId}`,
          "AssetNotFound",
        );
      }

      if (asset.status !== "ready") {
        throw ApplicationFailure.nonRetryable(
          `Asset not ready: ${input.assetId}`,
          "AssetNotReady",
        );
      }

      return {
        assetKey: asset.key,
        contentType: asset.contentType,
        sizeBytes: asset.sizeBytes,
      };
    },

    async saveAssetMetadata(input: SaveAssetMetadataInput): Promise<void> {
      await db
        .update(assets)
        .set({
          metadata: input.metadata,
          updatedAt: new Date(),
        })
        .where(eq(assets.id, input.assetId));
    },
  };
}
