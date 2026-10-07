import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";

export type ScriptedMockModelOptions = {
  chunkDelayMs?: number;
  chunkMode?: "words" | "single" | "multi50";
  onCall?: (callInfo: { prompt: unknown; tools: unknown }) => void;
};

function extractPromptDetails(prompt: LanguageModelV4CallOptions["prompt"]) {
  let userText = "";
  let fullPromptString = "";
  const toolResults: Array<{ toolName?: string; output: unknown }> = [];

  for (const msg of prompt) {
    if (msg.role === "user") {
      for (const part of msg.content) {
        if (part.type === "text") {
          userText += part.text + " ";
          fullPromptString += part.text + " ";
        }
      }
    } else if (msg.role === "system") {
      fullPromptString += msg.content + " ";
    } else if (msg.role === "tool") {
      for (const part of msg.content) {
        if (part.type === "tool-result") {
          toolResults.push({
            toolName: part.toolName,
            output: part.output,
          });
          fullPromptString += JSON.stringify(part.output) + " ";
        }
      }
    } else if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") {
          fullPromptString += part.text + " ";
        } else if (part.type === "tool-call") {
          fullPromptString +=
            part.toolName +
            " " +
            (typeof part.input === "string"
              ? part.input
              : JSON.stringify(part.input)) +
            " ";
        }
      }
    }
  }

  return {
    userText: userText.trim(),
    fullPromptString,
    toolResults,
  };
}

function findSmallestMissingK(promptText: string): number {
  const matches = promptText.matchAll(/agent-note-(\d+)/g);
  const existingK = new Set<number>();
  for (const m of matches) {
    const val = Number.parseInt(m[1]!, 10);
    if (!Number.isNaN(val) && val > 0) {
      existingK.add(val);
    }
  }
  let k = 1;
  while (existingK.has(k)) {
    k++;
  }
  return k;
}

