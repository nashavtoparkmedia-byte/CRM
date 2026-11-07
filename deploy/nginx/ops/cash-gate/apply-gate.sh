#!/usr/bin/env bash
# Install a Cash action-map kit made by regen-gate-map.sh (R2). PRODUCTION WRITE: only inside an
# admitted slot. nginx is reloaded, never recreated, so the runtime fingerprint does not move.
#
#   CASH_SLOT=granted bash apply-gate.sh <kit-dir>
#
# Before anything is written:
#   - production already holds Security P0;
#   - nothing moved since the kit was made;
#   - the candidate template keeps P0, is an approved template and differs from the live one
#     only in Cash action-map entries;
#   - the candidate render keeps P0;
#   - the Cash user file is usable.
# After the reload, P0 must still hold, and the Cash routes must behave as before.
# On a failed post-check only this run's own backup is put back, and only if it keeps P0;
# nothing older is ever suggested or restored.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
[ "${CASH_SLOT:-}" = granted ] || { echo "refused: run with CASH_SLOT=granted inside an admitted slot"; exit 64; }
K=$(cd "${1:?kit directory}" && pwd)
for f in crm.conf.template.current crm.conf.rendered.current crm.conf.template.candidate \
         crm.conf.rendered.candidate cash-action-ids.txt cash-action-ids.gravity-image.txt; do
    [ -f "$K/$f" ] || stop "kit $K lacks $f"
done

p0_holds live-before live || stop "production does not hold Security P0 now; nothing changed"
cmp -s "$TEMPLATE" "$K/crm.conf.template.current" || stop "live crm.conf.template changed since the kit was made"
cmp -s "$RENDERED" "$K/crm.conf.rendered.current" || stop "live conf.d/crm.conf is not the one the kit was made from"

# Check the exact bytes that will be installed, from private copies.
W=$(mktemp -d)
trap 'rm -rf -- "$W"' EXIT
cp "$K/crm.conf.template.candidate" "$W/template"
cp "$K/crm.conf.rendered.candidate" "$W/rendered"
p0_holds template-candidate template "$W/template" || stop "the candidate template does not keep Security P0"
p0_holds map-only map-only-diff "$TEMPLATE" "$W/template" || stop "the candidate changes more than Cash action-map entries"
p0_holds rendered-candidate rendered "$W/rendered" || stop "the candidate render does not keep Security P0"
mapfile -t gate < <(gate_files "$W/template")
[ "${#gate[@]}" = 3 ] || stop "the candidate names no single staff and Cash user file"
check_user_file "${gate[0]}"
check_user_file "${gate[1]}"
CASH_REALM=${gate[2]}
grep -qxF "$(docker inspect crm-gravity-mvp --format '{{.Image}}')" "$K/cash-action-ids.gravity-image.txt" \
    || stop "the running Gravity image is not one the Cash action ids were taken from: regenerate the kit"

B=$K/backup-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -m 0700 "$B"
cp -p "$TEMPLATE" "$B/crm.conf.template"
cp -p "$RENDERED" "$B/crm.conf"
echo "backup: $B"
restore_backup() { cp -p "$B/crm.conf.template" "$TEMPLATE"; cp -p "$B/crm.conf" "$RENDERED"; }

install -m 0644 "$W/template" "$TEMPLATE"
render_template "$TEMPLATE" > "$W/new"
if ! cmp -s "$W/new" "$W/rendered"; then
    restore_backup
    stop "the render differs from the tested candidate; both files restored, nothing reloaded"
fi
install -m 0644 "$W/new" "$RENDERED"
if ! nginx_test_and_reload; then
    restore_backup
    stop "nginx -t or reload failed; both files restored, nothing reloaded"
fi

fail=0
p0_holds live-after live || fail=1
for h in $CRM_HOSTS; do
    login=$(probe "$h" /login)
    cash=$(probe "$h" /compensation)
    action=403
    while read -r id; do
        code=$(probe "$h" / -X POST -H "Next-Action: $id" --data '' | cut -d'|' -f1)
        [ "$code" = 403 ] || action=$code
    done < "$K/cash-action-ids.txt"
    bot=$(probe "$h" /api/webhooks/bot -X POST --data '' | cut -d'|' -f1)
    telegram=$(probe "$h" /api/webhook/telegram -X POST --data '' | cut -d'|' -f1)
    echo "$h  /login=$login  /compensation=$cash  Cash action on /=$action  bot webhooks=$bot/$telegram"
    [ "$login" = "401|Basic realm=\"$GATE_REALM\"|$GATE_MARKER" ] || fail=1
    [ "${cash%|*}" = "401|Basic realm=\"$CASH_REALM\"" ] || fail=1
    [ "$action" = 403 ] && [ "$bot" = 404 ] && [ "$telegram" = 404 ] || fail=1
done
if [ "$fail" = 0 ]; then
    echo "gate applied; Security P0 holds and the Cash routes behave as before"
    exit 0
fi

echo "CHECK FAILED after the reload. The site-wide gate stays; never restore a pre-P0 backup."
if p0_holds this-run-backup backup "$B"; then
    restore_backup
    if nginx_test_and_reload && p0_holds live-restored live; then
        echo "this run's backup ($B) is back; Security P0 holds. Investigate before any new attempt."
    else
        echo "P0 NOT HOLDING after putting back this run's backup: escalate to Security. Nothing else is tried."
    fi
else
    echo "this run's backup does not keep P0, so it is not restored: escalate to Security. Nothing else is tried."
fi
exit 1
