import type Redis from "ioredis";
import {
  type AgentEvent,
  agentEventSchema,
  agentEventsChannel,
  type RunEvent,
  runEventSchema,
  runEventsChannel,
} from "@creative/contracts";

export type RunEventListener = (event: RunEvent) => void;
export type AgentEventListener = (event: AgentEvent) => void;

export interface GenericEventBus<TEvent> {
  subscribe(
    id: string,
    listener: (event: TEvent) => void,
  ): Promise<() => Promise<void>>;
  close(): Promise<void>;
  listenerCount(id?: string): number;
}

export type RunEventBus = GenericEventBus<RunEvent>;
export type AgentEventBus = GenericEventBus<AgentEvent>;

export interface GenericEventBusOptions<TEvent> {
  subscriberRedis: Redis;
  prefix: string;
  channel: (id: string) => string;
  parse: (raw: unknown) => { success: true; data: TEvent } | { success: false };
}

export function createGenericEventBus<TEvent>({
  subscriberRedis,
  prefix,
  channel,
  parse,
}: GenericEventBusOptions<TEvent>): GenericEventBus<TEvent> {
  const listenersById = new Map<string, Set<(event: TEvent) => void>>();
  const activeChannels = new Set<string>();
  const inFlightSubscribes = new Map<string, Promise<void>>();

  const onMessage = (ch: string, message: string) => {
    if (!ch.startsWith(prefix)) return;
    const id = ch.slice(prefix.length);
    const listeners = listenersById.get(id);
    if (!listeners || listeners.size === 0) return;

    try {
      const parsed = JSON.parse(message);
      const result = parse(parsed);
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
    listenerCount(id?: string): number {
      if (id) {
        return listenersById.get(id)?.size ?? 0;
      }
      let total = 0;
      for (const s of listenersById.values()) {
        total += s.size;
      }
      return total;
    },

    async subscribe(
      id: string,
      listener: (event: TEvent) => void,
    ): Promise<() => Promise<void>> {
      let set = listenersById.get(id);
      if (!set) {
        set = new Set();
        listenersById.set(id, set);
      }
      set.add(listener);

      if (!activeChannels.has(id)) {
        let inflight = inFlightSubscribes.get(id);
        if (!inflight) {
          inflight = (async () => {
            try {
              await subscriberRedis.subscribe(channel(id));
              activeChannels.add(id);
              const current = listenersById.get(id);
              if (!current || current.size === 0) {
                activeChannels.delete(id);
                try {
                  await subscriberRedis.unsubscribe(channel(id));
                } catch {
                  // Ignore unsubscribe errors
                }
              }
            } catch (err) {
              listenersById.delete(id);
              activeChannels.delete(id);
              throw err;
            } finally {
              inFlightSubscribes.delete(id);
            }
          })();
          inFlightSubscribes.set(id, inflight);
        }

        try {
          await inflight;
        } catch (err) {
          set.delete(listener);
          if (set.size === 0) {
            listenersById.delete(id);
          }
          throw err;
        }
      }

      let unsubscribed = false;
      return async () => {
        if (unsubscribed) return;
        unsubscribed = true;
        const currentSet = listenersById.get(id);
        if (currentSet) {
          currentSet.delete(listener);
          if (currentSet.size === 0) {
            listenersById.delete(id);
            if (activeChannels.has(id)) {
              activeChannels.delete(id);
              try {
                await subscriberRedis.unsubscribe(channel(id));
              } catch {
                // Ignore unsubscribe errors on shutdown
              }
            }
          }
        }
      };
    },

    async close(): Promise<void> {
      subscriberRedis.off("message", onMessage);
      listenersById.clear();
      activeChannels.clear();
      inFlightSubscribes.clear();
      try {
        await subscriberRedis.quit();
      } catch {
        subscriberRedis.disconnect();
      }
    },
  };
}

export function createRunEventBus(subscriberRedis: Redis): RunEventBus {
  return createGenericEventBus<RunEvent>({
    subscriberRedis,
    prefix: "run-events:",
    channel: runEventsChannel,
    parse: (raw) => runEventSchema.safeParse(raw),
  });
}

export function createAgentEventBus(subscriberRedis: Redis): AgentEventBus {
  return createGenericEventBus<AgentEvent>({
    subscriberRedis,
    prefix: "agent-events:",
    channel: agentEventsChannel,
    parse: (raw) => agentEventSchema.safeParse(raw),
  });
}
