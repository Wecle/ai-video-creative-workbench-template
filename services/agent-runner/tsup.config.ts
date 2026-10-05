import { defineConfig } from "tsup";
export default defineConfig({
  // bundle-workflows.ts is a build-time script: `node dist/bundle-workflows.js` writes dist/workflow-bundle.js.
  entry: ["src/server.ts", "src/bundle-workflows.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  // Workflow code is bundled separately by Temporal's webpack, never inlined here;
  // only its constants and types are. Everything else under @creative/* is workspace source.
  noExternal: [
    "@creative/agent-core",
    "@creative/observability",
    "@creative/workflows",
  ],
  external: [
    // Native core-bridge and webpack must stay external. If they are inlined, ESM fails with
    // "Dynamic require of ... is not supported".
    /^@temporalio\//,
    "@opentelemetry/api",
    "@opentelemetry/sdk-node",
    "@opentelemetry/exporter-trace-otlp-http",
  ],
});
