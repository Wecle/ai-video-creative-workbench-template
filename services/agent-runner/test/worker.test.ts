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

import { Redis } from "ioredis";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_LOOP_WORKFLOW_TYPE,
  agentLoopWorkflowId,
} from "@creative/workflows/constants";
import { agentApprovalSignal } from "@creative/workflows/signals";
import { agentEventsChannel, type AgentEvent } from "@creative/contracts";
import { createModelResolver } from "@creative/agent-core/runtime";
import { createAgentLoopActivities } from "../src/agent-loop-activities";
import { createAgentEventPublisher } from "../src/events";
import { createTestDatabase, type TestDb } from "./db-helper";

describe("agentLoopWorkflow integration with real Redis, DB and activities", () => {
  let testDb: TestDb;
  let redisClient: Redis;
  let subClient: Redis;
  let workspaceId: string;
  let projectId: string;
  let canvasId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
    redisClient = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    subClient = new Redis(redisUrl, { maxRetriesPerRequest: 1 });

    const [ws] = await testDb.client<{ id: string }[]>`
      INSERT INTO workspaces (name, slug, created_at) VALUES ('WS', 'ws', now()) RETURNING id`;
    workspaceId = ws!.id;

    const [proj] = await testDb.client<{ id: string }[]>`
      INSERT INTO projects (workspace_id, name) VALUES (${workspaceId}, 'P1') RETURNING id`;
    projectId = proj!.id;

    const [cv] = await testDb.client<{ id: string }[]>`
      INSERT INTO canvases (project_id, workspace_id, name, yjs_state, snapshot, schema_version)
      VALUES (${projectId}, ${workspaceId}, 'C1', ${Buffer.from([1])}, '{"schemaVersion":1,"nodes":[],"edges":[]}'::jsonb, 1) RETURNING id`;
    canvasId = cv!.id;
  });

  afterAll(async () => {
    await subClient?.quit();
    await redisClient?.quit();
    await testDb?.cleanup();
  });

  async function executeLoopWithChunkMode(
    chunkMode: "single" | "multi50",
  ) {
    const runId = randomUUID();
    const userId = "user-1";
    const channel = agentEventsChannel(runId);

    await testDb.client`
      INSERT INTO agent_runs (id, workspace_id, project_id, canvas_id, profile_id, prompt, canvas_version, canvas_snapshot, status, state, workflow_id)
      VALUES (${runId}, ${workspaceId}, ${projectId}, ${canvasId}, 'creative-assistant', 'Add a note to canvas', 1, '{"schemaVersion":1,"nodes":[],"edges":[]}'::jsonb, 'running', '{"steps":[],"proposals":[]}'::jsonb, 'wf-agent')`;

    const receivedEvents: AgentEvent[] = [];
    const messageHandler = (ch: string, msg: string) => {
      if (ch === channel) {
        receivedEvents.push(JSON.parse(msg));
      }
    };
    await subClient.subscribe(channel);
    subClient.on("message", messageHandler);

    const publisher = createAgentEventPublisher(redisClient);
    const skillsDir = resolve(
      fileURLToPath(new URL("../../../capabilities/skills", import.meta.url)),
    );
    const modelResolver = createModelResolver({ mockChunkMode: chunkMode });

    const activities = createAgentLoopActivities({
      db: testDb.db,
      publisher,
      skillsDir,
      modelResolver,
    });

    const taskQueue = `queue-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      activities: { ...activities },
      ...workflowSource("development"),
    });

    const handle = await env.client.workflow.start(AGENT_LOOP_WORKFLOW_TYPE, {
      taskQueue,
      workflowId: agentLoopWorkflowId(userId, runId),
      args: [{ runId, userId }],
    });

    const runPromise = worker.runUntil(handle.result());

    // Wait until proposal event is received
    let proposalCallId: string | undefined;
    while (!proposalCallId) {
      const propEvt = receivedEvents.find(
        (e) => e.type === "agent.tool.proposed",
      );
      if (propEvt && propEvt.type === "agent.tool.proposed") {
        proposalCallId = propEvt.proposal.toolCallId;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    // Approve the tool proposal
    await handle.signal(agentApprovalSignal, {
      toolCallId: proposalCallId,
      decision: "approve",
    });

    const result = await runPromise;
    expect(result).toEqual({ status: "completed", outcome: "finished" });

    const history = await handle.fetchHistory();

    subClient.off("message", messageHandler);
    await subClient.unsubscribe(channel);

    return { receivedEvents, history };
  }

  it("runs full agent loop, verifies 1 chunk vs >=50 chunks history purity and event sequence (B5.1)", async () => {
    const runSingle = await executeLoopWithChunkMode("single");
    const runMulti = await executeLoopWithChunkMode("multi50");

    // 1. fetchHistory() event counts are IDENTICAL between 1 chunk and 50 chunks
    expect(runSingle.history.events?.length).toBe(
      runMulti.history.events?.length,
    );
    expect(runSingle.history.events?.length).toBeGreaterThan(0);

    // 2. Subscriber delta counts vary with chunk count
    const deltasSingle = runSingle.receivedEvents.filter(
      (e) => e.type === "agent.text.delta",
    );
    const deltasMulti = runMulti.receivedEvents.filter(
      (e) => e.type === "agent.text.delta",
    );
    expect(deltasSingle.length).toBe(2);
    expect(deltasMulti.length).toBeGreaterThanOrEqual(50);
    expect(deltasMulti.length).toBeGreaterThan(deltasSingle.length);

    // 3. Every text.delta has stepId and attempt
    for (const d of deltasMulti) {
      if (d.type === "agent.text.delta") {
        expect(d.stepId).toBeDefined();
        expect(d.attempt).toBeGreaterThanOrEqual(1);
      }
    }

    // 4. Sequence numbers are monotonically increasing
    for (let i = 1; i < runMulti.receivedEvents.length; i++) {
      expect(runMulti.receivedEvents[i]!.seq).toBeGreaterThan(
        runMulti.receivedEvents[i - 1]!.seq,
      );
    }

    // 5. step.completed contains full accumulated text
    const stepCompletedEvt = runMulti.receivedEvents.find(
      (e) => e.type === "agent.step.completed",
    );
    expect(stepCompletedEvt).toBeDefined();
    if (stepCompletedEvt && stepCompletedEvt.type === "agent.step.completed") {
      expect(stepCompletedEvt.text.length).toBeGreaterThan(3000);
      expect(stepCompletedEvt.stepId).toBeDefined();
    }
  }, 60_000);
});
