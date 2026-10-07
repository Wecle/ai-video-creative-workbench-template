import { randomUUID } from "node:crypto";
import http from "node:http";
import { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { agentEventsChannel, agentEventsSeqKey } from "@creative/contracts";
import { schema } from "@creative/database";
import { createAgentEventBus } from "../src/realtime/run-event-bus";
import {
  createTestApp,
  createUserWithWorkspace,
  redisUrl,
  signedHeaders,
  testDatabaseUrl,
} from "./helpers";

const { projects, canvases, agent_runs } = schema;

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
      projectId: proj!.id,
      workspaceId,
      yjsState: Buffer.from([]),
      snapshot: { schemaVersion: 1, nodes: [], edges: [] },
      version: 1,
      schemaVersion: 1,
      updatedBy: userId,
    })
    .returning();

  return { projectId: proj!.id, canvasId: canvas!.id };
}

describe("backend realtime agent SSE streaming", () => {
  const dbUrl = testDatabaseUrl()!;
  const rUrl = redisUrl();

  it("rejects unsigned requests with 403", async () => {
    const { app, close } = createTestApp(dbUrl);
    try {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/realtime/agent/runs/${randomUUID()}/events`,
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await close();
    }
  });

  it("returns 404 for non-existent and inaccessible agent runs", async () => {
    const { app, db, close } = createTestApp(dbUrl);
    try {
      const user = await createUserWithWorkspace(db, "owner");
      const other = await createUserWithWorkspace(db, "other");
      const { projectId, canvasId } = await setupCanvas(
        db,
        user.userId,
        user.workspaceId,
      );

      const [runRow] = await db
        .insert(agent_runs)
        .values({
          workspaceId: user.workspaceId,
          projectId,
          canvasId,
          createdBy: user.userId,
          profileId: "creative-assistant",
          prompt: "Test",
          canvasVersion: 1,
          canvasSnapshot: {},
          status: "running",
          workflowId: "wf-1",
        })
        .returning();

      // 1. Non-existent -> 404
      const nonExistentUrl = `/api/v1/realtime/agent/runs/${randomUUID()}/events`;
      const nonExistentRes = await app.inject({
        method: "GET",
        url: nonExistentUrl,
        headers: signedHeaders("GET", nonExistentUrl, {
          authType: "jwt",
          userId: user.userId,
        }),
      });
      expect(nonExistentRes.statusCode).toBe(404);

      // 2. Inaccessible (other user) -> 404
      const realUrl = `/api/v1/realtime/agent/runs/${runRow!.id}/events`;
      const inaccessibleRes = await app.inject({
        method: "GET",
        url: realUrl,
        headers: signedHeaders("GET", realUrl, {
          authType: "jwt",
          userId: other.userId,
        }),
      });
      expect(inaccessibleRes.statusCode).toBe(404);
    } finally {
      await close();
    }
  });

  it("ensures PUBSUB NUMSUB is 0 after client disconnects", async () => {
    const redis = new Redis(rUrl);
    const subRedis = new Redis(rUrl);
    const agentBus = createAgentEventBus(subRedis);
    const { app, db, close } = createTestApp(dbUrl, { redis, agentBus });
    try {
      const user = await createUserWithWorkspace(db, "numsub-user");
      const { projectId, canvasId } = await setupCanvas(
        db,
        user.userId,
        user.workspaceId,
      );

      const [runRow] = await db
        .insert(agent_runs)
        .values({
          workspaceId: user.workspaceId,
          projectId,
          canvasId,
          createdBy: user.userId,
          profileId: "creative-assistant",
          prompt: "Test",
          canvasVersion: 1,
          canvasSnapshot: {},
          status: "running",
          workflowId: "wf-numsub",
        })
        .returning();

      const channel = agentEventsChannel(runRow!.id);
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address() as { port: number };

      const urlPath = `/api/v1/realtime/agent/runs/${runRow!.id}/events`;
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
          const resAfter = await redis.pubsub("NUMSUB", channel);
          expect(Number(resAfter[1])).toBe(0);
        },
        { timeout: 2000, interval: 50 },
      );

      expect(agentBus.listenerCount(runRow!.id)).toBe(0);
    } finally {
      await close();
      redis.disconnect();
    }
  });

  it("does not leak subscription if redis.get throws error during stream setup", async () => {
    const redis = new Redis(rUrl);
    const subRedis = new Redis(rUrl);
    const agentBus = createAgentEventBus(subRedis);
    const { app, db, close } = createTestApp(dbUrl, { redis, agentBus });
    try {
      const user = await createUserWithWorkspace(db, "throw-get-user");
      const { projectId, canvasId } = await setupCanvas(
        db,
        user.userId,
        user.workspaceId,
      );

      const [runRow] = await db
        .insert(agent_runs)
        .values({
          workspaceId: user.workspaceId,
          projectId,
          canvasId,
          createdBy: user.userId,
          profileId: "creative-assistant",
          prompt: "Test",
          canvasVersion: 1,
          canvasSnapshot: {},
          status: "running",
          workflowId: "wf-throw-get",
        })
        .returning();

      const channel = agentEventsChannel(runRow!.id);

      // Make redis.get throw on sequence key
      const originalGet = redis.get.bind(redis);
      vi.spyOn(redis, "get").mockImplementation(async (key) => {
        if (typeof key === "string" && key.includes(runRow!.id)) {
          throw new Error("Simulated redis.get failure");
        }
        return originalGet(key);
      });

      const url = `/api/v1/realtime/agent/runs/${runRow!.id}/events`;
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
      expect(agentBus.listenerCount(runRow!.id)).toBe(0);
      const resSub = await redis.pubsub("NUMSUB", channel);
      expect(Number(resSub[1])).toBe(0);
    } finally {
      await close();
      redis.disconnect();
    }
  });

  it("reflects incremented seq in subsequent ping event after redis.incr", async () => {
    const redis = new Redis(rUrl);
    const subRedis = new Redis(rUrl);
    const agentBus = createAgentEventBus(subRedis);
    const { app, db, close } = createTestApp(dbUrl, {
      redis,
      agentBus,
      pingIntervalMs: 50,
    });
    try {
      const user = await createUserWithWorkspace(db, "incr-user");
      const { projectId, canvasId } = await setupCanvas(
        db,
        user.userId,
        user.workspaceId,
      );

      const [runRow] = await db
        .insert(agent_runs)
        .values({
          workspaceId: user.workspaceId,
          projectId,
          canvasId,
          createdBy: user.userId,
          profileId: "creative-assistant",
          prompt: "Test",
          canvasVersion: 1,
          canvasSnapshot: {},
          status: "running",
          workflowId: "wf-incr",
        })
        .returning();

      const seqKey = agentEventsSeqKey(runRow!.id);
      await redis.set(seqKey, "2");

      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address() as { port: number };

      const urlPath = `/api/v1/realtime/agent/runs/${runRow!.id}/events`;
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
    } finally {
      await close();
      redis.disconnect();
    }
  });

  it("does not leak ping interval timer when connecting to a terminal run", async () => {
    const redis = new Redis(rUrl);
    const subRedis = new Redis(rUrl);
    const agentBus = createAgentEventBus(subRedis);
    const PING_MS = 7890;
    const { app, db, close } = createTestApp(dbUrl, {
      redis,
      agentBus,
      pingIntervalMs: PING_MS,
    });
    try {
      const user = await createUserWithWorkspace(db, "terminal-user");
      const { projectId, canvasId } = await setupCanvas(
        db,
        user.userId,
        user.workspaceId,
      );

      const [runRow] = await db
        .insert(agent_runs)
        .values({
          workspaceId: user.workspaceId,
          projectId,
          canvasId,
          createdBy: user.userId,
          profileId: "creative-assistant",
          prompt: "Terminal test",
          canvasVersion: 1,
          canvasSnapshot: {},
          status: "completed",
          workflowId: "wf-terminal-leak",
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
        const url = `/api/v1/realtime/agent/runs/${runRow!.id}/events`;
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
        expect(res.body).toContain('"status":"completed"');

        // Assert that no ping timer remains active after done event
        expect(activeTimers.size).toBe(0);
      } finally {
        setSpy.mockRestore();
        clearSpy.mockRestore();
        for (const t of activeTimers) {
          origClearInterval(t as NodeJS.Timeout);
        }
      }
    } finally {
      await close();
      redis.disconnect();
    }
  });
});
