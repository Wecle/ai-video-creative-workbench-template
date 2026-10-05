import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  clean: true,
  sourcemap: true,
  bundle: true,
  noExternal: ["@creative/contracts", "@creative/observability"],
  // OpenTelemetry uses CommonJS `require("async_hooks")`, which cannot run inside
  // an ESM bundle. Keep it external and install it as a runtime dependency.
  external: [
    "@opentelemetry/api",
    "@opentelemetry/sdk-node",
    "@opentelemetry/exporter-trace-otlp-http",
  ],
  target: "node22",
});
