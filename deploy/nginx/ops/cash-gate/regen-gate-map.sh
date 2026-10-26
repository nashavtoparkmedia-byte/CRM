#!/usr/bin/env bash
# Build a Cash action-map kit for a new Gravity build (R4). It keeps the ids of the build that
# runs today, so a runtime rollback stays protected.
#
#   bash regen-gate-map.sh <new-gravity-image> <kit-root>
#
# Read-only for production:
#   - it reads the live template and both images' server manifests (a --rm container, no network);
#   - it renders with the live nginx container's own envsubst (stdout only);
#   - it tests the candidate in a throwaway nginx with no network and throwaway logins.
#
# It refuses unless the live template holds Security P0. The candidate must also hold P0, must
# differ from the live template only in Cash map entries, and must pass the isolated test.
# Otherwise it stops and writes no kit. Apply the kit with apply-gate.sh in an admitted slot.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
NEW=${1:?new gravity image}
ROOT=$(cd "${2:?kit root directory}" && pwd)
p0_holds live-template template "$TEMPLATE" || stop "the live template does not hold Security P0; no kit written"
LIVE_IMAGE=$(docker inspect crm-gravity-mvp --format '{{.Image}}')
NEW=$(docker image inspect "$NEW" --format '{{.Id}}') || stop "image $1 is not loaded"

T=$(mktemp -d)
trap 'rm -rf -- "$T"' EXIT
K=$T/kit
mkdir -m 0700 "$K"

ids_of() {   # Cash Server Action ids of one image, read from its server manifest
    docker run --rm --network none --entrypoint cat "$1" /app/.next/server/server-reference-manifest.json \
    | python3 -I -c 'import json, sys; m = json.load(sys.stdin); print("\n".join(sorted(a for r in ("node", "edge") for a, v in m.get(r, {}).items() if str(v.get("filename", "")).startswith("src/app/compensation/"))))'
}
{ ids_of "$LIVE_IMAGE"; ids_of "$NEW"; cash_action_ids "$TEMPLATE"; } | grep -E '^[0-9a-f]{40,64}$' | sort -u > "$K/cash-action-ids.txt"
[ -s "$K/cash-action-ids.txt" ] || stop "no Cash action id found; no kit written"
printf '%s\n%s\n' "$LIVE_IMAGE" "$NEW" | sort -u > "$K/cash-action-ids.gravity-image.txt"
cp -p "$TEMPLATE" "$K/crm.conf.template.current"
cp -p "$RENDERED" "$K/crm.conf.rendered.current"
python3 -I - "$K" <<'PY'
import re, sys
kit = sys.argv[1]
src = open(kit + "/crm.conf.template.current").read()
ids = [line.strip() for line in open(kit + "/cash-action-ids.txt") if line.strip()]
block = re.compile(r'(map \$http_next_action \$yoko_cash_action_elsewhere \{\n    default 0;\n)(?:    "~\*[0-9a-f]+" 1;\n)+(\})')
if len(block.findall(src)) != 1:
    sys.exit("STOP: the live template has no single Cash action map; no kit written")
new = block.sub(lambda m: m.group(1) + "".join(f'    "~*{i}" 1;\n' for i in ids) + m.group(2), src)
open(kit + "/crm.conf.template.candidate", "w").write(new)
print("map ids:", len(ids))
PY
p0_holds template-candidate template "$K/crm.conf.template.candidate" || stop "the candidate does not hold Security P0; no kit written"
p0_holds map-only map-only-diff "$TEMPLATE" "$K/crm.conf.template.candidate" || stop "the candidate changes more than map entries; no kit written"
render_template "$K/crm.conf.template.candidate" > "$K/crm.conf.rendered.candidate"
p0_holds rendered-candidate rendered "$K/crm.conf.rendered.candidate" || stop "the candidate render does not hold Security P0; no kit written"
mapfile -t gate < <(gate_files "$K/crm.conf.template.candidate")
[ "${#gate[@]}" = 3 ] || stop "the candidate names no single staff and Cash user file; no kit written"

