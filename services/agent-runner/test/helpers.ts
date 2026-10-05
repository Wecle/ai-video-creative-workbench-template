import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultLogger, Runtime } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { TEMPORAL_DEV_CLI_VERSION } from "@creative/workflows/constants";

/**
 * Local Temporal server from the Temporal CLI, pinned to TEMPORAL_DEV_CLI_VERSION.
 * Same helper as packages/workflows/test/helpers.ts; see that file for the rationale.
 * First run downloads the CLI from https://temporal.download; TEMPORAL_CLI_PATH skips it.
 */
export async function createTemporalTestEnv() {
  Runtime.install({ logger: new DefaultLogger("ERROR") });
  const path = process.env.TEMPORAL_CLI_PATH;
  const downloadDir = join(
    tmpdir(),
    `creative-temporal-cli-${TEMPORAL_DEV_CLI_VERSION}`,
  );
  if (!path) mkdirSync(downloadDir, { recursive: true });
  return TestWorkflowEnvironment.createLocal({
    server: {
      executable: path
        ? { type: "existing-path", path }
        : {
            type: "cached-download",
            version: TEMPORAL_DEV_CLI_VERSION,
            downloadDir,
          },
    },
  });
}
