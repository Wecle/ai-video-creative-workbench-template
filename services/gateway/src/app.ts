import Fastify, {
  type FastifyError,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import cors from "@fastify/cors";
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
import { realtimeTicketRequestSchema } from "@creative/contracts";
import { createJwtAuthenticator } from "./auth";
import {
  ANONYMOUS,
  signedHeadersOnly,
  stripInternalHeaders,
  upstreamHeaders,
} from "./identity";
import { createLimiters, isAuthStrict } from "./rate-limit";
import {
  consumeRealtimeTicket,
  issueRealtimeTicket,
  redactTicket,
  stripTicketQuery,
} from "./ticket";

export type GatewayOptions = {
  logger?: boolean;
  logStream?: NodeJS.WritableStream;
  backendUrl?: string;
  /** Shared secret used to sign the internal identity headers. */
  internalSecret: string;
  /** Shared secret used to sign and verify realtime connection tickets. */
  ticketSecret?: string;
  /** Gateway's own public base URL, returned in ticket responses. */
  gatewayPublicUrl?: string;
  /** Max connection lifetime for realtime connections in seconds. */
  realtimeMaxConnectionSeconds?: number;
  /** Allowed Web Origin. Default: http://localhost:3000 */
  webOrigin?: string;
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
  logStream,
  backendUrl = "http://127.0.0.1:4001",
  internalSecret,
  ticketSecret,
  gatewayPublicUrl = "http://localhost:4000",
  realtimeMaxConnectionSeconds = 3600,
  webOrigin = "http://localhost:3000",
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

  const reqSerializer = (req: {
    method?: string;
    url?: string;
    headers?: Record<string, unknown>;
    hostname?: string;
    ip?: string;
  }) => ({
    method: req.method,
    url: req.url ? redactTicket(req.url) : req.url,
    version:
      typeof req.headers?.["accept-version"] === "string"
        ? req.headers["accept-version"]
        : undefined,
    hostname: req.hostname,
    remoteAddress: req.ip,
  });

  const serverOptions: FastifyServerOptions = {
    logger: logStream
      ? {
          stream: logStream,
          serializers: { req: reqSerializer },
          redact: ["req.headers.authorization", "req.headers.cookie"],
        }
      : logger
        ? {
            serializers: { req: reqSerializer },
            redact: ["req.headers.authorization", "req.headers.cookie"],
          }
        : false,
    bodyLimit: 1024 * 1024,
    requestTimeout: requestMs,
    trustProxy,
    forceCloseConnections: true,
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

    // webhooks: external provider callbacks. No Bearer JWT required, public IP rate-limited.
    await root.register(async (scope) => {
      scope.addHook("onRequest", limiters.byIp("public"));
      await scope.register(httpProxy, apiProxy("/api/webhooks", false));
    });

    // protected: business API. Bearer JWT required; limited per user once known.
    await root.register(async (scope) => {
      scope.addHook("onRequest", limiters.byIp("apiPreAuth"));
      scope.addHook("preHandler", async (request, reply) => {
        const denied = await authenticate(request, reply);
        if (denied) return denied;
        if (await limiters.exceeded("api", request, reply)) return reply;
      });

      scope.post("/api/v1/realtime-tickets", async (request, reply) => {
        if (await limiters.exceeded("realtimeTicket", request, reply)) {
          return reply;
        }
        if (!redis) {
          return reply
            .code(503)
            .send({ error: "Realtime ticket service unavailable" });
        }
        if (!ticketSecret) {
          return reply
            .code(500)
            .send({ error: "Ticket secret is not configured" });
        }
        const parsed = realtimeTicketRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "Invalid request body" });
        }
        const userId = request.identity.userId!;
        const ticketResponse = await issueRealtimeTicket({
          secret: ticketSecret,
          userId,
          runId: "runId" in parsed.data ? parsed.data.runId : undefined,
          agentRunId:
            "agentRunId" in parsed.data ? parsed.data.agentRunId : undefined,
          baseUrl: gatewayPublicUrl,
        });
        return reply.code(200).send(ticketResponse);
      });

      await scope.register(httpProxy, apiProxy("/api/v1", true));
    });

    // realtime: SSE and WebSocket pass-through, a sibling of protected (not nested).
    await root.register(async (scope) => {
      await scope.register(cors, {
        origin: [webOrigin],
        methods: ["GET"],
        credentials: false,
        preflight: false,
      });

      scope.addHook("onRequest", limiters.byIp("realtimeConnect"));

      scope.addHook("onRequest", async (request, reply) => {
        const origin = request.headers.origin;
        if (origin !== undefined && origin !== webOrigin) {
          return reply.code(403).send({ error: "Forbidden origin" });
        }

        const maxMs = realtimeMaxConnectionSeconds * 1000;
        const timer = setTimeout(() => {
          request.raw.socket.destroy();
        }, maxMs).unref();
        request.raw.on("close", () => {
          clearTimeout(timer);
        });
      });

      scope.addHook("preHandler", async (request, reply) => {
        if (request.headers.authorization !== undefined) {
          return authenticate(request, reply);
        }

        const urlObj = new URL(request.url, "http://localhost");
        const ticketParams = urlObj.searchParams.getAll("ticket");
        if (ticketParams.length !== 1 || !ticketParams[0]) {
          return reply
            .code(401)
            .header("www-authenticate", 'Bearer error="invalid_token"')
            .send({ error: "Missing or invalid realtime ticket" });
        }

        if (!ticketSecret) {
          return reply
            .code(500)
            .send({ error: "Ticket secret is not configured" });
        }

        const result = await consumeRealtimeTicket({
          secret: ticketSecret,
          ticket: ticketParams[0],
          pathname: pathnameOf(request.url),
          redis,
        });

        if (!result.ok) {
          if (result.code === 401) {
            reply.header("www-authenticate", 'Bearer error="invalid_token"');
          }
          return reply.code(result.code).send({ error: result.error });
        }

        request.identity = { authType: "ticket", userId: result.userId };
      });

      const baseRealtimeProxy = proxyOptions({
        prefix: REALTIME_PREFIX,
        dropCredentials: true,
        // SSE: no idle limit between chunks; only the first byte is bounded.
        headersTimeoutMs: 30_000,
        bodyTimeoutMs: 0,
      });

      await scope.register(httpProxy, {
        ...baseRealtimeProxy,
        replyOptions: {
          ...baseRealtimeProxy.replyOptions,
          queryString: (_search: string | undefined, reqUrl: string) =>
            stripTicketQuery(reqUrl),
        },
        websocket: true,
        wsClientOptions: {
          rewriteRequestHeaders: (_headers: unknown, request: FastifyRequest) =>
            signedHeadersOnly(internalSecret, request),
          queryString: (_search: unknown, reqUrl: string) =>
            stripTicketQuery(reqUrl),
        } as NonNullable<HttpProxyOptions["wsClientOptions"]>,
      });
    });
  });

  return app;
}
