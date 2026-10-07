export interface WorkerConfig {
  databaseUrl: string;
  temporalAddress: string;
  temporalNamespace: string;
  mockProviderWebhookSecret: string;
}

export function loadConfig(): WorkerConfig {
  return {
    databaseUrl:
      process.env.DATABASE_URL ||
      "postgresql://template:template@127.0.0.1:5432/template",
    temporalAddress: process.env.TEMPORAL_ADDRESS || "127.0.0.1:7233",
    temporalNamespace: process.env.TEMPORAL_NAMESPACE || "default",
    mockProviderWebhookSecret:
      process.env.MOCK_PROVIDER_WEBHOOK_SECRET ||
      "mock-provider-webhook-secret-key-32chars",
  };
}
