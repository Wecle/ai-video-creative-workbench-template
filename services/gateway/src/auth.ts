import type { FastifyReply, FastifyRequest } from "fastify";
import { errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { isValidInternalUserId } from "@creative/contracts/internal-auth";

export type JwtAuthOptions = {
  /** Key resolver: `createRemoteJWKSet` in production, a local JWKS in tests. */
  getKey: JWTVerifyGetKey;
  issuer: string;
  audience: string;
};

// Better Auth's JWT plugin signs with EdDSA by default. Pinning the algorithm
// prevents algorithm-confusion attacks (e.g. HS256 keyed with the public key).
const ALGORITHMS = ["EdDSA"];
const BEARER = /^Bearer +([^\s]+)$/i;

/**
 * jose errors that say "this token is bad". Everything else (a TypeError from a
 * failed fetch, JWKSTimeout, a generic JOSEError for a non-200 or non-JSON JWKS
 * response, JWKSInvalid) means the gateway could not obtain keys: that is an
 * outage on our side, not an invalid credential, and must not look like a 401.
 */
export function isInvalidTokenError(error: unknown) {
  return (
    error instanceof errors.JWTExpired ||
    error instanceof errors.JWTClaimValidationFailed ||
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JOSENotSupported ||
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys
  );
}

function unauthorized(reply: FastifyReply) {
  return reply
    .code(401)
    .header("www-authenticate", 'Bearer error="invalid_token"')
    .send({ error: "Unauthorized" });
}

/**
 * Hook factory shared by the protected and realtime scopes: accepts only
 * `Authorization: Bearer <JWT>`, verifies it against the JWKS and stores the
 * user on `request.identity` so the proxy signs it for the backend.
 */
export function createJwtAuthenticator({
  getKey,
  issuer,
  audience,
}: JwtAuthOptions) {
  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const header = request.headers.authorization;
    const token = header ? BEARER.exec(header)?.[1] : undefined;
    if (!token) return unauthorized(reply);
    try {
      const { payload } = await jwtVerify(token, getKey, {
        issuer,
        audience,
        algorithms: ALGORITHMS,
        clockTolerance: 5,
      });
      if (
        typeof payload.sub !== "string" ||
        !isValidInternalUserId(payload.sub)
      )
        return unauthorized(reply);
      request.identity = { authType: "jwt", userId: payload.sub };
    } catch (error) {
      if (isInvalidTokenError(error)) return unauthorized(reply);
      request.log.error({ err: error }, "JWKS unavailable");
      return reply
        .code(503)
        .send({ error: "Authentication service unavailable" });
    }
  };
}
