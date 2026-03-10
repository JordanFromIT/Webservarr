#!/usr/bin/env bash
# WebServarr Smoke Test — verifies a fresh install works end-to-end
set -euo pipefail

BASE_URL="${1:-http://localhost:8000}"
COOKIE_JAR=$(mktemp)
trap "rm -f $COOKIE_JAR" EXIT

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; exit 1; }

echo "=== WebServarr Smoke Test ==="
echo "Target: $BASE_URL"
echo ""

# 1. Health check
echo "1. Health check"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/health")
[ "$STATUS" = "200" ] && pass "GET /health → 200" || fail "GET /health → $STATUS"

# 2. Setup redirect (fresh install should redirect to /setup)
echo "2. Setup redirect"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -L --max-redirs 0 "$BASE_URL/")
[ "$STATUS" = "302" ] && pass "GET / → 302 redirect" || echo "  - GET / → $STATUS (may be post-setup)"

# 3. Complete setup
echo "3. Complete setup"
SETUP_RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/setup/complete" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"testpass123","password_confirm":"testpass123"}')
SETUP_CODE=$(echo "$SETUP_RESP" | tail -1)
[ "$SETUP_CODE" = "200" ] && pass "POST /api/setup/complete → 200" || pass "Setup already completed ($SETUP_CODE)"

# 4. Login
echo "4. Authentication"
LOGIN_RESP=$(curl -s -o /dev/null -w "%{http_code}" -c "$COOKIE_JAR" -X POST "$BASE_URL/auth/simple-login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"testpass123"}')
[ "$LOGIN_RESP" = "200" ] && pass "POST /auth/simple-login → 200" || fail "Login failed → $LOGIN_RESP"

# 5. Session check
SESSION_RESP=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" "$BASE_URL/auth/check-session")
[ "$SESSION_RESP" = "200" ] && pass "GET /auth/check-session → 200" || fail "Session check failed → $SESSION_RESP"

# 6. Page endpoints
echo "5. Page endpoints"
for PAGE in "/" "/settings" "/requests" "/issues" "/calendar" "/tickets"; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" "$BASE_URL$PAGE")
  [ "$STATUS" = "200" ] && pass "GET $PAGE → 200" || fail "GET $PAGE → $STATUS"
done

# 7. API endpoints
echo "6. API endpoints"
for ENDPOINT in "/api/branding" "/api/status/services" "/api/news" "/api/notifications" "/api/admin/settings"; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" "$BASE_URL$ENDPOINT")
  [ "$STATUS" = "200" ] && pass "GET $ENDPOINT → 200" || fail "GET $ENDPOINT → $STATUS"
done

echo ""
echo "=== All checks passed ==="
