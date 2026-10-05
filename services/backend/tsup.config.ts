import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  noExternal: [
    "@creative/contracts",
    "@creative/database",
    "@creative/observability",
    // Constants and types only (never the workflow entry): see packages/workflows/README.md.
    "@creative/workflows",
  ],
  external: [
    "@opentelemetry/api",
    "@opentelemetry/sdk-node",
    "@opentelemetry/exporter-trace-otlp-http",
  ],
});
