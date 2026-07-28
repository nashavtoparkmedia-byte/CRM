#!/usr/bin/env bash
# shellcheck disable=SC1091,SC2016
set -Eeuo pipefail
umask 077
readonly PACKAGE_ROOT='/opt/codex-work/crm-personal-max-stage8b2-autonomous-20260728T122700Z/release/personal-max-stage8b2b-dormant-gateway'
readonly COMPOSE_SOURCE="$PACKAGE_ROOT/dormant-gateway.compose.yml"
readonly COMPOSE_SOURCE_SHA='3f9656117f5da8db510a9710744263384619aa371cac6fa7c8a7d3e50a352ca2'
readonly FAILURE_DIAGNOSTICS="$PACKAGE_ROOT/failure-diagnostics.sh"
readonly FAILURE_DIAGNOSTICS_SHA='99250892456a7c5f308234a66bb65be1ad762665a0eef97d78d18477a7f9fa25'
readonly ACCEPTED_MIGRATION_FILTER="$PACKAGE_ROOT/accepted-migration-report.jq"
readonly ACCEPTED_MIGRATION_FILTER_SHA='9bf656c8570f10bb5ca2142419f35014a7174e472fad1018615b5e0d51cb3b03'
readonly ROLLBACK_SCRIPT="$PACKAGE_ROOT/dormant-rollback.sh"
readonly ROLLBACK_SCRIPT_SHA='d1260c5ad1eda416607ad87e0972d37d2cfaacb61117312a75c017e829a6f090'
readonly ACCEPTED_MIGRATION_SCRIPT_SHA='bf707cca672b350317717c2f611a371ca705fcc58c8eba8d6d0830e3715fe740'
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
RESOURCE_OBSERVATION='NOT_ATTEMPTED'
CONTAINER_OBSERVED_STATE='UNKNOWN'
NETWORK_OBSERVED_STATE='UNKNOWN'
RUNTIME_CONFIG_OBSERVED_STATE='UNKNOWN'
STATE_DIRECTORY_OBSERVED_STATE='UNKNOWN'

