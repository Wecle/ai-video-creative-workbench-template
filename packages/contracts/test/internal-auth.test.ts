import { describe, expect, it } from "vitest";
import {
  INTERNAL_HEADERS,
  pathnameOf,
  signInternalIdentity,
  verifyInternalIdentity,
} from "../src/internal-auth";

const secret = "test-internal-secret-0123456789abcdef";
const now = 1_800_000_000;
const base = { method: "GET", pathname: "/api/v1/me", nowSeconds: now };
const user = { authType: "jwt", userId: "user_123-ABC" } as const;

function sign(
  overrides: Partial<Parameters<typeof signInternalIdentity>[0]> = {},
) {
  return signInternalIdentity({
    secret,
    identity: user,
    ...base,
    ...overrides,
  });
}

function verify(
  headers: Record<string, string | string[] | undefined>,
  overrides: Partial<Parameters<typeof verifyInternalIdentity>[0]> = {},
) {
  return verifyInternalIdentity({ secret, headers, ...base, ...overrides });
}

describe("internal identity headers", () => {
  it("round-trips a user identity", () => {
    expect(verify(sign())).toEqual({ ok: true, identity: user });
  });

  it("round-trips an anonymous identity without a user id header", () => {
    const headers = sign({ identity: { authType: "anonymous" } });
    expect(headers[INTERNAL_HEADERS.userId]).toBeUndefined();
    expect(verify(headers)).toEqual({
      ok: true,
      identity: { authType: "anonymous" },
    });
  });

  it("is case-insensitive about the method", () => {
    expect(verify(sign({ method: "post" }), { method: "POST" }).ok).toBe(true);
  });

  it.each([
    ["method", { method: "POST" }],
    ["pathname", { pathname: "/api/v1/other" }],
  ])("rejects a changed %s", (_name, change) => {
    expect(verify(sign(), change)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects tampered timestamp, user id and auth type", () => {
    const headers = sign();
    expect(
      verify({ ...headers, [INTERNAL_HEADERS.timestamp]: String(now + 1) }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    expect(
      verify({ ...headers, [INTERNAL_HEADERS.userId]: "someone-else" }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    const anonymous = sign({ identity: { authType: "anonymous" } });
    expect(
      verify({
        ...anonymous,
        [INTERNAL_HEADERS.authType]: "jwt",
        [INTERNAL_HEADERS.userId]: "someone-else",
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects stale and future timestamps but allows small skew", () => {
    const headers = sign();
    expect(verify(headers, { nowSeconds: now + 30 }).ok).toBe(true);
    expect(verify(headers, { nowSeconds: now - 30 }).ok).toBe(true);
    expect(verify(headers, { nowSeconds: now + 31 })).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(verify(headers, { nowSeconds: now - 31 })).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("reports missing headers", () => {
    expect(verify({})).toEqual({ ok: false, reason: "missing" });
    const rest: Record<string, string> = { ...sign() };
    delete rest[INTERNAL_HEADERS.signature];
    expect(verify(rest)).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects malformed values", () => {
    const headers = sign();
    const cases: Record<string, string | string[]>[] = [
      { [INTERNAL_HEADERS.timestamp]: "12abc" },
      { [INTERNAL_HEADERS.timestamp]: "-5" },
      { [INTERNAL_HEADERS.signature]: "short" },
      { [INTERNAL_HEADERS.signature]: "!!!!" },
      { [INTERNAL_HEADERS.authType]: "admin" },
      { [INTERNAL_HEADERS.userId]: "a\nb" },
      { [INTERNAL_HEADERS.userId]: "" },
      { [INTERNAL_HEADERS.userId]: "x".repeat(129) },
      { [INTERNAL_HEADERS.userId]: ["a", "b"] },
    ];
    for (const change of cases)
      expect(verify({ ...headers, ...change })).toEqual({
        ok: false,
        reason: "malformed",
      });
  });

  it("round-trips a ticket identity", () => {
    const ticketUser = {
      authType: "ticket",
      userId: "user_ticket-456",
    } as const;
    const headers = sign({ identity: ticketUser });
    expect(headers[INTERNAL_HEADERS.authType]).toBe("ticket");
    expect(headers[INTERNAL_HEADERS.userId]).toBe(ticketUser.userId);
    expect(verify(headers)).toEqual({ ok: true, identity: ticketUser });
  });

  it("rejects jwt and ticket tampering", () => {
    const jwtHeaders = sign();
    // Tamper authType from jwt to ticket
    expect(
      verify({ ...jwtHeaders, [INTERNAL_HEADERS.authType]: "ticket" }),
    ).toEqual({ ok: false, reason: "bad_signature" });

    const ticketHeaders = sign({
      identity: { authType: "ticket", userId: "user_ticket-456" },
    });
    // Tamper authType from ticket to jwt
    expect(
      verify({ ...ticketHeaders, [INTERNAL_HEADERS.authType]: "jwt" }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects ticket missing user id", () => {
    const ticketHeaders = sign({
      identity: { authType: "ticket", userId: "user_ticket-456" },
    });
    const noUserId = { ...ticketHeaders };
    delete (noUserId as Record<string, string | undefined>)[
      INTERNAL_HEADERS.userId
    ];
    expect(verify(noUserId)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a user id header on an anonymous identity", () => {
    const headers = sign({ identity: { authType: "anonymous" } });
    expect(
      verify({ ...headers, [INTERNAL_HEADERS.userId]: "someone" }),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses to sign invalid user ids", () => {
    expect(() =>
      sign({ identity: { authType: "jwt", userId: "a\nanonymous" } }),
    ).toThrow();
    expect(() => sign({ identity: { authType: "jwt", userId: "" } })).toThrow();
    expect(() =>
      sign({ identity: { authType: "ticket", userId: "a\nanonymous" } }),
    ).toThrow();
    expect(() =>
      sign({ identity: { authType: "ticket", userId: "" } }),
    ).toThrow();
  });

  it("rejects a wrong secret", () => {
    expect(verify(sign(), { secret: `${secret}x` })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("strips query and fragment from URLs", () => {
    expect(pathnameOf("/api/v1/x?a=1#b")).toBe("/api/v1/x");
    expect(pathnameOf("/api/v1/x")).toBe("/api/v1/x");
  });
});
