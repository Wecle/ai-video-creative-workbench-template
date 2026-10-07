import type { AgentMessage } from "./types";

export function createUserMessage(content: string): AgentMessage {
  return { role: "user", content };
}

export function createAssistantTextMessage(text: string): AgentMessage {
  return { role: "assistant", content: text };
}

export function createAssistantToolCallsMessage(
  text: string,
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
  }>,
): AgentMessage {
  const parts: Array<
    | { type: "text"; text: string }
    | {
        type: "tool-call";
        toolCallId: string;
        toolName: string;
        input: Record<string, unknown>;
      }
  > = [];
  if (text.length > 0) {
    parts.push({ type: "text", text });
  }
  for (const call of toolCalls) {
    parts.push({
      type: "tool-call",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
    });
  }
  return { role: "assistant", content: parts };
}

export function createToolResultMessage(
  toolCallId: string,
  toolName: string,
  output:
    | { type: "text"; value: string }
    | { type: "json"; value: unknown }
    | { type: "error-text"; value: string },
): AgentMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName,
        output,
      },
    ],
  };
}
