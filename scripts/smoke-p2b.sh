#!/usr/bin/env bash
# Realtime streaming, storage & media probe smoke test (P2b):
# SSE streaming via Gateway ticket, S3 asset upload/download, and Temporal Python media probe.
# Needs a running stack (pnpm docker:up, or pnpm dev + pnpm dev:worker), curl, jq, node (Node 22).
#   WEB_URL=http://localhost:3000 GATEWAY_URL=http://localhost:4000 scripts/smoke-p2b.sh
set -u

WEB_URL="${WEB_URL:-http://localhost:3000}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:4000}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOCK_SECRET="${MOCK_PROVIDER_WEBHOOK_SECRET:-mock-provider-webhook-secret-key-32chars}"
JAR_A="$(mktemp)"
JAR_B="$(mktemp)"
BODY="$(mktemp)"
ASSET_FILE="$(mktemp)"
DL_FILE="$(mktemp)"
SSE_OUT="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B" "$BODY" "$ASSET_FILE" "$DL_FILE" "$SSE_OUT"' EXIT
failures=0

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "PASS  $1 ($3)"; else echo "FAIL  $1: expected $2, got $3"; failures=$((failures + 1)); fi
}

signup_token() { # signup_token <jar> -> prints "<user id> <token>"
  local email="smoke-p2b-$(date +%s)-$RANDOM@example.com" signup token
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

sign_webhook() { # sign_webhook <secret> <timestamp> <body>
  node -e "
    const crypto = require('crypto');
    const secret = process.argv[1];
    const ts = process.argv[2];
    const body = process.argv[3];
    const sig = crypto.createHmac('sha256', secret).update(ts + '.' + body).digest('hex');
    process.stdout.write('sha256=' + sig);
  " "$1" "$2" "$3"
}

echo "== P2b: Realtime, Assets & Media Probe smoke tests"

read -r USER_A TOKEN_A < <(signup_token "$JAR_A")
read -r USER_B TOKEN_B < <(signup_token "$JAR_B")
check "P2b.1 users signed up" true "$([ -n "$USER_A" ] && [ "$USER_A" != "$USER_B" ] && echo true || echo false)"

# Create project and canvas
tmp="$(mktemp)"; echo '{"name":"Realtime & Assets Project"}' > "$tmp"
check "P2b.2 User A creates project" 201 "$(api "$TOKEN_A" POST /api/v1/projects "$tmp")"
rm -f "$tmp"
PROJECT_ID=$(jq -r .project.id "$BODY")
WORKSPACE_ID=$(jq -r .project.workspaceId "$BODY")
CANVAS_ID=$(jq -r '.project.canvases[0].id' "$BODY")
CPATH="/api/v1/projects/$PROJECT_ID/canvases/$CANVAS_ID"

# Save canvas state (valid DAG)
VALID_STATE=$(make_state valid)
save_body="$(mktemp)"
jq -n --argjson v 0 --arg s "$VALID_STATE" '{baseVersion: $v, state: $s}' > "$save_body"
check "P2b.3 User A saves canvas state" 200 "$(api "$TOKEN_A" PUT "$CPATH/state" "$save_body")"
rm -f "$save_body"

# Trigger run in callback mode
run_req="$(mktemp)"; echo '{"mockMode":"callback"}' > "$run_req"
check "P2b.4 User A triggers run in callback mode -> 202" 202 "$(api "$TOKEN_A" POST "$CPATH/runs" "$run_req")"
rm -f "$run_req"
RUN_ID=$(jq -r .run.id "$BODY")

# 1. Realtime Ticket Authorization & Single-Use Checks
echo "== Realtime ticket authorization"

ticket_req="$(mktemp)"; jq -n --arg id "$RUN_ID" '{runId: $id}' > "$ticket_req"
# Gateway signs ticket statelessly; User B receives ticket signed for User B
check "P2b.5 User B gets ticket -> 200" 200 "$(api "$TOKEN_B" POST /api/v1/realtime-tickets "$ticket_req")"
TICKET_B=$(jq -r .ticket "$BODY")
# But backend enforces resource authorization at connection: User B cannot stream User A run -> 404
HTTP_CODE_B=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $WEB_URL" "$GATEWAY_URL/api/v1/realtime/runs/$RUN_ID/events?ticket=$TICKET_B")
check "P2b.5b User B cannot stream User A run via ticket -> 404" 404 "$HTTP_CODE_B"

# User A gets ticket for run -> 200
check "P2b.6 User A gets ticket for run -> 200" 200 "$(api "$TOKEN_A" POST /api/v1/realtime-tickets "$ticket_req")"
rm -f "$ticket_req"
TICKET_1=$(jq -r .ticket "$BODY")
check "P2b.7 ticket is returned" true "$([ -n "$TICKET_1" ] && [ "$TICKET_1" != "null" ] && echo true || echo false)"

# Disallowed Origin -> 403
FORBIDDEN_ORIGIN="http://evil-attacker.com"
check "P2b.8 SSE with disallowed Origin -> 403" 403 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $FORBIDDEN_ORIGIN" "$GATEWAY_URL/api/v1/realtime/runs/$RUN_ID/events?ticket=$TICKET_1")"

# Consume ticket with valid Origin
HTTP_CODE_1=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 -H "Origin: $WEB_URL" "$GATEWAY_URL/api/v1/realtime/runs/$RUN_ID/events?ticket=$TICKET_1" || true)
check "P2b.9 first ticket usage succeeds" true "$([ "$HTTP_CODE_1" = "200" ] || [ "$HTTP_CODE_1" = "000" ] && echo true || echo false)"

