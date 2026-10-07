export type ProviderJobStatus =
  "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface ProviderSubmitInput {
  jobId: string;
  capability: string;
  prompt: string;
  params?: Record<string, unknown>;
  webhookUrl?: string;
  mockMode?: "polling" | "callback";
}

export interface ProviderSubmitResult {
  externalId: string;
  status: "pending" | "succeeded";
  output?: Record<string, unknown>;
}

export interface ProviderPollResult {
  externalId: string;
  status: ProviderJobStatus;
  progress?: number;
  output?: Record<string, unknown>;
  error?: string;
}

export interface WebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface ParsedWebhookResult {
  externalId: string;
  status: ProviderJobStatus;
  output?: Record<string, unknown>;
  error?: string;
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export interface ProviderAdapter {
  readonly id: string;
  readonly supportedCapabilities: readonly string[];
  submit(input: ProviderSubmitInput): Promise<ProviderSubmitResult>;
  poll(externalId: string): Promise<ProviderPollResult>;
  parseWebhook(request: WebhookRequest): Promise<ParsedWebhookResult>;
  cancel(externalId: string): Promise<void>;
}
