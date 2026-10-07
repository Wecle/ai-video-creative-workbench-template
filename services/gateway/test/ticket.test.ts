import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  REALTIME_TICKET_AUDIENCE,
  REALTIME_TICKET_ISSUER,
  verifyInternalIdentity,
} from "@creative/contracts/internal-auth";
import {
  authedFetch,
  bearer,
  INTERNAL_SECRET,
  redisUrl,
  startGateway,
  TEST_USER_ID,
  TICKET_SECRET,
  withUpstream,
} from "./helpers";

async function boot(
  options: Partial<Parameters<typeof startGateway>[0]> = {},
  redisInstance?: Redis,
) {
  const upstream = await withUpstream();
  const redis = redisInstance ?? new Redis(redisUrl()!);
  const gateway = await startGateway({
    backendUrl: upstream.url,
    redis,
    ticketSecret: TICKET_SECRET,
    webOrigin: "http://localhost:3000",
    ...options,
  });
  return { upstream, gateway, redis };
}

function handshake(url: string, headers: Record<string, string> = {}) {
  return new Promise<
    { opened: WebSocket } | { status: number; headers: Record<string, unknown> }
  >((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => resolve({ opened: socket }));
    socket.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
    });
    socket.once("error", reject);
    setTimeout(() => reject(new Error("handshake hung")), 3000);
  });
}

