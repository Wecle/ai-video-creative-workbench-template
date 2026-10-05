import { describe, expect, it } from "vitest";
import { loadConfig, parseTrustProxy } from "../src/config";

const secret = "x".repeat(32);
const production = {
  NODE_ENV: "production",
  INTERNAL_AUTH_SECRET: secret,
  REDIS_URL: "redis://redis:6379",
  TRUST_PROXY: "10.0.0.0/8",
};

describe("gateway config", () => {
  it("applies development defaults", () => {
    const config = loadConfig({ INTERNAL_AUTH_SECRET: secret });
    expect(config).toMatchObject({
      production: false,
      backendUrl: "http://127.0.0.1:4001",
      port: 4000,
      trustProxy: false,
    });
  });

  it("requires a long internal secret", () => {
    expect(() => loadConfig({})).toThrow(/INTERNAL_AUTH_SECRET/);
    expect(() => loadConfig({ INTERNAL_AUTH_SECRET: "short" })).toThrow(
      /32 characters/,
    );
  });

  it("accepts a complete production configuration", () => {
    expect(loadConfig(production)).toMatchObject({
      production: true,
      trustProxy: "10.0.0.0/8",
    });
  });

  it.each([
    [{ INTERNAL_AUTH_SECRET: `dev-only-${secret}` }, /dev-only/],
    [{ REDIS_URL: undefined }, /REDIS_URL/],
    [{ TRUST_PROXY: undefined }, /TRUST_PROXY/],
  ])("rejects an unsafe production configuration %#", (change, message) => {
    expect(() => loadConfig({ ...production, ...change })).toThrow(message);
  });

  it("parses TRUST_PROXY", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("10.0.0.0/8, 172.16.0.0/12")).toEqual([
      "10.0.0.0/8",
      "172.16.0.0/12",
    ]);
    expect(() => parseTrustProxy("2")).toThrow(/CIDR/);
  });
});
