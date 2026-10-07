import { describe, expect, it, vi } from "vitest";
import { isStepCount, streamText, tool } from "ai";
import { z } from "zod";
import { createScriptedMockModel } from "../src/runtime/mock-model";

describe("scripted mock model", () => {
  it("generates initial text and canvas_applyPatch tool call with lowest missing k", async () => {
    const onCall = vi.fn();
    const model = createScriptedMockModel({ onCall });

    const tools = {
      canvas_applyPatch: tool({
        description: "Apply patch",
        inputSchema: z.object({ summary: z.string(), ops: z.array(z.any()) }),
      }),
    };

    const res = streamText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      prompt: "Please add a note to canvas: agent-note-1 is already there",
      tools,
      stopWhen: isStepCount(1),
    });

    const fullText = await res.text;
    expect(fullText).toContain("I'll add a note node to your canvas.");

    const toolCalls = await res.toolCalls;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolName).toBe("canvas_applyPatch");

    // Since agent-note-1 was in prompt, k should be 2!
    const input = toolCalls[0]?.input as { ops: Array<{ id: string }> };
    expect(input.ops[0]?.id).toBe("agent-note-2");

    const finishReason = await res.finishReason;
    expect(finishReason).toBe("tool-calls");
  });

  it("is completely stateless: identical input produces identical output across multiple calls", async () => {
    const model = createScriptedMockModel();
    const tools = {
      canvas_applyPatch: tool({
        description: "Apply patch",
        inputSchema: z.object({ summary: z.string(), ops: z.array(z.any()) }),
      }),
    };

    const call1 = streamText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      prompt: "Run 1",
      tools,
      stopWhen: isStepCount(1),
    });
    const text1 = await call1.text;
    const tools1 = await call1.toolCalls;

    const call2 = streamText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      prompt: "Run 1",
      tools,
      stopWhen: isStepCount(1),
    });
    const text2 = await call2.text;
    const tools2 = await call2.toolCalls;

    expect(text1).toBe(text2);
    expect(tools1).toEqual(tools2);
  });

  it("handles skill keyword and sequence: skill_load -> canvas_applyPatch -> completion", async () => {
    const model = createScriptedMockModel();
    const tools = {
      skill_load: tool({
        description: "Load skill",
        inputSchema: z.object({ name: z.string() }),
      }),
      canvas_applyPatch: tool({
        description: "Apply patch",
        inputSchema: z.object({ summary: z.string(), ops: z.array(z.any()) }),
      }),
    };

    // Step 1: prompt mentions skill
    const step1 = streamText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      messages: [{ role: "user", content: "Use the shot-list skill please" }],
      tools,
      stopWhen: isStepCount(1),
    });
    expect(await step1.text).toContain("I'll load the shot-list skill first.");
    const calls1 = await step1.toolCalls;
    expect(calls1[0]?.toolName).toBe("skill_load");
    expect(calls1[0]?.input).toEqual({ name: "shot-list" });

    // Step 2: Feed back skill_load result
    const step2 = streamText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      messages: [
        { role: "user", content: "Use the shot-list skill please" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll load the shot-list skill first." },
            {
              type: "tool-call",
              toolCallId: "call_skill_1",
              toolName: "skill_load",
              input: { name: "shot-list" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_skill_1",
              toolName: "skill_load",
              output: { type: "text", value: "Skill documentation here" },
            },
          ],
        },
      ],
      tools,
      stopWhen: isStepCount(1),
    });
    expect(await step2.text).toContain(
      "Now I'll add a note node to your canvas.",
    );
    const calls2 = await step2.toolCalls;
    expect(calls2[0]?.toolName).toBe("canvas_applyPatch");

    // Step 3: Feed back patch result (success)
    const step3Success = streamText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      messages: [
        { role: "user", content: "Use the shot-list skill please" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_patch_2",
              toolName: "canvas_applyPatch",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_patch_2",
              toolName: "canvas_applyPatch",
              output: { type: "json", value: { ok: true } },
            },
          ],
        },
      ],
      tools,
      stopWhen: isStepCount(1),
    });
    expect(await step3Success.text).toBe("Done. The note node was added.");
    expect(await step3Success.finishReason).toBe("stop");

    // Step 3 with rejection
    const step3Rejected = streamText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      messages: [
        { role: "user", content: "Use the shot-list skill please" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_patch_2",
              toolName: "canvas_applyPatch",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_patch_2",
              toolName: "canvas_applyPatch",
              output: { type: "error-text", value: "rejected by user" },
            },
          ],
        },
      ],
      tools,
      stopWhen: isStepCount(1),
    });
    expect(await step3Rejected.text).toBe(
      "Understood. I did not change the canvas.",
    );
    expect(await step3Rejected.finishReason).toBe("stop");
  });

  it("finishes with stop when no tools are available", async () => {
    const model = createScriptedMockModel();
    const res = streamText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      prompt: "Hello without tools",
      tools: {},
      stopWhen: isStepCount(1),
    });
    expect(await res.text).toBe("I have no tools available in this mode.");
    expect(await res.finishReason).toBe("stop");
  });
});
