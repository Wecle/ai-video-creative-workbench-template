import type Redis from "ioredis";
import {
  type NodeStatusEvent,
  type RunEvent,
  type RunStatusEvent,
  runEventsChannel,
  runEventsSeqKey,
} from "@creative/contracts";

export type PublishableRunEvent =
  Omit<RunStatusEvent, "seq"> | Omit<NodeStatusEvent, "seq">;

export interface RunEventPublisher {
  publish(event: PublishableRunEvent): Promise<void>;
}

export function createRunEventPublisher(redis?: Redis): RunEventPublisher {
  return {
    async publish(event: PublishableRunEvent): Promise<void> {
      if (!redis) return;
      try {
        const seqKey = runEventsSeqKey(event.runId);
        const channel = runEventsChannel(event.runId);

        // MULTI INCR seq + EXPIRE 24h
        const results = await redis
          .multi()
          .incr(seqKey)
          .expire(seqKey, 86400)
          .exec();

        if (!results || results.length === 0) return;
        const [incrErr, seq] = results[0];
        if (incrErr || typeof seq !== "number") return;

        const payload: RunEvent = {
          ...event,
          seq,
        } as RunEvent;

        await redis.publish(channel, JSON.stringify(payload));
      } catch (err) {
        console.warn("Failed to publish run event:", err);
      }
    },
  };
}
