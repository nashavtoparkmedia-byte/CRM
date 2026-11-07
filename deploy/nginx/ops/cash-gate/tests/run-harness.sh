#!/usr/bin/env bash
# Offline harness for the Cash gate scripts (R1–R5) under Security P0.
#
#   bash run-harness.sh <evidence-dir> [pre-P0-backup-dir ...]
#
# Production nginx image, --network none, copies of the production nginx.conf and templates,
# throwaway certificates and logins. The Gravity stub echoes the Authorization header it
# receives, so stripping is observed, not assumed. Production is only read. Throwaway
# passwords stay in a private temp directory that is removed at the end; the evidence
# directory gets reports only.
set -uo pipefail
umask 077
HERE=$(cd "$(dirname "$0")" && pwd)
GATE=$(cd "$HERE/.." && pwd)
OPS=$(cd "$GATE/.." && pwd)
REPO=$(cd "$OPS/../../.." && pwd)
EVID=${1:?evidence directory}
shift
PRE_P0=("$@")
mkdir -p "$EVID"
EVID=$(cd "$EVID" && pwd)
NAME=cash-gate-harness
IMG=$(docker inspect crm-nginx --format '{{.Image}}')
PROD=/opt/crm/deploy/nginx
RUN=$(mktemp -d)
N=$RUN/nginx
SECRET=$RUN/secret
mkdir -p "$N/templates" "$N/conf.d" "$RUN/certs/live" "$SECRET" "$RUN/kits"
chmod 755 "$RUN" "$N" "$N/templates" "$N/conf.d" "$RUN/kits"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; rm -rf -- "$RUN"; }
trap cleanup EXIT
exec > >(tee "$EVID/RESULTS.txt") 2>&1
pass=0
fail=0
ok() { pass=$((pass + 1)); echo "PASS  $1"; }
ko() { fail=$((fail + 1)); echo "FAIL  $1"; [ -z "${2:-}" ] || sed 's/^/      /' "$2" | tail -8; }
export CASH_GATE_TEST_ROOT=$N CASH_GATE_TEST_CONTAINER=$NAME CASH_SLOT=granted YOKO_CASH_CREDENTIAL_DIR=$SECRET/issued
tool() { local id=$1 t=$2; shift 2; bash "$GATE/$t" "$@" > "$EVID/$id.txt" 2>&1; }
live_sha() { cat "$N/templates/crm.conf.template" "$N/conf.d/crm.conf" | sha256sum | cut -c1-16; }
render() { docker exec "$NAME" /docker-entrypoint.d/20-envsubst-on-templates.sh >/dev/null 2>&1; }
reload() { docker exec "$NAME" nginx -s reload >/dev/null 2>&1; sleep 2; }
RENDER='defined_envs=$(printf "\${%s} " $(awk "END { for (name in ENVIRON) { print ( name ~ /${NGINX_ENVSUBST_FILTER:-}/ ) ? name : \"\" } }" < /dev/null )); envsubst "$defined_envs"'
render_to() { docker exec -i "$NAME" sh -c "$RENDER" < "$1" > "$2"; }
code() { docker exec "$NAME" curl -sk -o /dev/null -w '%{http_code}' --path-as-is --resolve "$1:443:127.0.0.1" "${@:3}" "https://$1$2" < /dev/null; }
realm() { docker exec "$NAME" curl -sk -o /dev/null -D - --resolve "$1:443:127.0.0.1" "https://$1$2" < /dev/null | tr -d '\r' | sed -n 's/^[Ww][Ww][Ww]-[Aa]uthenticate: //p'; }
as() {   # as <login> <host> <path> [curl args]: the code with that throwaway login
    printf 'user = "%s"\n' "$(cat "$SECRET/$1.cred")" \
    | docker exec -i "$NAME" curl -K - -sk -o /dev/null -w '%{http_code}' --resolve "$2:443:127.0.0.1" "${@:4}" "https://$2$3"
}
body_as() { printf 'user = "%s"\n' "$(cat "$SECRET/$1.cred")" | docker exec -i "$NAME" curl -K - -sk --resolve "$2:443:127.0.0.1" "https://$2$3"; }
new_login() {   # new_login <login> <file...>: one throwaway login, the same hash line in every file
    local pw line f
    pw=$(openssl rand -hex 16)
    line="$1:$(printf '%s' "$pw" | openssl passwd -6 -stdin)"
    printf '%s:%s\n' "$1" "$pw" > "$SECRET/$1.cred"
    for f in "${@:2}"; do printf '%s\n' "$line" >> "$f"; chown root:101 "$f"; chmod 640 "$f"; done
}

