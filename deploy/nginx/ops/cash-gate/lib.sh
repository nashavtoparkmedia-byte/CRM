# Shared helpers for the YOKO Cash nginx gate scripts. Sourced by them, never executed.
#
# Security P0 (2026-10-25) put both CRM hosts behind a site-wide staff Basic-auth gate. Every
# script here proves, with Security's shared checker, that a configuration keeps that gate
# before it is installed or restored, and that the running nginx still keeps it afterwards.
# Any answer other than HOLDS stops the script: VIOLATED, UNKNOWN, a usage error, a missing
# checker or approved-template list, or a digest mismatch.

CASH_GATE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Owner: Security. The checker finds its approved-template list next to itself, so the two
# are one package and both are pinned. Never edit either here; take a new version from Security.
P0_PACKAGE_DIR=$CASH_GATE_DIR/../security-p0-shared/v1
P0_CHECKER_SHA256=cda798ff30bac2d5108dd1853bc038f3d26b1e7e53b3a5efe75e82f6a6bebb24
P0_REGISTRY_SHA256=bec664bd7727382cb60a1c613aecc90ee9d0029c502833145bfb67a5165b53e3

# Offline harness only: a copy of the nginx directory and a throwaway container, together.
if [ -n "${CASH_GATE_TEST_ROOT:-}${CASH_GATE_TEST_CONTAINER:-}" ]; then
    [ -n "${CASH_GATE_TEST_ROOT:-}" ] && [ -n "${CASH_GATE_TEST_CONTAINER:-}" ] \
        || { echo "STOP: CASH_GATE_TEST_ROOT and CASH_GATE_TEST_CONTAINER are set together or not at all"; exit 64; }
    case "$(realpath -m "$CASH_GATE_TEST_ROOT")" in
        /opt/crm | /opt/crm/*) echo "STOP: the test root may not be production"; exit 64 ;;
    esac
    [ "$CASH_GATE_TEST_CONTAINER" != crm-nginx ] || { echo "STOP: the test container may not be crm-nginx"; exit 64; }
    NGINX_DIR=$CASH_GATE_TEST_ROOT
    NGINX_CONTAINER=$CASH_GATE_TEST_CONTAINER
    CASH_GATE_TEST=1
else
    NGINX_DIR=/opt/crm/deploy/nginx
    NGINX_CONTAINER=crm-nginx
    CASH_GATE_TEST=0
fi
TEMPLATE=$NGINX_DIR/templates/crm.conf.template
RENDERED=$NGINX_DIR/conf.d/crm.conf
CRM_HOSTS="yokoone.ru app.yokoone.ru"
GATE_REALM='YOKO CRM'
GATE_MARKER=crm-staff-p0-20261025
# The nginx image's own entrypoint render (envsubst over the variables the container defines).
RENDER='defined_envs=$(printf "\${%s} " $(awk "END { for (name in ENVIRON) { print ( name ~ /${NGINX_ENVSUBST_FILTER:-}/ ) ? name : \"\" } }" < /dev/null )); envsubst "$defined_envs"'

stop() { echo "STOP: $*"; exit 1; }

# p0 <mode> [args]: the shared checker on a verified private copy of its package, so the bytes
# that were checked are the bytes that run. Returns the checker's exit code; 2 if the package is
# missing or does not match its pins.
p0() {
    local pkg rc
    pkg=$(mktemp -d) || return 2
    if ! cp "$P0_PACKAGE_DIR/p0-invariant.py" "$P0_PACKAGE_DIR/approved-templates.v1.txt" "$pkg/" 2>/dev/null; then
        rm -rf -- "$pkg"; echo "P0 UNKNOWN checker-package missing under $P0_PACKAGE_DIR"; return 2
    fi
    if [ "$(sha256sum < "$pkg/p0-invariant.py" | cut -d' ' -f1)" != "$P0_CHECKER_SHA256" ]; then
        rm -rf -- "$pkg"; echo "P0 UNKNOWN checker digest mismatch"; return 2
    fi
    if [ "$(sha256sum < "$pkg/approved-templates.v1.txt" | cut -d' ' -f1)" != "$P0_REGISTRY_SHA256" ]; then
        rm -rf -- "$pkg"; echo "P0 UNKNOWN approved-template list digest mismatch"; return 2
    fi
    if [ "$CASH_GATE_TEST" = 1 ]; then
        env -i PATH=/usr/bin:/bin P0_NGINX_DIR="$NGINX_DIR" P0_CONTAINER="$NGINX_CONTAINER" /usr/bin/python3 -I "$pkg/p0-invariant.py" "$@"
    else
        env -i PATH=/usr/bin:/bin /usr/bin/python3 -I "$pkg/p0-invariant.py" "$@"
    fi
    rc=$?
    rm -rf -- "$pkg"
    return "$rc"
}

# p0_holds <label> <mode> [args]: true only for HOLDS. Prints the result line and any failing rows.
p0_holds() {
    local label=$1 out rc
    shift
    out=$(p0 "$@" 2>&1) && rc=0 || rc=$?
    printf '%s\n' "$out" | grep -E '^P0 (FAIL|UNKNOWN)|^P0-INVARIANT RESULT' | sed "s/^/  [$label] /"
    [ "$rc" = 0 ] || echo "  [$label] checker exit $rc"
    [ "$rc" = 0 ]
}

# probe <host> <path> [curl args]: "<code>|<WWW-Authenticate or ->|<marker or ->", answered by
# the nginx inside the container (never through the internet). Anonymous.
probe() {
    docker exec "$NGINX_CONTAINER" curl -sk -o /dev/null -D - --max-time 15 --path-as-is \
        --resolve "$1:443:127.0.0.1" "${@:3}" "https://$1$2" 2>/dev/null < /dev/null | probe_summary
}

# probe_as <credential-file> <host> <path> [curl args]: the same with a login. The file holds
# `login:password` (0600); it reaches curl as stdin config (-K -), never argv or a log.
probe_as() {
    local f=$1
    shift
    printf 'user = "%s"\n' "$(head -1 "$f")" \
    | docker exec -i "$NGINX_CONTAINER" curl -K - -sk -o /dev/null -D - --max-time 15 --path-as-is \
        --resolve "$1:443:127.0.0.1" "${@:3}" "https://$1$2" 2>/dev/null | probe_summary
}

probe_summary() {
    tr -d '\r' \
    | awk 'NR == 1 { c = $2 }
           tolower($1) == "www-authenticate:" { sub(/^[^:]*: */, ""); r = $0 }
           tolower($1) == "x-yoko-edge-gate:" { m = $2 }
           END { printf "%s|%s|%s\n", (c ? c : "000"), (r ? r : "-"), (m ? m : "-") }'
}

