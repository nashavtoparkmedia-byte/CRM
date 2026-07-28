#!/usr/bin/env bash
# shellcheck disable=SC2034

# Sourced only after package checksum validation. All potentially blocking
# external operations in the isolated probe pass through these wrappers.

: "${PM_TIMEOUT_BIN:=timeout}"
: "${PROBE_ERROR_CLASSIFICATION:=NONE}"

pm_phase_is_safe() {
  case ${1:-} in
    bootstrap_complete | source_binding | storage_gate | production_snapshot_before | image_acquisition | \
      image_verification | post_pull_storage_gate | disposable_topology | postgresql_start | backup_restore | \
      restore_verification | migration_preflight | disposable_migration | migration_verification | \
      gateway_negative | gateway_dormant | gateway_active | scraper_default_off | e2e_outage | \
      e2e_recovery | e2e_verification | cleanup | final_storage_gate | production_snapshot_after | \
      report_render | report_validation | report_handoff | completed) return 0 ;;
    *) return 1 ;;
  esac
}

pm_error_classification_is_safe() {
  case ${1:-} in
    NONE | UNEXPECTED_COMMAND_FAILURE | METADATA_TIMEOUT | METADATA_FAILED | \
      GATEWAY_PULL_TIMEOUT | SCRAPER_PULL_TIMEOUT | REGISTRY_AUTHENTICATION_DENIED | \
      REGISTRY_MANIFEST_NOT_FOUND | REGISTRY_DIGEST_MISMATCH | REGISTRY_ACCESS_UNAVAILABLE | \
      DISPOSABLE_DOCKER_TIMEOUT | DISPOSABLE_DOCKER_FAILED | RESTORE_LIST_TIMEOUT | \
      RESTORE_LIST_FAILED | FULL_RESTORE_TIMEOUT | FULL_RESTORE_FAILED | MIGRATION_INVENTORY_TIMEOUT | \
      MIGRATION_SCAN_TIMEOUT | MIGRATE_DEPLOY_TIMEOUT | MIGRATE_DEPLOY_FAILED | PRISMA_DIFF_TIMEOUT | \
      PRISMA_DIFF_FAILED | GATEWAY_STARTUP_TIMEOUT | GATEWAY_NEGATIVE_TIMEOUT | \
      SYNTHETIC_HARNESS_TIMEOUT | GATEWAY_CLIENT_TIMEOUT | POLLING_DEADLINE_EXCEEDED | \
      CONTAINER_REMOVAL_TIMEOUT | NETWORK_REMOVAL_TIMEOUT | VOLUME_REMOVAL_TIMEOUT | \
      TEMP_REMOVAL_TIMEOUT | CLEANUP_GLOBAL_DEADLINE_EXCEEDED | CLEANUP_INCOMPLETE | \
      PRE_PULL_DISK_GATE_FAILED | POST_PULL_DISK_GATE_FAILED | FINAL_DISK_GATE_FAILED | \
      SUCCESS_REPORT_VALIDATION_TIMEOUT | SUCCESS_REPORT_MALFORMED | SUCCESS_REPORT_SAFETY_VIOLATION | \
      EXPECTED_FAILURE_NOT_OBSERVED | INVALID_OUT_PARAMETER | EMERGENCY_DIAGNOSTICS_USED | \
      EMERGENCY_DIAGNOSTICS_UNAVAILABLE) return 0 ;;
    *) return 1 ;;
  esac
}

pm_enter_phase() {
  local phase=${1:?phase required} command_class=${2:?command class required}
  pm_phase_is_safe "$phase" || return 64
  PROBE_PHASE=$phase
  PROBE_SAFE_COMMAND_CLASS=$command_class
  printf 'STAGE8B1I_PHASE=%s\n' "$phase"
}

pm_safe_uint() { [[ ${1:-} =~ ^[0-9]+$ ]]; }

pm_validate_out_name() {
  [[ ${1:-} =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ && $1 != __pm_* ]]
}

pm_assign_out() {
  local __pm_target_name=${1:-} __pm_value=${2-}
  pm_validate_out_name "$__pm_target_name" || {
    PROBE_ERROR_CLASSIFICATION=INVALID_OUT_PARAMETER
    return 64
  }
  local -n __pm_out_ref="$__pm_target_name"
  __pm_out_ref=$__pm_value
}

