import { randomUUID } from "node:crypto";
import { Worker } from "@temporalio/worker";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { EchoAgentAdapter, type AgentAdapter } from "@creative/agent-core";
import {
  AGENT_TASK_QUEUE,
  ECHO_WORKFLOW_TYPE,
  agentRunWorkflowId,
} from "@creative/workflows/constants";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createActivities } from "../src/activities";
import { workflowSource } from "../src/workflow-source";
import { createTemporalTestEnv } from "./helpers";

let env: TestWorkflowEnvironment;
beforeAll(async () => {
  env = await createTemporalTestEnv();
}, 120_000);
afterAll(async () => {
  await env?.teardown();
});

async function run(adapter: AgentAdapter, prompt = "Hello") {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: AGENT_TASK_QUEUE,
    activities: { ...createActivities({ adapter }) },
    ...workflowSource("development"),
  });
  const runId = randomUUID();
  return worker.runUntil(
    env.client.workflow.execute(ECHO_WORKFLOW_TYPE, {
      taskQueue: AGENT_TASK_QUEUE,
      workflowId: agentRunWorkflowId("user-1", runId),
      args: [{ runId, userId: "user-1", prompt }],
    }),
  );
}

function messages(error: unknown): string[] {
  const out: string[] = [];
  for (let e = error as Error | undefined; e; e = e.cause as Error | undefined)
    out.push(e.message);
  return out;
}

describe("agent-runner worker", () => {
  it("runs the real echo workflow and activity", async () => {
    await expect(run(new EchoAgentAdapter())).resolves.toEqual({
      message: "Template Agent received: Hello",
    });
  });

  it("fails the workflow without leaking adapter internals", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const adapter: AgentAdapter = {
      run: async () => {
        throw new Error(
          "connect ECONNREFUSED db.internal:5432 password=hunter2",
        );
      },
    };
    const error = await run(adapter).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeDefined();
    const text = messages(error).join(" | ");
    expect(text).toContain("Agent adapter failed");
    expect(text).not.toMatch(/ECONNREFUSED|db\.internal|hunter2/);
  }, 30_000);
});

describe("workflowSource", () => {
  it("bundles from source outside production", () => {
    const source = workflowSource("development");
    expect(source.workflowsPath).toMatch(
      /packages\/workflows\/src\/index\.ts$/,
    );
    expect(source.workflowBundle).toBeUndefined();
  });

  it("uses the prebuilt bundle in production", () => {
    const source = workflowSource("production");
    expect(source.workflowBundle).toEqual({
      codePath: expect.stringMatching(/workflow-bundle\.js$/),
    });
    expect(source.workflowsPath).toBeUndefined();
  });
});
