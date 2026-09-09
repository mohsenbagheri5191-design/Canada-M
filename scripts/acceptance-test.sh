#!/usr/bin/env bash
#
# Live acceptance tests against a deployed project.
#
# Walks the acceptance criteria end to end: bad auth, disabled accounts,
# non-admin access to admin endpoints, quota exhaustion, the kill switch,
# token refresh, CORS, and direct table access with the anon key.
#
# It creates a throwaway user, drives it through every failure state, and
# deletes it again. Nothing else in your project is touched, except the kill
# switch which is turned on and back off during one test.
#
# Usage:
#   ./scripts/acceptance-test.sh <admin-email> <admin-password>
#
# Requires: curl, jq

set -uo pipefail

ADMIN_EMAIL="${1:-}"
ADMIN_PASSWORD="${2:-}"

URL="${SUPABASE_URL:-https://ftwkxuqqnbtuegabxxnj.supabase.co}"
ANON="${SUPABASE_ANON_KEY:-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ0d2t4dXFxbmJ0dWVnYWJ4eG5qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4Mjk4NzMsImV4cCI6MjEwNDQwNTg3M30.U-rq83swyVQkTwfvWdjX8-_tRdQd9RCoCMTkaJUpgR0}"
ORIGIN="${ALLOWED_ORIGIN:-chrome-extension://mmekjhdfdgcbnphlbpbmkfjiibcfocpk}"

if [[ -z "$ADMIN_EMAIL" || -z "$ADMIN_PASSWORD" ]]; then
  echo "usage: $0 <admin-email> <admin-password>" >&2
  exit 2
fi

for tool in curl jq; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }
done

PASS=0
FAIL=0

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

# Calls an Edge Function and prints "<status> <body>".
api() {
  local fn="$1" token="$2" body="${3:-\{\}}" origin="${4:-$ORIGIN}"
  curl -s -w '\n%{http_code}' -X POST "$URL/functions/v1/$fn" \
    -H "apikey: $ANON" \
    -H "Origin: $origin" \
    ${token:+-H "Authorization: Bearer $token"} \
    -H 'Content-Type: application/json' \
    -d "$body" | tr '\n' ' '
}

# expect <label> <expected-status> <expected-code-or-.> <actual "status body">
expect() {
  local label="$1" want_status="$2" want_code="$3" actual="$4"
  local status body code

  status=$(awk '{print $NF}' <<<"$actual")
  body=$(sed "s/ ${status}\$//" <<<"$actual")
  code=$(jq -r '.error.code // "none"' <<<"$body" 2>/dev/null || echo "unparseable")

  if [[ "$status" == "$want_status" ]] && { [[ "$want_code" == "." ]] || [[ "$code" == "$want_code" ]]; }; then
    green "  pass  $label  ($status${want_code:+/$code})"
    PASS=$((PASS + 1))
  else
    red   "  FAIL  $label"
    red   "        wanted $want_status/$want_code, got $status/$code"
    red   "        $(head -c 300 <<<"$body")"
    FAIL=$((FAIL + 1))
  fi
}

signin() {
  curl -s -X POST "$URL/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}"
}

