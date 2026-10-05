import Fastify, {
  type FastifyError,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import helmet from "@fastify/helmet";
import httpProxy, {
  type FastifyHttpProxyOptions as HttpProxyOptions,
} from "@fastify/http-proxy";
import rateLimit from "@fastify/rate-limit";
import type { Redis } from "ioredis";
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import {
  AUTH_JWT_AUDIENCE,
  pathnameOf,
} from "@creative/contracts/internal-auth";
import { createJwtAuthenticator } from "./auth";
import {
  ANONYMOUS,
  signedHeadersOnly,
  stripInternalHeaders,
  upstreamHeaders,
} from "./identity";
import { createLimiters, isAuthStrict } from "./rate-limit";

export type GatewayOptions = {
  logger?: boolean;
  backendUrl?: string;
  /** Shared secret used to sign the internal identity headers. */
  internalSecret: string;
  /** Used by `/ready` only; proxying goes through @fastify/http-proxy. */
  fetcher?: typeof fetch;
  /** JWT key resolver. Default: the backend's JWKS endpoint, fetched on demand and cached by jose. */
  getKey?: JWTVerifyGetKey;
  /** Expected `iss` and `aud` of access tokens. */
  jwt?: { issuer: string; audience: string };
  /** Missing: in-memory rate limiting (non-production only). */
  redis?: Redis;
  /** Redis key prefix for rate-limit counters; tests use a random one. */
  rateLimitNamespace?: string;
  trustProxy?: boolean | string | string[];
  timeouts?: { requestMs?: number; proxyMs?: number };
};

const REALTIME_PREFIX = "/api/v1/realtime";

function isRealtimePath(url: string) {
  const pathname = pathnameOf(url);
  return (
    pathname === REALTIME_PREFIX || pathname.startsWith(`${REALTIME_PREFIX}/`)
  );
}

export function buildApp({
  logger = true,
  backendUrl = "http://127.0.0.1:4001",
  internalSecret,
  fetcher = fetch,
  getKey,
  jwt = { issuer: "http://localhost:3000", audience: AUTH_JWT_AUDIENCE },
  redis,
  rateLimitNamespace = "gw:rl:",
  trustProxy = false,
  timeouts = {},
}: GatewayOptions) {
  // The JWKS lives on the backend's internal address, not behind Next or the public
  // origin. The three values are set explicitly instead of relying on jose defaults.
  const resolveKey =
    getKey ??
    createRemoteJWKSet(new URL("/api/auth/jwks", backendUrl), {
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
      timeoutDuration: 5_000,
    });
  const authenticate = createJwtAuthenticator({ getKey: resolveKey, ...jwt });
  const requestMs = timeouts.requestMs ?? 10000;
  const proxyMs = timeouts.proxyMs ?? 10000;
  const serverOptions: FastifyServerOptions = {
    logger: logger
      ? { redact: ["req.headers.authorization", "req.headers.cookie"] }
      : false,
    bodyLimit: 1024 * 1024,
    requestTimeout: requestMs,
    trustProxy,
  };
  const app = Fastify(serverOptions);

  app.decorateRequest("identity");
  // Must stay the first onRequest hook: nothing may read a client-supplied
  // x-internal-* header, and every request starts out anonymous.
  app.addHook("onRequest", async (request, reply) => {
    stripInternalHeaders(request.headers);
    request.identity = ANONYMOUS;
    // Only the realtime proxy owns WebSocket upgrades. Upgrading anywhere else
    // would be hijacked by @fastify/http-proxy and then left hanging.
    if (request.headers.upgrade !== undefined && !isRealtimePath(request.url))
      return reply.code(426).send({ error: "Upgrade not supported" });
  });

  app.register(helmet, { contentSecurityPolicy: false });
  app.register(rateLimit, {
    global: false,
    nameSpace: rateLimitNamespace,
    skipOnError: true,
    ...(redis ? { redis } : {}),
  });
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation)
      return reply.code(400).send({ error: "Invalid request" });
    const code = error.statusCode ?? 500;
    if (code >= 500) request.log.error({ err: error }, "Request failed");
    return reply
      .code(code)
      .send({ error: code >= 500 ? "Internal server error" : error.message });
  });

  type ProxyScope = {
    prefix: string;
    /** Protected scopes never forward the JWT or the session cookie. */
    dropCredentials: boolean;
    headersTimeoutMs: number;
    bodyTimeoutMs: number;
  };
  const proxyOptions = ({
    prefix,
    dropCredentials,
    headersTimeoutMs,
    bodyTimeoutMs,
  }: ProxyScope): HttpProxyOptions => ({
    upstream: backendUrl,
    prefix,
    // Without this @fastify/http-proxy strips the prefix before forwarding.
    rewritePrefix: prefix,
    undici: { headersTimeout: headersTimeoutMs, bodyTimeout: bodyTimeoutMs },
    replyOptions: {
      rewriteRequestHeaders: (request, headers) =>
        upstreamHeaders(internalSecret, request, headers, { dropCredentials }),
      // Never replay a request on 503: it already carries a signed identity.
      retryDelay: () => null,
      onError: (reply, { error }) => {
        const status =
          (error as { statusCode?: number }).statusCode === 504 ? 504 : 502;
        reply.code(status).send({
          error: status === 504 ? "Backend timeout" : "Backend unavailable",
        });
      },
    },
  });
  const apiProxy = (prefix: string, dropCredentials: boolean) =>
    proxyOptions({
      prefix,
      dropCredentials,
      headersTimeoutMs: proxyMs,
      bodyTimeoutMs: proxyMs,
    });

  // Register routes after the plugins above so their hooks and decorators exist.
  app.register(async (root) => {
    const limiters = createLimiters(root);

    // public: health, readiness and API docs.
    await root.register(async (scope) => {
      scope.addHook("onRequest", limiters.byIp("public"));
      scope.get("/health", async () => ({
        status: "ok" as const,
        service: "gateway" as const,
      }));
      scope.get("/ready", async (_request, reply) => {
        const dependencies = {
          backend: "unavailable",
          redis: redis ? "unavailable" : "unused",
        };
        let error: string | undefined;
        try {
          const response = await fetcher(new URL("/health", backendUrl), {
            signal: AbortSignal.timeout(3000),
          });
          if (!response.ok) throw new Error("Backend health check failed");
          dependencies.backend = "ready";
        } catch (cause) {
          error =
            cause instanceof Error ? cause.message : "Backend unavailable";
        }
        if (redis) {
          try {
            await redis.ping();
            dependencies.redis = "ready";
          } catch (cause) {
            error ??=
              cause instanceof Error ? cause.message : "Redis unavailable";
          }
        }
        if (error) {
          reply.code(503);
          return { status: "not_ready", dependencies, error };
        }
        return { status: "ready", dependencies };
      });
      await scope.register(httpProxy, apiProxy("/docs", false));
    });

    // auth: Better Auth lives in the backend; no JWT exists before login.
    await root.register(async (scope) => {
      scope.addHook("onRequest", async (request, reply) => {
        const strict = isAuthStrict(request.method, request.url);
        if (
          await limiters.exceeded(
            strict ? "authStrict" : "authGeneral",
            request,
            reply,
          )
        )
          return reply;
      });
      await scope.register(httpProxy, apiProxy("/api/auth", false));
    });

    // protected: business API. Bearer JWT required; limited per user once known.
    await root.register(async (scope) => {
      scope.addHook("onRequest", limiters.byIp("apiPreAuth"));
      scope.addHook("preHandler", async (request, reply) => {
        const denied = await authenticate(request, reply);
        if (denied) return denied;
        if (await limiters.exceeded("api", request, reply)) return reply;
      });
      await scope.register(httpProxy, apiProxy("/api/v1", true));
    });

    // realtime: SSE and WebSocket pass-through, a sibling of protected (not nested).
    await root.register(async (scope) => {
      scope.addHook("onRequest", limiters.byIp("realtimeConnect"));
      // Same verification as protected; browsers cannot send this header, so
      // ticket-based access is planned together with the realtime module.
      scope.addHook("preHandler", authenticate);
      await scope.register(httpProxy, {
        ...proxyOptions({
          prefix: REALTIME_PREFIX,
          dropCredentials: true,
          // SSE: no idle limit between chunks; only the first byte is bounded.
          headersTimeoutMs: 30_000,
          bodyTimeoutMs: 0,
        }),
        websocket: true,
        // The upstream WebSocket headers come only from this function. The
        // typings omit rewriteRequestHeaders, but the runtime reads it.
        wsClientOptions: {
          rewriteRequestHeaders: (_headers: unknown, request: FastifyRequest) =>
            signedHeadersOnly(internalSecret, request),
        } as NonNullable<HttpProxyOptions["wsClientOptions"]>,
      });
    });
  });

  return app;
}
