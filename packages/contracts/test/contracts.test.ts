import { describe, expect, it } from "vitest";
import {
  agentRequestSchema,
  agentRunResponseSchema,
  agentRunSchema,
  ASSET_MAX_BYTES,
  canvasSnapshotSchema,
  createProjectRequestSchema,
  meResponseSchema,
  realtimeStreamEventSchema,
  realtimeTicketRequestSchema,
  realtimeTicketResponseSchema,
  requestAssetUploadRequestSchema,
  runEventSchema,
  runEventsChannel,
  runEventsSeqKey,
  saveCanvasRequestSchema,
  toNodeRuntime,
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

  it("maps node run status to runtime status", () => {
    expect(toNodeRuntime("pending")).toBe("queued");
    expect(toNodeRuntime("running")).toBe("running");
    expect(toNodeRuntime("succeeded")).toBe("succeeded");
    expect(toNodeRuntime("failed")).toBe("failed");
    expect(toNodeRuntime("cancelled")).toBe("failed");
  });

  it("validates realtime channel and seq keys", () => {
    expect(runEventsChannel("run-123")).toBe("run-events:run-123");
    expect(runEventsSeqKey("run-123")).toBe("run-events:run-123:seq");
  });

  it("validates realtime run events and streams", () => {
    const runId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const statusEvent = {
      type: "run.status",
      runId,
      seq: 1,
      status: "running",
    };
    expect(runEventSchema.parse(statusEvent)).toEqual(statusEvent);
    expect(realtimeStreamEventSchema.parse(statusEvent)).toEqual(statusEvent);

    const nodeEvent = {
      type: "node.status",
      runId,
      seq: 2,
      nodeId: "node-1",
      status: "running",
    };
    expect(runEventSchema.parse(nodeEvent)).toEqual(nodeEvent);

    const snapshotEvent = {
      type: "snapshot",
      runId,
      seq: 0,
      status: "running",
      nodes: [{ nodeId: "node-1", status: "running" }],
    };
    expect(realtimeStreamEventSchema.parse(snapshotEvent)).toEqual(
      snapshotEvent,
    );

    const pingEvent = { type: "ping", seq: 5 };
    expect(realtimeStreamEventSchema.parse(pingEvent)).toEqual(pingEvent);

    const doneEvent = { type: "done", status: "succeeded" };
    expect(realtimeStreamEventSchema.parse(doneEvent)).toEqual(doneEvent);

    // Rejects invalid events
    expect(runEventSchema.safeParse({ ...statusEvent, seq: 0 }).success).toBe(
      false,
    ); // seq must be positive
    expect(
      runEventSchema.safeParse({ ...statusEvent, runId: "not-uuid" }).success,
    ).toBe(false);
    expect(
      realtimeStreamEventSchema.safeParse({ type: "unknown" }).success,
    ).toBe(false);
  });

  it("validates realtime ticket request and response", () => {
    const runId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const agentRunId = "1f8fad5b-d9cb-469f-a165-70867728950f";
    expect(realtimeTicketRequestSchema.parse({ runId })).toEqual({ runId });
    expect(realtimeTicketRequestSchema.parse({ agentRunId })).toEqual({
      agentRunId,
    });
    expect(
      realtimeTicketRequestSchema.safeParse({ runId: "invalid" }).success,
    ).toBe(false);
    expect(
      realtimeTicketRequestSchema.safeParse({ agentRunId: "invalid" }).success,
    ).toBe(false);
    expect(
      realtimeTicketRequestSchema.safeParse({ runId, agentRunId }).success,
    ).toBe(false);

    const ticketResp = {
      ticket: "jwt-ticket-token",
      expiresIn: 30,
      baseUrl: "http://localhost:4000",
    };
    expect(realtimeTicketResponseSchema.parse(ticketResp)).toEqual(ticketResp);
    expect(
      realtimeTicketResponseSchema.safeParse({
        ...ticketResp,
        expiresIn: -1,
      }).success,
    ).toBe(false);
    expect(
      realtimeTicketResponseSchema.safeParse({
        ...ticketResp,
        baseUrl: "not-a-url",
      }).success,
    ).toBe(false);
  });

  it("validates asset schemas, limits and content types", () => {
    const valid = {
      workspaceId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      contentType: "image/png",
      sizeBytes: 1024,
    };
    expect(requestAssetUploadRequestSchema.parse(valid)).toEqual(valid);

    // Unsupported content type
    expect(
      requestAssetUploadRequestSchema.safeParse({
        ...valid,
        contentType: "application/x-executable",
      }).success,
    ).toBe(false);

    // Zero, negative, float, over max size
    expect(
      requestAssetUploadRequestSchema.safeParse({ ...valid, sizeBytes: 0 })
        .success,
    ).toBe(false);
    expect(
      requestAssetUploadRequestSchema.safeParse({ ...valid, sizeBytes: -10 })
        .success,
    ).toBe(false);
    expect(
      requestAssetUploadRequestSchema.safeParse({ ...valid, sizeBytes: 1.5 })
        .success,
    ).toBe(false);
    expect(
      requestAssetUploadRequestSchema.safeParse({
        ...valid,
        sizeBytes: ASSET_MAX_BYTES + 1,
      }).success,
    ).toBe(false);
  });

  it("verifies media-probe JSON Schema against committed file", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { z } = await import("zod");
    const { mediaProbeInputSchema, mediaProbeResultSchema } =
      await import("../src/media");

    const file = fileURLToPath(
      new URL("../schemas/media-probe.json", import.meta.url),
    );
    const committed = JSON.parse(readFileSync(file, "utf-8"));

    const generated = {
      input: z.toJSONSchema(mediaProbeInputSchema, { io: "input" }),
      output: z.toJSONSchema(mediaProbeResultSchema, { io: "output" }),
    };

    expect(committed).toEqual(generated);
  });
});
