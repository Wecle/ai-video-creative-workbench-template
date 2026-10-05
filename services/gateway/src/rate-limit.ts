import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pathnameOf } from "@creative/contracts/internal-auth";

export type RateLimitTier =
  | "public"
  | "authStrict"
  | "authGeneral"
  | "apiPreAuth"
  | "api"
  | "realtimeConnect";

// Starting values, not capacity planning. Keep every number in this one place.
export const rateLimitTiers: Record<
  RateLimitTier,
  { max: number; timeWindow: string }
> = {
  public: { max: 120, timeWindow: "1 minute" }, // by IP
  authStrict: { max: 10, timeWindow: "1 minute" }, // by IP: credential endpoints
  authGeneral: { max: 60, timeWindow: "1 minute" }, // by IP: get-session, token, ...
  apiPreAuth: { max: 600, timeWindow: "1 minute" }, // by IP, before authentication
  api: { max: 300, timeWindow: "1 minute" }, // by user id, after authentication
  realtimeConnect: { max: 30, timeWindow: "1 minute" }, // by IP
};

// Credential-handling endpoints, checked against the routes Better Auth 1.7 registers.
// Anything not matched here (get-session, token, sign-out, callbacks, jwks) falls in
// authGeneral so that page loads and the periodic token refresh do not consume the
// brute-force budget.
const authStrictPath =
  /^\/api\/auth\/(sign-in|sign-up|request-password-reset|forget-password|reset-password|verify-password|change-password|set-password|change-email|send-verification-email)(\/|$)/;

export function isAuthStrict(method: string, url: string) {
  return method === "POST" && authStrictPath.test(pathnameOf(url));
}

export type Limiters = ReturnType<typeof createLimiters>;

// Tiers keyed by authenticated user id instead of client IP.
const userTiers = new Set<RateLimitTier>(["api"]);

/** Requires `@fastify/rate-limit` to be registered with `global: false`. */
export function createLimiters(app: FastifyInstance) {
  const checks = {} as Record<
    RateLimitTier,
    ReturnType<FastifyInstance["createRateLimit"]>
  >;
  for (const tier of Object.keys(rateLimitTiers) as RateLimitTier[]) {
    const { max, timeWindow } = rateLimitTiers[tier];
    // The tier is part of the key so tiers never share a counter.
    checks[tier] = app.createRateLimit({
      max,
      timeWindow,
      keyGenerator: (request) =>
        `${tier}:${userTiers.has(tier) ? (request.identity.userId ?? request.ip) : request.ip}`,
    });
  }

  /** Counts the request; when over the limit, sends 429 and returns true. */
  async function exceeded(
    tier: RateLimitTier,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const limit = await checks[tier](request);
    if (limit.isAllowed || !limit.isExceeded) return false;
    await reply
      .code(429)
      .header("retry-after", limit.ttlInSeconds)
      .send({ error: "Too many requests" });
    return true;
  }

  /** `onRequest` hook limiting by client IP. */
  const byIp =
    (tier: RateLimitTier) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (await exceeded(tier, request, reply)) return reply;
    };

  return { byIp, exceeded };
}
