export type AgentStatus =
  "created" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export type AgentRun = {
  id: string;
  status: AgentStatus;
  projectId?: string;
  canvasId?: string;
  createdAt: string;
};
export type AgentEvent = {
  type: string;
  runId: string;
  occurredAt: string;
  payload?: Record<string, unknown>;
};
export type ToolDefinition = {
  name: string;
  description: string;
  risk: "read" | "write" | "expensive" | "destructive";
};
export type SkillDefinition = {
  name: string;
  description: string;
  version: string;
  allowedTools: string[];
};

export interface AgentAdapter {
  run(input: {
    run: AgentRun;
    prompt: string;
  }): Promise<{ message: string; events: AgentEvent[] }>;
}

export class EchoAgentAdapter implements AgentAdapter {
  async run(input: { run: AgentRun; prompt: string }) {
    return {
      message: `Template Agent received: ${input.prompt}`,
      events: [
        {
          type: "agent.run.completed",
          runId: input.run.id,
          occurredAt: new Date().toISOString(),
        },
      ],
    };
  }
}

export * from "./pure";
export * from "./profiles";
export * from "./tools";
export * from "./skills";