pm_restore_errexit() { [[ $1 == true ]] && set -e || set +e; }

pm_run_bounded() {
  local command_class=$1 seconds=$2 timeout_class=$3 failure_class=$4 status had_errexit=false
  shift 4
  [[ $- == *e* ]] && had_errexit=true
  PROBE_SAFE_COMMAND_CLASS=$command_class
  set +e
  if "$PM_TIMEOUT_BIN" --signal=TERM --kill-after=10s "${seconds}s" "$@" 2>/dev/null; then status=0; else status=$?; fi
  pm_restore_errexit "$had_errexit"
  if (( status == 124 )); then
    PROBE_ERROR_CLASSIFICATION=$timeout_class
    return 124
  fi
  if (( status != 0 )); then
    PROBE_ERROR_CLASSIFICATION=$failure_class
    return "$status"
  fi
  return 0
}

pm_capture_bounded() {
  local __pm_target_name=${1:-} __pm_command_class=${2:-} __pm_seconds=${3:-}
  local __pm_timeout_class=${4:-} __pm_failure_class=${5:-}
  local __pm_captured='' __pm_status __pm_had_errexit=false
  pm_validate_out_name "$__pm_target_name" || {
    PROBE_ERROR_CLASSIFICATION=INVALID_OUT_PARAMETER
    return 64
  }
  shift 5
  [[ $- == *e* ]] && __pm_had_errexit=true
  PROBE_SAFE_COMMAND_CLASS=$__pm_command_class
  set +e
  if __pm_captured=$("$PM_TIMEOUT_BIN" --signal=TERM --kill-after=10s "${__pm_seconds}s" "$@" 2>/dev/null); then
    __pm_status=0
  else
    __pm_status=$?
  fi
  pm_restore_errexit "$__pm_had_errexit"
  if (( __pm_status == 124 )); then
    PROBE_ERROR_CLASSIFICATION=$__pm_timeout_class
    return 124
  fi
  if (( __pm_status != 0 )); then
    PROBE_ERROR_CLASSIFICATION=$__pm_failure_class
    return "$__pm_status"
  fi
  # Bash command substitution intentionally strips trailing newlines. Empty,
  # one-line, and multiline output otherwise remain byte-for-byte unchanged.
  pm_assign_out "$__pm_target_name" "$__pm_captured"
}

pm_write_bounded() {
  local target=$1 command_class=$2 seconds=$3 timeout_class=$4 failure_class=$5 status had_errexit=false
  shift 5
  [[ $- == *e* ]] && had_errexit=true
  PROBE_SAFE_COMMAND_CLASS=$command_class
  set +e
  if "$PM_TIMEOUT_BIN" --signal=TERM --kill-after=10s "${seconds}s" "$@" >"$target" 2>/dev/null; then status=0; else status=$?; fi
  pm_restore_errexit "$had_errexit"
  if (( status == 124 )); then
    PROBE_ERROR_CLASSIFICATION=$timeout_class
    return 124
  fi
  if (( status != 0 )); then
    PROBE_ERROR_CLASSIFICATION=$failure_class
    return "$status"
  fi
}

pm_expect_failure_bounded() {
  local command_class=$1 seconds=$2 timeout_class=$3 status had_errexit=false
  shift 3
  [[ $- == *e* ]] && had_errexit=true
  PROBE_SAFE_COMMAND_CLASS=$command_class
  set +e
  if "$PM_TIMEOUT_BIN" --signal=TERM --kill-after=10s "${seconds}s" "$@" >/dev/null 2>&1; then status=0; else status=$?; fi
  pm_restore_errexit "$had_errexit"
  if (( status == 124 )); then
    PROBE_ERROR_CLASSIFICATION=$timeout_class
    return 124
  fi
  if (( status == 0 )); then
    PROBE_ERROR_CLASSIFICATION=EXPECTED_FAILURE_NOT_OBSERVED
    return 1
  fi
  return 0
}

pm_classify_registry_failure() {
  local stderr_path=$1
  if grep -Eiq 'unauthorized|authentication required|denied|forbidden' "$stderr_path"; then
    PROBE_ERROR_CLASSIFICATION=REGISTRY_AUTHENTICATION_DENIED
  elif grep -Eiq 'manifest unknown|manifest.*not found|not found.*manifest|no matching manifest' "$stderr_path"; then
    PROBE_ERROR_CLASSIFICATION=REGISTRY_MANIFEST_NOT_FOUND
  else
    PROBE_ERROR_CLASSIFICATION=REGISTRY_ACCESS_UNAVAILABLE
  fi
}

