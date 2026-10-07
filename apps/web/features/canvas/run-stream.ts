import {
  type CanvasRunStatus,
  type NodeStatusEvent,
  type RunDoneEvent,
  type RunSnapshotEvent,
  type RunStatusEvent,
  nodeStatusEventSchema,
  runSnapshotEventSchema,
  runStatusEventSchema,
} from "@creative/contracts";

export type EventSourceLike = Pick<
  EventSource,
  "addEventListener" | "removeEventListener" | "close" | "onerror"
>;

export type EventSourceFactory = {
  new (url: string): EventSourceLike;
};

export type RunStreamHandlers = {
  onSnapshot?: (snapshot: RunSnapshotEvent) => void;
  onNodeStatus?: (event: NodeStatusEvent) => void;
  onRunStatus?: (event: RunStatusEvent) => void;
  onDone?: (event: RunDoneEvent) => void;
  onFallback?: () => void;
};

export type RunStreamOptions = RunStreamHandlers & {
  runId: string;
  fetchTicket: (runId: string) => Promise<{ ticket: string; baseUrl: string }>;
  EventSourceClass?: EventSourceFactory;
  maxReconnectAttempts?: number;
};

export type RunStreamController = {
  close: () => void;
};

export function subscribeRunStream(
  options: RunStreamOptions,
): RunStreamController {
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 3;
  let activeEs: EventSourceLike | null = null;
  let closed = false;
  let lastSeq = -1;
  let reconnectAttempts = 0;

  async function connect() {
    if (closed) return;

    let ticketData: { ticket: string; baseUrl: string };
    try {
      ticketData = await options.fetchTicket(options.runId);
    } catch {
      if (closed) return;
      reconnectAttempts++;
      if (reconnectAttempts > maxReconnectAttempts) {
        close();
        options.onFallback?.();
        return;
      }
      void connect();
      return;
    }

    if (closed) return;

    const ES = options.EventSourceClass ?? globalThis.EventSource;
    if (!ES) {
      close();
      options.onFallback?.();
      return;
    }

    const url = `${ticketData.baseUrl}/api/v1/realtime/runs/${encodeURIComponent(options.runId)}/events?ticket=${encodeURIComponent(ticketData.ticket)}`;
    const es = new ES(url);
    activeEs = es;

    const handleSnapshot = (evt: MessageEvent) => {
      if (closed) return;
      try {
        const raw =
          typeof evt.data === "string" ? JSON.parse(evt.data) : evt.data;
        const parsed = runSnapshotEventSchema.safeParse(raw);
        if (parsed.success) {
          reconnectAttempts = 0;
          lastSeq = Math.max(lastSeq, parsed.data.seq);
          options.onSnapshot?.(parsed.data);
          if (
            parsed.data.status === "succeeded" ||
            parsed.data.status === "failed" ||
            parsed.data.status === "cancelled"
          ) {
            close();
          }
        }
      } catch {
        // Ignore JSON parse errors
      }
    };

    const handleNodeStatus = (evt: MessageEvent) => {
      if (closed) return;
      try {
        const raw =
          typeof evt.data === "string" ? JSON.parse(evt.data) : evt.data;
        const parsed = nodeStatusEventSchema.safeParse(raw);
        if (parsed.success) {
          if (parsed.data.seq <= lastSeq) return;
          reconnectAttempts = 0;
          lastSeq = parsed.data.seq;
          options.onNodeStatus?.(parsed.data);
        }
      } catch {
        // Ignore JSON parse errors
      }
    };

    const handleRunStatus = (evt: MessageEvent) => {
      if (closed) return;
      try {
        const raw =
          typeof evt.data === "string" ? JSON.parse(evt.data) : evt.data;
        const parsed = runStatusEventSchema.safeParse(raw);
        if (parsed.success) {
          if (parsed.data.seq <= lastSeq) return;
          reconnectAttempts = 0;
          lastSeq = parsed.data.seq;
          options.onRunStatus?.(parsed.data);
          if (
            parsed.data.status === "succeeded" ||
            parsed.data.status === "failed" ||
            parsed.data.status === "cancelled"
          ) {
            close();
          }
        }
      } catch {
        // Ignore JSON parse errors
      }
    };

    const handlePing = (evt: MessageEvent) => {
      if (closed) return;
      try {
        const raw =
          typeof evt.data === "string" ? JSON.parse(evt.data) : evt.data;
        if (typeof raw?.seq === "number" && raw.seq > lastSeq) {
          reconnect();
        }
      } catch {
        // Ignore JSON parse errors
      }
    };

    const handleDone = (evt: MessageEvent) => {
      if (closed) return;
      try {
        const raw =
          typeof evt.data === "string" ? JSON.parse(evt.data) : evt.data;
        const status = (raw?.status ?? "succeeded") as CanvasRunStatus;
        options.onDone?.({ type: "done", status });
        close();
      } catch {
        // Ignore JSON parse errors
      }
    };

    const handleError = () => {
      if (closed) return;
      reconnect();
    };

    function reconnect() {
      if (closed) return;
      if (activeEs) {
        activeEs.close();
        activeEs = null;
      }
      reconnectAttempts++;
      if (reconnectAttempts > maxReconnectAttempts) {
        close();
        options.onFallback?.();
        return;
      }
      void connect();
    }

    es.addEventListener("snapshot", handleSnapshot as EventListener);
    es.addEventListener("node.status", handleNodeStatus as EventListener);
    es.addEventListener("run.status", handleRunStatus as EventListener);
    es.addEventListener("ping", handlePing as EventListener);
    es.addEventListener("done", handleDone as EventListener);
    es.onerror = handleError;
  }

  function close() {
    if (closed) return;
    closed = true;
    if (activeEs) {
      activeEs.close();
      activeEs = null;
    }
  }

  void connect();

  return { close };
}
