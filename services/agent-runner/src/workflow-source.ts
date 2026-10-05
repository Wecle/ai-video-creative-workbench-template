import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { WorkerOptions } from "@temporalio/worker";

type WorkflowSource = Pick<WorkerOptions, "workflowsPath" | "workflowBundle">;

/**
 * Production runs the bundle prebuilt by `bundle-workflows` (faster start, sandbox violations
 * fail the build). Development and tests bundle from source so workflow edits apply at once.
 * The bundle must be built by the same @temporalio/worker version that runs it.
 */
export function workflowSource(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): WorkflowSource {
  if (nodeEnv === "production")
    return {
      workflowBundle: {
        codePath: fileURLToPath(
          new URL("./workflow-bundle.js", import.meta.url),
        ),
      },
    };
  return { workflowsPath: workflowsSourcePath() };
}

/** Entry file of the workflow package (its TypeScript source, resolved through the workspace link). */
export function workflowsSourcePath(): string {
  return createRequire(import.meta.url).resolve("@creative/workflows");
}