pm_pull_exact() {
  local role=$1 ref=$2 stdout_path=$3 stderr_path=$4 status timeout_class had_errexit=false
  case $role in
    gateway) timeout_class=GATEWAY_PULL_TIMEOUT ;;
    scraper) timeout_class=SCRAPER_PULL_TIMEOUT ;;
    *) return 64 ;;
  esac
  [[ $- == *e* ]] && had_errexit=true
  PROBE_SAFE_COMMAND_CLASS=docker_pull
  set +e
  if "$PM_TIMEOUT_BIN" --signal=TERM --kill-after=30s 900s docker pull "$ref" >"$stdout_path" 2>"$stderr_path"; then status=0; else status=$?; fi
  pm_restore_errexit "$had_errexit"
  if (( status == 124 )); then
    PROBE_ERROR_CLASSIFICATION=$timeout_class
    return 124
  fi
  if (( status != 0 )); then
    pm_classify_registry_failure "$stderr_path"
    return "$status"
  fi
}

pm_poll_until() {
  local attempts=$1 elapsed_limit=$2 timeout_class=$3
  shift 3
  local started=$SECONDS attempt status had_errexit=false
  [[ $- == *e* ]] && had_errexit=true
  for (( attempt=1; attempt<=attempts; attempt++ )); do
    set +e
    if "$@"; then status=0; else status=$?; fi
    pm_restore_errexit "$had_errexit"
    (( status == 0 )) && return 0
    (( status == 124 )) && return 124
    if (( SECONDS - started >= elapsed_limit )); then
      PROBE_ERROR_CLASSIFICATION=$timeout_class
      return 124
    fi
    sleep 1
  done
  PROBE_ERROR_CLASSIFICATION=$timeout_class
  return 124
}

pm_check_disk_gate() {
  local available=$1 required=$2 classification=$3
  pm_safe_uint "$available" && pm_safe_uint "$required" || return 65
  if (( available < required )); then
    PROBE_ERROR_CLASSIFICATION=$classification
    return 90
  fi
}

pm_deadline_remaining() {
  local deadline=$1 now=$SECONDS remaining
  remaining=$((deadline - now))
  if (( remaining <= 0 )); then
    PROBE_ERROR_CLASSIFICATION=CLEANUP_GLOBAL_DEADLINE_EXCEEDED
    return 124
  fi
  (( remaining > 60 )) && remaining=60
  printf '%s\n' "$remaining"
}

pm_assert_cleanup_zero() {
  local containers=$1 networks=$2 volumes=$3 temp_files=$4
  for value in "$containers" "$networks" "$volumes" "$temp_files"; do pm_safe_uint "$value" || return 65; done
  if (( containers != 0 || networks != 0 || volumes != 0 || temp_files != 0 )); then
    PROBE_ERROR_CLASSIFICATION=CLEANUP_INCOMPLETE
    return 70
  fi
}

pm_preserve_original_exit() {
  local original=$1 cleanup=$2
  pm_safe_uint "$original" && pm_safe_uint "$cleanup" || return 65
  if (( original != 0 )); then printf '%s\n' "$original"; else printf '%s\n' "$cleanup"; fi
}

