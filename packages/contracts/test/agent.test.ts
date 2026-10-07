import { describe, expect, it } from "vitest";
import {
  AGENT_PATCH_MAX_OPS,
  agentEventsChannel,
  agentEventsSeqKey,
  agentLoopApprovalRequestSchema,
  agentLoopProposalSchema,
  agentLoopRunSchema,
  agentLoopStartRequestSchema,
  agentProfileSummarySchema,
  agentStreamEventSchema,
  canvasPatchSchema,
} from "../src";

describe("agent loop contracts", () => {
  const validUuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const validCanvasId = "n1";

  describe("canvasPatchSchema", () => {
    it("accepts valid patch with 1 to 50 operations", () => {
      const validPatch = {
        summary: "Add and connect nodes",
        ops: [
          {
            op: "addNode",
            id: validCanvasId,
            type: "text",
            position: { x: 100, y: 200 },
            config: { text: "hello" },
          },
          {
            op: "updateConfig",
            id: validCanvasId,
            patch: { text: "world" },
          },
          {
            op: "connect",
            source: validCanvasId,
            sourceHandle: "out",
            target: "n2",
            targetHandle: "in",
          },
        ],
      };
      expect(canvasPatchSchema.parse(validPatch)).toEqual(validPatch);
    });

    it("rejects empty ops or more than 50 ops", () => {
      expect(
        canvasPatchSchema.safeParse({ summary: "Empty", ops: [] }).success,
      ).toBe(false);

      const tooManyOps = Array.from(
        { length: AGENT_PATCH_MAX_OPS + 1 },
        (_, i) => ({
          op: "updateConfig" as const,
          id: `node-${i}`,
          patch: {},
        }),
      );
      expect(
        canvasPatchSchema.safeParse({ summary: "Too many", ops: tooManyOps })
          .success,
      ).toBe(false);
    });

    it("rejects unknown op or invalid operation shapes", () => {
      expect(
        canvasPatchSchema.safeParse({
          summary: "Unknown op",
          ops: [{ op: "deleteNode", id: "n1" }],
        }).success,
      ).toBe(false);

      expect(
        canvasPatchSchema.safeParse({
          summary: "Invalid connect",
          ops: [{ op: "connect", source: "n1", target: "n2" }], // missing handles
        }).success,
      ).toBe(false);
    });
  });

  describe("agentLoopStartRequestSchema", () => {
    it("accepts valid start request", () => {
      const req = {
        projectId: validUuid,
        canvasId: validUuid,
        canvasVersion: 0,
        prompt: "Create a shot list",
        profileId: "creative-assistant",
        selectedSkills: ["shot-list"],
        selectedNodeIds: ["n1"],
      };
      expect(agentLoopStartRequestSchema.parse(req)).toEqual(req);
    });

    it("rejects negative canvasVersion or blank prompt", () => {
      expect(
        agentLoopStartRequestSchema.safeParse({
          projectId: validUuid,
          canvasId: validUuid,
          canvasVersion: -1,
          prompt: "Valid prompt",
        }).success,
      ).toBe(false);

      expect(
        agentLoopStartRequestSchema.safeParse({
          projectId: validUuid,
          canvasId: validUuid,
          canvasVersion: 0,
          prompt: "   ",
        }).success,
      ).toBe(false);
    });

    it("rejects unknown fields in start request", () => {
      expect(
        agentLoopStartRequestSchema.safeParse({
          projectId: validUuid,
          canvasId: validUuid,
          canvasVersion: 0,
          prompt: "Hello",
          extraField: "not-allowed",
        }).success,
      ).toBe(false);
    });
  });

  describe("agentLoopApprovalRequestSchema", () => {
    it("accepts approve and reject", () => {
      expect(
        agentLoopApprovalRequestSchema.parse({
          toolCallId: "call_123",
          decision: "approve",
        }),
      ).toEqual({ toolCallId: "call_123", decision: "approve" });

      expect(
        agentLoopApprovalRequestSchema.parse({
          toolCallId: "call_123",
          decision: "reject",
        }),
      ).toEqual({ toolCallId: "call_123", decision: "reject" });
    });

    it("rejects invalid decisions", () => {
      expect(
        agentLoopApprovalRequestSchema.safeParse({
          toolCallId: "call_123",
          decision: "maybe",
        }).success,
      ).toBe(false);
    });
  });

  describe("agentLoopProposalSchema", () => {
    it("accepts proposal with patch result and validates strictObject", () => {
      const proposal = {
        toolCallId: "call_1",
        toolName: "canvas.applyPatch",
        input: { patch: { summary: "Test", ops: [] } },
        summary: "Propose adding note",
        risk: "write" as const,
        status: "pending" as const,
      };
      expect(agentLoopProposalSchema.parse(proposal)).toEqual(proposal);

      // Extra fields rejected
      expect(
        agentLoopProposalSchema.safeParse({ ...proposal, extra: 123 }).success,
      ).toBe(false);
    });
  });

  describe("agentLoopRunSchema", () => {
    it("validates full agent loop run view", () => {
      const run = {
        id: validUuid,
        profileId: "creative-assistant",
        projectId: validUuid,
        canvasId: validUuid,
        canvasVersion: 1,
        status: "completed" as const,
        outcome: "finished" as const,
        error: null,
        createdAt: "2026-10-07T00:00:00.000Z",
        completedAt: "2026-10-07T00:01:00.000Z",
        steps: [
          {
            stepId: "s0",
            index: 0,
            text: "Hello",
            finishReason: "tool-calls",
            toolCalls: [
              {
                toolCallId: "c1",
                toolName: "canvas.applyPatch",
                input: {},
              },
            ],
          },
        ],
        proposals: [],
      };
      expect(agentLoopRunSchema.parse(run)).toEqual(run);
    });
  });

  describe("agentProfileSummarySchema", () => {
    it("validates profile summary", () => {
      const summary = {
        id: "creative-assistant",
        name: "Creative Assistant",
        description: "Helps you brainstorm and build video shots on canvas.",
        starters: [
          {
            id: "starter-1",
            label: "Add creative note",
            prompt: "Add a creative note node to my canvas.",
          },
        ],
      };
      expect(agentProfileSummarySchema.parse(summary)).toEqual(summary);
    });
  });

  describe("agent stream events & channels", () => {
    it("formats channels and seq keys correctly", () => {
      expect(agentEventsChannel(validUuid)).toBe(`agent-events:${validUuid}`);
      expect(agentEventsSeqKey(validUuid)).toBe(
        `agent-events:${validUuid}:seq`,
      );
    });

    it("validates stream events including snapshot, ping, text delta, and done", () => {
      const delta = {
        type: "agent.text.delta" as const,
        runId: validUuid,
        seq: 1,
        stepId: "s0",
        attempt: 1,
        text: "Thinking...",
      };
      expect(agentStreamEventSchema.parse(delta)).toEqual(delta);

      const ping = { type: "ping" as const, seq: 10 };
      expect(agentStreamEventSchema.parse(ping)).toEqual(ping);

      const done = {
        type: "done" as const,
        status: "completed" as const,
        outcome: "finished" as const,
      };
      expect(agentStreamEventSchema.parse(done)).toEqual(done);
    });
  });
});
