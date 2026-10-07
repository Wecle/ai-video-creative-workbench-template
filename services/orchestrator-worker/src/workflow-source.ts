import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { WorkerOptions } from "@temporalio/worker";

type WorkflowSource = Pick<WorkerOptions, "workflowsPath" | "workflowBundle">;

export function workflowSource(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): WorkflowSource {
  if (nodeEnv === "production") {
    return {
      workflowBundle: {
        codePath: fileURLToPath(
          new URL("./workflow-bundle.js", import.meta.url),
        ),
      },
    };
  }
  return { workflowsPath: workflowsSourcePath() };
}

export function workflowsSourcePath(): string {
  return createRequire(import.meta.url).resolve(
    ["@creative", "workflows"].join("/"),
  );
}
