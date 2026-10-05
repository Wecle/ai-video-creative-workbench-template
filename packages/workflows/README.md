# @creative/workflows

Temporal workflow definitions: **deterministic code and contracts only**. Activity implementations live in
`services/agent-runner` (they need IO); this package is bundled by webpack into Temporal's sandbox.

| File                | Role                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/index.ts`      | Worker `workflowsPath` entry. Every function exported here is registered as a workflow.                  |
| `src/echo.ts`       | `echoWorkflow`: calls the `runEcho` activity (30 s timeout, at most 3 attempts).                         |
| `src/activities.ts` | Types only: `AgentActivities`, `EchoInput`, `EchoResult`. Imported by workflow and worker.               |
| `src/constants.ts`  | Task queue, workflow type, `agentRunWorkflowId()`, pinned test CLI version. No imports, no runtime deps. |

Exports: `.` (workflows), `./constants`, `./activities`. Backend and agent-runner depend on this package; it depends on
no other `@creative/*` runtime code.

## Determinism boundary (three layers)

1. **Bundler** (Temporal SDK): rejects Node built-ins (except `assert`, `url`, `util`) and `@temporalio/client|worker|activity|testing`.
   Pinned by `test/bundle.test.ts`. Do not work around it with `ignoreModules`.
2. **ESLint** (`eslint.config.mjs`): in `src/**` only `@temporalio/workflow` and relative imports are allowed (type imports are
   free); `fetch`, `process`, `require`, `XMLHttpRequest`, `WebSocket` are forbidden globals.
3. **tsconfig**: `lib: ["ES2022"]`, `types: []`, so `process`, `fetch`, `Buffer` are type errors. `typecheck` also checks
   `test/` with `tsconfig.test.json`.

Use `uuid4()` from `@temporalio/workflow`, never `crypto.randomUUID()`.

## Add a workflow

1. Add `src/<name>.ts` with the workflow function (and `proxyActivities<...>` with an explicit `maximumAttempts`).
2. Re-export it from `src/index.ts`; add its type name constant to `src/constants.ts`.
3. Add the activity interface to `src/activities.ts` and implement it in `services/agent-runner/src/activities.ts`.

## Tests

`TestWorkflowEnvironment.createLocal()` runs a real local Temporal server from the Temporal CLI, pinned to
`TEMPORAL_DEV_CLI_VERSION` (see `constants.ts`). The first run downloads the CLI from `https://temporal.download`
into `$TMPDIR/creative-temporal-cli-<version>` (needs network once, also on a fresh CI runner). Offline: set
`TEMPORAL_CLI_PATH` to a local `temporal` binary (its version is then yours to keep in line).
