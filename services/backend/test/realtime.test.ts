import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { runEventsChannel, runEventsSeqKey } from "@creative/contracts";
import { schema } from "@creative/database";
import { createRunEventBus } from "../src/realtime/run-event-bus";
import {
  createTestApp,
  createUserWithWorkspace,
  redisUrl,
  signedHeaders,
  testDatabaseUrl,
} from "./helpers";

const { projects, canvases, runs, node_runs } = schema;

async function setupCanvas(db: ReturnType<typeof createTestApp>["db"], userId: string, workspaceId: string) {
  const [proj] = await db
    .insert(projects)
    .values({
      name: "Test Proj",
      workspaceId,
      createdBy: userId,
    })
    .returning();

  const [canvas] = await db
    .insert(canvases)
    .values({
      name: "Test Canvas",
      projectId: proj.id,
      workspaceId,
      yjsState: Buffer.from([]),
      snapshot: { schemaVersion: 1, nodes: [], edges: [] },
      schemaVersion: 1,
      updatedBy: userId,
    })
    .returning();

  return { projectId: proj.id, canvasId: canvas.id };
}

describe("backend realtime SSE streaming", () => {
  const dbUrl = testDatabaseUrl()!;
  const rUrl = redisUrl();

  it("rejects unsigned requests with 403", async () => {
    const { app, close } = createTestApp(dbUrl);
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/realtime/runs/${randomUUID()}/events`,
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await close();
    }
  });

  it("rejects ticket identity on business routes like /api/v1/me with 401", async () => {
    const { app, close } = createTestApp(dbUrl);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: signedHeaders("GET", "/api/v1/me", {
          authType: "ticket",
          userId: "user-123",
        }),
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await close();
    }
  });

  it("returns identical 404 for non-existent run and inaccessible run", async () => {
    const { app, db, close } = createTestApp(dbUrl);
    const owner = await createUserWithWorkspace(db, "owner");
    const other = await createUserWithWorkspace(db, "other");
    const { projectId, canvasId } = await setupCanvas(db, owner.userId, owner.workspaceId);

    const [runRow] = await db
      .insert(runs)
      .values({
        canvasId,
        projectId,
        workspaceId: owner.workspaceId,
        createdBy: owner.userId,
        canvasVersion: 1,
        snapshot: {},
        workflowId: "wf-1",
        status: "queued",
      })
      .returning();

    try {
      // 1. Non-existent run
      const fakeRunId = randomUUID();
      const nonExistentRes = await app.inject({
        method: "GET",
        url: `/api/v1/realtime/runs/${fakeRunId}/events`,
        headers: signedHeaders("GET", `/api/v1/realtime/runs/${fakeRunId}/events`, {
          authType: "jwt",
          userId: owner.userId,
        }),
      });
      expect(nonExistentRes.statusCode).toBe(404);

      // 2. Inaccessible run (other user tries to access owner's run)
      const inaccessibleRes = await app.inject({
        method: "GET",
        url: `/api/v1/realtime/runs/${runRow.id}/events`,
        headers: signedHeaders("GET", `/api/v1/realtime/runs/${runRow.id}/events`, {
          authType: "ticket",
          userId: other.userId,
        }),
      });
      expect(inaccessibleRes.statusCode).toBe(404);

      // Identical response body to prevent enumeration
      expect(nonExistentRes.json()).toEqual(inaccessibleRes.json());
      expect(nonExistentRes.json()).toEqual({ error: "Run not found" });
    } finally {
      await close();
    }
  });

  it("sends snapshot at seq0, receives ordered incremental events, and finishes on terminal state", async () => {
    const redis = new Redis(rUrl);
    const subRedis = new Redis(rUrl);
    const bus = createRunEventBus(subRedis);
    const { app, db, close } = createTestApp(dbUrl, {
      redis,
      bus,
      pingIntervalMs: 200,
    });
    const user = await createUserWithWorkspace(db, "stream-user");
    const { projectId, canvasId } = await setupCanvas(db, user.userId, user.workspaceId);

    const [runRow] = await db
      .insert(runs)
      .values({
        canvasId,
        projectId,
        workspaceId: user.workspaceId,
        createdBy: user.userId,
        canvasVersion: 1,
        snapshot: {},
        workflowId: "wf-stream",
        status: "running",
      })
      .returning();

    await db.insert(node_runs).values({
      runId: runRow.id,
      nodeId: "node-1",
      nodeType: "text",
      status: "running",
    });

    const runId = runRow.id;
    const channel = runEventsChannel(runId);
    const seqKey = runEventsSeqKey(runId);

    // Initial seq in Redis = 1
    await redis.set(seqKey, "1");

    const url = `/api/v1/realtime/runs/${runId}/events`;
    const headers = signedHeaders("GET", url, {
      authType: "ticket",
      userId: user.userId,
    });

    // Start streaming via fastify.inject
    const responsePromise = app.inject({
      method: "GET",
      url,
      headers,
    });

    // Give time for initial subscription & snapshot
    await new Promise((r) => setTimeout(r, 100));

    // Publish incremental node status event
    await redis.publish(
      channel,
      JSON.stringify({
        type: "node.status",
        runId,
        nodeId: "node-1",
        status: "succeeded",
        seq: 2,
      }),
    );

    // Incur seq to 5 to test ping self-healing
    await redis.set(seqKey, "5");

    // Wait for at least one ping (ping interval is 200ms)
    await new Promise((r) => setTimeout(r, 300));

    // Publish terminal run.status event
    await redis.publish(
      channel,
      JSON.stringify({
        type: "run.status",
        runId,
        status: "succeeded",
        seq: 6,
      }),
    );

    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");

    const body = response.body;
    expect(body).toContain("retry: 3000");

    // Check snapshot event
    expect(body).toContain("event: snapshot");
    expect(body).toContain('"type":"snapshot"');
    expect(body).toContain('"seq":1');

    // Check incremental event
    expect(body).toContain("event: node.status");
    expect(body).toContain('"status":"succeeded"');

    // Check ping event with seq=5
    expect(body).toContain("event: ping");
    expect(body).toContain('"seq":5');

    // Check done event
    expect(body).toContain("event: done");
    expect(body).toContain('"status":"succeeded"');

    await redis.del(seqKey);
    redis.disconnect();
    await close();
  });

  it("allows app.close() cleanly even when connections are active", async () => {
    const redis = new Redis(rUrl);
    const subRedis = new Redis(rUrl);
    const bus = createRunEventBus(subRedis);
    const { app, db, close } = createTestApp(dbUrl, { redis, bus });
    const user = await createUserWithWorkspace(db, "close-user");
    const { projectId, canvasId } = await setupCanvas(db, user.userId, user.workspaceId);

    const [runRow] = await db
      .insert(runs)
      .values({
        canvasId,
        projectId,
        workspaceId: user.workspaceId,
        createdBy: user.userId,
        canvasVersion: 1,
        snapshot: {},
        workflowId: "wf-close",
        status: "running",
      })
      .returning();

    const url = `/api/v1/realtime/runs/${runRow.id}/events`;
    const headers = signedHeaders("GET", url, {
      authType: "jwt",
      userId: user.userId,
    });

    const injectPromise = app.inject({
      method: "GET",
      url,
      headers,
    });

    await new Promise((r) => setTimeout(r, 100));

    // app.close() must complete without hanging
    await expect(close()).resolves.not.toThrow();
    redis.disconnect();

    const res = await injectPromise;
    expect(res.statusCode).toBe(200);
  });
});
