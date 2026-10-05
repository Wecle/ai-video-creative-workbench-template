import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

describe("agent-runner config", () => {
  it("uses development defaults", () => {
    expect(loadConfig({})).toEqual({
      production: false,
      temporalAddress: "localhost:7233",
      temporalNamespace: "default",
    });
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

  it("requires TEMPORAL_ADDRESS in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
      /TEMPORAL_ADDRESS is required in production/,
    );
    expect(
      loadConfig({ NODE_ENV: "production", TEMPORAL_ADDRESS: "t:7233" })
        .production,
    ).toBe(true);
  });

  it("rejects an empty namespace", () => {
    expect(() => loadConfig({ TEMPORAL_NAMESPACE: "" })).toThrow(
      /TEMPORAL_NAMESPACE/,
    );
  });
});
