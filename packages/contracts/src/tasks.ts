export type MediaTaskRequest = {
  taskId: string;
  kind: "image" | "video" | "audio" | "analysis";
  model?: { provider: string; modelId: string };
  inputs: { prompt?: string; parameters: Record<string, unknown> };
};

export type MediaTaskResult = {
  taskId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  outputs?: Array<{ objectKey: string; mediaType: string }>;
  error?: { code: string; message: string; retryable: boolean };
};
