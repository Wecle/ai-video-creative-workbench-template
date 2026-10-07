import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/mock-provider";
import { ProviderRegistry } from "../src/registry";
import type { ProviderAdapter } from "../src/types";

describe("ProviderRegistry", () => {
  it("resolves default providers by capability", () => {
    const registry = new ProviderRegistry();
    const mock = new MockProvider();
    registry.register(mock);

    const resolved = registry.resolve("image.generate");
    expect(resolved).toBe(mock);

    const unknown = registry.resolve("unknown.capability");
    expect(unknown).toBeNull();
  });

  it("prioritizes regional providers when region is specified", () => {
    const registry = new ProviderRegistry();
    const globalMock = new MockProvider();
    const regionalMock: ProviderAdapter = {
      id: "regional-mock",
      supportedCapabilities: ["image.generate"],
      submit: globalMock.submit.bind(globalMock),
      poll: globalMock.poll.bind(globalMock),
      parseWebhook: globalMock.parseWebhook.bind(globalMock),
      cancel: globalMock.cancel.bind(globalMock),
    };

    registry.register(globalMock);
    registry.register(regionalMock, "cn");

    const resolvedGlobal = registry.resolve("image.generate");
    expect(resolvedGlobal).toBe(globalMock);

    const resolvedCn = registry.resolve("image.generate", "cn");
    expect(resolvedCn).toBe(regionalMock);

    const resolvedUsFallback = registry.resolve("image.generate", "us");
    expect(resolvedUsFallback).toBe(globalMock);
  });
});
