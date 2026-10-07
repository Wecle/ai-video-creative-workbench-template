import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type Redis from "ioredis";
import { createGenericEventBus } from "../src/realtime/run-event-bus";

function createMockRedis() {
  const emitter = new EventEmitter();
  let subscribeDelayMs = 0;
  let shouldFailSubscribe = false;

  const mock = {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    setDelay: (ms: number) => {
      subscribeDelayMs = ms;
    },
    setFail: (fail: boolean) => {
      shouldFailSubscribe = fail;
    },
    subscribe: vi.fn(async (channel: string) => {
      if (subscribeDelayMs > 0) {
        await new Promise((r) => setTimeout(r, subscribeDelayMs));
      }
      if (shouldFailSubscribe) {
        throw new Error(`Failed to subscribe to ${channel}`);
      }
      return 1;
    }),
    unsubscribe: vi.fn(async () => {
      return 1;
    }),
    quit: vi.fn(async () => "OK"),
    disconnect: vi.fn(),
  };

  return mock as unknown as Redis & typeof mock;
}

describe("GenericEventBus concurrency and rollback (S1)", () => {
  it("shares in-flight SUBSCRIBE promise across concurrent subscribers", async () => {
    const mockRedis = createMockRedis();
    mockRedis.setDelay(50);

    const bus = createGenericEventBus<{ seq: number; type: string }>({
      subscriberRedis: mockRedis,
      prefix: "test:",
      channel: (id) => `test:${id}`,
      parse: (raw) => ({
        success: true,
        data: raw as { seq: number; type: string },
      }),
    });

    const l1Events: unknown[] = [];
    const l2Events: unknown[] = [];

    // Two concurrent subscribes to the same id
    const [unsub1, unsub2] = await Promise.all([
      bus.subscribe("run-1", (e) => l1Events.push(e)),
      bus.subscribe("run-1", (e) => l2Events.push(e)),
    ]);

    // Redis subscribe should only be called once
    expect(mockRedis.subscribe).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount("run-1")).toBe(2);

    // Emit message
    mockRedis.emit(
      "message",
      "test:run-1",
      JSON.stringify({ seq: 1, type: "test" }),
    );

    expect(l1Events).toHaveLength(1);
    expect(l2Events).toHaveLength(1);

    await unsub1();
    expect(bus.listenerCount("run-1")).toBe(1);
    expect(mockRedis.unsubscribe).not.toHaveBeenCalled();

    await unsub2();
    expect(bus.listenerCount("run-1")).toBe(0);
    expect(mockRedis.unsubscribe).toHaveBeenCalledTimes(1);

    await bus.close();
  });

  it("rolls back all waiting listeners when SUBSCRIBE fails and allows subsequent retry", async () => {
    const mockRedis = createMockRedis();
    mockRedis.setDelay(20);
    mockRedis.setFail(true);

    const bus = createGenericEventBus<{ seq: number; type: string }>({
      subscriberRedis: mockRedis,
      prefix: "test:",
      channel: (id) => `test:${id}`,
      parse: (raw) => ({
        success: true,
        data: raw as { seq: number; type: string },
      }),
    });

    const p1 = bus.subscribe("run-2", () => {});
    const p2 = bus.subscribe("run-2", () => {});

    await expect(p1).rejects.toThrow("Failed to subscribe to test:run-2");
    await expect(p2).rejects.toThrow("Failed to subscribe to test:run-2");

    // All listeners must be rolled back
    expect(bus.listenerCount("run-2")).toBe(0);

    // Subsequent subscribe should retry and succeed when Redis recovers
    mockRedis.setFail(false);
    const unsub = await bus.subscribe("run-2", () => {});
    expect(bus.listenerCount("run-2")).toBe(1);
    expect(mockRedis.subscribe).toHaveBeenCalledTimes(2);

    await unsub();
    expect(bus.listenerCount("run-2")).toBe(0);

    await bus.close();
  });
});
