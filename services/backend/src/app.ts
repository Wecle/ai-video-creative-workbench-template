import Fastify, { type FastifyError } from "fastify";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { z } from "zod";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import {
  canvasDocumentSchema,
  demoCanvasDocument,
  healthSchema,
} from "@creative/contracts";
import { withSpan } from "@creative/observability";

export function buildApp({ logger = true }: { logger?: boolean } = {}) {
  const app = Fastify({
    logger,
    bodyLimit: 1024 * 1024,
    requestTimeout: 10000,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(helmet, { contentSecurityPolicy: false });
  app.register(swagger, {
    openapi: { info: { title: "Creative Backend", version: "0.1.0" } },
    transform: jsonSchemaTransform,
  });
  app.register(swaggerUi, { routePrefix: "/docs" });
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation)
      return reply.code(400).send({ error: "Invalid request" });
    const code = error.statusCode ?? 500;
    if (code >= 500) request.log.error({ err: error }, "Request failed");
    return reply
      .code(code)
      .send({ error: code >= 500 ? "Internal server error" : error.message });
  });
  // Register routes after plugins so onRoute hooks see every endpoint.
  app.register(async (instance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    app.get(
      "/health",
      { schema: { response: { 200: healthSchema } } },
      async () => ({ status: "ok" as const, service: "backend" }),
    );
    app.get("/ready", async () => ({
      status: "ready",
      mode: "template",
      dependencies: { database: "unused", redis: "unused" },
    }));
    app.get("/api/v1/projects", async () => ({
      projects: [
        { id: "demo-project", name: "Demo Creative Project", status: "draft" },
      ],
    }));
    app.get(
      "/api/v1/canvases/:canvasId/document",
      {
        schema: {
          params: z.object({ canvasId: z.string().min(1).max(100) }),
          response: {
            200: canvasDocumentSchema,
            404: z.object({ error: z.string() }),
          },
        },
      },
      async (request, reply) => {
        if (request.params.canvasId !== "demo")
          return reply.code(404).send({ error: "Canvas not found" });
        return withSpan("backend.demo-canvas", async () => demoCanvasDocument);
      },
    );
  });
  return app;
}
