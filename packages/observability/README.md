# Observability

Opt-in OpenTelemetry SDK and OTLP/HTTP trace exporter. Set OTEL_EXPORTER_OTLP_ENDPOINT to your Collector base URL to enable manual Gateway and Agent spans. Without an endpoint, tracing is a no-op. Logs use Fastify's structured JSON logger; metrics, cost tracking and storage are extension points.