# Reuse same ticket -> 401 Unauthorized (Single-use guarantee)
HTTP_CODE_REUSE=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $WEB_URL" "$GATEWAY_URL/api/v1/realtime/runs/$RUN_ID/events?ticket=$TICKET_1")
check "P2b.10 single-use ticket reuse -> 401" 401 "$HTTP_CODE_REUSE"

# 2. SSE Streaming Verification & Heartbeat
echo "== SSE stream lifecycle & heartbeat"
ticket_req="$(mktemp)"; jq -n --arg id "$RUN_ID" '{runId: $id}' > "$ticket_req"
api "$TOKEN_A" POST /api/v1/realtime-tickets "$ticket_req" >/dev/null
rm -f "$ticket_req"
STREAM_TICKET=$(jq -r .ticket "$BODY")

# Start background curl reading SSE stream
curl -N -s -H "Origin: $WEB_URL" "$GATEWAY_URL/api/v1/realtime/runs/$RUN_ID/events?ticket=$STREAM_TICKET" > "$SSE_OUT" 2>&1 &
SSE_PID=$!

# Wait for snapshot event in SSE stream
has_snapshot=false
for attempt in $(seq 1 10); do
  if grep -q "event: snapshot" "$SSE_OUT" 2>/dev/null; then
    has_snapshot=true
    break
  fi
  sleep 0.5
done
check "P2b.11 SSE receives initial snapshot event" true "$has_snapshot"

# Verify stream stays open for > 20s (exceeding 10s requestTimeout) with heartbeat ping
echo "Waiting 21s to verify heartbeat ping and connection longevity..."
sleep 21
check "P2b.12 SSE stream still alive after 21s" true "$(kill -0 "$SSE_PID" 2>/dev/null && echo true || echo false)"
check "P2b.13 SSE stream received heartbeat ping" true "$(grep -q "event: ping" "$SSE_OUT" 2>/dev/null && echo true || echo false)"

# Find job ID to send webhook callback
JOB_ID=""
for attempt in $(seq 1 10); do
  api "$TOKEN_A" GET "$CPATH/runs/$RUN_ID" >/dev/null
  JOB_ID=$(jq -r '.run.nodeRuns[] | select(.nodeType == "image.generate") | .externalJobId // empty' "$BODY")
  if [ -n "$JOB_ID" ]; then
    break
  fi
  sleep 1
done

# Deliver mock callback webhook to finish run
NOW_MS=$(node -e "process.stdout.write(String(Date.now()))")
PAYLOAD=$(jq -n --arg id "$JOB_ID" '{externalId: $id, status: "succeeded", output: {image: {url: "https://mock.test/art.png"}}}')
SIG=$(sign_webhook "$MOCK_SECRET" "$NOW_MS" "$PAYLOAD")
curl -s -o /dev/null -X POST "$GATEWAY_URL/api/webhooks/providers/mock" \
  -H 'content-type: application/json' \
  -H "x-mock-signature: $SIG" \
  -H "x-mock-timestamp: $NOW_MS" \
  -d "$PAYLOAD"

# Wait for terminal done event in SSE stream
has_done=false
for attempt in $(seq 1 15); do
  if grep -q "event: done" "$SSE_OUT" 2>/dev/null; then
    has_done=true
    break
  fi
  sleep 1
done
check "P2b.14 SSE received terminal done event" true "$has_done"
check "P2b.15 SSE received node.status and run.status" true \
  "$(grep -q "event: node.status" "$SSE_OUT" && grep -q "event: run.status" "$SSE_OUT" && echo true || echo false)"

# Kill background SSE curl if still running
kill "$SSE_PID" 2>/dev/null || true
wait "$SSE_PID" 2>/dev/null || true

# 3. Asset Upload, Validation, Complete & Download
echo "== Asset storage upload & download"
# Generate 1024 bytes test file
head -c 1024 /dev/urandom > "$ASSET_FILE"