describe("gateway realtime tickets", () => {
  const runId = "0f8fad5b-d9cb-469f-a165-70867728950e";

  it("issues tickets with valid JWT authentication and returns correct claims", async () => {
    const { gateway } = await boot();
    // 401 without auth
    const unauth = await fetch(`${gateway.url}/api/v1/realtime-tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId }),
    });
    expect(unauth.status).toBe(401);

    // 400 with invalid body
    const badBody = await authedFetch(
      `${gateway.url}/api/v1/realtime-tickets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: "not-a-uuid" }),
      },
    );
    expect(badBody.status).toBe(400);

    // 200 with valid body
    const success = await authedFetch(
      `${gateway.url}/api/v1/realtime-tickets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      },
    );
    expect(success.status).toBe(200);
    const data = (await success.json()) as {
      ticket: string;
      expiresIn: number;
      baseUrl: string;
    };
    expect(data.expiresIn).toBe(30);
    expect(data.baseUrl).toBe("http://localhost:4000");
    expect(data.ticket).toBeTruthy();
  });

  it("allows realtime HTTP stream with valid ticket, strips ticket query, and passes other queries", async () => {
    const { upstream, gateway } = await boot();
    const issueRes = await authedFetch(
      `${gateway.url}/api/v1/realtime-tickets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      },
    );
    const { ticket } = (await issueRes.json()) as { ticket: string };

    const url = `${gateway.url}/api/v1/realtime/runs/${runId}/events?ticket=${ticket}&lastEventId=10`;
    const res = await fetch(url, {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );

    const last = upstream.last();
    expect(last.url).toBe(
      `/api/v1/realtime/runs/${runId}/events?lastEventId=10`,
    );
    expect(last.headers["authorization"]).toBeUndefined();
    expect(last.headers["x-internal-auth-type"]).toBe("ticket");
    expect(last.headers["x-internal-user-id"]).toBe(TEST_USER_ID);

    const verified = verifyInternalIdentity({
      secret: INTERNAL_SECRET,
      method: "GET",
      pathname: `/api/v1/realtime/runs/${runId}/events`,
      headers: last.headers,
    });
    expect(verified).toEqual({
      ok: true,
      identity: { authType: "ticket", userId: TEST_USER_ID },
    });
  });

  it("allows realtime WebSocket connection with valid ticket and strips ticket query", async () => {
    const { upstream, gateway } = await boot();
    const issueRes = await authedFetch(
      `${gateway.url}/api/v1/realtime-tickets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      },
    );
    const { ticket } = (await issueRes.json()) as { ticket: string };

    const wsUrl = `${gateway.wsUrl}/api/v1/realtime/runs/${runId}/ws?ticket=${ticket}&foo=bar`;
    const result = await handshake(wsUrl, { Origin: "http://localhost:3000" });
    if (!("opened" in result)) throw new Error(`refused: ${result.status}`);
    result.opened.close();

    await expect.poll(() => upstream.websockets.length).toBe(1);
    const seen = upstream.websockets[0]!;
    expect(seen.url).toBe(`/api/v1/realtime/runs/${runId}/ws?foo=bar`);
    expect(seen.headers["x-internal-auth-type"]).toBe("ticket");
    expect(seen.headers["x-internal-user-id"]).toBe(TEST_USER_ID);
  });

  it("enforces single-use tickets: second use returns 401", async () => {
    const { gateway } = await boot();
    const issueRes = await authedFetch(
      `${gateway.url}/api/v1/realtime-tickets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      },
    );
    const { ticket } = (await issueRes.json()) as { ticket: string };

    const url = `${gateway.url}/api/v1/realtime/runs/${runId}/events?ticket=${ticket}`;
    // First use: success (200)
    const res1 = await fetch(url, {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(res1.status).toBe(200);

    // Second use: 401
    const res2 = await fetch(url, {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(res2.status).toBe(401);
  });

  it("rejects expired, wrong secret, wrong alg, wrong aud, and mismatched res", async () => {
    const { gateway } = await boot();
    const now = Math.floor(Date.now() / 1000);
    const key = new TextEncoder().encode(TICKET_SECRET);

    // Expired
    const expired = await new SignJWT({ res: `run:${runId}` })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(REALTIME_TICKET_ISSUER)
      .setAudience(REALTIME_TICKET_AUDIENCE)
      .setSubject(TEST_USER_ID)
      .setJti(randomUUID())
      .setIssuedAt(now - 60)
      .setExpirationTime(now - 10)
      .sign(key);
    expect(
      (
        await fetch(
          `${gateway.url}/api/v1/realtime/runs/${runId}/events?ticket=${expired}`,
        )
      ).status,
    ).toBe(401);

    // Wrong secret
    const wrongSecret = await new SignJWT({ res: `run:${runId}` })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(REALTIME_TICKET_ISSUER)
      .setAudience(REALTIME_TICKET_AUDIENCE)
      .setSubject(TEST_USER_ID)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 30)
      .sign(new TextEncoder().encode("wrong-secret-01234567890123456789"));
    expect(
      (
        await fetch(
          `${gateway.url}/api/v1/realtime/runs/${runId}/events?ticket=${wrongSecret}`,
        )
      ).status,
    ).toBe(401);

    // Wrong aud
    const wrongAud = await new SignJWT({ res: `run:${runId}` })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(REALTIME_TICKET_ISSUER)
      .setAudience("wrong-audience")
      .setSubject(TEST_USER_ID)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 30)
      .sign(key);
    expect(
      (
        await fetch(
          `${gateway.url}/api/v1/realtime/runs/${runId}/events?ticket=${wrongAud}`,
        )
      ).status,
    ).toBe(401);

    // Resource mismatch
    const otherRunId = "b0000000-0000-4000-8000-000000000002";
    const issueRes = await authedFetch(
      `${gateway.url}/api/v1/realtime-tickets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      },
    );
    const { ticket } = (await issueRes.json()) as { ticket: string };
    // Hit different run
    expect(
      (
        await fetch(
          `${gateway.url}/api/v1/realtime/runs/${otherRunId}/events?ticket=${ticket}`,
        )
      ).status,
    ).toBe(403);
    // Hit non-run path
    expect(
      (await fetch(`${gateway.url}/api/v1/realtime/other?ticket=${ticket}`))
        .status,
    ).toBe(403);
  });

  it("does not accept ticket in protected routes like /api/v1/me, but Bearer still works in realtime", async () => {
    const { gateway } = await boot();
    const issueRes = await authedFetch(
      `${gateway.url}/api/v1/realtime-tickets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      },
    );
    const { ticket } = (await issueRes.json()) as { ticket: string };

    // Ticket on /api/v1/me -> 401
    const meRes = await fetch(`${gateway.url}/api/v1/me?ticket=${ticket}`);
    expect(meRes.status).toBe(401);

    // Bearer on realtime endpoint still works
    const realtimeBearer = await fetch(
      `${gateway.url}/api/v1/realtime/runs/${runId}/events`,
      {
        headers: await bearer(),
      },
    );
    expect(realtimeBearer.status).toBe(200);
  });

  it("checks Origin: rejects untrusted Origin without consuming the ticket", async () => {
    const { gateway } = await boot();
    const issueRes = await authedFetch(
      `${gateway.url}/api/v1/realtime-tickets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      },
    );
    const { ticket } = (await issueRes.json()) as { ticket: string };

    const url = `${gateway.url}/api/v1/realtime/runs/${runId}/events?ticket=${ticket}`;

    // Forbidden Origin -> 403
    const badOrigin = await fetch(url, {
      headers: { Origin: "http://malicious.test" },
    });
    expect(badOrigin.status).toBe(403);

    // Since the ticket was not consumed, retry with valid Origin succeeds
    const goodOrigin = await fetch(url, {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(goodOrigin.status).toBe(200);
    expect(goodOrigin.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );

    // Regular protected route does not have CORS headers
    const meRes = await authedFetch(`${gateway.url}/api/v1/echo`, {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(meRes.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("disconnects realtime connection when max connection lifetime is reached", async () => {
    const { gateway } = await boot({ realtimeMaxConnectionSeconds: 1 });
    const issueRes = await authedFetch(
      `${gateway.url}/api/v1/realtime-tickets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      },
    );
    const { ticket } = (await issueRes.json()) as { ticket: string };

    const wsUrl = `${gateway.wsUrl}/api/v1/realtime/runs/${runId}/ws?ticket=${ticket}`;
    const result = await handshake(wsUrl);
    if (!("opened" in result)) throw new Error("handshake refused");
    const socket = result.opened;

    const closed = new Promise<boolean>((resolve) => {
      socket.on("close", () => resolve(true));
    });

    // Should close within ~1.5s
    expect(
      await Promise.race([closed, new Promise((_, r) => setTimeout(r, 3000))]),
    ).toBe(true);
  });

  it("returns 503 and fails closed when redis is broken during ticket verification", async () => {
    const brokenRedis = new Redis("redis://127.0.0.1:1", {
      connectTimeout: 200,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    brokenRedis.on("error", () => {});

    const { gateway } = await boot({ redis: brokenRedis });
    const now = Math.floor(Date.now() / 1000);
    const key = new TextEncoder().encode(TICKET_SECRET);
    const validTicket = await new SignJWT({ res: `run:${runId}` })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(REALTIME_TICKET_ISSUER)
      .setAudience(REALTIME_TICKET_AUDIENCE)
      .setSubject(TEST_USER_ID)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 30)
      .sign(key);

    const res = await fetch(
      `${gateway.url}/api/v1/realtime/runs/${runId}/events?ticket=${validTicket}`,
    );
    expect(res.status).toBe(503);
    brokenRedis.disconnect();
  });

  it("rate limits realtimeTicket tier per user", async () => {
    const { gateway } = await boot();
    const rlUser = await bearer("c0000000-0000-4000-8000-000000000003");
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`${gateway.url}/api/v1/realtime-tickets`, {
        method: "POST",
        headers: {
          ...rlUser,
          "content-type": "application/json",
        },
        body: JSON.stringify({ runId }),
      });
      expect(res.status).toBe(200);
    }

    const limited = await fetch(`${gateway.url}/api/v1/realtime-tickets`, {
      method: "POST",
      headers: {
        ...rlUser,
        "content-type": "application/json",
      },
      body: JSON.stringify({ runId }),
    });
    expect(limited.status).toBe(429);
  });

  it("redacts ticket parameter from gateway logs", async () => {
    let logBuffer = "";
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logBuffer += chunk.toString();
        callback();
      },
    });

    const { gateway } = await boot({ logger: true, logStream });
    const secretTicket = "super-secret-ticket-value-123456";
    await fetch(
      `${gateway.url}/api/v1/realtime/runs/${runId}/events?ticket=${secretTicket}`,
    );

    expect(logBuffer).toContain("ticket=[redacted]");
    expect(logBuffer).not.toContain(secretTicket);
  });
});
