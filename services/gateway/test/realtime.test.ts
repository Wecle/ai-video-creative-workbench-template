import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createLocalJWKSet, createRemoteJWKSet } from "jose";
import { verifyInternalIdentity } from "@creative/contracts/internal-auth";
import {
  bearer,
  createSigningKey,
  INTERNAL_SECRET,
  startGateway,
  TEST_USER_ID,
  validToken,
  withUpstream,
} from "./helpers";

async function boot(options: Partial<Parameters<typeof startGateway>[0]> = {}) {
  const upstream = await withUpstream();
  const gateway = await startGateway({ backendUrl: upstream.url, ...options });
  return { upstream, gateway };
}

type Handshake =
  { opened: WebSocket } | { status: number; headers: Record<string, unknown> };

/** Open a WebSocket and report either the open socket or the HTTP response that refused it. */
function handshake(url: string, headers: Record<string, string> = {}) {
  return new Promise<Handshake>((resolve, reject) => {
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

describe("realtime WebSocket authentication (Bearer only in P0a)", () => {
  it("completes the handshake with a valid token and the upstream receives the signed user", async () => {
    const { upstream, gateway } = await boot();
    const result = await handshake(
      `${gateway.wsUrl}/api/v1/realtime/ws?topic=runs`,
      await bearer(),
    );
    if (!("opened" in result)) throw new Error(`refused: ${result.status}`);
    const socket = result.opened;
    const reply = new Promise<string>((resolve) =>
      socket.once("message", (data) => resolve(data.toString())),
    );
    socket.send("hello");
    expect(await reply).toBe("hello");
    socket.close();

    expect(upstream.websockets).toHaveLength(1);
    const seen = upstream.websockets[0]!;
    expect(seen.url).toBe("/api/v1/realtime/ws?topic=runs");
    expect(seen.headers.authorization).toBeUndefined();
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

  it("identifies different users separately", async () => {
    const { upstream, gateway } = await boot();
    const other = "b0000000-0000-4000-8000-000000000002";
    const result = await handshake(
      `${gateway.wsUrl}/api/v1/realtime/ws`,
      await bearer(other),
    );
    if (!("opened" in result)) throw new Error("refused");
    result.opened.close();
    await expect.poll(() => upstream.websockets.length).toBe(1);
    expect(upstream.websockets[0]!.headers["x-internal-user-id"]).toBe(other);
  });

  it("refuses the handshake without a token (401, nothing reaches the backend)", async () => {
    const { upstream, gateway } = await boot();
    const result = await handshake(`${gateway.wsUrl}/api/v1/realtime/ws`);
    expect(result).toMatchObject({ status: 401 });
    expect(
      (result as { headers: Record<string, unknown> }).headers[
        "www-authenticate"
      ],
    ).toBe('Bearer error="invalid_token"');
    expect(upstream.websockets).toHaveLength(0);
  });

  it("refuses forged, expired and wrongly scoped tokens", async () => {
    const key = await createSigningKey();
    const attacker = await createSigningKey(); // same kid, different key pair
    const { upstream, gateway } = await boot({
      getKey: createLocalJWKSet(key.jwks),
    });
    const now = Math.floor(Date.now() / 1000);
    const tokens = {
      forged: await attacker.sign(),
      expired: await key.sign({ exp: now - 60 }),
      "wrong audience": await key.sign({}, { audience: "realtime" }),
      "wrong issuer": await key.sign({}, { issuer: "https://evil.test" }),
      garbage: "not.a.jwt",
    };
    for (const [name, token] of Object.entries(tokens)) {
      const result = await handshake(`${gateway.wsUrl}/api/v1/realtime/ws`, {
        authorization: `Bearer ${token}`,
      });
      expect(result, name).toMatchObject({ status: 401 });
    }
    expect(upstream.websockets).toHaveLength(0);
  });

  it("does not accept a token from the query string or a subprotocol (no tickets in P0a)", async () => {
    const { upstream, gateway } = await boot();
    const token = await validToken();
    expect(
      await handshake(
        `${gateway.wsUrl}/api/v1/realtime/ws?access_token=${token}`,
      ),
    ).toMatchObject({ status: 401 });
    expect(
      await handshake(`${gateway.wsUrl}/api/v1/realtime/ws?ticket=${token}`),
    ).toMatchObject({ status: 401 });
    expect(
      await handshake(`${gateway.wsUrl}/api/v1/realtime/ws`, {
        "sec-websocket-protocol": token,
      }),
    ).toMatchObject({ status: 401 });
    expect(upstream.websockets).toHaveLength(0);
  });

  it("answers 503 on the handshake when the JWKS is unreachable", async () => {
    const { upstream, gateway } = await boot({
      getKey: createRemoteJWKSet(new URL("http://127.0.0.1:1/api/auth/jwks"), {
        timeoutDuration: 1000,
      }),
    });
    const result = await handshake(
      `${gateway.wsUrl}/api/v1/realtime/ws`,
      await bearer(),
    );
    expect(result).toMatchObject({ status: 503 });
    expect(upstream.websockets).toHaveLength(0);
  });
});

describe("realtime SSE authentication", () => {
  it("streams to an authenticated client and refuses an anonymous one", async () => {
    const { upstream, gateway } = await boot();
    const url = `${gateway.url}/api/v1/realtime/sse?count=3&interval=20`;
    const anonymous = await fetch(url);
    expect(anonymous.status).toBe(401);
    expect(upstream.requests).toHaveLength(0);

    const response = await fetch(url, { headers: await bearer() });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect((await response.text()).match(/data: event-\d/g)).toHaveLength(3);
    const { headers } = upstream.last();
    expect(headers.authorization).toBeUndefined();
    expect(
      verifyInternalIdentity({
        secret: INTERNAL_SECRET,
        method: "GET",
        pathname: "/api/v1/realtime/sse",
        headers,
      }),
    ).toMatchObject({ ok: true, identity: { authType: "jwt" } });
  });
});
