import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  WebhookVerificationError,
  type ParsedWebhookResult,
  type ProviderAdapter,
  type ProviderJobStatus,
  type ProviderPollResult,
  type ProviderSubmitInput,
  type ProviderSubmitResult,
  type WebhookRequest,
} from "./types";

export const DEFAULT_MOCK_PROVIDER_SECRET =
  "mock-provider-webhook-secret-key-32chars";

interface MockJob {
  externalId: string;
  capability: string;
  prompt: string;
  params: Record<string, unknown>;
  mode: "polling" | "callback";
  status: ProviderJobStatus;
  output?: Record<string, unknown>;
  error?: string;
  createdAt: number;
}

export class MockProvider implements ProviderAdapter {
  readonly id = "mock";
  readonly supportedCapabilities = ["image.generate", "text.generate"] as const;

  private jobs = new Map<string, MockJob>();
  private secret: string;

  constructor(
    secret = process.env.MOCK_PROVIDER_WEBHOOK_SECRET ||
      DEFAULT_MOCK_PROVIDER_SECRET,
  ) {
    this.secret = secret;
  }

  async submit(input: ProviderSubmitInput): Promise<ProviderSubmitResult> {
    const externalId = `mock-${randomUUID()}`;
    const mode = input.mockMode ?? "polling";

    const hash = createHash("sha256").update(input.prompt).digest("hex");
    const aspectRatio = String(input.params?.aspectRatio ?? "1:1");
    let width = 1024;
    let height = 1024;
    if (aspectRatio === "16:9") {
      width = 1024;
      height = 576;
    } else if (aspectRatio === "9:16") {
      width = 576;
      height = 1024;
    }

    const shouldFail = input.prompt.includes("mock-fail");
    const output = shouldFail
      ? undefined
      : {
          image: {
            url: `https://mock.provider.test/images/${hash.slice(0, 16)}.png`,
            width,
            height,
            aspectRatio,
            prompt: input.prompt,
          },
        };
    const error = shouldFail ? "PROVIDER_SIMULATED_FAILURE" : undefined;

    const job: MockJob = {
      externalId,
      capability: input.capability,
      prompt: input.prompt,
      params: input.params ?? {},
      mode,
      status: "pending",
      output,
      error,
      createdAt: Date.now(),
    };

    this.jobs.set(externalId, job);

    return {
      externalId,
      status: "pending",
    };
  }

  async poll(externalId: string): Promise<ProviderPollResult> {
    const job = this.jobs.get(externalId);
    if (!job) {
      return {
        externalId,
        status: "failed",
        error: "JOB_NOT_FOUND",
      };
    }

    if (job.status === "cancelled") {
      return { externalId, status: "cancelled" };
    }

    if (job.mode === "callback") {
      // In callback mode, poll stays running until webhook arrives.
      return {
        externalId,
        status: job.status === "pending" ? "running" : job.status,
        output: job.output,
        error: job.error,
      };
    }

    // In polling mode:
    if (job.error) {
      job.status = "failed";
      return {
        externalId,
        status: "failed",
        error: job.error,
      };
    }

    job.status = "succeeded";
    return {
      externalId,
      status: "succeeded",
      output: job.output,
    };
  }

  async parseWebhook(request: WebhookRequest): Promise<ParsedWebhookResult> {
    const rawHeader = (headerName: string): string | undefined => {
      const val = request.headers[headerName.toLowerCase()];
      if (Array.isArray(val)) return val[0];
      return val;
    };

    const signatureHeader = rawHeader("x-mock-signature");
    const timestampHeader = rawHeader("x-mock-timestamp");

    if (!signatureHeader || !timestampHeader) {
      throw new WebhookVerificationError("MISSING_SIGNATURE_OR_TIMESTAMP");
    }

    const timestampNum = Number(timestampHeader);
    if (Number.isNaN(timestampNum)) {
      throw new WebhookVerificationError("INVALID_TIMESTAMP");
    }

    // Max 5 minutes age or clock drift
    const now = Date.now();
    if (Math.abs(now - timestampNum) > 300_000) {
      throw new WebhookVerificationError("EXPIRED_TIMESTAMP");
    }

    // Expected signature: HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
    const expectedSig = createHmac("sha256", this.secret)
      .update(`${timestampHeader}.`)
      .update(request.rawBody)
      .digest("hex");

    const providedSig = signatureHeader.replace(/^sha256=/, "");

    const expectedBuf = Buffer.from(expectedSig, "utf8");
    const providedBuf = Buffer.from(providedSig, "utf8");

    if (
      expectedBuf.length !== providedBuf.length ||
      !timingSafeEqual(expectedBuf, providedBuf)
    ) {
      throw new WebhookVerificationError("INVALID_SIGNATURE");
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(request.rawBody.toString("utf8"));
    } catch {
      throw new WebhookVerificationError("MALFORMED_JSON_PAYLOAD");
    }

    const externalId = String(parsed.externalId ?? "");
    const status = (parsed.status as ProviderJobStatus) ?? "succeeded";
    const output = (parsed.output as Record<string, unknown>) ?? undefined;
    const error = parsed.error ? String(parsed.error) : undefined;

    const existing = this.jobs.get(externalId);
    if (existing) {
      existing.status = status;
      if (output) existing.output = output;
      if (error) existing.error = error;
    }

    return {
      externalId,
      status,
      output,
      error,
    };
  }

  async cancel(externalId: string): Promise<void> {
    const job = this.jobs.get(externalId);
    if (job) {
      job.status = "cancelled";
    }
  }

  /**
   * Helper to construct signed webhook requests for testing or provider simulation.
   */
  createWebhookPayload(
    externalId: string,
    data: {
      status?: ProviderJobStatus;
      output?: Record<string, unknown>;
      error?: string;
    } = {},
    timestamp = Date.now(),
  ): { rawBody: Buffer; headers: Record<string, string> } {
    const payload = {
      externalId,
      status: data.status ?? "succeeded",
      output: data.output ?? {
        image: {
          url: `https://mock.provider.test/images/${externalId}.png`,
          width: 1024,
          height: 1024,
        },
      },
      error: data.error,
    };

    const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
    const signature = createHmac("sha256", this.secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest("hex");

    return {
      rawBody,
      headers: {
        "content-type": "application/json",
        "x-mock-signature": `sha256=${signature}`,
        "x-mock-timestamp": String(timestamp),
      },
    };
  }
}
