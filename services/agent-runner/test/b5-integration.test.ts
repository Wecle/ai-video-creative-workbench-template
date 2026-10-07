import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Redis } from "ioredis";
import { Worker } from "@temporalio/worker";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { ApplicationFailure } from "@temporalio/activity";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { schema } from "@creative/database";
import { eq } from "drizzle-orm";
import {
  agentEventsChannel,
  type AgentStreamEvent,
} from "@creative/contracts";
import {
  decideToolCall,
  type RouteDecision,
} from "@creative/agent-core/pure";
import {
  createModelResolver,
  createScriptedMockModel,
} from "@creative/agent-core/runtime";
import {
  AGENT_LOOP_WORKFLOW_TYPE,
  agentLoopWorkflowId,
} from "@creative/workflows/constants";
import { agentApprovalSignal } from "@creative/workflows/signals";
import { createAgentLoopActivities } from "../src/agent-loop-activities";
import { createAgentEventPublisher } from "../src/events";
import { workflowSource } from "../src/workflow-source";
import { createTemporalTestEnv } from "./helpers";
import { createTestDatabase, type TestDb } from "./db-helper";

const skillsDir = resolve(
  fileURLToPath(new URL("../../../capabilities/skills", import.meta.url)),
);

describe("B5 integration & audit requirements (H2, H5, M-d, M-f)", () => {
  let env: TestWorkflowEnvironment;
  let testDb: TestDb;
  let redisClient: Redis;
  let subClient: Redis;
  let workspaceId: string;
  let projectId: string;
  let canvasId: string;

  beforeAll(async () => {
    env = await createTemporalTestEnv();
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
  }, 120_000);

  afterAll(async () => {
    await subClient?.quit();
    await redisClient?.quit();
    await testDb?.cleanup();
    await env?.teardown();
  });

  async function createRun(profileId: string, prompt: string, routeHints = {}) {
    const runId = randomUUID();
    await testDb.client`
      INSERT INTO agent_runs (id, workspace_id, project_id, canvas_id, profile_id, prompt, route_hints, canvas_version, canvas_snapshot, status, state, workflow_id)
      VALUES (${runId}, ${workspaceId}, ${projectId}, ${canvasId}, ${profileId}, ${prompt}, ${JSON.stringify(routeHints)}::jsonb, 1, '{"schemaVersion":1,"nodes":[],"edges":[]}'::jsonb, 'running', '{"steps":[],"proposals":[]}'::jsonb, ${`wf-${runId}`})`;
    return runId;
  }

  // --- H5: B5.2 / B5.3 Integration ---
  describe("H5: Real buildContext + Mock Model profile and routing tests", () => {
    it("H5(a): two different profiles produce different system prompts and tools, loop code identical; profile without canvas.applyPatch ends without approval", async () => {
      const capturedCalls: Array<{ profileId: string; prompt: unknown; tools: unknown }> = [];

      // 1. Run 1: creative-assistant (has canvas.applyPatch)
      const runId1 = await createRun(
        "creative-assistant",
        "Add a note please",
      );
      const model1 = createScriptedMockModel({
        onCall: (info) =>
          capturedCalls.push({ profileId: "creative-assistant", ...info }),
      });
      const resolver1 = {
        resolve: () => model1,
      };
      const publisher = createAgentEventPublisher(redisClient);

      const activities1 = createAgentLoopActivities({
        db: testDb.db,
        publisher,
        skillsDir,
        modelResolver: resolver1,
      });

      const taskQueue1 = `queue-${randomUUID()}`;
      const worker1 = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: taskQueue1,
        activities: { ...activities1 },
        ...workflowSource("development"),
      });

      const handle1 = await env.client.workflow.start(AGENT_LOOP_WORKFLOW_TYPE, {
        taskQueue: taskQueue1,
        workflowId: agentLoopWorkflowId("user-1", runId1),
        args: [{ runId: runId1, userId: "user-1" }],
      });

      const promise1 = worker1.runUntil(handle1.result());

      // Approve step 0
      while (true) {
        const [row] = await testDb.db
          .select()
          .from(schema.agent_runs)
          .where(eq(schema.agent_runs.id, runId1));
        if (row?.status === "waiting_approval") {
          const proposals = (row.state as { proposals: Array<{ toolCallId: string }> }).proposals;
          if (proposals.length > 0) {
            await handle1.signal(agentApprovalSignal, {
              toolCallId: proposals[0]!.toolCallId,
              decision: "approve",
            });
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      const res1 = await promise1;
      expect(res1.status).toBe("completed");

      // 2. Run 2: readonly-assistant (no canvas.applyPatch)
      const runId2 = await createRun(
        "readonly-assistant",
        "Review the canvas",
      );
      const model2 = createScriptedMockModel({
        onCall: (info) =>
          capturedCalls.push({ profileId: "readonly-assistant", ...info }),
      });
      const resolver2 = {
        resolve: () => model2,
      };

      const activities2 = createAgentLoopActivities({
        db: testDb.db,
        publisher,
        skillsDir,
        modelResolver: resolver2,
      });

      const taskQueue2 = `queue-${randomUUID()}`;
      const worker2 = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: taskQueue2,
        activities: { ...activities2 },
        ...workflowSource("development"),
      });

      const handle2 = await env.client.workflow.start(AGENT_LOOP_WORKFLOW_TYPE, {
        taskQueue: taskQueue2,
        workflowId: agentLoopWorkflowId("user-1", runId2),
        args: [{ runId: runId2, userId: "user-1" }],
      });

      // Run 2 must finish directly WITHOUT ANY SIGNAL/APPROVAL
      const res2 = await worker2.runUntil(handle2.result());
      expect(res2.status).toBe("completed");
      expect(res2.outcome).toBe("finished");

      // Verify Run 2 never entered waiting_approval in database
      const [finalRow2] = await testDb.db
        .select()
        .from(schema.agent_runs)
        .where(eq(schema.agent_runs.id, runId2));
      expect(finalRow2?.status).toBe("completed");
      const proposals2 = (finalRow2?.state as { proposals: unknown[] })?.proposals;
      expect(proposals2).toHaveLength(0);

      // Verify captured calls: systems and tools are different
      const call1 = capturedCalls.find(
        (c) => c.profileId === "creative-assistant",
      );
      const call2 = capturedCalls.find(
        (c) => c.profileId === "readonly-assistant",
      );
      expect(call1).toBeDefined();
      expect(call2).toBeDefined();

      const promptStr1 = JSON.stringify(call1?.prompt);
      const promptStr2 = JSON.stringify(call2?.prompt);
      expect(promptStr1).toContain("encouraging, structured creative director");
      expect(promptStr2).toContain("concise canvas reviewer");
      expect(promptStr1).not.toBe(promptStr2);

      const toolsStr1 = JSON.stringify(call1?.tools);
      const toolsStr2 = JSON.stringify(call2?.tools);
      expect(toolsStr1).toContain("canvas_applyPatch");
      expect(toolsStr2).not.toContain("canvas_applyPatch");
    }, 60_000);

    it("H5(b): router advises candidateSkills and high confidence, but model calls canvas_applyPatch -> still enters approval using requested profile", async () => {
      // Prompt triggers /shot-list router advice with high confidence
      const runId = await createRun(
        "creative-assistant",
        "Please use shot-list /shot-list",
        { selectedSkills: ["shot-list"] },
      );

      // Model scripted to directly call canvas_applyPatch instead of skill.load
      const model = createScriptedMockModel({
        onCall: undefined,
      });

      const publisher = createAgentEventPublisher(redisClient);
      const activities = createAgentLoopActivities({
        db: testDb.db,
        publisher,
        skillsDir,
        modelResolver: { resolve: () => model },
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
        workflowId: agentLoopWorkflowId("user-1", runId),
        args: [{ runId, userId: "user-1" }],
      });

      let reachedWaitingApproval = false;
      const runPromise = worker.runUntil(handle.result());

      while (!reachedWaitingApproval) {
        const [row] = await testDb.db
          .select()
          .from(schema.agent_runs)
          .where(eq(schema.agent_runs.id, runId));
        if (row?.status === "waiting_approval") {
          reachedWaitingApproval = true;
          const proposals = (row.state as { proposals: Array<{ toolCallId: string }> }).proposals;
          expect(proposals).toHaveLength(1);
          // Approve it so workflow finishes
          await handle.signal(agentApprovalSignal, {
            toolCallId: proposals[0]!.toolCallId,
            decision: "approve",
          });
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(reachedWaitingApproval).toBe(true);
      const result = await runPromise;
      expect(result.status).toBe("completed");
    }, 60_000);

    it("H5(c): type assertion that decideToolCall arguments do not contain route types", () => {
      type DecideToolCallInput = Parameters<typeof decideToolCall>[0];
      expectTypeOf<DecideToolCallInput>().not.toMatchTypeOf<RouteDecision>();
      expectTypeOf<RouteDecision>().not.toMatchTypeOf<DecideToolCallInput>();
    });
  });

  // --- H2: AGENT_MODEL Configuration & Priority ---
  describe("H2: AGENT_MODEL worker environment override and unknown provider", () => {
    it("uses AGENT_MODEL override when provided", async () => {
      const runId = await createRun("creative-assistant", "test model");
      let resolvedModelId: string | undefined;

      const resolver = {
        resolve(options: { provider: string; modelId: string }) {
          resolvedModelId = `${options.provider}:${options.modelId}`;
          return createScriptedMockModel();
        },
      };

      const activities = createAgentLoopActivities({
        db: testDb.db,
        publisher: createAgentEventPublisher(redisClient),
        skillsDir,
        modelResolver: resolver,
        agentModel: "mock:custom-scripted-model",
      });

      await activities.llmStep({
        runId,
        stepId: "s0",
        index: 0,
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      });

      expect(resolvedModelId).toBe("mock:custom-scripted-model");
    });

    it("throws nonRetryable ModelRequestError for unknown provider", async () => {
      const runId = await createRun("creative-assistant", "test unknown provider");

      const activities = createAgentLoopActivities({
        db: testDb.db,
        publisher: createAgentEventPublisher(redisClient),
        skillsDir,
        modelResolver: createModelResolver(),
        agentModel: "unknown-provider:some-model",
      });

      await expect(
        activities.llmStep({
          runId,
          stepId: "s0",
          index: 0,
          system: "sys",
          messages: [{ role: "user", content: "hi" }],
          tools: [],
        }),
      ).rejects.toMatchObject({
        nonRetryable: true,
        type: "ModelRequestError",
      });
    });
  });

  // --- M-d: Sanitization of sensitive error details ---
  describe("M-d: Sensitive detail sanitization", () => {
    it("provider error with sensitive details is sanitized and does not leak into ApplicationFailure", async () => {
      const runId = await createRun("creative-assistant", "test sensitive error");

      const sensitiveResolver = {
        resolve() {
          throw new Error("SECRET_API_KEY_abc123 failed to connect to secret-host.internal");
        },
      };

      const activities = createAgentLoopActivities({
        db: testDb.db,
        publisher: createAgentEventPublisher(redisClient),
        skillsDir,
        modelResolver: sensitiveResolver,
      });

      let thrownError: unknown;
      try {
        await activities.llmStep({
          runId,
          stepId: "s0",
          index: 0,
          system: "sys",
          messages: [{ role: "user", content: "hi" }],
          tools: [],
        });
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeDefined();
      const appFailure = thrownError as ApplicationFailure;
      expect(appFailure.nonRetryable).toBe(true);
      expect(appFailure.type).toBe("ModelRequestError");
      // Sanitized message does not contain sensitive token or host
      expect(appFailure.message).toBe("Failed to resolve model provider");
      expect(appFailure.message).not.toContain("SECRET_API_KEY");
      expect(appFailure.message).not.toContain("secret-host.internal");
    });
  });

  // --- M-f: Empty text and Non-retryable failure SSE done with real Redis ---
  describe("M-f: Empty text and non-retryable failure terminal event", () => {
    it("handles empty text without error and finishes", async () => {
      const runId = await createRun("creative-assistant", "empty text test");

      // Custom model that streams empty text and stops
      const emptyModel = {
        specificationVersion: "v4" as const,
        provider: "mock",
        modelId: "mock",
        supportedUrls: {},
        async doStream() {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({
                type: "finish",
                usage: {
                  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 0, text: 0, reasoning: 0 },
                },
                finishReason: { unified: "stop", raw: "stop" },
              });
              controller.close();
            },
          });
          return { stream };
        },
      };

      const activities = createAgentLoopActivities({
        db: testDb.db,
        publisher: createAgentEventPublisher(redisClient),
        skillsDir,
        modelResolver: { resolve: () => emptyModel },
      });

      const res = await activities.llmStep({
        runId,
        stepId: "s0",
        index: 0,
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      });

      expect(res.text).toBe("");
      expect(res.finishReason).toBe("stop");
      expect(res.toolCalls).toHaveLength(0);
    });

    it("non-retryable activity failure leads to agent_runs failed and SSE receiving done over real Redis", async () => {
      const runId = await createRun("creative-assistant", "test unretryable sse");
      const channel = agentEventsChannel(runId);
      const receivedEvents: AgentStreamEvent[] = [];

      const handler = (ch: string, msg: string) => {
        if (ch === channel) {
          receivedEvents.push(JSON.parse(msg));
        }
      };
      await subClient.subscribe(channel);
      subClient.on("message", handler);

      const brokenResolver = {
        resolve() {
          throw ApplicationFailure.nonRetryable("Fatal model config error", "ModelRequestError");
        },
      };

      const activities = createAgentLoopActivities({
        db: testDb.db,
        publisher: createAgentEventPublisher(redisClient),
        skillsDir,
        modelResolver: brokenResolver,
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
        workflowId: agentLoopWorkflowId("user-1", runId),
        args: [{ runId, userId: "user-1" }],
      });

      const workflowResult = (await worker.runUntil(handle.result())) as { status: string };
      expect(workflowResult.status).toBe("failed");

      // Check agent_runs in database is failed
      const [row] = await testDb.db
        .select()
        .from(schema.agent_runs)
        .where(eq(schema.agent_runs.id, runId));
      expect(row?.status).toBe("failed");
      expect(row?.error).toBe("MODEL_ERROR");

      // Check that agent.run.status event with status: failed was published to Redis
      const failedEvt = receivedEvents.find(
        (e) => e.type === "agent.run.status" && (e as { status?: string }).status === "failed",
      );
      expect(failedEvt).toBeDefined();

      subClient.off("message", handler);
      await subClient.unsubscribe(channel);
    }, 60_000);
  });
});
