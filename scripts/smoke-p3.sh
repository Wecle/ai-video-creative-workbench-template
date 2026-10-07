#!/usr/bin/env bash
# Agent loop and realtime streaming smoke test (P3a):
# Agent run initiation, ticket validation, SSE streaming, proposal approval/rejection,
# skill loading, and heartbeat longevity.
# Needs a running stack (pnpm docker:up, or pnpm dev + pnpm dev:worker + pnpm dev:agent), curl, jq, node (Node 22).
#   WEB_URL=http://localhost:3000 GATEWAY_URL=http://localhost:4000 scripts/smoke-p3.sh
set -u

WEB_URL="${WEB_URL:-http://localhost:3000}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:4000}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK_RESTART="${CHECK_RESTART:-0}"
JAR_A="$(mktemp)"
JAR_B="$(mktemp)"
BODY="$(mktemp)"
SSE_OUT="$(mktemp)"
SSE_OUT_SKILL="$(mktemp)"
SSE_OUT_HEARTBEAT="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B" "$BODY" "$SSE_OUT" "$SSE_OUT_SKILL" "$SSE_OUT_HEARTBEAT"' EXIT
failures=0

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "PASS  $1 ($3)"; else echo "FAIL  $1: expected $2, got $3"; failures=$((failures + 1)); fi
}

signup_token() { # signup_token <jar> -> prints "<user id> <token>"
  local email="smoke-p3-$(date +%s)-$RANDOM@example.com" signup token
  signup=$(curl -s -c "$1" -X POST "$WEB_URL/api/auth/sign-up/email" \
    -H 'content-type: application/json' -H "origin: $WEB_URL" \
    -d "{\"name\":\"smoke\",\"email\":\"$email\",\"password\":\"password-1234\"}")
  token=$(curl -s -b "$1" "$WEB_URL/api/auth/token" | jq -r .token)
  echo "$(echo "$signup" | jq -r .user.id) $token"
}

make_state() { (cd "$ROOT" && pnpm --silent --filter @creative/canvas-doc make-state "$1"); }

api() {
  local token="$1" method="$2" path="$3" data="${4:-}"
  if [ -n "$data" ]; then
    curl -s -o "$BODY" -w "%{http_code}" -X "$method" "$GATEWAY_URL$path" \
      -H "authorization: Bearer $token" -H 'content-type: application/json' --data-binary "@$data"
  else
    curl -s -o "$BODY" -w "%{http_code}" -X "$method" "$GATEWAY_URL$path" -H "authorization: Bearer $token"
  fi
}

echo "== P3a: Agent Loop and Realtime Streaming smoke tests"

read -r USER_A TOKEN_A < <(signup_token "$JAR_A")
read -r USER_B TOKEN_B < <(signup_token "$JAR_B")
check "P3.1 users signed up" true "$([ -n "$USER_A" ] && [ "$USER_A" != "$USER_B" ] && echo true || echo false)"

# Create project and canvas
tmp="$(mktemp)"; echo '{"name":"Agent Loop Project"}' > "$tmp"
check "P3.2 User A creates project" 201 "$(api "$TOKEN_A" POST /api/v1/projects "$tmp")"
rm -f "$tmp"
PROJECT_ID=$(jq -r .project.id "$BODY")
CANVAS_ID=$(jq -r '.project.canvases[0].id' "$BODY")
CPATH="/api/v1/projects/$PROJECT_ID/canvases/$CANVAS_ID"

# Save canvas state (valid DAG)
VALID_STATE=$(make_state valid)
save_body="$(mktemp)"
jq -n --argjson v 0 --arg s "$VALID_STATE" '{baseVersion: $v, state: $s}' > "$save_body"
check "P3.3 User A saves canvas state" 200 "$(api "$TOKEN_A" PUT "$CPATH/state" "$save_body")"
rm -f "$save_body"
CANVAS_VERSION=$(jq -r .version "$BODY")
check "P3.3b canvas version is 1" "1" "$CANVAS_VERSION"

