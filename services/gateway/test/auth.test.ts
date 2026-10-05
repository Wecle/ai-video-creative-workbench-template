import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";
import {
  AUTH_JWT_AUDIENCE,
  INTERNAL_HEADERS,
  verifyInternalIdentity,
} from "@creative/contracts/internal-auth";
import {
  authedFetch,
  createSigningKey,
  INTERNAL_SECRET,
  JWT_ISSUER,
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

const protectedUrl = (gateway: { url: string }) => `${gateway.url}/api/v1/echo`;

const b64 = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

describe("JWT verification", () => {
  it("accepts a valid token, forwards a signed identity and no credentials", async () => {
    const { upstream, gateway } = await boot();
    const response = await fetch(protectedUrl(gateway), {
      headers: {
        authorization: `Bearer ${await validToken()}`,
        cookie: "session=abc",
      },
    });
    expect(response.status).toBe(200);
    const { headers } = upstream.last();
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(
      verifyInternalIdentity({
        secret: INTERNAL_SECRET,
        method: "GET",
        pathname: "/api/v1/echo",
        headers,
      }),
    ).toEqual({
      ok: true,
      identity: { authType: "jwt", userId: TEST_USER_ID },
    });
  });

  it("accepts the scheme case-insensitively", async () => {
    const { gateway } = await boot();
    const response = await fetch(protectedUrl(gateway), {
      headers: { authorization: `bearer ${await validToken()}` },
    });
    expect(response.status).toBe(200);
  });

  describe("rejects with 401 and never reaches the backend", () => {
    async function cases() {
      const key = await createSigningKey();
      const other = await createSigningKey(); // same kid, different key pair
      const now = Math.floor(Date.now() / 1000);
      const valid = await key.sign();
      const [header, payload, signature] = valid.split(".") as [
        string,
        string,
        string,
      ];
      const flipped = signature.startsWith("A") ? "B" : "A";
      const publicX = key.jwks.keys[0]!.x!;
      const hs256 = (secret: Buffer) => {
        const head = b64({ alg: "HS256", typ: "JWT", kid: "test-key" });
        const body = b64({
          sub: TEST_USER_ID,
          iss: JWT_ISSUER,
          aud: AUTH_JWT_AUDIENCE,
          exp: now + 600,
        });
        const mac = createHmac("sha256", secret)
          .update(`${head}.${body}`)
          .digest("base64url");
        return `${head}.${body}.${mac}`;
      };
      const noSub = await new SignJWT({})
        .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
        .setIssuer(JWT_ISSUER)
        .setAudience(AUTH_JWT_AUDIENCE)
        .setExpirationTime("10m")
        .sign(key.privateKey);
      return {
        key,
        tokens: {
          expired: await key.sign({ exp: now - 60 }),
          "wrong issuer": await key.sign({}, { issuer: "https://evil.test" }),
          "wrong audience": await key.sign({}, { audience: "someone-else" }),
          "tampered signature": `${header}.${payload}.${flipped}${signature.slice(1)}`,
          "tampered payload": `${header}.${b64({ sub: "attacker", iss: JWT_ISSUER, aud: AUTH_JWT_AUDIENCE, exp: now + 600 })}.${signature}`,
          "unknown kid": await key.sign({}, { kid: "rotated-away" }),
          "signed by another key": await other.sign(),
          "alg none": `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: TEST_USER_ID, iss: JWT_ISSUER, aud: AUTH_JWT_AUDIENCE, exp: now + 600 })}.`,
          "HS256 keyed with the public key (algorithm confusion)": hs256(
            Buffer.from(publicX, "base64url"),
          ),
          "HS256 keyed with the public key text": hs256(Buffer.from(publicX)),
          "missing sub": noSub,
          "unsafe sub": await key.sign({ sub: "a\nb" }),
          "not a JWT": "garbage",
          "two segments": "a.b",
          "empty segments": "..",
        } as Record<string, string>,
      };
    }

    it("for every kind of bad token", async () => {
      const { key, tokens } = await cases();
      const { upstream, gateway } = await boot({
        getKey: createLocalJWKSet(key.jwks),
      });
      for (const [name, token] of Object.entries(tokens)) {
        const response = await fetch(protectedUrl(gateway), {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status, name).toBe(401);
        expect(response.headers.get("www-authenticate"), name).toBe(
          'Bearer error="invalid_token"',
        );
        expect(await response.json()).toEqual({ error: "Unauthorized" });
      }
      expect(upstream.requests).toHaveLength(0);
    });

    it("for a missing or malformed Authorization header", async () => {
      const { upstream, gateway } = await boot();
      const token = await validToken();
      for (const authorization of [
        undefined,
        "",
        "Bearer",
        "Bearer ",
        `Basic ${token}`,
        token,
        `Bearer ${token} extra`,
      ]) {
        const response = await fetch(protectedUrl(gateway), {
          headers: authorization === undefined ? {} : { authorization },
        });
        expect(response.status, String(authorization)).toBe(401);
        expect(response.headers.get("www-authenticate")).toBe(
          'Bearer error="invalid_token"',
        );
      }
      expect(upstream.requests).toHaveLength(0);
    });

    it("even when the client forges internal identity headers", async () => {
      const { upstream, gateway } = await boot();
      const response = await fetch(protectedUrl(gateway), {
        headers: {
          [INTERNAL_HEADERS.userId]: TEST_USER_ID,
          [INTERNAL_HEADERS.authType]: "jwt",
          [INTERNAL_HEADERS.signature]: "forged",
        },
      });
      expect(response.status).toBe(401);
      expect(upstream.requests).toHaveLength(0);
    });

    it("and does not accept the token from a query parameter or cookie", async () => {
      const { upstream, gateway } = await boot();
      const token = await validToken();
      expect(
        (await fetch(`${protectedUrl(gateway)}?access_token=${token}`)).status,
      ).toBe(401);
      expect(
        (
          await fetch(protectedUrl(gateway), {
            headers: { cookie: `token=${token}` },
          })
        ).status,
      ).toBe(401);
      expect(upstream.requests).toHaveLength(0);
    });
  });

  it("tolerates a few seconds of clock skew", async () => {
    const key = await createSigningKey();
    const { gateway } = await boot({ getKey: createLocalJWKSet(key.jwks) });
    const token = await key.sign({ exp: Math.floor(Date.now() / 1000) - 2 });
    const response = await fetch(protectedUrl(gateway), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });

  it("leaves non-protected scopes open without a token", async () => {
    const { gateway } = await boot();
    expect((await fetch(`${gateway.url}/api/auth/get-session`)).status).toBe(
      200,
    );
    expect((await fetch(`${gateway.url}/docs/json`)).status).toBe(200);
    expect((await fetch(`${gateway.url}/health`)).status).toBe(200);
  });
});

/** A fake backend that serves a JWKS and can be switched off. */
async function startJwksServer(jwks: object) {
  let mode: "ok" | "down" | "hang" | "error" | "html" = "ok";
  const hits: { url: string; headers: Record<string, unknown> }[] = [];
  const hung: Server[] = [];
  const server = createServer((req, res) => {
    hits.push({ url: req.url ?? "", headers: req.headers });
    if (mode === "hang") return; // never answers: forces the JWKS timeout
    if (mode === "error") return void res.writeHead(500).end("boom");
    if (mode === "html")
      return void res
        .writeHead(200, { "content-type": "text/html" })
        .end("<p>");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(jwks));
  });
  hung.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    set: (next: typeof mode) => (mode = next),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("JWKS handling (R5)", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()!();
  });

  /** Wraps a key resolver so the test can see which error jose really threw. */
  function recording(getKey: JWTVerifyGetKey) {
    const errors: { name: string; code: unknown; message: string }[] = [];
    const wrapped: JWTVerifyGetKey = async (header, token) => {
      try {
        return await getKey(header, token);
      } catch (error) {
        const e = error as Error & { code?: unknown };
        errors.push({
          name: e.constructor.name,
          code: e.code,
          message: e.message,
        });
        throw error;
      }
    };
    return { wrapped, errors };
  }

  it("answers 503, not 401, when the JWKS endpoint is unreachable", async () => {
    const token = await validToken();
    const { wrapped, errors } = recording(
      createRemoteJWKSet(new URL("http://127.0.0.1:1/api/auth/jwks"), {
        timeoutDuration: 1000,
      }),
    );
    const { upstream, gateway } = await boot({ getKey: wrapped });
    const response = await fetch(protectedUrl(gateway), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(await response.json()).toEqual({
      error: "Authentication service unavailable",
    });
    expect(upstream.requests).toHaveLength(0);
    // Connection refused surfaces as a plain TypeError from fetch, not a JOSEError.
    expect(errors).toHaveLength(1);
    expect(errors[0]!.name).toBe("TypeError");
    expect(errors[0]!.message).toBe("fetch failed");
  });

  it("answers 503 when the JWKS request times out (JWKSTimeout)", async () => {
    const jwks = await startJwksServer({ keys: [] });
    closers.push(jwks.close);
    jwks.set("hang");
    const { wrapped, errors } = recording(
      createRemoteJWKSet(new URL(`${jwks.url}/api/auth/jwks`), {
        timeoutDuration: 200,
      }),
    );
    const { gateway } = await boot({ getKey: wrapped });
    const response = await fetch(protectedUrl(gateway), {
      headers: { authorization: `Bearer ${await validToken()}` },
    });
    expect(response.status).toBe(503);
    expect(errors[0]).toMatchObject({
      name: "JWKSTimeout",
      code: "ERR_JWKS_TIMEOUT",
    });
  });

  it("answers 503 when the JWKS endpoint returns an error status or a non-JSON body", async () => {
    const jwks = await startJwksServer({ keys: [] });
    closers.push(jwks.close);
    const { wrapped, errors } = recording(
      createRemoteJWKSet(new URL(`${jwks.url}/api/auth/jwks`), {
        timeoutDuration: 1000,
      }),
    );
    const { gateway } = await boot({ getKey: wrapped });
    const call = async () =>
      (
        await fetch(protectedUrl(gateway), {
          headers: { authorization: `Bearer ${await validToken()}` },
        })
      ).status;
    jwks.set("error");
    expect(await call()).toBe(503);
    jwks.set("html");
    expect(await call()).toBe(503);
    expect(errors.map((e) => e.name)).toEqual(["JOSEError", "JOSEError"]);
    expect(errors.map((e) => e.code)).toEqual([
      "ERR_JOSE_GENERIC",
      "ERR_JOSE_GENERIC",
    ]);
  });

  it("recovers on its own once the JWKS endpoint is back, without a restart", async () => {
    const key = await createSigningKey();
    const jwks = await startJwksServer(key.jwks);
    closers.push(jwks.close);
    const { gateway } = await boot({
      getKey: createRemoteJWKSet(new URL(`${jwks.url}/api/auth/jwks`), {
        timeoutDuration: 1000,
        cooldownDuration: 30_000,
      }),
    });
    const token = await key.sign();
    const call = async () =>
      (
        await fetch(protectedUrl(gateway), {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status;
    jwks.set("error");
    expect(await call()).toBe(503);
    jwks.set("ok");
    expect(await call()).toBe(200);
  });

  it("does not mistake an unknown kid for an outage: 401 once the keys are known", async () => {
    const key = await createSigningKey();
    const jwks = await startJwksServer(key.jwks);
    closers.push(jwks.close);
    const { gateway } = await boot({
      getKey: createRemoteJWKSet(new URL(`${jwks.url}/api/auth/jwks`), {
        timeoutDuration: 1000,
      }),
    });
    const response = await fetch(protectedUrl(gateway), {
      headers: {
        authorization: `Bearer ${await key.sign({}, { kid: "rotated-away" })}`,
      },
    });
    expect(response.status).toBe(401);
  });

  it("fetches the JWKS from BACKEND_URL without a signature and caches it", async () => {
    const key = await createSigningKey();
    const jwks = await startJwksServer(key.jwks);
    closers.push(jwks.close);
    // No getKey override: the default createRemoteJWKSet against backendUrl.
    const gateway = await startGateway({
      backendUrl: jwks.url,
      getKey: undefined,
    });
    const headers = { authorization: `Bearer ${await key.sign()}` };
    // The fake backend answers every path with the JWKS JSON, which is enough here.
    for (let i = 0; i < 3; i++)
      expect((await fetch(protectedUrl(gateway), { headers })).status).toBe(
        200,
      );
    const jwksHits = jwks.hits.filter((h) => h.url === "/api/auth/jwks");
    expect(jwksHits).toHaveLength(1);
    for (const name of Object.values(INTERNAL_HEADERS))
      expect(jwksHits[0]!.headers[name]).toBeUndefined();
  });

  it("returns 503 through the default resolver when the backend is down", async () => {
    const gateway = await startGateway({
      backendUrl: "http://127.0.0.1:1",
      getKey: undefined,
    });
    const response = await authedFetch(protectedUrl(gateway), {
      headers: { authorization: `Bearer ${await validToken()}` },
    });
    expect(response.status).toBe(503);
  });
});
