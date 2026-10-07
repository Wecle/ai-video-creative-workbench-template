import { describe, expect, it, vi } from "vitest";
import type {
  CanvasRunStatus,
  NodeRunStatus,
  NodeStatusEvent,
  RunSnapshotEvent,
  RunStatusEvent,
} from "@creative/contracts";
import { subscribeRunStream } from "./run-stream";
import { trackRun } from "./run-tracker";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  listeners: Record<string, EventListener[]> = {};
  onerror: ((evt: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: EventListener) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
    }
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    const list = [...(this.listeners[type] || [])];
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const listener of list) {
      listener(event);
    }
  }

  emitError() {
    this.onerror?.(new Event("error"));
  }
}

describe("run-stream", () => {
  const runId = "11111111-1111-4111-8111-111111111111";

  it("applies events in order: snapshot -> node.status -> run.status", async () => {
    FakeEventSource.instances = [];
    const snapshots: RunSnapshotEvent[] = [];
    const nodeEvents: NodeStatusEvent[] = [];
    const runEvents: RunStatusEvent[] = [];

    const fetchTicket = vi.fn().mockResolvedValue({
      ticket: "tok-1",
      baseUrl: "http://localhost:4000",
    });

    const sub = subscribeRunStream({
      runId,
      fetchTicket,
      EventSourceClass: FakeEventSource as unknown as typeof EventSource,
      onSnapshot: (s) => snapshots.push(s),
      onNodeStatus: (e) => nodeEvents.push(e),
      onRunStatus: (e) => runEvents.push(e),
    });

    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toContain("ticket=tok-1");

    // 1. Snapshot
    const snapshot: RunSnapshotEvent = {
      type: "snapshot",
      runId,
      seq: 2,
      status: "running",
      nodes: [
        { nodeId: "node-1", status: "running" },
        { nodeId: "node-2", status: "pending" },
      ],
    };
    es.emit("snapshot", snapshot);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.seq).toBe(2);

    // 2. Node status
    const nodeEvent: NodeStatusEvent = {
      type: "node.status",
      runId,
      seq: 3,
      nodeId: "node-1",
      status: "succeeded",
    };
    es.emit("node.status", nodeEvent);
    expect(nodeEvents).toHaveLength(1);
    expect(nodeEvents[0]?.seq).toBe(3);

    // 3. Run status
    const runEvent: RunStatusEvent = {
      type: "run.status",
      runId,
      seq: 4,
      status: "succeeded",
    };
    es.emit("run.status", runEvent);
    expect(runEvents).toHaveLength(1);
    expect(runEvents[0]?.seq).toBe(4);

    expect(es.closed).toBe(true);
    sub.close();
  });

  it("discards events with seq <= lastSeq", async () => {
    FakeEventSource.instances = [];
    const nodeEvents: NodeStatusEvent[] = [];
    const runEvents: RunStatusEvent[] = [];

    const fetchTicket = vi.fn().mockResolvedValue({
      ticket: "tok-1",
      baseUrl: "http://localhost:4000",
    });

    const sub = subscribeRunStream({
      runId,
      fetchTicket,
      EventSourceClass: FakeEventSource as unknown as typeof EventSource,
      onNodeStatus: (e) => nodeEvents.push(e),
      onRunStatus: (e) => runEvents.push(e),
    });

    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0]!;

    // Initial snapshot at seq 5
    es.emit("snapshot", {
      type: "snapshot",
      runId,
      seq: 5,
      status: "running",
      nodes: [],
    });

    // Event with seq 5 (<= lastSeq) should be dropped
    es.emit("node.status", {
      type: "node.status",
      runId,
      seq: 5,
      nodeId: "n1",
      status: "running",
    });
    expect(nodeEvents).toHaveLength(0);

    // Event with seq 4 (< lastSeq) should be dropped
    es.emit("node.status", {
      type: "node.status",
      runId,
      seq: 4,
      nodeId: "n1",
      status: "running",
    });
    expect(nodeEvents).toHaveLength(0);

    // Event with seq 6 (> lastSeq) is accepted
    es.emit("node.status", {
      type: "node.status",
      runId,
      seq: 6,
      nodeId: "n1",
      status: "running",
    });
    expect(nodeEvents).toHaveLength(1);

    // Run status with seq 6 (<= lastSeq) should be dropped
    es.emit("run.status", {
      type: "run.status",
      runId,
      seq: 6,
      status: "running",
    });
    expect(runEvents).toHaveLength(0);

    sub.close();
  });

  it("reconnects with a new ticket after onerror", async () => {
    FakeEventSource.instances = [];
    let ticketCount = 0;
    const fetchTicket = vi.fn().mockImplementation(async () => {
      ticketCount++;
      return {
        ticket: `tok-${ticketCount}`,
        baseUrl: "http://localhost:4000",
      };
    });

    const sub = subscribeRunStream({
      runId,
      fetchTicket,
      EventSourceClass: FakeEventSource as unknown as typeof EventSource,
    });

    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const firstEs = FakeEventSource.instances[0]!;
    expect(firstEs.url).toContain("ticket=tok-1");

    // Trigger error on first connection
    firstEs.emitError();
    expect(firstEs.closed).toBe(true);

    // Should create a second EventSource with new ticket
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
    const secondEs = FakeEventSource.instances[1]!;
    expect(secondEs.url).toContain("ticket=tok-2");

    sub.close();
    expect(secondEs.closed).toBe(true);
  });

  it("applies exponential backoff with cap on reconnect and resets on event", async () => {
    vi.useFakeTimers();
    try {
      FakeEventSource.instances = [];
      let ticketCount = 0;
      const fetchTicket = vi.fn().mockImplementation(async () => {
        ticketCount++;
        return {
          ticket: `tok-${ticketCount}`,
          baseUrl: "http://localhost:4000",
        };
      });

      const sub = subscribeRunStream({
        runId,
        fetchTicket,
        EventSourceClass: FakeEventSource as unknown as typeof EventSource,
        initialBackoffMs: 100,
        maxBackoffMs: 300,
        maxReconnectAttempts: 5,
      });

      // 1st connection
      await vi.advanceTimersByTimeAsync(0);
      expect(FakeEventSource.instances.length).toBe(1);

      // 1st error -> backoff is min(100 * 2^0, 300) = 100ms
      FakeEventSource.instances[0]!.emitError();
      await vi.advanceTimersByTimeAsync(50);
      expect(FakeEventSource.instances.length).toBe(1);
      await vi.advanceTimersByTimeAsync(60);
      expect(FakeEventSource.instances.length).toBe(2);

      // 2nd error -> backoff is min(100 * 2^1, 300) = 200ms
      FakeEventSource.instances[1]!.emitError();
      await vi.advanceTimersByTimeAsync(150);
      expect(FakeEventSource.instances.length).toBe(2);
      await vi.advanceTimersByTimeAsync(60);
      expect(FakeEventSource.instances.length).toBe(3);

      // Receiving valid event resets backoff
      FakeEventSource.instances[2]!.emit("node.status", {
        type: "node.status",
        runId,
        seq: 1,
        nodeId: "n1",
        status: "running",
      });

      // Next error should start from initial backoff again (100ms)
      FakeEventSource.instances[2]!.emitError();
      await vi.advanceTimersByTimeAsync(50);
      expect(FakeEventSource.instances.length).toBe(3);
      await vi.advanceTimersByTimeAsync(60);
      expect(FakeEventSource.instances.length).toBe(4);

      sub.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to polling after 3 reconnect failures", async () => {
    FakeEventSource.instances = [];
    let ticketCount = 0;
    const fetchTicket = vi.fn().mockImplementation(async () => {
      ticketCount++;
      return {
        ticket: `tok-${ticketCount}`,
        baseUrl: "http://localhost:4000",
      };
    });
    const onFallback = vi.fn();

    const sub = subscribeRunStream({
      runId,
      fetchTicket,
      EventSourceClass: FakeEventSource as unknown as typeof EventSource,
      maxReconnectAttempts: 3,
      onFallback,
    });

    // 1st connection
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    FakeEventSource.instances[0]!.emitError();

    // 2nd connection (1st retry)
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
    FakeEventSource.instances[1]!.emitError();

    // 3rd connection (2nd retry)
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(3));
    FakeEventSource.instances[2]!.emitError();

    // 4th connection (3rd retry)
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(4));
    FakeEventSource.instances[3]!.emitError();

    // Now exceeded maxReconnectAttempts -> triggers onFallback
    await vi.waitFor(() => expect(onFallback).toHaveBeenCalledTimes(1));
    sub.close();
  });

  it("reconnects when ping.seq > lastSeq to recover missed events", async () => {
    FakeEventSource.instances = [];
    let ticketCount = 0;
    const fetchTicket = vi.fn().mockImplementation(async () => {
      ticketCount++;
      return {
        ticket: `tok-${ticketCount}`,
        baseUrl: "http://localhost:4000",
      };
    });

    const sub = subscribeRunStream({
      runId,
      fetchTicket,
      EventSourceClass: FakeEventSource as unknown as typeof EventSource,
    });

    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const firstEs = FakeEventSource.instances[0]!;

    // Initial snapshot at seq 3
    firstEs.emit("snapshot", {
      type: "snapshot",
      runId,
      seq: 3,
      status: "running",
      nodes: [],
    });

    // Ping with seq 3 (not greater than lastSeq) -> no reconnect
    firstEs.emit("ping", { seq: 3 });
    expect(FakeEventSource.instances.length).toBe(1);

    // Ping with seq 5 (> lastSeq 3) -> missed messages, trigger reconnect!
    firstEs.emit("ping", { seq: 5 });
    expect(firstEs.closed).toBe(true);

    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
    const secondEs = FakeEventSource.instances[1]!;
    expect(secondEs.url).toContain("ticket=tok-2");

    sub.close();
  });

  it("closes cleanly on done event and on unmount", async () => {
    FakeEventSource.instances = [];
    const fetchTicket = vi.fn().mockResolvedValue({
      ticket: "tok-1",
      baseUrl: "http://localhost:4000",
    });
    const onDone = vi.fn();

    const sub = subscribeRunStream({
      runId,
      fetchTicket,
      EventSourceClass: FakeEventSource as unknown as typeof EventSource,
      onDone,
    });

    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0]!;

    es.emit("done", { status: "succeeded" });
    expect(onDone).toHaveBeenCalledWith({
      type: "done",
      status: "succeeded",
    });
    expect(es.closed).toBe(true);

    sub.close();
  });
});

