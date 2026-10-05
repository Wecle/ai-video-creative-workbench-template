# Agent Runner

Temporal worker for the `agent` task queue. It serves no HTTP and publishes no port.

- `src/activities.ts`: activity implementations (`runEcho`, wrapping `EchoAgentAdapter`). Put IO (database, Redis, providers) here; workflow code in `packages/workflows` must stay deterministic.
- `src/server.ts`: connects to `TEMPORAL_ADDRESS`, starts the worker, writes `/tmp/agent-runner.ready` (the Compose healthcheck). The worker handles SIGINT/SIGTERM itself and drains for up to 10 s (`stop_grace_period` is 15 s).
- `src/workflow-source.ts`: production loads the prebuilt `dist/workflow-bundle.js`; development and tests bundle `@creative/workflows` from source.
- `src/bundle-workflows.ts`: build step (`pnpm build` runs `tsup && node dist/bundle-workflows.js`).

Requires a running Temporal (`pnpm infra:up`); without it the process exits at startup. Configuration: `TEMPORAL_ADDRESS` (default `localhost:7233`, required in production), `TEMPORAL_NAMESPACE` (default `default`).

Extension points: new workflows go in `packages/workflows`, their activities here; metrics and traces attach through `Runtime.install` and `@temporalio/interceptors-opentelemetry` (not included yet). Keep prompts and credentials out of logs and spans.
