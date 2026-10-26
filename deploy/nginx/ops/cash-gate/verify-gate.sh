#!/usr/bin/env bash
# Non-mutating checks of the YOKO Cash nginx gate under Security P0 (R3).
#
#   bash verify-gate.sh pre    # record the current answers, never fails
#   bash verify-gate.sh post   # every expectation must hold, exit 1 otherwise
#
# Anonymous requests stop at the edge:
#   - every CRM path answers 401 with realm "YOKO CRM" and the P0 marker;
#   - /compensation answers 401 with the Cash realm;
#   - Cash Server Actions on other paths get 403;
#   - the bot webhooks get 404.
# Handler behaviour (bot, MAX, Avito) is checked on the internal path, from the tg-bot
# container to gravity-mvp:3002, never through the edge. Every request is unsigned, invalid,
# a static tombstone or the bot's health ping, so no handler does any work.
#
# A staff login is checked separately, only when VERIFY_STAFF_CREDENTIAL_FILE names a 0600
# file holding `login:password`; the gate is never weakened for a check.
set -uo pipefail
mode=${1:?pre|post}
case "$mode" in pre | post) ;; *) echo "usage: verify-gate.sh pre|post"; exit 64 ;; esac
. "$(dirname "$0")/lib.sh"
fail=0
row() { printf '%-5s %-17s %-62s %s\n' "$1" "$2" "$3" "$4"; }
expect() {   # expect <where> <label> <wanted (regex over code|realm|marker)> <actual>
    local status=PASS
    if [ "$mode" = pre ]; then
        status=PRE
    elif ! [[ "$4" =~ ^($3)$ ]]; then
        status=FAIL
        fail=1
    fi
    row "$status" "$1" "$2" "got $4"
}
skip() { row SKIP "$1" "$2" "$3"; }

CRM="401\|Basic realm=\"$GATE_REALM\"\|$GATE_MARKER"
mapfile -t gate < <(gate_files "$TEMPLATE")
if [ "${#gate[@]}" = 3 ]; then
    CASH="401\|Basic realm=\"${gate[2]}\"\|.*"
else
    CASH='no-cash-realm-in-template'
    expect template "one staff and one Cash user file named" 'yes' 'no'
fi
mapfile -t IDS < <(cash_action_ids "$TEMPLATE")
[ "${#IDS[@]}" -gt 0 ] || expect template "Cash action map present" 'yes' 'no'

p0_out=$(p0 live 2>&1) && p0_rc=0 || p0_rc=$?
expect checker "Security P0 shared checker (live)" '0' "$p0_rc"
[ "$p0_rc" = 0 ] || printf '%s\n' "$p0_out" | grep -E '^P0 (FAIL|UNKNOWN)' | sed 's/^/      /'

for h in $CRM_HOSTS; do
    for p in /login / /drivers /messages; do
        expect "$h" "GET $p (anonymous)" "$CRM" "$(probe "$h" "$p")"
    done
    for p in /compensation /compensation/x/evidence /compensation/cmprobe0000000000000000000; do
        expect "$h" "GET $p (anonymous)" "$CASH" "$(probe "$h" "$p")"
    done
    for id in "${IDS[@]}"; do
        for p in / /login /drivers /messages; do
            expect "$h" "POST $p Cash action ${id:0:8}" '403\|.*' "$(probe "$h" "$p" -X POST -H "Next-Action: $id" --data '')"
        done
        expect "$h" "POST /compensation/x Cash action ${id:0:8}" "$CASH" \
            "$(probe "$h" /compensation/x -X POST -H "Next-Action: $id" --data '')"
    done
    # The bot webhooks are never reachable from the internet (N1).
    for p in /api/webhooks/bot /api/webhooks/bot/ '/api/webhooks/bot?x=1' //api//webhooks/bot /api/webhooks/%62ot \
             /api/webhook/telegram /api/webhook/telegram/ '/api/webhook/telegram?x=1' //api//webhook/telegram \
             /api/webhook/%74elegram /api/webhooks%2Fbot; do
        expect "$h" "POST $p" '404\|.*' "$(probe "$h" "$p" -X POST -H 'content-type: application/json' --data '{}')"
    done
    # Forms the 404 location does not match stop at the staff gate, never at the application.
    for p in '/api/webhooks/bot;x' /API/webhooks/bot /api/webhooks/max /api/webhook/max /api/webhooks/avito; do
        expect "$h" "POST $p" "$CRM" "$(probe "$h" "$p" -X POST -H 'content-type: application/json' --data '{}')"
    done
