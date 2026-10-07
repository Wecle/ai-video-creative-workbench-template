import { Client, Connection } from "@temporalio/client";
import { buildApp } from "./app";
import { createAuth } from "./auth/auth";
import { loadConfig } from "./config";
import { createDatabase, schema } from "@creative/database";
import { startTelemetry } from "@creative/observability";
import { createTemporalAgentRuns } from "./temporal/agent-runs";
import { createTemporalCanvasRuns } from "./temporal/canvas-runs";
import { defaultProviderRegistry } from "@creative/providers";

import { Redis } from "ioredis";
import { createRunEventBus } from "./realtime/run-event-bus";
import { createS3Storage } from "@creative/storage";

const config = loadConfig();
const telemetry = startTelemetry(
  process.env.OTEL_SERVICE_NAME ?? "creative-backend",
);
const database = createDatabase(config.databaseUrl);
const auth = createAuth({ db: database.db, schema, config });
// Lazy: the backend must start even if Temporal is briefly down; the connection recovers on its own.
const temporal = Connection.lazy({ address: config.temporalAddress });
const temporalClient = new Client({
  connection: temporal,
  namespace: config.temporalNamespace,
});

const redis = config.redisUrl
  ? new Redis(config.redisUrl, {
      connectTimeout: 500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
  : undefined;

const subscriberRedis = config.redisUrl
  ? new Redis(config.redisUrl, {
      connectTimeout: 500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
  : undefined;

const bus = subscriberRedis ? createRunEventBus(subscriberRedis) : undefined;

const storage = config.s3 ? createS3Storage(config.s3) : undefined;
if (storage && config.s3?.configureCors) {
  storage.configureCors([config.webOrigin]).catch((err) => {
    console.warn("Failed to configure S3 CORS:", err);
  });
}

const app = buildApp({
  auth,
  db: database.db,
  internalSecret: config.internalSecret,
  webOrigin: config.webOrigin,
  bus,
  redis,
  storage,
  agentRuns: createTemporalAgentRuns({
    client: temporalClient,
    connection: temporal,
  }),
  canvasRuns: createTemporalCanvasRuns({
    client: temporalClient,
    connection: temporal,
  }),
  providerRegistry: defaultProviderRegistry,
  production: config.production,
  allowMockMode: config.allowMockMode,
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    await redis?.quit();
    await temporal.close();
    await database.close();
    await telemetry.shutdown();
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await shutdown();
  process.exitCode = 1;
}
