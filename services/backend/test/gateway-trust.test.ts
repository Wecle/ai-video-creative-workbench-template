import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, signedHeaders } from "./helpers";

const userId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const user = { authType: "jwt", userId } as const;

describe("backend trusts only the gateway", () => {
  // Never touches a database: these tests are about the signature check alone.
  const ctx = createTestApp("postgresql://nobody:nobody@127.0.0.1:1/none");
  const { app } = ctx;
  beforeAll(async () => {
    await app.ready();
  });
  afterAll(async () => ctx.close());

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url, headers });

  it("rejects requests without a signature", async () => {
    for (const url of [
      "/api/v1/me",
      "/api/v1/projects",
      "/api/v1/projects/0f8fad5b-d9cb-469f-a165-70867728950e/canvases/0f8fad5b-d9cb-469f-a165-70867728950e",
      "/docs/json",
      "/no-such-route",
    ])
      expect((await get(url)).statusCode, url).toBe(403);
  });

  it("rejects a wrong secret, a stale timestamp, another method and another path", async () => {
    const path = "/api/v1/projects";
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      signedHeaders("GET", path, user, { secret: "x".repeat(40) }),
      signedHeaders("GET", path, user, { nowSeconds: now - 120 }),
      signedHeaders("GET", path, user, { nowSeconds: now + 120 }),
      signedHeaders("POST", path, user),
      signedHeaders("GET", "/api/v1/me", user),
    ];
    for (const headers of bad)
      expect((await get(path, headers)).statusCode).toBe(403);
  });

  it("binds the signature to the pathname, not the query", async () => {
    // /docs/json is served without touching the database.
    const path = "/docs/json";
    const response = await get(`${path}?x=1`, signedHeaders("GET", path, user));
    expect(response.statusCode).toBe(200);
  });

  it("serves /health and /ready without a signature", async () => {
    expect((await get("/health")).statusCode).toBe(200);
    // /ready checks the database; without one it is 503, but never 403.
    expect((await get("/ready")).statusCode).not.toBe(403);
  });

  it("answers 401 to an anonymous identity on business routes", async () => {
    const response = await get(
      "/api/v1/me",
      signedHeaders("GET", "/api/v1/me"),
    );
    expect(response.statusCode).toBe(401);
    expect(
      (await get("/api/v1/projects", signedHeaders("GET", "/api/v1/projects")))
        .statusCode,
    ).toBe(401);
  });

  it("lets a signed user through the hook", async () => {
    // Anonymous is 401 on a business route; a user gets past the hook (here: the
    // validator answers 400 before any database access).
    const url = "/api/v1/projects/not-a-uuid/canvases/not-a-uuid";
    expect((await get(url, signedHeaders("GET", url, user))).statusCode).toBe(
      400,
    );
    expect((await get(url, signedHeaders("GET", url))).statusCode).toBe(401);
  });

  it("requires a signature on /docs", async () => {
    expect((await get("/docs/json")).statusCode).toBe(403);
    const response = await get(
      "/docs/json",
      signedHeaders("GET", "/docs/json"),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().openapi).toMatch(/^3/);
    expect(response.json().paths).toHaveProperty(
      "/api/v1/projects/{projectId}/canvases/{canvasId}/state",
    );
    expect(response.json().paths).toHaveProperty("/api/v1/projects");
    expect(response.json().paths).toHaveProperty("/api/v1/me");
    // Better Auth routes are not part of the product OpenAPI document.
    expect(Object.keys(response.json().paths)).not.toContain("/api/auth/*");
  });

  it("adds security headers", async () => {
    expect((await get("/health")).headers["x-content-type-options"]).toBe(
      "nosniff",
    );
  });

  it("rejects JSON payloads containing __proto__ on normal routes with 400", async () => {
    const path = "/api/v1/projects";
    const headers = signedHeaders("POST", path, user);
    headers["content-type"] = "application/json";
    const response = await app.inject({
      method: "POST",
      url: path,
      headers,
      payload: '{"name":"test","__proto__":{"polluted":true}}',
    });
    expect(response.statusCode).toBe(400);
  });

  describe("/api/auth/*", () => {
    it("requires a signature everywhere except GET /api/auth/jwks", async () => {
      for (const [method, url] of [
        ["GET", "/api/auth/get-session"],
        ["GET", "/api/auth/token"],
        ["POST", "/api/auth/sign-in/email"],
        ["POST", "/api/auth/sign-up/email"],
        ["POST", "/api/auth/sign-out"],
        ["GET", "/api/auth/callback/google"],
        // Lookalikes of the public route must stay signed.
        ["GET", "/api/auth/jwks/"],
        ["GET", "/api/auth/JWKS"],
        ["GET", "/api/auth/jwks/extra"],
        ["POST", "/api/auth/jwks"],
      ] as const) {
        const response = await app.inject({ method, url });
        expect(response.statusCode, `${method} ${url}`).toBe(403);
      }
    });

    it("does not require a signature for GET /api/auth/jwks", async () => {
      // With no database Better Auth answers an error, but the trust hook must not
      // answer 403. The 200 case is covered in auth.test.ts.
      const response = await get("/api/auth/jwks");
      expect(response.statusCode).not.toBe(403);
    });

    it("rejects methods Better Auth does not serve", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/auth/sign-out",
        headers: signedHeaders("DELETE", "/api/auth/sign-out"),
      });
      expect(response.statusCode).toBe(405);
    });
  });
});
