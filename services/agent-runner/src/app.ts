import Fastify, { type FastifyError } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { validatorCompiler } from "fastify-type-provider-zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { agentRequestSchema } from "@creative/contracts";
import {
  EchoAgentAdapter,
  type AgentAdapter,
  type AgentRun,
} from "@creative/agent-core";
import { withSpan } from "@creative/observability";

export function buildApp({
  logger = true,
  adapter = new EchoAgentAdapter(),
}: { logger?: boolean; adapter?: AgentAdapter } = {}) {
  const app = Fastify({
    logger,
    bodyLimit: 64 * 1024,
    requestTimeout: 10000,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.register(helmet);
  app.register(rateLimit, { max: 30, timeWindow: "1 minute" });
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation)
      return reply.code(400).send({ error: "Invalid request" });
    const code = error.statusCode ?? 500;
    if (code >= 500) request.log.error({ err: error }, "Agent request failed");
    return reply
      .code(code)
      .send({ error: code >= 500 ? "Agent adapter failed" : error.message });
  });
  // Register routes after plugins so onRoute hooks see every endpoint.
  app.register(async (instance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    app.get("/health", async () => ({ status: "ok", service: "agent-runner" }));
    app.post(
      "/runs",
      { schema: { body: agentRequestSchema } },
      async (request) => {
        const run: AgentRun = {
          id: crypto.randomUUID(),
          status: "running",
          projectId: request.body.projectId,
          canvasId: request.body.canvasId,
          createdAt: new Date().toISOString(),
        };
        const result = await withSpan("agent.echo-run", () =>
          adapter.run({ run, prompt: request.body.prompt }),
        );
        return { run: { ...run, status: "completed" }, result, mode: "echo" };
      },
    );
  });
  return app;
}