done
# /wss-sip has its own SIP authentication and opts out of the staff gate on the apex only.
sip=$(probe yokoone.ru /wss-sip)
case "${sip%%|*}" in 401 | 000) ;; *) sip="answered-past-the-gate ($sip)" ;; esac
expect yokoone.ru "GET /wss-sip (opted out of the staff gate)" 'answered-past-the-gate .*' "$sip"
expect app.yokoone.ru "GET /wss-sip (anonymous)" "$CRM" "$(probe app.yokoone.ru /wss-sip)"
expect yokopark.ru "GET / (public site, unchanged)" '(200|30[1-8])\|.*' "$(probe yokopark.ru /)"

if [ "$CASH_GATE_TEST" = 1 ]; then
    skip admin.yokoone.ru "POST /api/telegram/webhook (no Telegram token)" "offline harness: no bot admin"
    skip internal "handler rows on gravity-mvp:3002" "offline harness: no tg-bot or Gravity"
else
    expect admin.yokoone.ru "POST /api/telegram/webhook (no Telegram token)" '401\|.*' \
        "$(probe admin.yokoone.ru /api/telegram/webhook -X POST -H 'content-type: application/json' --data '{}')"
    internal=$(docker exec -i crm-tg-bot node - <<'JS'
const http = require('http');
const call = (path, body, signed) => new Promise((resolve) => {
  const headers = { 'content-type': 'application/json' };
  if (signed) headers['x-bot-signature'] = process.env.BOT_CRM_SECRET;
  const req = http.request({ host: 'gravity-mvp', port: 3002, path, method: 'POST', headers, timeout: 10000 },
    (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(res.statusCode + ':' + b.slice(0, 40))); });
  req.on('error', (e) => resolve('ERR:' + e.code)); req.end(body);
});
(async () => {
  console.log('bot_unsigned=' + await call('/api/webhooks/bot', '{}', false));
  console.log('telegram_unsigned=' + await call('/api/webhook/telegram', '{}', false));
  console.log('bot_signed_ping=' + await call('/api/webhooks/bot', JSON.stringify({ action: '__ping__', payload: {} }), true));
  console.log('max_unsigned=' + await call('/api/webhooks/max', '{}', false));
  console.log('max_tombstone=' + await call('/api/webhook/max', '{}', false));
  console.log('avito_bad_json=' + await call('/api/webhooks/avito', 'x', false));
})();
JS
    )
    get() { printf '%s\n' "$internal" | sed -n "s/^$1=//p"; }
    expect internal "POST gravity-mvp:3002/api/webhooks/bot unsigned" '401:.*' "$(get bot_unsigned)"
    expect internal "POST gravity-mvp:3002/api/webhook/telegram unsigned" '401:.*' "$(get telegram_unsigned)"
    expect internal "tg-bot signed health ping (unknown action)" '400:.*Unknown action.*' "$(get bot_signed_ping)"
    expect internal "POST gravity-mvp:3002/api/webhooks/max unsigned" '401:.*' "$(get max_unsigned)"
    expect internal "POST gravity-mvp:3002/api/webhook/max (tombstone)" '410:.*' "$(get max_tombstone)"
    expect internal "POST gravity-mvp:3002/api/webhooks/avito (bad JSON)" '400:.*' "$(get avito_bad_json)"
fi

if [ -n "${VERIFY_STAFF_CREDENTIAL_FILE:-}" ]; then
    f=$VERIFY_STAFF_CREDENTIAL_FILE
    if [ -f "$f" ] && [ "$(stat -c '%a' "$f")" = 600 ]; then
        for h in $CRM_HOSTS; do
            expect "$h" "GET /login with the staff login" '(200|30[1-8])\|.*' "$(probe_as "$f" "$h" /login)"
        done
    else
        expect credential "VERIFY_STAFF_CREDENTIAL_FILE is a 0600 file" 'yes' 'no'
    fi
else
    skip credential "staff login check" "set VERIFY_STAFF_CREDENTIAL_FILE to a 0600 login:password file"
fi

if [ "$mode" = post ]; then
    [ "$fail" = 0 ] && { echo "ALL POST CHECKS PASS"; exit 0; }
    echo "POST CHECK FAILED. Do not restore any backup because of this: escalate; Security P0 rollbacks are Security's."
    exit 1
fi
exit 0
