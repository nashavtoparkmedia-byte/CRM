#!/usr/bin/env bash
# Restore crm.conf.template and conf.d/crm.conf from ONE backup taken by apply-gate.sh, only if
# that backup keeps Security P0 (R1). A backup the shared checker does not pass would reopen the
# CRM to anonymous visitors, so it is refused before any file is touched.
#
#   CASH_SLOT=granted bash rollback-gate.sh <backup-dir>
#
# One attempt, no fallback: on any failure this script never tries another backup. If P0 does
# not hold afterwards it says so and stops; that is a Security escalation, not a reason to roll
# back further.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
[ "${CASH_SLOT:-}" = granted ] || { echo "refused: run with CASH_SLOT=granted inside an admitted slot"; exit 64; }
B=$(cd "${1:?backup directory}" && pwd)
case "$B/" in
    */QUARANTINED-PRE-P0/*) echo "REFUSED: $B is quarantined (pre-P0); nothing changed"; exit 1 ;;
esac
[ -f "$B/crm.conf.template" ] && [ -f "$B/crm.conf" ] || stop "$B is not an apply-gate backup"

# Check the exact bytes that would be restored, from a private copy.
W=$(mktemp -d)
trap 'rm -rf -- "$W"' EXIT
mkdir "$W/candidate"
cp "$B/crm.conf.template" "$B/crm.conf" "$W/candidate/"
if ! p0_holds backup backup "$W/candidate"; then
    echo "REFUSED: $B does not keep Security P0; restoring it would reopen the CRM. Nothing changed."
    exit 1
fi

# Keep the state being replaced, so a failed nginx test puts back exactly that.
U=$B.replaced-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -m 0700 "$U"
cp -p "$TEMPLATE" "$RENDERED" "$U/"
install -m 0644 "$W/candidate/crm.conf.template" "$TEMPLATE"
install -m 0644 "$W/candidate/crm.conf" "$RENDERED"
if ! nginx_test_and_reload; then
    cp -p "$U/crm.conf.template" "$TEMPLATE"
    cp -p "$U/crm.conf" "$RENDERED"
    stop "nginx -t or reload failed; the replaced files are back (kept in $U), nothing reloaded"
fi

if ! p0_holds live-after live; then
    echo "P0 NOT HOLDING after restoring $B. Do not try another backup: escalate to Security."
    echo "The replaced files are kept in $U."
    exit 1
fi
echo "restored $B; Security P0 holds (replaced files kept in $U)"
