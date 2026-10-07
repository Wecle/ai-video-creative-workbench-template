import { isStepCount, streamText, tool } from "ai";
import { z } from "zod";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { AgentMessage, ToolMeta } from "../loop/types";
import { fromModelToolName, toModelToolName } from "../tools/names";
import type { ToolRegistry } from "../tools/registry";
import { createDeltaBatcher } from "./delta-batcher";

export type NormalizedToolCall = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  invalid?: { message: string };
};

export type LlmStepResult = {
  text: string;
  toolCalls: NormalizedToolCall[];
  finishReason: string;
  usage: { totalTokens: number };
};

export type LlmStepEvents = {
  onStepStarted?: (event: {
    stepId: string;
    index: number;
    attempt: number;
  }) => Promise<void> | void;
  onTextDelta?: (event: {
    stepId: string;
    attempt: number;
    text: string;
  }) => Promise<void> | void;
  heartbeat?: () => void;
};

export type LlmStepInput = {
  runId: string;
  stepId: string;
  index: number;
  attempt?: number;
  system: string;
  messages: AgentMessage[];
  tools: ToolMeta[];
  model: LanguageModelV4;
  toolRegistry?: ToolRegistry;
  abortSignal?: AbortSignal;
  events?: LlmStepEvents;
};

export function toModelMessages(messages: AgentMessage[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      result.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        result.push({
          role: "assistant",
          content: [{ type: "text", text: msg.content }],
        });
      } else {
        result.push({
          role: "assistant",
          content: msg.content.map((part) => {
            if (part.type === "text") {
              return { type: "text", text: part.text };
            }
            return {
              type: "tool-call",
              toolCallId: part.toolCallId,
              toolName: toModelToolName(part.toolName),
              input: part.input,
            };
          }),
        });
      }
    } else if (msg.role === "tool") {
      result.push({
        role: "tool",
        content: msg.content.map((item) => ({
          type: "tool-result",
          toolCallId: item.toolCallId,
          toolName: toModelToolName(item.toolName),
          output: item.output,
        })),
      });
    }
  }

  return result;
}

export function wrapModelError(err: unknown): Error {
  if (err instanceof Error) {
    const errObj = err as unknown as Record<string, unknown>;
    const isRetryable = errObj.isRetryable;
    if (isRetryable === false) {
      const wrapped = new Error("Model request failed: " + err.message);
      const wrappedObj = wrapped as unknown as Record<string, unknown>;
      wrappedObj.type = "ModelRequestError";
      wrappedObj.isNonRetryable = true;
      return wrapped;
    }
    return err;
  }
  return new Error("Unknown error during model call: " + String(err));
}

export async function llmStep(input: LlmStepInput): Promise<LlmStepResult> {
  const {
    stepId,
    index,
    attempt = 1,
    system,
    messages,
    tools,
    model,
    toolRegistry,
    abortSignal,
    events,
  } = input;

  // 1. Notify step started
  await events?.onStepStarted?.({
    stepId,
    index,
    attempt,
  });
  events?.heartbeat?.();

  // 2. Prepare AI tools
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aiTools: Record<string, any> = {};
  for (const t of tools) {
    const modelName = toModelToolName(t.name);
    const descriptor = toolRegistry?.get(t.name);
    const schema = descriptor?.inputSchema ?? z.record(z.string(), z.unknown());
    aiTools[modelName] = tool({
      description: descriptor?.description ?? t.description ?? t.name,
      inputSchema: schema,
    });
  }

  // 3. Batcher for text deltas
  const batcher = createDeltaBatcher({
    minIntervalMs: 50,
    minChars: 64,
    onFlush: (deltaText) => {
      events?.onTextDelta?.({
        stepId,
        attempt,
        text: deltaText,
      });
      events?.heartbeat?.();
    },
  });

  let fullText = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rawToolCalls: any[] = [];
  let finishReason = "stop";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let totalUsage: any;

  try {
    const rawResult = streamText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: model as any,
      system,
      messages: toModelMessages(messages),
      tools: aiTools,
      stopWhen: isStepCount(1),
      maxRetries: 0,
      abortSignal,
    });

    for await (const part of rawResult.stream) {
      if (part.type === "text-delta") {
        fullText += part.text;
        batcher.append(part.text);
      } else if (part.type === "error") {
        throw part.error;
      }
    }
    batcher.flush();

    rawToolCalls = (await rawResult.toolCalls) ?? [];
    finishReason = (await rawResult.finishReason) ?? "stop";
    totalUsage = await rawResult.totalUsage;
  } catch (err) {
    batcher.flush();
    console.error("LLM step stream error:", err);
    throw wrapModelError(err);
  }

  // 4. Retrieve results
  const totalTokens =
    totalUsage?.totalTokens ?? Math.max(1, Math.ceil(fullText.length / 4));

  // 5. Normalize tool calls
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolCalls: NormalizedToolCall[] = rawToolCalls.map((call: any) => {
    const canonicalName = fromModelToolName(call.toolName, toolRegistry);
    const isInvalid = call.invalid === true;
    const errorMessage = isInvalid
      ? String(
          call.error?.message ?? call.error ?? "Invalid tool call arguments",
        )
      : undefined;

    return {
      toolCallId: call.toolCallId,
      toolName: canonicalName,
      input: (call.input ?? {}) as Record<string, unknown>,
      invalid: isInvalid ? { message: errorMessage! } : undefined,
    };
  });

  return {
    text: fullText,
    toolCalls,
    finishReason,
    usage: { totalTokens },
  };
}
