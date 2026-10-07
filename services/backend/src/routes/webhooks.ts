import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { schema } from "@creative/database";
import {
  WebhookVerificationError,
  type ProviderRegistry,
} from "@creative/providers";
import type { CanvasRunService } from "../temporal/canvas-runs";
import type { Database } from "./me";

const { runs, node_runs } = schema;
const params = z.object({
  provider: z.string().min(1),
});

export async function webhookRoutes(
  instance: FastifyInstance,
  db: Database,
  providerRegistry: ProviderRegistry,
  canvasRuns: CanvasRunService,
) {
  // Encapsulated parser: only routes in this scope receive the raw Buffer body
  instance.removeAllContentTypeParsers();
  instance.addContentTypeParser(
    "*",
    { parseAs: "buffer" },
    (_request, body: Buffer, done) => done(null, body),
  );

  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/api/webhooks/providers/:provider",
    {
      schema: {
        params,
      },
    },
    async (request, reply) => {
      const { provider } = request.params;
      const adapter = providerRegistry.get(provider);
      if (!adapter) {
        return reply
          .code(404)
          .send({ error: `Provider ${provider} not found` });
      }

      const rawBuffer = Buffer.isBuffer(request.body) ? request.body : null;
      if (!rawBuffer) {
        return reply.code(400).send({ error: "Missing raw request body" });
      }

      let parsed;
      try {
        parsed = await adapter.parseWebhook({
          rawBody: rawBuffer,
          headers: request.headers,
        });
      } catch (error) {
        if (error instanceof WebhookVerificationError) {
          return reply.code(401).send({ error: error.message });
        }
        return reply.code(400).send({ error: (error as Error).message });
      }

      // Check existing node_run in database
      const [existingNodeRun] = await db
        .select({
          id: node_runs.id,
          runId: node_runs.runId,
          status: node_runs.status,
        })
        .from(node_runs)
        .where(
          and(
            eq(node_runs.provider, provider),
            eq(node_runs.externalJobId, parsed.externalId),
          ),
        )
        .limit(1);

      // If job is not found yet in node_runs, return 409 so provider will retry
      if (!existingNodeRun) {
        return reply.code(409).send({
          error: `External job ${parsed.externalId} not found or not registered yet, retry later`,
        });
      }

      // Optimization: if node_run is already terminal in database, return 200 early
      if (
        existingNodeRun.status === "succeeded" ||
        existingNodeRun.status === "failed"
      ) {
        return reply.code(200).send({ message: "already processed" });
      }

      const [run] = await db
        .select({ workflowId: runs.workflowId })
        .from(runs)
        .where(eq(runs.id, existingNodeRun.runId))
        .limit(1);

      if (run) {
        try {
          await canvasRuns.sendCallbackSignal(run.workflowId, {
            provider,
            externalJobId: parsed.externalId,
            status: parsed.status === "failed" ? "failed" : "succeeded",
            output: parsed.output,
            error: parsed.error,
          });
        } catch (err) {
          request.log.warn(
            { err, workflowId: run.workflowId },
            "Failed to signal workflow (may have already completed)",
          );
        }
      }

      return reply.code(200).send({ received: true });
    },
  );
}
