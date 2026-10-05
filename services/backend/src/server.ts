import { buildApp } from "./app";
import { createAuth } from "./auth/auth";
import { loadConfig } from "./config";
import { createDatabase, schema } from "@creative/database";
import { startTelemetry } from "@creative/observability";

const config = loadConfig();
const telemetry = startTelemetry(
  process.env.OTEL_SERVICE_NAME ?? "creative-backend",
);
const database = createDatabase(config.databaseUrl);
const auth = createAuth({ db: database.db, schema, config });
const app = buildApp({
  auth,
  db: database.db,
  internalSecret: config.internalSecret,
  webOrigin: config.webOrigin,
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await app.close();
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
