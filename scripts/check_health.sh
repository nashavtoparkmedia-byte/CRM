#!/bin/sh
# POSIX health-check wrapper for /api/health/infra.
# Cron- and Task-Scheduler-friendly: deterministic exit codes, single
# stdout line, no notifications, no SaaS, no dependencies beyond
# curl + grep.
#
# Exit codes
# ──────────
#   0  ok           — endpoint replied, status="ok"
#   1  degraded     — endpoint replied, status="degraded"
#   2  down         — endpoint replied, status="down"
#   3  unreachable  — endpoint did not reply (network / process down / 5xx without body)
#
# Override the URL via env (e.g. for testing or non-default port):
#   HEALTH_URL=http://localhost:9999/api/health/infra ./scripts/check_health.sh
#
# Override the curl timeout (seconds) via env:
#   HEALTH_TIMEOUT_S=10 ./scripts/check_health.sh
#
# Stdout is one of: "ok", "degraded", "down", "unreachable".
# Suitable for piping into a webhook script externally; this script
# deliberately ships no notify logic.

set -u

URL="${HEALTH_URL:-http://localhost:3002/api/health/infra}"
TIMEOUT="${HEALTH_TIMEOUT_S:-5}"

# `-s` silent, `-S` show errors on stderr (kept off stdout), `-m` overall
# timeout, `-o -` body to stdout. We do NOT pass `-f` because a 503 with
# a JSON body (`degraded` / `down`) is a meaningful response we want to
# parse — `-f` would suppress that body and treat 503 as transport
# failure.
BODY=$(curl -s -S -m "$TIMEOUT" -o - "$URL" 2>/dev/null) || {
    echo "unreachable"
    exit 3
}

# Empty body or unparseable → treat as unreachable. An HTML 404 page
# (server up but endpoint not deployed) lands here too — closer to
# «unreachable» than «degraded» from an operator's point of view.
if [ -z "$BODY" ]; then
    echo "unreachable"
    exit 3
fi

# No jq: a substring match against the JSON status field is enough
# because the server controls the exact shape (no whitespace variants).
# `grep -q` returns 0 on match, non-zero otherwise.
if echo "$BODY" | grep -q '"status":"ok"'; then
    echo "ok"
    exit 0
fi
if echo "$BODY" | grep -q '"status":"degraded"'; then
    echo "degraded"
    exit 1
fi
if echo "$BODY" | grep -q '"status":"down"'; then
    echo "down"
    exit 2
fi

# Body present but no recognised status field — treat as unreachable.
# The endpoint is implemented to always emit one of the three, so this
# only fires if something other than our CRM is answering at that URL.
echo "unreachable"
exit 3