# Unauthenticated checks
check "P3.3c unauthenticated request to /api/v1/agent/runs -> 401" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GATEWAY_URL/api/v1/agent/runs" -H 'content-type: application/json' -d '{}')"
check "P3.3d unauthenticated request to /api/v1/agent/profiles -> 401" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$GATEWAY_URL/api/v1/agent/profiles")"

# Record initial canvas snapshot
api "$TOKEN_A" GET "$CPATH" >/dev/null
CANVAS_SNAP_INIT=$(jq -c .canvas.snapshot "$BODY")

# Non-member and invalid version checks
echo "== Authorization & validation checks"
agent_req="$(mktemp)"
jq -n --arg pid "$PROJECT_ID" --arg cid "$CANVAS_ID" --argjson cv "$CANVAS_VERSION" \
  '{projectId: $pid, canvasId: $cid, canvasVersion: $cv, profileId: "creative-assistant", prompt: "smoke test unauthorized"}' > "$agent_req"
check "P3.4 User B cannot start agent run on User A canvas -> 404" 404 "$(api "$TOKEN_B" POST /api/v1/agent/runs "$agent_req")"

jq -n --arg pid "$PROJECT_ID" --arg cid "$CANVAS_ID" --argjson cv 999 \
  '{projectId: $pid, canvasId: $cid, canvasVersion: $cv, profileId: "creative-assistant", prompt: "smoke test wrong version"}' > "$agent_req"
check "P3.5 mismatched canvasVersion -> 409" 409 "$(api "$TOKEN_A" POST /api/v1/agent/runs "$agent_req")"
rm -f "$agent_req"

# 1. Normal Run: Initiation, SSE, Proposal, Approval, Completion
echo "== Run 1: Approval flow"
RAND_TAG="smoke-$RANDOM"
start_req="$(mktemp)"
jq -n --arg pid "$PROJECT_ID" --arg cid "$CANVAS_ID" --argjson cv "$CANVAS_VERSION" --arg p "Please add a text card $RAND_TAG" \
  '{projectId: $pid, canvasId: $cid, canvasVersion: $cv, profileId: "creative-assistant", prompt: $p}' > "$start_req"
check "P3.6 User A starts agent run -> 202" 202 "$(api "$TOKEN_A" POST /api/v1/agent/runs "$start_req")"
rm -f "$start_req"
AGENT_RUN_ID=$(jq -r .run.id "$BODY")
check "P3.7 agentRunId returned" true "$([ -n "$AGENT_RUN_ID" ] && [ "$AGENT_RUN_ID" != "null" ] && echo true || echo false)"

# Open SSE stream for User A immediately to capture live events
ticket_req="$(mktemp)"; jq -n --arg id "$AGENT_RUN_ID" '{agentRunId: $id}' > "$ticket_req"
api "$TOKEN_A" POST /api/v1/realtime-tickets "$ticket_req" >/dev/null
rm -f "$ticket_req"
STREAM_TICKET=$(jq -r .ticket "$BODY")

curl -N -s -H "Origin: $WEB_URL" "$GATEWAY_URL/api/v1/realtime/agent/runs/$AGENT_RUN_ID/events?ticket=$STREAM_TICKET" > "$SSE_OUT" 2>&1 &
SSE_PID=$!

# Realtime Ticket Authorization & Single-Use Checks
echo "== Ticket authorization & isolation"
ticket_req="$(mktemp)"; jq -n --arg id "$AGENT_RUN_ID" '{agentRunId: $id}' > "$ticket_req"
# Gateway signs ticket statelessly for User B
check "P3.8 User B gets ticket for agent run -> 200" 200 "$(api "$TOKEN_B" POST /api/v1/realtime-tickets "$ticket_req")"
TICKET_B=$(jq -r .ticket "$BODY")