# Isolated behaviour test, with the user-file paths the candidate names and throwaway logins.
H=$T/nginx
mkdir -p "$H/conf.d" "$H/templates" "$H/le" "$T/run"
cp "$NGINX_DIR/nginx.conf" "$H/nginx.conf"
cp "$K/crm.conf.rendered.candidate" "$H/conf.d/crm.conf"
cat > "$H/conf.d/zz-test-only.conf" <<'EOF'
server { listen 127.0.0.1:3002; location / { default_type text/plain; return 200 "AUTH=[$http_authorization]"; } }
# Variable upstreams resolve through Docker DNS, absent here; a static proxy_pass makes
# "gravity-mvp:3002" an upstream resolved from /etc/hosts instead.
server { listen 127.0.0.1:8099; location / { proxy_pass http://gravity-mvp:3002; } }
EOF
for d in yokoone.ru app.yokoone.ru; do
    mkdir -p "$H/le/live/$d"
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$d" \
        -keyout "$H/le/live/$d/privkey.pem" -out "$H/le/live/$d/fullchain.pem" 2>/dev/null
done
login_file() {   # login_file <name> <container path>: a throwaway login at the path, plaintext kept in $T/run
    local pw rel=${2#/etc/nginx/templates/}
    pw=$(openssl rand -hex 16)
    mkdir -p "$(dirname "$H/templates/$rel")"
    printf '%s:%s\n' "$1" "$(printf '%s' "$pw" | openssl passwd -6 -stdin)" >> "$H/templates/$rel"
    printf '%s:%s\n' "$1" "$pw" > "$T/run/$1.cred"
}
staff_c=/etc/nginx${gate[0]#"$NGINX_DIR"}
cash_c=/etc/nginx${gate[1]#"$NGINX_DIR"}
login_file staffprobe "$staff_c"
login_file cashprobe "$cash_c"
# Every Cash login is also a staff login (Cash ⊆ staff): the same line in the staff file.
grep '^cashprobe:' "$H/templates/${cash_c#/etc/nginx/templates/}" >> "$H/templates/${staff_c#/etc/nginx/templates/}"
chmod -R a+rX "$H"
cp "$K/cash-action-ids.txt" "$T/run/ids.txt"
cat > "$T/run/t.sh" <<EOF
nginx -t >/tmp/t 2>&1 || { cat /tmp/t; exit 9; }
nginx; sleep 1; fail=0
c() { curl -sk -o /dev/null -w '%{http_code}' "\$@"; }
ca() { cred=\$1; shift; printf 'user = "%s"\n' "\$(cat /cashtest/\$cred.cred)" | curl -K - -sk -o /dev/null -w '%{http_code}' "\$@"; }
body() { cred=\$1; shift; printf 'user = "%s"\n' "\$(cat /cashtest/\$cred.cred)" | curl -K - -sk "\$@"; }
for h in yokoone.ru app.yokoone.ru; do
  [ "\$(c https://\$h/login)" = 401 ] || { echo "FAIL \$h anonymous /login"; fail=1; }
  [ "\$(ca staffprobe https://\$h/login)" = 200 ] || { echo "FAIL \$h staff /login"; fail=1; }
  [ "\$(body staffprobe https://\$h/login)" = "AUTH=[]" ] || { echo "FAIL \$h Authorization reaches Gravity"; fail=1; }
  [ "\$(c https://\$h/compensation)" = 401 ] || { echo "FAIL \$h anonymous /compensation"; fail=1; }
  [ "\$(ca staffprobe https://\$h/compensation)" = 401 ] || { echo "FAIL \$h staff-only login on /compensation"; fail=1; }
  [ "\$(ca cashprobe https://\$h/compensation)" = 200 ] || { echo "FAIL \$h Cash login on /compensation"; fail=1; }
  [ "\$(body cashprobe https://\$h/compensation)" = "AUTH=[]" ] || { echo "FAIL \$h Authorization reaches Gravity on /compensation"; fail=1; }
  [ "\$(c -X POST https://\$h/api/webhooks/bot)" = 404 ] || { echo "FAIL \$h bot webhook"; fail=1; }
  while read -r id; do for p in / /login; do
    [ "\$(c -X POST -H "Next-Action: \$id" https://\$h\$p)" = 403 ] || { echo "FAIL \$h \$p \${id:0:8}"; fail=1; }
    [ "\$(ca staffprobe -X POST -H "Next-Action: \$id" https://\$h\$p)" = 403 ] || { echo "FAIL \$h staff \$p \${id:0:8}"; fail=1; }
  done; done < /cashtest/ids.txt
done
[ \$fail = 0 ] && echo "ISOLATED GATE TEST PASS"
EOF
chmod -R a+rX "$T/run"
docker run --rm --network none --read-only --tmpfs /var/cache/nginx --tmpfs /var/run --tmpfs /tmp \
    --add-host yokoone.ru:127.0.0.1 --add-host app.yokoone.ru:127.0.0.1 --add-host gravity-mvp:127.0.0.1 \
    --add-host host.docker.internal:127.0.0.1 \
    -v "$H/nginx.conf:/etc/nginx/nginx.conf:ro" -v "$H/conf.d:/etc/nginx/conf.d:ro" -v "$H/templates:/etc/nginx/templates:ro" \
    -v "$H/le:/etc/letsencrypt:ro" -v "$T/run:/cashtest:ro" \
    --entrypoint sh "$(docker inspect "$NGINX_CONTAINER" --format '{{.Image}}')" /cashtest/t.sh 2>/dev/null \
    | grep -E "PASS|FAIL" > "$K/gate-test-results.txt" || true
cat "$K/gate-test-results.txt"
grep -qx "ISOLATED GATE TEST PASS" "$K/gate-test-results.txt" || stop "isolated gate test failed; no kit written"

sha256sum "$CASH_GATE_DIR"/*.sh "$P0_PACKAGE_DIR/p0-invariant.py" "$P0_PACKAGE_DIR/approved-templates.v1.txt" \
    | sed "s#  $CASH_GATE_DIR/#  cash-gate/#; s#  $P0_PACKAGE_DIR/#  security-p0-shared/v1/#" > "$K/TOOLING.sha256"
OUT=$ROOT/regen-$(printf '%s' "${NEW#sha256:}" | cut -c1-12)-$(date -u +%Y%m%dT%H%M%SZ)
mv "$K" "$OUT"
echo "KIT READY: $OUT (ids $(grep -c . "$OUT/cash-action-ids.txt"), images $(grep -c . "$OUT/cash-action-ids.gravity-image.txt"))"
if cmp -s "$OUT/crm.conf.template.current" "$OUT/crm.conf.template.candidate"; then
    echo "candidate == live template (no new id: nothing to apply)"
else
    echo "candidate differs: in an admitted slot, CASH_SLOT=granted bash $(dirname "$0")/apply-gate.sh $OUT"
fi
