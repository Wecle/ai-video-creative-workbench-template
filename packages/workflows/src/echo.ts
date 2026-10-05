import { proxyActivities } from "@temporalio/workflow";
import type { AgentActivities, EchoInput, EchoResult } from "./activities";

// maximumAttempts must be explicit: Temporal retries without limit by default.
const { runEcho } = proxyActivities<AgentActivities>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "1s",
    backoffCoefficient: 2,
    maximumInterval: "10s",
    maximumAttempts: 3,
  },
});

export async function echoWorkflow(input: EchoInput): Promise<EchoResult> {
  return runEcho(input);
}
