#!/usr/bin/env bash
# shellcheck disable=SC1091,SC2016,SC2034,SC2154,SC2254
set -Eeuo pipefail
umask 077

readonly EXPECTED_PACKAGE_ROOT='/opt/codex-work/crm-personal-max-stage8b1r-release-hardening-20260727T220905Z/release/personal-max-stage8b1i'
readonly SUCCESS_REPORT='/var/tmp/personal-max-stage8b1i-isolated-release-proof.json'
readonly BACKUP_REPORT='/var/tmp/personal-max-stage8b1s-production-backup.json'
readonly BACKUP_REPORT_SHA256='f9b29d5fbe69b9a87d402bab3a19a1079797640549078b17a6ba8e7280415566'
readonly PREFLIGHT_REPORT='/var/tmp/personal-max-stage8b1r-production-readonly-preflight.json'
readonly PREFLIGHT_REPORT_SHA256='d6a6e4764c90a6f64af9c11b2b0c4eeb08b82c377b58990f939bd559688ac63b'
readonly DUMP_PATH='/var/backups/personal-max-stage8b1s-production-backup/database.dump'
readonly DUMP_SHA256='c76bda794cc053d32a42f41209d55252d90d02d3806f45c5b16a275544262a3f'
readonly DUMP_BYTES=45284314
readonly DUMP_OBJECTS=581
readonly GATEWAY_IMAGE='ghcr.io/nashavtoparkmedia-byte/crm-max-personal-gateway@sha256:dd718fd8e9e2ec52a0ee1c19b576d75a1035f9e251980351ebc04071dfe5d0de'
readonly SCRAPER_IMAGE='ghcr.io/nashavtoparkmedia-byte/crm-max-web-scraper@sha256:abf4405f55ab1c84f319b00cdb8b561f76353001ba2543045fddb17dc6b46768'
readonly POSTGRES_IMAGE='sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229'
readonly GATEWAY_DIGEST='sha256:dd718fd8e9e2ec52a0ee1c19b576d75a1035f9e251980351ebc04071dfe5d0de'
readonly SCRAPER_DIGEST='sha256:abf4405f55ab1c84f319b00cdb8b561f76353001ba2543045fddb17dc6b46768'
readonly POSTGRES_DIGEST='sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229'
readonly POSTGRES_VERSION='16.14'
readonly POSTGRES_VERSION_NUM=160014
readonly REQUIRED_FREE_BYTES=12500000000
readonly IMAGE_EXPANSION_BYTES=4323469515
readonly PROBE_BUDGET_BYTES=2172240240
readonly CLEANUP_RESERVE_BYTES=5368709120
readonly ATTESTED_PRODUCTION_LEDGER_SHA256='3b77a5c161cbd9850ce3d45b38c2b0e5cc110d97b13f8b506e7723459766a4c3'
readonly ACCEPTED_LEDGER_ONLY_MIGRATION='20260717000000_add_driver_telegram_submitted_phone'
readonly ACCEPTED_PRODUCTION_HEAD='e6a0a833fbb756216b058bfe326f9f9c77c4cc6d'
readonly ACCEPTED_PRODUCTION_STATUS_V2_RAW_SHA256='2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b'
readonly FAILURE_DIAGNOSTICS_SHA256='cf79c2d62de5f8eae16b0b0acf95f46cb6664375512fbcf2896ee9c8536fd9d0'
readonly BOUNDED_OPERATIONS_SHA256='1a72c1e76c65b1a504079b2100238417828da30f3ca62aaf4df610da5e80a3e1'
readonly PROBE_OUTPUT_HELPERS_SHA256='64f4a885a1f109130059f9466712d5b9088cfe9154ad580903694b17403eeed7'
readonly RESTORE_VERIFICATION_SHA256='996721573f9b243598c2380497e44a8aafd2800330500256ddc53c2ef6779547'
readonly POSTGRES_STARTUP_SHA256='54276af4a969b0003c907e249e1fdef04d2b8da6c101cc898aecc6d5685b56e3'
readonly MIGRATION_PREFLIGHT_SHA256='d0d084950caab5d74670290f5ea5ad4bf1b84408da57b4d667a3c46372c55361'
readonly MIGRATION_SQL_GATE_SHA256='9faf24f9aacbd48c27d5e8cff8b0bfdcc92570a9d314232969fd684d70539bda'
readonly MIGRATION_SQL_BINDINGS_SHA256='9128eba91ecb5ce9d010015031050379cd45941fff93bef721df889040a56f8f'
readonly PRISMA_LEGACY_DIFF_GATE_SHA256='552383e215c3d4f3a6b5ae81556cd3d7888430ecfb66196cd983e3f29a736db8'
readonly SYNTHETIC_SCRAPER_HARNESS_SHA256='85d3b4f7b63829b054cfcb61af3d9c786b8dbcf0e9d52aa01be86fbef85a917e'
readonly GATEWAY_CLIENT_HARNESS_SHA256='f1f8c3f5a60a0cf45f44904d8f708f760d02b6553c3b86d05e1ecbbd8cd25428'
readonly PRODUCTION_PROJECT_LABEL='com.docker.compose.project=crm'
readonly STAGE_LABEL='personal-max.stage=8b1i'
readonly RUN_LABEL_KEY='personal-max.run-id'
readonly EXPECTED_MIGRATIONS=(
  20260726162043_add_max_raw_transport_journal
  20260726190658_add_max_route_registry
  20260726205437_add_max_inbound_normalization
  20260726215715_add_max_per_chat_outbound_actor
  20260726225737_add_max_dispatch_ledger
  20260727053744_add_max_provider_confirmation_matcher
  20260727141925_add_max_shadow_semantic_comparison
  20260727154647_add_max_capture_ingress
)

PROBE_PHASE='bootstrap_complete'
PROBE_SAFE_COMMAND_CLASS='package_validation'
PROBE_ERROR_CLASSIFICATION='NONE'
RESTORE_CHECK_ID='NONE'
LEDGER_NAME_COUNT=0
LEDGER_UNIQUE_COUNT=0
LEDGER_DUPLICATE_COUNT=0
LEDGER_EMPTY_NAME_COUNT=0
LEDGER_INVALID_FORMAT_COUNT=0
LEDGER_UNSAFE_NAME_COUNT=0
LEDGER_REPOSITORY_TO_LEDGER_COUNT=0
LEDGER_TO_REPOSITORY_COUNT=0
OBSERVED_PRODUCTION_HEAD=not_observed
OBSERVED_PRODUCTION_STATUS_V2_RAW_SHA256=not_observed
LEDGER_NAMES_SHA256='not_observed'
LEDGER_ATTESTATION_SHA256='not_observed'
LEDGER_INVALID_NAMING_CATEGORIES_JSON='[]'
LEDGER_ACCEPTED_HISTORICAL_NAMES_JSON='[]'
LEDGER_NAMING_CLASSIFICATION='NOT_OBSERVED'
PM_SCRIPT_SHA256=''
PM_FAILURE_PATH=''
PM_DIAGNOSTIC_TMP=''
RUN_ID=''
PREFIX=''
TMP=''
TMP_REPORT=''
TMP_AFTER=''
NETWORK=''
PG_VOLUME=''
SPOOL_VOLUME=''
PG_CONTAINER=''
EXPECTED_POSTGRES_ALIAS=''
GATEWAY_CONTAINER=''
DIAGNOSTICS_LOADED=false
CLEANUP_COMPLETED=false
FAILURE_SOURCE_LINE=0
FAILURE_EXIT=0
GATEWAY_PREEXISTING_BEFORE_PULL=false
SCRAPER_PREEXISTING_BEFORE_PULL=false
GATEWAY_IMAGE_ID_BEFORE=''
SCRAPER_IMAGE_ID_BEFORE=''
GATEWAY_ACQUIRED_DURING_PROBE=false
SCRAPER_ACQUIRED_DURING_PROBE=false
FREE_BYTES_BEFORE_PULL=0
FREE_BYTES_AFTER_GATEWAY_PULL=0
FREE_BYTES_AFTER_SCRAPER_PULL=0
FREE_BYTES_AFTER_PULL=0
FREE_BYTES_AFTER_CLEANUP=0
IMAGE_EXPANSION_REQUIRED_BYTES=$IMAGE_EXPANSION_BYTES
CLEANUP_CONTAINERS_REMAINING=unknown
CLEANUP_NETWORKS_REMAINING=unknown
CLEANUP_VOLUMES_REMAINING=unknown
CLEANUP_TEMP_FILES_REMAINING=unknown
CLEANUP_ERROR_CLASSIFICATION='NONE'
CLEANUP_GLOBAL_DEADLINE=0

fail() {
  local status=$1 phase=$2 command_class=$3
  PROBE_PHASE=$phase
  PROBE_SAFE_COMMAND_CLASS=$command_class
  return "$status"
}

uint() { [[ ${1:-} =~ ^[0-9]+$ ]]; }

production_snapshot() {
  local target=$1 container_list id inspect_line states_text='' restarts_text='' volume_list network_list
  local ids_hash states_hash restarts_hash volumes_hash networks_hash git_head git_status_hash git_text git_hash free_bytes
  pm_capture_bounded container_list docker_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
    docker ps -aq --no-trunc --filter "label=$PRODUCTION_PROJECT_LABEL" || return
  for id in $container_list; do
    pm_capture_bounded inspect_line docker_metadata 60 METADATA_TIMEOUT METADATA_FAILED docker inspect --format \
      '{{.Id}}|{{.Name}}|{{.State.Status}}|{{.State.Running}}|{{.RestartCount}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.service"}}' "$id" || return
    states_text+="$inspect_line"$'\n'
    pm_capture_bounded inspect_line docker_metadata 60 METADATA_TIMEOUT METADATA_FAILED docker inspect --format \
      '{{.Id}}|{{.RestartCount}}' "$id" || return
    restarts_text+="$inspect_line"$'\n'
  done
  pm_capture_bounded volume_list docker_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
    docker volume ls -q --filter "label=$PRODUCTION_PROJECT_LABEL" || return
  pm_capture_bounded network_list docker_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
    docker network ls -q --filter "label=$PRODUCTION_PROJECT_LABEL" || return
  hash_sorted_text ids_hash "$container_list" || return
  hash_sorted_text states_hash "$states_text" || return
  hash_sorted_text restarts_hash "$restarts_text" || return
  hash_sorted_text volumes_hash "$volume_list" || return
  hash_sorted_text networks_hash "$network_list" || return
  pm_capture_bounded git_head filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
    env GIT_OPTIONAL_LOCKS=0 git -C /opt/crm rev-parse HEAD || return
  hash_raw_command git_status_hash filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
    env GIT_OPTIONAL_LOCKS=0 git -C /opt/crm status --porcelain=v2 --untracked-files=all || return
  pm_assert_production_git_baseline "$git_head" "$git_status_hash" \
    "$ACCEPTED_PRODUCTION_HEAD" "$ACCEPTED_PRODUCTION_STATUS_V2_RAW_SHA256" || return
  OBSERVED_PRODUCTION_HEAD=$git_head
  OBSERVED_PRODUCTION_STATUS_V2_RAW_SHA256=$git_status_hash
  git_text="$git_head|$git_status_hash"
  hash_sorted_text git_hash "$git_text" || return
  free_bytes_at free_bytes /var/lib/docker || return
  pm_write_bounded "$target" report_render 60 METADATA_TIMEOUT METADATA_FAILED jq -n \
    --arg containerIdsHash "$ids_hash" --arg serviceStatesHash "$states_hash" --arg restartCountsHash "$restarts_hash" \
    --arg volumeInventoryHash "$volumes_hash" --arg networkInventoryHash "$networks_hash" \
    --arg productionGitHash "$git_hash" --arg productionHead "$git_head" --arg productionStatusHash "$git_status_hash" \
    --arg productionStatusV2RawSha256 "$git_status_hash" \
    --arg acceptedProductionHead "$ACCEPTED_PRODUCTION_HEAD" \
    --arg acceptedProductionStatusV2RawSha256 "$ACCEPTED_PRODUCTION_STATUS_V2_RAW_SHA256" \
    --arg migrationLedgerAttestedHash "$ATTESTED_PRODUCTION_LEDGER_SHA256" --argjson freeBytes "$free_bytes" \
    '{containerIdsHash:$containerIdsHash,serviceStatesHash:$serviceStatesHash,restartCountsHash:$restartCountsHash,
      volumeInventoryHash:$volumeInventoryHash,networkInventoryHash:$networkInventoryHash,
      productionGitHash:$productionGitHash,productionHead:$productionHead,productionStatusHash:$productionStatusHash,
      productionStatusV2RawSha256:$productionStatusV2RawSha256,
      acceptedProductionHead:$acceptedProductionHead,
      acceptedProductionStatusV2RawSha256:$acceptedProductionStatusV2RawSha256,acceptedProductionGitBaseline:true,
      migrationLedger:{hash:$migrationLedgerAttestedHash,source:"accepted_preflight_attestation",liveConnection:false},freeBytes:$freeBytes}'
}


