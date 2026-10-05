import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { isAuthStrict } from "../src/rate-limit";
import {
  authedFetch,
  bearer,
  redisUrl,
  startGateway,
  withUpstream,
} from "./helpers";

async function boot(options: Partial<Parameters<typeof startGateway>[0]> = {}) {
  const upstream = await withUpstream();
  const gateway = await startGateway({ backendUrl: upstream.url, ...options });
  return { upstream, gateway };
}

async function hit(url: string, method = "GET") {
  return fetch(url, { method });
}

async function exhaust(url: string, method: string, allowed: number) {
  for (let i = 0; i < allowed; i++) {
    expect((await hit(url, method)).status).not.toBe(429);
  }
  return hit(url, method);
}

describe("auth tier routing", () => {
  it.each([
    "/api/auth/sign-in/email",
    "/api/auth/sign-in/social",
    "/api/auth/sign-up/email",
    "/api/auth/request-password-reset",
    "/api/auth/reset-password",
    "/api/auth/verify-password",
    "/api/auth/change-password",
    "/api/auth/change-email",
    "/api/auth/send-verification-email",
  ])("treats POST %s as a credential endpoint", (path) => {
    expect(isAuthStrict("POST", path)).toBe(true);
    expect(isAuthStrict("POST", `${path}?x=1`)).toBe(true);
    expect(isAuthStrict("GET", path)).toBe(false);
  });

  it.each([
    "/api/auth/get-session",
    "/api/auth/token",
    "/api/auth/jwks",
    "/api/auth/sign-out",
    "/api/auth/callback/google",
    "/api/auth/list-sessions",
  ])("keeps %s in the general tier", (path) => {
    expect(isAuthStrict("POST", path)).toBe(false);
    expect(isAuthStrict("GET", path)).toBe(false);
  });
});

describe("rate limits (in-memory store)", () => {
  it("limits the public tier and reports retry-after", async () => {
    const { gateway } = await boot();
    const response = await exhaust(`${gateway.url}/health`, "GET", 120);
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("limits credential endpoints strictly and leaves other auth routes alone", async () => {
    const { gateway } = await boot();
    const strict = await exhaust(
      `${gateway.url}/api/auth/sign-in/email`,
      "POST",
      10,
    );
    expect(strict.status).toBe(429);
    // authGeneral has its own counter: session lookups keep working.
    expect((await hit(`${gateway.url}/api/auth/get-session`)).status).toBe(200);
    expect((await hit(`${gateway.url}/api/auth/token`)).status).toBe(200);
    // Only POST on credential paths is strict.
    expect((await hit(`${gateway.url}/api/auth/sign-in/email`)).status).toBe(
      200,
    );
  });

  it("keeps tier counters independent", async () => {
    const { gateway } = await boot();
    expect((await exhaust(`${gateway.url}/health`, "GET", 120)).status).toBe(
      429,
    );
    expect((await authedFetch(`${gateway.url}/api/v1/echo`)).status).toBe(200);
    expect((await hit(`${gateway.url}/api/auth/get-session`)).status).toBe(200);
  });

  it("limits unauthenticated API traffic by IP before any authentication", async () => {
    const { gateway } = await boot();
    expect(
      (await exhaust(`${gateway.url}/api/v1/echo`, "GET", 600)).status,
    ).toBe(429);
  });

  it("limits authenticated API traffic per user, not per IP", async () => {
    const { gateway } = await boot();
    const asA = await bearer("a0000000-0000-4000-8000-000000000001");
    const asB = await bearer("b0000000-0000-4000-8000-000000000002");
    const call = (headers: Record<string, string>) =>
      fetch(`${gateway.url}/api/v1/echo`, { headers });
    for (let i = 0; i < 300; i++) expect((await call(asA)).status).toBe(200);
    const limited = await call(asA);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    // Same IP, another user: still served.
    expect((await call(asB)).status).toBe(200);
  });

  it("limits realtime connections by IP", async () => {
    const { gateway } = await boot();
    expect(
      (
        await exhaust(
          `${gateway.url}/api/v1/realtime/status?code=200`,
          "GET",
          30,
        )
      ).status,
    ).toBe(429);
  });
});

describe("rate limits (redis)", () => {
  const url = redisUrl();

  it.skipIf(!url)("shares counters between gateway instances", async () => {
    const redis = new Redis(url!);
    const namespace = `test:${randomUUID()}:`;
    try {
      const a = await boot({ redis, rateLimitNamespace: namespace });
      const b = await boot({ redis, rateLimitNamespace: namespace });
      for (let i = 0; i < 60; i++) {
        expect((await hit(`${a.gateway.url}/health`)).status).toBe(200);
        expect((await hit(`${b.gateway.url}/health`)).status).toBe(200);
      }
      expect((await hit(`${a.gateway.url}/health`)).status).toBe(429);
      expect((await hit(`${b.gateway.url}/health`)).status).toBe(429);
      expect((await redis.keys(`${namespace}*`)).length).toBeGreaterThan(0);
    } finally {
      const keys = await redis.keys(`${namespace}*`);
      if (keys.length > 0) await redis.del(...keys);
      redis.disconnect();
    }
  });

  it.skipIf(!url)("reports redis in /ready", async () => {
    const redis = new Redis(url!);
    try {
      const { gateway } = await boot({
        redis,
        rateLimitNamespace: `test:${randomUUID()}:`,
      });
      const response = await fetch(`${gateway.url}/ready`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "ready",
        dependencies: { backend: "ready", redis: "ready" },
      });
    } finally {
      redis.disconnect();
    }
  });
});

describe("redis failure", () => {
  function deadRedis() {
    const redis = new Redis("redis://127.0.0.1:1", {
      connectTimeout: 200,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    redis.on("error", () => {});
    return redis;
  }

  it("fails open: requests are served and not limited when redis is down", async () => {
    const redis = deadRedis();
    const { gateway } = await boot({ redis });
    for (let i = 0; i < 130; i++) {
      expect((await hit(`${gateway.url}/health`)).status).toBe(200);
    }
    expect((await authedFetch(`${gateway.url}/api/v1/echo`)).status).toBe(200);
    redis.disconnect();
  });

  it("reports not_ready when redis is down", async () => {
    const redis = deadRedis();
    const { gateway } = await boot({ redis });
    const response = await fetch(`${gateway.url}/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "not_ready",
      dependencies: { backend: "ready", redis: "unavailable" },
    });
    redis.disconnect();
  });
});
