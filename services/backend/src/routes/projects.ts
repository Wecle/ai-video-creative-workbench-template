import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createProjectRequestSchema,
  createProjectResponseSchema,
  projectListResponseSchema,
  type ProjectSummary,
} from "@creative/contracts";
import { schema } from "@creative/database";
import {
  createCanvasDoc,
  encodeState,
  readSnapshot,
  SCHEMA_VERSION,
} from "@creative/canvas-doc";
import { workspacesOf } from "../canvas/access";
import type { Database } from "./me";

const { projects, canvases, workspace_members, workspaces } = schema;
const errorSchema = z.object({ error: z.string() });

export async function projectRoutes(instance: FastifyInstance, db: Database) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/v1/projects",
    { schema: { response: { 200: projectListResponseSchema } } },
    async (request) => {
      const { userId } = request.identity;
      const rows = await db
        .select()
        .from(projects)
        .where(inArray(projects.workspaceId, workspacesOf(db, userId!)))
        .orderBy(desc(projects.createdAt), asc(projects.id));
      const canvasRows =
        rows.length === 0
          ? []
          : await db
              .select({
                id: canvases.id,
                name: canvases.name,
                projectId: canvases.projectId,
              })
              .from(canvases)
              .where(
                inArray(
                  canvases.projectId,
                  rows.map((row) => row.id),
                ),
              )
              .orderBy(asc(canvases.createdAt), asc(canvases.id));
      return {
        projects: rows.map((row): ProjectSummary => ({
          id: row.id,
          workspaceId: row.workspaceId,
          name: row.name,
          createdAt: row.createdAt.toISOString(),
          canvases: canvasRows
            .filter((canvas) => canvas.projectId === row.id)
            .map(({ id, name }) => ({ id, name })),
        })),
      };
    },
  );

  app.post(
    "/api/v1/projects",
    {
      schema: {
        body: createProjectRequestSchema,
        response: { 201: createProjectResponseSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const userId = request.identity.userId!;
      const { name, workspaceId } = request.body;
      // Default: the user's oldest workspace. An explicit one must be a membership;
      // otherwise answer as if it did not exist.
      const [membership] = await db
        .select({ id: workspaces.id })
        .from(workspace_members)
        .innerJoin(
          workspaces,
          eq(workspace_members.workspace_id, workspaces.id),
        )
        .where(
          workspaceId
            ? and(
                eq(workspace_members.userId, userId),
                eq(workspaces.id, workspaceId),
              )
            : eq(workspace_members.userId, userId),
        )
        .orderBy(asc(workspaces.createdAt))
        .limit(1);
      if (!membership)
        return reply.code(404).send({ error: "Workspace not found" });

      // New canvases start empty. The server creates the initial state so that clients
      // only ever load a document, never initialize one.
      const doc = createCanvasDoc();
      const state = encodeState(doc);
      const snapshot = readSnapshot(doc);
      const canvasName = "Main canvas";
      const project = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(projects)
          .values({ workspaceId: membership.id, name, createdBy: userId })
          .returning();
        const [canvas] = await tx
          .insert(canvases)
          .values({
            projectId: created!.id,
            workspaceId: membership.id,
            name: canvasName,
            yjsState: state,
            snapshot,
            schemaVersion: SCHEMA_VERSION,
            version: 0,
            updatedBy: userId,
          })
          .returning({ id: canvases.id, name: canvases.name });
        return { created: created!, canvas: canvas! };
      });
      return reply.code(201).send({
        project: {
          id: project.created.id,
          workspaceId: project.created.workspaceId,
          name: project.created.name,
          createdAt: project.created.createdAt.toISOString(),
          canvases: [project.canvas],
        },
      });
    },
  );
}
