import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";
import { describe, expect, it } from "vitest";

const path = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url));

// Pins the SDK's own build-time guard: the third layer behind lint and tsconfig (see README).
describe("workflow bundling", () => {
  it("bundles the real workflows", async () => {
    const { code } = await bundleWorkflowCode({
      workflowsPath: path("../src/index.ts"),
    });
    expect(code).toContain("echoWorkflow");
  }, 60_000);

  it("rejects a workflow that imports a Node built-in", async () => {
    await expect(
      bundleWorkflowCode({
        workflowsPath: path("./fixtures/bad-workflow.ts"),
      }),
    ).rejects.toThrow(/Webpack finished with errors/);
  }, 60_000);
});