# Backend blocks User B from connecting to User A agent run stream -> 404
HTTP_CODE_B=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $WEB_URL" "$GATEWAY_URL/api/v1/realtime/agent/runs/$AGENT_RUN_ID/events?ticket=$TICKET_B")
check "P3.9 User B cannot stream User A agent run -> 404" 404 "$HTTP_CODE_B"

# User B cannot approve User A run -> 404
appr_req="$(mktemp)"; jq -n '{toolCallId: "call-dummy", decision: "approve"}' > "$appr_req"
check "P3.10 User B cannot approve User A run -> 404" 404 "$(api "$TOKEN_B" POST "/api/v1/agent/runs/$AGENT_RUN_ID/approvals" "$appr_req")"
rm -f "$appr_req"

# User A gets ticket
check "P3.11 User A gets ticket for agent run -> 200" 200 "$(api "$TOKEN_A" POST /api/v1/realtime-tickets "$ticket_req")"
rm -f "$ticket_req"
TICKET_A1=$(jq -r .ticket "$BODY")

# Disallowed Origin -> 403
FORBIDDEN_ORIGIN="http://evil-attacker.com"
check "P3.12 SSE with disallowed Origin -> 403" 403 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $FORBIDDEN_ORIGIN" "$GATEWAY_URL/api/v1/realtime/agent/runs/$AGENT_RUN_ID/events?ticket=$TICKET_A1")"

# Consume ticket with valid Origin
HTTP_CODE_1=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 -H "Origin: $WEB_URL" "$GATEWAY_URL/api/v1/realtime/agent/runs/$AGENT_RUN_ID/events?ticket=$TICKET_A1" || true)
check "P3.13 first ticket usage succeeds" "200" "$HTTP_CODE_1"

# Reuse same ticket -> 401 Unauthorized
HTTP_CODE_REUSE=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $WEB_URL" "$GATEWAY_URL/api/v1/realtime/agent/runs/$AGENT_RUN_ID/events?ticket=$TICKET_A1")
check "P3.14 single-use ticket reuse -> 401" 401 "$HTTP_CODE_REUSE"

# Wait for snapshot, text delta, and proposed events
echo "Waiting for SSE events (snapshot, text delta, tool proposal)..."
has_snapshot=false
has_delta=false
has_proposal=false

for attempt in $(seq 1 30); do
  if ! $has_snapshot && grep -q "event: snapshot" "$SSE_OUT" 2>/dev/null; then
    has_snapshot=true
  fi
  if ! $has_delta && grep -q "event: agent.text.delta" "$SSE_OUT" 2>/dev/null; then
    has_delta=true
  fi
  if ! $has_proposal && grep -q "event: agent.tool.proposed" "$SSE_OUT" 2>/dev/null; then
    has_proposal=true
  fi
  if $has_snapshot && $has_delta && $has_proposal; then
    break
  fi
  sleep 0.5
done

check "P3.15 SSE receives snapshot" true "$has_snapshot"
check "P3.16 SSE receives agent.text.delta" true "$has_delta"
check "P3.17 SSE receives agent.tool.proposed" true "$has_proposal"

# Pre-approval invariants: canvas snapshot & version unchanged, run waiting_approval
api "$TOKEN_A" GET "$CPATH" >/dev/null
CANVAS_VER_PRE=$(jq -r .canvas.version "$BODY")
CANVAS_SNAP_PRE=$(jq -c .canvas.snapshot "$BODY")
check "P3.18 canvas version unchanged before approval" "$CANVAS_VERSION" "$CANVAS_VER_PRE"
check "P3.18b canvas snapshot unchanged before approval" "$CANVAS_SNAP_INIT" "$CANVAS_SNAP_PRE"

