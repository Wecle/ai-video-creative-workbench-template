import type { FastifyReply, FastifyRequest } from "fastify";
import {
  pathnameOf,
  verifyInternalIdentity,
  type InternalIdentity,
} from "@creative/contracts/internal-auth";

declare module "fastify" {
  interface FastifyRequest {
    /** Identity vouched for by the gateway's signature; set by `verifyGatewayIdentity`. */
    identity: InternalIdentity;
  }
  interface FastifyContextConfig {
    /** Reachable without a gateway signature (health checks, JWKS). */
    public?: boolean;
  }
}

/**
 * Root `onRequest` hook: every request must carry a valid gateway signature,
 * except routes marked `config: { public: true }`. A missing or invalid
 * signature means the caller is not the gateway, hence 403 (not 401).
 */
export function verifyGatewayIdentity(secret: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.routeOptions.config?.public === true) return;
    const result = verifyInternalIdentity({
      secret,
      method: request.method,
      pathname: pathnameOf(request.url),
      headers: request.headers,
    });
    if (!result.ok) {
      request.log.warn({ reason: result.reason }, "Rejected unsigned request");
      return reply.code(403).send({ error: "Forbidden" });
    }
    request.identity = result.identity;
  };
}

/** `onRequest` hook for business routes: a valid signature is not enough, a user is required. */
export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (request.identity?.authType !== "jwt")
    return reply.code(401).send({ error: "Unauthorized" });
}
