import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app";
import {
  authedFetch,
  INTERNAL_SECRET,
  startGateway,
  withUpstream,
} from "./helpers";

const options = { logger: false, internalSecret: INTERNAL_SECRET } as const;

describe("gateway", () => {
  it("reports gateway health", async () => {
    const app = buildApp(options);
    try {
      const response = await app.inject("/health");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok", service: "gateway" });
    } finally {
      await app.close();
    }
  });

  it("proxies API requests to the backend", async () => {
    const upstream = await withUpstream();
    const { url } = await startGateway({ backendUrl: upstream.url });
    const response = await authedFetch(`${url}/api/v1/projects`);
    expect(response.status).toBe(200);
    expect(upstream.last().url).toBe("/api/v1/projects");
  });

  it("reports backend readiness", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", service: "backend" }), {
        status: 200,
      }),
    );
    const app = buildApp({
      ...options,
      backendUrl: "http://backend.test",
      fetcher,
    });
    try {
      const response = await app.inject("/ready");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: "ready",
        dependencies: { backend: "ready", redis: "unused" },
      });
      expect(fetcher.mock.calls[0]?.[0]).toEqual(
        new URL("http://backend.test/health"),
      );
    } finally {
      await app.close();
    }
  });

  it("reports an unavailable backend", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("down"));
    const app = buildApp({ ...options, fetcher });
    try {
      const response = await app.inject("/ready");
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        status: "not_ready",
        dependencies: { backend: "unavailable" },
      });
    } finally {
      await app.close();
    }
  });

  it("limits requests at the edge", async () => {
    const app = buildApp(options);
    try {
      for (let i = 0; i < 120; i++) {
        expect((await app.inject("/health")).statusCode).toBe(200);
      }
      expect((await app.inject("/health")).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("adds security headers", async () => {
    const app = buildApp(options);
    try {
      expect(
        (await app.inject("/health")).headers["x-content-type-options"],
      ).toBe("nosniff");
    } finally {
      await app.close();
    }
  });
});
