#!/usr/bin/env bash
# One-command local setup, safe to re-run: checks tools, creates .env (never overwrites),
# installs dependencies, starts PostgreSQL/Redis/Temporal and applies database migrations.
# Does not generate secrets or touch an existing .env.
set -euo pipefail

cd "$(dirname "$0")/.."
WAIT_SECONDS="${BOOTSTRAP_WAIT_SECONDS:-120}"
COMPOSE=(docker compose -f infra/docker/docker-compose.yml)

die() { echo "bootstrap: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

step "Checking tools"
command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install Node.js 22.9 or newer."
node_version="$(node -p 'process.versions.node')"
IFS=. read -r node_major node_minor _ <<<"$node_version"
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 9 ]; }; then
  die "Node.js $node_version is too old. Install Node.js 22.9 or newer."
fi
command -v pnpm >/dev/null 2>&1 || die "pnpm is not installed. Run: corepack enable (pnpm 10.13.1 is pinned in package.json)."
command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker Desktop or Docker Engine with Compose v2."
docker info >/dev/null 2>&1 || die "Docker is installed but the daemon is not reachable. Start Docker and re-run."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose)."
echo "node $node_version, pnpm $(pnpm --version), docker OK"

step "Environment file"
if [ -f .env ]; then
  echo ".env exists, leaving it untouched"
else
  cp .env.example .env
  echo "created .env from .env.example (development defaults; set real secrets before using docker:up)"
fi

step "Installing dependencies"
pnpm install --frozen-lockfile

step "Starting PostgreSQL, Redis and Temporal"
if [ -n "$(docker compose -p creative-full -f infra/docker/docker-compose.full.yml ps -q 2>/dev/null || true)" ]; then
  die "the full stack (creative-full) is running and uses the same ports. Run: pnpm docker:down"
fi
pnpm infra:up

wait_healthy() { # wait_healthy <service>
  local service="$1" deadline=$((SECONDS + WAIT_SECONDS)) id state
  while [ "$SECONDS" -lt "$deadline" ]; do
    id="$("${COMPOSE[@]}" ps -q "$service" 2>/dev/null || true)"
    if [ -n "$id" ]; then
      state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
      [ "$state" = "healthy" ] && { echo "$service: healthy"; return 0; }
    fi
    sleep 2
  done
  die "$service did not become healthy within ${WAIT_SECONDS}s. Check: docker compose -f infra/docker/docker-compose.yml logs $service"
}
wait_exited_ok() { # wait_exited_ok <one-shot service>
  local service="$1" deadline=$((SECONDS + WAIT_SECONDS)) id state code
  while [ "$SECONDS" -lt "$deadline" ]; do
    id="$("${COMPOSE[@]}" ps -aq "$service" 2>/dev/null || true)"
    if [ -n "$id" ]; then
      state="$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || true)"
      code="$(docker inspect -f '{{.State.ExitCode}}' "$id" 2>/dev/null || true)"
      if [ "$state" = "exited" ]; then
        [ "$code" = "0" ] && { echo "$service: completed"; return 0; }
        die "$service failed (exit $code). Check: docker compose -f infra/docker/docker-compose.yml logs $service"
      fi
    fi
    sleep 2
  done
  die "$service did not finish within ${WAIT_SECONDS}s. Check: docker compose -f infra/docker/docker-compose.yml logs $service"
}
wait_healthy postgres
wait_healthy redis
wait_healthy s3
wait_healthy temporal
wait_exited_ok temporal-setup
wait_exited_ok temporal-namespace

step "Applying database migrations"
pnpm db:migrate

cat <<'DONE'

Ready. Next:
  pnpm dev                          start web, gateway, backend and the agent-runner worker

  Web                http://localhost:3000   (sign up first)
  Gateway / API docs http://localhost:4000/docs
  Backend (debug)    http://localhost:4001
  Temporal UI        http://localhost:8080
  Temporal gRPC      localhost:7233
  Media worker       pnpm dev:worker  (http://localhost:4200)
DONE