# ---- inputs: production copies (read only), the P0 template, throwaway logins
cp "$PROD/nginx.conf" "$N/nginx.conf"
cp "$PROD/conf.d/default.conf" "$N/conf.d/"
cp "$PROD/templates/bot-admin.conf.template" "$PROD/templates/site.conf.template" "$PROD/templates/crm.conf.template" "$N/templates/"
cp "$PROD/templates/crm.conf.template" "$RUN/p0.template"
git -c safe.directory='*' -C "$REPO" show 7e14fbbf5eabe6dee64732083b73ffd770d99a62:deploy/nginx/templates/crm.conf.template > "$RUN/main.template"
git -c safe.directory='*' -C "$REPO" show 4f3b6c0a9f19ded2d7867c8a11da396f6dc61543:deploy/nginx/templates/crm.conf.template > "$RUN/pre-p0-main.template"
chmod 644 "$N"/templates/*.template "$N/nginx.conf" "$N/conf.d/default.conf"
STAFF=$N/templates/yoko-crm-staff.htpasswd
CASHF=$N/templates/yoko-cash.htpasswd
: > "$STAFF"
: > "$CASHF"
new_login staffonly "$STAFF"
new_login manager "$STAFF" "$CASHF"
cp -p "$STAFF" "$RUN/staff.keep"
cp -p "$CASHF" "$RUN/cash.keep"
printf '%s\n' "$(cat "$SECRET/staffonly.cred")" > "$SECRET/staff-credential"
chmod 600 "$SECRET/staff-credential"
for n in yokoone.ru app.yokoone.ru admin.yokoone.ru yokopark.ru; do
    mkdir -p "$RUN/certs/live/$n"
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$n" \
        -keyout "$RUN/certs/live/$n/privkey.pem" -out "$RUN/certs/live/$n/fullchain.pem" 2>/dev/null
done
chmod -R a+rX "$RUN/certs"
cat > "$N/conf.d/zz-harness.conf" <<'EOF'
server { listen 127.0.0.1:3002; location / { default_type text/plain; return 200 "AUTH=[$http_authorization]"; } }
server { listen 127.0.0.1:7080; location / { return 200 "STUB-FS\n"; } }
server { listen 127.0.0.1:3004; location / { return 200 "STUB-ADMIN\n"; } }
server { listen 127.0.0.1:8081; location / { return 200 "STUB-SEO\n"; } }
# nginx.conf resolves variable upstreams through Docker DNS, which --network none lacks. A static
# proxy_pass makes "gravity-mvp:3002" an upstream resolved from /etc/hosts at load; this server
# keeps every P0 rule itself, so the checker sees no ungated way to Gravity.
server {
    listen 127.0.0.1:8099;
    auth_basic "YOKO CRM";
    auth_basic_user_file /etc/nginx/templates/yoko-crm-staff.htpasswd;
    add_header X-Yoko-Edge-Gate "crm-staff-p0-20261025" always;
    location / { proxy_set_header Authorization ""; proxy_pass http://gravity-mvp:3002; }
}
server { listen 127.0.0.1:8098; location / { proxy_pass http://seo-site:8081; } }
EOF
chmod 644 "$N/conf.d/zz-harness.conf"
docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" --network none --pull=never \
    --add-host gravity-mvp:127.0.0.1 --add-host seo-site:127.0.0.1 --add-host tg-bot-frontend:127.0.0.1 \
    --add-host host.docker.internal:127.0.0.1 \
    -e NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/conf.d -e CRM_DOMAIN=yokoone.ru -e CRM_WWW_DOMAIN=www.yokoone.ru \
    -e CRM_APP_DOMAIN=app.yokoone.ru -e BOT_ADMIN_DOMAIN=admin.yokoone.ru -e SITE_DOMAIN=yokopark.ru \
    -v "$N/nginx.conf:/etc/nginx/nginx.conf:ro" -v "$N/templates:/etc/nginx/templates:ro" \
    -v "$N/conf.d:/etc/nginx/conf.d" -v "$RUN/certs:/etc/letsencrypt:ro" "$IMG" >/dev/null || { echo "harness did not start"; exit 1; }
for _ in $(seq 1 20); do docker exec "$NAME" sh -c 'ps | grep -q "nginx: worker"' 2>/dev/null && break; sleep 0.5; done

fresh() {   # the gated production state, with both throwaway logins
    rm -rf "$N/templates/auth"
    cp "$RUN/p0.template" "$N/templates/crm.conf.template"
    chmod 644 "$N/templates/crm.conf.template"
    cp -p "$RUN/staff.keep" "$STAFF"
    cp -p "$RUN/cash.keep" "$CASHF"
    render
    reload
}
backup_of() {   # backup_of <dir> <template>: a backup dir as apply-gate.sh writes it (template + its render)
    mkdir -p "$1"
    cp "$2" "$1/crm.conf.template"
    render_to "$1/crm.conf.template" "$1/crm.conf"
}
mutate() {   # mutate <out> <python expression over s>: a variant of the P0 template
    python3 -I - "$RUN/p0.template" "$1" "$2" <<'PY'
import sys
s = open(sys.argv[1]).read()
new = eval(sys.argv[3], {"s": s})
assert new != s, "mutation changed nothing"
open(sys.argv[2], "w").write(new)
PY
}
APP_AUTH='s[:s.rfind(chr(10) + "    auth_basic \"YOKO CRM\";")] + s[s.rfind(chr(10) + "    auth_basic \"YOKO CRM\";") + len(chr(10) + "    auth_basic \"YOKO CRM\";"):]'
mutate "$RUN/m-app-no-auth" "$APP_AUTH"
mutate "$RUN/m-no-strip" 's.replace("proxy_set_header Authorization \"\";", "", 1)'
mutate "$RUN/m-no-marker" 's.replace("add_header X-Yoko-Edge-Gate \"crm-staff-p0-20261025\" always;", "", 1)'
mutate "$RUN/m-cash-open" 's.replace("auth_basic \"YOKO Cash\";", "auth_basic off;", 1)'
mutate "$RUN/m-wrong-path" 's.replace("/etc/nginx/templates/yoko-crm-staff.htpasswd", "/etc/nginx/templates/other.htpasswd")'
mutate "$RUN/m-bypass" 's.replace("    location /wss-sip {", "    location /bypass { auth_basic off; proxy_pass http://gravity-mvp:3002; }\n    location /wss-sip {", 1)'
mutate "$RUN/m-satisfy-any" 's.replace("    auth_basic \"YOKO CRM\";", "    satisfy any;\n    auth_basic \"YOKO CRM\";", 1)'
mutate "$RUN/m-timeout" 's.replace("proxy_read_timeout 3600s;", "proxy_read_timeout 3599s;", 1)'
render
reload
echo "== Cash gate harness $(date -u +%FT%TZ), nginx image ${IMG:7:12}, P0 template $(sha256sum < "$RUN/p0.template" | cut -c1-12)"

# ---- 0. positive baseline: the gated production template and the original Cash routes
fresh
r=$(cd "$GATE" && bash -c '. ./lib.sh; p0 live' > "$EVID/P0-live-baseline.txt" 2>&1; echo $?)
[ "$r" = 0 ] && ok "P0 live HOLDS on the gated production copy" || ko "P0 live baseline exit $r" "$EVID/P0-live-baseline.txt"
for h in yokoone.ru app.yokoone.ru; do
    c=$(code $h /login); m=$(realm $h /login)
    [ "$c" = 401 ] && [ "$m" = 'Basic realm="YOKO CRM"' ] && ok "$h anonymous /login 401 YOKO CRM" || ko "$h anonymous /login $c $m"
    [ "$(code $h /compensation)" = 401 ] && [ "$(realm $h /compensation)" = 'Basic realm="YOKO Cash"' ] && ok "$h anonymous /compensation 401 YOKO Cash" || ko "$h /compensation"
    [ "$(as staffonly $h /login)" = 200 ] && ok "$h staff login reaches the CRM" || ko "$h staff login"
    [ "$(body_as staffonly $h /login)" = "AUTH=[]" ] && ok "$h Authorization stripped before Gravity (staff)" || ko "$h Authorization forwarded"
    [ "$(as staffonly $h /compensation)" = 401 ] && ok "$h staff-only login refused on /compensation" || ko "$h staff-only /compensation"
    [ "$(as manager $h /compensation)" = 200 ] && ok "$h Cash login reaches /compensation" || ko "$h Cash login"
    [ "$(body_as manager $h /compensation)" = "AUTH=[]" ] && ok "$h Authorization stripped on /compensation" || ko "$h Authorization forwarded on /compensation"
    id=$(grep -oE '"~\*[0-9a-f]{40,64}"' "$RUN/p0.template" | head -1 | tr -d '"~*')
    [ "$(code $h / -X POST -H "Next-Action: $id" --data '')" = 403 ] && ok "$h Cash action off-path 403 (anonymous)" || ko "$h Cash action anonymous"
    [ "$(as manager $h / -X POST -H "Next-Action: $id" --data '')" = 403 ] && ok "$h Cash action off-path 403 (logged in)" || ko "$h Cash action logged in"
    [ "$(code $h /api/webhooks/bot -X POST --data '')" = 404 ] && [ "$(as manager $h /api/webhook/telegram -X POST --data '')" = 404 ] && ok "$h bot webhooks 404" || ko "$h bot webhooks"
done

# ---- A. the checker package fails closed
mkdir -p "$RUN/good-backup"
backup_of "$RUN/good-backup" "$RUN/p0.template"
for kind in no-checker no-registry tampered-checker tampered-registry; do
    T=$RUN/tooling-$kind
    cp -r "$OPS" "$T"
    case $kind in
        no-checker) rm "$T/security-p0-shared/v1/p0-invariant.py" ;;
        no-registry) rm "$T/security-p0-shared/v1/approved-templates.v1.txt" ;;
        tampered-checker) printf '\n' >> "$T/security-p0-shared/v1/p0-invariant.py" ;;
        tampered-registry) printf '%s pre-p0\n' "$(printf '0%.0s' $(seq 64))" >> "$T/security-p0-shared/v1/approved-templates.v1.txt" ;;
    esac
    before=$(live_sha)
    bash "$T/cash-gate/rollback-gate.sh" "$RUN/good-backup" > "$EVID/A-$kind.txt" 2>&1
    r=$?
    [ "$r" != 0 ] && [ "$(live_sha)" = "$before" ] && ok "A $kind: rollback refused (exit $r), nothing changed" || ko "A $kind exit $r" "$EVID/A-$kind.txt"
done

# ---- B. rollback (R1)
fresh
i=0
for d in "${PRE_P0[@]}"; do
    i=$((i + 1))
    mkdir -p "$RUN/pre-p0-$i"
    cp "$d/crm.conf.template" "$d/crm.conf" "$RUN/pre-p0-$i/"
    before=$(live_sha)
    tool "B1-pre-p0-backup-$i" rollback-gate.sh "$RUN/pre-p0-$i"
    r=$?
    [ "$r" = 1 ] && [ "$(live_sha)" = "$before" ] && grep -q REFUSED "$EVID/B1-pre-p0-backup-$i.txt" \
        && ok "B1 historical pre-P0 backup $i ($(sha256sum < "$d/crm.conf.template" | cut -c1-8)) refused, nothing changed" \
        || ko "B1 pre-P0 backup $i exit $r" "$EVID/B1-pre-p0-backup-$i.txt"
    case "$d" in
        */QUARANTINED-PRE-P0/*)
            tool "B1-quarantined-path-$i" rollback-gate.sh "$d"
            r=$?
            [ "$r" = 1 ] && grep -q quarantined "$EVID/B1-quarantined-path-$i.txt" && [ "$(live_sha)" = "$before" ] \
                && ok "B1 quarantined directory $i refused by path" || ko "B1 quarantined path $i exit $r" "$EVID/B1-quarantined-path-$i.txt" ;;
    esac
done
for m in pre-p0-main m-app-no-auth m-no-strip m-no-marker m-cash-open m-wrong-path m-bypass m-satisfy-any m-timeout; do
    src=$RUN/$m
    [ "$m" = pre-p0-main ] && src=$RUN/pre-p0-main.template
    mkdir -p "$RUN/bk-$m"
    backup_of "$RUN/bk-$m" "$src"
    before=$(live_sha)
    tool "B2-$m" rollback-gate.sh "$RUN/bk-$m"
    r=$?
    [ "$r" = 1 ] && [ "$(live_sha)" = "$before" ] && ok "B2 backup $m refused, nothing changed" || ko "B2 backup $m exit $r" "$EVID/B2-$m.txt"
done
tool B3-good-backup rollback-gate.sh "$RUN/good-backup"
r=$?
[ "$r" = 0 ] && grep -q "Security P0 holds" "$EVID/B3-good-backup.txt" && ok "B3 P0 backup restored; P0 holds" || ko "B3 exit $r" "$EVID/B3-good-backup.txt"
# A failed nginx test during the restore puts back exactly the replaced files; nothing reloaded.
fresh
mkdir -p "$RUN/bk-certless"
backup_of "$RUN/bk-certless" "$RUN/p0.template"
mv "$RUN/certs/live/app.yokoone.ru" "$RUN/certs/app.hidden"
before=$(live_sha)
tool B4-nginx-test-fails rollback-gate.sh "$RUN/bk-certless"
r=$?
mv "$RUN/certs/app.hidden" "$RUN/certs/live/app.yokoone.ru"
[ "$r" = 1 ] && [ "$(live_sha)" = "$before" ] && grep -q "nothing reloaded" "$EVID/B4-nginx-test-fails.txt" \
    && ok "B4 nginx -t failure during rollback: replaced files back, nothing reloaded" || ko "B4 exit $r" "$EVID/B4-nginx-test-fails.txt"
# P0 lost after a restore: one attempt only, no further backup tried.
fresh
: > "$STAFF"
tool B5-no-fallback rollback-gate.sh "$RUN/good-backup"
r=$?
[ "$r" = 1 ] && grep -q "Do not try another backup" "$EVID/B5-no-fallback.txt" && cmp -s "$N/templates/crm.conf.template" "$RUN/good-backup/crm.conf.template" \
    && [ "$(ls -d "$RUN"/good-backup.replaced-* | wc -l)" -ge 1 ] \
    && ok "B5 P0 not holding after restore: stops, single attempt, no fallback" || ko "B5 exit $r" "$EVID/B5-no-fallback.txt"

# ---- E. regen (R4) and kits
fresh
GRAVITY_IMAGE=$(docker inspect crm-gravity-mvp --format '{{.Image}}')
tool E1-regen-p0 regen-gate-map.sh "$GRAVITY_IMAGE" "$RUN/kits"
r=$?
KIT=$(ls -d "$RUN"/kits/regen-* 2>/dev/null | head -1)
[ "$r" = 0 ] && [ -n "$KIT" ] && grep -qx "ISOLATED GATE TEST PASS" "$KIT/gate-test-results.txt" \
    && ok "E1 regen on the P0 template: kit ready, isolated test PASS" || ko "E1 exit $r" "$EVID/E1-regen-p0.txt"
cp "$RUN/pre-p0-main.template" "$N/templates/crm.conf.template"
mkdir -p "$RUN/kits-pre"
tool E2-regen-pre-p0 regen-gate-map.sh "$GRAVITY_IMAGE" "$RUN/kits-pre"
r=$?
[ "$r" != 0 ] && [ -z "$(ls -A "$RUN/kits-pre")" ] && ok "E2 regen on a pre-P0 template: STOP, no kit" || ko "E2 exit $r" "$EVID/E2-regen-pre-p0.txt"
fresh

kit_with() {   # kit_with <name> <template>: a copy of the regen kit whose candidate is <template>
    local k=$RUN/kits/$1
    rm -rf "$k"
    cp -r "$KIT" "$k"
    cp "$2" "$k/crm.conf.template.candidate"
    render_to "$k/crm.conf.template.candidate" "$k/crm.conf.rendered.candidate"
    echo "$k"
}
# ---- C. apply (R2)
NEWID=$(printf 'f%.0s' $(seq 42))
python3 -I - "$RUN/p0.template" "$RUN/c-extra-id" "$NEWID" <<'PY'
import sys
s = open(sys.argv[1]).read()
open(sys.argv[2], "w").write(s.replace("    default 0;\n", f'    default 0;\n    "~*{sys.argv[3]}" 1;\n', 1))
PY
python3 -I - "$RUN/p0.template" "$RUN/c-no-ids" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
open(sys.argv[2], "w").write(re.sub(r'    "~\*[0-9a-f]+" 1;\n', "", s))
PY
for m in m-app-no-auth m-no-strip m-no-marker m-cash-open m-wrong-path m-bypass m-satisfy-any m-timeout pre-p0-main.template; do
    k=$(kit_with "c-$m" "$RUN/$m")
    before=$(live_sha)
    tool "C2-$m" apply-gate.sh "$k"
    r=$?
    [ "$r" = 1 ] && [ "$(live_sha)" = "$before" ] && ! ls -d "$k"/backup-* >/dev/null 2>&1 \
        && ok "C2 candidate $m refused before install" || ko "C2 candidate $m exit $r" "$EVID/C2-$m.txt"
done
k=$(kit_with c-no-cash-file "$RUN/c-extra-id")
mv "$CASHF" "$RUN/cash.moved"
tool C5-missing-cash-file apply-gate.sh "$k"
r=$?
mv "$RUN/cash.moved" "$CASHF"
[ "$r" = 1 ] && grep -q "user file missing" "$EVID/C5-missing-cash-file.txt" && ok "C5 missing Cash user file: refused" || ko "C5 exit $r" "$EVID/C5-missing-cash-file.txt"
cp "$RUN/pre-p0-main.template" "$N/templates/crm.conf.template"
render
reload
k=$(kit_with c-live-open "$RUN/c-extra-id")
cp "$N/templates/crm.conf.template" "$k/crm.conf.template.current"
cp "$N/conf.d/crm.conf" "$k/crm.conf.rendered.current"
tool C1-live-not-p0 apply-gate.sh "$k"
r=$?
[ "$r" = 1 ] && grep -q "does not hold Security P0 now" "$EVID/C1-live-not-p0.txt" && ok "C1 production not gated: apply refused" || ko "C1 exit $r" "$EVID/C1-live-not-p0.txt"
fresh
k=$(kit_with c-extra-id "$RUN/c-extra-id")
tool C3-valid-map-change apply-gate.sh "$k"
r=$?
[ "$r" = 0 ] && cmp -s "$N/templates/crm.conf.template" "$RUN/c-extra-id" && [ "$(code yokoone.ru / -X POST -H "Next-Action: $NEWID" --data '')" = 403 ] \
    && ok "C3 valid map-only kit applied; P0 holds; the new id is refused off-path" || ko "C3 exit $r" "$EVID/C3-valid-map-change.txt"
APPLIED_BACKUP=$(ls -d "$k"/backup-* | head -1)
tool C3b-rollback-this-run rollback-gate.sh "$APPLIED_BACKUP"
r=$?
[ "$r" = 0 ] && cmp -s "$N/templates/crm.conf.template" "$RUN/p0.template" && ok "C3b rollback to this run's backup: P0 holds" || ko "C3b exit $r" "$EVID/C3b-rollback-this-run.txt"
fresh
k=$(kit_with c-no-ids "$RUN/c-no-ids")
cp "$KIT/cash-action-ids.txt" "$k/cash-action-ids.txt"
tool C4-post-check-fails apply-gate.sh "$k"
r=$?
[ "$r" = 1 ] && cmp -s "$N/templates/crm.conf.template" "$RUN/p0.template" && grep -q "this run's backup" "$EVID/C4-post-check-fails.txt" \
    && ! grep -q "rollback-gate" "$EVID/C4-post-check-fails.txt" \
    && ok "C4 failed post-check: only this run's P0 backup restored, no rollback advice" || ko "C4 exit $r" "$EVID/C4-post-check-fails.txt"

# ---- D. verify (R3)
fresh
tool D1-verify-post verify-gate.sh post
r=$?
[ "$r" = 0 ] && grep -q "ALL POST CHECKS PASS" "$EVID/D1-verify-post.txt" && ok "D1 verify-gate post: ALL PASS on the gated copy" || ko "D1 exit $r" "$EVID/D1-verify-post.txt"
VERIFY_STAFF_CREDENTIAL_FILE=$SECRET/staff-credential tool D2-verify-with-login verify-gate.sh post
r=$?
[ "$r" = 0 ] && grep -q "^PASS .*GET /login with the staff login" "$EVID/D2-verify-with-login.txt" && ok "D2 authenticated staff check PASS" || ko "D2 exit $r" "$EVID/D2-verify-with-login.txt"
cp "$RUN/pre-p0-main.template" "$N/templates/crm.conf.template"
cp "$RUN/p0.template" "$RUN/hold.template"
render
reload
tool D3-verify-open verify-gate.sh post
r=$?
[ "$r" = 1 ] && grep -q "^FAIL .*GET /login (anonymous)" "$EVID/D3-verify-open.txt" && ! grep -q "rollback-gate" "$EVID/D3-verify-open.txt" \
    && ok "D3 verify-gate post detects an open CRM (FAIL), no rollback advice" || ko "D3 exit $r" "$EVID/D3-verify-open.txt"
fresh

# ---- F. credentials (R5)
tool F1-issue manager-credentials.sh issue mgrtest
r=$?
issued=$(ls "$SECRET"/issued/mgrtest.*.txt 2>/dev/null | head -1)
if [ "$r" = 0 ] && [ -n "$issued" ]; then
    printf '%s:%s\n' mgrtest "$(sed -n 's/^password: //p' "$issued")" > "$SECRET/mgrtest.cred"
    pw=$(sed -n 's/^password: //p' "$issued")
    grep -q "^mgrtest:" "$STAFF" && grep -q "^mgrtest:" "$CASHF" && [ "$(grep '^mgrtest:' "$STAFF")" = "$(grep '^mgrtest:' "$CASHF")" ] \
        && ok "F1 issue: the same hash line in the Cash and staff files" || ko "F1 files"
    [ "$(as mgrtest yokoone.ru /login)" = 200 ] && [ "$(as mgrtest app.yokoone.ru /compensation)" = 200 ] && ok "F1 issued login opens the CRM and /compensation" || ko "F1 access"
    ! grep -rqF "$pw" "$EVID" && ok "F1 the password is in no report or log" || ko "F1 password leaked into evidence"
    tool F2-revoke manager-credentials.sh revoke mgrtest
    r=$?
    [ "$r" = 0 ] && [ "$(as mgrtest yokoone.ru /compensation)" = 401 ] && [ "$(as mgrtest yokoone.ru /login)" = 200 ] \
        && ok "F2 revoke: /compensation refused, staff login kept" || ko "F2 exit $r" "$EVID/F2-revoke.txt"
    unset pw
else
    ko "F1 issue exit $r" "$EVID/F1-issue.txt"
fi
tool F3-paths manager-credentials.sh paths
grep -q "every user file this template names is present" "$EVID/F3-paths.txt" && ok "F3 paths: production layout ready" || ko "F3" "$EVID/F3-paths.txt"
fresh

# ---- G. a missing staff file never opens the CRM
rm "$STAFF"
for h in yokoone.ru app.yokoone.ru; do
    a=$(code $h /login)
    s=$(as staffonly $h /login)
    [ "$a" = 401 ] && [[ "$s" =~ ^(403|500)$ ]] && ok "G $h staff file missing: anonymous 401, login refused $s (closed)" || ko "G $h anonymous=$a login=$s"
done
r=$(cd "$GATE" && bash -c '. ./lib.sh; p0 live' > "$EVID/G-p0-live.txt" 2>&1; echo $?)
[ "$r" != 0 ] && ok "G P0 checker: not holding (exit $r)" || ko "G checker still HOLDS"
fresh

# ---- H. credential-path migration to MAIN's auth/ layout (offline only)
cp "$RUN/main.template" "$N/templates/crm.conf.template"
tool H1-paths-before manager-credentials.sh paths
grep -q "NOT READY" "$EVID/H1-paths-before.txt" && ok "H1 MAIN template before migration: paths NOT READY" || ko "H1" "$EVID/H1-paths-before.txt"
render
reload
s=$(as staffonly yokoone.ru /login)
[ "$(code yokoone.ru /login)" = 401 ] && [[ "$s" =~ ^(403|500)$ ]] && ok "H1 MAIN template without auth/ files: anonymous 401, login refused $s (closed)" || ko "H1 login=$s"
mkdir -p "$N/templates/auth"
chown root:101 "$N/templates/auth"
chmod 0710 "$N/templates/auth"
install -m 0640 -o root -g 101 "$STAFF" "$N/templates/auth/yoko-crm-staff.htpasswd"
install -m 0640 -o root -g 101 "$CASHF" "$N/templates/auth/compensation.htpasswd"
tool H2-paths-after manager-credentials.sh paths
grep -q "every user file this template names is present" "$EVID/H2-paths-after.txt" && grep -q "Cash realm: YOKO compensation" "$EVID/H2-paths-after.txt" \
    && ok "H2 auth/ layout after migration: paths ready" || ko "H2" "$EVID/H2-paths-after.txt"
r=$(cd "$GATE" && bash -c '. ./lib.sh; p0 live' > "$EVID/H2-p0-live.txt" 2>&1; echo $?)
[ "$r" = 0 ] && ok "H2 P0 live HOLDS on MAIN's template with the auth/ layout" || ko "H2 P0 exit $r" "$EVID/H2-p0-live.txt"
for h in yokoone.ru app.yokoone.ru; do
    [ "$(code $h /login)" = 401 ] && [ "$(as staffonly $h /login)" = 200 ] && [ "$(body_as staffonly $h /login)" = "AUTH=[]" ] \
        && [ "$(realm $h /compensation)" = 'Basic realm="YOKO compensation"' ] && [ "$(as manager $h /compensation)" = 200 ] \
        && ok "H2 $h staff and Cash logins work after the move; Authorization stripped" || ko "H2 $h"
done
# Why MAIN is NOT SAFE FOR PRODUCTION SYNC: a logged-in user reaches what production refuses.
id=$(grep -oE '"~\*[0-9a-f]{40,64}"' "$RUN/p0.template" | head -1 | tr -d '"~*')
a=$(as staffonly yokoone.ru / -X POST -H "Next-Action: $id" --data '')
b=$(as staffonly yokoone.ru /api/webhooks/bot -X POST --data '')
[ "$a" != 403 ] && [ "$b" != 404 ] && ok "H3 divergence recorded: MAIN template lets a staff login post a Cash action off-path ($a) and reach the bot webhook ($b); production answers 403/404" \
    || ko "H3 divergence not reproduced (action=$a webhook=$b)"
fresh

docker logs "$NAME" > "$EVID/harness-nginx.log" 2>&1
echo "== Cash gate harness: PASS=$pass FAIL=$fail"
[ "$fail" = 0 ]