fail_bootstrap() { printf '%s\n' "$1" >&2; exit "$2"; }
verify_subordinate() {
  local artifact_path=$1 expected_path=$2 expected_sha=$3 canonical_path actual_sha
  canonical_path=$(realpath -- "$artifact_path") || fail_bootstrap SUBORDINATE_UNREADABLE 75
  [[ $canonical_path == "$expected_path" && -f $artifact_path && ! -L $artifact_path ]] || fail_bootstrap SUBORDINATE_PATH_INVALID 75
  actual_sha=$(sha256sum -- "$artifact_path" | awk '{print $1}')
  [[ $actual_sha == "$expected_sha" ]] || fail_bootstrap SUBORDINATE_CHECKSUM_MISMATCH 79
}
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
verify_subordinate "$FAILURE_DIAGNOSTICS" "$PACKAGE_ROOT/failure-diagnostics.sh" "$FAILURE_DIAGNOSTICS_SHA"
verify_subordinate "$ACCEPTED_MIGRATION_FILTER" "$PACKAGE_ROOT/accepted-migration-report.jq" "$ACCEPTED_MIGRATION_FILTER_SHA"
verify_subordinate "$COMPOSE_SOURCE" "$PACKAGE_ROOT/dormant-gateway.compose.yml" "$COMPOSE_SOURCE_SHA"
verify_subordinate "$ROLLBACK_SCRIPT" "$PACKAGE_ROOT/dormant-rollback.sh" "$ROLLBACK_SCRIPT_SHA"
FAILURE_REPORT="$FAILURE_PREFIX.$SCRIPT_SHA.json"
[[ ! -e $SUCCESS_REPORT && ! -L $SUCCESS_REPORT && ! -e $FAILURE_REPORT && ! -L $FAILURE_REPORT ]] || fail_bootstrap REPORT_PATH_EXISTS 80
verify_subordinate "$FAILURE_DIAGNOSTICS" "$PACKAGE_ROOT/failure-diagnostics.sh" "$FAILURE_DIAGNOSTICS_SHA"
source "$FAILURE_DIAGNOSTICS"
observe_failure_resources() {
  local container_names='' network_names='' identity=''
  RESOURCE_OBSERVATION='DOCKER_UNAVAILABLE'
  CONTAINER_OBSERVED_STATE='UNKNOWN'
  NETWORK_OBSERVED_STATE='UNKNOWN'
  RUNTIME_CONFIG_OBSERVED_STATE='UNKNOWN'
  STATE_DIRECTORY_OBSERVED_STATE='UNKNOWN'
  if timeout --signal=TERM --kill-after=2 10 docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
    RESOURCE_OBSERVATION='DOCKER_AVAILABLE'
    if ! container_names=$(timeout --signal=TERM --kill-after=2 10 docker ps -a --filter "name=^/${CONTAINER}$" --format '{{.Names}}' 2>/dev/null); then
      CONTAINER_OBSERVED_STATE='UNKNOWN'
    elif [[ -z $container_names ]]; then
      CONTAINER_OBSERVED_STATE='ABSENT'
    elif [[ $container_names == "$CONTAINER" ]]; then
      if identity=$(timeout --signal=TERM --kill-after=2 10 docker inspect --format '{{index .Config.Labels "personal-max.stage"}}|{{index .Config.Labels "personal-max.mode"}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' "$CONTAINER" 2>/dev/null) && [[ $identity == '8b2b|dormant|personal-max-stage8b2b|gateway' ]]; then
        CONTAINER_OBSERVED_STATE='PRESENT_OWNED'
      else
        CONTAINER_OBSERVED_STATE='PRESENT_MISMATCH'
      fi
    else
      CONTAINER_OBSERVED_STATE='PRESENT_MISMATCH'
    fi
    if ! network_names=$(timeout --signal=TERM --kill-after=2 10 docker network ls --filter "name=^${NETWORK}$" --format '{{.Name}}' 2>/dev/null); then
      NETWORK_OBSERVED_STATE='UNKNOWN'
    elif [[ -z $network_names ]]; then
      NETWORK_OBSERVED_STATE='ABSENT'
    elif [[ $network_names == "$NETWORK" ]]; then
      if identity=$(timeout --signal=TERM --kill-after=2 10 docker network inspect --format '{{.Internal}}|{{index .Labels "personal-max.stage"}}|{{index .Labels "personal-max.mode"}}|{{index .Labels "com.docker.compose.project"}}' "$NETWORK" 2>/dev/null) && [[ $identity == 'true|8b2b|dormant|personal-max-stage8b2b' ]]; then
        NETWORK_OBSERVED_STATE='PRESENT_OWNED'
      else
        NETWORK_OBSERVED_STATE='PRESENT_MISMATCH'
      fi
    else
      NETWORK_OBSERVED_STATE='PRESENT_MISMATCH'
    fi
  fi
  if [[ ! -e $COMPOSE_RUNTIME && ! -L $COMPOSE_RUNTIME ]]; then
    RUNTIME_CONFIG_OBSERVED_STATE='ABSENT'
  elif [[ -f $COMPOSE_RUNTIME && ! -L $COMPOSE_RUNTIME ]] &&
       [[ $(stat -Lc '%U:%G:%a' "$COMPOSE_RUNTIME" 2>/dev/null) == root:root:600 ]] &&
       [[ $(sha256sum -- "$COMPOSE_RUNTIME" 2>/dev/null | awk '{print $1}') == "$COMPOSE_SOURCE_SHA" ]]; then
    RUNTIME_CONFIG_OBSERVED_STATE='PRESENT_OWNED'
  else
    RUNTIME_CONFIG_OBSERVED_STATE='PRESENT_MISMATCH'
  fi
  if [[ ! -e $STATE_DIR && ! -L $STATE_DIR ]]; then
    STATE_DIRECTORY_OBSERVED_STATE='ABSENT'
  elif [[ -d $STATE_DIR && ! -L $STATE_DIR ]] && [[ $(stat -Lc '%U:%G:%a' "$STATE_DIR" 2>/dev/null) == root:root:700 ]]; then
    STATE_DIRECTORY_OBSERVED_STATE='PRESENT_OWNED'
  else
    STATE_DIRECTORY_OBSERVED_STATE='PRESENT_MISMATCH'
  fi
}
on_error() {
  local original=${1:-1} line=${2:-0}; trap - ERR; set +e
  observe_failure_resources
  personal_max_dormant_failure "$original" "$line" "$PHASE" "$CLASSIFICATION" "$SCRIPT_SHA" "$FAILURE_REPORT" \
    "$RESOURCE_OBSERVATION" "$CONTAINER_OBSERVED_STATE" "$NETWORK_OBSERVED_STATE" \
    "$RUNTIME_CONFIG_OBSERVED_STATE" "$STATE_DIRECTORY_OBSERVED_STATE"
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
verify_subordinate "$COMPOSE_SOURCE" "$PACKAGE_ROOT/dormant-gateway.compose.yml" "$COMPOSE_SOURCE_SHA"
run 30 docker compose -p personal-max-stage8b2b -f "$COMPOSE_SOURCE" config --quiet

phase evidence_binding EVIDENCE_INVALID
for report in "$ISOLATED_REPORT" "$MIGRATION_REPORT"; do
  [[ -f $report && ! -L $report && $(stat -Lc '%U:%G:%a' "$report") == root:codexbot:640 ]]
  run 5 runuser -u codexbot -- test -r "$report"
  if run 5 runuser -u codexbot -- test -w "$report"; then false; fi
done
[[ $(sha_file "$ISOLATED_REPORT") == "$PERSONAL_MAX_ISOLATED_REPORT_SHA256" ]]
[[ $(sha_file "$MIGRATION_REPORT") == "$PERSONAL_MAX_MIGRATION_REPORT_SHA256" ]]
jq -e '.mode=="ISOLATED_RELEASE_PROOF" and .restore.FULL_RESTORE_PROOF=="PASS" and .migration.DISPOSABLE_MIGRATION_PROOF=="PASS" and
  .migration.prismaDiffEmpty==false and .migration.prismaDiffStatus=="ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS" and
  .migration.acceptedLedgerOnlyMigrations==["20260717000000_add_driver_telegram_submitted_phone"] and
  .productionImmutability.unchanged==true and .safety.maxContacted==false and .safety.providerAction==false' "$ISOLATED_REPORT" >/dev/null
verify_subordinate "$ACCEPTED_MIGRATION_FILTER" "$PACKAGE_ROOT/accepted-migration-report.jq" "$ACCEPTED_MIGRATION_FILTER_SHA"
jq -e --arg isolated "$PERSONAL_MAX_ISOLATED_REPORT_SHA256" --arg expectedMigrationScriptSha "$ACCEPTED_MIGRATION_SCRIPT_SHA" \
  --arg expectedImage "$IMAGE" -f "$ACCEPTED_MIGRATION_FILTER" "$MIGRATION_REPORT" >/dev/null

phase production_gate PRODUCTION_DRIFT
[[ $(git -C /opt/crm rev-parse HEAD) == "$PRODUCTION_HEAD" ]]
status_before=$(git -C /opt/crm status --porcelain=v2 --untracked-files=all | sha256sum | awk '{print $1}'); [[ $status_before == "$PRODUCTION_STATUS_V2_SHA" ]]
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
verify_subordinate "$COMPOSE_SOURCE" "$PACKAGE_ROOT/dormant-gateway.compose.yml" "$COMPOSE_SOURCE_SHA"
mkdir -m 0700 -- "$STATE_DIR"; chown root:root "$STATE_DIR"
cp --no-preserve=mode,ownership -- "$COMPOSE_SOURCE" "$COMPOSE_RUNTIME"
chown root:root "$COMPOSE_RUNTIME"; chmod 0600 "$COMPOSE_RUNTIME"
[[ $(sha_file "$COMPOSE_RUNTIME") == "$COMPOSE_SOURCE_SHA" && $(stat -Lc '%U:%G:%a' "$COMPOSE_RUNTIME") == root:root:600 ]]

phase dormant_start DORMANT_START_FAILED
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
status_after=$(git -C /opt/crm status --porcelain=v2 --untracked-files=all | sha256sum | awk '{print $1}'); [[ $status_after == "$PRODUCTION_STATUS_V2_SHA" ]]

phase report_handoff REPORT_HANDOFF_FAILED
tmp_report=$(mktemp "/var/tmp/personal-max-stage8b2b-dormant-gateway.$SCRIPT_SHA.XXXXXX")
jq -n --arg scriptSha "$SCRIPT_SHA" --arg image "$IMAGE" --arg isolatedSha "$PERSONAL_MAX_ISOLATED_REPORT_SHA256" --arg migrationSha "$PERSONAL_MAX_MIGRATION_REPORT_SHA256" \
  --arg migrationScriptSha "$ACCEPTED_MIGRATION_SCRIPT_SHA" --arg rollbackScriptSha "$ROLLBACK_SCRIPT_SHA" --arg composeSha "$COMPOSE_SOURCE_SHA" \
  --arg before "$production_hash_before" --arg after "$production_hash_after" --argjson freeBefore "$free_before" '
  {schemaVersion:1,mode:"DORMANT_GATEWAY_ROLLOUT",script:{sha256:$scriptSha,checksumBound:true},bindings:{isolatedReportSha256:$isolatedSha,migrationReportSha256:$migrationSha,migrationScriptSha256:$migrationScriptSha},
   acceptedMigration:{reportValidated:true,productionMigrationScriptSha256:$migrationScriptSha,gatewayImage:$image,isolatedReportShaCrossBound:true,
    freshBackupStatus:"VALIDATED",appliedCount:8,runnerCleanup:"PASS",safety:"PASS",prismaDiffEmpty:false,
    prismaDiffStatus:"ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS",prismaDiffRawSqlIncluded:false,
    acceptedLedgerOnlyMigrations:["20260717000000_add_driver_telegram_submitted_phone"]},
   image:{ref:$image,runtimeUser:"1000:1000"},runtime:{container:"personal-max-dormant-gateway",network:"personal-max-stage8b2b-dormant",networkInternal:true,publicPorts:0,mounts:0,health:"PASS",readiness:"dormant-ready",restartPolicy:"unless-stopped"},
   behavior:{databaseConfigured:false,databaseWrites:0,captureEnabled:false,senderActive:false,browserLaunched:false,maxContacted:false,providerAction:false},
   production:{hashBefore:$before,hashAfter:$after,unchanged:($before==$after),restartCountsUnchanged:true},storage:{freeBytesBefore:$freeBefore},
   rollback:{available:true,automatic:false,scriptSha256:$rollbackScriptSha,composeSha256:$composeSha}}' >"$tmp_report"
jq -e --arg migrationScriptSha "$ACCEPTED_MIGRATION_SCRIPT_SHA" --arg rollbackScriptSha "$ROLLBACK_SCRIPT_SHA" --arg composeSha "$COMPOSE_SOURCE_SHA" '
  .mode=="DORMANT_GATEWAY_ROLLOUT" and .bindings.migrationScriptSha256==$migrationScriptSha and
  .acceptedMigration.reportValidated==true and .acceptedMigration.productionMigrationScriptSha256==$migrationScriptSha and
  .acceptedMigration.gatewayImage==.image.ref and .acceptedMigration.isolatedReportShaCrossBound==true and
  .acceptedMigration.freshBackupStatus=="VALIDATED" and .acceptedMigration.appliedCount==8 and
  .acceptedMigration.runnerCleanup=="PASS" and .acceptedMigration.safety=="PASS" and
  .runtime.health=="PASS" and .runtime.readiness=="dormant-ready" and .runtime.publicPorts==0 and .runtime.mounts==0 and
  .behavior.databaseWrites==0 and .behavior.captureEnabled==false and .behavior.senderActive==false and
  .behavior.browserLaunched==false and .behavior.maxContacted==false and .behavior.providerAction==false and
  .production.unchanged==true and .rollback.scriptSha256==$rollbackScriptSha and .rollback.composeSha256==$composeSha' "$tmp_report" >/dev/null
chown root:codexbot "$tmp_report"; chmod 0640 "$tmp_report"; mv --no-clobber "$tmp_report" "$SUCCESS_REPORT"
run 5 runuser -u codexbot -- test -r "$SUCCESS_REPORT"; if run 5 runuser -u codexbot -- test -w "$SUCCESS_REPORT"; then false; fi
report_sha=$(sha_file "$SUCCESS_REPORT"); trap - ERR
printf 'STAGE8B2B_DORMANT_ROLLOUT_COMPLETED\nSANITIZED_RESULT_PATH=%s\nSANITIZED_RESULT_SHA256=%s\nPUBLIC_PORTS=0\nCAPTURE=OFF\nSENDER=OFF\nMAX_CONTACTED=NO\n' "$SUCCESS_REPORT" "$report_sha"
