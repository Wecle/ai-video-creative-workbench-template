import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { schema } from "@creative/database";
import type { CanvasSnapshot } from "@creative/contracts";
import type { ProviderRegistry } from "@creative/providers";
import type {
  ExecuteNodeInput,
  ExecuteNodeResult,
  OrchestratorActivities,
  PollJobInput,
  PollJobResult,
  RecordNodeRunCompletedInput,
  RecordNodeRunStartedInput,
  RunGraphData,
  UpdateRunStatusInput,
} from "@creative/workflows/activities";

const { runs, node_runs } = schema;

export type Database = PostgresJsDatabase<typeof schema>;

export interface ActivityContext {
  db: Database;
  registry: ProviderRegistry;
}

export function createActivities({
  db,
  registry,
}: ActivityContext): OrchestratorActivities {
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

      return {
        runId: run.id,
        canvasId: run.canvasId,
        projectId: run.projectId,
        canvasVersion: run.canvasVersion,
        snapshot,
        mockMode: snap?.mockMode as "polling" | "callback" | undefined,
        region: snap?.region as string | undefined,
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
    },
  };
}