# gate_files <template>: three lines from the template's own directives, for either layout
# (templates/ or templates/auth/): the staff user file (host path), the Cash user file (host
# path) and the Cash realm. Exactly one of each, or exit 1.
gate_files() {
    python3 -I - "$1" "$NGINX_DIR" "$GATE_REALM" <<'PY'
import re, sys
text = "\n".join(line.split("#", 1)[0] for line in open(sys.argv[1]).read().splitlines())
pairs = set(re.findall(r'auth_basic\s+"([^"]+)"\s*;\s*auth_basic_user_file\s+(\S+?)\s*;', text))
staff = sorted({f for realm, f in pairs if realm == sys.argv[3]})
cash = sorted({(realm, f) for realm, f in pairs if realm != sys.argv[3]})
if len(staff) != 1 or len(cash) != 1:
    sys.exit(f"STOP: expected one staff and one Cash user file, found {len(staff)} and {len(cash)}")
files = (staff[0], cash[0][1])
if not all(f.startswith("/etc/nginx/templates/") and ".." not in f for f in files):
    sys.exit("STOP: a user file is outside /etc/nginx/templates/")
for f in files:
    print(sys.argv[2] + f[len("/etc/nginx"):])
print(cash[0][0])
PY
}

# check_user_file <host path>: an htpasswd nginx can use (root:101 0640, one well-formed line per
# login, no duplicate). Prints nothing from the file.
check_user_file() {
    local f=$1
    [ -f "$f" ] && [ ! -L "$f" ] || stop "user file missing: $f"
    [ "$(stat -c '%u:%g %a' "$f")" = "0:101 640" ] || stop "user file must be root:101 0640: $f"
    python3 -I - "$f" <<'PY' || exit 1
import re, sys
lines = [l for l in open(sys.argv[1]).read().splitlines() if l]
good = re.compile(r"^[a-z0-9][a-z0-9._-]{1,31}:\$(2[aby]\$|5\$|6\$|apr1\$)\S+$")
logins = [l.split(":", 1)[0] for l in lines]
if not all(good.match(l) for l in lines) or len(set(logins)) != len(logins):
    sys.exit(f"STOP: {sys.argv[1]} has a malformed or duplicate line")
PY
}

render_template() {   # render_template <template> > rendered, with the running container's entrypoint
    docker exec -i "$NGINX_CONTAINER" sh -c "$RENDER" < "$1"
}

nginx_test_and_reload() {
    docker exec "$NGINX_CONTAINER" nginx -t >/dev/null 2>&1 || return 1
    docker exec "$NGINX_CONTAINER" nginx -s reload >/dev/null || return 1
    sleep 2
}

# cash_action_ids <template>: the ids in the template's Cash action map.
cash_action_ids() {
    grep -oE '"~\*[0-9a-f]{40,64}"' "$1" | tr -d '"~*' | sort -u
}
