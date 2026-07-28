#!/usr/bin/env bash
# shellcheck disable=SC1091,SC2016
set -Eeuo pipefail
umask 077
readonly PACKAGE_ROOT='/opt/codex-work/crm-personal-max-stage8b2-autonomous-20260728T122700Z/release/personal-max-stage8b2b-dormant-gateway'
readonly COMPOSE_SOURCE="$PACKAGE_ROOT/dormant-gateway.compose.yml"
readonly STATE_DIR='/var/lib/personal-max-stage8b2b'
readonly COMPOSE_RUNTIME="$STATE_DIR/dormant-gateway.compose.yml"
readonly ISOLATED_REPORT='/var/tmp/personal-max-stage8b1i-isolated-release-proof.json'
readonly MIGRATION_REPORT='/var/tmp/personal-max-stage8b2a-production-migration.json'
readonly SUCCESS_REPORT='/var/tmp/personal-max-stage8b2b-dormant-gateway.json'
readonly FAILURE_PREFIX='/var/tmp/personal-max-stage8b2b-dormant-gateway.failure'
readonly IMAGE='ghcr.io/nashavtoparkmedia-byte/crm-max-personal-gateway@sha256:dd718fd8e9e2ec52a0ee1c19b576d75a1035f9e251980351ebc04071dfe5d0de'
readonly CONTAINER='personal-max-dormant-gateway'
readonly NETWORK='personal-max-stage8b2b-dormant'
readonly PRODUCTION_HEAD='e6a0a833fbb756216b058bfe326f9f9c77c4cc6d'
readonly PRODUCTION_STATUS_V2_SHA='2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b'
readonly PROJECT_LABEL='com.docker.compose.project=crm'
readonly REQUIRED_FREE_BYTES=12500000000
PHASE=bootstrap
CLASSIFICATION=UNEXPECTED_FAILURE
SCRIPT_SHA=''
FAILURE_REPORT=''
CONTAINER_CREATED=false
NETWORK_CREATED=false

fail_bootstrap() { printf '%s\n' "$1" >&2; exit "$2"; }
(( EUID == 0 )) || fail_bootstrap ROOT_REQUIRED 77
[[ ${1:-} =~ ^[0-9a-f]{64}$ ]] || fail_bootstrap CHECKSUM_BINDING_REQUIRED 78
[[ ${PERSONAL_MAX_ISOLATED_REPORT_SHA256:-} =~ ^[0-9a-f]{64}$ ]] || fail_bootstrap ISOLATED_REPORT_SHA_BINDING_REQUIRED 78
[[ ${PERSONAL_MAX_MIGRATION_REPORT_SHA256:-} =~ ^[0-9a-f]{64}$ ]] || fail_bootstrap MIGRATION_REPORT_SHA_BINDING_REQUIRED 78
for binary in awk chgrp chmod chown cp df docker getent git jq mkdir mv realpath runuser sha256sum sort stat timeout; do
  command -v "$binary" >/dev/null || fail_bootstrap "MANDATORY_BINARY_MISSING:$binary" 76
done
SCRIPT_PATH=$(realpath -- "${BASH_SOURCE[0]}")
[[ $SCRIPT_PATH == "$PACKAGE_ROOT/dormant-rollout.sh" && -f $SCRIPT_PATH && ! -L $SCRIPT_PATH ]] || fail_bootstrap SCRIPT_PATH_INVALID 75
SCRIPT_SHA=$(sha256sum -- "$SCRIPT_PATH" | awk '{print $1}'); [[ $SCRIPT_SHA == "$1" ]] || fail_bootstrap CHECKSUM_MISMATCH 79
FAILURE_REPORT="$FAILURE_PREFIX.$SCRIPT_SHA.json"
[[ ! -e $SUCCESS_REPORT && ! -L $SUCCESS_REPORT && ! -e $FAILURE_REPORT && ! -L $FAILURE_REPORT ]] || fail_bootstrap REPORT_PATH_EXISTS 80
source "$PACKAGE_ROOT/failure-diagnostics.sh"
on_error() {
  local original=${1:-1} line=${2:-0}; trap - ERR; set +e
  personal_max_dormant_failure "$original" "$line" "$PHASE" "$CLASSIFICATION" "$SCRIPT_SHA" "$FAILURE_REPORT" "$CONTAINER_CREATED" "$NETWORK_CREATED"
  exit "$original"
}
trap 'on_error "$?" "$LINENO"' ERR
phase() { PHASE=$1; CLASSIFICATION=$2; printf 'STAGE8B2B_PHASE=%s\n' "$PHASE"; }
run() { local seconds=$1; shift; timeout --signal=TERM --kill-after=10 "$seconds" "$@"; }
sha_file() { sha256sum -- "$1" | awk '{print $1}'; }
hash_sorted() { LC_ALL=C sort | sha256sum | awk '{print $1}'; }
project_hash() {
  run 60 docker ps -aq --no-trunc --filter "label=$PROJECT_LABEL" | awk 'NF' | sort -u | while IFS= read -r id; do
    run 60 docker inspect --format '{{.Id}}|{{.State.Status}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.service"}}' "$id"
  done | hash_sorted
}
restart_hash() {
  run 60 docker ps -aq --no-trunc --filter "label=$PROJECT_LABEL" | awk 'NF' | sort -u | while IFS= read -r id; do
    run 60 docker inspect --format '{{.Id}}|{{.RestartCount}}' "$id"
  done | hash_sorted
}

