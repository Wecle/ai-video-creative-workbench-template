import { createHmac, timingSafeEqual } from "node:crypto";

// Server-only module: import via "@creative/contracts/internal-auth" (not re-exported
// from the package index so that node:crypto never reaches the web bundle).

export const AUTH_JWT_AUDIENCE = "creative-gateway";
export const INTERNAL_HEADER_PREFIX = "x-internal-";

export const INTERNAL_HEADERS = {
  authType: "x-internal-auth-type",
  userId: "x-internal-user-id",
  timestamp: "x-internal-ts",
  signature: "x-internal-sig",
} as const;

export const DEFAULT_MAX_SKEW_SECONDS = 30;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TIMESTAMP_PATTERN = /^\d{1,12}$/;
const SIGNATURE_BYTES = 32;

export type InternalIdentity =
  | { authType: "jwt"; userId: string }
  | { authType: "anonymous"; userId?: undefined };

export type HeaderBag = Record<string, string | string[] | undefined>;

export type VerifyFailureReason =
  "missing" | "malformed" | "stale" | "bad_signature";

export type VerifyResult =
  | { ok: true; identity: InternalIdentity }
  | { ok: false; reason: VerifyFailureReason };

export function isValidInternalUserId(value: string) {
  return USER_ID_PATTERN.test(value);
}

/** Path part of a request URL (query and fragment removed). */
export function pathnameOf(url: string) {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

function canonical(input: {
  method: string;
  pathname: string;
  timestamp: string;
  userId: string;
  authType: string;
}) {
  return [
    "v1",
    input.method.toUpperCase(),
    input.pathname,
    input.timestamp,
    input.userId,
    input.authType,
  ].join("\n");
}

function hmac(secret: string, message: string) {
  return createHmac("sha256", secret).update(message).digest();
}

export function signInternalIdentity(input: {
  secret: string;
  method: string;
  pathname: string;
  identity: InternalIdentity;
  nowSeconds?: number;
}): Record<string, string> {
  const { identity } = input;
  const userId = identity.userId ?? "";
  if (identity.authType === "jwt" && !isValidInternalUserId(userId))
    throw new Error("Invalid internal user id");
  const timestamp = String(input.nowSeconds ?? Math.floor(Date.now() / 1000));
  const signature = hmac(
    input.secret,
    canonical({
      method: input.method,
      pathname: input.pathname,
      timestamp,
      userId,
      authType: identity.authType,
    }),
  ).toString("base64url");
  const headers: Record<string, string> = {
    [INTERNAL_HEADERS.authType]: identity.authType,
    [INTERNAL_HEADERS.timestamp]: timestamp,
    [INTERNAL_HEADERS.signature]: signature,
  };
  if (identity.authType !== "anonymous")
    headers[INTERNAL_HEADERS.userId] = userId;
  return headers;
}

function single(headers: HeaderBag, name: string) {
  const value = headers[name];
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null; // null: repeated header
}

export function verifyInternalIdentity(input: {
  secret: string;
  method: string;
  pathname: string;
  headers: HeaderBag;
  nowSeconds?: number;
  maxSkewSeconds?: number;
}): VerifyResult {
  const authType = single(input.headers, INTERNAL_HEADERS.authType);
  const timestamp = single(input.headers, INTERNAL_HEADERS.timestamp);
  const signature = single(input.headers, INTERNAL_HEADERS.signature);
  const userId = single(input.headers, INTERNAL_HEADERS.userId);
  if (
    authType === undefined ||
    timestamp === undefined ||
    signature === undefined
  )
    return { ok: false, reason: "missing" };
  if (
    authType === null ||
    timestamp === null ||
    signature === null ||
    userId === null
  )
    return { ok: false, reason: "malformed" };
  if (authType !== "jwt" && authType !== "anonymous")
    return { ok: false, reason: "malformed" };
  if (!TIMESTAMP_PATTERN.test(timestamp))
    return { ok: false, reason: "malformed" };
  if (
    authType === "jwt" &&
    (userId === undefined || !USER_ID_PATTERN.test(userId))
  )
    return { ok: false, reason: "malformed" };
  if (authType === "anonymous" && userId !== undefined)
    return { ok: false, reason: "malformed" };

  const provided = Buffer.from(signature, "base64url");
  if (provided.length !== SIGNATURE_BYTES)
    return { ok: false, reason: "malformed" };

  const expected = hmac(
    input.secret,
    canonical({
      method: input.method,
      pathname: input.pathname,
      timestamp,
      userId: userId ?? "",
      authType,
    }),
  );
  if (!timingSafeEqual(provided, expected))
    return { ok: false, reason: "bad_signature" };

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = input.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  if (Math.abs(now - Number(timestamp)) > skew)
    return { ok: false, reason: "stale" };

  return {
    ok: true,
    identity:
      authType === "jwt"
        ? { authType, userId: userId as string }
        : { authType: "anonymous" },
  };
}
