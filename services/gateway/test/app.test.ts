import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";

describe("gateway", () => {
  it("reports gateway health", async () => {
    const app = buildApp({ logger: false });
    try {
      const response = await app.inject("/health");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok", service: "gateway" });
    } finally {
      await app.close();
    }
  });

  it("proxies API requests to the backend", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ projects: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const app = buildApp({
      logger: false,
      backendUrl: "http://backend.test",
      fetcher,
    });
    try {
      const response = await app.inject("/api/v1/projects");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ projects: [] });
      expect(fetcher.mock.calls[0]?.[0]).toEqual(
        new URL("http://backend.test/api/v1/projects"),
      );
    } finally {
      await app.close();
    }
  });

  it("reports backend readiness", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", service: "backend" }), {
        status: 200,
      }),
    );
    const app = buildApp({
      logger: false,
      backendUrl: "http://backend.test",
      fetcher,
    });
    try {
      const response = await app.inject("/ready");
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: "ready",
        dependencies: { backend: "ready" },
      });
    } finally {
      await app.close();
    }
  });

  it("limits requests at the edge", async () => {
    const app = buildApp({ logger: false });
    try {
      for (let i = 0; i < 120; i++) {
        expect((await app.inject("/health")).statusCode).toBe(200);
      }
      expect((await app.inject("/health")).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => app.close());

  it("adds security headers", async () => {
    expect(
      (await app.inject("/health")).headers["x-content-type-options"],
    ).toBe("nosniff");
  });
});
