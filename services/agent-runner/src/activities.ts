import { ApplicationFailure } from "@temporalio/activity";
import {
  EchoAgentAdapter,
  type AgentAdapter,
  type AgentRun,
} from "@creative/agent-core";
import type { AgentActivities } from "@creative/workflows/activities";

/**
 * Activity implementations: the place for IO (database, Redis, providers) as the template grows.
 * The prompt is never logged.
 */
export function createActivities({
  adapter = new EchoAgentAdapter(),
}: { adapter?: AgentAdapter } = {}): AgentActivities {
  return {
    async runEcho(input) {
      const run: AgentRun = {
        id: input.runId,
        status: "running",
        projectId: input.projectId,
        canvasId: input.canvasId,
        createdAt: new Date().toISOString(),
      };
      try {
        const { message } = await adapter.run({ run, prompt: input.prompt });
        return { message };
      } catch (error) {
        // Keep internals out of workflow history and the Temporal UI; log them here instead.
        // Non-retryable for the deterministic echo adapter; decide per error class once real
        // adapters (LLM, providers) can fail transiently.
        console.error("Agent adapter failed", { runId: input.runId, error });
        throw ApplicationFailure.create({
          message: "Agent adapter failed",
          type: "AgentAdapterError",
          nonRetryable: true,
        });
      }
    },
  };
}
