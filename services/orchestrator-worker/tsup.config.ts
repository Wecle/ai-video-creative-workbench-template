import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts", "src/bundle-workflows.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  noExternal: [
    "@creative/contracts",
    "@creative/database",
    "@creative/observability",
    "@creative/providers",
    "@creative/workflows",
  ],
  external: [
    /^@temporalio\//,
    "@opentelemetry/api",
    "@opentelemetry/sdk-node",
    "@opentelemetry/exporter-trace-otlp-http",
    "postgres",
  ],
});
