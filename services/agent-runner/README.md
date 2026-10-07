# Agent Runner

Temporal worker for the `agent` task queue. It serves no HTTP and publishes no port.

- `src/activities.ts`: activity implementations (`runEcho`, wrapping `EchoAgentAdapter`).
- `src/agent-loop-activities.ts`: activities for the agent loop (`buildContext`, `llmStep`, `prepareTool`, `executeTool`, `recordProgress`).
- `src/events.ts`: Redis event publisher for streaming agent events and state updates.
- `src/server.ts`: connects to `TEMPORAL_ADDRESS`, Postgres, and Redis; starts the worker on the `agent` task queue; writes `/tmp/agent-runner.ready` (the Compose healthcheck). The worker handles SIGINT/SIGTERM itself and drains for up to 10 s (`stop_grace_period` is 15 s).
- `src/workflow-source.ts`: production loads the prebuilt `dist/workflow-bundle.js`; development and tests bundle `@creative/workflows` from source.
- `src/bundle-workflows.ts`: build step (`pnpm build` runs `tsup && node dist/bundle-workflows.js`).

Requires a running Temporal (`pnpm infra:up`), Postgres, and Redis; without them the process exits at startup. Configuration:

- `TEMPORAL_ADDRESS` (default `localhost:7233`, required in production), `TEMPORAL_NAMESPACE` (default `default`).
- `DATABASE_URL` (required in production).
- `REDIS_URL` (required in production).
- `AGENT_MODEL` (default `mock`).
- `AGENT_MOCK_CHUNK_DELAY_MS` (default `0`).
- `AGENT_SKILLS_DIR` (default `capabilities/skills`).

Extension points: new workflows go in `packages/workflows`, their activities here; metrics and traces attach through `Runtime.install` and `@temporalio/interceptors-opentelemetry`. Keep prompts and credentials out of logs and spans.