phase package_validation PACKAGE_INVALID
(cd "$PACKAGE_ROOT" && sha256sum -c SHA256SUMS >/dev/null)
run 30 docker compose version >/dev/null
run 30 docker compose -p personal-max-stage8b2b -f "$COMPOSE_SOURCE" config --quiet

phase evidence_binding EVIDENCE_INVALID
for report in "$ISOLATED_REPORT" "$MIGRATION_REPORT"; do
  [[ -f $report && ! -L $report && $(stat -Lc '%U:%G:%a' "$report") == root:codexbot:640 ]]
  run 5 runuser -u codexbot -- test -r "$report"
  if run 5 runuser -u codexbot -- test -w "$report"; then false; fi
done
[[ $(sha_file "$ISOLATED_REPORT") == "$PERSONAL_MAX_ISOLATED_REPORT_SHA256" ]]
[[ $(sha_file "$MIGRATION_REPORT") == "$PERSONAL_MAX_MIGRATION_REPORT_SHA256" ]]
jq -e '.mode=="ISOLATED_RELEASE_PROOF" and .restore.FULL_RESTORE_PROOF=="PASS" and .migration.DISPOSABLE_MIGRATION_PROOF=="PASS" and .productionImmutability.unchanged==true and .safety.maxContacted==false and .safety.providerAction==false' "$ISOLATED_REPORT" >/dev/null
jq -e '.mode=="PRODUCTION_MIGRATION_EVIDENCE" and .migration.after=={total:54,finished:54,failed:0} and (.migration.appliedNames|length)==8 and .migration.rawRows==0 and .production.restartCountsUnchanged==true and .safety.deploy==false and .safety.captureEnabled==false' "$MIGRATION_REPORT" >/dev/null

phase production_gate PRODUCTION_DRIFT
[[ $(git -C /opt/crm rev-parse HEAD) == "$PRODUCTION_HEAD" ]]
status_before=$(git -C /opt/crm status --porcelain=v2 --untracked-files=all | LC_ALL=C sort | sha256sum | awk '{print $1}'); [[ $status_before == "$PRODUCTION_STATUS_V2_SHA" ]]
free_before=$(df -B1 --output=avail /var/lib/docker | awk 'NR==2{print $1}'); [[ $free_before =~ ^[0-9]+$ ]] && (( free_before >= REQUIRED_FREE_BYTES ))
production_hash_before=$(project_hash); restart_hash_before=$(restart_hash)

phase image_gate IMAGE_INVALID
[[ $(run 60 docker image inspect --format '{{join .RepoDigests "\n"}}' "$IMAGE" | grep -Fx "$IMAGE") == "$IMAGE" ]]
[[ $(run 60 docker image inspect --format '{{.Os}}|{{.Architecture}}|{{.Config.User}}' "$IMAGE") == 'linux|amd64|1000:1000' ]]

phase collision_gate RUNTIME_CONFLICT
if run 30 docker container inspect "$CONTAINER" >/dev/null 2>&1; then false; fi
if run 30 docker network inspect "$NETWORK" >/dev/null 2>&1; then false; fi
[[ ! -e $STATE_DIR && ! -L $STATE_DIR ]]

phase root_owned_config CONFIG_INSTALL_FAILED
mkdir -m 0700 -- "$STATE_DIR"; chown root:root "$STATE_DIR"
cp --no-preserve=mode,ownership -- "$COMPOSE_SOURCE" "$COMPOSE_RUNTIME"
chown root:root "$COMPOSE_RUNTIME"; chmod 0600 "$COMPOSE_RUNTIME"
[[ $(sha_file "$COMPOSE_RUNTIME") == "$(sha_file "$COMPOSE_SOURCE")" && $(stat -Lc '%U:%G:%a' "$COMPOSE_RUNTIME") == root:root:600 ]]

phase dormant_start DORMANT_START_FAILED
CONTAINER_CREATED=true; NETWORK_CREATED=true
run 180 docker compose -p personal-max-stage8b2b -f "$COMPOSE_RUNTIME" up -d --no-build --pull never --wait gateway

