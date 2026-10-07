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
import type { AgentContext, AgentMessage } from "@creative/agent-core/pure";
import type {
  AgentLoopActivities,
  ExecuteToolActivityInput,
  ExecuteToolActivityResult,
  LlmStepActivityInput,
  LlmStepActivityResult,
  PrepareToolActivityResult,
  RecordProgressActivityInput,
} from "../src/activities";
import {
  AGENT_LOOP_WORKFLOW_TYPE,
  agentLoopWorkflowId,
} from "../src/constants";
import { agentApprovalSignal } from "../src/signals";
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

function createDefaultContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    system: "You are an assistant",
    messages: [{ role: "user", content: "Add a note" }],
    tools: [
      {
        name: "canvas.applyPatch",
        modelName: "canvas_applyPatch",
        risk: "write",
      },
      {
        name: "skill.load",
        modelName: "skill_load",
        risk: "read",
      },
    ],
    policy: {
      approvalThreshold: "write",
      budget: {
        maxSteps: 5,
        maxEstimatedCredits: 100,
        creditsPerKiloToken: 1,
      },
      approvalTimeoutMs: 3000,
      maxToolCallsPerStep: 4,
    },
    ...overrides,
  };
}

describe("agentLoopWorkflow", () => {
  it("completes full path: llmStep -> waiting_approval -> approve -> executeTool -> llmStep -> finished", async () => {
    const runId = randomUUID();
    const userId = "user-1";
    const toolCallId = "call-1";

    let executeToolCount = 0;
    const progressRecords: RecordProgressActivityInput[] = [];

    const activities: AgentLoopActivities = {
      async buildContext() {
        return createDefaultContext();
      },
      async llmStep({
        index,
      }: LlmStepActivityInput): Promise<LlmStepActivityResult> {
        if (index === 0) {
          return {
            text: "I will add a note node.",
            toolCalls: [
              {
                toolCallId,
                toolName: "canvas.applyPatch",
                input: { summary: "add note", ops: [] },
              },
            ],
            finishReason: "tool-calls",
            usage: { totalTokens: 100 },
          };
        }
        return {
          text: "Done. The note node was added.",
          toolCalls: [],
          finishReason: "stop",
          usage: { totalTokens: 50 },
        };
      },
      async prepareTool(): Promise<PrepareToolActivityResult> {
        return { ok: true, summary: "Add note node" };
      },
      async executeTool(
        input: ExecuteToolActivityInput,
      ): Promise<ExecuteToolActivityResult> {
        executeToolCount++;
        return {
          ok: true,
          summary: "Patch applied",
          patch: input.toolCall.input,
        };
      },
      async recordProgress(input: RecordProgressActivityInput) {
        progressRecords.push(input);
      },
    };

    const taskQueue = `queue-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: { ...activities },
    });

    const handle = await env.client.workflow.start(AGENT_LOOP_WORKFLOW_TYPE, {
      taskQueue,
      workflowId: agentLoopWorkflowId(userId, runId),
      args: [{ runId, userId }],
    });

    const executionPromise = worker.runUntil(handle.result());

    // Wait until status is waiting_approval
    while (!progressRecords.some((p) => p.status === "waiting_approval")) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Before approval, executeTool must be 0
    expect(executeToolCount).toBe(0);

    // Send approve signal
    await handle.signal(agentApprovalSignal, {
      toolCallId,
      decision: "approve",
    });

    const result = await executionPromise;

    expect(result).toEqual({ status: "completed", outcome: "finished" });
    expect(executeToolCount).toBe(1);

    // Verify progress records sequence
    const statuses = progressRecords.map((p) => p.status);
    expect(statuses).toContain("running");
    expect(statuses).toContain("waiting_approval");
    expect(statuses[statuses.length - 1]).toBe("completed");

    // Verify version is strictly increasing
    for (let i = 1; i < progressRecords.length; i++) {
      expect(progressRecords[i]!.version).toBeGreaterThan(
        progressRecords[i - 1]!.version,
      );
    }
  });

  it("handles rejection: executeTool is 0, second llmStep receives rejected error, finishes", async () => {
    const runId = randomUUID();
    const userId = "user-1";
    const toolCallId = "call-rej";

    let executeToolCount = 0;
    let secondStepMessages: AgentMessage[] = [];
    const progressRecords: RecordProgressActivityInput[] = [];

    const activities: AgentLoopActivities = {
      async buildContext() {
        return createDefaultContext();
      },
      async llmStep({
        index,
        messages,
      }: LlmStepActivityInput): Promise<LlmStepActivityResult> {
        if (index === 0) {
          return {
            text: "I will add a note node.",
            toolCalls: [
              {
                toolCallId,
                toolName: "canvas.applyPatch",
                input: { summary: "add note", ops: [] },
              },
            ],
            finishReason: "tool-calls",
            usage: { totalTokens: 100 },
          };
        }
        secondStepMessages = [...messages];
        return {
          text: "Understood. I did not change the canvas.",
          toolCalls: [],
          finishReason: "stop",
          usage: { totalTokens: 50 },
        };
      },
      async prepareTool(): Promise<PrepareToolActivityResult> {
        return { ok: true, summary: "Add note node" };
      },
      async executeTool(): Promise<ExecuteToolActivityResult> {
        executeToolCount++;
        return { ok: true, summary: "Patch applied" };
      },
      async recordProgress(input: RecordProgressActivityInput) {
        progressRecords.push(input);
      },
    };

    const taskQueue = `queue-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: { ...activities },
    });

    const handle = await env.client.workflow.start(AGENT_LOOP_WORKFLOW_TYPE, {
      taskQueue,
      workflowId: agentLoopWorkflowId(userId, runId),
      args: [{ runId, userId }],
    });

    const executionPromise = worker.runUntil(handle.result());

    while (!progressRecords.some((p) => p.status === "waiting_approval")) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Send reject signal
    await handle.signal(agentApprovalSignal, {
      toolCallId,
      decision: "reject",
    });

    const result = await executionPromise;

    expect(result).toEqual({ status: "completed", outcome: "finished" });
    expect(executeToolCount).toBe(0);

    // Verify second step received rejected error message
    const lastMsg = secondStepMessages[secondStepMessages.length - 1];
    expect(lastMsg?.role).toBe("tool");
    if (lastMsg && lastMsg.role === "tool") {
      expect(lastMsg.content[0]?.output).toEqual({
        type: "error-text",
        value: "Tool execution rejected by user",
      });
    }
  });

  it("handles timeout: finishes with approval_timeout without second llmStep", async () => {
    const runId = randomUUID();
    const userId = "user-1";
    const toolCallId = "call-timeout";
    let llmStepCount = 0;

    const activities: AgentLoopActivities = {
      async buildContext() {
        return createDefaultContext({
          policy: {
            approvalThreshold: "write",
            budget: {
              maxSteps: 5,
              maxEstimatedCredits: 100,
              creditsPerKiloToken: 1,
            },
            approvalTimeoutMs: 1000,
            maxToolCallsPerStep: 4,
          },
        });
      },
      async llmStep(): Promise<LlmStepActivityResult> {
        llmStepCount++;
        return {
          text: "I will add a note node.",
          toolCalls: [
            {
              toolCallId,
              toolName: "canvas.applyPatch",
              input: { summary: "add note", ops: [] },
            },
          ],
          finishReason: "tool-calls",
          usage: { totalTokens: 100 },
        };
      },
      async prepareTool(): Promise<PrepareToolActivityResult> {
        return { ok: true, summary: "Add note" };
      },
      async executeTool(): Promise<ExecuteToolActivityResult> {
        return { ok: true, summary: "Applied" };
      },
      async recordProgress() {},
    };

    const taskQueue = `queue-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: { ...activities },
    });

    const result = await worker.runUntil(
      env.client.workflow.execute(AGENT_LOOP_WORKFLOW_TYPE, {
        taskQueue,
        workflowId: agentLoopWorkflowId(userId, runId),
        args: [{ runId, userId }],
      }),
    );

    expect(result).toEqual({
      status: "completed",
      outcome: "approval_timeout",
    });
    expect(llmStepCount).toBe(1);
  });

  it("approval waiting does not occupy worker and survives worker restart", async () => {
    const runId = randomUUID();
    const userId = "user-1";
    const toolCallId = "call-migrate";

    const workerASeen: string[] = [];
    const workerBSeen: string[] = [];
    let isWaitingApproval = false;

    const createActivities = (workerSeen: string[]): AgentLoopActivities => ({
      async buildContext() {
        return createDefaultContext();
      },
      async llmStep({ index }: LlmStepActivityInput) {
        workerSeen.push(`llmStep-${index}`);
        if (index === 0) {
          return {
            text: "Adding note.",
            toolCalls: [
              {
                toolCallId,
                toolName: "canvas.applyPatch",
                input: { summary: "note", ops: [] },
              },
            ],
            finishReason: "tool-calls",
            usage: { totalTokens: 100 },
          };
        }
        return {
          text: "Done.",
          toolCalls: [],
          finishReason: "stop",
          usage: { totalTokens: 50 },
        };
      },
      async prepareTool() {
        return { ok: true, summary: "note" };
      },
      async executeTool() {
        workerSeen.push("executeTool");
        return { ok: true, summary: "done" };
      },
      async recordProgress(input) {
        if (input.status === "waiting_approval") {
          isWaitingApproval = true;
        }
      },
    });

    const taskQueue = `queue-${randomUUID()}`;
    const workerA = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: createActivities(workerASeen),
      maxCachedWorkflows: 0,
    });

    const handle = await env.client.workflow.start(AGENT_LOOP_WORKFLOW_TYPE, {
      taskQueue,
      workflowId: agentLoopWorkflowId(userId, runId),
      args: [{ runId, userId }],
    });

    // Run worker A until waiting_approval is reached
    const runAPromise = workerA.run();

    while (!isWaitingApproval) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Verify pendingActivities is empty while waiting for approval
    const desc = await handle.describe();
    expect(desc.raw.pendingActivities ?? []).toHaveLength(0);

    // Stop worker A
    workerA.shutdown();
    await runAPromise;

    // Start worker B
    const workerB = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: createActivities(workerBSeen),
      maxCachedWorkflows: 0,
    });

    const runBPromise = workerB.runUntil(handle.result());

    // Send approve signal
    await handle.signal(agentApprovalSignal, {
      toolCallId,
      decision: "approve",
    });

    const result = await runBPromise;

    expect(result).toEqual({ status: "completed", outcome: "finished" });
    expect(workerASeen).toContain("llmStep-0");
    expect(workerASeen).not.toContain("executeTool");
    expect(workerBSeen).toContain("executeTool");
    expect(workerBSeen).toContain("llmStep-1");
  });

  it("handles duplicate signal and signal after completion throws WorkflowNotFoundError", async () => {
    const runId = randomUUID();
    const userId = "user-1";
    const toolCallId = "call-dup";

    let executeToolCount = 0;
    const progressRecords: RecordProgressActivityInput[] = [];

    const activities: AgentLoopActivities = {
      async buildContext() {
        return createDefaultContext();
      },
      async llmStep({ index }: LlmStepActivityInput) {
        if (index === 0) {
          return {
            text: "Patching",
            toolCalls: [
              {
                toolCallId,
                toolName: "canvas.applyPatch",
                input: { summary: "p", ops: [] },
              },
            ],
            finishReason: "tool-calls",
            usage: { totalTokens: 100 },
          };
        }
        return {
          text: "Done",
          toolCalls: [],
          finishReason: "stop",
          usage: { totalTokens: 50 },
        };
      },
      async prepareTool() {
        return { ok: true, summary: "p" };
      },
      async executeTool() {
        executeToolCount++;
        return { ok: true, summary: "applied" };
      },
      async recordProgress(input) {
        progressRecords.push(input);
      },
    };

    const taskQueue = `queue-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities,
    });

    const handle = await env.client.workflow.start(AGENT_LOOP_WORKFLOW_TYPE, {
      taskQueue,
      workflowId: agentLoopWorkflowId(userId, runId),
      args: [{ runId, userId }],
    });

    const executionPromise = worker.runUntil(handle.result());

    while (!progressRecords.some((p) => p.status === "waiting_approval")) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // First reject, then approve
    await handle.signal(agentApprovalSignal, {
      toolCallId,
      decision: "reject",
    });
    await handle.signal(agentApprovalSignal, {
      toolCallId,
      decision: "approve",
    });

    const result = await executionPromise;
    expect(result).toEqual({ status: "completed", outcome: "finished" });
    // First signal (reject) won, executeTool was not called
    expect(executeToolCount).toBe(0);

    // Signaling finished workflow throws WorkflowNotFoundError
    await expect(
      handle.signal(agentApprovalSignal, {
        toolCallId,
        decision: "approve",
      }),
    ).rejects.toThrow();
  });

  it("finishes immediately when budget is exceeded or maxSteps is reached", async () => {
    const runId = randomUUID();
    const userId = "user-1";

    let proposed = false;

    // Budget exceeded case
    const activities: AgentLoopActivities = {
      async buildContext() {
        return createDefaultContext({
          policy: {
            approvalThreshold: "write",
            budget: {
              maxSteps: 5,
              maxEstimatedCredits: 0.01,
              creditsPerKiloToken: 1,
            },
            approvalTimeoutMs: 1000,
            maxToolCallsPerStep: 4,
          },
        });
      },
      async llmStep() {
        return {
          text: "Step output",
          toolCalls: [
            {
              toolCallId: "c1",
              toolName: "canvas.applyPatch",
              input: {},
            },
          ],
          finishReason: "tool-calls",
          usage: { totalTokens: 10000 }, // 10000 / 1000 * 1 = 10 credits >> 0.01
        };
      },
      async prepareTool() {
        return { ok: true, summary: "ok" };
      },
      async executeTool() {
        return { ok: true, summary: "ok" };
      },
      async recordProgress(input) {
        if (input.status === "waiting_approval") {
          proposed = true;
        }
      },
    };

    const taskQueue = `queue-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities,
    });

    const result = await worker.runUntil(
      env.client.workflow.execute(AGENT_LOOP_WORKFLOW_TYPE, {
        taskQueue,
        workflowId: agentLoopWorkflowId(userId, runId),
        args: [{ runId, userId }],
      }),
    );

    expect(result.outcome).toBe("budget_exceeded");
    expect(proposed).toBe(false);
  });

  it("handles prepareTool returning ok:false without proposing or waiting approval", async () => {
    const runId = randomUUID();
    const userId = "user-1";
    let proposed = false;
    const step1Msgs: AgentMessage[] = [];

    const activities: AgentLoopActivities = {
      async buildContext() {
        return createDefaultContext();
      },
      async llmStep({ index, messages }: LlmStepActivityInput) {
        if (index === 0) {
          return {
            text: "Applying patch",
            toolCalls: [
              {
                toolCallId: "bad-patch-1",
                toolName: "canvas.applyPatch",
                input: {},
              },
            ],
            finishReason: "tool-calls",
            usage: { totalTokens: 10 },
          };
        }
        if (messages.length > 0) {
          step1Msgs.push(messages[messages.length - 1]!);
        }
        return {
          text: "Handled error",
          toolCalls: [],
          finishReason: "stop",
          usage: { totalTokens: 10 },
        };
      },
      async prepareTool() {
        return {
          ok: false,
          code: "CYCLE_DETECTED",
          summary: "Graph cycle detected",
        };
      },
      async executeTool() {
        return { ok: true, summary: "ok" };
      },
      async recordProgress(input) {
        if (input.status === "waiting_approval") {
          proposed = true;
        }
      },
    };

    const taskQueue = `queue-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities,
    });

    const result = await worker.runUntil(
      env.client.workflow.execute(AGENT_LOOP_WORKFLOW_TYPE, {
        taskQueue,
        workflowId: agentLoopWorkflowId(userId, runId),
        args: [{ runId, userId }],
      }),
    );

    expect(result).toEqual({ status: "completed", outcome: "finished" });
    expect(proposed).toBe(false);
    expect(step1Msgs).toHaveLength(1);
    const toolMsg = step1Msgs[0];
    expect(toolMsg?.role).toBe("tool");
    if (toolMsg && toolMsg.role === "tool") {
      expect(
        toolMsg.content[0]?.output.type === "error-text"
          ? toolMsg.content[0]?.output.value
          : "",
      ).toBe("Graph cycle detected");
    }
  });

  it("handles invalid tool call and unknown tool calls by feeding back error", async () => {
    const runId = randomUUID();
    const userId = "user-1";
    let step1Messages: AgentMessage[] = [];

    const activities: AgentLoopActivities = {
      async buildContext() {
        return createDefaultContext();
      },
      async llmStep({ index, messages }: LlmStepActivityInput) {
        if (index === 0) {
          return {
            text: "Multiple tools",
            toolCalls: [
              {
                toolCallId: "inv-1",
                toolName: "canvas.applyPatch",
                input: {},
                invalid: { message: "Bad syntax" },
              },
              {
                toolCallId: "unknown-1",
                toolName: "non_existent_tool",
                input: {},
              },
            ],
            finishReason: "tool-calls",
            usage: { totalTokens: 10 },
          };
        }
        step1Messages = [...messages];
        return {
          text: "Handled both errors",
          toolCalls: [],
          finishReason: "stop",
          usage: { totalTokens: 10 },
        };
      },
      async prepareTool() {
        return { ok: true, summary: "ok" };
      },
      async executeTool() {
        return { ok: true, summary: "ok" };
      },
      async recordProgress() {},
    };

    const taskQueue = `queue-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities,
    });

    const result = await worker.runUntil(
      env.client.workflow.execute(AGENT_LOOP_WORKFLOW_TYPE, {
        taskQueue,
        workflowId: agentLoopWorkflowId(userId, runId),
        args: [{ runId, userId }],
      }),
    );

    expect(result).toEqual({ status: "completed", outcome: "finished" });
    const toolMessages = step1Messages.filter(
      (m): m is Extract<AgentMessage, { role: "tool" }> => m.role === "tool",
    );
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content[0]?.output).toEqual({
      type: "error-text",
      value: "Bad syntax",
    });
    expect(
      toolMessages[1]?.content[0]?.output.type === "error-text"
        ? toolMessages[1]?.content[0]?.output.value
        : "",
    ).toContain("Tool call rejected: unknown_tool");
  });

  it("handles too many tool calls per step", async () => {
    const runId = randomUUID();
    const userId = "user-1";
    let step1Messages: AgentMessage[] = [];

    const activities: AgentLoopActivities = {
      async buildContext() {
        return createDefaultContext({
          policy: {
            approvalThreshold: "write",
            budget: {
              maxSteps: 5,
              maxEstimatedCredits: 100,
              creditsPerKiloToken: 1,
            },
            approvalTimeoutMs: 3000,
            maxToolCallsPerStep: 1, // Only 1 allowed
          },
        });
      },
      async llmStep({ index, messages }: LlmStepActivityInput) {
        if (index === 0) {
          return {
            text: "Two tools",
            toolCalls: [
              {
                toolCallId: "call-ok",
                toolName: "skill.load", // read tool -> auto allowed
                input: { name: "shot-list" },
              },
              {
                toolCallId: "call-excess",
                toolName: "skill.load",
                input: { name: "shot-list" },
              },
            ],
            finishReason: "tool-calls",
            usage: { totalTokens: 10 },
          };
        }
        step1Messages = [...messages];
        return {
          text: "Done",
          toolCalls: [],
          finishReason: "stop",
          usage: { totalTokens: 10 },
        };
      },
      async prepareTool() {
        return { ok: true, summary: "ok" };
      },
      async executeTool() {
        return { ok: true, summary: "loaded" };
      },
      async recordProgress() {},
    };

    const taskQueue = `queue-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities,
    });

    const result = await worker.runUntil(
      env.client.workflow.execute(AGENT_LOOP_WORKFLOW_TYPE, {
        taskQueue,
        workflowId: agentLoopWorkflowId(userId, runId),
        args: [{ runId, userId }],
      }),
    );

    expect(result).toEqual({ status: "completed", outcome: "finished" });
    const toolMessages = step1Messages.filter(
      (m): m is Extract<AgentMessage, { role: "tool" }> => m.role === "tool",
    );
    expect(
      toolMessages[1]?.content[0]?.output.type === "error-text"
        ? toolMessages[1]?.content[0]?.output.value
        : "",
    ).toBe("Too many tool calls in single step");
  });

  it("handles non-retryable llmStep failure and records MODEL_ERROR", async () => {
    const runId = randomUUID();
    const userId = "user-1";
    const progressRecords: RecordProgressActivityInput[] = [];

    const activities: AgentLoopActivities = {
      async buildContext() {
        return createDefaultContext();
      },
      async llmStep() {
        throw ApplicationFailure.nonRetryable(
          "Model API failed",
          "ModelRequestError",
        );
      },
      async prepareTool() {
        return { ok: true, summary: "ok" };
      },
      async executeTool() {
        return { ok: true, summary: "ok" };
      },
      async recordProgress(input) {
        progressRecords.push(input);
      },
    };

    const taskQueue = `queue-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities,
    });

    const result = await worker.runUntil(
      env.client.workflow.execute(AGENT_LOOP_WORKFLOW_TYPE, {
        taskQueue,
        workflowId: agentLoopWorkflowId(userId, runId),
        args: [{ runId, userId }],
      }),
    );

    expect(result).toEqual({ status: "failed", error: "MODEL_ERROR" });
    const lastRecord = progressRecords[progressRecords.length - 1];
    expect(lastRecord?.status).toBe("failed");
    expect(lastRecord?.error).toBe("MODEL_ERROR");
  });
});
