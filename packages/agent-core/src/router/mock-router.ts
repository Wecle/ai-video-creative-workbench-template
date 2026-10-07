import type { IntentRouter, RouteDecision } from "./types";

export function createMockRouter(): IntentRouter {
  return {
    async route(): Promise<RouteDecision> {
      return {
        candidateSkills: [],
        targetNodeIds: [],
        confidence: 0,
      };
    },
  };
}
