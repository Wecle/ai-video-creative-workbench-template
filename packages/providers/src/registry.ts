import type { ProviderAdapter } from "./types";
import { MockProvider } from "./mock-provider";

export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();
  private regionalAdapters = new Map<string, Map<string, ProviderAdapter>>();

  register(adapter: ProviderAdapter, region?: string): void {
    if (region) {
      if (!this.regionalAdapters.has(region)) {
        this.regionalAdapters.set(region, new Map());
      }
      this.regionalAdapters.get(region)!.set(adapter.id, adapter);
    } else {
      this.adapters.set(adapter.id, adapter);
    }
  }

  get(id: string, region?: string): ProviderAdapter | null {
    if (region && this.regionalAdapters.get(region)?.has(id)) {
      return this.regionalAdapters.get(region)!.get(id)!;
    }
    return this.adapters.get(id) ?? null;
  }

  resolve(capability: string, region?: string): ProviderAdapter | null {
    if (region && this.regionalAdapters.has(region)) {
      for (const adapter of this.regionalAdapters.get(region)!.values()) {
        if (adapter.supportedCapabilities.includes(capability)) {
          return adapter;
        }
      }
    }
    for (const adapter of this.adapters.values()) {
      if (adapter.supportedCapabilities.includes(capability)) {
        return adapter;
      }
    }
    return null;
  }
}

export const defaultProviderRegistry = new ProviderRegistry();
defaultProviderRegistry.register(new MockProvider());
