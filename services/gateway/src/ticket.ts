import { randomBytes } from "node:crypto";
import type Redis from "ioredis";
import { type JWTPayload, jwtVerify, SignJWT } from "jose";
import {
  REALTIME_TICKET_AUDIENCE,
  REALTIME_TICKET_ISSUER,
  REALTIME_TICKET_TTL_SECONDS,
} from "@creative/contracts/internal-auth";
import type { RealtimeTicketResponse } from "@creative/contracts";

// Path: /api/v1/realtime/runs/<uuid>/... -> run:<uuid>
const RUN_RESOURCE_REGEX =
  /^\/api\/v1\/realtime\/runs\/([0-9a-fA-F-]{36})(?:\/|$)/;

export function extractResourceFromPath(pathname: string): string | null {
  const match = RUN_RESOURCE_REGEX.exec(pathname);
  if (!match) return null;
  return `run:${match[1]}`;
}

export async function issueRealtimeTicket(options: {
  secret: string;
  userId: string;
  runId: string;
  baseUrl: string;
}): Promise<RealtimeTicketResponse> {
  const jti = randomBytes(16).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const secretKey = new TextEncoder().encode(options.secret);
  const ticket = await new SignJWT({
    res: `run:${options.runId}`,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(REALTIME_TICKET_ISSUER)
    .setAudience(REALTIME_TICKET_AUDIENCE)
    .setSubject(options.userId)
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(now + REALTIME_TICKET_TTL_SECONDS)
    .sign(secretKey);

  return {
    ticket,
    expiresIn: REALTIME_TICKET_TTL_SECONDS,
    baseUrl: options.baseUrl,
  };
}

export type ConsumeTicketResult =
  | { ok: true; userId: string }
  | { ok: false; code: 401 | 403 | 503; error: string };

export async function consumeRealtimeTicket(options: {
  secret: string;
  ticket: string;
  pathname: string;
  redis: Redis | undefined;
}): Promise<ConsumeTicketResult> {
  const secretKey = new TextEncoder().encode(options.secret);
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(options.ticket, secretKey, {
      issuer: REALTIME_TICKET_ISSUER,
      audience: REALTIME_TICKET_AUDIENCE,
      algorithms: ["HS256"],
      clockTolerance: 5,
    });
    payload = verified.payload;
  } catch {
    return { ok: false, code: 401, error: "Invalid ticket" };
  }

  const { sub: userId, jti, res } = payload as {
    sub?: string;
    jti?: string;
    res?: string;
  };
  if (!userId || !jti || typeof res !== "string") {
    return { ok: false, code: 401, error: "Invalid ticket claims" };
  }

  const expectedResource = extractResourceFromPath(options.pathname);
  if (!expectedResource || expectedResource !== res) {
    return { ok: false, code: 403, error: "Ticket resource mismatch" };
  }

  if (!options.redis) {
    return {
      ok: false,
      code: 503,
      error: "Realtime ticket service unavailable",
    };
  }

  // Atomically consume ticket: SET gw:ticket:<jti> 1 EX 60 NX
  try {
    const result = await options.redis.set(
      `gw:ticket:${jti}`,
      "1",
      "EX",
      60,
      "NX",
    );
    if (!result) {
      return { ok: false, code: 401, error: "Ticket already used" };
    }
  } catch {
    // Redis error -> fail-closed with 503
    return { ok: false, code: 503, error: "Failed to verify ticket" };
  }

  return { ok: true, userId };
}

export function redactTicket(url: string): string {
  return url.replace(/([?&]ticket=)[^&]*/g, "$1[redacted]");
}

export function stripTicketQuery(reqUrl: string): string {
  const qIndex = reqUrl.indexOf("?");
  if (qIndex === -1) return "";
  const search = reqUrl.slice(qIndex + 1);
  const params = new URLSearchParams(search);
  params.delete("ticket");
  return params.toString();
}
