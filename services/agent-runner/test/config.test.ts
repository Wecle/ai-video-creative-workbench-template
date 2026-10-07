import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("agent-runner config", () => {
  it("uses development defaults", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      production: false,
      temporalAddress: "localhost:7233",
      temporalNamespace: "default",
      agentModel: "mock",
      agentMockChunkDelayMs: 0,
      agentRegion: "default",
    });
    expect(config.agentSkillsDir).toMatch(/capabilities\/skills$/);
  });

  it("reads the Temporal settings", () => {
    expect(
      loadConfig({
        TEMPORAL_ADDRESS: "temporal:7233",
        TEMPORAL_NAMESPACE: "prod",
      }),
    ).toMatchObject({
      temporalAddress: "temporal:7233",
      temporalNamespace: "prod",
    });
  });

  it("requires TEMPORAL_ADDRESS, DATABASE_URL, REDIS_URL in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
      /TEMPORAL_ADDRESS is required in production/,
    );
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        TEMPORAL_ADDRESS: "t:7233",
      }),
    ).toThrow(/DATABASE_URL is required in production/);
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        TEMPORAL_ADDRESS: "t:7233",
        DATABASE_URL: "postgresql://localhost/db",
      }),
    ).toThrow(/REDIS_URL is required in production/);

    const validProd = loadConfig({
      NODE_ENV: "production",
      TEMPORAL_ADDRESS: "t:7233",
      DATABASE_URL: "postgresql://localhost/db",
      REDIS_URL: "redis://localhost:6379",
    });
    expect(validProd.production).toBe(true);
  });

  it("rejects an empty namespace", () => {
    expect(() => loadConfig({ TEMPORAL_NAMESPACE: "" })).toThrow(
      /TEMPORAL_NAMESPACE/,
    );
  });

  it("rejects unknown AGENT_MODEL", () => {
    expect(() => loadConfig({ AGENT_MODEL: "unknown-gpt-9" })).toThrow(
      /Unknown AGENT_MODEL 'unknown-gpt-9'/,
    );
  });
});