api "$TOKEN_A" GET "/api/v1/agent/runs/$AGENT_RUN_ID" >/dev/null
RUN_STATUS_PRE=$(jq -r .run.status "$BODY")
check "P3.19 run status is waiting_approval" "waiting_approval" "$RUN_STATUS_PRE"
TOOL_CALL_ID=$(jq -r '.run.proposals[-1].toolCallId // empty' "$BODY")
check "P3.20 active proposal toolCallId exists" true "$([ -n "$TOOL_CALL_ID" ] && echo true || echo false)"

# Optional worker restart check if requested
if [ "$CHECK_RESTART" = "1" ]; then
  echo "Testing worker restart while waiting for approval..."
  docker compose --env-file "$ROOT/.env" -f "$ROOT/infra/docker/docker-compose.full.yml" restart agent-runner
  echo "Waiting for agent-runner to become healthy again..."
  STATUS="unknown"
  for attempt in $(seq 1 30); do
    STATUS=$(docker inspect --format='{{.State.Health.Status}}' creative-full-agent-runner-1 2>/dev/null || echo "unknown")
    if [ "$STATUS" = "healthy" ]; then
      break
    fi
    sleep 1
  done
  check "agent-runner container recovered healthy" "healthy" "$STATUS"
fi

# User A approves the proposal
echo "User A approves proposal $TOOL_CALL_ID..."
appr_body="$(mktemp)"
jq -n --arg tid "$TOOL_CALL_ID" '{toolCallId: $tid, decision: "approve"}' > "$appr_body"
check "P3.21 User A approves proposal -> 202" 202 "$(api "$TOKEN_A" POST "/api/v1/agent/runs/$AGENT_RUN_ID/approvals" "$appr_body")"
check "P3.21b approval response accepted true" "true" "$(jq -r .accepted "$BODY")"
rm -f "$appr_body"

# Wait for completion in SSE
has_decided=false
has_tool_res=false
has_status_completed=false
has_done=false

for attempt in $(seq 1 30); do
  if ! $has_decided && grep -q "event: agent.tool.decided" "$SSE_OUT" 2>/dev/null; then
    has_decided=true
  fi
  if ! $has_tool_res && grep -q "event: agent.tool.result" "$SSE_OUT" 2>/dev/null; then
    has_tool_res=true
  fi
  if ! $has_status_completed && grep -q '"status":"completed"' "$SSE_OUT" 2>/dev/null; then
    has_status_completed=true
  fi
  if ! $has_done && grep -q "event: done" "$SSE_OUT" 2>/dev/null; then
    has_done=true
  fi
  if $has_decided && $has_tool_res && $has_status_completed && $has_done; then
    break
  fi
  sleep 0.5
done

check "P3.22 SSE receives agent.tool.decided" true "$has_decided"
check "P3.23 SSE receives agent.tool.result" true "$has_tool_res"
check "P3.24 SSE receives completed status" true "$has_status_completed"
check "P3.25 SSE receives terminal done event" true "$has_done"

kill "$SSE_PID" 2>/dev/null || true
wait "$SSE_PID" 2>/dev/null || true

# Assert run completed in DB
api "$TOKEN_A" GET "/api/v1/agent/runs/$AGENT_RUN_ID" >/dev/null
RUN_STATUS_POST=$(jq -r .run.status "$BODY")
RUN_OUTCOME_POST=$(jq -r .run.outcome "$BODY")
check "P3.26 run completed in backend" "completed" "$RUN_STATUS_POST"
check "P3.27 run outcome is finished" "finished" "$RUN_OUTCOME_POST"

# Server canvas version & snapshot remain unchanged (client applies patch)
api "$TOKEN_A" GET "$CPATH" >/dev/null
CANVAS_VER_POST=$(jq -r .canvas.version "$BODY")
CANVAS_SNAP_POST=$(jq -c .canvas.snapshot "$BODY")
check "P3.28 canvas version still unchanged on server" "$CANVAS_VERSION" "$CANVAS_VER_POST"
check "P3.28b canvas snapshot still unchanged on server" "$CANVAS_SNAP_INIT" "$CANVAS_SNAP_POST"

