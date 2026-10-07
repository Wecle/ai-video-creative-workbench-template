import { rmSync, writeFileSync } from "node:fs";
import { NativeConnection, Worker } from "@temporalio/worker";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { schema } from "@creative/database";
import { MockProvider, ProviderRegistry } from "@creative/providers";
import { startTelemetry } from "@creative/observability";
import { ORCHESTRATOR_TASK_QUEUE } from "@creative/workflows/constants";
import { createActivities } from "./activities";
import { loadConfig } from "./config";
import { workflowSource } from "./workflow-source";

const READY_FILE = "/tmp/orchestrator-worker.ready";

const config = loadConfig();
const telemetry = startTelemetry("creative-orchestrator-worker");

const sql = postgres(config.databaseUrl, { max: 5 });
const db = drizzle(sql, { schema });

const registry = new ProviderRegistry();
registry.register(new MockProvider(config.mockProviderWebhookSecret));

let connection: NativeConnection | undefined;
try {
  connection = await NativeConnection.connect({
    address: config.temporalAddress,
  });
  const worker = await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: ORCHESTRATOR_TASK_QUEUE,
    activities: { ...createActivities({ db, registry }) },
    shutdownGraceTime: "10s",
    ...workflowSource(),
  });
  writeFileSync(READY_FILE, "ready");
  await worker.run();
} catch (error) {
  console.error("orchestrator-worker failed", error);
  process.exitCode = 1;
} finally {
  rmSync(READY_FILE, { force: true });
  await connection?.close();
  await sql.end({ timeout: 5 }).catch(() => undefined);
  await telemetry.shutdown();
}
