import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import { type AgentEvent, agentEventsSeqKey } from "@creative/contracts";
import { schema } from "@creative/database";
import { findAccessibleCanvas } from "../canvas/access";
import { requireUserOrTicket } from "../plugins/gateway-trust";
import type { AgentEventBus } from "../realtime/run-event-bus";
import { openRunStream } from "../realtime/sse-stream";
import { formatAgentLoopRun } from "./agent-loop";
import type { Database } from "./me";

const paramsSchema = z.object({
  runId: z.string().uuid(),
});

export type RealtimeAgentRoutesOptions = {
  db: Database;
  bus?: AgentEventBus;
  redis?: Redis;
  pingIntervalMs?: number;
};

export async function realtimeAgentRoutes(
  app: FastifyInstance,
  options: RealtimeAgentRoutesOptions,
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
    "/api/v1/realtime/agent/runs/:runId/events",
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

      const [runRow] = await db
        .select()
        .from(schema.agent_runs)
        .where(eq(schema.agent_runs.id, runId))
        .limit(1);

      if (!runRow || runRow.createdBy !== userId) {
        return reply.code(404).send({ error: "Run not found" });
      }

      const canvas = await findAccessibleCanvas(
        db,
        userId,
        runRow.projectId,
        runRow.canvasId,
        { id: schema.canvases.id },
      );

      if (!canvas) {
        return reply.code(404).send({ error: "Run not found" });
      }

      if (!bus || !redis) {
        return reply.code(503).send({ error: "Realtime service unavailable" });
      }

      await openRunStream<AgentEvent, unknown>(request, reply, {
        bus,
        redis,
        runId,
        seqKey: agentEventsSeqKey(runId),
        pingIntervalMs,
        activeConnections,
        isTerminalEvent: (evt) => {
          if (
            evt.type === "agent.run.status" &&
            (evt.status === "completed" || evt.status === "failed")
          ) {
            return evt.status;
          }
          return null;
        },
        loadSnapshot: async (seq0) => {
          const [latestRun] = await db
            .select()
            .from(schema.agent_runs)
            .where(eq(schema.agent_runs.id, runId))
            .limit(1);

          if (request.raw.destroyed) {
            return {
              snapshot: null,
              initialTerminalStatus: null,
            };
          }

          const currentRow = latestRun ?? runRow;
          const initialStatus = currentRow.status;
          const isTerminal =
            initialStatus === "completed" ||
            initialStatus === "failed" ||
            initialStatus === "cancelled";

          return {
            snapshot: {
              type: "snapshot",
              runId,
              seq: seq0,
              run: formatAgentLoopRun(currentRow),
            },
            initialTerminalStatus: isTerminal ? initialStatus : null,
          };
        },
      });
    },
  );
}
