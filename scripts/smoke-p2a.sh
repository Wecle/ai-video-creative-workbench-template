#!/usr/bin/env bash
# Canvas execution chain smoke test: DAG workflow, mock provider, polling, callback & webhook verification.
# Needs a running stack (pnpm dev, or pnpm docker:up), curl, jq, node (Node 22).
#   WEB_URL=http://localhost:3000 GATEWAY_URL=http://localhost:4000 scripts/smoke-p2a.sh
set -u

WEB_URL="${WEB_URL:-http://localhost:3000}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:4000}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOCK_SECRET="${MOCK_PROVIDER_WEBHOOK_SECRET:-mock-provider-webhook-secret-key-32chars}"
JAR_A="$(mktemp)"
JAR_B="$(mktemp)"
BODY="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B" "$BODY"' EXIT
failures=0

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "PASS  $1 ($3)"; else echo "FAIL  $1: expected $2, got $3"; failures=$((failures + 1)); fi
}

signup_token() { # signup_token <jar> -> prints "<user id> <token>"
  local email="smoke-p2a-$(date +%s)-$RANDOM@example.com" signup token
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

put_body() {
  local file; file="$(mktemp)"
  jq -n --argjson v "$1" --arg s "$2" '{baseVersion: $v, state: $s}' > "$file"
  echo "$file"
}

save() {
  local file code; file="$(put_body "$3" "$4")"
  code=$(api "$1" PUT "$2/state" "$file")
  rm -f "$file"
  echo "$code"
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

echo "== P2a: Execution Chain smoke tests"

read -r USER_A TOKEN_A < <(signup_token "$JAR_A")
read -r USER_B TOKEN_B < <(signup_token "$JAR_B")
check "P2a.1 users signed up" true "$([ -n "$USER_A" ] && [ "$USER_A" != "$USER_B" ] && echo true || echo false)"

# Create project and canvas
tmp="$(mktemp)"; echo '{"name":"Execution smoke project"}' > "$tmp"
check "P2a.2 A creates project" 201 "$(api "$TOKEN_A" POST /api/v1/projects "$tmp")"
rm -f "$tmp"
PROJECT=$(jq -r .project.id "$BODY")
CANVAS=$(jq -r '.project.canvases[0].id' "$BODY")
CPATH="/api/v1/projects/$PROJECT/canvases/$CANVAS"

# Save a valid state (text -> image.generate)
VALID=$(make_state valid)
check "P2a.3 A saves canvas state" 200 "$(save "$TOKEN_A" "$CPATH" 0 "$VALID")"

# 1. Auth & Isolation checks
check "P2a.4 POST runs without token -> 401" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GATEWAY_URL$CPATH/runs")"

run_req="$(mktemp)"; echo '{"mockMode":"polling"}' > "$run_req"
check "P2a.5 User B cannot trigger run on User A canvas -> 404" 404 \
  "$(api "$TOKEN_B" POST "$CPATH/runs" "$run_req")"

# 2. Polling Mode Execution
echo "== Polling mode execution"
check "P2a.6 User A triggers run in polling mode -> 202" 202 \
  "$(api "$TOKEN_A" POST "$CPATH/runs" "$run_req")"
rm -f "$run_req"

POLL_RUN_ID=$(jq -r .run.id "$BODY")
POLL_STATUS=$(jq -r .run.status "$BODY")
check "P2a.7 initial run status is queued" queued "$POLL_STATUS"

# Poll until completed
echo "Polling for run completion ($POLL_RUN_ID)..."
succeeded=false
for attempt in $(seq 1 30); do
  code=$(api "$TOKEN_A" GET "$CPATH/runs/$POLL_RUN_ID")
  current_status=$(jq -r .run.status "$BODY")
  if [ "$current_status" = "succeeded" ]; then
    succeeded=true
    break
  fi
  if [ "$current_status" = "failed" ]; then
    break
  fi
  sleep 1
done
check "P2a.8 polling run reached succeeded" true "$succeeded"
check "P2a.9 polling run nodeRuns has 2 succeeded nodes" 2 \
  "$(jq '[.run.nodeRuns[] | select(.status == "succeeded")] | length' "$BODY")"

# Isolation check on run details
check "P2a.10 User B cannot GET User A's run -> 404" 404 \
  "$(api "$TOKEN_B" GET "$CPATH/runs/$POLL_RUN_ID")"

# 3. Callback Mode & Webhook Security
echo "== Callback mode & webhook security"
cb_req="$(mktemp)"; echo '{"mockMode":"callback"}' > "$cb_req"
check "P2a.11 User A triggers run in callback mode -> 202" 202 \
  "$(api "$TOKEN_A" POST "$CPATH/runs" "$cb_req")"
rm -f "$cb_req"

CB_RUN_ID=$(jq -r .run.id "$BODY")

# Wait for image node to start and obtain externalJobId
JOB_ID=""
for attempt in $(seq 1 15); do
  api "$TOKEN_A" GET "$CPATH/runs/$CB_RUN_ID" >/dev/null
  JOB_ID=$(jq -r '.run.nodeRuns[] | select(.nodeType == "image.generate") | .externalJobId // empty' "$BODY")
  if [ -n "$JOB_ID" ]; then
    break
  fi
  sleep 1
done
check "P2a.12 image node registered externalJobId" true "$([ -n "$JOB_ID" ] && echo true || echo false)"

echo "Testing webhooks for job $JOB_ID..."
NOW_MS=$(node -e "process.stdout.write(String(Date.now()))")
VALID_PAYLOAD=$(jq -n --arg id "$JOB_ID" '{externalId: $id, status: "succeeded", output: {image: {url: "https://mock.test/out.png", width: 1024, height: 1024}}}')

# 3.1 Forged signature -> 401
FORGED_SIG="sha256=0000000000000000000000000000000000000000000000000000000000000000"
check "P2a.13 webhook forged signature -> 401" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GATEWAY_URL/api/webhooks/providers/mock" \
    -H 'content-type: application/json' \
    -H "x-mock-signature: $FORGED_SIG" \
    -H "x-mock-timestamp: $NOW_MS" \
    -d "$VALID_PAYLOAD")"

# 3.2 Expired timestamp -> 401
EXPIRED_MS=$((NOW_MS - 305000))
EXPIRED_SIG=$(sign_webhook "$MOCK_SECRET" "$EXPIRED_MS" "$VALID_PAYLOAD")
check "P2a.14 webhook expired timestamp -> 401" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GATEWAY_URL/api/webhooks/providers/mock" \
    -H 'content-type: application/json' \
    -H "x-mock-signature: $EXPIRED_SIG" \
    -H "x-mock-timestamp: $EXPIRED_MS" \
    -d "$VALID_PAYLOAD")"

# 3.3 Tampered body -> 401
VALID_SIG=$(sign_webhook "$MOCK_SECRET" "$NOW_MS" "$VALID_PAYLOAD")
TAMPERED_PAYLOAD=$(jq -n --arg id "$JOB_ID" '{externalId: $id, status: "succeeded", output: {tampered: true}}')
check "P2a.15 webhook tampered body -> 401" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GATEWAY_URL/api/webhooks/providers/mock" \
    -H 'content-type: application/json' \
    -H "x-mock-signature: $VALID_SIG" \
    -H "x-mock-timestamp: $NOW_MS" \
    -d "$TAMPERED_PAYLOAD")"

# 3.4 Valid webhook delivery -> 200
check "P2a.16 valid webhook delivered -> 200" 200 \
  "$(curl -s -o "$BODY" -w '%{http_code}' -X POST "$GATEWAY_URL/api/webhooks/providers/mock" \
    -H 'content-type: application/json' \
    -H "x-mock-signature: $VALID_SIG" \
    -H "x-mock-timestamp: $NOW_MS" \
    -d "$VALID_PAYLOAD")"
check "P2a.17 webhook received: true" true "$(jq -r .received "$BODY")"

# 3.5 Wait for callback run completion
cb_succeeded=false
for attempt in $(seq 1 30); do
  api "$TOKEN_A" GET "$CPATH/runs/$CB_RUN_ID" >/dev/null
  current_status=$(jq -r .run.status "$BODY")
  if [ "$current_status" = "succeeded" ]; then
    cb_succeeded=true
    break
  fi
  sleep 1
done
check "P2a.18 callback run reached succeeded" true "$cb_succeeded"

# 3.6 Webhook duplicate check -> 200 already processed
check "P2a.19 duplicate webhook -> 200 already processed" 200 \
  "$(curl -s -o "$BODY" -w '%{http_code}' -X POST "$GATEWAY_URL/api/webhooks/providers/mock" \
    -H 'content-type: application/json' \
    -H "x-mock-signature: $VALID_SIG" \
    -H "x-mock-timestamp: $NOW_MS" \
    -d "$VALID_PAYLOAD")"
check "P2a.20 duplicate response is already processed" "already processed" "$(jq -r .message "$BODY")"

echo
if [ "$failures" -eq 0 ]; then
  echo "All P2a smoke tests passed!"
  exit 0
else
  echo "$failures test(s) failed."
  exit 1
fi
