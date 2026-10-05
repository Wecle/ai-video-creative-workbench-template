import { describe, expect, it } from "vitest";
import {
  agentRequestSchema,
  agentRunResponseSchema,
  agentRunSchema,
  canvasSnapshotSchema,
  createProjectRequestSchema,
  meResponseSchema,
  saveCanvasRequestSchema,
} from "../src";

describe("contracts", () => {
  const snapshot = {
    schemaVersion: 1,
    nodes: [
      {
        id: "n1",
        type: "text",
        version: 1,
        title: "Text",
        position: { x: 0, y: 0 },
        config: { text: "" },
      },
    ],
    edges: [],
  };
  it("parses a canvas snapshot", () =>
    expect(canvasSnapshotSchema.parse(snapshot)).toEqual(snapshot));
  it("rejects runtime status, viewport and unknown keys in snapshots", () => {
    const withStatus = {
      ...snapshot,
      nodes: [{ ...snapshot.nodes[0], status: "ready" }],
    };
    expect(canvasSnapshotSchema.safeParse(withStatus).success).toBe(false);
    expect(
      canvasSnapshotSchema.safeParse({
        ...snapshot,
        viewport: { x: 0, y: 0, zoom: 1 },
      }).success,
    ).toBe(false);
    expect(
      canvasSnapshotSchema.safeParse({ ...snapshot, canvasId: "c" }).success,
    ).toBe(false);
  });
  it("rejects future snapshot versions and unsafe ids", () => {
    expect(
      canvasSnapshotSchema.safeParse({ ...snapshot, schemaVersion: 2 }).success,
    ).toBe(false);
    const badId = { ...snapshot, nodes: [{ ...snapshot.nodes[0], id: "a:b" }] };
    expect(canvasSnapshotSchema.safeParse(badId).success).toBe(false);
  });
  it("validates project and canvas request bodies", () => {
    expect(createProjectRequestSchema.safeParse({ name: "  " }).success).toBe(
      false,
    );
    expect(createProjectRequestSchema.parse({ name: " Film " }).name).toBe(
      "Film",
    );
    expect(
      createProjectRequestSchema.safeParse({ name: "x", workspaceId: "nope" })
        .success,
    ).toBe(false);
    expect(
      saveCanvasRequestSchema.safeParse({ baseVersion: 0, state: "AAAA" })
        .success,
    ).toBe(true);
    expect(
      saveCanvasRequestSchema.safeParse({
        baseVersion: 0,
        state: "not base64!",
      }).success,
    ).toBe(false);
    expect(
      saveCanvasRequestSchema.safeParse({ baseVersion: -1, state: "AAAA" })
        .success,
    ).toBe(false);
  });
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
