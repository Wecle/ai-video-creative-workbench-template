import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/mock-provider";
import { WebhookVerificationError } from "../src/types";

describe("MockProvider", () => {
  it("generates deterministic outputs given the same prompt and aspect ratio", async () => {
    const provider = new MockProvider();
    const res1 = await provider.submit({
      jobId: "job-1",
      capability: "image.generate",
      prompt: "cyberpunk cat",
      params: { aspectRatio: "16:9" },
    });
    const poll1 = await provider.poll(res1.externalId);

    const res2 = await provider.submit({
      jobId: "job-2",
      capability: "image.generate",
      prompt: "cyberpunk cat",
      params: { aspectRatio: "16:9" },
    });
    const poll2 = await provider.poll(res2.externalId);

    expect(poll1.status).toBe("succeeded");
    expect(poll2.status).toBe("succeeded");
    expect(poll1.output).toEqual(poll2.output);
    const img1 = poll1.output as { image: { width: number; height: number } };
    expect(img1.image.width).toBe(1024);
    expect(img1.image.height).toBe(576);
  });

  it("handles polling mode failure simulation with mock-fail", async () => {
    const provider = new MockProvider();
    const submit = await provider.submit({
      jobId: "job-fail",
      capability: "image.generate",
      prompt: "test mock-fail prompt",
    });
    const poll = await provider.poll(submit.externalId);
    expect(poll.status).toBe("failed");
    expect(poll.error).toBe("PROVIDER_SIMULATED_FAILURE");
  });

  it("handles callback mode and verifies webhook successfully", async () => {
    const provider = new MockProvider("secret-123");
    const submit = await provider.submit({
      jobId: "job-cb",
      capability: "image.generate",
      prompt: "serene mountain",
      mockMode: "callback",
    });

    const poll = await provider.poll(submit.externalId);
    expect(poll.status).toBe("running");

    const webhook = provider.createWebhookPayload(submit.externalId, {
      status: "succeeded",
      output: { image: { url: "https://example.com/mountain.png" } },
    });

    const parsed = await provider.parseWebhook(webhook);
    expect(parsed.externalId).toBe(submit.externalId);
    expect(parsed.status).toBe("succeeded");
    expect(parsed.output).toEqual({
      image: { url: "https://example.com/mountain.png" },
    });
  });

  it("rejects forged webhook signatures", async () => {
    const provider = new MockProvider("secret-123");
    const webhook = provider.createWebhookPayload("job-fake");
    webhook.headers["x-mock-signature"] =
      "sha256=0000000000000000000000000000000000000000000000000000000000000000";

    await expect(provider.parseWebhook(webhook)).rejects.toThrow(
      WebhookVerificationError,
    );
    await expect(provider.parseWebhook(webhook)).rejects.toThrow(
      "INVALID_SIGNATURE",
    );
  });

  it("rejects expired webhook timestamps (> 300s)", async () => {
    const provider = new MockProvider("secret-123");
    const oldTimestamp = Date.now() - 400_000;
    const webhook = provider.createWebhookPayload("job-old", {}, oldTimestamp);

    await expect(provider.parseWebhook(webhook)).rejects.toThrow(
      WebhookVerificationError,
    );
    await expect(provider.parseWebhook(webhook)).rejects.toThrow(
      "EXPIRED_TIMESTAMP",
    );
  });

  it("rejects tampered webhook bodies", async () => {
    const provider = new MockProvider("secret-123");
    const webhook = provider.createWebhookPayload("job-tamper");
    // Tamper with the raw body
    webhook.rawBody = Buffer.from(
      JSON.stringify({
        externalId: "job-tamper",
        status: "failed",
        injected: true,
      }),
      "utf8",
    );

    await expect(provider.parseWebhook(webhook)).rejects.toThrow(
      WebhookVerificationError,
    );
    await expect(provider.parseWebhook(webhook)).rejects.toThrow(
      "INVALID_SIGNATURE",
    );
  });

  it("handles cancel", async () => {
    const provider = new MockProvider();
    const submit = await provider.submit({
      jobId: "job-cancel",
      capability: "image.generate",
      prompt: "cancel me",
      mockMode: "callback",
    });
    await provider.cancel(submit.externalId);
    const poll = await provider.poll(submit.externalId);
    expect(poll.status).toBe("cancelled");
  });
});