export function createScriptedMockModel(
  options: ScriptedMockModelOptions = {},
): LanguageModelV4 {
  const { chunkDelayMs = 0, chunkMode = "words", onCall } = options;

  async function resolveStream(
    callOptions: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4StreamResult> {
    onCall?.({ prompt: callOptions.prompt, tools: callOptions.tools });

    const { userText, fullPromptString, toolResults } = extractPromptDetails(
      callOptions.prompt,
    );
    const n = toolResults.length;
    const tools = callOptions.tools ?? [];

    const hasSkillTool = tools.some(
      (t) => t.type === "function" && t.name === "skill_load",
    );
    const hasPatchTool = tools.some(
      (t) => t.type === "function" && t.name === "canvas_applyPatch",
    );

    let textOut = "";
    let toolCallOut:
      { toolCallId: string; toolName: string; input: string } | undefined;
    let finishReason: "stop" | "tool-calls" = "stop";

    if (n === 0) {
      const mentionsSkill = /\bskill\b/i.test(userText);
      if (mentionsSkill && hasSkillTool) {
        textOut = "I'll load the shot-list skill first.";
        toolCallOut = {
          toolCallId: "call_skill_1",
          toolName: "skill_load",
          input: JSON.stringify({ name: "shot-list" }),
        };
        finishReason = "tool-calls";
      } else if (hasPatchTool) {
        const k = findSmallestMissingK(fullPromptString);
        textOut = "I'll add a note node to your canvas.";
        toolCallOut = {
          toolCallId: "call_patch_1",
          toolName: "canvas_applyPatch",
          input: JSON.stringify({
            summary: "Add creative note node",
            ops: [
              {
                op: "addNode",
                id: `agent-note-${k}`,
                type: "text",
                position: { x: 100, y: 100 },
                title: "Creative Note",
                config: { text: "Generated note" },
              },
            ],
          }),
        };
        finishReason = "tool-calls";
      } else {
        textOut = "I have no tools available in this mode.";
        finishReason = "stop";
      }
    } else if (n === 1 && toolResults[0]?.toolName === "skill_load") {
      const k = findSmallestMissingK(fullPromptString);
      textOut = "Now I'll add a note node to your canvas.";
      toolCallOut = {
        toolCallId: "call_patch_2",
        toolName: "canvas_applyPatch",
        input: JSON.stringify({
          summary: "Add creative note node from shot list",
          ops: [
            {
              op: "addNode",
              id: `agent-note-${k}`,
              type: "text",
              position: { x: 100, y: 100 },
              title: "Shot List Note",
              config: { text: "Generated from skill" },
            },
          ],
        }),
      };
      finishReason = "tool-calls";
    } else {
      const last = toolResults[toolResults.length - 1];
      const lastStr = JSON.stringify(last?.output ?? "");
      const isDenied =
        /reject|error|denied/i.test(lastStr) ||
        (typeof last?.output === "object" &&
          last?.output !== null &&
          "ok" in (last.output as Record<string, unknown>) &&
          (last.output as Record<string, unknown>).ok === false);

      if (isDenied) {
        textOut = "Understood. I did not change the canvas.";
      } else {
        textOut = "Done. The note node was added.";
      }
      finishReason = "stop";
    }

    const inputTokens = Math.max(1, Math.ceil(fullPromptString.length / 4));
    const outputTokens = Math.max(1, Math.ceil(textOut.length / 4));

    // Build parts
    const parts: LanguageModelV4StreamPart[] = [
      { type: "stream-start", warnings: [] },
    ];

    if (chunkMode === "single") {
      parts.push({ type: "text-start", id: "t0" });
      parts.push({ type: "text-delta", id: "t0", delta: textOut });
      parts.push({ type: "text-end", id: "t0" });
    } else if (chunkMode === "multi50") {
      parts.push({ type: "text-start", id: "t0" });
      let combined = "";
      for (let i = 0; i < 50; i++) {
        const chunk = `[chunk-${String(i).padStart(2, "0")}: This is chunk content with enough characters to pass 64] `;
        combined += chunk;
        parts.push({ type: "text-delta", id: "t0", delta: chunk });
      }
      textOut = combined;
      parts.push({ type: "text-end", id: "t0" });
    } else {
      // Split text into words to simulate streaming chunks
      const words = textOut.split(/(\s+)/);
      parts.push({ type: "text-start", id: "t0" });
      for (const w of words) {
        if (w.length > 0) {
          parts.push({ type: "text-delta", id: "t0", delta: w });
        }
      }
      parts.push({ type: "text-end", id: "t0" });
    }

    if (toolCallOut) {
      parts.push({
        type: "tool-call",
        toolCallId: toolCallOut.toolCallId,
        toolName: toolCallOut.toolName,
        input: toolCallOut.input,
      });
    }

    parts.push({
      type: "finish",
      usage: {
        inputTokens: {
          total: inputTokens,
          noCache: inputTokens,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: outputTokens,
          text: outputTokens,
          reasoning: 0,
        },
      },
      finishReason: {
        unified: finishReason,
        raw: finishReason,
      },
    });

    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        for (const part of parts) {
          if (part.type === "text-delta" && chunkDelayMs > 0) {
            await new Promise((r) => setTimeout(r, chunkDelayMs));
          }
          controller.enqueue(part);
        }
        controller.close();
      },
    });

    return { stream };
  }

  return {
    specificationVersion: "v4",
    provider: "mock",
    modelId: "scripted-1",
    supportedUrls: {},
    async doGenerate(callOptions): Promise<LanguageModelV4GenerateResult> {
      const { stream } = await resolveStream(callOptions);
      const reader = stream.getReader();
      let text = "";
      const toolCalls: Array<{
        type: "tool-call";
        toolCallId: string;
        toolName: string;
        input: string;
      }> = [];
      let finishReason: "stop" | "tool-calls" = "stop";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === "text-delta") {
          text += value.delta;
        } else if (value.type === "tool-call") {
          toolCalls.push(value);
        } else if (value.type === "finish") {
          finishReason = value.finishReason.unified as "stop" | "tool-calls";
        }
      }

      const inputTokens = Math.max(1, Math.ceil(text.length / 4));
      const outputTokens = Math.max(1, Math.ceil(text.length / 4));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const content: any[] = [];
      if (text.length > 0) {
        content.push({ type: "text", text });
      }
      for (const tc of toolCalls) {
        content.push(tc);
      }

      return {
        content,
        finishReason: { unified: finishReason, raw: finishReason },
        usage: {
          inputTokens: {
            total: inputTokens,
            noCache: inputTokens,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: {
            total: outputTokens,
            text: outputTokens,
            reasoning: 0,
          },
        },
        warnings: [],
      };
    },
    async doStream(callOptions): Promise<LanguageModelV4StreamResult> {
      return resolveStream(callOptions);
    },
  };
}
