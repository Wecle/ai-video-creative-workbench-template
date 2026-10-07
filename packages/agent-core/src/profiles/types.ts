import type { Risk } from "../policy/risk";

export type AgentStarter = {
  id: string;
  label: string;
  prompt: string;
};

export type AgentProfile = {
  id: string;
  version: number;
  name: string;
  description: string;
  persona: string;
  systemPrompt: string;
  tools: string[];
  skills: string[];
  defaultModel: {
    provider: string;
    modelId: string;
  };
  approval: {
    threshold: Risk;
    timeoutSeconds: number;
  };
  budget: {
    maxSteps: number;
    maxEstimatedCredits: number;
    creditsPerKiloToken: number;
  };
  starters: AgentStarter[];
};
