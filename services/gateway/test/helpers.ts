import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { afterEach } from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type JWTPayload,
} from "jose";
import { AUTH_JWT_AUDIENCE } from "@creative/contracts/internal-auth";
import { buildApp, type GatewayOptions } from "../src/app";

export const INTERNAL_SECRET = "test-internal-secret-0123456789abcdef";
export const JWT_ISSUER = "http://localhost:3000";
export const TEST_USER_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

/** An Ed25519 signing key and the JWKS that publishes its public half. */
export async function createSigningKey(kid = "test-key") {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    extractable: true,
  });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "EdDSA" };
  return {
    privateKey,
    jwks: { keys: [jwk] },
    /** Mint a token the way Better Auth's JWT plugin does; override any claim to break it. */
    sign: async (
      claims: JWTPayload & { exp?: number | string } = {},
      overrides: { issuer?: string; audience?: string; kid?: string } = {},
    ) => {
      const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: "EdDSA", kid: overrides.kid ?? kid })
        .setIssuedAt()
        .setIssuer(overrides.issuer ?? JWT_ISSUER)
        .setAudience(overrides.audience ?? AUTH_JWT_AUDIENCE);
      if (claims.sub === undefined) jwt.setSubject(TEST_USER_ID);
      if (claims.exp === undefined) jwt.setExpirationTime("10m");
      return jwt.sign(privateKey);
    },
  };
}

export type SigningKey = Awaited<ReturnType<typeof createSigningKey>>;

const defaultKey = createSigningKey();

/** Valid access token for TEST_USER_ID (or `sub`), signed with the default test key. */
export async function validToken(sub?: string) {
  const key = await defaultKey;
  return key.sign(sub ? { sub } : {});
}

export async function bearer(sub?: string) {
  return { authorization: `Bearer ${await validToken(sub)}` };
}

/** `fetch` with a valid Bearer token already attached. */
export async function authedFetch(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("authorization"))
    headers.set("authorization", (await bearer()).authorization);
  return fetch(url, { ...init, headers });
}

export type RecordedRequest = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

/**
 * Stand-in for the backend. The last path segment selects the behaviour:
 * `echo` (default), `slow?ms=`, `sse?count=&interval=`, `cookies`,
 * `redirect`, `status?code=`.
 */
export async function startUpstream() {
  const requests: RecordedRequest[] = [];
  const websockets: { url: string; headers: IncomingHttpHeaders }[] = [];
  let sseClosed = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://upstream.test");
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body,
      });
      const action = url.pathname.split("/").pop();
      const query = url.searchParams;
      if (action === "slow") {
        setTimeout(
          () => res.writeHead(200).end("slow"),
          Number(query.get("ms") ?? 600),
        );
      } else if (action === "sse") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        const count = Number(query.get("count") ?? 5);
        const interval = Number(query.get("interval") ?? 50);
        let sent = 0;
        const timer = setInterval(() => {
          res.write(`data: event-${sent}\n\n`);
          if (++sent >= count) {
            clearInterval(timer);
            res.end();
          }
        }, interval);
        res.on("close", () => {
          clearInterval(timer);
          sseClosed++;
        });
      } else if (action === "cookies") {
        res.writeHead(200, {
          "set-cookie": ["a=1; Path=/; HttpOnly", "b=2; Path=/; Secure"],
        });
        res.end("ok");
      } else if (action === "redirect") {
        res.writeHead(302, { location: "https://example.test/next" }).end();
      } else if (action === "status") {
        res.writeHead(Number(query.get("code") ?? 500)).end("upstream status");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: body.toString("base64"),
          }),
        );
      }
    });
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket, req) => {
    websockets.push({ url: req.url ?? "", headers: req.headers });
    socket.on("message", (data, isBinary) =>
      socket.send(data, { binary: isBinary }),
    );
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  const upstream = {
    url: `http://127.0.0.1:${port}`,
    requests,
    websockets,
    get sseClosed() {
      return sseClosed;
    },
    last: () => requests[requests.length - 1]!,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return upstream;
}

export type TestUpstream = Awaited<ReturnType<typeof startUpstream>>;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

export async function withUpstream() {
  const upstream = await startUpstream();
  cleanups.push(upstream.close);
  return upstream;
}

/** Build a gateway, listen on a random port, and close it after the test. */
export async function startGateway(
  options: Partial<GatewayOptions> & { backendUrl: string },
) {
  const key = await defaultKey;
  const app = buildApp({
    logger: false,
    internalSecret: INTERNAL_SECRET,
    getKey: createLocalJWKSet(key.jwks),
    jwt: { issuer: JWT_ISSUER, audience: AUTH_JWT_AUDIENCE },
    ...options,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => app.close());
  const { port } = app.server.address() as AddressInfo;
  return {
    app,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
  };
}

/** Integration tests need real Redis; in CI a missing variable is a failure, not a skip. */
export function redisUrl() {
  const url = process.env.REDIS_URL;
  if (!url && process.env.CI) throw new Error("REDIS_URL is required in CI");
  return url;
}
