import Fastify, { type FastifyError } from "fastify";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { healthSchema } from "@creative/contracts";
import {
  registry as defaultRegistry,
  type Registry,
} from "@creative/node-registry";
import {
  defaultProviderRegistry,
  type ProviderRegistry,
} from "@creative/providers";
import { sql } from "drizzle-orm";
import type { Auth } from "./auth/auth";
import { authRoutes } from "./auth/routes";
import { requireUser, verifyGatewayIdentity } from "./plugins/gateway-trust";
import { agentRunRoutes } from "./routes/agent-runs";
import { canvasRoutes } from "./routes/canvases";
import { canvasRunRoutes } from "./routes/canvas-runs";
import { projectRoutes } from "./routes/projects";
import { meRoutes, type Database } from "./routes/me";
import { webhookRoutes } from "./routes/webhooks";
import type { AgentRunService } from "./temporal/agent-runs";
import type { CanvasRunService } from "./temporal/canvas-runs";

const defaultCanvasRuns: CanvasRunService = {
  start: async () => {
    throw new Error(
      "canvasRuns.start must not be called without being provided",
    );
  },
  sendCallbackSignal: async () => {
    throw new Error(
      "canvasRuns.sendCallbackSignal must not be called without being provided",
    );
  },
};

export type BackendOptions = {
  logger?: boolean;
  auth: Auth;
  db: Database;
  /** Gateway-to-backend signing secret (INTERNAL_AUTH_SECRET). */
  internalSecret: string;
  /** Origin the browser uses; Better Auth routes are matched against it. */
  webOrigin: string;
  /** Starts and queries agent runs (Temporal in production, a fake in tests). */
  agentRuns: AgentRunService;
  /** Starts canvas runs and signals workflows. */
  canvasRuns?: CanvasRunService;
  /** Provider registry (default: defaultProviderRegistry). */
  providerRegistry?: ProviderRegistry;
  /** Node definitions saved canvases are validated against (default: the shipped registry). */
  registry?: Registry;
  /** Production mode */
  production?: boolean;
};

const ok = () => "ready" as const;
const fail = () => "unavailable" as const;

export function buildApp({
  logger = true,
  auth,
  db,
  internalSecret,
  webOrigin,
  agentRuns,
  canvasRuns = defaultCanvasRuns,
  providerRegistry = defaultProviderRegistry,
  registry = defaultRegistry,
  production = false,
}: BackendOptions) {
  const app = Fastify({
    logger,
    bodyLimit: 1024 * 1024,
    requestTimeout: 10000,
  }).withTypeProvider<ZodTypeProvider>();
  app.decorateRequest("identity");

  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body: Buffer, done) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = body;
      if (body.length === 0) {
        done(null, null);
        return;
      }
      try {
        const json = JSON.parse(body.toString("utf8"));
        done(null, json);
      } catch (err: unknown) {
        const error = err as Error & { statusCode?: number };
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );

  app.addContentTypeParser(
    ["application/octet-stream", "text/plain"],
    { parseAs: "buffer" },
    (req, body: Buffer, done) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = body;
      done(null, body);
    },
  );

  // First hook: nothing runs for a request the gateway did not sign.
  app.addHook("onRequest", verifyGatewayIdentity(internalSecret));
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
      {
        config: { public: true },
        schema: { response: { 200: healthSchema } },
      },
      async () => ({ status: "ok" as const, service: "backend" }),
    );
    app.get("/ready", { config: { public: true } }, async (_request, reply) => {
      const [database, temporal] = await Promise.all([
        db.execute(sql`select 1`).then(ok, fail),
        agentRuns.ping().then(ok, fail),
      ]);
      const dependencies = { database, temporal };
      if (database === "ready" && temporal === "ready")
        return { status: "ready", dependencies };
      return reply.code(503).send({ status: "not_ready", dependencies });
    });
    app.register(authRoutes, { auth, webOrigin });

    // Webhooks API: external providers callback through gateway without Bearer token
    await webhookRoutes(app, db, providerRegistry, canvasRuns);

    // Business API: a valid gateway signature that vouches for a user is required.
    app.register(async (v1) => {
      v1.addHook("onRequest", requireUser);
      await meRoutes(v1, db);
      await agentRunRoutes(v1, agentRuns);
      await projectRoutes(v1, db);
      await canvasRoutes(v1, db, registry);
      await canvasRunRoutes(v1, db, canvasRuns, production);
    });
  });
  return app;
}