cleanup_remove_kind() {
  local kind=$1 objects=$2 deadline=$3 object remaining timeout_class command
  case $kind in
    containers) timeout_class=CONTAINER_REMOVAL_TIMEOUT; command=(docker rm -f) ;;
    networks) timeout_class=NETWORK_REMOVAL_TIMEOUT; command=(docker network rm) ;;
    volumes) timeout_class=VOLUME_REMOVAL_TIMEOUT; command=(docker volume rm) ;;
    *) return 64 ;;
  esac
  for object in $objects; do
    remaining=$(pm_deadline_remaining "$deadline") || { PROBE_ERROR_CLASSIFICATION=CLEANUP_GLOBAL_DEADLINE_EXCEEDED; return 124; }
    pm_run_bounded cleanup "$remaining" "$timeout_class" CLEANUP_INCOMPLETE "${command[@]}" "$object" >/dev/null 2>&1 || return
  done
}

cleanup_docker_objects() {
  local deadline containers=unknown networks=unknown volumes=unknown remaining object failed=0 status first_class=NONE
  [[ -n ${RUN_ID:-} ]] || return 0
  pm_enter_phase cleanup cleanup || return
  if (( CLEANUP_GLOBAL_DEADLINE <= SECONDS )); then CLEANUP_GLOBAL_DEADLINE=$((SECONDS + 300)); fi
  deadline=$CLEANUP_GLOBAL_DEADLINE
  if remaining=$(pm_deadline_remaining "$deadline"); then
    if cleanup_inventory containers containers "$remaining"; then
      cleanup_remove_kind containers "$containers" "$deadline" || { status=$?; failed=$status; first_class=${PROBE_ERROR_CLASSIFICATION:-CLEANUP_INCOMPLETE}; }
    else status=$?; failed=$status; first_class=${PROBE_ERROR_CLASSIFICATION:-CLEANUP_INCOMPLETE}; fi
  else failed=124; first_class=CLEANUP_GLOBAL_DEADLINE_EXCEEDED; fi
  if remaining=$(pm_deadline_remaining "$deadline"); then
    if cleanup_inventory networks networks "$remaining"; then
      cleanup_remove_kind networks "$networks" "$deadline" || { status=$?; (( failed != 0 )) || { failed=$status; first_class=${PROBE_ERROR_CLASSIFICATION:-CLEANUP_INCOMPLETE}; }; }
    else status=$?; (( failed != 0 )) || { failed=$status; first_class=${PROBE_ERROR_CLASSIFICATION:-CLEANUP_INCOMPLETE}; }; fi
  else (( failed != 0 )) || { failed=124; first_class=CLEANUP_GLOBAL_DEADLINE_EXCEEDED; }; fi
  if remaining=$(pm_deadline_remaining "$deadline"); then
    if cleanup_inventory volumes volumes "$remaining"; then
      cleanup_remove_kind volumes "$volumes" "$deadline" || { status=$?; (( failed != 0 )) || { failed=$status; first_class=${PROBE_ERROR_CLASSIFICATION:-CLEANUP_INCOMPLETE}; }; }
    else status=$?; (( failed != 0 )) || { failed=$status; first_class=${PROBE_ERROR_CLASSIFICATION:-CLEANUP_INCOMPLETE}; }; fi
  else (( failed != 0 )) || { failed=124; first_class=CLEANUP_GLOBAL_DEADLINE_EXCEEDED; }; fi

  if remaining=$(pm_deadline_remaining "$deadline"); then
    cleanup_inventory containers containers "$remaining" || { status=$?; containers=unknown; (( failed != 0 )) || { failed=$status; first_class=${PROBE_ERROR_CLASSIFICATION:-CLEANUP_INCOMPLETE}; }; }
    cleanup_inventory networks networks "$remaining" || { status=$?; networks=unknown; (( failed != 0 )) || { failed=$status; first_class=${PROBE_ERROR_CLASSIFICATION:-CLEANUP_INCOMPLETE}; }; }
    cleanup_inventory volumes volumes "$remaining" || { status=$?; volumes=unknown; (( failed != 0 )) || { failed=$status; first_class=${PROBE_ERROR_CLASSIFICATION:-CLEANUP_INCOMPLETE}; }; }
  else
    containers=unknown; networks=unknown; volumes=unknown
    (( failed != 0 )) || { failed=124; first_class=CLEANUP_GLOBAL_DEADLINE_EXCEEDED; }
  fi
  if [[ $containers == unknown ]]; then CLEANUP_CONTAINERS_REMAINING=unknown; else
    CLEANUP_CONTAINERS_REMAINING=0; for object in $containers; do CLEANUP_CONTAINERS_REMAINING=$((CLEANUP_CONTAINERS_REMAINING + 1)); done
  fi
  if [[ $networks == unknown ]]; then CLEANUP_NETWORKS_REMAINING=unknown; else
    CLEANUP_NETWORKS_REMAINING=0; for object in $networks; do CLEANUP_NETWORKS_REMAINING=$((CLEANUP_NETWORKS_REMAINING + 1)); done
  fi
  if [[ $volumes == unknown ]]; then CLEANUP_VOLUMES_REMAINING=unknown; else
    CLEANUP_VOLUMES_REMAINING=0; for object in $volumes; do CLEANUP_VOLUMES_REMAINING=$((CLEANUP_VOLUMES_REMAINING + 1)); done
  fi
  # Temporary paths are removed later by cleanup_disposable. Validate only the
  # Docker inventory here so an as-yet-unobserved temp count cannot turn a
  # successful cleanup into CLEANUP_INCOMPLETE.
  pm_assert_cleanup_zero "$CLEANUP_CONTAINERS_REMAINING" "$CLEANUP_NETWORKS_REMAINING" \
    "$CLEANUP_VOLUMES_REMAINING" 0 || { status=$?; (( failed != 0 )) || { failed=$status; first_class=CLEANUP_INCOMPLETE; }; }
  if (( failed != 0 )); then PROBE_ERROR_CLASSIFICATION=$first_class; return "$failed"; fi
}

cleanup_temp_path() {
  local path=$1 pattern=$2 deadline=$3 remaining
  [[ -n $path && ( -e $path || -L $path ) ]] || return 0
  case $path in $pattern) ;; *) PROBE_ERROR_CLASSIFICATION=CLEANUP_INCOMPLETE; return 70 ;; esac
  remaining=$(pm_deadline_remaining "$deadline") || { PROBE_ERROR_CLASSIFICATION=CLEANUP_GLOBAL_DEADLINE_EXCEEDED; return 124; }
  pm_run_bounded temp_cleanup "$remaining" TEMP_REMOVAL_TIMEOUT TEMP_REMOVAL_TIMEOUT rm -rf -- "$path"
}

cleanup_disposable() {
  local failed=0 deadline status first_class=NONE
  if (( CLEANUP_GLOBAL_DEADLINE <= SECONDS )); then CLEANUP_GLOBAL_DEADLINE=$((SECONDS + 300)); fi
  deadline=$CLEANUP_GLOBAL_DEADLINE
  cleanup_docker_objects || {
    status=$?; failed=$status; first_class=${PROBE_ERROR_CLASSIFICATION:-CLEANUP_INCOMPLETE};
  }
  cleanup_temp_path "${TMP:-}" "/var/tmp/personal-max-stage8b1i.${RUN_ID}.*" "$deadline" || {
    status=$?; (( failed != 0 )) || { failed=$status; first_class=${PROBE_ERROR_CLASSIFICATION:-CLEANUP_INCOMPLETE}; }
  }
  cleanup_temp_path "${TMP_REPORT:-}" '/var/tmp/personal-max-stage8b1i-success.tmp.*' "$deadline" || {
    status=$?; (( failed != 0 )) || { failed=$status; first_class=${PROBE_ERROR_CLASSIFICATION:-CLEANUP_INCOMPLETE}; }
  }
  cleanup_temp_path "${TMP_AFTER:-}" '/var/tmp/personal-max-stage8b1i-after.tmp.*' "$deadline" || {
    status=$?; (( failed != 0 )) || { failed=$status; first_class=${PROBE_ERROR_CLASSIFICATION:-CLEANUP_INCOMPLETE}; }
  }
  CLEANUP_TEMP_FILES_REMAINING=0
  [[ -n ${TMP:-} && ( -e $TMP || -L $TMP ) ]] && CLEANUP_TEMP_FILES_REMAINING=$((CLEANUP_TEMP_FILES_REMAINING + 1))
  [[ -n ${TMP_REPORT:-} && ( -e $TMP_REPORT || -L $TMP_REPORT ) ]] && CLEANUP_TEMP_FILES_REMAINING=$((CLEANUP_TEMP_FILES_REMAINING + 1))
  [[ -n ${TMP_AFTER:-} && ( -e $TMP_AFTER || -L $TMP_AFTER ) ]] && CLEANUP_TEMP_FILES_REMAINING=$((CLEANUP_TEMP_FILES_REMAINING + 1))
  (( CLEANUP_TEMP_FILES_REMAINING == 0 )) || {
    (( failed != 0 )) || { failed=70; first_class=CLEANUP_INCOMPLETE; }
  }
  (( failed == 0 )) || PROBE_ERROR_CLASSIFICATION=$first_class
  return "$failed"
}

on_error() {
  local status=$? line=${1:-0}
  (( status != 0 )) || status=1
  [[ ${PROBE_ERROR_CLASSIFICATION:-NONE} != NONE ]] || PROBE_ERROR_CLASSIFICATION=UNEXPECTED_COMMAND_FAILURE
  FAILURE_EXIT=$status
  FAILURE_SOURCE_LINE=$line
  exit "$status"
}

on_exit() {
  local status=$? cleanup_status=0 cleanup_ok=false original_class=${PROBE_ERROR_CLASSIFICATION:-UNEXPECTED_COMMAND_FAILURE}
  local original_phase=${PROBE_PHASE:-bootstrap_complete} original_safe_class=${PROBE_SAFE_COMMAND_CLASS:-unknown}
  local preserved_status
  trap - ERR EXIT
  set +e
  (( FAILURE_EXIT != 0 )) && status=$FAILURE_EXIT
  cleanup_disposable
  cleanup_status=$?
  if (( cleanup_status == 0 )); then
    cleanup_ok=true
    CLEANUP_COMPLETED=true
  else
    cleanup_ok=false
    CLEANUP_ERROR_CLASSIFICATION=${PROBE_ERROR_CLASSIFICATION:-CLEANUP_INCOMPLETE}
  fi
  PROBE_ERROR_CLASSIFICATION=$original_class
  PROBE_PHASE=$original_phase
  PROBE_SAFE_COMMAND_CLASS=$original_safe_class
  if (( status != 0 )) && [[ $DIAGNOSTICS_LOADED == true ]]; then
    if ! personal_max_stage8b1i_render_failure "$status" "$FAILURE_SOURCE_LINE" "$cleanup_ok"; then
      personal_max_stage8b1i_emergency_diagnostics "$status" || true
    fi
    if declare -F pm_preserve_original_exit >/dev/null; then
      preserved_status=$(pm_preserve_original_exit "$status" "$cleanup_status")
      uint "$preserved_status" && status=$preserved_status
    fi
  elif (( status == 0 && cleanup_status != 0 )); then
    status=$cleanup_status
  fi
  exit "$status"
}

trap 'on_error $LINENO' ERR
trap on_exit EXIT

