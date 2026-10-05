import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultLogger, Runtime } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { TEMPORAL_DEV_CLI_VERSION } from "../src/constants";

/**
 * Local Temporal server powered by the Temporal CLI, pinned to TEMPORAL_DEV_CLI_VERSION.
 * - First run downloads the CLI from https://temporal.download (network needed once).
 * - The download dir contains the version: the SDK names the cached binary after the SDK
 *   version only, so a shared dir could silently reuse a CLI of another version.
 * - The SDK does not create the download dir, so we do.
 * - TEMPORAL_CLI_PATH uses a local CLI instead (offline); the version is then the caller's.
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
