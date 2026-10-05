import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { authRoutes } from "../src/auth/routes";
import type { Auth } from "../src/auth/auth";
import { WEB_ORIGIN } from "./helpers";

type Seen = {
  method: string;
  url: string;
  headers: Headers;
  body: Uint8Array;
};

/** Stand-in for Better Auth: records the Request it receives and replies with two cookies. */
async function build() {
  const seen: Seen[] = [];
  const auth = {
    handler: async (request: Request) => {
      seen.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: new Uint8Array(await request.arrayBuffer()),
      });
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "a=1; Path=/; HttpOnly");
      headers.append("set-cookie", "b=2; Path=/; Secure");
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers,
      });
    },
  } as unknown as Auth;
  const app = Fastify({ logger: false });
  await app.register(authRoutes, { auth, webOrigin: WEB_ORIGIN });
  return { app, seen };
}

describe("auth route bridge", () => {
  it("hands Better Auth a Request on the public origin without Host or internal headers", async () => {
    const { app, seen } = await build();
    await app.inject({
      method: "GET",
      url: "/api/auth/get-session?x=1",
      headers: {
        host: "backend:4001",
        "x-internal-user-id": "attacker",
        cookie: "session=abc",
      },
    });
    expect(seen[0]!.url).toBe(`${WEB_ORIGIN}/api/auth/get-session?x=1`);
    expect(seen[0]!.headers.get("host")).toBeNull();
    expect(seen[0]!.headers.get("x-internal-user-id")).toBeNull();
    expect(seen[0]!.headers.get("cookie")).toBe("session=abc");
    await app.close();
  });

  it("forwards JSON, form and binary bodies byte for byte", async () => {
    const { app, seen } = await build();
    const bodies: [string, Buffer][] = [
      ["application/json", Buffer.from('{"email":"a@example.test"}')],
      [
        "application/x-www-form-urlencoded",
        Buffer.from("email=a%40example.test&password=p%26q"),
      ],
      ["application/octet-stream", Buffer.from([0, 255, 1, 254, 10, 13, 128])],
    ];
    for (const [type, payload] of bodies) {
      await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { "content-type": type },
        payload,
      });
      expect(Buffer.from(seen.at(-1)!.body).equals(payload), type).toBe(true);
      expect(seen.at(-1)!.headers.get("content-type")).toBe(type);
    }
    await app.close();
  });

  it("delivers every Set-Cookie header and the upstream status", async () => {
    const { app } = await build();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["set-cookie"]).toEqual([
      "a=1; Path=/; HttpOnly",
      "b=2; Path=/; Secure",
    ]);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });
});
