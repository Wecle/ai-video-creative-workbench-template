import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { NativeConnection, Worker } from "@temporalio/worker";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { schema } from "@creative/database";
import { Redis } from "ioredis";
import { startTelemetry } from "@creative/observability";
import { AGENT_TASK_QUEUE } from "@creative/workflows/constants";
import { createModelResolver } from "@creative/agent-core/runtime";
import { createActivities } from "./activities";
import { createAgentLoopActivities } from "./agent-loop-activities";
import { createAgentEventPublisher } from "./events";
import { loadConfig } from "./config";
import { workflowSource } from "./workflow-source";

const READY_FILE = "/tmp/agent-runner.ready";

const config = loadConfig();
const telemetry = startTelemetry("creative-agent-runner");

// Validate skills directory at startup
if (
  !existsSync(config.agentSkillsDir) ||
  readdirSync(config.agentSkillsDir).length === 0
) {
  console.error(
    `Skills directory missing or empty at ${config.agentSkillsDir}`,
  );
  process.exit(1);
}

const sql = postgres(config.databaseUrl, { max: 5 });
const db = drizzle(sql, { schema });

const redis = config.redisUrl
  ? new Redis(config.redisUrl, {
      connectTimeout: 500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
  : undefined;

const publisher = createAgentEventPublisher(redis);
const modelResolver = createModelResolver({
  mockChunkDelayMs: config.agentMockChunkDelayMs,
});

const agentLoopActivities = createAgentLoopActivities({
  db,
  publisher,
  skillsDir: config.agentSkillsDir,
  modelResolver,
});

let connection: NativeConnection | undefined;
try {
  connection = await NativeConnection.connect({
    address: config.temporalAddress,
  });
  const worker = await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: AGENT_TASK_QUEUE,
    activities: {
      ...createActivities(),
      ...agentLoopActivities,
    },
    shutdownGraceTime: "10s",
    ...workflowSource(),
  });
  writeFileSync(READY_FILE, "ready");
  await worker.run();
} catch (error) {
  console.error("agent-runner failed", error);
  process.exitCode = 1;
} finally {
  rmSync(READY_FILE, { force: true });
  await connection?.close();
  await redis?.quit();
  await sql.end({ timeout: 5 }).catch(() => undefined);
  await telemetry.shutdown();
}
