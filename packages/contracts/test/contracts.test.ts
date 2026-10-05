import { describe, expect, it } from "vitest";
import {
  agentRequestSchema,
  agentRunResponseSchema,
  agentRunSchema,
  canvasDocumentSchema,
  demoCanvasDocument,
  meResponseSchema,
} from "../src";

describe("contracts", () => {
  it("validates the demo canvas", () =>
    expect(canvasDocumentSchema.parse(demoCanvasDocument)).toEqual(
      demoCanvasDocument,
    ));
  it("rejects future document versions", () =>
    expect(
      canvasDocumentSchema.safeParse({
        ...demoCanvasDocument,
        schemaVersion: 2,
      }).success,
    ).toBe(false));
  it("rejects blank agent prompts", () =>
    expect(agentRequestSchema.safeParse({ prompt: "  " }).success).toBe(false));
  it("parses the /me response", () => {
    const body = {
      user: { id: "u1", name: "A", email: "a@example.test", image: null },
      workspaces: [
        { id: "w1", name: "A's workspace", slug: "ws-u1", role: "owner" },
      ],
    };
    expect(meResponseSchema.parse(body)).toEqual(body);
    expect(meResponseSchema.safeParse({ user: body.user }).success).toBe(false);
  });
  it("parses agent runs and their response envelope", () => {
    const run = {
      id: "0f8fad5b-d9cb-469f-a165-70867728950e",
      status: "completed",
      createdAt: "2026-10-05T00:00:00.000Z",
      result: { message: "Template Agent received: Hi" },
    };
    expect(agentRunSchema.parse(run)).toEqual(run);
    expect(agentRunResponseSchema.parse({ run })).toEqual({ run });
    expect(
      agentRunSchema.parse({ ...run, status: "failed", result: undefined })
        .status,
    ).toBe("failed");
    expect(agentRunSchema.safeParse({ ...run, status: "paused" }).success).toBe(
      false,
    );
    expect(agentRunSchema.safeParse({ ...run, id: "not-a-uuid" }).success).toBe(
      false,
    );
  });
});
