import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
import { workflowsSourcePath } from "./workflow-source";

const { code } = await bundleWorkflowCode({
  workflowsPath: workflowsSourcePath(),
});
await writeFile(
  fileURLToPath(new URL("./workflow-bundle.js", import.meta.url)),
  code,
);
