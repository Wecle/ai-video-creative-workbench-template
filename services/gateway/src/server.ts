import { buildApp } from "./app";
import { startTelemetry } from "@creative/observability";

const telemetry = startTelemetry(
  process.env.OTEL_SERVICE_NAME ?? "creative-gateway",
);
const app = buildApp();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    await telemetry.shutdown();
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
try {
  await app.listen({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.GATEWAY_PORT ?? 4000),
  });
} catch (error) {
  app.log.error(error);
  await shutdown();
  process.exitCode = 1;
}
