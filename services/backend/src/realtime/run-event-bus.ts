import type Redis from "ioredis";
import {
  runEventSchema,
  runEventsChannel,
  type RunEvent,
} from "@creative/contracts";

export type RunEventListener = (event: RunEvent) => void;

export interface RunEventBus {
  subscribe(runId: string, listener: RunEventListener): Promise<() => void>;
  close(): Promise<void>;
  listenerCount(runId?: string): number;
}

export function createRunEventBus(subscriberRedis: Redis): RunEventBus {
  const listenersByRun = new Map<string, Set<RunEventListener>>();

  const onMessage = (channel: string, message: string) => {
    // Channel format: run-events:<runId>
    const prefix = "run-events:";
    if (!channel.startsWith(prefix)) return;
    const runId = channel.slice(prefix.length);
    const listeners = listenersByRun.get(runId);
    if (!listeners || listeners.size === 0) return;

    try {
      const parsed = JSON.parse(message);
      const result = runEventSchema.safeParse(parsed);
      if (!result.success) return;
      for (const listener of listeners) {
        listener(result.data);
      }
    } catch {
      // Discard invalid JSON
    }
  };

  subscriberRedis.on("message", onMessage);

  return {
    listenerCount(runId?: string): number {
      if (runId) {
        return listenersByRun.get(runId)?.size ?? 0;
      }
      let total = 0;
      for (const s of listenersByRun.values()) {
        total += s.size;
      }
      return total;
    },

    async subscribe(
      runId: string,
      listener: RunEventListener,
    ): Promise<() => void> {
      let set = listenersByRun.get(runId);
      const isFirst = !set || set.size === 0;
      if (!set) {
        set = new Set();
        listenersByRun.set(runId, set);
      }
      set.add(listener);

      if (isFirst) {
        try {
          await subscriberRedis.subscribe(runEventsChannel(runId));
        } catch (err) {
          set.delete(listener);
          if (set.size === 0) {
            listenersByRun.delete(runId);
          }
          throw err;
        }
      }

      let unsubscribed = false;
      return async () => {
        if (unsubscribed) return;
        unsubscribed = true;
        const currentSet = listenersByRun.get(runId);
        if (currentSet) {
          currentSet.delete(listener);
          if (currentSet.size === 0) {
            listenersByRun.delete(runId);
            try {
              await subscriberRedis.unsubscribe(runEventsChannel(runId));
            } catch {
              // Ignore unsubscribe errors on shutdown
            }
          }
        }
      };
    },

    async close(): Promise<void> {
      subscriberRedis.off("message", onMessage);
      listenersByRun.clear();
      try {
        await subscriberRedis.quit();
      } catch {
        subscriberRedis.disconnect();
      }
    },
  };
}
