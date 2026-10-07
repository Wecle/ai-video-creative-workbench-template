import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import {
  type NodeRunStatus,
  type RunEvent,
  runEventsSeqKey,
} from "@creative/contracts";
import { schema } from "@creative/database";
import { findAccessibleCanvas } from "../canvas/access";
import { requireUserOrTicket } from "../plugins/gateway-trust";
import type { RunEventBus } from "../realtime/run-event-bus";
import { openRunStream } from "../realtime/sse-stream";
import type { Database } from "./me";

const { canvases, runs, node_runs } = schema;

export type RealtimeRoutesOptions = {
  db: Database;
  bus?: RunEventBus;
  redis?: Redis;
  pingIntervalMs?: number;
};

const paramsSchema = z.object({
  runId: z.string().uuid(),
});

export async function realtimeRoutes(
  app: FastifyInstance,
  options: RealtimeRoutesOptions,
) {
  const { db, bus, redis, pingIntervalMs = 15_000 } = options;
  const activeConnections = new Set<() => void>();

  app.addHook("onClose", async () => {
    for (const close of activeConnections) {
      close();
    }
    activeConnections.clear();
  });

  app.get(
    "/api/v1/realtime/runs/:runId/events",
    {
      onRequest: [requireUserOrTicket],
    },
    async (request, reply) => {
      const parsedParams = paramsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: "Invalid run ID" });
      }
      const { runId } = parsedParams.data;
      const userId = request.identity.userId!;

      // 1. Verify existence and canvas access
      const [runRow] = await db
        .select({
          id: runs.id,
          canvasId: runs.canvasId,
          projectId: runs.projectId,
          status: runs.status,
          error: runs.error,
        })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1);

      if (!runRow) {
        return reply.code(404).send({ error: "Run not found" });
      }

      const canvas = await findAccessibleCanvas(
        db,
        userId,
        runRow.projectId,
        runRow.canvasId,
        { id: canvases.id },
      );

      if (!canvas) {
        return reply.code(404).send({ error: "Run not found" });
      }

      if (!bus || !redis) {
        return reply.code(503).send({ error: "Realtime service unavailable" });
      }

      await openRunStream<RunEvent, unknown>(request, reply, {
        bus,
        redis,
        runId,
        seqKey: runEventsSeqKey(runId),
        pingIntervalMs,
        activeConnections,
        isTerminalEvent: (evt) => {
          if (
            evt.type === "run.status" &&
            (evt.status === "succeeded" ||
              evt.status === "failed" ||
              evt.status === "cancelled")
          ) {
            return evt.status;
          }
          return null;
        },
        loadSnapshot: async (seq0) => {
          const [latestRun] = await db
            .select({ status: runs.status, error: runs.error })
            .from(runs)
            .where(eq(runs.id, runId))
            .limit(1);

          if (request.raw.destroyed) {
            return {
              snapshot: null as any,
              initialTerminalStatus: null,
            };
          }

          const nodeRunRows = await db
            .select({
              nodeId: node_runs.nodeId,
              status: node_runs.status,
              error: node_runs.error,
            })
            .from(node_runs)
            .where(eq(node_runs.runId, runId));

          const initialStatus = latestRun?.status ?? runRow.status;
          const isTerminal =
            initialStatus === "succeeded" ||
            initialStatus === "failed" ||
            initialStatus === "cancelled";

          return {
            snapshot: {
              type: "snapshot",
              runId,
              seq: seq0,
              status: initialStatus,
              error: latestRun?.error ?? undefined,
              nodes: nodeRunRows.map((nr) => ({
                nodeId: nr.nodeId,
                status: nr.status as NodeRunStatus,
                error: nr.error ?? undefined,
              })),
            },
            initialTerminalStatus: isTerminal ? initialStatus : null,
          };
        },
      });
    },
  );
}
