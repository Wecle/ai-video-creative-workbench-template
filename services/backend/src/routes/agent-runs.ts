import { ServiceError } from "@temporalio/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  agentRequestSchema,
  agentRunResponseSchema,
} from "@creative/contracts";
import type { AgentRunService } from "../temporal/agent-runs";

const errorSchema = z.object({ error: z.string() });

/** Temporal unreachable, timed out or erroring: 503. Anything else is a bug and stays a 500. */
function unavailable(error: unknown, reply: FastifyReply) {
  if (!(error instanceof ServiceError)) throw error;
  return reply.code(503).send({ error: "Execution engine unavailable" });
}

export async function agentRunRoutes(
  instance: FastifyInstance,
  agentRuns: AgentRunService,
) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/api/v1/agent-runs",
    {
      schema: {
        body: agentRequestSchema,
        response: {
          202: agentRunResponseSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      // The owner comes from the gateway-signed identity only; the body has no userId.
      // projectId and canvasId are still opaque pass-through values here. Canvases now have
      // resource-level authorization, so code that starts using these fields to read or
      // write canvas data must first call findAccessibleCanvas (canvas/access.ts) and
      // answer 404 when it finds nothing; never trust them as given.
      try {
        const run = await agentRuns.start(
          request.identity.userId!,
          request.body,
        );
        return reply.code(202).send({ run });
      } catch (error) {
        return unavailable(error, reply);
      }
    },
  );

  app.get(
    "/api/v1/agent-runs/:runId",
    {
      schema: {
        params: z.object({ runId: z.uuid() }),
        response: {
          200: agentRunResponseSchema,
          404: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const run = await agentRuns.get(
          request.identity.userId!,
          request.params.runId,
        );
        if (!run) return reply.code(404).send({ error: "Run not found" });
        return { run };
      } catch (error) {
        return unavailable(error, reply);
      }
    },
  );
}
