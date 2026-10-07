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

      const rawBuffer =
        (request as unknown as { rawBody?: Buffer }).rawBody ??
        (Buffer.isBuffer(request.body)
          ? request.body
          : Buffer.from(
              typeof request.body === "string"
                ? request.body
                : JSON.stringify(request.body ?? {}),
            ));

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

      // Optimization: if node_run is already terminal in database, return 200 early
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

      if (
        existingNodeRun &&
        (existingNodeRun.status === "succeeded" ||
          existingNodeRun.status === "failed")
      ) {
        return reply.code(200).send({ message: "already processed" });
      }

      if (existingNodeRun) {
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
      }

      return reply.code(200).send({ received: true });
    },
  );
}
