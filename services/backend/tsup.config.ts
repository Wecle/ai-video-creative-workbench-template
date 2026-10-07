import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  noExternal: [
    "@creative/contracts",
    // Source-only workspace packages (yjs and zod stay external runtime dependencies).
    "@creative/canvas-doc",
    "@creative/node-registry",
    "@creative/database",
    "@creative/observability",
    "@creative/providers",
    "@creative/storage",
    // Constants and types only (never the workflow entry): see packages/workflows/README.md.
    "@creative/workflows",
    "@creative/agent-core",
  ],
  external: [
    "@opentelemetry/api",
    "@opentelemetry/sdk-node",
    "@opentelemetry/exporter-trace-otlp-http",
  ],
});
