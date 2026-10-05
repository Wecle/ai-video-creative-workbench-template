import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import postgres from "postgres";
import { schema } from "@creative/database";
import { meResponseSchema } from "@creative/contracts";
import { AUTH_JWT_AUDIENCE } from "@creative/contracts/internal-auth";
import {
  createTestApp,
  signedHeaders,
  testDatabaseUrl,
  WEB_ORIGIN,
} from "./helpers";

const databaseUrl = testDatabaseUrl();
const password = "password-1234";
const randomEmail = () => `p0a-${randomUUID()}@example.test`;

describe.skipIf(!databaseUrl)("auth integration (Postgres)", () => {
  const ctx = createTestApp(databaseUrl);
  const { app, db } = ctx;
  const admin = postgres(databaseUrl!, { max: 1 });
  beforeAll(async () => {
    // jwks private keys are encrypted with BETTER_AUTH_SECRET; a key left behind by a
    // run with another secret would make every token request fail with a 500.
    await admin`delete from jwks`;
    await app.ready();
  });
  afterAll(async () => {
    await ctx.close();
    await admin.end({ timeout: 5 });
  });

  /** A request as the gateway would forward it: anonymous identity plus the browser's Origin. */
  const authRequest = (
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; cookie?: string; origin?: string } = {},
  ) =>
    app.inject({
      method,
      url: path,
      headers: {
        ...signedHeaders(method, path),
        origin: options.origin ?? WEB_ORIGIN,
        ...(options.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      payload:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });

  const cookieOf = (response: Awaited<ReturnType<typeof authRequest>>) =>
    [response.headers["set-cookie"] ?? []]
      .flat()
      .map((c) => c.split(";")[0])
      .join("; ");

  async function signUp(email = randomEmail(), name = "Smoke Tester") {
    const response = await authRequest("POST", "/api/auth/sign-up/email", {
      body: { name, email, password },
    });
    return { email, response, cookie: cookieOf(response) };
  }

  it("signs up: creates the user, a personal workspace (owner) and a session cookie", async () => {
    const { email, response } = await signUp();
    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeDefined();
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email));
    expect(user).toBeDefined();
    const memberships = await db
      .select({
        role: schema.workspace_members.role,
        slug: schema.workspaces.slug,
        name: schema.workspaces.name,
      })
      .from(schema.workspace_members)
      .innerJoin(
        schema.workspaces,
        eq(schema.workspace_members.workspace_id, schema.workspaces.id),
      )
      .where(eq(schema.workspace_members.userId, user!.id));
    expect(memberships).toEqual([
      {
        role: "owner",
        slug: `ws-${user!.id}`,
        name: "Smoke Tester's workspace",
      },
    ]);
  });

  it("rejects a wrong password and a duplicate email", async () => {
    const { email } = await signUp();
    const wrong = await authRequest("POST", "/api/auth/sign-in/email", {
      body: { email, password: "not-the-password" },
    });
    expect(wrong.statusCode).toBe(401);
    const ok = await authRequest("POST", "/api/auth/sign-in/email", {
      body: { email, password },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["set-cookie"]).toBeDefined();
    const duplicate = await authRequest("POST", "/api/auth/sign-up/email", {
      body: { name: "Again", email, password },
    });
    expect(duplicate.statusCode).toBeGreaterThanOrEqual(400);
    expect(duplicate.statusCode).toBeLessThan(500);
  });

  it("accepts application/x-www-form-urlencoded as well as JSON (R3)", async () => {
    const { email } = await signUp();
    const path = "/api/auth/sign-in/email";
    const response = await app.inject({
      method: "POST",
      url: path,
      headers: {
        ...signedHeaders("POST", path),
        origin: WEB_ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams({ email, password }).toString(),
    });
    expect(response.statusCode).toBe(200);
  });

  it("checks Origin against the web origin, independent of the backend Host (R3)", async () => {
    // Better Auth's CSRF check applies to requests that carry a session cookie.
    const { cookie } = await signUp();
    const evil = await authRequest("POST", "/api/auth/sign-out", {
      body: {},
      cookie,
      origin: "https://evil.example",
    });
    expect(evil.statusCode).toBe(403);
    const good = await authRequest("POST", "/api/auth/sign-out", {
      body: {},
      cookie,
    });
    expect(good.statusCode).toBe(200);
  });

  it("issues a JWT that verifies against the public JWKS", async () => {
    const { cookie } = await signUp();
    const tokenResponse = await authRequest("GET", "/api/auth/token", {
      cookie,
    });
    expect(tokenResponse.statusCode).toBe(200);
    const { token } = tokenResponse.json() as { token: string };

    // The gateway fetches the JWKS without a signature.
    const jwksResponse = await app.inject({
      method: "GET",
      url: "/api/auth/jwks",
    });
    expect(jwksResponse.statusCode).toBe(200);
    const keys = createLocalJWKSet(jwksResponse.json());
    const { payload, protectedHeader } = await jwtVerify(token, keys, {
      issuer: WEB_ORIGIN,
      audience: AUTH_JWT_AUDIENCE,
      algorithms: ["EdDSA"],
    });
    expect(protectedHeader.alg).toBe("EdDSA");
    const [user] = await db.select().from(schema.users).limit(1);
    expect(user).toBeDefined();
    expect(payload.sub).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.exp! - payload.iat!).toBe(600);
    // R1: an empty definePayload keeps user fields out of the token.
    expect(Object.keys(decodeJwt(token)).sort()).toEqual(
      ["aud", "exp", "iat", "iss", "sub"].sort(),
    );
  });

  it("returns no token without a session", async () => {
    const response = await authRequest("GET", "/api/auth/token");
    expect(response.statusCode).toBe(401);
  });

  describe("GET /api/v1/me", () => {
    it("returns the signed user and their personal workspace", async () => {
      const { email, cookie } = await signUp(randomEmail(), "Mia");
      const { token } = (
        await authRequest("GET", "/api/auth/token", { cookie })
      ).json() as { token: string };
      const sub = decodeJwt(token).sub!;
      const path = "/api/v1/me";
      const response = await app.inject({
        method: "GET",
        url: path,
        headers: signedHeaders("GET", path, { authType: "jwt", userId: sub }),
      });
      expect(response.statusCode).toBe(200);
      const body = meResponseSchema.parse(response.json());
      expect(body.user).toMatchObject({ id: sub, name: "Mia", email });
      expect(body.workspaces).toEqual([
        {
          id: expect.any(String),
          name: "Mia's workspace",
          slug: `ws-${sub}`,
          role: "owner",
        },
      ]);
    });

    it("answers 401 for a well-formed user id that does not exist", async () => {
      const path = "/api/v1/me";
      const response = await app.inject({
        method: "GET",
        url: path,
        headers: signedHeaders("GET", path, {
          authType: "jwt",
          userId: randomUUID(),
        }),
      });
      expect(response.statusCode).toBe(401);
    });
  });

  it("answers /ready from the database", async () => {
    const response = await app.inject("/ready");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ready",
      dependencies: { database: "ready" },
    });
  });

  // R16: what happens to the user when creating the personal workspace fails.
  describe("personal workspace creation fails (R16)", () => {
    const trigger = `r16_fail_${randomUUID().slice(0, 8)}`;
    beforeAll(async () => {
      await admin.unsafe(`
        create function ${trigger}() returns trigger language plpgsql as $$
        begin
          if new.name like 'r16-fail-%' then raise exception 'r16 injected failure'; end if;
          return new;
        end $$`);
      await admin.unsafe(
        `create trigger ${trigger} before insert on workspaces
         for each row execute function ${trigger}()`,
      );
    });
    afterAll(async () => {
      await admin.unsafe(`drop trigger if exists ${trigger} on workspaces`);
      await admin.unsafe(`drop function if exists ${trigger}()`);
    });

    it("leaves a user without a workspace: sign-up answers 500, no transaction (R16)", async () => {
      const email = randomEmail();
      const response = await authRequest("POST", "/api/auth/sign-up/email", {
        body: { name: "r16-fail-user", email, password },
      });
      // The `after` hook is not part of the user insert's transaction.
      expect(response.statusCode).toBe(500);
      expect(response.headers["set-cookie"]).toBeUndefined();
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email));
      expect(user).toBeDefined();
      const members = await db
        .select()
        .from(schema.workspace_members)
        .where(eq(schema.workspace_members.userId, user!.id));
      expect(members).toEqual([]);

      // The credential account exists, so the user can still sign in, and /me
      // reports an empty workspace list instead of failing (plan R16 fallback).
      const signIn = await authRequest("POST", "/api/auth/sign-in/email", {
        body: { email, password },
      });
      expect(signIn.statusCode).toBe(200);
      const path = "/api/v1/me";
      const me = await app.inject({
        method: "GET",
        url: path,
        headers: signedHeaders("GET", path, {
          authType: "jwt",
          userId: user!.id,
        }),
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().workspaces).toEqual([]);
    });
  });
});
