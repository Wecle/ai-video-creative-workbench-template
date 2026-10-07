# @creative/orchestrator-worker

Temporal worker service for canvas DAG execution and external AI provider activities.

## Responsibilities

- Listens on Temporal task queue `orchestrator`.
- Runs `canvasDagWorkflow`.
- Implements `OrchestratorActivities`:
  - `loadRunGraph`: loads the persisted snapshot and configuration for a run.
  - `executeNode`: executes canvas nodes (e.g. `text`, `image.generate`).
  - `pollJob`: polls provider status during polling mode.
  - `recordNodeRunStarted` / `recordNodeRunCompleted`: idempotently updates `node_runs`.
  - `updateRunStatus`: updates `runs` table status and timestamps.
