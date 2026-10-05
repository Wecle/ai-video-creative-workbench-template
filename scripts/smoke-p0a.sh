#!/usr/bin/env bash
# Gateway/auth smoke test: backend trust boundary and the sign-up -> token -> /api/v1/me flow.
# Needs a running stack (pnpm dev or pnpm docker:up), curl and jq.
#   WEB_URL=http://localhost:3000 GATEWAY_URL=http://localhost:4000 BACKEND_URL=http://localhost:4001 scripts/smoke-p0a.sh
set -u

WEB_URL="${WEB_URL:-http://localhost:3000}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:4000}"
BACKEND_URL="${BACKEND_URL:-http://localhost:4001}"
EMAIL="smoke-$(date +%s)-$RANDOM@example.com"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
failures=0

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "PASS  $1 ($3)"; else echo "FAIL  $1: expected $2, got $3"; failures=$((failures + 1)); fi
}
status() { curl -s -o /dev/null -w "%{http_code}" "$@"; }

echo "== A1: backend trusts only the gateway"
check "A1.1 backend /api/v1/me without a signature" 403 "$(status "$BACKEND_URL/api/v1/me")"
check "A1.2 backend /health" 200 "$(status "$BACKEND_URL/health")"
check "A1.3 backend /api/auth/token without a signature" 403 "$(status "$BACKEND_URL/api/auth/token")"
check "A1.4 backend /api/auth/jwks without a signature (public)" 200 "$(status "$BACKEND_URL/api/auth/jwks")"

echo "== A3: identity"
signup=$(curl -s -c "$JAR" -X POST "$WEB_URL/api/auth/sign-up/email" \
  -H 'content-type: application/json' -H "origin: $WEB_URL" \
  -d "{\"name\":\"smoke\",\"email\":\"$EMAIL\",\"password\":\"password-1234\"}")
check "A3.1 sign-up returns a user id" true "$(echo "$signup" | jq -r '.user.id != null')"
TOKEN=$(curl -s -b "$JAR" "$WEB_URL/api/auth/token" | jq -r .token)
check "A3.2 /api/auth/token returns a JWT" 3 "$(echo "$TOKEN" | awk -F. '{print NF}')"
check "A3.3 /api/v1/me without a token" 401 "$(status "$GATEWAY_URL/api/v1/me")"
me=$(curl -s -H "authorization: Bearer $TOKEN" -H "x-internal-user-id: someone-else" "$GATEWAY_URL/api/v1/me")
echo "      $me"
check "A3.4a /api/v1/me user id is the token's user (forged header ignored)" "$(echo "$signup" | jq -r .user.id)" "$(echo "$me" | jq -r .user.id)"
check "A3.4b exactly one workspace" 1 "$(echo "$me" | jq '.workspaces | length')"
check "A3.4c workspace role" owner "$(echo "$me" | jq -r '.workspaces[0].role')"
# Change the FIRST character of the signature. Changing the last one is flaky: the final
# base64url character of an Ed25519 signature carries 4 padding bits, so "w" -> "x" decodes
# to the same bytes and the token stays valid.
SIG="${TOKEN##*.}"
FLIP=$([ "${SIG:0:1}" = "A" ] && echo B || echo A)
check "A3.5 tampered token" 401 "$(status -H "authorization: Bearer ${TOKEN%.*}.${FLIP}${SIG:1}" "$GATEWAY_URL/api/v1/me")"
check "A3.6 /api/v1/me through the web rewrite with a token" 200 "$(status -H "authorization: Bearer $TOKEN" "$WEB_URL/gateway/api/v1/me")"
check "A3.7 web redirects an anonymous visitor to /login" "307 /login?next=%2F" \
  "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$WEB_URL/" | sed "s#$WEB_URL##")"

if [ "$failures" -gt 0 ]; then echo "$failures check(s) failed"; exit 1; fi
echo "all checks passed"
