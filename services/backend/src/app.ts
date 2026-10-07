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
import type { Redis } from "ioredis";
import { agentRunRoutes } from "./routes/agent-runs";
import { canvasRoutes } from "./routes/canvases";
import { canvasRunRoutes } from "./routes/canvas-runs";
import { projectRoutes } from "./routes/projects";
import { meRoutes, type Database } from "./routes/me";
import { realtimeRoutes } from "./routes/realtime";
import { webhookRoutes } from "./routes/webhooks";
import { assetRoutes } from "./routes/assets";
import type { ObjectStorage } from "@creative/storage";
import type { RunEventBus } from "./realtime/run-event-bus";
import type { AgentRunService } from "./temporal/agent-runs";
import type { CanvasRunService } from "./temporal/canvas-runs";
import type { AssetProbeService } from "./temporal/asset-probes";

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

const defaultAssetProbes: AssetProbeService = {
  start: async () => {
    throw new Error(
      "assetProbes.start must not be called without being provided",
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
  /** Starts media probe workflows. */
  assetProbes?: AssetProbeService;
  /** Provider registry (default: defaultProviderRegistry). */
  providerRegistry?: ProviderRegistry;
  /** Node definitions saved canvases are validated against (default: the shipped registry). */
  registry?: Registry;
  /** Production mode */
  production?: boolean;
  /** Allow mockMode in canvas runs (default: !production) */
  allowMockMode?: boolean;
  /** Redis pub/sub bus for realtime event streaming. */
  bus?: RunEventBus;
  /** Redis instance for reading sequence counters and state. */
  redis?: Redis;
  /** Ping interval for realtime SSE streams in ms (default: 15_000). */
  pingIntervalMs?: number;
  /** S3-compatible object storage for assets. */
  storage?: ObjectStorage;
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
  assetProbes = defaultAssetProbes,
  providerRegistry = defaultProviderRegistry,
  registry = defaultRegistry,
  production = false,
  allowMockMode = !production,
  bus,
  redis,
  pingIntervalMs,
  storage,
}: BackendOptions) {
  const app = Fastify({
    logger,
    bodyLimit: 1024 * 1024,
    requestTimeout: 10000,
    forceCloseConnections: true,
  }).withTypeProvider<ZodTypeProvider>();
  app.decorateRequest("identity");

  // First hook: nothing runs for a request the gateway did not sign.
  app.addHook("onRequest", verifyGatewayIdentity(internalSecret));
  app.addHook("onClose", async () => {
    await bus?.close();
  });
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
    app.register(async (webhookScope) => {
      await webhookRoutes(webhookScope, db, providerRegistry, canvasRuns);
    });

    // Realtime API: accepts Bearer JWT or realtime single-use ticket.
    app.register(async (realtimeScope) => {
      await realtimeRoutes(realtimeScope, {
        db,
        bus,
        redis,
        pingIntervalMs,
      });
    });

    // Business API: a valid gateway signature that vouches for a user is required.
    app.register(async (v1) => {
      v1.addHook("onRequest", requireUser);
      await meRoutes(v1, db);
      await agentRunRoutes(v1, agentRuns);
      await projectRoutes(v1, db);
      await canvasRoutes(v1, db, registry);
      await canvasRunRoutes(v1, db, canvasRuns, allowMockMode);
      await assetRoutes(v1, { db, storage, assetProbes });
    });
  });
  return app;
}
