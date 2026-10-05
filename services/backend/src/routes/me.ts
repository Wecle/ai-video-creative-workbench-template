import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { meResponseSchema } from "@creative/contracts";
import type { createDatabase } from "@creative/database";
import { schema } from "@creative/database";

export type Database = ReturnType<typeof createDatabase>["db"];

export async function meRoutes(instance: FastifyInstance, db: Database) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  app.get(
    "/api/v1/me",
    {
      schema: {
        response: {
          200: meResponseSchema,
          401: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.identity;
      const [user] = await db
        .select({
          id: schema.users.id,
          name: schema.users.name,
          email: schema.users.email,
          image: schema.users.image,
        })
        .from(schema.users)
        .where(eq(schema.users.id, userId!))
        .limit(1);
      // A valid token for a deleted user must not be treated as logged in.
      if (!user) return reply.code(401).send({ error: "Unauthorized" });
      const workspaces = await db
        .select({
          id: schema.workspaces.id,
          name: schema.workspaces.name,
          slug: schema.workspaces.slug,
          role: schema.workspace_members.role,
        })
        .from(schema.workspace_members)
        .innerJoin(
          schema.workspaces,
          eq(schema.workspace_members.workspace_id, schema.workspaces.id),
        )
        .where(eq(schema.workspace_members.userId, user.id))
        .orderBy(schema.workspaces.createdAt);
      return { user, workspaces };
    },
  );
}
