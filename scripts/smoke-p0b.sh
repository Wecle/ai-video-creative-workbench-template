#!/usr/bin/env bash
# Execution layer smoke test: sign-up -> POST agent run -> poll to completed -> ownership -> Temporal UI.
# Needs a running full stack (pnpm docker:up, after pnpm db:migrate), curl and jq.
# Optional: CHECK_OUTAGE=1 also stops/starts the `temporal` container (compose project creative-full).
#   WEB_URL=http://localhost:3000 GATEWAY_URL=http://localhost:4000 TEMPORAL_UI_URL=http://127.0.0.1:8080 scripts/smoke-p0b.sh
set -u

WEB_URL="${WEB_URL:-http://localhost:3000}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:4000}"
TEMPORAL_UI_URL="${TEMPORAL_UI_URL:-http://127.0.0.1:8080}"
COMPOSE_FILE="${COMPOSE_FILE:-infra/docker/docker-compose.full.yml}"
PROMPT="smoke hello $RANDOM"
JAR_A="$(mktemp)"
JAR_B="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B"' EXIT
failures=0

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "PASS  $1 ($3)"; else echo "FAIL  $1: expected $2, got $3"; failures=$((failures + 1)); fi
}
status() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
signup_token() { # signup_token <jar> -> prints "<user id> <token>"
  local email="smoke-$(date +%s)-$RANDOM@example.com" signup token
  signup=$(curl -s -c "$1" -X POST "$WEB_URL/api/auth/sign-up/email" \
    -H 'content-type: application/json' -H "origin: $WEB_URL" \
    -d "{\"name\":\"smoke\",\"email\":\"$email\",\"password\":\"password-1234\"}")
  token=$(curl -s -b "$1" "$WEB_URL/api/auth/token" | jq -r .token)
  echo "$(echo "$signup" | jq -r .user.id) $token"
}
post_run() { # post_run <token> -> prints "<status>\n<body>" via the gateway
  curl -s -w "\n%{http_code}" -X POST "$GATEWAY_URL/api/v1/agent-runs" \
    -H "authorization: Bearer $1" -H 'content-type: application/json' -d "{\"prompt\":\"$PROMPT\"}"
}

echo "== B1: echo workflow through backend, temporal and agent-runner"
check "B1.1 POST /api/v1/agent-runs without a token" 401 \
  "$(status -X POST "$GATEWAY_URL/api/v1/agent-runs" -H 'content-type: application/json' -d '{"prompt":"x"}')"
read -r USER_A TOKEN_A < <(signup_token "$JAR_A")
read -r USER_B TOKEN_B < <(signup_token "$JAR_B")
check "B1.2 two distinct users signed up" true "$([ -n "$USER_A" ] && [ "$USER_A" != "$USER_B" ] && echo true || echo false)"

check "B1.3 POST with an invalid body" 400 \
  "$(status -X POST "$GATEWAY_URL/api/v1/agent-runs" -H "authorization: Bearer $TOKEN_A" -H 'content-type: application/json' -d '{}')"
out=$(post_run "$TOKEN_A")
code=$(echo "$out" | tail -n1)
body=$(echo "$out" | sed '$d')
echo "      $body"
check "B1.4 POST returns 202" 202 "$code"
RUN_ID=$(echo "$body" | jq -r .run.id)
check "B1.5 run id is a uuid" true "$(echo "$RUN_ID" | grep -Eq '^[0-9a-f-]{36}$' && echo true || echo false)"

state=""
for _ in $(seq 1 30); do
  run=$(curl -s -H "authorization: Bearer $TOKEN_A" "$GATEWAY_URL/api/v1/agent-runs/$RUN_ID")
  state=$(echo "$run" | jq -r .run.status)
  [ "$state" = "completed" ] || [ "$state" = "failed" ] && break
  sleep 0.5
done
echo "      $run"
check "B1.6 run reaches completed within 15 s" completed "$state"
check "B1.7 result message" "Template Agent received: $PROMPT" "$(echo "$run" | jq -r .run.result.message)"

echo "== ownership"
check "B1.8 another user gets 404 for the run" 404 \
  "$(status -H "authorization: Bearer $TOKEN_B" "$GATEWAY_URL/api/v1/agent-runs/$RUN_ID")"
check "B1.9 GET with a non-uuid id" 400 \
  "$(status -H "authorization: Bearer $TOKEN_A" "$GATEWAY_URL/api/v1/agent-runs/not-a-uuid")"
check "B1.10 GET an unknown run" 404 \
  "$(status -H "authorization: Bearer $TOKEN_A" "$GATEWAY_URL/api/v1/agent-runs/00000000-0000-4000-8000-000000000000")"

echo "== temporal ui"
check "B1.11 Temporal UI" 200 "$(status "$TEMPORAL_UI_URL")"
check "B1.12 workflow id in Temporal" "agent-run:$USER_A:$RUN_ID" "$(curl -s "$TEMPORAL_UI_URL/api/v1/namespaces/default/workflows/agent-run:$USER_A:$RUN_ID" | jq -r .workflowExecutionInfo.execution.workflowId)"

if [ "${CHECK_OUTAGE:-0}" = "1" ]; then
  echo "== outage: stop temporal, expect 503 within ~3 s, then recover without restarting the backend"
  docker compose --env-file .env -f "$COMPOSE_FILE" stop temporal >/dev/null 2>&1
  start=$(date +%s)
  out=$(post_run "$TOKEN_A"); code=$(echo "$out" | tail -n1)
  elapsed=$(( $(date +%s) - start ))
  check "B1.13 POST while temporal is down" 503 "$code"
  echo "      503 took ${elapsed}s"
  check "B1.14 answered within 6 s" true "$([ "$elapsed" -le 6 ] && echo true || echo false)"
  docker compose --env-file .env -f "$COMPOSE_FILE" start temporal >/dev/null 2>&1
  code=000
  for _ in $(seq 1 40); do
    out=$(post_run "$TOKEN_A"); code=$(echo "$out" | tail -n1)
    [ "$code" = "202" ] && break
    sleep 2
  done
  check "B1.15 POST succeeds again after temporal is back" 202 "$code"
fi

if [ "$failures" -gt 0 ]; then echo "$failures check(s) failed"; exit 1; fi
echo "all checks passed"
