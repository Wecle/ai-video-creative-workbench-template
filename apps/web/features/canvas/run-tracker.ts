import {
  type CanvasRunStatus,
  type CanvasRuntime,
  type NodeRunStatus,
  type NodeRuntimeStatus,
  toNodeRuntime,
} from "@creative/contracts";
import {
  subscribeRunStream,
  type EventSourceFactory,
  type RunStreamController,
} from "./run-stream";

export type RunTrackerApi = {
  createRealtimeTicket: (
    runId: string,
  ) => Promise<{ ticket: string; baseUrl: string }>;
  getCanvasRun: (
    projectId: string,
    canvasId: string,
    runId: string,
  ) => Promise<{
    run: {
      status: CanvasRunStatus;
      nodeRuns: Array<{
        nodeId: string;
        status: NodeRunStatus;
        error?: string | null;
      }>;
    };
  }>;
};

export type TrackRunOptions = {
  projectId: string;
  canvasId: string;
  runId: string;
  api: RunTrackerApi;
  setCanvasRuntime: (runtime: CanvasRuntime) => void;
  updateNodeRuntime?: (
    nodeId: string,
    runtime: { status: NodeRuntimeStatus; error?: string },
  ) => void;
  onComplete?: (status: CanvasRunStatus) => void;
  onError?: (error: unknown) => void;
  EventSourceClass?: EventSourceFactory;
  pollingInitialDelayMs?: number;
  maxReconnectAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
};

export type RunTracker = {
  stop: () => void;
  getMode: () => "stream" | "polling";
};

export function trackRun(options: TrackRunOptions): RunTracker {
  let stopped = false;
  let mode: "stream" | "polling" = "stream";
  let streamController: RunStreamController | null = null;
  let pollingTimer: ReturnType<typeof setTimeout> | null = null;
  let pollingDelay = options.pollingInitialDelayMs ?? 1000;

  function stop() {
    if (stopped) return;
    stopped = true;
    if (pollingTimer) {
      clearTimeout(pollingTimer);
      pollingTimer = null;
    }
    if (streamController) {
      streamController.close();
      streamController = null;
    }
  }

  function startPolling() {
    if (stopped) return;
    mode = "polling";
    if (streamController) {
      streamController.close();
      streamController = null;
    }

    const poll = async () => {
      if (stopped) return;
      try {
        const res = await options.api.getCanvasRun(
          options.projectId,
          options.canvasId,
          options.runId,
        );
        const currentRun = res.run;
        const newRuntime: CanvasRuntime = {};
        for (const nr of currentRun.nodeRuns) {
          newRuntime[nr.nodeId] = {
            status: toNodeRuntime(nr.status),
            error: nr.error ?? undefined,
          };
        }
        options.setCanvasRuntime(newRuntime);

        if (
          currentRun.status === "succeeded" ||
          currentRun.status === "failed" ||
          currentRun.status === "cancelled"
        ) {
          stop();
          options.onComplete?.(currentRun.status);
          return;
        }

        pollingDelay = Math.min(pollingDelay + 500, 3000);
        pollingTimer = setTimeout(poll, pollingDelay);
      } catch (err) {
        options.onError?.(err);
        stop();
      }
    };

    pollingTimer = setTimeout(poll, pollingDelay);
  }

  streamController = subscribeRunStream({
    runId: options.runId,
    fetchTicket: options.api.createRealtimeTicket,
    EventSourceClass: options.EventSourceClass,
    maxReconnectAttempts: options.maxReconnectAttempts,
    initialBackoffMs: options.initialBackoffMs,
    maxBackoffMs: options.maxBackoffMs,
    onSnapshot: (snapshot) => {
      const newRuntime: CanvasRuntime = {};
      for (const nr of snapshot.nodes) {
        newRuntime[nr.nodeId] = {
          status: toNodeRuntime(nr.status),
          error: nr.error ?? undefined,
        };
      }
      options.setCanvasRuntime(newRuntime);
      if (
        snapshot.status === "succeeded" ||
        snapshot.status === "failed" ||
        snapshot.status === "cancelled"
      ) {
        stop();
        options.onComplete?.(snapshot.status);
      }
    },
    onNodeStatus: (event) => {
      if (options.updateNodeRuntime) {
        options.updateNodeRuntime(event.nodeId, {
          status: toNodeRuntime(event.status),
          error: event.error ?? undefined,
        });
      }
    },
    onRunStatus: (event) => {
      if (
        event.status === "succeeded" ||
        event.status === "failed" ||
        event.status === "cancelled"
      ) {
        stop();
        options.onComplete?.(event.status);
      }
    },
    onDone: (event) => {
      stop();
      options.onComplete?.(event.status);
    },
    onFallback: () => {
      startPolling();
    },
  });

  return {
    stop,
    getMode: () => mode,
  };
}