pm_validate_success_report() {
  local report=$1 status had_errexit=false
  [[ $- == *e* ]] && had_errexit=true
  set +e
  if "$PM_TIMEOUT_BIN" --signal=TERM --kill-after=10s 60s jq -e . "$report" >/dev/null 2>&1; then status=0; else status=$?; fi
  pm_restore_errexit "$had_errexit"
  if (( status == 124 )); then
    PROBE_ERROR_CLASSIFICATION=SUCCESS_REPORT_VALIDATION_TIMEOUT
    return 124
  fi
  if (( status != 0 )); then
    PROBE_ERROR_CLASSIFICATION=SUCCESS_REPORT_MALFORMED
    return 65
  fi

  set +e
  if "$PM_TIMEOUT_BIN" --signal=TERM --kill-after=10s 60s jq -e '
    .schemaVersion==1 and .mode=="ISOLATED_RELEASE_PROOF" and
    (.script.sha256|test("^[0-9a-f]{64}$")) and .script.checksumBound==true and
    (.bindings.backupReportSha256|test("^[0-9a-f]{64}$")) and
    (.bindings.dumpSha256|test("^[0-9a-f]{64}$")) and .bindings.dumpBytes==45284314 and
    .restore.FULL_RESTORE_PROOF=="PASS" and .restore.objectCount==581 and
    .migration.DISPOSABLE_MIGRATION_PROOF=="PASS" and .migration.beforeFinished==46 and
    .migration.afterFinished==54 and .migration.failed==0 and .migration.prismaDiffEmpty==true and
    (.migration.appliedNames|sort)==(["20260726162043_add_max_raw_transport_journal",
      "20260726190658_add_max_route_registry","20260726205437_add_max_inbound_normalization",
      "20260726215715_add_max_per_chat_outbound_actor","20260726225737_add_max_dispatch_ledger",
      "20260727053744_add_max_provider_confirmation_matcher","20260727141925_add_max_shadow_semantic_comparison",
      "20260727154647_add_max_capture_ingress"]|sort) and
    .images.gateway.ref=="ghcr.io/nashavtoparkmedia-byte/crm-max-personal-gateway@sha256:dd718fd8e9e2ec52a0ee1c19b576d75a1035f9e251980351ebc04071dfe5d0de" and
    .images.scraper.ref=="ghcr.io/nashavtoparkmedia-byte/crm-max-web-scraper@sha256:abf4405f55ab1c84f319b00cdb8b561f76353001ba2543045fddb17dc6b46768" and
    .images.postgresql.ref=="sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229" and
    .images.gateway.digestVerified==true and .images.scraper.digestVerified==true and
    .images.postgresql.digestVerified==true and .images.gateway.runtimeUser=="1000:1000" and
    .images.scraper.runtimeUser=="1001:1001" and .images.postgresql.version=="16.14" and
    (.images.gateway.preexistingBeforePull|type)=="boolean" and
    (.images.scraper.preexistingBeforePull|type)=="boolean" and .images.retained==true and
    .e2e.frames==1000 and .e2e.identicalFrames==100 and .e2e.captureLoss==0 and
    .e2e.accidentalDuplicateRawRows==0 and .e2e.wrongAccount==0 and .e2e.criticalSemanticRegressions==0 and
    .cleanup.containersRemaining==0 and .cleanup.networksRemaining==0 and
    .cleanup.volumesRemaining==0 and .cleanup.tempFilesRemaining==0 and
    .productionImmutability.unchanged==true and .productionImmutability.productionDatabaseConnections==0 and
    .productionImmutability.productionMigrationLedgerSource=="accepted_preflight_attestation" and
    (.storage.freeBytesBeforePull|type)=="number" and (.storage.freeBytesAfterPull|type)=="number" and
    (.storage.freeBytesAfterCleanup|type)=="number"
  ' "$report" >/dev/null 2>&1; then status=0; else status=$?; fi
  pm_restore_errexit "$had_errexit"
  if (( status == 124 )); then
    PROBE_ERROR_CLASSIFICATION=SUCCESS_REPORT_VALIDATION_TIMEOUT
    return 124
  fi
  if (( status != 0 )); then
    PROBE_ERROR_CLASSIFICATION=SUCCESS_REPORT_MALFORMED
    return 65
  fi

  set +e
  if "$PM_TIMEOUT_BIN" --signal=TERM --kill-after=10s 60s jq -e '
    ([.safety.productionDDL,.safety.productionDML,.safety.productionMigration,.safety.restart,
      .safety.deploy,.safety.browserLaunched,.safety.maxContacted,.safety.providerAction,
      .safety.productionNetworkAttached,.safety.productionVolumeMounted,.safety.profileMounted]|all(.==false))
  ' "$report" >/dev/null 2>&1; then status=0; else status=$?; fi
  pm_restore_errexit "$had_errexit"
  if (( status == 124 )); then
    PROBE_ERROR_CLASSIFICATION=SUCCESS_REPORT_VALIDATION_TIMEOUT
    return 124
  fi
  if (( status != 0 )); then
    PROBE_ERROR_CLASSIFICATION=SUCCESS_REPORT_SAFETY_VIOLATION
    return 67
  fi
}
