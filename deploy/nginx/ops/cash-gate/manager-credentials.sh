#!/usr/bin/env bash
# Individual logins for the YOKO Cash gate (/compensation) under Security P0 (R5). Run by the
# authorized operator as root on the VPS.
#
#   CASH_SLOT=granted bash manager-credentials.sh issue <login>    # new or replacement password
#   CASH_SLOT=granted bash manager-credentials.sh revoke <login>   # Cash access only
#   bash manager-credentials.sh list                               # logins only
#   bash manager-credentials.sh paths [template]                   # user-file layout, read-only
#
# The user files are the ones the live template names, in either layout (templates/ or
# templates/auth/), so a credential-path migration needs no change here.
#
# Every Cash login is also a staff login (Cash ⊆ staff): without the site-wide staff login a
# manager could not load the /compensation page assets.
#   - issue: writes the same hash line to both files;
#   - revoke: removes the login from the Cash file only. Staff logins are Security's
#     (kit/staff-htpasswd.sh).
#
# Secrets never appear on the screen, in argv, in shell history or in a log. The plaintext goes
# to one root-only 0600 file for personal hand-over, then `shred -u`. nginx re-reads the files on
# every request, so nothing is reloaded.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
OUT=${YOKO_CASH_CREDENTIAL_DIR:-/root/yoko-cash-credentials}
[ "$CASH_GATE_TEST" = 0 ] || [ -n "${YOKO_CASH_CREDENTIAL_DIR:-}" ] || stop "the offline harness sets YOKO_CASH_CREDENTIAL_DIR"
cmd=${1:-}
login=${2:-}
umask 077

describe() {   # describe <label> <host path>: owner, mode and line count, never the contents
    local f=$2
    if [ -f "$f" ]; then
        printf '%-6s %s  %s %s  %s line(s)\n' "$1" "$f" "$(stat -c '%u:%g' "$f")" "$(stat -c '%a' "$f")" "$(grep -c . "$f")"
    else
        printf '%-6s %s  MISSING\n' "$1" "$f"
    fi
    printf '       directory %s  %s %s\n' "$(dirname "$f")" "$(stat -c '%u:%g' "$(dirname "$f")" 2>/dev/null || echo -)" \
        "$(stat -c '%a' "$(dirname "$f")" 2>/dev/null || echo -)"
}

replace_line() {   # replace_line <file> <login> [line]: drop the login's line, append [line]; root:101 0640, atomic
    local f=$1 tmp
    mkdir -p "$(dirname "$f")"
    tmp=$(mktemp "$f.XXXXXX")
    { [ -f "$f" ] && grep -v "^$2:" "$f" || true; [ -n "${3:-}" ] && printf '%s\n' "$3"; } > "$tmp"
    chown root:101 "$tmp"
    chmod 0640 "$tmp"
    mv -f "$tmp" "$f"
}

case "$cmd" in
    paths)
        t=${2:-$TEMPLATE}
        mapfile -t gate < <(gate_files "$t")
        [ "${#gate[@]}" = 3 ] || stop "$t names no single staff and Cash user file"
        echo "template $t"
        echo "Cash realm: ${gate[2]}"
        describe staff "${gate[0]}"
        describe cash "${gate[1]}"
        missing=0
        for f in "${gate[0]}" "${gate[1]}"; do [ -s "$f" ] || missing=1; done
        if [ "$missing" = 0 ]; then
            echo "every user file this template names is present"
        else
            echo "NOT READY: installing this template now would refuse every login (403/500 with a login, 401 without)"
        fi
        ;;
    list)
        mapfile -t gate < <(gate_files "$TEMPLATE")
        [ "${#gate[@]}" = 3 ] || stop "the live template names no single staff and Cash user file"
        [ -f "${gate[1]}" ] || { echo "(no Cash user file)"; exit 0; }
        while IFS=: read -r name _; do
            [ -n "$name" ] || continue
            if [ -f "${gate[0]}" ] && grep -q "^$name:" "${gate[0]}"; then echo "$name"; else echo "$name  (NOT a staff login: page assets refused)"; fi
        done < "${gate[1]}"
        ;;
    issue | revoke)
        [ "${CASH_SLOT:-}" = granted ] || { echo "refused: run with CASH_SLOT=granted"; exit 64; }
        [[ "$login" =~ ^[a-z][a-z0-9._-]{2,31}$ ]] || { echo "login: 3-32 chars, a-z 0-9 . _ -"; exit 64; }
        mapfile -t gate < <(gate_files "$TEMPLATE")
        [ "${#gate[@]}" = 3 ] || stop "the live template names no single staff and Cash user file"
        STAFF=${gate[0]}
        CASH=${gate[1]}
        p0_holds before disk || stop "Security P0 does not hold on disk now; nothing changed"
        if [ "$cmd" = revoke ]; then
            replace_line "$CASH" "$login"
            echo "revoked from the Cash gate: $login (a staff login stays; Security revokes those)"
            p0_holds after disk || { echo "P0 does not hold on disk after the revoke: escalate to Security"; exit 1; }
        else
            mkdir -p -m 0700 "$OUT"
            f="$OUT/$login.$(date -u +%Y%m%dT%H%M%SZ).txt"
            pw=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
            hash=$(printf '%s' "$pw" | openssl passwd -6 -stdin)
            printf 'login: %s\npassword: %s\naddress: https://yokoone.ru/compensation\n' "$login" "$pw" > "$f"
            unset pw
            replace_line "$CASH" "$login" "$login:$hash"
            replace_line "$STAFF" "$login" "$login:$hash"
            unset hash
            echo "issued: $login -> $f (0600); the same line is in the Cash and staff files"
            p0_holds after disk --strict-consistency || { echo "P0 does not hold on disk after the issue: escalate to Security"; exit 1; }
            echo "deliver it to the manager personally, then: shred -u '$f'"
        fi
        p0_holds live live || { echo "P0 does not hold live: escalate to Security"; exit 1; }
        ;;
    *)
        sed -n '2,22p' "$0"
        exit 64
        ;;
esac
