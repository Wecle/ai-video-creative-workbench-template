import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isStepCount, streamText, tool } from "ai";
import { llmStep } from "../src/runtime/llm-step";
import { createScriptedMockModel } from "../src/runtime/mock-model";
import { createDeltaBatcher } from "../src/runtime/delta-batcher";
import { canvasApplyPatchTool } from "../src/tools/canvas-apply-patch";
import { createToolRegistry } from "../src/tools/registry";
import type { ToolProvider } from "../src/tools/types";

describe("llmStep and stream runtime", () => {
  const builtinProvider: ToolProvider = {
    id: "builtin",
    kind: "builtin",
    list: () => [canvasApplyPatchTool],
    execute: async () => ({ ok: true, summary: "ok" }),
  };
  const registry = createToolRegistry([builtinProvider]);

  it("publishes step.started and text.delta events in correct sequence", async () => {
    const startedEvents: Array<{ stepId: string; attempt: number }> = [];
    const deltaEvents: Array<{
      stepId: string;
      attempt: number;
      text: string;
    }> = [];
    let heartbeatCount = 0;

    const model = createScriptedMockModel();

    const result = await llmStep({
      runId: "run-1",
      stepId: "s0",
      index: 0,
      attempt: 1,
      system: "System prompt",
      messages: [{ role: "user", content: "Add a note please" }],
      tools: [
        {
          name: "canvas.applyPatch",
          modelName: "canvas_applyPatch",
          risk: "write",
        },
      ],
      model,
      toolRegistry: registry,
      events: {
        onStepStarted: (e) => {
          startedEvents.push(e);
        },
        onTextDelta: (e) => {
          deltaEvents.push(e);
        },
        heartbeat: () => {
          heartbeatCount++;
        },
      },
    });

    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]).toMatchObject({ stepId: "s0", attempt: 1 });
    expect(deltaEvents.length).toBeGreaterThanOrEqual(1);
    expect(heartbeatCount).toBeGreaterThanOrEqual(1);

    expect(result.text).toContain("I'll add a note node to your canvas.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe("canvas.applyPatch");
    expect(result.finishReason).toBe("tool-calls");
  });

  it("normalizes tool name back from model tool name", async () => {
    const model = createScriptedMockModel();
    const result = await llmStep({
      runId: "run-1",
      stepId: "s0",
      index: 0,
      system: "System prompt",
      messages: [{ role: "user", content: "Add a note" }],
      tools: [
        {
          name: "canvas.applyPatch",
          modelName: "canvas_applyPatch",
          risk: "write",
        },
      ],
      model,
      toolRegistry: registry,
    });

    expect(result.toolCalls[0]?.toolName).toBe("canvas.applyPatch");
  });

  it("restores tool name with mixed dots and underscores like a.b_c through production llmStep path (M-e)", async () => {
    const customTool = {
      name: "a.b_c",
      description: "Custom tool",
      risk: "read" as const,
      inputSchema: z.object({ query: z.string().optional() }),
    };
    const customProvider: ToolProvider = {
      id: "custom",
      kind: "builtin",
      list: () => [customTool],
      execute: async () => ({ ok: true, summary: "ok" }),
    };
    const customRegistry = createToolRegistry([customProvider]);

    const customModel = {
      specificationVersion: "v4" as const,
      provider: "mock",
      modelId: "mock",
      supportedUrls: {},
      async doStream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "call_abc_1",
              toolName: "a_b_c",
              input: JSON.stringify({ query: "test" }),
            });
            controller.enqueue({
              type: "finish",
              usage: {
                inputTokens: {
                  total: 10,
                  noCache: 10,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 10, text: 10, reasoning: 0 },
              },
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
            });
            controller.close();
          },
        });
        return { stream };
      },
    };

    const result = await llmStep({
      runId: "run-custom",
      stepId: "s0",
      index: 0,
      system: "System prompt",
      messages: [{ role: "user", content: "Run a.b_c" }],
      tools: [
        {
          name: "a.b_c",
          modelName: "a_b_c",
          risk: "read",
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: customModel as any,
      toolRegistry: customRegistry,
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe("a.b_c");
  });

  it("identifies invalid tool inputs as invalid without throwing", async () => {
    // Model generates invalid input for a strict schema tool
    const strictTool = tool({
      description: "Strict numbers only",
      inputSchema: z.strictObject({
        count: z.number().int().positive(),
      }),
    });

    // Mock model that outputs invalid tool input (string instead of number)
    const customModel = createScriptedMockModel({
      onCall: undefined,
    });
    // Override doStream to emit an invalid tool-call
    const badModel = {
      ...customModel,
      async doStream() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "call_bad_1",
              toolName: "strict_calc",
              input: JSON.stringify({ count: "not-a-number" }),
            });
            controller.enqueue({
              type: "finish",
              usage: {
                inputTokens: {
                  total: 10,
                  noCache: 10,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 10, text: 10, reasoning: 0 },
              },
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
            });
            controller.close();
          },
        });
        return { stream };
      },
    };

    const res = streamText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: badModel as any,
      prompt: "test",
      tools: {
        strict_calc: strictTool,
      },
      stopWhen: isStepCount(1),
    });

    const calls = await res.toolCalls;
    expect(calls).toHaveLength(1);
    // AI SDK sets invalid: true for schema mismatch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((calls[0] as any).invalid).toBe(true);
  });

  it("delta-batcher aggregates rapid chunks and flushes cleanly", () => {
    const flushes: string[] = [];
    let currentTime = 1000;
    const batcher = createDeltaBatcher({
      minIntervalMs: 50,
      minChars: 64,
      now: () => currentTime,
      onFlush: (t) => flushes.push(t),
    });

    // Appending small text rapidly doesn't flush immediately
    batcher.append("Hello ");
    batcher.append("world ");
    expect(flushes).toHaveLength(0);

    // After 50ms, next append flushes
    currentTime += 60;
    batcher.append("!");
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toBe("Hello world !");

    // Reaching minChars flushes immediately
    batcher.append("A".repeat(70));
    expect(flushes).toHaveLength(2);
    expect(flushes[1]).toBe("A".repeat(70));

    // flush() emits remaining buffer
    batcher.append("Final buffer");
    batcher.flush();
    expect(flushes).toHaveLength(3);
    expect(flushes[2]).toBe("Final buffer");
  });

  it("locks AI SDK stream parts and text-delta structure", async () => {
    const model = createScriptedMockModel();
    const result = streamText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      prompt: "Say hi without tools",
      tools: {},
      stopWhen: isStepCount(1),
    });

    const partTypes: string[] = [];
    for await (const part of result.stream) {
      partTypes.push(part.type);
      if (part.type === "text-delta") {
        // Must have .text property
        expect(typeof part.text).toBe("string");
      }
    }

    expect(partTypes).toContain("start");
    expect(partTypes).toContain("text-start");
    expect(partTypes).toContain("text-delta");
    expect(partTypes).toContain("text-end");
    expect(partTypes).toContain("finish");
  });
});
