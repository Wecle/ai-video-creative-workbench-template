import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { runEventsChannel, runEventsSeqKey, type RunEvent } from "@creative/contracts";
import { createRunEventPublisher } from "../src/events";

function redisUrl() {
  if (!process.env.REDIS_URL) {
    try {
      process.loadEnvFile(new URL("../../../.env", import.meta.url));
    } catch {
      // ignore
    }
  }
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  return url;
}

describe("orchestrator-worker event publisher", () => {
  it("increments sequence monotonically and publishes event to Redis channel", async () => {
    const url = redisUrl();
    const redis = new Redis(url);
    const subRedis = new Redis(url);
    const publisher = createRunEventPublisher(redis);

    const runId = randomUUID();
    const channel = runEventsChannel(runId);
    const received: RunEvent[] = [];

    await subRedis.subscribe(channel);
    subRedis.on("message", (_ch, msg) => {
      received.push(JSON.parse(msg));
    });

    try {
      await publisher.publish({
        type: "node.status",
        runId,
        nodeId: "node-1",
        status: "running",
      });

      await publisher.publish({
        type: "node.status",
        runId,
        nodeId: "node-1",
        status: "succeeded",
      });

      await publisher.publish({
        type: "run.status",
        runId,
        status: "succeeded",
      });

      await expect.poll(() => received.length).toBe(3);

      expect(received[0]).toMatchObject({
        type: "node.status",
        runId,
        nodeId: "node-1",
        status: "running",
        seq: 1,
      });

      expect(received[1]).toMatchObject({
        type: "node.status",
        runId,
        nodeId: "node-1",
        status: "succeeded",
        seq: 2,
      });

      expect(received[2]).toMatchObject({
        type: "run.status",
        runId,
        status: "succeeded",
        seq: 3,
      });

      // Seq in Redis matches
      const currentSeq = await redis.get(runEventsSeqKey(runId));
      expect(Number(currentSeq)).toBe(3);
    } finally {
      await redis.del(runEventsSeqKey(runId));
      await subRedis.unsubscribe(channel);
      redis.disconnect();
      subRedis.disconnect();
    }
  });

  it("does not throw when Redis is disconnected or fails", async () => {
    const brokenRedis = new Redis("redis://127.0.0.1:1", {
      connectTimeout: 100,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
    });
    brokenRedis.on("error", () => {});
    const publisher = createRunEventPublisher(brokenRedis);

    await expect(
      publisher.publish({
        type: "run.status",
        runId: randomUUID(),
        status: "running",
      }),
    ).resolves.not.toThrow();

    brokenRedis.disconnect();
  });
});