# 2. Run 2: Rejection Flow
echo "== Run 2: Rejection flow"
start_reject="$(mktemp)"
jq -n --arg pid "$PROJECT_ID" --arg cid "$CANVAS_ID" --argjson cv "$CANVAS_VERSION" \
  '{projectId: $pid, canvasId: $cid, canvasVersion: $cv, profileId: "creative-assistant", prompt: "smoke reject request"}' > "$start_reject"
check "P3.29 start second run -> 202" 202 "$(api "$TOKEN_A" POST /api/v1/agent/runs "$start_reject")"
rm -f "$start_reject"
REJECT_RUN_ID=$(jq -r .run.id "$BODY")

echo "Waiting for run 2 to reach waiting_approval..."
REJECT_TOOL_CALL_ID=""
for attempt in $(seq 1 30); do
  api "$TOKEN_A" GET "/api/v1/agent/runs/$REJECT_RUN_ID" >/dev/null
  if [ "$(jq -r .run.status "$BODY")" = "waiting_approval" ]; then
    REJECT_TOOL_CALL_ID=$(jq -r '.run.proposals[-1].toolCallId // empty' "$BODY")
    break
  fi
  sleep 0.5
done
check "P3.30 run 2 reached waiting_approval" true "$([ -n "$REJECT_TOOL_CALL_ID" ] && echo true || echo false)"

rej_body="$(mktemp)"
jq -n --arg tid "$REJECT_TOOL_CALL_ID" '{toolCallId: $tid, decision: "reject"}' > "$rej_body"
check "P3.31 User A rejects proposal -> 202" 202 "$(api "$TOKEN_A" POST "/api/v1/agent/runs/$REJECT_RUN_ID/approvals" "$rej_body")"
check "P3.31b reject response accepted true" "true" "$(jq -r .accepted "$BODY")"
rm -f "$rej_body"

echo "Waiting for run 2 to complete..."
for attempt in $(seq 1 30); do
  api "$TOKEN_A" GET "/api/v1/agent/runs/$REJECT_RUN_ID" >/dev/null
  if [ "$(jq -r .run.status "$BODY")" = "completed" ]; then
    break
  fi
  sleep 0.5
done
check "P3.32 run 2 status is completed" "completed" "$(jq -r .run.status "$BODY")"
check "P3.33 run 2 outcome is finished" "finished" "$(jq -r .run.outcome "$BODY")"
REJECT_STATUS=$(jq -r '.run.proposals[-1].status // empty' "$BODY")
check "P3.34 proposal record status is rejected" "rejected" "$REJECT_STATUS"
LAST_TEXT=$(jq -r '.run.steps[-1].text // empty' "$BODY")
check "P3.35 last step contains rejection acknowledgement" true "$([[ "$LAST_TEXT" == *"Understood"* ]] && echo true || echo false)"

# 3. Run 3: Skill Loading
echo "== Run 3: Skill loading flow"
start_skill="$(mktemp)"
jq -n --arg pid "$PROJECT_ID" --arg cid "$CANVAS_ID" --argjson cv "$CANVAS_VERSION" \
  '{projectId: $pid, canvasId: $cid, canvasVersion: $cv, profileId: "creative-assistant", prompt: "smoke please use skill for shot-list"}' > "$start_skill"
check "P3.36 start skill run -> 202" 202 "$(api "$TOKEN_A" POST /api/v1/agent/runs "$start_skill")"
rm -f "$start_skill"
SKILL_RUN_ID=$(jq -r .run.id "$BODY")

ticket_req="$(mktemp)"; jq -n --arg id "$SKILL_RUN_ID" '{agentRunId: $id}' > "$ticket_req"
api "$TOKEN_A" POST /api/v1/realtime-tickets "$ticket_req" >/dev/null
rm -f "$ticket_req"
SKILL_TICKET=$(jq -r .ticket "$BODY")

