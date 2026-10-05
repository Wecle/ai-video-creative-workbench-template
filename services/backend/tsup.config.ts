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
  ],
  external: [
    "@opentelemetry/api",
    "@opentelemetry/sdk-node",
    "@opentelemetry/exporter-trace-otlp-http",
  ],
});