bootstrap_validate_out_name() { [[ ${1:-} =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ && $1 != __pm_* ]]; }
bootstrap_validate_internal_out_name() { [[ ${1:-} =~ ^__pm_[a-zA-Z0-9_]+$ ]]; }

bootstrap_reject_out_collision() {
  local __pm_candidate=${1:-} __pm_declared
  shift || true
  for __pm_declared in "$@"; do
    [[ $__pm_candidate != "$__pm_declared" ]] || return 65
  done
}

bootstrap_assign_out() {
  local __pm_target_name=${1:-} __pm_value=${2-}
  bootstrap_validate_out_name "$__pm_target_name" || return 64
  local -n __pm_out_ref="$__pm_target_name"
  __pm_out_ref=$__pm_value
}

bootstrap_assign_internal_out() {
  local __pm_assignment_target=${1:-} __pm_assignment_value=${2-}
  bootstrap_validate_internal_out_name "$__pm_assignment_target" || return 64
  bootstrap_reject_out_collision "$__pm_assignment_target" \
    __pm_assignment_target __pm_assignment_value __pm_assignment_ref || return
  local -n __pm_assignment_ref="$__pm_assignment_target"
  __pm_assignment_ref=$__pm_assignment_value
}

bootstrap_capture() {
  local __pm_target_name=$1 __pm_seconds=$2 __pm_captured='' __pm_status
  bootstrap_validate_out_name "$__pm_target_name" || return 64
  shift 2
  set +e
  if __pm_captured=$(timeout --signal=TERM --kill-after=10s "${__pm_seconds}s" "$@"); then __pm_status=0; else __pm_status=$?; fi
  set -e
  (( __pm_status == 0 )) || return "$__pm_status"
  bootstrap_assign_out "$__pm_target_name" "$__pm_captured"
}

bootstrap_capture_internal() {
  local __pm_capture_target=${1:-} __pm_capture_seconds=${2:-} __pm_capture_value='' __pm_capture_status
  bootstrap_validate_internal_out_name "$__pm_capture_target" || return 64
  bootstrap_reject_out_collision "$__pm_capture_target" \
    __pm_capture_target __pm_capture_seconds __pm_capture_value __pm_capture_status || return
  shift 2
  if __pm_capture_value=$(timeout --signal=TERM --kill-after=10s "${__pm_capture_seconds}s" "$@" 2>/dev/null); then
    __pm_capture_status=0
  else
    __pm_capture_status=$?
  fi
  (( __pm_capture_status == 0 )) || return "$__pm_capture_status"
  bootstrap_assign_internal_out "$__pm_capture_target" "$__pm_capture_value"
}

bootstrap_verify_runtime_path() {
  local __pm_name=${1:-} __pm_path __pm_real_path
  case $__pm_name in
    isolated-release-probe.sh | SHA256SUMS | failure-diagnostics.sh | bounded-operations.sh | \
      probe-output-helpers.sh | restore-verification.sh | postgres-startup.sh | migration-preflight.sh | \
      migration-sql-gate.sh | migration-sql-bindings.txt | \
      prisma-legacy-diff-gate.sh | synthetic-scraper-harness.js | gateway-client-harness.js) ;;
    *) printf 'RUNTIME_ARTIFACT_NAME_REFUSED\n' >&2; return 64 ;;
  esac
  __pm_path="$PACKAGE_ROOT/$__pm_name"
  [[ -f $__pm_path && ! -L $__pm_path ]] || {
    printf 'RUNTIME_ARTIFACT_PATH_REFUSED=%s\n' "$__pm_name" >&2
    return 65
  }
  bootstrap_capture_internal __pm_real_path 30 realpath -- "$__pm_path" || return
  [[ $__pm_real_path == "$__pm_path" ]] || {
    printf 'RUNTIME_ARTIFACT_PATH_REFUSED=%s\n' "$__pm_name" >&2
    return 65
  }
}

bootstrap_verify_runtime_artifact() {
  local __pm_name=${1:-} __pm_expected=${2:-} __pm_checksum_line __pm_observed
  [[ $__pm_expected =~ ^[0-9a-f]{64}$ ]] || {
    printf 'RUNTIME_ARTIFACT_EXPECTED_SHA_REFUSED=%s\n' "$__pm_name" >&2
    return 64
  }
  bootstrap_verify_runtime_path "$__pm_name" || return
  bootstrap_capture_internal __pm_checksum_line 60 sha256sum -- "$PACKAGE_ROOT/$__pm_name" || return
  __pm_observed=${__pm_checksum_line%% *}
  [[ $__pm_observed == "$__pm_expected" ]] || {
    printf 'RUNTIME_ARTIFACT_CHECKSUM_MISMATCH=%s\n' "$__pm_name" >&2
    return 66
  }
}

