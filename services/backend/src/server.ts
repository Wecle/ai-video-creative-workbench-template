import { Client, Connection } from "@temporalio/client";
import { buildApp } from "./app";
import { createAuth } from "./auth/auth";
import { loadConfig } from "./config";
import { createDatabase, schema } from "@creative/database";
import { startTelemetry } from "@creative/observability";
import { createTemporalAgentRuns } from "./temporal/agent-runs";
import { createTemporalCanvasRuns } from "./temporal/canvas-runs";
import { defaultProviderRegistry } from "@creative/providers";

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
const app = buildApp({
  auth,
  db: database.db,
  internalSecret: config.internalSecret,
  webOrigin: config.webOrigin,
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
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await app.close();
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
