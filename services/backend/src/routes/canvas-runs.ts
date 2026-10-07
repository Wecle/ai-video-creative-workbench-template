import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  type CanvasRunStatus,
  type NodeRunStatus,
  getCanvasRunResponseSchema,
  startCanvasRunRequestSchema,
  startCanvasRunResponseSchema,
} from "@creative/contracts";
import { schema } from "@creative/database";
import { canvasRunWorkflowId } from "@creative/workflows/constants";
import { findAccessibleCanvas } from "../canvas/access";
import type { CanvasRunService } from "../temporal/canvas-runs";
import type { Database } from "./me";

const { canvases, runs, node_runs } = schema;
const errorSchema = z.object({ error: z.string() });

const runParams = z.object({
  projectId: z.uuid(),
  canvasId: z.uuid(),
});

const getRunParams = z.object({
  projectId: z.uuid(),
  canvasId: z.uuid(),
  runId: z.uuid(),
});

export async function canvasRunRoutes(
  instance: FastifyInstance,
  db: Database,
  canvasRuns: CanvasRunService,
  production = false,
) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const base = "/api/v1/projects/:projectId/canvases/:canvasId/runs";

  app.post(
    base,
    {
      schema: {
        params: runParams,
        body: startCanvasRunRequestSchema,
        response: {
          202: startCanvasRunResponseSchema,
          400: errorSchema,
          404: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const { projectId, canvasId } = request.params;
      const { mockMode } = request.body;

      if (production && mockMode) {
        return reply
          .code(400)
          .send({ error: "mockMode is not allowed in production" });
      }

      const canvas = await findAccessibleCanvas(
        db,
        request.identity.userId!,
        projectId,
        canvasId,
        {
          id: canvases.id,
          projectId: canvases.projectId,
          workspaceId: canvases.workspaceId,
          version: canvases.version,
          snapshot: canvases.snapshot,
        },
      );
      if (!canvas) {
        return reply.code(404).send({ error: "Canvas not found" });
      }

      const runId = randomUUID();
      const workflowId = canvasRunWorkflowId(canvasId, runId);

      const [newRun] = await db
        .insert(runs)
        .values({
          id: runId,
          canvasId,
          projectId,
          workspaceId: canvas.workspaceId,
          createdBy: request.identity.userId!,
          status: "queued",
          canvasVersion: canvas.version,
          snapshot: {
            ...(canvas.snapshot as Record<string, unknown>),
            mockMode,
          },
          workflowId,
        })
        .returning();

      try {
        await canvasRuns.start({
          canvasId,
          runId,
          mockMode,
        });
      } catch (error) {
        request.log.error(
          { err: error },
          "Failed to start canvas DAG workflow",
        );
        await db
          .update(runs)
          .set({
            status: "failed",
            error: "Execution engine unavailable",
            completedAt: new Date(),
          })
          .where(eq(runs.id, runId));
        return reply.code(503).send({ error: "Execution engine unavailable" });
      }

      return reply.code(202).send({
        run: {
          id: newRun.id,
          canvasId: newRun.canvasId,
          projectId: newRun.projectId,
          status: "queued",
          canvasVersion: newRun.canvasVersion,
          error: null,
          createdBy: newRun.createdBy,
          createdAt: newRun.createdAt.toISOString(),
          startedAt: null,
          completedAt: null,
          nodeRuns: [],
        },
      });
    },
  );

  app.get(
    `${base}/:runId`,
    {
      schema: {
        params: getRunParams,
        response: {
          200: getCanvasRunResponseSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const { projectId, canvasId, runId } = request.params;

      const canvas = await findAccessibleCanvas(
        db,
        request.identity.userId!,
        projectId,
        canvasId,
        { id: canvases.id },
      );
      if (!canvas) {
        return reply.code(404).send({ error: "Canvas not found" });
      }

      const [runRow] = await db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.canvasId, canvasId),
            eq(runs.projectId, projectId),
          ),
        )
        .limit(1);

      if (!runRow) {
        return reply.code(404).send({ error: "Run not found" });
      }

      const nodeRunRows = await db
        .select()
        .from(node_runs)
        .where(eq(node_runs.runId, runId))
        .orderBy(node_runs.createdAt);

      return reply.code(200).send({
        run: {
          id: runRow.id,
          canvasId: runRow.canvasId,
          projectId: runRow.projectId,
          status: runRow.status as CanvasRunStatus,
          canvasVersion: runRow.canvasVersion,
          error: runRow.error ?? null,
          createdBy: runRow.createdBy ?? null,
          createdAt: runRow.createdAt.toISOString(),
          startedAt: runRow.startedAt?.toISOString() ?? null,
          completedAt: runRow.completedAt?.toISOString() ?? null,
          nodeRuns: nodeRunRows.map((nr) => ({
            id: nr.id,
            nodeId: nr.nodeId,
            nodeType: nr.nodeType,
            provider: nr.provider ?? null,
            externalJobId: nr.externalJobId ?? null,
            status: nr.status as NodeRunStatus,
            inputs: nr.inputs as Record<string, unknown> | null,
            outputs: nr.outputs as Record<string, unknown> | null,
            error: nr.error ?? null,
            createdAt: nr.createdAt.toISOString(),
            startedAt: nr.startedAt?.toISOString() ?? null,
            completedAt: nr.completedAt?.toISOString() ?? null,
          })),
        },
      });
    },
  );
}
