import { trace, SpanStatusCode } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

export function startTelemetry(serviceName: string) {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
    return { shutdown: async () => {} };
  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter(),
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
// Keep prompts, credentials, asset URLs and other sensitive payloads out of spans.
export function withSpan<T>(name: string, execute: () => Promise<T>) {
  return trace
    .getTracer("creative-template")
    .startActiveSpan(name, async (span) => {
      try {
        return await execute();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}