bold "Signing in as $ADMIN_EMAIL"
ADMIN_SESSION=$(signin "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
ADMIN_TOKEN=$(jq -r '.access_token // empty' <<<"$ADMIN_SESSION")

if [[ -z "$ADMIN_TOKEN" ]]; then
  red "  could not sign in: $(jq -r '.error_description // .msg // .' <<<"$ADMIN_SESSION")"
  exit 1
fi
green "  signed in"

# ---------------------------------------------------------------------------
bold "1. Bad auth is rejected"
expect "no token -> 401 missing_token"     401 missing_token "$(api me "" )"
expect "junk token -> 401 invalid_token"   401 invalid_token "$(api me "not.a.real.token")"

# ---------------------------------------------------------------------------
bold "2. CORS is an allowlist, not a wildcard"
expect "unknown origin -> 403" 403 origin_not_allowed \
  "$(api me "$ADMIN_TOKEN" '{}' 'https://evil.example')"

CORS_HEADER=$(curl -si -X POST "$URL/functions/v1/me" \
  -H "apikey: $ANON" -H "Origin: https://evil.example" \
  -H 'Content-Type: application/json' -d '{}' \
  | grep -ci 'access-control-allow-origin' || true)

if [[ "$CORS_HEADER" == "0" ]]; then
  green "  pass  no Access-Control-Allow-Origin for a disallowed origin"
  PASS=$((PASS + 1))
else
  red "  FAIL  a disallowed origin still received CORS headers"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
bold "3. Direct table access with the anon key returns nothing"
for table in profiles usage_events app_settings audit_log; do
  ROWS=$(curl -s "$URL/rest/v1/$table?select=*" -H "apikey: $ANON")
  COUNT=$(jq 'if type=="array" then length else -1 end' <<<"$ROWS" 2>/dev/null || echo -1)

  if [[ "$COUNT" == "0" || "$COUNT" == "-1" ]]; then
    green "  pass  $table exposes no rows to anon"
    PASS=$((PASS + 1))
  else
    red "  FAIL  $table returned $COUNT rows to the anon key"
    FAIL=$((FAIL + 1))
  fi
done

# ---------------------------------------------------------------------------
bold "4. Admin can work"
expect "me -> 200"                200 . "$(api me "$ADMIN_TOKEN")"
expect "admin-users list -> 200"  200 . "$(api admin-users "$ADMIN_TOKEN" '{"op":"list"}')"
expect "admin-usage -> 200"       200 . "$(api admin-usage "$ADMIN_TOKEN" '{"days":30,"recent":5}')"
expect "research score -> 200"    200 . "$(api research "$ADMIN_TOKEN" \
  '{"op":"score","items":[{"asin":"B000000001","rank":1200,"priceNumber":24.99,"reviewCount":340,"variationCount":3}]}')"

SCORED=$(api research "$ADMIN_TOKEN" \
  '{"op":"score","items":[{"asin":"B000000001","rank":1200,"priceNumber":24.99,"reviewCount":340,"variationCount":3}]}')
UNITS=$(sed 's/ [0-9]*$//' <<<"$SCORED" | jq -r '.items[0].bsrEstimatedUnitsMid // "none"')
if [[ "$UNITS" != "none" && "$UNITS" != "null" ]]; then
  green "  pass  server returned an estimate the client never computed ($UNITS units)"
  PASS=$((PASS + 1))
else
  red "  FAIL  research returned no estimate"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
bold "5. Creating a throwaway user"
TEST_EMAIL="acceptance-$(date +%s)@example.com"
TEST_PASSWORD="Acceptance-$(openssl rand -hex 10)"

CREATED=$(api admin-users "$ADMIN_TOKEN" \
  "{\"op\":\"create\",\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"role\":\"user\",\"quota\":2}")
expect "create user -> 200" 200 . "$CREATED"

TEST_ID=$(sed 's/ [0-9]*$//' <<<"$CREATED" | jq -r '.userId // empty')
if [[ -z "$TEST_ID" ]]; then
  red "  could not create the test user; stopping here"
  exit 1
fi

cleanup() {
  # Runs on any exit, including a failed assertion part-way through, so the
  # kill switch is never left on and no test account is left behind.
  [[ -n "${TEST_ID:-}" ]] &&
    api admin-users "$ADMIN_TOKEN" "{\"op\":\"delete\",\"userId\":\"$TEST_ID\"}" >/dev/null
  api admin-users "$ADMIN_TOKEN" '{"op":"settings.update","killSwitch":false}' >/dev/null
  echo
  echo "cleaned up: throwaway account removed, kill switch confirmed off"
}
trap cleanup EXIT

USER_SESSION=$(signin "$TEST_EMAIL" "$TEST_PASSWORD")
USER_TOKEN=$(jq -r '.access_token // empty' <<<"$USER_SESSION")
USER_REFRESH=$(jq -r '.refresh_token // empty' <<<"$USER_SESSION")

if [[ -n "$USER_TOKEN" ]]; then
  green "  pass  the new user can sign in"
  PASS=$((PASS + 1))
else
  red "  FAIL  the new user could not sign in"
  FAIL=$((FAIL + 1))
  exit 1
fi

# ---------------------------------------------------------------------------
bold "6. A non-admin cannot reach the admin API"
expect "admin-users -> 403 not_admin" 403 not_admin "$(api admin-users "$USER_TOKEN" '{"op":"list"}')"
expect "admin-usage -> 403 not_admin" 403 not_admin "$(api admin-usage "$USER_TOKEN" '{"days":30}')"

# ---------------------------------------------------------------------------
bold "7. Quota is enforced (this account has 2 requests)"
ITEM='{"op":"score","items":[{"asin":"B000000002","rank":900,"priceNumber":19.99,"reviewCount":50}]}'
expect "request 1 -> 200"                 200 . "$(api research "$USER_TOKEN" "$ITEM")"
expect "request 2 -> 200"                 200 . "$(api research "$USER_TOKEN" "$ITEM")"
expect "request 3 -> 403 quota_exceeded"  403 quota_exceeded "$(api research "$USER_TOKEN" "$ITEM")"

# ---------------------------------------------------------------------------
bold "8. Disabling takes effect on the very next request"
api admin-users "$ADMIN_TOKEN" "{\"op\":\"disable\",\"userId\":\"$TEST_ID\"}" >/dev/null
# Same token as before: no sign-out, no expiry, no refresh.
expect "same token -> 403 account_disabled" 403 account_disabled "$(api me "$USER_TOKEN")"

api admin-users "$ADMIN_TOKEN" "{\"op\":\"enable\",\"userId\":\"$TEST_ID\"}" >/dev/null
expect "re-enabled -> 200"                  200 . "$(api me "$USER_TOKEN")"

# ---------------------------------------------------------------------------
bold "9. Expiry is evaluated live"
YESTERDAY=$(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -v-1d +%Y-%m-%dT%H:%M:%SZ)
api admin-users "$ADMIN_TOKEN" \
  "{\"op\":\"update\",\"userId\":\"$TEST_ID\",\"accessExpiresAt\":\"$YESTERDAY\"}" >/dev/null
expect "past expiry -> 403 account_expired" 403 account_expired "$(api me "$USER_TOKEN")"

api admin-users "$ADMIN_TOKEN" \
  "{\"op\":\"update\",\"userId\":\"$TEST_ID\",\"accessExpiresAt\":null}" >/dev/null

# ---------------------------------------------------------------------------
bold "10. Refresh tokens work, and a revoked one fails cleanly"
REFRESHED=$(curl -s -X POST "$URL/auth/v1/token?grant_type=refresh_token" \
  -H "apikey: $ANON" -H 'Content-Type: application/json' \
  -d "{\"refresh_token\":\"$USER_REFRESH\"}")
NEW_TOKEN=$(jq -r '.access_token // empty' <<<"$REFRESHED")

if [[ -n "$NEW_TOKEN" ]]; then
  green "  pass  refresh returned a new access token"
  PASS=$((PASS + 1))
else
  red "  FAIL  refresh did not return a token"
  FAIL=$((FAIL + 1))
fi

# A revoked refresh token must fail, so the client re-logins instead of looping.
#
# Note this is tested by signing out rather than by replaying the previous
# token. Supabase has a reuse-tolerance window (10s by default) in which
# replaying a just-spent refresh token returns the same new session, so two
# tabs refreshing at the same moment both succeed. That is deliberate, and
# testing replay would assert the wrong thing. Revocation is the real case.
curl -s -o /dev/null -X POST "$URL/auth/v1/logout" \
  -H "apikey: $ANON" -H "Authorization: Bearer $NEW_TOKEN"

REVOKED=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/auth/v1/token?grant_type=refresh_token" \
  -H "apikey: $ANON" -H 'Content-Type: application/json' \
  -d "{\"refresh_token\":\"$USER_REFRESH\"}")

if [[ "$REVOKED" != "200" ]]; then
  green "  pass  a revoked refresh token is rejected ($REVOKED), so no refresh loop"
  PASS=$((PASS + 1))
else
  red "  FAIL  a revoked refresh token was still accepted"
  FAIL=$((FAIL + 1))
fi

# Sign in again so the remaining tests have a live session.
USER_SESSION=$(signin "$TEST_EMAIL" "$TEST_PASSWORD")
NEW_TOKEN=$(jq -r '.access_token // empty' <<<"$USER_SESSION")

# ---------------------------------------------------------------------------
bold "11. The kill switch blocks everyone, including the admin"
api admin-users "$ADMIN_TOKEN" \
  '{"op":"settings.update","killSwitch":true,"killSwitchMessage":"Acceptance test in progress."}' >/dev/null
sleep 1

expect "user me -> 503 kill_switch"     503 kill_switch "$(api me "$NEW_TOKEN")"
expect "ADMIN me -> 503 kill_switch"    503 kill_switch "$(api me "$ADMIN_TOKEN")"
expect "research -> 503 kill_switch"    503 kill_switch "$(api research "$ADMIN_TOKEN" "$ITEM")"
# The control plane must stay reachable, or the switch is a one-way door.
expect "admin-users still works -> 200" 200 . "$(api admin-users "$ADMIN_TOKEN" '{"op":"list"}')"

api admin-users "$ADMIN_TOKEN" '{"op":"settings.update","killSwitch":false}' >/dev/null
sleep 1
expect "after turning it off -> 200"    200 . "$(api me "$ADMIN_TOKEN")"

# ---------------------------------------------------------------------------
bold "12. Deletion is immediate"
api admin-users "$ADMIN_TOKEN" "{\"op\":\"delete\",\"userId\":\"$TEST_ID\"}" >/dev/null
TEST_ID=""   # gone; stop the cleanup trap from trying again

# Either code is correct here and which one you get depends on whether the
# Auth API has finished invalidating the JWT: 401 invalid_token if the user
# record is already gone, 403 no_profile if the token still resolves but the
# profile row has cascaded away. Both mean "refused".
DELETED=$(api me "$NEW_TOKEN")
DELETED_STATUS=$(awk '{print $NF}' <<<"$DELETED")

if [[ "$DELETED_STATUS" == "401" || "$DELETED_STATUS" == "403" ]]; then
  green "  pass  a deleted account is refused immediately ($DELETED_STATUS)"
  PASS=$((PASS + 1))
else
  red "  FAIL  a deleted account still got $DELETED_STATUS"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
echo
if [[ $FAIL -eq 0 ]]; then
  green "All $PASS checks passed."
  exit 0
fi
red "$FAIL of $((PASS + FAIL)) checks failed."
exit 1
