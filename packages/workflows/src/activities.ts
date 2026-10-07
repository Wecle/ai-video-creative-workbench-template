/** Types only: the contract between the workflow (here) and the activities (services/agent-runner). */

export type EchoInput = {
  runId: string;
  /** Taken from the authenticated identity by the starter, never from the request body. */
  userId: string;
  prompt: string;
  /** Opaque pass-through. No authorization decision may depend on these until P1 adds resource authz. */
  projectId?: string;
  canvasId?: string;
};

export type EchoResult = { message: string };

export interface AgentActivities {
  runEcho(input: EchoInput): Promise<EchoResult>;
}

import type { CanvasSnapshot } from "@creative/contracts";

export type RunGraphData = {
  runId: string;
  canvasId: string;
  projectId: string;
  canvasVersion: number;
  snapshot: CanvasSnapshot;
  mockMode?: "polling" | "callback";
  region?: string;
};

export type ExecuteNodeInput = {
  runId: string;
  nodeId: string;
  nodeType: string;
  version: number;
  config: Record<string, unknown>;
  inputs: Record<string, unknown>;
  mockMode?: "polling" | "callback";
  region?: string;
};

export type ExecuteNodeResult =
  | {
      status: "succeeded";
      outputs: Record<string, unknown>;
      provider?: string;
      externalJobId?: string;
    }
  | {
      status: "pending";
      provider: string;
      externalJobId: string;
      mode: "callback" | "polling";
    }
  | {
      status: "failed";
      error: string;
      provider?: string;
      externalJobId?: string;
    };

export type PollJobInput = {
  provider: string;
  externalJobId: string;
};

export type PollJobResult =
  | { status: "succeeded"; outputs: Record<string, unknown> }
  | { status: "running" }
  | { status: "failed"; error: string };

export type RecordNodeRunStartedInput = {
  runId: string;
  nodeId: string;
  nodeType: string;
  inputs?: Record<string, unknown>;
};

export type RecordNodeRunCompletedInput = {
  runId: string;
  nodeId: string;
  status: "succeeded" | "failed";
  outputs?: Record<string, unknown>;
  error?: string;
  provider?: string;
  externalJobId?: string;
};

export type UpdateRunStatusInput = {
  runId: string;
  status: "running" | "succeeded" | "failed";
  error?: string;
};

export type ProviderCallbackPayload = {
  provider: string;
  externalJobId: string;
  status: "succeeded" | "failed";
  output?: Record<string, unknown>;
  error?: string;
};

export interface OrchestratorActivities {
  loadRunGraph(runId: string): Promise<RunGraphData>;
  recordNodeRunStarted(input: RecordNodeRunStartedInput): Promise<void>;
  executeNode(input: ExecuteNodeInput): Promise<ExecuteNodeResult>;
  pollJob(input: PollJobInput): Promise<PollJobResult>;
  recordNodeRunCompleted(input: RecordNodeRunCompletedInput): Promise<void>;
  updateRunStatus(input: UpdateRunStatusInput): Promise<void>;
}
