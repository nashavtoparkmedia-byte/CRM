#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
readonly PACKAGE_ROOT='/opt/codex-work/crm-personal-max-stage8b2-autonomous-20260728T122700Z/release/personal-max-stage8b2b-dormant-gateway'
readonly STATE_DIR='/var/lib/personal-max-stage8b2b'
readonly COMPOSE_RUNTIME="$STATE_DIR/dormant-gateway.compose.yml"
readonly CONTAINER='personal-max-dormant-gateway'
readonly NETWORK='personal-max-stage8b2b-dormant'
readonly REPORT='/var/tmp/personal-max-stage8b2b-dormant-rollback.json'
readonly PROJECT_LABEL='com.docker.compose.project=crm'
run() { local seconds=$1; shift; timeout --signal=TERM --kill-after=10 "$seconds" "$@"; }
project_hash() {
  run 60 docker ps -aq --no-trunc --filter "label=$PROJECT_LABEL" | awk 'NF' | sort -u | while IFS= read -r id; do
    run 60 docker inspect --format '{{.Id}}|{{.State.Status}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.service"}}' "$id"
  done | sha256sum | awk '{print $1}'
}
(( EUID == 0 )) || { printf 'ROOT_REQUIRED\n' >&2; exit 77; }
[[ ${1:-} =~ ^[0-9a-f]{64}$ ]] || { printf 'CHECKSUM_BINDING_REQUIRED\n' >&2; exit 78; }
script_path=$(realpath -- "${BASH_SOURCE[0]}"); script_sha=$(sha256sum -- "$script_path" | awk '{print $1}'); [[ $script_sha == "$1" ]]
(cd "$PACKAGE_ROOT" && sha256sum -c SHA256SUMS >/dev/null)
[[ -f $COMPOSE_RUNTIME && ! -L $COMPOSE_RUNTIME && $(stat -Lc '%U:%G:%a' "$COMPOSE_RUNTIME") == root:root:600 ]]
[[ ! -e $REPORT && ! -L $REPORT ]]
[[ $(timeout 30 docker inspect --format '{{index .Config.Labels "personal-max.stage"}}|{{index .Config.Labels "personal-max.mode"}}' "$CONTAINER") == '8b2b|dormant' ]]
production_hash_before=$(project_hash)
log_sha=$(timeout 30 docker logs "$CONTAINER" 2>/dev/null | sha256sum | awk '{print $1}')
timeout --signal=TERM --kill-after=10 180 docker compose -p personal-max-stage8b2b -f "$COMPOSE_RUNTIME" down --timeout 30
if timeout 30 docker container inspect "$CONTAINER" >/dev/null 2>&1; then exit 1; fi
if timeout 30 docker network inspect "$NETWORK" >/dev/null 2>&1; then exit 1; fi
production_hash_after=$(project_hash); [[ $production_hash_after == "$production_hash_before" ]]
tmp=$(mktemp /var/tmp/personal-max-stage8b2b-dormant-rollback.XXXXXX)
jq -n --arg scriptSha "$script_sha" --arg logSha "$log_sha" --arg before "$production_hash_before" --arg after "$production_hash_after" '{schemaVersion:1,mode:"DORMANT_GATEWAY_ROLLBACK",scriptSha256:$scriptSha,logSha256:$logSha,containerRemoved:true,networkRemoved:true,production:{hashBefore:$before,hashAfter:$after,unchanged:($before==$after)},databaseChanged:false,scraperChanged:false,profileChanged:false,globalPrune:false}' >"$tmp"
chown root:codexbot "$tmp"; chmod 0640 "$tmp"; mv --no-clobber "$tmp" "$REPORT"
printf 'STAGE8B2B_DORMANT_ROLLBACK_COMPLETED\nSANITIZED_RESULT_PATH=%s\n' "$REPORT"
