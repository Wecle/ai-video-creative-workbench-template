# @creative/workflows

Temporal workflow definitions: **deterministic code and contracts only**. Activity implementations live in
`services/agent-runner` (they need IO); this package is bundled by webpack into Temporal's sandbox.

| File                | Role                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/index.ts`      | Worker `workflowsPath` entry. Every function exported here is registered as a workflow.                  |
| `src/echo.ts`       | `echoWorkflow`: calls the `runEcho` activity (30 s timeout, at most 3 attempts).                         |
| `src/dag.ts`        | `canvasDagWorkflow`: executes canvas node graph with topological order and callback/polling support.     |
| `src/media-probe.ts`| `mediaProbeWorkflow`: coordinates `loadAsset`, `media.probe` (Python), and `saveAssetMetadata`.           |
| `src/activities.ts` | Types only: `AgentActivities`, `OrchestratorActivities`, `MediaActivities`, etc.                         |
| `src/constants.ts`  | Task queues, workflow types, workflow-id helpers, pinned test CLI version.                                |

Exports: `.` (workflows), `./constants`, `./activities`, `./dag`, `./signals`, `./media-probe`.


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
