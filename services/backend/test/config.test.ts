import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const secret = "s".repeat(32);
const env = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  BETTER_AUTH_SECRET: secret,
  INTERNAL_AUTH_SECRET: `${secret}2`,
};

describe("backend config", () => {
  it("applies development defaults", () => {
    expect(loadConfig(env)).toMatchObject({
      production: false,
      webOrigin: "http://localhost:3000",
      port: 4001,
      google: undefined,
    });
  });

  it("requires the database url and long secrets", () => {
    expect(() => loadConfig({ ...env, DATABASE_URL: undefined })).toThrow(
      /DATABASE_URL/,
    );
    expect(() => loadConfig({ ...env, BETTER_AUTH_SECRET: "short" })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it("enables Google only when both variables are set", () => {
    expect(() => loadConfig({ ...env, GOOGLE_CLIENT_ID: "id" })).toThrow(
      /together/,
    );
    expect(
      loadConfig({
        ...env,
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
      }).google,
    ).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("rejects placeholder secrets in production", () => {
    expect(() =>
      loadConfig({
        ...env,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: `dev-only-${secret}`,
      }),
    ).toThrow(/BETTER_AUTH_SECRET must not use the dev-only/);

    expect(() =>
      loadConfig({
        ...env,
        NODE_ENV: "production",
        TEMPORAL_ADDRESS: "temporal:7233",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toThrow(/S3_\* configuration is required in production/);

    expect(
      loadConfig({
        ...env,
        NODE_ENV: "production",
        TEMPORAL_ADDRESS: "temporal:7233",
        REDIS_URL: "redis://localhost:6379",
        S3_ENDPOINT: "http://s3:8333",
        S3_ACCESS_KEY: "key",
        S3_SECRET_KEY: "secret",
        S3_BUCKET: "bucket",
      }).production,
    ).toBe(true);
  });

  it("defaults the Temporal settings in development", () => {
    expect(loadConfig(env)).toMatchObject({
      temporalAddress: "localhost:7233",
      temporalNamespace: "default",
    });
    expect(
      loadConfig({
        ...env,
        TEMPORAL_ADDRESS: "temporal:7233",
        TEMPORAL_NAMESPACE: "prod",
      }),
    ).toMatchObject({
      temporalAddress: "temporal:7233",
      temporalNamespace: "prod",
    });
  });

  it("requires TEMPORAL_ADDRESS and REDIS_URL in production", () => {
    expect(() =>
      loadConfig({
        ...env,
        NODE_ENV: "production",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toThrow(/TEMPORAL_ADDRESS is required in production/);

    expect(() =>
      loadConfig({
        ...env,
        NODE_ENV: "production",
        TEMPORAL_ADDRESS: "temporal:7233",
      }),
    ).toThrow(/REDIS_URL is required in production/);
  });
});
