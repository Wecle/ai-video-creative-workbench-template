import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src";

describe("API client", () => {
  it("validates health responses", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "ok", service: "gateway" })),
      );
    expect(
      await createApiClient("http://example.test", fetcher).health(),
    ).toEqual({ status: "ok", service: "gateway" });
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://example.test/health");
  });
  it("surfaces non-success responses", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    await expect(createApiClient("", fetcher).health()).rejects.toThrow("503");
  });
  it("rejects incompatible responses", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ status: "fake" })));
    await expect(createApiClient("", fetcher).health()).rejects.toThrow();
  });
});
