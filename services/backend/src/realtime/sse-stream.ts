import { PassThrough } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

export interface EventBusLike<TEvent> {
  subscribe(
    id: string,
    listener: (event: TEvent) => void,
  ): Promise<() => void | Promise<void>>;
}

export type TerminalStatus =
  string | { status: string; outcome?: string | null };

export interface OpenRunStreamOptions<
  TEvent extends { seq: number; type: string },
  TSnapshot,
> {
  bus: EventBusLike<TEvent>;
  redis: Redis;
  runId: string;
  seqKey: string;
  loadSnapshot: (seq0: number) => Promise<{
    snapshot: TSnapshot | null;
    initialTerminalStatus?: TerminalStatus | null;
  }>;
  isTerminalEvent?: (event: TEvent) => TerminalStatus | null | undefined;
  pingIntervalMs?: number;
  activeConnections?: Set<() => void>;
}

export async function openRunStream<
  TEvent extends { seq: number; type: string },
  TSnapshot,
>(
  request: FastifyRequest,
  reply: FastifyReply,
  options: OpenRunStreamOptions<TEvent, TSnapshot>,
): Promise<void> {
  const {
    bus,
    redis,
    runId,
    seqKey,
    loadSnapshot,
    isTerminalEvent,
    pingIntervalMs = 15_000,
    activeConnections,
  } = options;

  const buffer: TEvent[] = [];
  let live = false;
  let ended = false;
  let pingInterval: NodeJS.Timeout | null = null;
  const stream = new PassThrough();

  const push = (event: TEvent) => {
    if (ended) return;
    if (!live) {
      buffer.push(event);
    } else {
      sendEvent(event);
    }
  };

  const unsubscribe = await bus.subscribe(runId, push);

  function cleanup() {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    try {
      const res = unsubscribe() as unknown;
      if (res && typeof (res as Promise<void>).catch === "function") {
        (res as Promise<void>).catch(() => {});
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  const closeStream = () => {
    if (!ended) {
      ended = true;
      if (activeConnections) {
        activeConnections.delete(closeStream);
      }
      cleanup();
      stream.end();
    }
  };

  if (activeConnections) {
    activeConnections.add(closeStream);
  }

  request.raw.on("close", () => {
    closeStream();
  });

  if (request.raw.destroyed) {
    closeStream();
    if (!reply.sent) {
      reply.hijack();
      reply.raw.destroy();
    }
    return;
  }

  function finish(terminal: TerminalStatus) {
    if (ended) return;
    const payload =
      typeof terminal === "string"
        ? { status: terminal }
        : {
            status: terminal.status,
            ...(terminal.outcome ? { outcome: terminal.outcome } : {}),
          };
    stream.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
    closeStream();
  }

  let lastSeq = 0;

  function sendEvent(evt: TEvent) {
    if (ended) return;
    if (evt.seq <= lastSeq) return;
    lastSeq = evt.seq;
    stream.write(
      `id: ${evt.seq}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`,
    );
    const terminalStatus = isTerminalEvent ? isTerminalEvent(evt) : null;
    if (terminalStatus) {
      finish(terminalStatus);
    }
  }

  try {
    const rawSeq = await redis.get(seqKey);
    if (request.raw.destroyed || ended) {
      closeStream();
      if (!reply.sent) {
        reply.hijack();
        reply.raw.destroy();
      }
      return;
    }
    const seq0 = rawSeq ? Number(rawSeq) : 0;
    lastSeq = seq0;

    const { snapshot, initialTerminalStatus } = await loadSnapshot(seq0);
    if (request.raw.destroyed || ended) {
      closeStream();
      if (!reply.sent) {
        reply.hijack();
        reply.raw.destroy();
      }
      return;
    }

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");

    reply.send(stream);

    stream.write("retry: 3000\n\n");

    stream.write(
      `id: ${seq0}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
    );

    const sortedBuffer = [...buffer].sort((a, b) => a.seq - b.seq);
    for (const evt of sortedBuffer) {
      if (evt.seq > seq0) {
        sendEvent(evt);
      }
    }
    lastSeq = Math.max(lastSeq, seq0);
    live = true;

    if (initialTerminalStatus) {
      finish(initialTerminalStatus);
    }

    if (!ended) {
      pingInterval = setInterval(async () => {
        if (ended) return;
        try {
          const current = await redis.get(seqKey);
          const seq = current ? Number(current) : lastSeq;
          stream.write(`event: ping\ndata: ${JSON.stringify({ seq })}\n\n`);
        } catch {
          // Ignore redis ping errors
        }
      }, pingIntervalMs);
    }
  } catch (err) {
    closeStream();
    throw err;
  }
}
