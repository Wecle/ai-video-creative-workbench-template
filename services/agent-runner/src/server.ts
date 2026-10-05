import { rmSync, writeFileSync } from "node:fs";
import { NativeConnection, Worker } from "@temporalio/worker";
import { startTelemetry } from "@creative/observability";
import { AGENT_TASK_QUEUE } from "@creative/workflows/constants";
import { createActivities } from "./activities";
import { loadConfig } from "./config";
import { workflowSource } from "./workflow-source";

/** Compose healthcheck: present once connected and about to poll. It does not track later disconnects. */
const READY_FILE = "/tmp/agent-runner.ready";

const config = loadConfig();
const telemetry = startTelemetry("creative-agent-runner");
let connection: NativeConnection | undefined;
try {
  connection = await NativeConnection.connect({
    address: config.temporalAddress,
  });
  const worker = await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: AGENT_TASK_QUEUE,
    activities: { ...createActivities() },
    // Must stay below stop_grace_period in the compose file.
    shutdownGraceTime: "10s",
    ...workflowSource(),
  });
  writeFileSync(READY_FILE, "ready");
  // run() handles SIGINT/SIGTERM/SIGQUIT/SIGUSR2 itself and returns after draining.
  await worker.run();
} catch (error) {
  console.error("agent-runner failed", error);
  process.exitCode = 1;
} finally {
  rmSync(READY_FILE, { force: true });
  await connection?.close();
  await telemetry.shutdown();
}
