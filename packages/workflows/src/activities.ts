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
