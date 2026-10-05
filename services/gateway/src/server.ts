import { Redis } from "ioredis";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { AUTH_JWT_AUDIENCE } from "@creative/contracts/internal-auth";
import { startTelemetry } from "@creative/observability";

const config = loadConfig();
const telemetry = startTelemetry(
  process.env.OTEL_SERVICE_NAME ?? "creative-gateway",
);

// Fail fast instead of queueing commands while Redis is down; rate limiting
// then fails open (see skipOnError) and /ready reports the outage.
const redis = config.redisUrl
  ? new Redis(config.redisUrl, {
      connectTimeout: 500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
  : undefined;
if (!redis)
  console.warn(
    "REDIS_URL is not set: using in-process rate limiting (dev only)",
  );

const app = buildApp({
  backendUrl: config.backendUrl,
  internalSecret: config.internalSecret,
  trustProxy: config.trustProxy,
  jwt: { issuer: config.webOrigin, audience: AUTH_JWT_AUDIENCE },
  redis,
});
let closing = false;

async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    await redis?.quit();
    await telemetry.shutdown();
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  // enableOfflineQueue is off, so wait for the connection before the first PING.
  if (redis) {
    await new Promise<void>((resolve, reject) => {
      redis.once("ready", () => resolve());
      redis.once("error", reject);
    });
    await redis.ping();
  }
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await shutdown();
  process.exitCode = 1;
}
