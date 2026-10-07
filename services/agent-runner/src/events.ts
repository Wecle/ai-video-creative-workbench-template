import type Redis from "ioredis";
import {
  type AgentEvent,
  agentEventsChannel,
  agentEventsSeqKey,
} from "@creative/contracts";

type DistributiveOmit<T, K extends keyof any> = T extends any
  ? Omit<T, K>
  : never;

export type PublishableAgentEvent = DistributiveOmit<AgentEvent, "seq">;

export interface AgentEventPublisher {
  publish(event: PublishableAgentEvent): Promise<number | undefined>;
}

export function createAgentEventPublisher(
  redis?: Redis,
  expireSeconds = 86400,
): AgentEventPublisher {
  return {
    async publish(event: PublishableAgentEvent): Promise<number | undefined> {
      if (!redis) return undefined;
      try {
        const seqKey = agentEventsSeqKey(event.runId);
        const channel = agentEventsChannel(event.runId);

        const results = await redis
          .multi()
          .incr(seqKey)
          .expire(seqKey, expireSeconds)
          .exec();

        if (!results || results.length === 0) return undefined;
        const [incrErr, seq] = results[0];
        if (incrErr || typeof seq !== "number") return undefined;

        const payload: AgentEvent = {
          ...event,
          seq,
        } as AgentEvent;

        await redis.publish(channel, JSON.stringify(payload));
        return seq;
      } catch (err) {
        console.warn("Failed to publish agent event:", err);
        return undefined;
      }
    },
  };
}
