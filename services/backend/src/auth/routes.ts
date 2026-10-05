import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Auth } from "./auth";
import { INTERNAL_HEADER_PREFIX } from "@creative/contracts/internal-auth";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding"]);

type AuthRoutesOptions = {
  auth: Auth;
  /** Origin the browser sees; Better Auth matches routes and checks `Origin` against it. */
  webOrigin: string;
};

/**
 * Mounts Better Auth under /api/auth/*. Registers its own content-type parser so
 * the request body reaches Better Auth as the original bytes (JSON, form, anything).
 */
export async function authRoutes(
  app: FastifyInstance,
  { auth, webOrigin }: AuthRoutesOptions,
) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) =>
    done(null, body),
  );

  async function handle(request: FastifyRequest, reply: FastifyReply) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      // Host is the backend's own; the URL below carries the public origin.
      if (name === "host" || name.startsWith(INTERNAL_HEADER_PREFIX)) continue;
      if (Array.isArray(value)) for (const v of value) headers.append(name, v);
      else if (value !== undefined) headers.set(name, value);
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const response = await auth.handler(
      new Request(new URL(request.raw.url ?? "/", webOrigin), {
        method: request.method,
        headers,
        body:
          hasBody && Buffer.isBuffer(request.body) && request.body.length > 0
            ? new Uint8Array(request.body)
            : undefined,
      }),
    );
    reply.code(response.status);
    for (const [name, value] of response.headers) {
      if (name === "set-cookie" || HOP_BY_HOP.has(name)) continue;
      reply.header(name, value);
    }
    // Headers#forEach joins cookies; getSetCookie keeps each one separate.
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) reply.header("set-cookie", cookies);
    return reply.send(Buffer.from(await response.arrayBuffer()));
  }

  // Route-level `public`: the gateway fetches signing keys without a signature
  // (its signed headers carry a timestamp, so a static header cannot stand in).
  // The JWKS is public key material only. Every other /api/auth/* route is signed.
  app.route({
    method: "GET",
    url: "/api/auth/jwks",
    config: { public: true },
    schema: { hide: true },
    handler: handle,
  });
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    schema: { hide: true },
    handler: handle,
  });
  // Better Auth only serves GET and POST.
  app.route({
    method: ["PUT", "PATCH", "DELETE"],
    url: "/api/auth/*",
    schema: { hide: true },
    handler: async (_request, reply) =>
      reply
        .code(405)
        .header("allow", "GET, POST")
        .send({ error: "Method not allowed" }),
  });
}
