import { PassThrough } from "node:stream";
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

      // 2. Subscribe to bus before snapshot so no events are missed
      const buffer: RunEvent[] = [];
      let live = false;
      let ended = false;
      let pingInterval: NodeJS.Timeout | null = null;
      const stream = new PassThrough();

      const push = (event: RunEvent) => {
        if (ended) return;
        if (!live) {
          buffer.push(event);
        } else {
          sendEvent(event);
        }
      };

      const unsubscribe = await bus.subscribe(runId, push);

      function cleanup() {
        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }
        try {
          const res = unsubscribe() as unknown;
          if (res && typeof (res as Promise<void>).catch === "function") {
            (res as Promise<void>).catch(() => {});
          }
        } catch {
          // Ignore cleanup errors
        }
      }

      const closeStream = () => {
        if (!ended) {
          ended = true;
          activeConnections.delete(closeStream);
          cleanup();
          stream.end();
        }
      };

      activeConnections.add(closeStream);
      request.raw.on("close", () => {
        closeStream();
      });

      if (request.raw.destroyed) {
        closeStream();
        return;
      }

      function finish(status: string) {
        if (ended) return;
        stream.write(`event: done\ndata: ${JSON.stringify({ status })}\n\n`);
        closeStream();
      }

      let lastSeq = 0;

      function sendEvent(evt: RunEvent) {
        if (ended) return;
        if (evt.seq <= lastSeq) return;
        lastSeq = evt.seq;
        stream.write(
          `id: ${evt.seq}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`,
        );
        if (
          evt.type === "run.status" &&
          (evt.status === "succeeded" ||
            evt.status === "failed" ||
            evt.status === "cancelled")
        ) {
          finish(evt.status);
        }
      }

      try {
        // 3. Read seq0 before querying database for snapshot
        const rawSeq = await redis.get(runEventsSeqKey(runId));
        if (request.raw.destroyed || ended) {
          closeStream();
          return;
        }
        const seq0 = rawSeq ? Number(rawSeq) : 0;
        lastSeq = seq0;

        // 4. Read database for latest run and node_runs snapshot
        const [latestRun] = await db
          .select({ status: runs.status, error: runs.error })
          .from(runs)
          .where(eq(runs.id, runId))
          .limit(1);
        if (request.raw.destroyed || ended) {
          closeStream();
          return;
        }

        const nodeRunRows = await db
          .select({
            nodeId: node_runs.nodeId,
            status: node_runs.status,
            error: node_runs.error,
          })
          .from(node_runs)
          .where(eq(node_runs.runId, runId));
        if (request.raw.destroyed || ended) {
          closeStream();
          return;
        }

        // 5. Send SSE headers
        reply.raw.setHeader("Content-Type", "text/event-stream");
        reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
        reply.raw.setHeader("Connection", "keep-alive");
        reply.raw.setHeader("X-Accel-Buffering", "no");

        reply.send(stream);

        stream.write("retry: 3000\n\n");

        // Write snapshot
        const snapshot = {
          type: "snapshot",
          runId,
          seq: seq0,
          status: latestRun?.status ?? runRow.status,
          error: latestRun?.error ?? undefined,
          nodes: nodeRunRows.map((nr) => ({
            nodeId: nr.nodeId,
            status: nr.status as NodeRunStatus,
            error: nr.error ?? undefined,
          })),
        };
        stream.write(
          `id: ${seq0}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
        );

        // Flush buffer for events > seq0
        for (const evt of buffer) {
          if (evt.seq > seq0) {
            sendEvent(evt);
          }
        }
        live = true;

        // If initial state is terminal, finish immediately
        const initialStatus = latestRun?.status ?? runRow.status;
        if (
          initialStatus === "succeeded" ||
          initialStatus === "failed" ||
          initialStatus === "cancelled"
        ) {
          finish(initialStatus);
        }

        // Periodic ping
        if (!ended) {
          pingInterval = setInterval(async () => {
            if (ended) return;
            try {
              const current = await redis.get(runEventsSeqKey(runId));
              const seq = current ? Number(current) : lastSeq;
              stream.write(`event: ping\ndata: ${JSON.stringify({ seq })}\n\n`);
            } catch {
              // Ignore redis ping errors
            }
          }, pingIntervalMs);
        }
      } catch (err) {
        closeStream();
        throw err;
      }
    },
  );
}
