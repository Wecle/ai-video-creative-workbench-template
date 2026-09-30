# Architecture and extension boundaries

## Runnable scaffold

- apps/web: Next.js App Router, React Flow playground, Zustand canvas state, TanStack Query health request and React Hook Form/Zod inspector.
- services/gateway: Fastify entry point for browser clients; demo reads, OpenAPI, security headers, request limits and in-process IP rate limiting.
- services/agent-runner: separately deployable Fastify service with validated synchronous echo execution.
- workers/media-worker-python: separately started FastAPI service for health and task validation.
- packages/contracts: browser-safe Zod contracts and event/task types.
- packages/ui: shared shadcn/ui-compatible source components, Radix Slot, CVA and Tailwind tokens.
- packages/api-client: typed HTTP client with response validation.
- packages/database: server-side Drizzle/PostgreSQL client and example migration schema.
- packages/job-queue: optional BullMQ queue factory; no active consumer or scheduler.
- packages/observability: optional manual OpenTelemetry spans and OTLP trace export.

The default playground needs neither Docker nor model credentials. Services build into standalone ESM entry points that bundle workspace source, while third-party dependencies remain installed runtime dependencies. Shared packages expose TypeScript source for workspace tooling; they are not npm distribution artifacts.

## Reserved boundaries

The README-only directories have no package.json, process or implemented runtime. Split them into services/packages when there is a real ownership or scaling need:

- control-plane: project, canvas, asset and task use cases; owns database writes.
- realtime: SSE/WebSocket event delivery, reconnect and replay.
- webhook-ingress: signature verification and idempotent provider callbacks.
- node-registry/domain: node definitions and application rules.
- agent-policy: permission, budget, approval and safety decisions.
- tool-runtime/skill-runtime/mcp-adapter: validated execution, versioned skills and permission-scoped MCP connections.
- skills/mcp-servers: application-owned capability definitions and servers.

Canvas/event/provider protocols can initially live in contracts. Extract them when independent versioning becomes useful. Keep database credentials and ORM imports out of browser-facing packages.

## Before deploying a real application

1. Add identity, tenant-scoped authorization and audit records. Current services are unauthenticated local examples, not public APIs.
2. Replace per-process rate limiting with shared Redis limits; implement tenant/provider concurrency, quotas, queue fairness and admission control.
3. Add durable task/run storage, idempotency, cancellation, timeout/retry policy and callback validation. Echo completion does not prove a durable Agent loop.
4. Implement bounded Agent turns, context compaction, tool schemas, approval gates, skill/MCP isolation and replayable checkpoints.
5. Add S3-compatible object storage adapters, upload restrictions, signed URLs and media scanning. Configure the `S3_*` environment variables after adding an adapter; provisioning storage and buckets is separate from the PostgreSQL/Redis development Compose stack.
6. Add BFF routes with explicit request/response contracts. The Next.js rewrite is transport plumbing, not authorization or domain orchestration.
7. Define trace/log redaction, sampling, retention and cost metrics. Manual spans contain no prompt or credential payloads; the template provides no Collector or observability storage.
8. Add database migrations and integration/e2e tests for actual persistence and providers. Review example schema and development credentials before reuse.

Python is not connected to BullMQ in this scaffold. Define the worker transport and versioned cross-language task protocol before enabling jobs.
