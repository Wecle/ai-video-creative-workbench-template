import Fastify, {
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type GatewayOptions = {
  logger?: boolean;
  backendUrl?: string;
  fetcher?: typeof fetch;
};

function copyRequestHeaders(request: FastifyRequest) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (hopByHopHeaders.has(name.toLowerCase()) || value === undefined)
      continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function serializeBody(request: FastifyRequest) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  if (request.body === undefined) return undefined;
  if (typeof request.body === "string") return request.body;
  if (Buffer.isBuffer(request.body)) return request.body;
  return JSON.stringify(request.body);
}

async function proxyRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  backendUrl: string,
  fetcher: typeof fetch,
) {
  const target = new URL(request.url, backendUrl);
  let response: Response;
  try {
    response = await fetcher(target, {
      method: request.method,
      headers: copyRequestHeaders(request),
      body: serializeBody(request) as BodyInit | undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    request.log.error({ err: error }, "Backend request failed");
    return reply.code(502).send({ error: "Backend unavailable" });
  }

  for (const [name, value] of response.headers) {
    if (!hopByHopHeaders.has(name.toLowerCase())) reply.header(name, value);
  }
  return reply
    .code(response.status)
    .send(Buffer.from(await response.arrayBuffer()));
}

export function buildApp({
  logger = true,
  backendUrl = process.env.BACKEND_URL ?? "http://127.0.0.1:4001",
  fetcher = fetch,
}: GatewayOptions = {}) {
  const app = Fastify({
    logger,
    bodyLimit: 1024 * 1024,
    requestTimeout: 10000,
  });
  app.register(helmet, { contentSecurityPolicy: false });
  app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation)
      return reply.code(400).send({ error: "Invalid request" });
    const code = error.statusCode ?? 500;
    if (code >= 500) request.log.error({ err: error }, "Request failed");
    return reply
      .code(code)
      .send({ error: code >= 500 ? "Internal server error" : error.message });
  });

  app.register(async (instance) => {
    instance.get("/health", async () => ({
      status: "ok" as const,
      service: "gateway" as const,
    }));
    instance.get("/ready", async (_request, reply) => {
      try {
        const response = await fetcher(new URL("/health", backendUrl), {
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) throw new Error("Backend health check failed");
        return { status: "ready", dependencies: { backend: "ready" } };
      } catch (error) {
        reply.code(503);
        return {
          status: "not_ready",
          dependencies: { backend: "unavailable" },
          error: error instanceof Error ? error.message : "Backend unavailable",
        };
      }
    });

    const forward = (request: FastifyRequest, reply: FastifyReply) =>
      proxyRequest(request, reply, backendUrl, fetcher);
    instance.all("/api/v1/*", forward);
    instance.all("/docs", forward);
    instance.all("/docs/*", forward);
  });

  return app;
}
