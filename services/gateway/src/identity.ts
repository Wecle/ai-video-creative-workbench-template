import type { FastifyRequest } from "fastify";
import {
  INTERNAL_HEADER_PREFIX,
  pathnameOf,
  signInternalIdentity,
  type InternalIdentity,
} from "@creative/contracts/internal-auth";

declare module "fastify" {
  interface FastifyRequest {
    /** Identity the gateway vouches for; `anonymous` until a scope authenticates the request. */
    identity: InternalIdentity;
  }
}

export const ANONYMOUS: InternalIdentity = { authType: "anonymous" };

/** Remove every client-supplied `x-internal-*` header before anything else can read it. */
export function stripInternalHeaders(headers: FastifyRequest["headers"]) {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase().startsWith(INTERNAL_HEADER_PREFIX))
      delete headers[name];
  }
}

type HeaderBag = Record<string, string | string[] | undefined>;

// Structural so it accepts the request type @fastify/http-proxy hands to its hooks.
type IdentityRequest = Pick<
  FastifyRequest,
  "method" | "url" | "ip" | "identity"
>;

function sign(secret: string, request: IdentityRequest) {
  return signInternalIdentity({
    secret,
    method: request.method,
    pathname: pathnameOf(request.url),
    identity: request.identity,
  });
}

/**
 * Headers sent to the upstream over HTTP: the client's headers minus anything
 * internal, `x-forwarded-for` replaced by the address the gateway computed,
 * plus the signed identity. Protected scopes also drop credentials so the
 * backend never sees the JWT or the session cookie.
 */
export function upstreamHeaders(
  secret: string,
  request: IdentityRequest,
  headers: HeaderBag,
  options: { dropCredentials: boolean },
) {
  const out: HeaderBag = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith(INTERNAL_HEADER_PREFIX)) continue;
    if (lower === "x-forwarded-for") continue;
    if (
      options.dropCredentials &&
      (lower === "authorization" || lower === "cookie")
    )
      continue;
    out[name] = value;
  }
  out["x-forwarded-for"] = request.ip;
  return { ...out, ...sign(secret, request) };
}

/**
 * WebSocket upstream headers are built from scratch: nothing the client sent
 * is copied, only the signed identity and the client address.
 */
export function signedHeadersOnly(secret: string, request: IdentityRequest) {
  return { "x-forwarded-for": request.ip, ...sign(secret, request) };
}
