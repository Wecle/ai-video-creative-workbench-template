import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createScriptedMockModel } from "./mock-model";

export interface ModelResolver {
  resolve(options: {
    provider: string;
    modelId: string;
    region?: string;
  }): LanguageModelV4;
}

export function createModelResolver(options?: {
  mockChunkDelayMs?: number;
}): ModelResolver {
  const mockModel = createScriptedMockModel({
    chunkDelayMs: options?.mockChunkDelayMs ?? 0,
  });

  return {
    resolve({ provider, modelId }) {
      if (provider === "mock") {
        return mockModel;
      }
      const err = new Error(
        `Unsupported model provider '${provider}' (modelId '${modelId}'). Only 'mock' is available in this template.`,
      );
      const errObj = err as unknown as Record<string, unknown>;
      errObj.isNonRetryable = true;
      errObj.type = "ModelRequestError";
      throw err;
    },
  };
}
