#!/usr/bin/env bash
# shellcheck disable=SC1091
set -Eeuo pipefail
umask 077

readonly PACKAGE_ROOT='/home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z/release/personal-max-stage8b2b-dormant-gateway'
readonly COMPOSE_SOURCE="$PACKAGE_ROOT/dormant-gateway.compose.yml"
readonly COMPOSE_SOURCE_SHA='3f9656117f5da8db510a9710744263384619aa371cac6fa7c8a7d3e50a352ca2'
readonly FAILURE_DIAGNOSTICS="$PACKAGE_ROOT/failure-diagnostics.sh"
readonly FAILURE_DIAGNOSTICS_SHA='99250892456a7c5f308234a66bb65be1ad762665a0eef97d78d18477a7f9fa25'
readonly STATE_DIR='/var/lib/personal-max-stage8b2b'
readonly COMPOSE_RUNTIME="$STATE_DIR/dormant-gateway.compose.yml"
readonly COMPOSE_PROJECT='personal-max-stage8b2b'
readonly CONTAINER='personal-max-dormant-gateway'
readonly NETWORK='personal-max-stage8b2b-dormant'
readonly IMAGE='ghcr.io/nashavtoparkmedia-byte/crm-max-personal-gateway@sha256:dd718fd8e9e2ec52a0ee1c19b576d75a1035f9e251980351ebc04071dfe5d0de'
readonly REPORT='/var/tmp/personal-max-stage8b2b-dormant-rollback.json'
readonly FAILURE_PREFIX='/var/tmp/personal-max-stage8b2b-dormant-rollback.failure'
readonly PROJECT_LABEL='com.docker.compose.project=crm'
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
run() { local seconds=$1; shift; timeout --signal=TERM --kill-after=10 "$seconds" "$@"; }
sha_file() { sha256sum -- "$1" | awk '{print $1}'; }
verify_subordinate() {
  local artifact_path=$1 expected_path=$2 expected_sha=$3 canonical_path actual_sha
  canonical_path=$(realpath -- "$artifact_path") || fail_bootstrap SUBORDINATE_UNREADABLE 75
  [[ $canonical_path == "$expected_path" && -f $artifact_path && ! -L $artifact_path ]] || fail_bootstrap SUBORDINATE_PATH_INVALID 75
  actual_sha=$(sha_file "$artifact_path")
  [[ $actual_sha == "$expected_sha" ]] || fail_bootstrap SUBORDINATE_CHECKSUM_MISMATCH 79
}
subordinate_valid() {
  local artifact_path=$1 expected_path=$2 expected_sha=$3 canonical_path actual_sha
  canonical_path=$(realpath -- "$artifact_path" 2>/dev/null) || return 1
  [[ $canonical_path == "$expected_path" && -f $artifact_path && ! -L $artifact_path ]] || return 1
  actual_sha=$(sha_file "$artifact_path" 2>/dev/null) || return 1
  [[ $actual_sha == "$expected_sha" ]]
}
project_hash() {
  run 60 docker ps -aq --no-trunc --filter "label=$PROJECT_LABEL" | awk 'NF' | sort -u | while IFS= read -r id; do
    run 60 docker inspect --format '{{.Id}}|{{.State.Status}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.service"}}' "$id"
  done | sha256sum | awk '{print $1}'
}
observe_rollback_targets() {
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
      if identity=$(timeout --signal=TERM --kill-after=2 10 docker inspect --format '{{index .Config.Labels "personal-max.stage"}}|{{index .Config.Labels "personal-max.mode"}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.Config.Image}}|{{len .Mounts}}|{{len .HostConfig.PortBindings}}|{{.Config.User}}|{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER" 2>/dev/null) &&
         [[ $identity == "8b2b|dormant|$COMPOSE_PROJECT|gateway|$IMAGE|0|0|1000:1000|unless-stopped" ]]; then
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
      if identity=$(timeout --signal=TERM --kill-after=2 10 docker network inspect --format '{{.Internal}}|{{index .Labels "personal-max.stage"}}|{{index .Labels "personal-max.mode"}}|{{index .Labels "com.docker.compose.project"}}' "$NETWORK" 2>/dev/null) &&
         [[ $identity == "true|8b2b|dormant|$COMPOSE_PROJECT" ]]; then
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
       [[ $(sha_file "$COMPOSE_RUNTIME" 2>/dev/null) == "$COMPOSE_SOURCE_SHA" ]]; then
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
  observe_rollback_targets
  if subordinate_valid "$FAILURE_DIAGNOSTICS" "$PACKAGE_ROOT/failure-diagnostics.sh" "$FAILURE_DIAGNOSTICS_SHA"; then
    personal_max_dormant_rollback_failure "$original" "$line" "$PHASE" "$CLASSIFICATION" "$SCRIPT_SHA" "$FAILURE_REPORT" \
      "$RESOURCE_OBSERVATION" "$CONTAINER_OBSERVED_STATE" "$NETWORK_OBSERVED_STATE" \
      "$RUNTIME_CONFIG_OBSERVED_STATE" "$STATE_DIRECTORY_OBSERVED_STATE"
  else
    printf 'STAGE8B2B_ROLLBACK_FAILURE\nPHASE=%s\nCLASSIFICATION=%s\nORIGINAL_EXIT=%s\nFAILURE_HANDOFF=SUBORDINATE_INVALID\n' "$PHASE" "$CLASSIFICATION" "$original" >&2
  fi
  exit "$original"
}
phase() { PHASE=$1; CLASSIFICATION=$2; printf 'STAGE8B2B_ROLLBACK_PHASE=%s\n' "$PHASE"; }

(( EUID == 0 )) || fail_bootstrap ROOT_REQUIRED 77
[[ ${1:-} =~ ^[0-9a-f]{64}$ ]] || fail_bootstrap CHECKSUM_BINDING_REQUIRED 78
for binary in awk chgrp chmod chown docker getent jq mktemp mv realpath rm rmdir runuser sha256sum sort stat timeout; do
  command -v "$binary" >/dev/null || fail_bootstrap "MANDATORY_BINARY_MISSING:$binary" 76
done
package_path=$(realpath -- "$PACKAGE_ROOT") || fail_bootstrap PACKAGE_ROOT_UNREADABLE 75
[[ $package_path == "$PACKAGE_ROOT" && -d $PACKAGE_ROOT && ! -L $PACKAGE_ROOT ]] || fail_bootstrap PACKAGE_ROOT_INVALID 75
script_path=$(realpath -- "${BASH_SOURCE[0]}") || fail_bootstrap SCRIPT_UNREADABLE 75
[[ $script_path == "$PACKAGE_ROOT/dormant-rollback.sh" && -f $script_path && ! -L $script_path ]] || fail_bootstrap SCRIPT_PATH_INVALID 75
SCRIPT_SHA=$(sha_file "$script_path")
verify_subordinate "$FAILURE_DIAGNOSTICS" "$PACKAGE_ROOT/failure-diagnostics.sh" "$FAILURE_DIAGNOSTICS_SHA"
verify_subordinate "$COMPOSE_SOURCE" "$PACKAGE_ROOT/dormant-gateway.compose.yml" "$COMPOSE_SOURCE_SHA"
FAILURE_REPORT="$FAILURE_PREFIX.$SCRIPT_SHA.json"
[[ ! -e $REPORT && ! -L $REPORT && ! -e $FAILURE_REPORT && ! -L $FAILURE_REPORT ]] || fail_bootstrap REPORT_PATH_EXISTS 80
verify_subordinate "$FAILURE_DIAGNOSTICS" "$PACKAGE_ROOT/failure-diagnostics.sh" "$FAILURE_DIAGNOSTICS_SHA"
source "$FAILURE_DIAGNOSTICS"
trap 'on_error "$?" "$LINENO"' ERR

phase checksum_binding CHECKSUM_MISMATCH
[[ $SCRIPT_SHA == "$1" ]]

phase package_validation PACKAGE_INVALID
(cd "$PACKAGE_ROOT" && sha256sum -c SHA256SUMS >/dev/null)
run 5 getent group codexbot >/dev/null
subordinate_valid "$COMPOSE_SOURCE" "$PACKAGE_ROOT/dormant-gateway.compose.yml" "$COMPOSE_SOURCE_SHA"

phase state_validation RUNTIME_STATE_INVALID
[[ -d $STATE_DIR && ! -L $STATE_DIR && $(stat -Lc '%U:%G:%a' "$STATE_DIR") == root:root:700 ]]
runtime_path=$(realpath -- "$COMPOSE_RUNTIME")
[[ $runtime_path == "$COMPOSE_RUNTIME" && -f $COMPOSE_RUNTIME && ! -L $COMPOSE_RUNTIME ]]
[[ $(stat -Lc '%U:%G:%a' "$COMPOSE_RUNTIME") == root:root:600 ]]
[[ $(sha_file "$COMPOSE_RUNTIME") == "$COMPOSE_SOURCE_SHA" ]]
run 30 docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_RUNTIME" config --quiet

phase target_validation TARGET_IDENTITY_MISMATCH
container_identity=$(run 30 docker inspect --format '{{index .Config.Labels "personal-max.stage"}}|{{index .Config.Labels "personal-max.mode"}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.Config.Image}}' "$CONTAINER")
[[ $container_identity == "8b2b|dormant|$COMPOSE_PROJECT|gateway|$IMAGE" ]]
container_scope=$(run 30 docker inspect --format '{{len .Mounts}}|{{len .HostConfig.PortBindings}}|{{.Config.User}}|{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER")
[[ $container_scope == '0|0|1000:1000|unless-stopped' ]]
network_json=$(run 30 docker inspect --format '{{json .NetworkSettings.Networks}}' "$CONTAINER")
[[ $(jq -r 'keys|length' <<<"$network_json") == 1 && $(jq -r 'keys[0]' <<<"$network_json") == "$NETWORK" ]]
network_identity=$(run 30 docker network inspect --format '{{.Internal}}|{{index .Labels "personal-max.stage"}}|{{index .Labels "personal-max.mode"}}|{{index .Labels "com.docker.compose.project"}}' "$NETWORK")
[[ $network_identity == "true|8b2b|dormant|$COMPOSE_PROJECT" ]]
network_members=$(run 30 docker network inspect --format '{{json .Containers}}' "$NETWORK")
jq -e --arg container "$CONTAINER" 'length==1 and ([.[]|.Name]==[$container])' <<<"$network_members" >/dev/null

phase production_snapshot PRODUCTION_SNAPSHOT_FAILED
production_hash_before=$(project_hash)
log_sha=$(run 30 docker logs "$CONTAINER" 2>/dev/null | sha256sum | awk '{print $1}')

phase targeted_teardown TARGETED_TEARDOWN_FAILED
run 180 docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_RUNTIME" down --timeout 30

phase teardown_verification TARGET_TEARDOWN_INCOMPLETE
if run 30 docker container inspect "$CONTAINER" >/dev/null 2>&1; then false; fi
if run 30 docker network inspect "$NETWORK" >/dev/null 2>&1; then false; fi

phase production_immutability PRODUCTION_DRIFT
production_hash_after=$(project_hash)
[[ $production_hash_after == "$production_hash_before" ]]

phase runtime_config_cleanup RUNTIME_CONFIG_CLEANUP_FAILED
runtime_path_after=$(realpath -- "$COMPOSE_RUNTIME")
[[ $runtime_path_after == "$COMPOSE_RUNTIME" && -f $COMPOSE_RUNTIME && ! -L $COMPOSE_RUNTIME ]]
[[ $(stat -Lc '%U:%G:%a' "$COMPOSE_RUNTIME") == root:root:600 && $(sha_file "$COMPOSE_RUNTIME") == "$COMPOSE_SOURCE_SHA" ]]
rm -- "$COMPOSE_RUNTIME"

phase state_directory_cleanup STATE_DIRECTORY_CLEANUP_FAILED
rmdir -- "$STATE_DIR"
[[ ! -e $COMPOSE_RUNTIME && ! -L $COMPOSE_RUNTIME && ! -e $STATE_DIR && ! -L $STATE_DIR ]]

phase report_handoff REPORT_HANDOFF_FAILED
tmp=$(mktemp /var/tmp/personal-max-stage8b2b-dormant-rollback.XXXXXX)
jq -n --arg scriptSha "$SCRIPT_SHA" --arg composeSha "$COMPOSE_SOURCE_SHA" --arg logSha "$log_sha" --arg before "$production_hash_before" --arg after "$production_hash_after" \
  '{schemaVersion:1,mode:"DORMANT_GATEWAY_ROLLBACK",scriptSha256:$scriptSha,composeSha256:$composeSha,logSha256:$logSha,
    verifiedTarget:{container:"personal-max-dormant-gateway",network:"personal-max-stage8b2b-dormant",stage:"8b2b",mode:"dormant",mounts:0,publicPorts:0},
    containerRemoved:true,networkRemoved:true,runtimeConfigRemoved:true,stateDirectoryRemoved:true,
    production:{hashBefore:$before,hashAfter:$after,unchanged:($before==$after)},
    databaseChanged:false,scraperChanged:false,profileChanged:false,globalPrune:false}' >"$tmp"
chown root:codexbot "$tmp"; chmod 0640 "$tmp"; mv --no-clobber "$tmp" "$REPORT"
run 5 runuser -u codexbot -- test -r "$REPORT"; if run 5 runuser -u codexbot -- test -w "$REPORT"; then false; fi
trap - ERR
printf 'STAGE8B2B_DORMANT_ROLLBACK_COMPLETED\nSANITIZED_RESULT_PATH=%s\n' "$REPORT"