curl -N -s -H "Origin: $WEB_URL" "$GATEWAY_URL/api/v1/realtime/agent/runs/$SKILL_RUN_ID/events?ticket=$SKILL_TICKET" > "$SSE_OUT_SKILL" 2>&1 &
SKILL_SSE_PID=$!

echo "Waiting for skill.load tool result and subsequent proposal..."
has_skill_res=false
has_skill_prop=false
for attempt in $(seq 1 30); do
  if ! $has_skill_res && grep -q "skill\.load" "$SSE_OUT_SKILL" 2>/dev/null && grep -q "shot-list" "$SSE_OUT_SKILL" 2>/dev/null; then
    has_skill_res=true
  fi
  if ! $has_skill_prop && grep -q "event: agent.tool.proposed" "$SSE_OUT_SKILL" 2>/dev/null; then
    has_skill_prop=true
  fi
  if $has_skill_res && $has_skill_prop; then
    break
  fi
  sleep 0.5
done

check "P3.37 received skill.load tool result with shot-list" true "$has_skill_res"
check "P3.38 proposal emitted after skill.load" true "$has_skill_prop"

# Order check: skill.load arrives before agent.tool.proposed
skill_line=$(grep -n "skill\.load" "$SSE_OUT_SKILL" 2>/dev/null | head -n1 | cut -d: -f1)
prop_line=$(grep -n "event: agent\.tool\.proposed" "$SSE_OUT_SKILL" 2>/dev/null | head -n1 | cut -d: -f1)
check "P3.38b skill result arrived before proposal" true "$([ -n "$skill_line" ] && [ -n "$prop_line" ] && [ "$skill_line" -lt "$prop_line" ] && echo true || echo false)"

kill "$SKILL_SSE_PID" 2>/dev/null || true
wait "$SKILL_SSE_PID" 2>/dev/null || true

# 4. SSE Heartbeat & Longevity Check (>= 20s)
echo "== SSE heartbeat longevity check (>= 20s)"
start_hb="$(mktemp)"
jq -n --arg pid "$PROJECT_ID" --arg cid "$CANVAS_ID" --argjson cv "$CANVAS_VERSION" \
  '{projectId: $pid, canvasId: $cid, canvasVersion: $cv, profileId: "creative-assistant", prompt: "smoke heartbeat test"}' > "$start_hb"
api "$TOKEN_A" POST /api/v1/agent/runs "$start_hb" >/dev/null
rm -f "$start_hb"
HB_RUN_ID=$(jq -r .run.id "$BODY")

ticket_req="$(mktemp)"; jq -n --arg id "$HB_RUN_ID" '{agentRunId: $id}' > "$ticket_req"
api "$TOKEN_A" POST /api/v1/realtime-tickets "$ticket_req" >/dev/null
rm -f "$ticket_req"
HB_TICKET=$(jq -r .ticket "$BODY")

curl -N -s -H "Origin: $WEB_URL" "$GATEWAY_URL/api/v1/realtime/agent/runs/$HB_RUN_ID/events?ticket=$HB_TICKET" > "$SSE_OUT_HEARTBEAT" 2>&1 &
HB_PID=$!

echo "Waiting 21s to verify heartbeat ping and connection longevity without 10s request timeout..."
sleep 21
check "P3.39 SSE connection alive after 21s" true "$(kill -0 "$HB_PID" 2>/dev/null && echo true || echo false)"
check "P3.40 SSE received heartbeat ping" true "$(grep -q "event: ping" "$SSE_OUT_HEARTBEAT" 2>/dev/null && echo true || echo false)"

kill "$HB_PID" 2>/dev/null || true
wait "$HB_PID" 2>/dev/null || true

echo "== All smoke tests finished. Failures: $failures =="
if [ "$failures" -gt 0 ]; then
  exit 1
fi
exit 0
