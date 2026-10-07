import { randomUUID } from "node:crypto";
import http from "node:http";
import { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
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

async function setupCanvas(
  db: ReturnType<typeof createTestApp>["db"],
  userId: string,
  workspaceId: string,
) {
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
    const { projectId, canvasId } = await setupCanvas(
      db,
      owner.userId,
      owner.workspaceId,
    );

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
        headers: signedHeaders(
          "GET",
          `/api/v1/realtime/runs/${fakeRunId}/events`,
          {
            authType: "jwt",
            userId: owner.userId,
          },
        ),
      });
      expect(nonExistentRes.statusCode).toBe(404);

      // 2. Inaccessible run (other user tries to access owner's run)
      const inaccessibleRes = await app.inject({
        method: "GET",
        url: `/api/v1/realtime/runs/${runRow.id}/events`,
        headers: signedHeaders(
          "GET",
          `/api/v1/realtime/runs/${runRow.id}/events`,
          {
            authType: "ticket",
            userId: other.userId,
          },
        ),
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
    const { projectId, canvasId } = await setupCanvas(
      db,
      user.userId,
      user.workspaceId,
    );

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
    await vi.waitFor(() => expect(bus.listenerCount(runId)).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));

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
    const { projectId, canvasId } = await setupCanvas(
      db,
      user.userId,
      user.workspaceId,
    );

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

    await vi.waitFor(() =>
      expect(bus.listenerCount(runRow.id)).toBeGreaterThan(0),
    );
    await new Promise((r) => setTimeout(r, 100));

    // app.close() must complete without hanging
    await expect(close()).resolves.not.toThrow();
    redis.disconnect();

    const res = await injectPromise;
    expect(res.statusCode).toBe(200);
  });

  it("ensures PUBSUB NUMSUB is 0 after client disconnects", async () => {
    const redis = new Redis(rUrl);
    const subRedis = new Redis(rUrl);
    const bus = createRunEventBus(subRedis);
    const { app, db, close } = createTestApp(dbUrl, { redis, bus });
    const user = await createUserWithWorkspace(db, "numsub-user");
    const { projectId, canvasId } = await setupCanvas(
      db,
      user.userId,
      user.workspaceId,
    );

    const [runRow] = await db
      .insert(runs)
      .values({
        canvasId,
        projectId,
        workspaceId: user.workspaceId,
        createdBy: user.userId,
        canvasVersion: 1,
        snapshot: {},
        workflowId: "wf-numsub",
        status: "running",
      })
      .returning();

    const channel = runEventsChannel(runRow.id);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as { port: number };

    const urlPath = `/api/v1/realtime/runs/${runRow.id}/events`;
    const headers = signedHeaders("GET", urlPath, {
      authType: "jwt",
      userId: user.userId,
    });

    const clientReq = http.request({
      hostname: "127.0.0.1",
      port: address.port,
      path: urlPath,
      method: "GET",
      headers,
    });

    await new Promise<void>((resolve, reject) => {
      clientReq.on("response", (res) => {
        res.on("data", () => {
          resolve();
        });
      });
      clientReq.on("error", reject);
      clientReq.end();
    });

    // While client is connected, NUMSUB is at least 1
    const resBefore = await redis.pubsub("NUMSUB", channel);
    expect(Number(resBefore[1])).toBeGreaterThanOrEqual(1);

    // Client disconnects
    clientReq.destroy();

    // Verify NUMSUB becomes 0
    await vi.waitFor(
      async () => {
        expect(bus.listenerCount(runRow.id)).toBe(0);
        const resAfter = await redis.pubsub("NUMSUB", channel);
        expect(Number(resAfter[1])).toBe(0);
      },
      { timeout: 2000, interval: 50 },
    );

    await close();
    redis.disconnect();
  });

  it("does not leak subscription if redis.get throws error", async () => {
    const redis = new Redis(rUrl);
    const subRedis = new Redis(rUrl);
    const bus = createRunEventBus(subRedis);
    const { app, db, close } = createTestApp(dbUrl, { redis, bus });
    const user = await createUserWithWorkspace(db, "throw-get-user");
    const { projectId, canvasId } = await setupCanvas(
      db,
      user.userId,
      user.workspaceId,
    );

    const [runRow] = await db
      .insert(runs)
      .values({
        canvasId,
        projectId,
        workspaceId: user.workspaceId,
        createdBy: user.userId,
        canvasVersion: 1,
        snapshot: {},
        workflowId: "wf-throw-get",
        status: "running",
      })
      .returning();

    const channel = runEventsChannel(runRow.id);

    // Make redis.get throw on sequence key
    const originalGet = redis.get.bind(redis);
    vi.spyOn(redis, "get").mockImplementation(async (key) => {
      if (typeof key === "string" && key.includes(runRow.id)) {
        throw new Error("Simulated redis.get failure");
      }
      return originalGet(key);
    });

    const url = `/api/v1/realtime/runs/${runRow.id}/events`;
    const res = await app.inject({
      method: "GET",
      url,
      headers: signedHeaders("GET", url, {
        authType: "jwt",
        userId: user.userId,
      }),
    });

    expect(res.statusCode).toBe(500);

    // Must not leak bus listener or redis subscription
    await vi.waitFor(
      async () => {
        expect(bus.listenerCount(runRow.id)).toBe(0);
        const resSub = await redis.pubsub("NUMSUB", channel);
        expect(Number(resSub[1])).toBe(0);
      },
      { timeout: 2000, interval: 50 },
    );

    await close();
    redis.disconnect();
  });

  it("cleans up listener on SUBSCRIBE failure and subsequent subscribe receives events", async () => {
    const subRedis = new Redis(rUrl);
    const pubRedis = new Redis(rUrl);
    const bus = createRunEventBus(subRedis);
    const runId = randomUUID();
    const channel = runEventsChannel(runId);

    const originalSubscribe = subRedis.subscribe.bind(subRedis);
    let failFirst = true;
    vi.spyOn(subRedis, "subscribe").mockImplementation(async (...args) => {
      if (failFirst) {
        failFirst = false;
        throw new Error("Simulated SUBSCRIBE failure");
      }
      return originalSubscribe(...args);
    });

    const listener1 = vi.fn();
    await expect(bus.subscribe(runId, listener1)).rejects.toThrow(
      "Simulated SUBSCRIBE failure",
    );
    expect(bus.listenerCount(runId)).toBe(0);

    // Second subscription succeeds and receives events
    const receivedEvents: unknown[] = [];
    const unsubscribe2 = await bus.subscribe(runId, (evt) => {
      receivedEvents.push(evt);
    });
    expect(bus.listenerCount(runId)).toBe(1);

    // Publish event
    await pubRedis.publish(
      channel,
      JSON.stringify({
        type: "run.status",
        runId,
        seq: 1,
        status: "running",
      }),
    );

    await vi.waitFor(() => expect(receivedEvents).toHaveLength(1));
    expect((receivedEvents[0] as { seq: number }).seq).toBe(1);

    await unsubscribe2();
    await vi.waitFor(() => expect(bus.listenerCount(runId)).toBe(0));

    await bus.close();
    pubRedis.disconnect();
  });

  it("reflects incremented seq in subsequent ping event after redis.incr", async () => {
    const redis = new Redis(rUrl);
    const subRedis = new Redis(rUrl);
    const bus = createRunEventBus(subRedis);
    const { app, db, close } = createTestApp(dbUrl, {
      redis,
      bus,
      pingIntervalMs: 50,
    });
    const user = await createUserWithWorkspace(db, "incr-user");
    const { projectId, canvasId } = await setupCanvas(
      db,
      user.userId,
      user.workspaceId,
    );

    const [runRow] = await db
      .insert(runs)
      .values({
        canvasId,
        projectId,
        workspaceId: user.workspaceId,
        createdBy: user.userId,
        canvasVersion: 1,
        snapshot: {},
        workflowId: "wf-incr",
        status: "running",
      })
      .returning();

    const seqKey = runEventsSeqKey(runRow.id);
    await redis.set(seqKey, "2");

    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as { port: number };

    const urlPath = `/api/v1/realtime/runs/${runRow.id}/events`;
    const headers = signedHeaders("GET", urlPath, {
      authType: "jwt",
      userId: user.userId,
    });

    const clientReq = http.request({
      hostname: "127.0.0.1",
      port: address.port,
      path: urlPath,
      method: "GET",
      headers,
    });

    const pings: number[] = [];

    clientReq.on("response", (res) => {
      res.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        const matches = text.matchAll(/event: ping\ndata: (\{.*?\})/g);
        for (const m of matches) {
          const parsed = JSON.parse(m[1]!);
          pings.push(parsed.seq);
        }
      });
    });
    clientReq.end();

    // Wait for first ping (seq = 2)
    await vi.waitFor(() => expect(pings.length).toBeGreaterThanOrEqual(1));
    expect(pings[0]).toBe(2);

    // Manually INCR sequence key in Redis
    await redis.incr(seqKey); // 3
    await redis.incr(seqKey); // 4

    // Wait for next ping to have seq >= 4
    await vi.waitFor(
      () => {
        expect(pings.some((s) => s >= 4)).toBe(true);
      },
      { timeout: 2000, interval: 50 },
    );

    clientReq.destroy();
    await redis.del(seqKey);
    await close();
    redis.disconnect();
  });

  it("does not leak ping interval timer when connecting to a terminal run", async () => {
    const redis = new Redis(rUrl);
    const subRedis = new Redis(rUrl);
    const bus = createRunEventBus(subRedis);
    const PING_MS = 6789;
    const { app, db, close } = createTestApp(dbUrl, {
      redis,
      bus,
      pingIntervalMs: PING_MS,
    });
    const user = await createUserWithWorkspace(db, "terminal-timer-user");
    const { projectId, canvasId } = await setupCanvas(
      db,
      user.userId,
      user.workspaceId,
    );

    const [runRow] = await db
      .insert(runs)
      .values({
        canvasId,
        projectId,
        workspaceId: user.workspaceId,
        createdBy: user.userId,
        canvasVersion: 1,
        snapshot: {},
        workflowId: "wf-terminal-leak",
        status: "succeeded",
      })
      .returning();

    const activeTimers = new Set<unknown>();
    const origSetInterval = globalThis.setInterval;
    const origClearInterval = globalThis.clearInterval;

    const setSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((handler, ms, ...args) => {
        const timer = origSetInterval(handler, ms, ...args);
        if (ms === PING_MS) {
          activeTimers.add(timer);
        }
        return timer;
      });

    const clearSpy = vi
      .spyOn(globalThis, "clearInterval")
      .mockImplementation((timer) => {
        activeTimers.delete(timer);
        return origClearInterval(timer);
      });

    try {
      const url = `/api/v1/realtime/runs/${runRow.id}/events`;
      const headers = signedHeaders("GET", url, {
        authType: "jwt",
        userId: user.userId,
      });

      const res = await app.inject({
        method: "GET",
        url,
        headers,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("event: done");
      expect(res.body).toContain('"status":"succeeded"');

      // Assert that no ping timer remains active after done event
      expect(activeTimers.size).toBe(0);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
      for (const t of activeTimers) {
        origClearInterval(t as NodeJS.Timeout);
      }
      await close();
      redis.disconnect();
    }
  });
});