describe("run-tracker", () => {
  const projectId = "p-1";
  const canvasId = "c-1";
  const runId = "11111111-1111-4111-8111-111111111111";

  it("integrates stream updates with toNodeRuntime mapping", async () => {
    FakeEventSource.instances = [];
    const setCanvasRuntime = vi.fn();
    const updateNodeRuntime = vi.fn();
    const onComplete = vi.fn();

    const api = {
      createRealtimeTicket: vi.fn().mockResolvedValue({
        ticket: "tok-1",
        baseUrl: "http://localhost:4000",
      }),
      getCanvasRun: vi.fn(),
    };

    const tracker = trackRun({
      projectId,
      canvasId,
      runId,
      api,
      setCanvasRuntime,
      updateNodeRuntime,
      onComplete,
      EventSourceClass: FakeEventSource as unknown as typeof EventSource,
    });

    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0]!;

    // Snapshot event
    es.emit("snapshot", {
      type: "snapshot",
      runId,
      seq: 1,
      status: "running",
      nodes: [
        { nodeId: "n1", status: "pending" as NodeRunStatus },
        { nodeId: "n2", status: "running" as NodeRunStatus },
      ],
    });

    // pending is mapped to queued via toNodeRuntime
    expect(setCanvasRuntime).toHaveBeenCalledWith({
      n1: { status: "queued", error: undefined },
      n2: { status: "running", error: undefined },
    });

    // Node status event
    es.emit("node.status", {
      type: "node.status",
      runId,
      seq: 2,
      nodeId: "n1",
      status: "running" as NodeRunStatus,
    });
    expect(updateNodeRuntime).toHaveBeenCalledWith("n1", {
      status: "running",
      error: undefined,
    });

    // Terminal run status
    es.emit("run.status", {
      type: "run.status",
      runId,
      seq: 3,
      status: "succeeded" as CanvasRunStatus,
    });
    expect(onComplete).toHaveBeenCalledWith("succeeded");

    tracker.stop();
  });

  it("falls back to polling when SSE fails and completes via polling", async () => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    const setCanvasRuntime = vi.fn();
    const onComplete = vi.fn();

    const api = {
      // Ticket generation fails immediately
      createRealtimeTicket: vi
        .fn()
        .mockRejectedValue(new Error("Ticket service down")),
      getCanvasRun: vi
        .fn()
        .mockResolvedValueOnce({
          run: {
            status: "running" as CanvasRunStatus,
            nodeRuns: [
              { nodeId: "n1", status: "running" as NodeRunStatus, error: null },
            ],
          },
        })
        .mockResolvedValueOnce({
          run: {
            status: "succeeded" as CanvasRunStatus,
            nodeRuns: [
              {
                nodeId: "n1",
                status: "succeeded" as NodeRunStatus,
                error: null,
              },
            ],
          },
        }),
    };

    const tracker = trackRun({
      projectId,
      canvasId,
      runId,
      api,
      setCanvasRuntime,
      onComplete,
      EventSourceClass: FakeEventSource as unknown as typeof EventSource,
      pollingInitialDelayMs: 100,
      initialBackoffMs: 0,
    });

    // Flush promises so fetchTicket rejection is processed and onFallback triggers
    await vi.advanceTimersByTimeAsync(10);
    expect(tracker.getMode()).toBe("polling");

    // Advance for 1st poll (delay: 100ms)
    await vi.advanceTimersByTimeAsync(100);
    expect(api.getCanvasRun).toHaveBeenCalledTimes(1);
    expect(setCanvasRuntime).toHaveBeenCalledWith({
      n1: { status: "running", error: undefined },
    });

    // Advance for 2nd poll (delay: 100 + 500 = 600ms)
    await vi.advanceTimersByTimeAsync(600);
    expect(api.getCanvasRun).toHaveBeenCalledTimes(2);
    expect(setCanvasRuntime).toHaveBeenCalledWith({
      n1: { status: "succeeded", error: undefined },
    });
    expect(onComplete).toHaveBeenCalledWith("succeeded");

    tracker.stop();
    vi.useRealTimers();
  });
});