# 3.1 Upload validation errors
up_req="$(mktemp)"
jq -n --arg ws "$WORKSPACE_ID" '{workspaceId: $ws, contentType: "invalid/type", sizeBytes: 1024}' > "$up_req"
check "P2b.16 invalid content type -> 400" 400 "$(api "$TOKEN_A" POST /api/v1/assets/upload-url "$up_req")"

jq -n --arg ws "$WORKSPACE_ID" '{workspaceId: $ws, contentType: "image/png", sizeBytes: 0}' > "$up_req"
check "P2b.17 sizeBytes <= 0 -> 400" 400 "$(api "$TOKEN_A" POST /api/v1/assets/upload-url "$up_req")"

# Non-member cannot request upload
jq -n --arg ws "$WORKSPACE_ID" '{workspaceId: $ws, contentType: "image/png", sizeBytes: 1024}' > "$up_req"
check "P2b.18 User B cannot request upload on User A workspace -> 404" 404 "$(api "$TOKEN_B" POST /api/v1/assets/upload-url "$up_req")"

# Valid upload request
check "P2b.19 User A requests asset upload URL -> 200" 200 "$(api "$TOKEN_A" POST /api/v1/assets/upload-url "$up_req")"
rm -f "$up_req"
ASSET_ID=$(jq -r .asset.id "$BODY")
UPLOAD_URL=$(jq -r .upload.url "$BODY")
check "P2b.20 asset created with pending status" pending "$(jq -r .asset.status "$BODY")"

# 3.2 Direct S3 PUT
# Wrong content-type PUT -> 403 (enforced by signed headers)
PUT_WRONG=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$UPLOAD_URL" -H 'content-type: image/jpeg' --data-binary "@$ASSET_FILE")
check "P2b.21 S3 rejects mismatched PUT content-type -> 403" 403 "$PUT_WRONG"

# Valid PUT
PUT_OK=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$UPLOAD_URL" -H 'content-type: image/png' --data-binary "@$ASSET_FILE")
check "P2b.22 S3 accepts matching PUT -> 200" 200 "$PUT_OK"

# 3.3 Complete asset
check "P2b.23 complete asset marks status ready -> 200" 200 "$(api "$TOKEN_A" POST "/api/v1/assets/$ASSET_ID/complete")"
check "P2b.24 asset status is ready" ready "$(jq -r .asset.status "$BODY")"

# Complete idempotency
check "P2b.25 repeated complete call is idempotent -> 200" 200 "$(api "$TOKEN_A" POST "/api/v1/assets/$ASSET_ID/complete")"

# 3.4 Download & Integrity check
check "P2b.26 User A gets download URL -> 200" 200 "$(api "$TOKEN_A" GET "/api/v1/assets/$ASSET_ID/download-url")"
DL_URL=$(jq -r .url "$BODY")
curl -s "$DL_URL" > "$DL_FILE"
check "P2b.27 downloaded content is byte-for-byte identical" true "$(cmp -s "$ASSET_FILE" "$DL_FILE" && echo true || echo false)"

# User B cannot access User A's asset
check "P2b.28 User B cannot get User A asset -> 404" 404 "$(api "$TOKEN_B" GET "/api/v1/assets/$ASSET_ID")"

# 4. Media Probe Temporal Workflow & Python Worker
echo "== Media probe workflow"

check "P2b.29 User A triggers media probe -> 202" 202 "$(api "$TOKEN_A" POST "/api/v1/assets/$ASSET_ID/probe")"
check "P2b.30 probe returned queued" true "$(jq -r .queued "$BODY")"

# Poll until probe metadata is filled by media worker
echo "Waiting for media-worker-python to process probe..."
probed=false
for attempt in $(seq 1 20); do
  api "$TOKEN_A" GET "/api/v1/assets/$ASSET_ID" >/dev/null
  PROBED_BY=$(jq -r '.asset.metadata.probedBy // empty' "$BODY")
  if [ "$PROBED_BY" = "media-worker-python" ]; then
    probed=true
    break
  fi
  sleep 1
done
check "P2b.31 media probe completed by media-worker-python" true "$probed"
check "P2b.32 probe metadata kind is image" image "$(jq -r .asset.metadata.kind "$BODY")"
check "P2b.33 probe metadata contentType is image/png" image/png "$(jq -r .asset.metadata.contentType "$BODY")"
check "P2b.34 probe metadata sizeBytes is 1024" 1024 "$(jq -r .asset.metadata.sizeBytes "$BODY")"
PYTHON_VERSION=$(jq -r '.asset.metadata.pythonVersion // empty' "$BODY")
check "P2b.35 probe metadata records pythonVersion" true "$([ -n "$PYTHON_VERSION" ] && echo true || echo false)"

echo
if [ "$failures" -eq 0 ]; then
  echo "All P2b smoke tests passed!"
  exit 0
else
  echo "$failures test(s) failed."
  exit 1
fi
