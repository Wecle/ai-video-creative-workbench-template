import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  canvasConflictSchema,
  canvasInvalidSchema,
  canvasSnapshotResponseSchema,
  getCanvasResponseSchema,
  saveCanvasRequestSchema,
  saveCanvasResponseSchema,
} from "@creative/contracts";
import { schema } from "@creative/database";
import {
  SCHEMA_VERSION,
  fromBase64,
  inspectState,
  toBase64,
} from "@creative/canvas-doc";
import type { Registry } from "@creative/node-registry";
import { findAccessibleCanvas, workspacesOf } from "../canvas/access";
import type { Database } from "./me";

const { canvases } = schema;
const errorSchema = z.object({ error: z.string() });
const params = z.object({ projectId: z.uuid(), canvasId: z.uuid() });
const NOT_FOUND = { error: "Canvas not found" };

export async function canvasRoutes(
  instance: FastifyInstance,
  db: Database,
  registry: Registry,
) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const base = "/api/v1/projects/:projectId/canvases/:canvasId";

  app.get(
    base,
    {
      schema: {
        params,
        response: { 200: getCanvasResponseSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const { projectId, canvasId } = request.params;
      const canvas = await findAccessibleCanvas(
        db,
        request.identity.userId!,
        projectId,
        canvasId,
        { ...canvasColumns, yjsState: canvases.yjsState },
      );
      if (!canvas) return reply.code(404).send(NOT_FOUND);
      return {
        canvas: {
          id: canvas.id,
          projectId: canvas.projectId,
          name: canvas.name,
          version: canvas.version,
          updatedAt: canvas.updatedAt.toISOString(),
        },
        state: toBase64(canvas.yjsState),
      };
    },
  );

  app.get(
    `${base}/snapshot`,
    {
      schema: {
        params,
        response: { 200: canvasSnapshotResponseSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const { projectId, canvasId } = request.params;
      const canvas = await findAccessibleCanvas(
        db,
        request.identity.userId!,
        projectId,
        canvasId,
        { version: canvases.version, snapshot: canvases.snapshot },
      );
      if (!canvas) return reply.code(404).send(NOT_FOUND);
      return {
        version: canvas.version,
        snapshot: canvas.snapshot as z.infer<
          typeof canvasSnapshotResponseSchema
        >["snapshot"],
      };
    },
  );

  app.put(
    `${base}/state`,
    {
      schema: {
        params,
        body: saveCanvasRequestSchema,
        response: {
          200: saveCanvasResponseSchema,
          404: errorSchema,
          409: canvasConflictSchema,
          422: canvasInvalidSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.identity.userId!;
      const { projectId, canvasId } = request.params;
      const { baseVersion, state } = request.body;
      // Authorize before doing any work on the payload.
      if (!(await findAccessibleCanvas(db, userId, projectId, canvasId)))
        return reply.code(404).send(NOT_FOUND);

      // The server never trusts the client's JSON: the snapshot is derived here, from the
      // state, after the state passed every check.
      const inspected = inspectState(fromBase64(state), registry);
      if (!inspected.ok)
        return reply
          .code(422)
          .send({ error: "Invalid canvas state", issues: inspected.issues });
      inspected.doc.destroy();

      // One conditional UPDATE: it succeeds for exactly one of any number of concurrent
      // saves from the same base version, and it re-checks membership so that a user
      // removed from the workspace after the check above cannot write.
      const updatedAt = new Date();
      const [saved] = await db
        .update(canvases)
        .set({
          yjsState: fromBase64(state),
          snapshot: inspected.snapshot,
          schemaVersion: SCHEMA_VERSION,
          version: sql`${canvases.version} + 1`,
          updatedAt,
          updatedBy: userId,
        })
        .where(
          and(
            eq(canvases.id, canvasId),
            eq(canvases.projectId, projectId),
            eq(canvases.version, baseVersion),
            inArray(canvases.workspaceId, workspacesOf(db, userId)),
          ),
        )
        .returning({ version: canvases.version });
      if (saved)
        return { version: saved.version, updatedAt: updatedAt.toISOString() };

      // No row: the canvas became inaccessible (404) or someone saved first (409).
      const current = await findAccessibleCanvas(
        db,
        userId,
        projectId,
        canvasId,
      );
      if (!current) return reply.code(404).send(NOT_FOUND);
      return reply.code(409).send({
        error: "Canvas was updated elsewhere",
        currentVersion: current.version,
      });
    },
  );
}

const canvasColumns = {
  id: canvases.id,
  projectId: canvases.projectId,
  name: canvases.name,
  version: canvases.version,
  updatedAt: canvases.updatedAt,
} as const;
