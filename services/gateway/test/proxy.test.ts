import http from "node:http";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  INTERNAL_HEADERS,
  verifyInternalIdentity,
} from "@creative/contracts/internal-auth";
import {
  authedFetch,
  bearer,
  INTERNAL_SECRET,
  startGateway,
  TEST_USER_ID,
  withUpstream,
} from "./helpers";

async function boot(options: Partial<Parameters<typeof startGateway>[0]> = {}) {
  const upstream = await withUpstream();
  const gateway = await startGateway({ backendUrl: upstream.url, ...options });
  return { upstream, gateway };
}

describe("http proxy", () => {
  it("forwards method, path, query and JSON bodies untouched", async () => {
    const { upstream, gateway } = await boot();
    const response = await authedFetch(`${gateway.url}/api/v1/echo?a=1&b=two`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(response.status).toBe(200);
    const sent = upstream.last();
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("/api/v1/echo?a=1&b=two");
    expect(JSON.parse(sent.body.toString())).toEqual({ hello: "world" });
  });

  it("forwards binary bodies byte for byte", async () => {
    const { upstream, gateway } = await boot();
    const bytes = Buffer.from([0, 255, 1, 254, 10, 13, 128]);
    await authedFetch(`${gateway.url}/api/v1/blob`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    expect(upstream.last().body.equals(bytes)).toBe(true);
  });

  it("keeps the prefix for every proxied scope (rewritePrefix regression)", async () => {
    const { upstream, gateway } = await boot();
    for (const path of [
      "/api/v1/x/y",
      "/api/auth/sign-in/email",
      "/docs",
      "/docs/json",
    ]) {
      await authedFetch(`${gateway.url}${path}`);
      expect(upstream.last().url).toBe(path);
    }
  });

  it("passes several Set-Cookie headers and redirect statuses through", async () => {
    const { gateway } = await boot();
    const cookies = await fetch(`${gateway.url}/api/auth/cookies`);
    expect(cookies.headers.getSetCookie()).toEqual([
      "a=1; Path=/; HttpOnly",
      "b=2; Path=/; Secure",
    ]);
    const redirect = await fetch(`${gateway.url}/api/auth/redirect`, {
      redirect: "manual",
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("https://example.test/next");
  });

  it("passes upstream error statuses through and maps failures to 502/504", async () => {
    const { gateway } = await boot({ timeouts: { proxyMs: 1000 } });
    expect(
      (await authedFetch(`${gateway.url}/api/v1/status?code=500`)).status,
    ).toBe(500);
    expect(
      (await authedFetch(`${gateway.url}/api/v1/status?code=404`)).status,
    ).toBe(404);
    expect(
      (await authedFetch(`${gateway.url}/api/v1/slow?ms=2500`)).status,
    ).toBe(504);

    const dead = await startGateway({ backendUrl: "http://127.0.0.1:1" });
    const response = await authedFetch(`${dead.url}/api/v1/anything`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Backend unavailable" });
  });

  it("does not replay a request when the upstream answers 503", async () => {
    const { upstream, gateway } = await boot();
    expect(
      (await authedFetch(`${gateway.url}/api/v1/status?code=503`)).status,
    ).toBe(503);
    expect(upstream.requests).toHaveLength(1);
  });

  it("returns 404 for paths no scope owns", async () => {
    const { upstream, gateway } = await boot();
    expect((await fetch(`${gateway.url}/nope`)).status).toBe(404);
    expect((await fetch(`${gateway.url}/api/other`)).status).toBe(404);
    expect(upstream.requests).toHaveLength(0);
  });
});

describe("internal identity headers", () => {
  const verify = (
    headers: http.IncomingHttpHeaders,
    pathname: string,
    method = "GET",
  ) =>
    verifyInternalIdentity({
      secret: INTERNAL_SECRET,
      method,
      pathname,
      headers,
    });

  it("signs the verified user on protected routes, bound to method and path", async () => {
    const { upstream, gateway } = await boot();
    await authedFetch(`${gateway.url}/api/v1/echo?secret=1`, {
      method: "POST",
      body: "x",
    });
    const { headers } = upstream.last();
    expect(headers[INTERNAL_HEADERS.userId]).toBe(TEST_USER_ID);
    expect(verify(headers, "/api/v1/echo", "POST")).toEqual({
      ok: true,
      identity: { authType: "jwt", userId: TEST_USER_ID },
    });
    expect(verify(headers, "/api/v1/echo", "GET").ok).toBe(false);
    expect(verify(headers, "/api/v1/other", "POST").ok).toBe(false);
  });

  it.each(["/api/auth/echo", "/docs/echo"])(
    "signs %s as anonymous even when a valid token is sent",
    async (path) => {
      const { upstream, gateway } = await boot();
      await authedFetch(`${gateway.url}${path}`);
      const { headers } = upstream.last();
      expect(headers[INTERNAL_HEADERS.userId]).toBeUndefined();
      expect(verify(headers, path)).toEqual({
        ok: true,
        identity: { authType: "anonymous" },
      });
    },
  );

  it.each(["/api/v1/echo", "/api/auth/echo", "/docs/echo"])(
    "replaces forged internal headers and x-forwarded-for on %s",
    async (path) => {
      const { upstream, gateway } = await boot();
      const expected =
        path === "/api/v1/echo"
          ? { authType: "jwt", userId: TEST_USER_ID }
          : { authType: "anonymous" };
      // fetch() refuses to send a Connection header, so use node:http.
      await new Promise<void>((resolve, reject) => {
        bearer().then((auth) => {
          const request = http.request(
            `${gateway.url}${path}`,
            {
              headers: {
                ...auth,
                "x-internal-user-id": "someone-else",
                "x-internal-auth-type": "jwt",
                "x-internal-ts": "1",
                "x-internal-sig": "forged",
                connection: "close, x-internal-user-id",
                "x-forwarded-for": "6.6.6.6",
              },
            },
            (response) => {
              response.resume();
              response.on("end", resolve);
            },
          );
          request.on("error", reject);
          request.end();
        }, reject);
      });
      const { headers } = upstream.last();
      expect(headers[INTERNAL_HEADERS.signature]).not.toBe("forged");
      expect(headers[INTERNAL_HEADERS.userId]).not.toBe("someone-else");
      expect(verify(headers, path)).toEqual({ ok: true, identity: expected });
      expect(headers["x-forwarded-for"]).toBe("127.0.0.1");
    },
  );

  it("drops credentials on protected routes but keeps them for auth routes", async () => {
    const { upstream, gateway } = await boot();
    const credentials = { cookie: "session=abc" };
    await authedFetch(`${gateway.url}/api/v1/echo`, { headers: credentials });
    expect(upstream.last().headers.authorization).toBeUndefined();
    expect(upstream.last().headers.cookie).toBeUndefined();
    await fetch(`${gateway.url}/api/auth/echo`, {
      headers: { ...credentials, authorization: "Bearer opaque" },
    });
    expect(upstream.last().headers.cookie).toBe("session=abc");
  });
});

// undici drives header/body timeouts with a coarse timer (fires roughly 0.5-1s late),
// so the proxy timeout under test is 1s rather than a few hundred milliseconds.
describe("timeouts", () => {
  it("applies the proxy timeout to normal routes", async () => {
    const { gateway } = await boot({
      timeouts: { requestMs: 300, proxyMs: 1000 },
    });
    expect(
      (await authedFetch(`${gateway.url}/api/v1/slow?ms=2500`)).status,
    ).toBe(504);
    expect((await authedFetch(`${gateway.url}/api/v1/slow?ms=50`)).status).toBe(
      200,
    );
  });
});

describe("sse", () => {
  it("streams events as they happen, beyond the normal timeouts", async () => {
    const { gateway } = await boot({
      timeouts: { requestMs: 300, proxyMs: 1000 },
    });
    const response = await authedFetch(
      `${gateway.url}/api/v1/realtime/sse?count=25&interval=100`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const arrivals: number[] = [];
    let text = "";
    const started = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push(Date.now() - started);
      text += decoder.decode(value, { stream: true });
    }
    const events = text.match(/data: event-\d+/g) ?? [];
    expect(events).toHaveLength(25);
    // Not buffered: the first event arrived long before the stream ended.
    expect(arrivals[0]).toBeLessThan(800);
    expect(arrivals[arrivals.length - 1]).toBeGreaterThan(2000);
  });

  it("closes the upstream stream when the client disconnects", async () => {
    const { upstream, gateway } = await boot();
    const controller = new AbortController();
    const response = await authedFetch(
      `${gateway.url}/api/v1/realtime/sse?count=1000&interval=20`,
      { signal: controller.signal },
    );
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await expect.poll(() => upstream.sseClosed, { timeout: 3000 }).toBe(1);
  });
});

describe("websocket", () => {
  function open(url: string, options?: WebSocket.ClientOptions) {
    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url, options);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
      socket.once("unexpected-response", (_req, res) =>
        reject(new Error(`status ${res.statusCode}`)),
      );
    });
  }

  it("relays messages both ways and builds upstream headers from scratch", async () => {
    const { upstream, gateway } = await boot();
    const socket = await open(`${gateway.wsUrl}/api/v1/realtime/ws?topic=a`, {
      headers: {
        ...(await bearer()),
        cookie: "session=abc",
        "x-internal-user-id": "someone-else",
        "x-custom": "client",
      },
    });
    const reply = new Promise<string>((resolve) =>
      socket.once("message", (data) => resolve(data.toString())),
    );
    socket.send("ping");
    expect(await reply).toBe("ping");
    socket.close();

    const seen = upstream.websockets[0]!;
    expect(seen.url).toBe("/api/v1/realtime/ws?topic=a");
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers["x-custom"]).toBeUndefined();
    // The client-supplied x-internal-user-id never reaches the upstream; the signed one does.
    expect(seen.headers[INTERNAL_HEADERS.userId]).toBe(TEST_USER_ID);
    expect(seen.headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(
      verifyInternalIdentity({
        secret: INTERNAL_SECRET,
        method: "GET",
        pathname: "/api/v1/realtime/ws",
        headers: seen.headers,
      }),
    ).toEqual({
      ok: true,
      identity: { authType: "jwt", userId: TEST_USER_ID },
    });
  });

  it("relays binary frames", async () => {
    const { gateway } = await boot();
    const socket = await open(`${gateway.wsUrl}/api/v1/realtime/ws`, {
      headers: await bearer(),
    });
    const reply = new Promise<Buffer>((resolve) =>
      socket.once("message", (data) => resolve(data as Buffer)),
    );
    socket.send(Buffer.from([1, 2, 3, 250]), { binary: true });
    expect([...(await reply)]).toEqual([1, 2, 3, 250]);
    socket.close();
  });

  it("answers an upgrade outside the realtime prefix with 426 instead of hanging", async () => {
    const { upstream, gateway } = await boot();
    for (const path of ["/api/v1/foo", "/api/auth/x", "/health", "/nope"]) {
      const status = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(`${gateway.wsUrl}${path}`);
        socket.once("unexpected-response", (_req, res) =>
          resolve(res.statusCode ?? 0),
        );
        socket.once("open", () => reject(new Error("upgraded")));
        socket.once("error", reject);
        setTimeout(() => reject(new Error("hung")), 2000);
      });
      expect(status).toBe(426);
    }
    expect(upstream.websockets).toHaveLength(0);
  });

  it("keeps a long-lived connection open past the request timeout", async () => {
    const { gateway } = await boot({
      timeouts: { requestMs: 300, proxyMs: 1000 },
    });
    const socket = await open(`${gateway.wsUrl}/api/v1/realtime/ws`, {
      headers: await bearer(),
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const reply = new Promise<string>((resolve) =>
      socket.once("message", (data) => resolve(data.toString())),
    );
    socket.send("still here");
    expect(await reply).toBe("still here");
    socket.close();
  });
});

describe("route table", () => {
  it("sends /api/v1/realtime/* to the realtime scope, not the protected one", async () => {
    // The protected scope times out at proxyMs; the realtime scope does not.
    const { gateway } = await boot({ timeouts: { proxyMs: 1000 } });
    expect(
      (await authedFetch(`${gateway.url}/api/v1/slow?ms=2500`)).status,
    ).toBe(504);
    expect(
      (await authedFetch(`${gateway.url}/api/v1/realtime/slow?ms=2500`)).status,
    ).toBe(200);
  });
});
