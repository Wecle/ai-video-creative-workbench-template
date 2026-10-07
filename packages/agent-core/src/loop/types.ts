export type AgentMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content:
        | string
        | Array<
            | { type: "text"; text: string }
            | {
                type: "tool-call";
                toolCallId: string;
                toolName: string;
                input: Record<string, unknown>;
              }
          >;
    }
  | {
      role: "tool";
      content: Array<{
        type: "tool-result";
        toolCallId: string;
        toolName: string;
        output:
          | { type: "text"; value: string }
          | { type: "json"; value: unknown }
          | { type: "error-text"; value: string };
      }>;
    };

export type ToolMeta = {
  name: string;
  modelName: string;
  risk: import("../policy/risk").Risk;
  description?: string;
};

export type ToolOutcome =
  | { ok: true; summary: string; patch?: unknown }
  | { ok: false; summary: string; code?: string };
