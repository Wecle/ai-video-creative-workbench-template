import { describe, expect, it } from "vitest";
import {
  agentRequestSchema,
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
});