printf 'STAGE8B1I_PHASE=bootstrap_complete\n'
bootstrap_capture root_uid 30 id -u
[[ $root_uid -eq 0 ]] || { printf 'ROOT_REQUIRED\n' >&2; exit 77; }
[[ $# -eq 1 && $1 =~ ^[0-9a-f]{64}$ ]] || { printf 'CHECKSUM_ARGUMENT_REQUIRED\n' >&2; exit 64; }
PACKAGE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly PACKAGE_ROOT
[[ $PACKAGE_ROOT == "$EXPECTED_PACKAGE_ROOT" ]] || { printf 'PACKAGE_PATH_REFUSED\n' >&2; exit 65; }
bootstrap_verify_runtime_path isolated-release-probe.sh || exit $?
bootstrap_capture checksum_line 60 sha256sum -- "$PACKAGE_ROOT/isolated-release-probe.sh"
PM_SCRIPT_SHA256=${checksum_line%% *}
[[ $PM_SCRIPT_SHA256 == "$1" ]] || { printf 'SCRIPT_CHECKSUM_MISMATCH\n' >&2; exit 66; }
PM_FAILURE_PATH="/var/tmp/personal-max-stage8b1i-isolated-release-proof.failure.${PM_SCRIPT_SHA256}.json"
[[ ! -e $SUCCESS_REPORT && ! -L $SUCCESS_REPORT && ! -e $PM_FAILURE_PATH && ! -L $PM_FAILURE_PATH ]] || {
  printf 'NO_CLOBBER_REPORT_PATH_EXISTS\n' >&2; exit 73;
}
for command in docker jq sha256sum stat realpath df git awk sed grep comm cmp timeout openssl find sort seq runuser; do
  command -v "$command" >/dev/null || { printf 'REQUIRED_COMMAND_MISSING=%s\n' "$command" >&2; exit 69; }
done
# The checksum argument anchors this script; these constants transitively anchor
# every package file that can be sourced, executed, mounted, or decide success.
bootstrap_verify_runtime_artifact failure-diagnostics.sh "$FAILURE_DIAGNOSTICS_SHA256" || exit $?
bootstrap_verify_runtime_artifact bounded-operations.sh "$BOUNDED_OPERATIONS_SHA256" || exit $?
bootstrap_verify_runtime_artifact probe-output-helpers.sh "$PROBE_OUTPUT_HELPERS_SHA256" || exit $?
bootstrap_verify_runtime_artifact restore-verification.sh "$RESTORE_VERIFICATION_SHA256" || exit $?
bootstrap_verify_runtime_artifact postgres-startup.sh "$POSTGRES_STARTUP_SHA256" || exit $?
bootstrap_verify_runtime_artifact migration-preflight.sh "$MIGRATION_PREFLIGHT_SHA256" || exit $?
bootstrap_verify_runtime_artifact migration-sql-gate.sh "$MIGRATION_SQL_GATE_SHA256" || exit $?
bootstrap_verify_runtime_artifact migration-sql-bindings.txt "$MIGRATION_SQL_BINDINGS_SHA256" || exit $?
bootstrap_verify_runtime_artifact prisma-legacy-diff-gate.sh "$PRISMA_LEGACY_DIFF_GATE_SHA256" || exit $?
bootstrap_verify_runtime_artifact synthetic-scraper-harness.js "$SYNTHETIC_SCRAPER_HARNESS_SHA256" || exit $?
bootstrap_verify_runtime_artifact gateway-client-harness.js "$GATEWAY_CLIENT_HARNESS_SHA256" || exit $?
# SHA256SUMS remains a complete package-integrity ledger, but is deliberately
# not a trust anchor because binding it here would create a circular hash.
bootstrap_verify_runtime_path SHA256SUMS || exit $?
timeout --signal=TERM --kill-after=10s 60s sh -c 'cd -- "$1" && sha256sum -c SHA256SUMS >/dev/null' sh "$PACKAGE_ROOT"
# shellcheck source=release/personal-max-stage8b1i/failure-diagnostics.sh
source "$PACKAGE_ROOT/failure-diagnostics.sh"
DIAGNOSTICS_LOADED=true
# Diagnostics load first so the emergency fallback remains available if either
# wrapper library fails while being sourced after checksum validation.
# shellcheck source=release/personal-max-stage8b1i/bounded-operations.sh
source "$PACKAGE_ROOT/bounded-operations.sh"
# shellcheck source=release/personal-max-stage8b1i/probe-output-helpers.sh
source "$PACKAGE_ROOT/probe-output-helpers.sh"
# shellcheck source=release/personal-max-stage8b1i/postgres-startup.sh
source "$PACKAGE_ROOT/postgres-startup.sh"
# shellcheck source=release/personal-max-stage8b1i/migration-preflight.sh
source "$PACKAGE_ROOT/migration-preflight.sh"
# shellcheck source=release/personal-max-stage8b1i/restore-verification.sh
source "$PACKAGE_ROOT/restore-verification.sh"

pm_enter_phase source_binding package_validation
sha_of observed_sha "$BACKUP_REPORT"
[[ $observed_sha == "$BACKUP_REPORT_SHA256" ]]
pm_capture_bounded observed_stat filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED stat -Lc '%U:%G:%a' "$BACKUP_REPORT"
[[ $observed_stat == root:codexbot:640 && -f $BACKUP_REPORT && ! -L $BACKUP_REPORT ]]
pm_run_bounded package_validation 60 METADATA_TIMEOUT METADATA_FAILED jq -e --arg dumpSha "$DUMP_SHA256" --argjson dumpBytes "$DUMP_BYTES" --argjson objects "$DUMP_OBJECTS" \
  '.schemaVersion==1 and .mode=="PRODUCTION_BACKUP_METADATA" and .dump.sha256==$dumpSha and
   .dump.bytes==$dumpBytes and .dump.format=="custom" and .dump.noOwner==true and .dump.noAcl==true and
   .dump.objectCount==$objects and .dump.structuralValidation=="PASS" and
   .migrationLedger.total==46 and .migrationLedger.finished==46 and .migrationLedger.failed==0 and
   .migrationLedger.sourceReportMatched==true and .production.containerHashes.before==.production.containerHashes.after and
   .production.restartCount.before==.production.restartCount.after and .restore.FULL_RESTORE_PROOF=="PENDING_ISOLATED_ROOT_PROBE" and
   ([.safety.DockerMutation,.safety.DDL,.safety.DML,.safety.migration,.safety.restart,.safety.deploy,
     .safety.imagePull,.safety.imageLoad,.safety.browserLaunched,.safety.maxContacted,.safety.providerAction]|all(.==false))' "$BACKUP_REPORT" >/dev/null
sha_of observed_sha "$PREFLIGHT_REPORT"
[[ $observed_sha == "$PREFLIGHT_REPORT_SHA256" ]]
pm_capture_bounded observed_stat filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED stat -Lc '%U:%G:%a:%s' "$DUMP_PATH"
[[ -f $DUMP_PATH && ! -L $DUMP_PATH && $observed_stat == "root:root:600:$DUMP_BYTES" ]]
sha_of observed_sha "$DUMP_PATH"
[[ $observed_sha == "$DUMP_SHA256" ]]

pm_capture_bounded RUN_ID filesystem_metadata 30 METADATA_TIMEOUT METADATA_FAILED openssl rand -hex 6
[[ $RUN_ID =~ ^[0-9a-f]{12}$ ]]
PREFIX="personal-max-stage8b1i-$RUN_ID"
NETWORK="$PREFIX-internal"
PG_VOLUME="$PREFIX-postgres"
SPOOL_VOLUME="$PREFIX-spool"
PG_CONTAINER="$PREFIX-postgres"
EXPECTED_POSTGRES_ALIAS="$PREFIX-postgres-dns"
GATEWAY_CONTAINER="$PREFIX-gateway"
pm_capture_bounded TMP filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED mktemp -d "/var/tmp/personal-max-stage8b1i.$RUN_ID.XXXXXX"
pm_run_bounded filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED chmod 0700 "$TMP"

pm_enter_phase storage_gate docker_metadata
image_presence GATEWAY_PREEXISTING_BEFORE_PULL GATEWAY_IMAGE_ID_BEFORE "$GATEWAY_IMAGE"
image_presence SCRAPER_PREEXISTING_BEFORE_PULL SCRAPER_IMAGE_ID_BEFORE "$SCRAPER_IMAGE"
if [[ $GATEWAY_PREEXISTING_BEFORE_PULL == true && $SCRAPER_PREEXISTING_BEFORE_PULL == true ]]; then
  IMAGE_EXPANSION_REQUIRED_BYTES=0
fi
free_bytes_at FREE_BYTES_BEFORE_PULL /var/lib/docker
pm_check_disk_gate "$FREE_BYTES_BEFORE_PULL" "$((REQUIRED_FREE_BYTES + IMAGE_EXPANSION_REQUIRED_BYTES + PROBE_BUDGET_BYTES))" PRE_PULL_DISK_GATE_FAILED
(( FREE_BYTES_BEFORE_PULL - IMAGE_EXPANSION_REQUIRED_BYTES - PROBE_BUDGET_BYTES - CLEANUP_RESERVE_BYTES >= 0 )) || {
  PROBE_ERROR_CLASSIFICATION=PRE_PULL_DISK_GATE_FAILED; exit 90;
}

pm_enter_phase production_snapshot_before docker_metadata
pm_capture_bounded stage_objects docker_metadata 60 METADATA_TIMEOUT METADATA_FAILED docker ps -aq --no-trunc --filter "label=$STAGE_LABEL"
[[ -z $stage_objects ]]
production_snapshot "$TMP/production-before.json"

for name in "$PG_CONTAINER" "$GATEWAY_CONTAINER"; do
  pm_capture_bounded collision docker_metadata 60 METADATA_TIMEOUT METADATA_FAILED docker ps -aq --no-trunc --filter "name=^/${name}$"
  [[ -z $collision ]]
done
pm_expect_failure_bounded docker_metadata 60 METADATA_TIMEOUT docker network inspect "$NETWORK" >/dev/null 2>&1
pm_expect_failure_bounded docker_metadata 60 METADATA_TIMEOUT docker volume inspect "$PG_VOLUME" >/dev/null 2>&1
pm_expect_failure_bounded docker_metadata 60 METADATA_TIMEOUT docker volume inspect "$SPOOL_VOLUME" >/dev/null 2>&1

verify_image() {
  local ref=$1 digest=$2 role=$3 os architecture digests
  pm_capture_bounded os docker_metadata 60 METADATA_TIMEOUT METADATA_FAILED docker image inspect --format '{{.Os}}' "$ref" || return
  pm_capture_bounded architecture docker_metadata 60 METADATA_TIMEOUT METADATA_FAILED docker image inspect --format '{{.Architecture}}' "$ref" || return
  [[ $os == linux && $architecture == amd64 ]]
  pm_capture_bounded digests docker_metadata 60 METADATA_TIMEOUT METADATA_FAILED docker image inspect --format '{{json .RepoDigests}}' "$ref" || return
  if ! pm_run_bounded docker_metadata 60 METADATA_TIMEOUT REGISTRY_DIGEST_MISMATCH jq -e --arg digest "$digest" \
    'any(.[]; endswith("@"+$digest))' <<<"$digests" >/dev/null; then
    PROBE_ERROR_CLASSIFICATION=REGISTRY_DIGEST_MISMATCH
    return 67
  fi
  pm_capture_bounded history docker_metadata 60 METADATA_TIMEOUT METADATA_FAILED docker image history --no-trunc --format '{{.CreatedBy}}' "$ref" || return
  if grep -Eiq '(password|secret|token|private[_ -]?key)[=:][^ ]{8,}' <<<"$history"; then
    fail 67 image_verification docker_metadata
  fi
  printf '%s\n' "$role" >/dev/null
}

pm_enter_phase image_acquisition docker_pull
if [[ $GATEWAY_PREEXISTING_BEFORE_PULL == false ]]; then
  pm_pull_exact gateway "$GATEWAY_IMAGE" "$TMP/gateway-pull.log" "$TMP/gateway-pull.stderr"
  GATEWAY_ACQUIRED_DURING_PROBE=true
fi
verify_image "$GATEWAY_IMAGE" "$GATEWAY_DIGEST" gateway
pm_enter_phase post_pull_storage_gate filesystem_metadata
free_bytes_at FREE_BYTES_AFTER_GATEWAY_PULL /var/lib/docker
pm_check_disk_gate "$FREE_BYTES_AFTER_GATEWAY_PULL" "$((REQUIRED_FREE_BYTES + PROBE_BUDGET_BYTES))" POST_PULL_DISK_GATE_FAILED
pm_enter_phase image_acquisition docker_pull
if [[ $SCRAPER_PREEXISTING_BEFORE_PULL == false ]]; then
  pm_pull_exact scraper "$SCRAPER_IMAGE" "$TMP/scraper-pull.log" "$TMP/scraper-pull.stderr"
  SCRAPER_ACQUIRED_DURING_PROBE=true
fi
verify_image "$SCRAPER_IMAGE" "$SCRAPER_DIGEST" scraper
pm_enter_phase post_pull_storage_gate filesystem_metadata
free_bytes_at FREE_BYTES_AFTER_SCRAPER_PULL /var/lib/docker
pm_check_disk_gate "$FREE_BYTES_AFTER_SCRAPER_PULL" "$((REQUIRED_FREE_BYTES + PROBE_BUDGET_BYTES))" POST_PULL_DISK_GATE_FAILED
FREE_BYTES_AFTER_PULL=$FREE_BYTES_AFTER_SCRAPER_PULL
observed_image_growth=$((FREE_BYTES_BEFORE_PULL > FREE_BYTES_AFTER_PULL ? FREE_BYTES_BEFORE_PULL - FREE_BYTES_AFTER_PULL : 0))
if [[ $GATEWAY_ACQUIRED_DURING_PROBE == true || $SCRAPER_ACQUIRED_DURING_PROBE == true ]]; then
  (( observed_image_growth <= IMAGE_EXPANSION_BYTES )) || { PROBE_ERROR_CLASSIFICATION=POST_PULL_DISK_GATE_FAILED; exit 90; }
fi

pm_enter_phase image_verification docker_metadata
verify_image "$GATEWAY_IMAGE" "$GATEWAY_DIGEST" gateway
verify_image "$SCRAPER_IMAGE" "$SCRAPER_DIGEST" scraper
pm_capture_bounded postgres_image_facts docker_metadata 60 METADATA_TIMEOUT METADATA_FAILED docker image inspect --format '{{.Os}}|{{.Architecture}}|{{.Id}}' "$POSTGRES_IMAGE"
[[ $postgres_image_facts == "linux|amd64|$POSTGRES_DIGEST" ]]
pm_capture_bounded gateway_user docker_disposable 120 DISPOSABLE_DOCKER_TIMEOUT DISPOSABLE_DOCKER_FAILED \
  docker run --rm --name "$PREFIX-gateway-usercheck" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" \
  --network none --entrypoint node "$GATEWAY_IMAGE" -e 'process.stdout.write(`${process.getuid()}:${process.getgid()}`)'
pm_capture_bounded gateway_declared_user docker_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
  docker image inspect --format '{{.Config.User}}' "$GATEWAY_IMAGE"
pm_capture_bounded scraper_user docker_disposable 120 DISPOSABLE_DOCKER_TIMEOUT DISPOSABLE_DOCKER_FAILED \
  docker run --rm --name "$PREFIX-scraper-usercheck" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" \
  --network none --entrypoint node "$SCRAPER_IMAGE" -e 'process.stdout.write(`${process.getuid()}:${process.getgid()}`)'
pm_capture_bounded postgres_version_output docker_disposable 120 DISPOSABLE_DOCKER_TIMEOUT DISPOSABLE_DOCKER_FAILED \
  docker run --rm --name "$PREFIX-postgres-version" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" \
  --network none --entrypoint postgres "$POSTGRES_IMAGE" --version
[[ $gateway_user == 1000:1000 && $gateway_declared_user =~ ^[a-zA-Z0-9:_-]+$ && \
  $scraper_user == 1001:1001 && $postgres_version_output == *"$POSTGRES_VERSION"* ]]

PG_USER="pm_${RUN_ID}"
PG_DB="pm_${RUN_ID}"
PG_SHADOW_DB="pm_${RUN_ID}_shadow"
pm_capture_bounded PG_PASSWORD filesystem_metadata 30 METADATA_TIMEOUT METADATA_FAILED openssl rand -hex 32
HMAC_KEY_ID="stage8b1i-$RUN_ID"
pm_capture_bounded HMAC_SECRET filesystem_metadata 30 METADATA_TIMEOUT METADATA_FAILED openssl rand -hex 48
ACCOUNT_A="stage8b1i-a-$RUN_ID"
ACCOUNT_B="stage8b1i-b-$RUN_ID"
pm_migration_build_database_url DATABASE_URL "$PG_USER" "$PG_PASSWORD" "$EXPECTED_POSTGRES_ALIAS" "$PG_DB"
pm_migration_build_database_url SHADOW_DATABASE_URL "$PG_USER" "$PG_PASSWORD" "$EXPECTED_POSTGRES_ALIAS" "$PG_SHADOW_DB"
MIGRATION_POSTGRES_ALIAS_URL_BINDING=true
printf 'POSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\n' "$PG_USER" "$PG_PASSWORD" "$PG_DB" >"$TMP/postgres.env"
printf 'DATABASE_URL=%s\nMAX_PERSONAL_GATEWAY_DATABASE_URL=%s\nMAX_PERSONAL_CAPTURE_HMAC_KEYS_JSON={"%s":"%s"}\nMAX_PERSONAL_GATEWAY_BIND_HOST=0.0.0.0\nMAX_PERSONAL_GATEWAY_PRIVATE_NETWORK=required\nMAX_RAW_JOURNAL_ENABLED=%s,%s\nMAX_INBOUND_NORMALIZER_ENABLED=%s,%s\nMAX_SHADOW_COMPARISON_ENABLED=%s,%s\nMAX_PERSONAL_LIVE_CAPTURE_ENABLED=%s,%s\nMAX_PERSONAL_GATEWAY_WORKER_POLL_MS=100\nMAX_PERSONAL_GATEWAY_WORKER_BATCH_SIZE=100\n' \
  "$DATABASE_URL" "$DATABASE_URL" "$HMAC_KEY_ID" "$HMAC_SECRET" "$ACCOUNT_A" "$ACCOUNT_B" "$ACCOUNT_A" "$ACCOUNT_B" \
  "$ACCOUNT_A" "$ACCOUNT_B" "$ACCOUNT_A" "$ACCOUNT_B" >"$TMP/gateway.env"
printf 'DATABASE_URL=%s\nMAX_PERSONAL_GATEWAY_DATABASE_URL=%s\nMAX_PERSONAL_GATEWAY_BIND_HOST=0.0.0.0\nMAX_PERSONAL_GATEWAY_PRIVATE_NETWORK=required\nMAX_RAW_JOURNAL_ENABLED=%s\n' \
  "$DATABASE_URL" "$DATABASE_URL" "$ACCOUNT_A" >"$TMP/missing-hmac.env"
printf 'DATABASE_URL=%s\nSHADOW_DATABASE_URL=%s\n' "$DATABASE_URL" "$SHADOW_DATABASE_URL" >"$TMP/migration.env"
printf 'MAX_PERSONAL_CAPTURE_HMAC_KEY_ID=%s\nMAX_PERSONAL_CAPTURE_HMAC_SECRET=%s\n' "$HMAC_KEY_ID" "$HMAC_SECRET" >"$TMP/client.env"
pm_run_bounded filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED chmod 0600 "$TMP"/*.env

pm_enter_phase disposable_topology docker_disposable
pm_run_bounded docker_disposable 120 DISPOSABLE_DOCKER_TIMEOUT DISPOSABLE_DOCKER_FAILED \
  docker network create --internal --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" "$NETWORK" >/dev/null
pm_run_bounded docker_disposable 120 DISPOSABLE_DOCKER_TIMEOUT DISPOSABLE_DOCKER_FAILED \
  docker volume create --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" "$PG_VOLUME" >/dev/null
pm_run_bounded docker_disposable 120 DISPOSABLE_DOCKER_TIMEOUT DISPOSABLE_DOCKER_FAILED \
  docker volume create --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" "$SPOOL_VOLUME" >/dev/null

pm_enter_phase postgresql_start docker_disposable
pm_postgres_start_container \
  docker run -d --name "$PG_CONTAINER" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" \
  --network-alias "$EXPECTED_POSTGRES_ALIAS" \
  --env-file "$TMP/postgres.env" -v "$PG_VOLUME:/var/lib/postgresql/data" -v "$DUMP_PATH:/backup/database.dump:ro" "$POSTGRES_IMAGE"
pm_postgres_wait_readiness 90 120
pm_postgres_wait_version server_version_num "$POSTGRES_VERSION_NUM" 30 60
server_version="${POSTGRES_OBSERVED_VERSION_MAJOR}.${POSTGRES_OBSERVED_VERSION_MINOR}"
RESTORE_CHECK_ID=NONE

pm_enter_phase backup_restore backup_validation
pm_write_bounded "$TMP/dump.list" backup_validation 120 RESTORE_LIST_TIMEOUT RESTORE_LIST_FAILED \
  docker exec "$PG_CONTAINER" pg_restore --list /backup/database.dump
object_count=$(awk 'NF && $1 !~ /^;/{count++} END{print count+0}' "$TMP/dump.list")
[[ $object_count -eq $DUMP_OBJECTS ]]
restore_started=$(date +%s)
pm_write_bounded "$TMP/restore.log" backup_validation 1200 FULL_RESTORE_TIMEOUT FULL_RESTORE_FAILED \
  docker exec "$PG_CONTAINER" pg_restore --exit-on-error --no-owner --no-acl -U "$PG_USER" -d "$PG_DB" /backup/database.dump
restore_seconds=$(( $(date +%s) - restore_started ))

pm_enter_phase migration_preflight disposable_migration
pm_migration_write_bounded "$TMP/repository-migrations" MIGRATION_INVENTORY_CHECK repository_inventory \
  migration_inventory docker_start docker_cli 120 MIGRATION_INVENTORY_TIMEOUT MIGRATION_INVENTORY_FAILED \
  docker run --rm --name "$PREFIX-migration-inventory" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network none \
  --entrypoint sh "$GATEWAY_IMAGE" -ceu 'for directory in /app/prisma/migrations/*; do test -d "$directory" && basename "$directory"; done | sort'

pm_enter_phase restore_verification disposable_postgresql
MIGRATION_CHECK_ID=NONE
pm_restore_verify_database
RESTORE_CHECK_ID=NONE

pm_enter_phase migration_preflight disposable_migration
pm_migration_write_bounded "$TMP/pending-before" MIGRATION_PENDING_SET_CHECK pending_set_validation \
  host_validator internal_validator coreutils 60 MIGRATION_INTERNAL_VALIDATOR_FAILED MIGRATION_INTERNAL_VALIDATOR_FAILED \
  comm -23 "$TMP/repository-migrations" "$TMP/ledger-before"
pm_migration_write_bounded "$TMP/expected-migrations.unsorted" MIGRATION_PENDING_SET_CHECK pending_set_validation \
  host_validator internal_validator shell_builtin 30 MIGRATION_INTERNAL_VALIDATOR_FAILED MIGRATION_INTERNAL_VALIDATOR_FAILED \
  printf '%s\n' "${EXPECTED_MIGRATIONS[@]}"
pm_migration_write_bounded "$TMP/expected-migrations" MIGRATION_PENDING_SET_CHECK pending_set_validation \
  host_validator internal_validator coreutils 30 MIGRATION_INTERNAL_VALIDATOR_FAILED MIGRATION_INTERNAL_VALIDATOR_FAILED \
  sort "$TMP/expected-migrations.unsorted"
pm_migration_run_bounded MIGRATION_PENDING_SET_CHECK pending_set_validation host_validator internal_validator coreutils \
  30 MIGRATION_INTERNAL_VALIDATOR_FAILED MIGRATION_INTERNAL_VALIDATOR_FAILED \
  cmp "$TMP/expected-migrations" "$TMP/pending-before"
pm_migration_capture_bounded repository_migration_count MIGRATION_REPOSITORY_COUNT_CHECK repository_count_validation \
  host_validator internal_validator coreutils 30 MIGRATION_INTERNAL_VALIDATOR_FAILED MIGRATION_INTERNAL_VALIDATOR_FAILED \
  sh -ceu 'wc -l <"$1" | tr -d " "' sh "$TMP/repository-migrations"
if [[ $repository_migration_count != 53 ]]; then
  pm_migration_reject_before_command MIGRATION_REPOSITORY_COUNT_CHECK repository_count_validation \
    host_validator internal_validator shell_builtin MIGRATION_INTERNAL_VALIDATOR_FAILED 65
fi
pm_migration_write_bounded "$TMP/applied-only" MIGRATION_APPLIED_ONLY_CHECK applied_only_validation \
  host_validator internal_validator coreutils 30 MIGRATION_INTERNAL_VALIDATOR_FAILED MIGRATION_INTERNAL_VALIDATOR_FAILED \
  comm -13 "$TMP/repository-migrations" "$TMP/ledger-before"
if [[ $(<"$TMP/applied-only") != "$ACCEPTED_LEDGER_ONLY_MIGRATION" ]]; then
  pm_migration_reject_before_command MIGRATION_APPLIED_ONLY_CHECK applied_only_validation \
    host_validator internal_validator shell_builtin MIGRATION_INTERNAL_VALIDATOR_FAILED 65
fi

pm_migration_run_bounded MIGRATION_RUNTIME_BINDING_CHECK runtime_file_binding sql_gate filesystem_binding coreutils \
  30 MIGRATION_COMMAND_NOT_STARTED MIGRATION_COMMAND_NOT_STARTED mkdir -m 0755 "$TMP/migration-runtime"
pm_migration_prepare_runtime_file "$PACKAGE_ROOT/migration-sql-gate.sh" \
  "$TMP/migration-runtime/migration-sql-gate.sh" "$MIGRATION_SQL_GATE_SHA256" 1000 1000
pm_migration_prepare_runtime_file "$PACKAGE_ROOT/migration-sql-bindings.txt" \
  "$TMP/migration-runtime/migration-sql-bindings.txt" "$MIGRATION_SQL_BINDINGS_SHA256" 1000 1000
pm_migration_create_runner migration_scan_id MIGRATION_SQL_RUNNER_CREATE_CHECK sql_runner_create sql_gate \
  docker create --name "$PREFIX-migration-scan" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network none \
  -v "$TMP/migration-runtime/migration-sql-gate.sh:/tmp/stage8b1i-migration-sql-gate.sh:ro" \
  -v "$TMP/migration-runtime/migration-sql-bindings.txt:/tmp/stage8b1i-migration-sql-bindings.txt:ro" \
  --entrypoint sh "$GATEWAY_IMAGE" /tmp/stage8b1i-migration-sql-gate.sh \
  /app/prisma/migrations /tmp/stage8b1i-migration-sql-bindings.txt
pm_migration_capture_bounded migration_scan_identity MIGRATION_SQL_RUNNER_IDENTITY_CHECK sql_runner_identity \
  sql_gate docker_inspect docker_cli 30 MIGRATION_CONTAINER_UNAVAILABLE MIGRATION_CONTAINER_UNAVAILABLE \
  docker inspect --format '{{.Config.Image}}|{{.Config.User}}|{{.HostConfig.NetworkMode}}' "$PREFIX-migration-scan"
pm_migration_validate_runner_identity "$migration_scan_identity" "$GATEWAY_IMAGE" "$gateway_declared_user" none sql_gate
pm_migration_start_runner "$PREFIX-migration-scan" sql_gate "$TMP/migration-scan.log"

pm_migration_capture_bounded postgres_alias_facts MIGRATION_POSTGRES_ALIAS_CHECK postgres_alias_validation \
  postgres docker_inspect docker_cli 30 MIGRATION_POSTGRES_INSPECT_FAILED MIGRATION_POSTGRES_INSPECT_FAILED \
  docker inspect --format '{"running":{{json .State.Running}},"networks":{{json .NetworkSettings.Networks}}}' "$PG_CONTAINER"
pm_migration_validate_alias_facts "$postgres_alias_facts" "$NETWORK" "$EXPECTED_POSTGRES_ALIAS"
pm_migration_run_bounded MIGRATION_SHADOW_DATABASE_CREATE_CHECK shadow_database_create postgres docker_exec postgres_client \
  120 MIGRATION_DOCKER_EXEC_FAILED MIGRATION_DOCKER_EXEC_FAILED \
  docker exec "$PG_CONTAINER" createdb -U "$PG_USER" "$PG_SHADOW_DB"

pm_enter_phase disposable_migration disposable_migration
migration_started=$(date +%s)
pm_migration_create_runner migration_apply_id MIGRATION_PRISMA_RUNNER_CREATE_CHECK prisma_runner_create prisma_deploy \
  docker create --name "$PREFIX-migration-apply" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" \
  --env-file "$TMP/migration.env" --entrypoint sh "$GATEWAY_IMAGE" -ceu \
  'test -x /app/node_modules/.bin/prisma || exit 127; exec /app/node_modules/.bin/prisma migrate deploy --schema /app/prisma/schema.prisma'
pm_migration_capture_bounded migration_apply_identity MIGRATION_PRISMA_RUNNER_IDENTITY_CHECK prisma_runner_identity \
  prisma_deploy docker_inspect docker_cli 30 MIGRATION_CONTAINER_UNAVAILABLE MIGRATION_CONTAINER_UNAVAILABLE \
  docker inspect --format '{{.Config.Image}}|{{.Config.User}}|{{.HostConfig.NetworkMode}}' "$PREFIX-migration-apply"
pm_migration_validate_runner_identity "$migration_apply_identity" "$GATEWAY_IMAGE" "$gateway_declared_user" "$NETWORK" prisma_deploy
pm_migration_start_runner "$PREFIX-migration-apply" prisma_deploy "$TMP/migration.log"
migration_seconds=$(( $(date +%s) - migration_started ))

pm_enter_phase migration_verification disposable_migration
pm_migration_psql_value ledger_after_finished MIGRATION_POST_LEDGER_CHECK post_ledger_verification \
  'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'
pm_migration_psql_value ledger_after_failed MIGRATION_POST_LEDGER_CHECK post_ledger_verification \
  'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL'
pm_migration_run_bounded MIGRATION_POST_LEDGER_CHECK post_ledger_verification host_validator internal_validator shell_builtin \
  30 MIGRATION_POST_VERIFICATION_FAILED MIGRATION_POST_VERIFICATION_FAILED \
  test "$ledger_after_finished" -eq 54 -a "$ledger_after_failed" -eq 0
pm_migration_psql_value ledger_after MIGRATION_POST_LEDGER_CHECK post_ledger_verification \
  "SELECT migration_name FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name"
printf '%s\n' "$ledger_after" >"$TMP/ledger-after"
pm_migration_write_bounded "$TMP/applied-now" MIGRATION_POST_LEDGER_CHECK post_ledger_verification \
  host_validator internal_validator coreutils 30 MIGRATION_POST_VERIFICATION_FAILED MIGRATION_POST_VERIFICATION_FAILED \
  comm -13 "$TMP/ledger-before" "$TMP/ledger-after"
pm_migration_run_bounded MIGRATION_POST_LEDGER_CHECK post_ledger_verification host_validator internal_validator coreutils \
  30 MIGRATION_POST_VERIFICATION_FAILED MIGRATION_POST_VERIFICATION_FAILED \
  cmp "$TMP/expected-migrations" "$TMP/applied-now"
migration_names_sql=$(printf "'%s'," "${EXPECTED_MIGRATIONS[@]}")
migration_names_sql=${migration_names_sql%,}
migration_query="SELECT COALESCE(json_agg(json_build_object('name',migration_name,'durationMs',GREATEST(0,ROUND(EXTRACT(EPOCH FROM (finished_at-started_at))*1000)::bigint)) ORDER BY migration_name),'[]'::json)::text FROM \"_prisma_migrations\" WHERE migration_name IN ($migration_names_sql) AND finished_at IS NOT NULL AND rolled_back_at IS NULL"
pm_migration_psql_value migration_durations MIGRATION_POST_LEDGER_CHECK post_ledger_verification "$migration_query"
pm_migration_run_bounded MIGRATION_POST_LEDGER_CHECK post_ledger_verification host_validator internal_validator coreutils \
  30 MIGRATION_POST_VERIFICATION_FAILED MIGRATION_POST_VERIFICATION_FAILED \
  jq -e 'length==8 and all(.[]; (.name|type)=="string" and (.durationMs|type)=="number" and .durationMs>=0)' \
  <<<"$migration_durations" >/dev/null
pm_migration_psql_value raw_table_present MIGRATION_POST_SCHEMA_CHECK post_schema_verification \
  "SELECT to_regclass('public.\"MaxRawTransportEvent\"') IS NOT NULL"
pm_migration_psql_value envelope_column_present MIGRATION_POST_SCHEMA_CHECK post_schema_verification \
  "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='MaxRawTransportEvent' AND column_name='captureEnvelopeId')"
pm_migration_psql_value envelope_index_present MIGRATION_POST_SCHEMA_CHECK post_schema_verification \
  "SELECT to_regclass('public.\"MaxRawTransportEvent_accountId_captureEnvelopeId_idx\"') IS NOT NULL"
pm_migration_psql_value envelope_key_present MIGRATION_POST_SCHEMA_CHECK post_schema_verification \
  "SELECT to_regclass('public.\"MaxRawTransportEvent_accountId_captureEnvelopeId_key\"') IS NOT NULL"
pm_migration_run_bounded MIGRATION_POST_SCHEMA_CHECK post_schema_verification host_validator internal_validator shell_builtin \
  30 MIGRATION_POST_VERIFICATION_FAILED MIGRATION_POST_VERIFICATION_FAILED \
  test "$raw_table_present" = t -a "$envelope_column_present" = t -a "$envelope_index_present" = t -a "$envelope_key_present" = t
pm_migration_write_bounded "$TMP/prisma-diff.log" MIGRATION_PRISMA_DIFF_CHECK prisma_diff \
  prisma_diff prisma docker_cli 600 PRISMA_DIFF_TIMEOUT PRISMA_DIFF_FAILED \
  docker run --rm --name "$PREFIX-prisma-diff" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" \
  --env-file "$TMP/migration.env" --entrypoint sh "$GATEWAY_IMAGE" -ceu \
  'exec /app/node_modules/.bin/prisma migrate diff --from-migrations /app/prisma/migrations --to-url "$DATABASE_URL" --shadow-database-url "$SHADOW_DATABASE_URL" --script'
pm_migration_run_bounded MIGRATION_PRISMA_DIFF_CHECK prisma_diff prisma_diff internal_validator posix_shell \
  60 PRISMA_DIFF_TIMEOUT PRISMA_DIFF_FAILED \
  sh "$PACKAGE_ROOT/prisma-legacy-diff-gate.sh" "$TMP/prisma-diff.log" >/dev/null
prisma_diff_empty=false
prisma_diff_status=ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS

pm_enter_phase gateway_negative docker_disposable
MIGRATION_CHECK_ID=NONE
pm_expect_failure_bounded docker_disposable 120 GATEWAY_NEGATIVE_TIMEOUT \
  docker run --rm --name "$PREFIX-gateway-missing-hmac" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" \
  --network "$NETWORK" --env-file "$TMP/missing-hmac.env" "$GATEWAY_IMAGE"
pm_expect_failure_bounded docker_disposable 120 GATEWAY_NEGATIVE_TIMEOUT \
  docker run --rm --name "$PREFIX-gateway-invalid-config" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" \
  --network "$NETWORK" -e MAX_RAW_JOURNAL_ENABLED='*' "$GATEWAY_IMAGE"

gateway_dormant_health() {
  pm_run_bounded docker_disposable 30 DISPOSABLE_DOCKER_TIMEOUT DISPOSABLE_DOCKER_FAILED \
    docker exec "$PREFIX-gateway-dormant" node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.status===200?0:1))" >/dev/null
}

gateway_active_health() {
  pm_run_bounded docker_disposable 30 DISPOSABLE_DOCKER_TIMEOUT DISPOSABLE_DOCKER_FAILED \
    docker exec "$GATEWAY_CONTAINER" node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.status===200?0:1))" >/dev/null
}

pm_enter_phase gateway_dormant docker_disposable
pm_run_bounded docker_disposable 120 DISPOSABLE_DOCKER_TIMEOUT DISPOSABLE_DOCKER_FAILED \
  docker run -d --name "$PREFIX-gateway-dormant" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" "$GATEWAY_IMAGE" >/dev/null
pm_poll_until 30 60 GATEWAY_STARTUP_TIMEOUT gateway_dormant_health
pm_run_bounded docker_disposable 60 GATEWAY_STARTUP_TIMEOUT DISPOSABLE_DOCKER_FAILED \
  docker exec "$PREFIX-gateway-dormant" node -e "fetch('http://127.0.0.1:8080/ready').then(async r=>{const v=await r.json();process.exit(r.status===200&&v.state==='dormant-ready'?0:1)})"
pm_run_bounded docker_disposable 60 CONTAINER_REMOVAL_TIMEOUT DISPOSABLE_DOCKER_FAILED docker rm -f "$PREFIX-gateway-dormant" >/dev/null

start_gateway() {
  pm_run_bounded docker_disposable 120 DISPOSABLE_DOCKER_TIMEOUT DISPOSABLE_DOCKER_FAILED \
    docker run -d --name "$GATEWAY_CONTAINER" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" \
    --network-alias max-personal-gateway --env-file "$TMP/gateway.env" "$GATEWAY_IMAGE" >/dev/null
  pm_poll_until 60 90 GATEWAY_STARTUP_TIMEOUT gateway_active_health
}

pm_enter_phase gateway_active docker_disposable
start_gateway

pm_enter_phase scraper_default_off synthetic_harness
pm_write_bounded "$TMP/default-off.json" synthetic_harness 600 SYNTHETIC_HARNESS_TIMEOUT DISPOSABLE_DOCKER_FAILED \
  docker run --rm --name "$PREFIX-scraper-default-off" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network none \
  -v "$PACKAGE_ROOT/synthetic-scraper-harness.js:/tmp/stage8b1i-harness.js:ro" --entrypoint node "$SCRAPER_IMAGE" \
  /tmp/stage8b1i-harness.js
jq -e '.defaultOffNoSpool==true and .timers==false and .network==false and .database==false' "$TMP/default-off.json" >/dev/null
pm_run_bounded synthetic_harness 600 SYNTHETIC_HARNESS_TIMEOUT DISPOSABLE_DOCKER_FAILED \
  docker run --rm --name "$PREFIX-spool-init" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --user 0:0 --network none \
  -v "$SPOOL_VOLUME:/spool" --entrypoint sh "$SCRAPER_IMAGE" -ceu 'chown 1001:1001 /spool; chmod 0700 /spool'

pm_enter_phase e2e_outage synthetic_harness
pm_run_bounded docker_disposable 120 DISPOSABLE_DOCKER_TIMEOUT DISPOSABLE_DOCKER_FAILED docker stop "$PG_CONTAINER" >/dev/null
pm_run_bounded synthetic_http 120 GATEWAY_CLIENT_TIMEOUT DISPOSABLE_DOCKER_FAILED \
  docker exec "$GATEWAY_CONTAINER" node -e "fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.status===503?0:1))"
pm_run_bounded docker_disposable 120 DISPOSABLE_DOCKER_TIMEOUT DISPOSABLE_DOCKER_FAILED docker start "$PG_CONTAINER" >/dev/null
pm_poll_until 60 90 POLLING_DEADLINE_EXCEEDED postgres_ready
pm_run_bounded cleanup 60 CONTAINER_REMOVAL_TIMEOUT DISPOSABLE_DOCKER_FAILED docker rm -f "$GATEWAY_CONTAINER" >/dev/null
pm_write_bounded "$TMP/capture-a.json" synthetic_harness 600 SYNTHETIC_HARNESS_TIMEOUT DISPOSABLE_DOCKER_FAILED \
  docker run --rm --name "$PREFIX-scraper-capture-a" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network none \
  -e MAX_PERSONAL_ACCOUNT_ID="$ACCOUNT_A" -e MAX_PERSONAL_LIVE_CAPTURE_ENABLED="$ACCOUNT_A" \
  -e MAX_PERSONAL_CAPTURE_SPOOL_PATH=/spool/account-a -e STAGE8B1I_HARNESS_MODE=capture-only \
  -e STAGE8B1I_FRAME_COUNT=500 -e STAGE8B1I_IDENTICAL_COUNT=100 \
  -v "$SPOOL_VOLUME:/spool" -v "$PACKAGE_ROOT/synthetic-scraper-harness.js:/tmp/stage8b1i-harness.js:ro" \
  --entrypoint node "$SCRAPER_IMAGE" /tmp/stage8b1i-harness.js
pm_write_bounded "$TMP/retry-a.json" synthetic_harness 600 SYNTHETIC_HARNESS_TIMEOUT DISPOSABLE_DOCKER_FAILED \
  docker run --rm --name "$PREFIX-scraper-retry-a" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" \
  --env-file "$TMP/client.env" -e MAX_PERSONAL_ACCOUNT_ID="$ACCOUNT_A" -e MAX_PERSONAL_LIVE_CAPTURE_ENABLED="$ACCOUNT_A" \
  -e MAX_PERSONAL_CAPTURE_SPOOL_PATH=/spool/account-a -e MAX_PERSONAL_CAPTURE_INGRESS_URL=http://max-personal-gateway:8080/v1/capture \
  -e STAGE8B1I_HARNESS_MODE=retry-only -e STAGE8B1I_DRAIN_ATTEMPTS=10 \
  -v "$SPOOL_VOLUME:/spool" -v "$PACKAGE_ROOT/synthetic-scraper-harness.js:/tmp/stage8b1i-harness.js:ro" \
  --entrypoint node "$SCRAPER_IMAGE" /tmp/stage8b1i-harness.js
jq -e '.retryCount>0 and .pendingAfter>0 and .lostBeforeSpoolCount==0' "$TMP/retry-a.json" >/dev/null

pm_enter_phase e2e_recovery synthetic_harness
start_gateway
pm_write_bounded "$TMP/capture-b.json" synthetic_harness 600 SYNTHETIC_HARNESS_TIMEOUT DISPOSABLE_DOCKER_FAILED \
  docker run --rm --name "$PREFIX-scraper-capture-b" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" \
  --env-file "$TMP/client.env" -e MAX_PERSONAL_ACCOUNT_ID="$ACCOUNT_B" -e MAX_PERSONAL_LIVE_CAPTURE_ENABLED="$ACCOUNT_B" \
  -e MAX_PERSONAL_CAPTURE_SPOOL_PATH=/spool/account-b -e MAX_PERSONAL_CAPTURE_INGRESS_URL=http://max-personal-gateway:8080/v1/capture \
  -e STAGE8B1I_HARNESS_MODE=capture-and-drain -e STAGE8B1I_FRAME_COUNT=500 -e STAGE8B1I_IDENTICAL_COUNT=0 \
  -v "$SPOOL_VOLUME:/spool" -v "$PACKAGE_ROOT/synthetic-scraper-harness.js:/tmp/stage8b1i-harness.js:ro" \
  --entrypoint node "$SCRAPER_IMAGE" /tmp/stage8b1i-harness.js
pm_write_bounded "$TMP/drain-a.json" synthetic_harness 600 SYNTHETIC_HARNESS_TIMEOUT DISPOSABLE_DOCKER_FAILED \
  docker run --rm --name "$PREFIX-scraper-drain-a" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" \
  --env-file "$TMP/client.env" -e MAX_PERSONAL_ACCOUNT_ID="$ACCOUNT_A" -e MAX_PERSONAL_LIVE_CAPTURE_ENABLED="$ACCOUNT_A" \
  -e MAX_PERSONAL_CAPTURE_SPOOL_PATH=/spool/account-a -e MAX_PERSONAL_CAPTURE_INGRESS_URL=http://max-personal-gateway:8080/v1/capture \
  -e STAGE8B1I_HARNESS_MODE=drain-only -e STAGE8B1I_DRAIN_ATTEMPTS=120 \
  -v "$SPOOL_VOLUME:/spool" -v "$PACKAGE_ROOT/synthetic-scraper-harness.js:/tmp/stage8b1i-harness.js:ro" \
  --entrypoint node "$SCRAPER_IMAGE" /tmp/stage8b1i-harness.js
pm_run_bounded synthetic_harness 600 SYNTHETIC_HARNESS_TIMEOUT DISPOSABLE_DOCKER_FAILED \
  docker run --rm --name "$PREFIX-spool-permissions" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network none \
  -v "$SPOOL_VOLUME:/spool" --entrypoint sh "$SCRAPER_IMAGE" -ceu \
  'test "$(stat -c %u:%g:%a /spool)" = 1001:1001:700; find /spool -type d ! -perm 0700 -print -quit | grep -q . && exit 1 || true; find /spool -type f ! -perm 0600 -print -quit | grep -q . && exit 1 || true'
pm_run_bounded cleanup 60 CONTAINER_REMOVAL_TIMEOUT DISPOSABLE_DOCKER_FAILED docker rm -f "$GATEWAY_CONTAINER" >/dev/null
start_gateway

pm_enter_phase gateway_active synthetic_http
pm_write_bounded "$TMP/gateway-client.json" synthetic_http 600 GATEWAY_CLIENT_TIMEOUT DISPOSABLE_DOCKER_FAILED \
  docker run --rm --name "$PREFIX-gateway-client" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" \
  --env-file "$TMP/client.env" -e STAGE8B1I_ACCOUNT_A="$ACCOUNT_A" \
  -v "$PACKAGE_ROOT/gateway-client-harness.js:/tmp/stage8b1i-client.js:ro" --entrypoint node "$SCRAPER_IMAGE" \
  /tmp/stage8b1i-client.js
jq -e 'all(.missingAuthDenied,.invalidAuthDenied,.wrongAccountDenied,.requestSizeLimit,.authenticatedIngress,.idempotentRetry; .==true)' "$TMP/gateway-client.json" >/dev/null

e2e_results_ready() {
  psql_value normalized "SELECT count(*) FROM \"MaxInboundNormalizationResult\" WHERE \"accountId\" IN ('$ACCOUNT_A','$ACCOUNT_B')" || return
  psql_value compared "SELECT count(*) FROM \"MaxShadowComparisonResult\" WHERE \"accountId\" IN ('$ACCOUNT_A','$ACCOUNT_B')" || return
  [[ $normalized -ge 1001 && $compared -ge 1001 ]]
}

pm_enter_phase e2e_verification disposable_postgresql
pm_poll_until 180 240 POLLING_DEADLINE_EXCEEDED e2e_results_ready
psql_value physical_frames "SELECT count(*) FROM \"MaxRawTransportEvent\" WHERE \"accountId\" IN ('$ACCOUNT_A','$ACCOUNT_B') AND \"eventType\" IS DISTINCT FROM 'stage8b1i-idempotency'"
psql_value idempotency_rows "SELECT count(*) FROM \"MaxRawTransportEvent\" WHERE \"accountId\"='$ACCOUNT_A' AND \"eventType\"='stage8b1i-idempotency'"
psql_value identical_frames "SELECT COALESCE(max(c),0) FROM (SELECT count(*) c FROM \"MaxRawTransportEvent\" WHERE \"accountId\" IN ('$ACCOUNT_A','$ACCOUNT_B') GROUP BY \"accountId\",\"payloadSha256\" HAVING count(*)>1) grouped"
psql_value duplicate_envelopes "SELECT count(*) FROM (SELECT 1 FROM \"MaxRawTransportEvent\" WHERE \"accountId\" IN ('$ACCOUNT_A','$ACCOUNT_B') GROUP BY \"accountId\",\"captureEnvelopeId\" HAVING count(*)>1) duplicated"
psql_value wrong_account "SELECT count(*) FROM \"MaxRawTransportEvent\" WHERE \"accountId\"='stage8b1i-wrong-account'"
psql_value critical_regressions "SELECT count(*) FROM \"MaxShadowComparisonResult\" WHERE \"accountId\" IN ('$ACCOUNT_A','$ACCOUNT_B') AND \"highestSeverity\"='critical'"
psql_value quarantined_results "SELECT count(*) FROM \"MaxInboundNormalizationResult\" WHERE \"accountId\" IN ('$ACCOUNT_A','$ACCOUNT_B') AND status='quarantined'"
psql_value unsupported_results "SELECT count(*) FROM \"MaxInboundNormalizationResult\" WHERE \"accountId\" IN ('$ACCOUNT_A','$ACCOUNT_B') AND status='unsupported'"
[[ $physical_frames -eq 1000 && $idempotency_rows -eq 1 && $identical_frames -eq 100 && $duplicate_envelopes -eq 0 && $wrong_account -eq 0 && $critical_regressions -eq 0 ]]
[[ $quarantined_results -ge 2 && $unsupported_results -ge 2 ]]
[[ $normalized -ge 1001 && $compared -ge 1001 ]]

pm_run_bounded cleanup 60 CONTAINER_REMOVAL_TIMEOUT DISPOSABLE_DOCKER_FAILED docker rm -f "$GATEWAY_CONTAINER" >/dev/null
cleanup_docker_objects
CLEANUP_COMPLETED=true

pm_enter_phase final_storage_gate filesystem_metadata
free_bytes_at FREE_BYTES_AFTER_CLEANUP /var/lib/docker
pm_check_disk_gate "$FREE_BYTES_AFTER_CLEANUP" "$REQUIRED_FREE_BYTES" FINAL_DISK_GATE_FAILED

pm_capture_bounded TMP_REPORT filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
  mktemp /var/tmp/personal-max-stage8b1i-success.tmp.XXXXXX
pm_run_bounded filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED chmod 0600 "$TMP_REPORT"

pm_enter_phase production_snapshot_after docker_metadata
pm_capture_bounded TMP_AFTER filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
  mktemp /var/tmp/personal-max-stage8b1i-after.tmp.XXXXXX
pm_run_bounded filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED chmod 0600 "$TMP_AFTER"
production_snapshot "$TMP_AFTER"
production_unchanged=false
pm_write_bounded "$TMP/production-before-core.json" filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
  jq -S 'del(.freeBytes)' "$TMP/production-before.json"
pm_write_bounded "$TMP/production-after-core.json" filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
  jq -S 'del(.freeBytes)' "$TMP_AFTER"
pm_run_bounded filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
  cmp "$TMP/production-before-core.json" "$TMP/production-after-core.json" >/dev/null && production_unchanged=true
[[ $production_unchanged == true ]]
pm_assert_cleanup_zero "$CLEANUP_CONTAINERS_REMAINING" "$CLEANUP_NETWORKS_REMAINING" "$CLEANUP_VOLUMES_REMAINING" 0

pm_enter_phase report_render report_render
pm_capture_bounded generated_at filesystem_metadata 30 METADATA_TIMEOUT METADATA_FAILED date -u +'%Y-%m-%dT%H:%M:%SZ'
pm_capture_bounded applied_names report_render 60 METADATA_TIMEOUT METADATA_FAILED jq -R -s 'split("\n")|map(select(length>0))' "$TMP/applied-now"
pm_capture_bounded retry_count report_render 60 METADATA_TIMEOUT METADATA_FAILED jq -r '.retryCount' "$TMP/retry-a.json"
pm_write_bounded "$TMP_REPORT" report_render 60 METADATA_TIMEOUT METADATA_FAILED jq -n \
  --arg generatedAt "$generated_at" --arg scriptSha256 "$PM_SCRIPT_SHA256" \
  --arg backupReportSha256 "$BACKUP_REPORT_SHA256" --arg dumpSha256 "$DUMP_SHA256" --argjson dumpBytes "$DUMP_BYTES" \
  --arg gatewayRef "$GATEWAY_IMAGE" --arg scraperRef "$SCRAPER_IMAGE" --arg postgresqlRef "$POSTGRES_IMAGE" \
  --arg gatewayUser "$gateway_user" --arg scraperUser "$scraper_user" --arg postgresqlVersion "$server_version" \
  --argjson objectCount "$object_count" --argjson restoreSeconds "$restore_seconds" \
  --argjson beforeFinished "$ledger_before_finished" --argjson afterFinished "$ledger_after_finished" \
  --argjson failed "$ledger_after_failed" --argjson appliedNames "$applied_names" \
  --arg ledgerNamesSha256 "$LEDGER_NAMES_SHA256" --arg ledgerAttestationSha256 "$LEDGER_ATTESTATION_SHA256" \
  --arg ledgerNamingClassification "$LEDGER_NAMING_CLASSIFICATION" \
  --argjson ledgerNameCount "$LEDGER_NAME_COUNT" --argjson ledgerUniqueCount "$LEDGER_UNIQUE_COUNT" \
  --argjson ledgerDuplicateCount "$LEDGER_DUPLICATE_COUNT" --argjson ledgerInvalidFormatCount "$LEDGER_INVALID_FORMAT_COUNT" \
  --argjson ledgerUnsafeNameCount "$LEDGER_UNSAFE_NAME_COUNT" \
  --argjson repositoryToLedgerCount "$LEDGER_REPOSITORY_TO_LEDGER_COUNT" \
  --argjson ledgerToRepositoryCount "$LEDGER_TO_REPOSITORY_COUNT" \
  --argjson acceptedHistoricalNames "$LEDGER_ACCEPTED_HISTORICAL_NAMES_JSON" \
  --arg postgresStartupStatus "$POSTGRES_STARTUP_STATUS" --arg postgresContainerState "$POSTGRES_CONTAINER_STATE" \
  --arg postgresContainerHealth "$POSTGRES_CONTAINER_HEALTH" \
  --argjson postgresContainerExitCode "$POSTGRES_CONTAINER_EXIT_CODE" \
  --argjson postgresReadinessAttempts "$POSTGRES_READINESS_ATTEMPTS" \
  --argjson postgresReadinessTransientCount "$POSTGRES_READINESS_TRANSIENT_COUNT" \
  --argjson postgresReadinessLastExit "$POSTGRES_READINESS_LAST_EXIT" \
  --argjson postgresVersionQueryAttempts "$POSTGRES_VERSION_QUERY_ATTEMPTS" \
  --argjson postgresVersionTransientCount "$POSTGRES_VERSION_TRANSIENT_COUNT" \
  --argjson postgresVersionLastExit "$POSTGRES_VERSION_LAST_EXIT" \
  --argjson postgresVersionMatched "$POSTGRES_VERSION_MATCHED" \
  --arg postgresExpectedVersionText "$POSTGRES_VERSION" --argjson postgresExpectedVersionNum "$POSTGRES_VERSION_NUM" \
  --argjson postgresObservedVersionNum "$POSTGRES_OBSERVED_VERSION_NUM" \
  --argjson postgresObservedMajor "$POSTGRES_OBSERVED_VERSION_MAJOR" \
  --argjson postgresObservedMinor "$POSTGRES_OBSERVED_VERSION_MINOR" \
  --argjson postgresObservedPatch "$POSTGRES_OBSERVED_VERSION_PATCH" \
  --arg postgresVersionClassification "$POSTGRES_VERSION_CLASSIFICATION" \
  --arg postgresVersionOutputCategory "$POSTGRES_VERSION_OUTPUT_CATEGORY" \
  --argjson postgresStartupElapsedSeconds "$POSTGRES_STARTUP_ELAPSED_SECONDS" \
  --argjson postgresNetworkCount "$MIGRATION_POSTGRES_OBSERVED_NETWORK_COUNT" \
  --argjson postgresExpectedNetworkPresent "$MIGRATION_POSTGRES_EXPECTED_NETWORK_PRESENT" \
  --argjson postgresAliasArrayPresent "$MIGRATION_POSTGRES_ALIAS_ARRAY_PRESENT" \
  --argjson postgresExpectedAliasPresent "$MIGRATION_POSTGRES_EXPECTED_ALIAS_PRESENT" \
  --argjson postgresUnexpectedNetworkPresent "$MIGRATION_POSTGRES_UNEXPECTED_NETWORK_PRESENT" \
  --argjson postgresContainerRunning "$MIGRATION_POSTGRES_CONTAINER_RUNNING" \
  --argjson postgresAliasUrlBinding "$MIGRATION_POSTGRES_ALIAS_URL_BINDING" \
  --argjson prismaDiffEmpty "$prisma_diff_empty" --arg prismaDiffStatus "$prisma_diff_status" \
  --argjson migrationSeconds "$migration_seconds" --argjson migrationDurations "$migration_durations" \
  --argjson representativeCounts "$(<"$TMP/representative-counts.json")" \
  --argjson physicalFrames "$physical_frames" --argjson identicalFrames "$identical_frames" \
  --argjson normalized "$normalized" --argjson compared "$compared" --argjson quarantinedResults "$quarantined_results" \
  --argjson unsupportedResults "$unsupported_results" --argjson retryCount "$retry_count" \
  --argjson before "$(<"$TMP/production-before.json")" --argjson after "$(<"$TMP_AFTER")" \
  --argjson gatewayPreexisting "$GATEWAY_PREEXISTING_BEFORE_PULL" --arg gatewayImageIdBefore "$GATEWAY_IMAGE_ID_BEFORE" \
  --argjson scraperPreexisting "$SCRAPER_PREEXISTING_BEFORE_PULL" --arg scraperImageIdBefore "$SCRAPER_IMAGE_ID_BEFORE" \
  --argjson gatewayAcquired "$GATEWAY_ACQUIRED_DURING_PROBE" --argjson scraperAcquired "$SCRAPER_ACQUIRED_DURING_PROBE" \
  --argjson freeBytesBeforePull "$FREE_BYTES_BEFORE_PULL" --argjson freeBytesAfterGatewayPull "$FREE_BYTES_AFTER_GATEWAY_PULL" \
  --argjson freeBytesAfterScraperPull "$FREE_BYTES_AFTER_SCRAPER_PULL" --argjson freeBytesAfterPull "$FREE_BYTES_AFTER_PULL" \
  --argjson freeBytesAfterCleanup "$FREE_BYTES_AFTER_CLEANUP" \
  '{schemaVersion:1,mode:"ISOLATED_RELEASE_PROOF",generatedAt:$generatedAt,script:{sha256:$scriptSha256,checksumBound:true},
    bindings:{backupReportSha256:$backupReportSha256,dumpSha256:$dumpSha256,dumpBytes:$dumpBytes},
    postgresStartup:{status:$postgresStartupStatus,containerState:$postgresContainerState,
      containerExitCode:$postgresContainerExitCode,healthStatus:$postgresContainerHealth,
      readinessAttempts:$postgresReadinessAttempts,readinessTransientCount:$postgresReadinessTransientCount,
      readinessLastExit:$postgresReadinessLastExit,versionQueryAttempts:$postgresVersionQueryAttempts,
      versionTransientCount:$postgresVersionTransientCount,versionLastExit:$postgresVersionLastExit,
      expectedVersionText:$postgresExpectedVersionText,expectedVersionNum:$postgresExpectedVersionNum,
      observedVersionNum:$postgresObservedVersionNum,observedMajor:$postgresObservedMajor,
      observedMinor:$postgresObservedMinor,observedPatch:$postgresObservedPatch,
      versionClassification:$postgresVersionClassification,versionOutputCategory:$postgresVersionOutputCategory,
      versionMatched:$postgresVersionMatched,elapsedSeconds:$postgresStartupElapsedSeconds,
      rawLogsCaptured:false,environmentValuesCaptured:false,credentialsCaptured:false},
    restore:{FULL_RESTORE_PROOF:"PASS",objectCount:$objectCount,ledgerFinished:$beforeFinished,ledgerFailed:0,
      ledgerNameCount:$ledgerNameCount,ledgerUniqueCount:$ledgerUniqueCount,ledgerDuplicateCount:$ledgerDuplicateCount,
      ledgerInvalidFormatCount:$ledgerInvalidFormatCount,ledgerUnsafeNameCount:$ledgerUnsafeNameCount,
      ledgerNamesSha256:$ledgerNamesSha256,ledgerAttestationSha256:$ledgerAttestationSha256,
      ledgerNamingClassification:$ledgerNamingClassification,acceptedHistoricalNames:$acceptedHistoricalNames,
      repositoryToLedgerCount:$repositoryToLedgerCount,ledgerToRepositoryCount:$ledgerToRepositoryCount,
      catalogIntegrity:true,requiredRelations:["_prisma_migrations","users","Contact","Chat"],
      representativeCounts:$representativeCounts,durationSeconds:$restoreSeconds,userDataPrinted:false},
    migration:{DISPOSABLE_MIGRATION_PROOF:"PASS",appliedNames:$appliedNames,beforeFinished:$beforeFinished,
      afterFinished:$afterFinished,failed:$failed,prismaDiffEmpty:$prismaDiffEmpty,
      prismaDiffStatus:$prismaDiffStatus,durationSeconds:$migrationSeconds,
      acceptedLedgerOnlyMigrations:["20260717000000_add_driver_telegram_submitted_phone"],
      perMigrationDurations:$migrationDurations,repositoryDirectoryCount:53,appliedOnlyLegacyCount:1,productionMigration:false,
      postgresNetworkAlias:{explicit:true,databaseUrlHostBound:$postgresAliasUrlBinding,
        observedNetworkCount:$postgresNetworkCount,expectedNetworkPresent:$postgresExpectedNetworkPresent,
        aliasArrayPresent:$postgresAliasArrayPresent,expectedAliasPresent:$postgresExpectedAliasPresent,
        unexpectedNetworkPresent:$postgresUnexpectedNetworkPresent,containerRunning:$postgresContainerRunning,
        rawInspectCaptured:false,databaseUrlCaptured:false,credentialsCaptured:false}},
    images:{gateway:{ref:$gatewayRef,runtimeUser:$gatewayUser,digestVerified:true,preexistingBeforePull:$gatewayPreexisting,
        imageIdBeforePull:$gatewayImageIdBefore,acquiredDuringProbe:$gatewayAcquired},
      scraper:{ref:$scraperRef,runtimeUser:$scraperUser,digestVerified:true,preexistingBeforePull:$scraperPreexisting,
        imageIdBeforePull:$scraperImageIdBefore,acquiredDuringProbe:$scraperAcquired},
      postgresql:{ref:$postgresqlRef,version:$postgresqlVersion,digestVerified:true,exactProductionImageId:true},
      architecture:"linux/amd64",mutableTags:false,retained:true},
    executable:{dormant:true,invalidConfigFailsClosed:true,missingHmacFailsClosed:true,authenticatedIngress:true,authDenied:true,requestSizeLimit:true},
    e2e:{actualHook:true,frames:$physicalFrames,identicalFrames:$identicalFrames,accounts:2,retryStorm:$retryCount,
      gatewayOutage:true,databaseOutage:true,scraperRestart:true,gatewayRestart:true,spoolRecovery:true,normalized:$normalized,compared:$compared,
      quarantined:$quarantinedResults,unsupported:$unsupportedResults,captureLoss:0,accidentalDuplicateRawRows:0,
      wrongAccount:0,criticalSemanticRegressions:0},
    cleanup:{containersRemaining:0,networksRemaining:0,volumesRemaining:0,tempFilesRemaining:0,labelScoped:true,globalPrune:false},
    productionImmutability:{before:$before,after:$after,unchanged:true,productionDatabaseConnections:0,
      productionMigrationLedgerSource:"accepted_preflight_attestation"},
    storage:{freeBytesBeforePull:$freeBytesBeforePull,freeBytesAfterGatewayPull:$freeBytesAfterGatewayPull,
      freeBytesAfterScraperPull:$freeBytesAfterScraperPull,freeBytesAfterPull:$freeBytesAfterPull,
      freeBytesAfterCleanup:$freeBytesAfterCleanup,postPullRequiredBytes:'"$((REQUIRED_FREE_BYTES + PROBE_BUDGET_BYTES))"',
      finalRequiredBytes:'"$REQUIRED_FREE_BYTES"',postPullDeficitBytes:0,finalDeficitBytes:0,
      imageExpansionBudgetBytes:'"$IMAGE_EXPANSION_BYTES"',imageExpansionRequiredBytes:'"$IMAGE_EXPANSION_REQUIRED_BYTES"',
      restoreProbeBudgetBytes:'"$PROBE_BUDGET_BYTES"',cleanupReserveBytes:'"$CLEANUP_RESERVE_BYTES"'},
    safety:{productionDDL:false,productionDML:false,productionMigration:false,restart:false,deploy:false,browserLaunched:false,
      maxContacted:false,providerAction:false,productionNetworkAttached:false,productionVolumeMounted:false,profileMounted:false}}'

pm_enter_phase report_validation report_render
pm_validate_success_report "$TMP_REPORT"

cleanup_deadline=$CLEANUP_GLOBAL_DEADLINE
cleanup_temp_path "$TMP_AFTER" '/var/tmp/personal-max-stage8b1i-after.tmp.*' "$cleanup_deadline"
TMP_AFTER=''
cleanup_temp_path "$TMP" "/var/tmp/personal-max-stage8b1i.${RUN_ID}.*" "$cleanup_deadline"
TMP=''
pm_assert_cleanup_zero "$CLEANUP_CONTAINERS_REMAINING" "$CLEANUP_NETWORKS_REMAINING" "$CLEANUP_VOLUMES_REMAINING" 0

pm_enter_phase report_handoff report_handoff
pm_run_bounded report_handoff 60 METADATA_TIMEOUT METADATA_FAILED chgrp codexbot "$TMP_REPORT"
pm_run_bounded report_handoff 60 METADATA_TIMEOUT METADATA_FAILED chmod 0640 "$TMP_REPORT"
pm_capture_bounded report_permissions report_handoff 60 METADATA_TIMEOUT METADATA_FAILED stat -Lc '%U:%G:%a' "$TMP_REPORT"
[[ $report_permissions == root:codexbot:640 && -f $TMP_REPORT && ! -L $TMP_REPORT ]]
pm_capture_bounded report_identity report_handoff 60 METADATA_TIMEOUT METADATA_FAILED stat -Lc '%d:%i' "$TMP_REPORT"
pm_run_bounded report_handoff 60 METADATA_TIMEOUT METADATA_FAILED \
  mv --no-clobber --no-target-directory -- "$TMP_REPORT" "$SUCCESS_REPORT"
pm_capture_bounded final_identity report_handoff 60 METADATA_TIMEOUT METADATA_FAILED stat -Lc '%d:%i' "$SUCCESS_REPORT"
[[ $final_identity == "$report_identity" ]]
pm_run_bounded report_handoff 30 METADATA_TIMEOUT METADATA_FAILED runuser -u codexbot -- test -r "$SUCCESS_REPORT"
pm_expect_failure_bounded report_handoff 30 METADATA_TIMEOUT runuser -u codexbot -- test -w "$SUCCESS_REPORT"
sha_of report_sha "$SUCCESS_REPORT"
TMP_REPORT=''
pm_enter_phase completed report_handoff
trap - ERR EXIT
printf 'ISOLATED_RELEASE_PROOF_COMPLETED\nREPORT_PATH=%s\nREPORT_SHA256=%s\nREPORT_OWNER=root\nREPORT_GROUP=codexbot\nREPORT_MODE=0640\nCODEXBOT_READABLE=YES\nCODEXBOT_WRITABLE=NO\nFULL_RESTORE_PROOF=PASS\nDISPOSABLE_MIGRATION_PROOF=PASS\nPRODUCTION_UNCHANGED=YES\nCLEANUP=PASS\n' \
  "$SUCCESS_REPORT" "$report_sha"
