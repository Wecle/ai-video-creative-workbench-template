import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  bundleWorkflowCode,
  Worker,
  type WorkflowBundle,
} from "@temporalio/worker";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { ApplicationFailure } from "@temporalio/workflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentActivities, EchoInput } from "../src/activities";
import {
  AGENT_TASK_QUEUE,
  ECHO_WORKFLOW_TYPE,
  agentRunWorkflowId,
} from "../src/constants";
import { createTemporalTestEnv } from "./helpers";

const workflowsPath = fileURLToPath(
  new URL("../src/index.ts", import.meta.url),
);

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundle;

beforeAll(async () => {
  env = await createTemporalTestEnv();
  workflowBundle = await bundleWorkflowCode({
    workflowsPath,
  });
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

function input(prompt = "Hello"): EchoInput {
  return { runId: randomUUID(), userId: "user-1", prompt };
}

async function run(activities: AgentActivities, value: EchoInput) {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: AGENT_TASK_QUEUE,
    workflowBundle,
    activities: { ...activities },
  });
  return worker.runUntil(
    env.client.workflow.execute(ECHO_WORKFLOW_TYPE, {
      taskQueue: AGENT_TASK_QUEUE,
      workflowId: agentRunWorkflowId(value.userId, value.runId),
      args: [value],
    }),
  );
}

describe("echoWorkflow", () => {
  it("returns the activity result and passes userId, runId and prompt through", async () => {
    const seen: EchoInput[] = [];
    const value = input("Hi there");
    const result = await run(
      {
        runEcho: async (i) => {
          seen.push(i);
          return { message: `echo: ${i.prompt}` };
        },
      },
      value,
    );
    expect(result).toEqual({ message: "echo: Hi there" });
    expect(seen).toEqual([value]);
  }, 30_000);

  it("retries a failing activity and succeeds on the second attempt", async () => {
    let calls = 0;
    const result = await run(
      {
        runEcho: async () => {
          calls += 1;
          if (calls === 1) throw new Error("transient");
          return { message: "ok" };
        },
      },
      input(),
    );
    expect(result).toEqual({ message: "ok" });
    expect(calls).toBe(2);
  }, 30_000);

  it("fails the workflow on a non-retryable activity failure without retrying", async () => {
    let calls = 0;
    await expect(
      run(
        {
          runEcho: async () => {
            calls += 1;
            throw ApplicationFailure.nonRetryable("boom", "Fatal");
          },
        },
        input(),
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  }, 30_000);
});

describe("agentRunWorkflowId", () => {
  it("encodes the owner and rejects a separator in either part", () => {
    expect(agentRunWorkflowId("u1", "r1")).toBe("agent-run:u1:r1");
    expect(() => agentRunWorkflowId("u:1", "r1")).toThrow();
    expect(() => agentRunWorkflowId("u1", "r:1")).toThrow();
    expect(() => agentRunWorkflowId("", "r1")).toThrow();
  });
});