phase dormant_verification DORMANT_VERIFICATION_FAILED
[[ $(run 60 docker inspect --format '{{.State.Status}}|{{.State.Health.Status}}|{{.Config.User}}|{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER") == 'running|healthy|1000:1000|unless-stopped' ]]
[[ $(run 60 docker inspect --format '{{len .Mounts}}|{{len .HostConfig.PortBindings}}|{{index .Config.Labels "personal-max.stage"}}|{{index .Config.Labels "personal-max.mode"}}' "$CONTAINER") == '0|0|8b2b|dormant' ]]
[[ $(run 60 docker network inspect --format '{{.Internal}}|{{index .Labels "personal-max.stage"}}' "$NETWORK") == 'true|8b2b' ]]
run 30 docker exec "$CONTAINER" node -e "fetch('http://127.0.0.1:8080/health').then(async r=>{const v=await r.json();process.exit(r.status===200&&v.mode==='dormant'&&v.enabledAccountCount===0?0:1)})"
run 30 docker exec "$CONTAINER" node -e "fetch('http://127.0.0.1:8080/ready').then(async r=>{const v=await r.json();process.exit(r.status===200&&v.state==='dormant-ready'&&v.ready===true?0:1)})"
run 30 docker exec "$CONTAINER" node -e "fetch('http://127.0.0.1:8080/v1/capture',{method:'POST'}).then(async r=>{const v=await r.json();process.exit(r.status===503&&v.code==='INGRESS_DORMANT'?0:1)})"

phase production_immutability PRODUCTION_DRIFT
production_hash_after=$(project_hash); restart_hash_after=$(restart_hash)
[[ $production_hash_after == "$production_hash_before" && $restart_hash_after == "$restart_hash_before" ]]
[[ $(git -C /opt/crm rev-parse HEAD) == "$PRODUCTION_HEAD" ]]
status_after=$(git -C /opt/crm status --porcelain=v2 --untracked-files=all | LC_ALL=C sort | sha256sum | awk '{print $1}'); [[ $status_after == "$PRODUCTION_STATUS_V2_SHA" ]]

phase report_handoff REPORT_HANDOFF_FAILED
tmp_report=$(mktemp "/var/tmp/personal-max-stage8b2b-dormant-gateway.$SCRIPT_SHA.XXXXXX")
jq -n --arg scriptSha "$SCRIPT_SHA" --arg image "$IMAGE" --arg isolatedSha "$PERSONAL_MAX_ISOLATED_REPORT_SHA256" --arg migrationSha "$PERSONAL_MAX_MIGRATION_REPORT_SHA256" \
  --arg before "$production_hash_before" --arg after "$production_hash_after" --argjson freeBefore "$free_before" '
  {schemaVersion:1,mode:"DORMANT_GATEWAY_ROLLOUT",script:{sha256:$scriptSha,checksumBound:true},bindings:{isolatedReportSha256:$isolatedSha,migrationReportSha256:$migrationSha},
   image:{ref:$image,runtimeUser:"1000:1000"},runtime:{container:"personal-max-dormant-gateway",network:"personal-max-stage8b2b-dormant",networkInternal:true,publicPorts:0,mounts:0,health:"PASS",readiness:"dormant-ready",restartPolicy:"unless-stopped"},
   behavior:{databaseConfigured:false,databaseWrites:0,captureEnabled:false,senderActive:false,browserLaunched:false,maxContacted:false,providerAction:false},
   production:{hashBefore:$before,hashAfter:$after,unchanged:($before==$after),restartCountsUnchanged:true},storage:{freeBytesBefore:$freeBefore},rollback:{available:true,automatic:false}}' >"$tmp_report"
jq -e '.mode=="DORMANT_GATEWAY_ROLLOUT" and .runtime.health=="PASS" and .runtime.readiness=="dormant-ready" and .runtime.publicPorts==0 and .runtime.mounts==0 and .behavior.databaseWrites==0 and .behavior.captureEnabled==false and .behavior.senderActive==false and .behavior.browserLaunched==false and .behavior.maxContacted==false and .behavior.providerAction==false and .production.unchanged==true' "$tmp_report" >/dev/null
chown root:codexbot "$tmp_report"; chmod 0640 "$tmp_report"; mv --no-clobber "$tmp_report" "$SUCCESS_REPORT"
run 5 runuser -u codexbot -- test -r "$SUCCESS_REPORT"; if run 5 runuser -u codexbot -- test -w "$SUCCESS_REPORT"; then false; fi
report_sha=$(sha_file "$SUCCESS_REPORT"); trap - ERR
printf 'STAGE8B2B_DORMANT_ROLLOUT_COMPLETED\nSANITIZED_RESULT_PATH=%s\nSANITIZED_RESULT_SHA256=%s\nPUBLIC_PORTS=0\nCAPTURE=OFF\nSENDER=OFF\nMAX_CONTACTED=NO\n' "$SUCCESS_REPORT" "$report_sha"
