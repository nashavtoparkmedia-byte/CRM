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
      e2e_recovery | e2e_verification | prior_residual_cleanup | cleanup | final_storage_gate | production_snapshot_after | \
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
      PRODUCTION_GIT_BASELINE_MISMATCH | \
      SUCCESS_REPORT_VALIDATION_TIMEOUT | SUCCESS_REPORT_MALFORMED | SUCCESS_REPORT_SAFETY_VIOLATION | \
      EXPECTED_FAILURE_NOT_OBSERVED | INVALID_OUT_PARAMETER | OUTPUT_TARGET_SCOPE_COLLISION | \
      EMERGENCY_DIAGNOSTICS_USED | \
      MIGRATION_COMMAND_NOT_STARTED | MIGRATION_DOCKER_CLI_FAILED | \
      MIGRATION_RUNNER_CREATE_FAILED | MIGRATION_RUNNER_START_FAILED | MIGRATION_RUNNER_EXITED | \
      MIGRATION_DOCKER_EXEC_FAILED | MIGRATION_CONTAINER_UNAVAILABLE | \
      MIGRATION_NETWORK_ALIAS_MISMATCH | MIGRATION_DATABASE_URL_CONSTRUCTION_FAILED | \
      MIGRATION_POSTGRES_INSPECT_FAILED | MIGRATION_POSTGRES_NETWORK_MISSING | \
      MIGRATION_POSTGRES_UNEXPECTED_NETWORK | MIGRATION_POSTGRES_ALIAS_ARRAY_MISSING | \
      MIGRATION_POSTGRES_ALIAS_MISSING | MIGRATION_POSTGRES_ALIAS_MISMATCH | \
      MIGRATION_POSTGRES_NETWORK_FACTS_MALFORMED | \
      MIGRATION_PRISMA_EXECUTABLE_MISSING | MIGRATION_PRISMA_COMMAND_REJECTED | \
      MIGRATION_PRISMA_EXIT_1 | MIGRATION_PRISMA_EXIT_2 | MIGRATION_PRISMA_TIMEOUT | \
      MIGRATION_SQL_BINDING_MISMATCH | MIGRATION_SQL_GATE_EXIT_2 | MIGRATION_DIRECTORY_MISSING | \
      MIGRATION_DEPLOY_FAILED | MIGRATION_POST_VERIFICATION_FAILED | MIGRATION_INTERNAL_VALIDATOR_FAILED | \
      MIGRATION_RUNTIME_FILE_UNREADABLE | MIGRATION_RUNNER_IDENTITY_MISMATCH | \
      MIGRATION_RUNNER_NETWORK_MISMATCH | MIGRATION_INVENTORY_FAILED | \
      MIGRATION_SHADOW_DATABASE_CREATE_FAILED | \
      MIGRATION_POST_FINISHED_COUNT_QUERY_FAILED | MIGRATION_POST_FAILED_COUNT_QUERY_FAILED | \
      MIGRATION_POST_LEDGER_COUNT_MISMATCH | MIGRATION_POST_LEDGER_NAMES_QUERY_FAILED | \
      MIGRATION_POST_APPLIED_SET_FAILED | MIGRATION_POST_APPLIED_SET_MISMATCH | \
      MIGRATION_DURATION_QUERY_FAILED | MIGRATION_DURATION_RESULT_MALFORMED | \
      MIGRATION_SCHEMA_TABLE_QUERY_FAILED | MIGRATION_SCHEMA_TABLE_MISSING | \
      MIGRATION_SCHEMA_COLUMN_QUERY_FAILED | MIGRATION_SCHEMA_COLUMN_MISSING | \
      MIGRATION_SCHEMA_INDEX_QUERY_FAILED | MIGRATION_SCHEMA_INDEX_MISSING | \
      MIGRATION_SCHEMA_UNIQUE_KEY_QUERY_FAILED | MIGRATION_SCHEMA_UNIQUE_KEY_MISSING | \
      MIGRATION_PRISMA_DIFF_EXECUTION_FAILED | MIGRATION_PRISMA_DIFF_REJECTED | \
      MIGRATION_PRISMA_DIFF_EMPTY_UNEXPECTED | MIGRATION_PRISMA_DIFF_REQUIRED_EMPTY | \
      MIGRATION_PRISMA_DIFF_PARSE_FAILED | MIGRATION_PRISMA_DIFF_UNEXPECTED_TABLE | \
      MIGRATION_PRISMA_DIFF_UNEXPECTED_COLUMN | MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION | \
      MIGRATION_PRISMA_DIFF_TYPE_MISMATCH | MIGRATION_PRISMA_DIFF_REQUIRED_COLUMN_MISSING | \
      MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT | MIGRATION_PRISMA_DIFF_EMPTY_ACCEPTED | \
      PRIOR_RESIDUAL_CLEANUP_REENTRY | PRIOR_RESIDUAL_PATH_UNSAFE | PRIOR_RESIDUAL_METADATA_FAILED | \
      PRIOR_RESIDUAL_MOUNTPOINT_REFUSED | PRIOR_RESIDUAL_IN_USE | PRIOR_RESIDUAL_DOCKER_OBJECTS_PRESENT | \
      PRIOR_RESIDUAL_REPORT_REFUSED | PRIOR_RESIDUAL_REMOVAL_TIMEOUT | PRIOR_RESIDUAL_REMOVAL_FAILED | \
      GATEWAY_NEGATIVE_VALIDATION_FAILED | GATEWAY_DORMANT_READINESS_FAILED | \
      GATEWAY_ACTIVE_READINESS_FAILED | SCRAPER_DEFAULT_OFF_FAILED | \
      SCRAPER_RUNTIME_REVISION_MISSING | SCRAPER_RUNTIME_SOURCE_BINDING_MISMATCH | \
      SCRAPER_RUNTIME_MODULE_MISSING | SCRAPER_RUNTIME_MODULE_SYMLINK | \
      SCRAPER_RUNTIME_EXPORT_MISSING | SCRAPER_RUNTIME_DISABLED_ADAPTER_INVALID | \
      SCRAPER_RUNTIME_INTERCEPTOR_INVALID | SCRAPER_RUNTIME_NODE_UNSUPPORTED | \
      SCRAPER_RUNTIME_IDENTITY_MISMATCH | SCRAPER_RUNTIME_OUTPUT_MISSING | \
      SCRAPER_RUNTIME_OUTPUT_MALFORMED | \
      SCRAPER_DEFAULT_OFF_MODE_MISSING | SCRAPER_DEFAULT_OFF_MODE_MISMATCH | \
      SCRAPER_DEFAULT_OFF_HARNESS_EXITED | SCRAPER_DEFAULT_OFF_OUTPUT_MISSING | \
      SCRAPER_DEFAULT_OFF_OUTPUT_MALFORMED | SCRAPER_DEFAULT_OFF_ENABLED_UNEXPECTED | \
      SCRAPER_DEFAULT_OFF_INSTRUMENTATION_FAILED | SCRAPER_DEFAULT_OFF_DEPENDENCY_LOAD_FAILED | \
      SCRAPER_DEFAULT_OFF_ADAPTER_CREATE_FAILED | SCRAPER_DEFAULT_OFF_ADAPTER_CONTRACT_FAILED | \
      SCRAPER_DEFAULT_OFF_INTERCEPTOR_CONSTRUCT_FAILED | SCRAPER_DEFAULT_OFF_FRAME_DISPATCH_FAILED | \
      SCRAPER_DEFAULT_OFF_HEALTH_READ_FAILED | SCRAPER_DEFAULT_OFF_DETACH_FAILED | \
      SCRAPER_DEFAULT_OFF_RESTORE_FAILED | SCRAPER_DEFAULT_OFF_RESULT_SERIALIZATION_FAILED | \
      SCRAPER_DEFAULT_OFF_FRAME_NOT_HANDLED | SCRAPER_DEFAULT_OFF_SPOOL_CREATED | \
      SCRAPER_DEFAULT_OFF_PENDING_UNEXPECTED | SCRAPER_DEFAULT_OFF_TIMER_ACTIVITY | \
      SCRAPER_DEFAULT_OFF_NETWORK_ACTIVITY | SCRAPER_DEFAULT_OFF_DATABASE_ACTIVITY | \
      SCRAPER_DEFAULT_OFF_ACTIVE_FACTORY_CALLED | SCRAPER_DEFAULT_OFF_DRAIN_CREATED | \
      SCRAPER_DEFAULT_OFF_CHROMIUM_ACTIVITY | SCRAPER_DEFAULT_OFF_MAX_CONTACTED | \
      SCRAPER_DEFAULT_OFF_PROVIDER_ACTION | SPOOL_INITIALIZATION_FAILED | \
      E2E_OUTAGE_FAILED | E2E_RECOVERY_FAILED | GATEWAY_CLIENT_VERIFICATION_FAILED | \
      E2E_VERIFICATION_FAILED | PRODUCTION_SNAPSHOT_MISMATCH | SUCCESS_REPORT_RENDER_FAILED | \
      SUCCESS_REPORT_HANDOFF_FAILED | SUCCESS_TERMINAL_HANDOFF_FAILED | \
      RESTORE_LEDGER_MISMATCH | RESTORE_REQUIRED_RELATION_MISSING | \
      RESTORE_LEDGER_COUNT_MISMATCH | RESTORE_LEDGER_DUPLICATE_NAME | \
      RESTORE_LEDGER_UNSAFE_NAME | RESTORE_LEDGER_EXPECTED_SET_MISMATCH | \
      RESTORE_LEDGER_HISTORICAL_NAME_ACCEPTED | \
      POSTGRES_CONTAINER_START_FAILED | POSTGRES_CONTAINER_EXITED_DURING_STARTUP | \
      POSTGRES_READINESS_TIMEOUT | POSTGRES_READINESS_COMMAND_FAILED | \
      POSTGRES_VERSION_QUERY_FAILED | POSTGRES_VERSION_OUTPUT_MALFORMED | POSTGRES_VERSION_MISMATCH | \
      RESTORE_CATALOG_INTEGRITY_FAILED | RESTORE_REPRESENTATIVE_CHECK_FAILED | \
      RESTORE_QUERY_FAILED | DISPOSABLE_CONTAINER_UNAVAILABLE | \
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

pm_validate_internal_out_name() {
  [[ ${1:-} =~ ^__pm_[a-zA-Z0-9_]+$ ]]
}

pm_reject_out_collision() {
  local __pm_candidate=${1:-} __pm_declared
  shift || true
  for __pm_declared in "$@"; do
    if [[ $__pm_candidate == "$__pm_declared" ]]; then
      PROBE_ERROR_CLASSIFICATION=OUTPUT_TARGET_SCOPE_COLLISION
      return 65
    fi
  done
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

# Reserved-scope assignment is private to checksum-bound helpers. Public APIs
# continue to reject __pm_* destinations. Every forwarding helper must first
# reject collisions with its own explicitly declared locals.
pm_assign_internal_out() {
  local __pm_assignment_target=${1:-} __pm_assignment_value=${2-}
  pm_validate_internal_out_name "$__pm_assignment_target" || {
    PROBE_ERROR_CLASSIFICATION=INVALID_OUT_PARAMETER
    return 64
  }
  pm_reject_out_collision "$__pm_assignment_target" \
    __pm_assignment_target __pm_assignment_value __pm_assignment_ref || return
  local -n __pm_assignment_ref="$__pm_assignment_target"
  __pm_assignment_ref=$__pm_assignment_value
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

pm_capture_bounded_internal() {
  local __pm_capture_target=${1:-} __pm_capture_command_class=${2:-} __pm_capture_seconds=${3:-}
  local __pm_capture_timeout_class=${4:-} __pm_capture_failure_class=${5:-}
  local __pm_capture_value='' __pm_capture_status __pm_capture_had_errexit=false
  pm_validate_internal_out_name "$__pm_capture_target" || {
    PROBE_ERROR_CLASSIFICATION=INVALID_OUT_PARAMETER
    return 64
  }
  pm_reject_out_collision "$__pm_capture_target" \
    __pm_capture_target __pm_capture_command_class __pm_capture_seconds \
    __pm_capture_timeout_class __pm_capture_failure_class __pm_capture_value \
    __pm_capture_status __pm_capture_had_errexit || return
  shift 5
  [[ $- == *e* ]] && __pm_capture_had_errexit=true
  PROBE_SAFE_COMMAND_CLASS=$__pm_capture_command_class
  set +e
  if __pm_capture_value=$("$PM_TIMEOUT_BIN" --signal=TERM --kill-after=10s \
      "${__pm_capture_seconds}s" "$@" 2>/dev/null); then
    __pm_capture_status=0
  else
    __pm_capture_status=$?
  fi
  pm_restore_errexit "$__pm_capture_had_errexit"
  if (( __pm_capture_status == 124 )); then
    PROBE_ERROR_CLASSIFICATION=$__pm_capture_timeout_class
    return 124
  fi
  if (( __pm_capture_status != 0 )); then
    PROBE_ERROR_CLASSIFICATION=$__pm_capture_failure_class
    return "$__pm_capture_status"
  fi
  pm_assign_internal_out "$__pm_capture_target" "$__pm_capture_value"
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

pm_scraper_check_id_is_safe() {
  case ${1:-} in
    SCRAPER_RUNTIME_CONTRACT_CHECK | SCRAPER_RUNTIME_SOURCE_CHECK | SCRAPER_RUNTIME_EXPORT_CHECK | \
      SCRAPER_RUNTIME_DISABLED_ADAPTER_CHECK | SCRAPER_RUNTIME_INTERCEPTOR_CHECK | \
      SCRAPER_DEFAULT_OFF_RUN_CHECK | SCRAPER_DEFAULT_OFF_RESULT_CHECK | SPOOL_INITIALIZATION_CHECK) return 0 ;;
    *) return 1 ;;
  esac
}

pm_scraper_begin_operation() {
  local check_id=${1:?check id required} substep=${2:?substep required}
  local command_category=${3:?command category required} executable_category=${4:?executable category required}
  local container_state=${5:-not_observed}
  pm_scraper_check_id_is_safe "$check_id" || return 64
  case $substep in runtime_revision | runtime_contract | runtime_source | runtime_exports | runtime_disabled_adapter | runtime_interceptor | \
    default_off_mode_binding | default_off_harness | default_off_result_validation | spool_initialization) ;; *) return 64 ;; esac
  case $command_category in invocation_contract | docker_image_inspect | docker_run | internal_validator | docker_volume_initialization) ;; *) return 64 ;; esac
  case $executable_category in shell_builtin | docker_cli | jq | posix_shell) ;; *) return 64 ;; esac
  case $container_state in not_observed | command_not_started | running | exited | unavailable) ;; *) return 64 ;; esac
  SCRAPER_CHECK_ID=$check_id
  SCRAPER_SUBSTEP=$substep
  SCRAPER_COMMAND_CATEGORY=$command_category
  SCRAPER_EXECUTABLE_CATEGORY=$executable_category
  SCRAPER_COMMAND_STARTED=false
  SCRAPER_ATTEMPT_COUNT=0
  SCRAPER_ELAPSED_SECONDS=0
  SCRAPER_ORIGINAL_EXIT=not_observed
  SCRAPER_PRIMARY_CLASSIFICATION=NONE
  SCRAPER_CONTAINER_STATE_CATEGORY=$container_state
  SCRAPER_OPERATION_STARTED_SECONDS=$SECONDS
}

pm_scraper_mark_started() {
  SCRAPER_COMMAND_STARTED=true
  SCRAPER_ATTEMPT_COUNT=$(( ${SCRAPER_ATTEMPT_COUNT:-0} + 1 ))
}

pm_scraper_finish_operation() {
  local status=${1:-0} classification=${2:-NONE} container_state=${3:-not_observed}
  [[ $status =~ ^[0-9]+$ && $status -le 255 ]] || return 64
  pm_error_classification_is_safe "$classification" || return 64
  case $container_state in not_observed | command_not_started | running | exited | unavailable) ;; *) return 64 ;; esac
  SCRAPER_ELAPSED_SECONDS=$(( SECONDS - ${SCRAPER_OPERATION_STARTED_SECONDS:-SECONDS} ))
  SCRAPER_ORIGINAL_EXIT=$status
  SCRAPER_PRIMARY_CLASSIFICATION=$classification
  SCRAPER_CONTAINER_STATE_CATEGORY=$container_state
  PROBE_ERROR_CLASSIFICATION=$classification
}

pm_scraper_reject_result() {
  local classification=${1:?classification required}
  pm_scraper_finish_operation 65 "$classification" exited || return
  return 65
}

pm_scraper_envelope_shape_valid() {
  local path=${1:?result path required}
  jq -se '
    length == 1 and .[0] as $v |
    ($v | type) == "object" and
    ($v | keys | sort) == ([
      "schemaVersion","status","selectedMode","failureStage","failureCode",
      "productDependencySource","moduleLoadCompleted","liveCaptureExportType","transportInterceptorExportType",
      "instrumentationInstalled","instrumentationRestored","disabledFactoryCalled","disabledAdapterCreated",
      "capturePhysicalFrameCallable","getCaptureHealthCallable","interceptorConstructed",
      "frameDispatchAttempted","frameDispatchCompleted","healthReadCompleted","detachCompleted","resultSerialized",
      "suppressedLogCount","suppressedWarnCount","suppressedErrorCount",
      "adapterEnabled","frameHandled","spoolPathCreated","spoolPendingCount",
      "timerAttemptCount","networkAttemptCount","databaseAttemptCount","activeAdapterFactoryCalled",
      "drainCreated","chromiumLaunched","maxContacted","providerAction",
      "actualTransportHook","framesCaptured","identicalFrames","pendingBefore","pendingAfter",
      "acknowledged","retryCount","lostBeforeSpoolCount"
    ] | sort) and
    $v.schemaVersion == 1 and ($v.status == "PASS" or $v.status == "FAIL") and
    (["default-off","capture-only","retry-only","capture-and-drain","drain-only","NOT_SELECTED"] | index($v.selectedMode)) != null and
    (["NONE","MODE_SELECTION","INSTRUMENTATION_INSTALL","PRODUCT_DEPENDENCY_LOAD",
      "DISABLED_ADAPTER_CREATE","DISABLED_ADAPTER_CONTRACT","INTERCEPTOR_CONSTRUCT",
      "FRAME_DISPATCH","HEALTH_READ","INTERCEPTOR_DETACH","ACTIVE_ADAPTER_CREATE",
      "ACTIVE_EXECUTION","INSTRUMENTATION_RESTORE","RESULT_SERIALIZATION","INTERNAL"] | index($v.failureStage)) != null and
    (["NONE","MODE_MISSING","MODE_INVALID","INSTRUMENTATION_INSTALL_FAILED",
      "LIVE_CAPTURE_MODULE_MISSING","TRANSPORT_INTERCEPTOR_MODULE_MISSING","PRODUCT_DEPENDENCY_LOAD_FAILED",
      "LIVE_CAPTURE_EXPORT_MISSING","TRANSPORT_INTERCEPTOR_EXPORT_MISSING","DISABLED_ADAPTER_CREATE_FAILED",
      "CAPTURE_PHYSICAL_FRAME_MISSING","GET_CAPTURE_HEALTH_MISSING","INTERCEPTOR_CONSTRUCT_FAILED",
      "HANDLE_FRAME_MISSING","INTERCEPTOR_HEALTH_MISSING","DETACH_MISSING","FRAME_DISPATCH_FAILED",
      "HEALTH_READ_FAILED","DETACH_FAILED","ACTIVE_ADAPTER_CREATE_FAILED","ACTIVE_ADAPTER_INVALID",
      "ACTIVE_EXECUTION_FAILED","INSTRUMENTATION_RESTORE_FAILED","CONSOLE_RESTORE_FAILED",
      "RESULT_SERIALIZATION_FAILED","INTERNAL_FAILURE"] | index($v.failureCode)) != null and
    ([ $v.moduleLoadCompleted,$v.instrumentationInstalled,$v.instrumentationRestored,$v.disabledFactoryCalled,
       $v.disabledAdapterCreated,$v.capturePhysicalFrameCallable,$v.getCaptureHealthCallable,$v.interceptorConstructed,
       $v.frameDispatchAttempted,$v.frameDispatchCompleted,$v.healthReadCompleted,$v.detachCompleted,$v.resultSerialized,
       $v.adapterEnabled,$v.frameHandled,$v.spoolPathCreated,$v.activeAdapterFactoryCalled,$v.drainCreated,
       $v.chromiumLaunched,$v.maxContacted,$v.providerAction,$v.actualTransportHook ] | all(type == "boolean")) and
    ([ $v.suppressedLogCount,$v.suppressedWarnCount,$v.suppressedErrorCount,$v.spoolPendingCount,
       $v.timerAttemptCount,$v.networkAttemptCount,$v.databaseAttemptCount,$v.framesCaptured,$v.identicalFrames,
       $v.pendingBefore,$v.pendingAfter,$v.acknowledged,$v.retryCount,$v.lostBeforeSpoolCount ] |
       all(type == "number" and isfinite and floor == . and . >= 0)) and
    $v.resultSerialized == true
  ' "$path" >/dev/null 2>&1
}

pm_scraper_classification_for_failure_code() {
  case ${1:-} in
    MODE_MISSING) printf SCRAPER_DEFAULT_OFF_MODE_MISSING ;;
    MODE_INVALID) printf SCRAPER_DEFAULT_OFF_MODE_MISMATCH ;;
    INSTRUMENTATION_INSTALL_FAILED) printf SCRAPER_DEFAULT_OFF_INSTRUMENTATION_FAILED ;;
    LIVE_CAPTURE_MODULE_MISSING | TRANSPORT_INTERCEPTOR_MODULE_MISSING | PRODUCT_DEPENDENCY_LOAD_FAILED | \
      LIVE_CAPTURE_EXPORT_MISSING | TRANSPORT_INTERCEPTOR_EXPORT_MISSING) printf SCRAPER_DEFAULT_OFF_DEPENDENCY_LOAD_FAILED ;;
    DISABLED_ADAPTER_CREATE_FAILED) printf SCRAPER_DEFAULT_OFF_ADAPTER_CREATE_FAILED ;;
    CAPTURE_PHYSICAL_FRAME_MISSING | GET_CAPTURE_HEALTH_MISSING) printf SCRAPER_DEFAULT_OFF_ADAPTER_CONTRACT_FAILED ;;
    INTERCEPTOR_CONSTRUCT_FAILED | HANDLE_FRAME_MISSING | INTERCEPTOR_HEALTH_MISSING | DETACH_MISSING) \
      printf SCRAPER_DEFAULT_OFF_INTERCEPTOR_CONSTRUCT_FAILED ;;
    FRAME_DISPATCH_FAILED) printf SCRAPER_DEFAULT_OFF_FRAME_DISPATCH_FAILED ;;
    HEALTH_READ_FAILED) printf SCRAPER_DEFAULT_OFF_HEALTH_READ_FAILED ;;
    DETACH_FAILED) printf SCRAPER_DEFAULT_OFF_DETACH_FAILED ;;
    INSTRUMENTATION_RESTORE_FAILED | CONSOLE_RESTORE_FAILED) printf SCRAPER_DEFAULT_OFF_RESTORE_FAILED ;;
    RESULT_SERIALIZATION_FAILED) printf SCRAPER_DEFAULT_OFF_RESULT_SERIALIZATION_FAILED ;;
    *) printf SCRAPER_DEFAULT_OFF_HARNESS_EXITED ;;
  esac
}

pm_record_scraper_envelope_facts() {
  local path=${1:?result path required}
  SCRAPER_HARNESS_ENVELOPE_OBSERVED=true
  SCRAPER_HARNESS_STATUS=$(jq -r '.status' "$path")
  SCRAPER_HARNESS_SELECTED_MODE=$(jq -r '.selectedMode' "$path")
  SCRAPER_HARNESS_FAILURE_STAGE=$(jq -r '.failureStage' "$path")
  SCRAPER_HARNESS_FAILURE_CODE=$(jq -r '.failureCode' "$path")
  SCRAPER_HARNESS_MODULE_LOAD_COMPLETED=$(jq -r '.moduleLoadCompleted' "$path")
  SCRAPER_HARNESS_INSTRUMENTATION_INSTALLED=$(jq -r '.instrumentationInstalled' "$path")
  SCRAPER_HARNESS_INSTRUMENTATION_RESTORED=$(jq -r '.instrumentationRestored' "$path")
  SCRAPER_HARNESS_DISABLED_FACTORY_CALLED=$(jq -r '.disabledFactoryCalled' "$path")
  SCRAPER_HARNESS_DISABLED_ADAPTER_CREATED=$(jq -r '.disabledAdapterCreated' "$path")
  SCRAPER_HARNESS_FRAME_DISPATCH_ATTEMPTED=$(jq -r '.frameDispatchAttempted' "$path")
  SCRAPER_HARNESS_FRAME_DISPATCH_COMPLETED=$(jq -r '.frameDispatchCompleted' "$path")
  SCRAPER_HARNESS_HEALTH_READ_COMPLETED=$(jq -r '.healthReadCompleted' "$path")
  SCRAPER_HARNESS_DETACH_COMPLETED=$(jq -r '.detachCompleted' "$path")
  SCRAPER_HARNESS_RESULT_SERIALIZED=$(jq -r '.resultSerialized' "$path")
  SCRAPER_HARNESS_SUPPRESSED_LOG_COUNT=$(jq -r '.suppressedLogCount' "$path")
  SCRAPER_HARNESS_SUPPRESSED_WARN_COUNT=$(jq -r '.suppressedWarnCount' "$path")
  SCRAPER_HARNESS_SUPPRESSED_ERROR_COUNT=$(jq -r '.suppressedErrorCount' "$path")
}

pm_classify_scraper_failure_envelope() {
  local path=${1:?result path required} original_exit=${2:-1} code classification
  if [[ ! -s $path ]]; then classification=SCRAPER_DEFAULT_OFF_OUTPUT_MISSING
  elif ! pm_scraper_envelope_shape_valid "$path"; then classification=SCRAPER_DEFAULT_OFF_OUTPUT_MALFORMED
  elif ! jq -e 'select(.status=="FAIL")' "$path" >/dev/null 2>&1; then classification=SCRAPER_DEFAULT_OFF_OUTPUT_MALFORMED
  else
    pm_record_scraper_envelope_facts "$path"
    code=$(jq -r '.failureCode' "$path")
    classification=$(pm_scraper_classification_for_failure_code "$code")
  fi
  pm_scraper_finish_operation "$original_exit" "$classification" exited || return
  return "$original_exit"
}

pm_validate_scraper_default_off_result() {
  local path=${1:?result path required}
  pm_scraper_begin_operation SCRAPER_DEFAULT_OFF_RESULT_CHECK default_off_result_validation internal_validator jq exited || return
  pm_scraper_mark_started
  if [[ ! -s $path ]]; then pm_scraper_reject_result SCRAPER_DEFAULT_OFF_OUTPUT_MISSING; return; fi
  if ! pm_scraper_envelope_shape_valid "$path"; then
    pm_scraper_reject_result SCRAPER_DEFAULT_OFF_OUTPUT_MALFORMED; return
  fi
  pm_record_scraper_envelope_facts "$path"
  if ! jq -e '.status=="PASS" and .failureStage=="NONE" and .failureCode=="NONE"' "$path" >/dev/null 2>&1; then
    local failure_code failure_classification
    failure_code=$(jq -r '.failureCode' "$path")
    failure_classification=$(pm_scraper_classification_for_failure_code "$failure_code")
    pm_scraper_reject_result "$failure_classification"; return
  fi
  if ! jq -e '.selectedMode == "default-off"' "$path" >/dev/null 2>&1; then pm_scraper_reject_result SCRAPER_DEFAULT_OFF_MODE_MISMATCH; return; fi
  if ! jq -e '.productDependencySource == "PINNED_APP_ROOT" and .moduleLoadCompleted==true and
    .liveCaptureExportType=="function" and .transportInterceptorExportType=="function" and
    .instrumentationInstalled==true and .instrumentationRestored==true and
    .disabledFactoryCalled==true and .disabledAdapterCreated==true and
    .capturePhysicalFrameCallable==true and .getCaptureHealthCallable==true and
    .interceptorConstructed==true and .frameDispatchAttempted==true and .frameDispatchCompleted==true and
    .healthReadCompleted==true and .detachCompleted==true and .resultSerialized==true and
    .actualTransportHook==true' "$path" >/dev/null 2>&1; then
    pm_scraper_reject_result SCRAPER_DEFAULT_OFF_OUTPUT_MALFORMED; return
  fi
  if ! jq -e '.adapterEnabled == false' "$path" >/dev/null 2>&1; then pm_scraper_reject_result SCRAPER_DEFAULT_OFF_ENABLED_UNEXPECTED; return; fi
  if ! jq -e '.frameHandled == true' "$path" >/dev/null 2>&1; then pm_scraper_reject_result SCRAPER_DEFAULT_OFF_FRAME_NOT_HANDLED; return; fi
  if ! jq -e '.spoolPathCreated == false' "$path" >/dev/null 2>&1; then pm_scraper_reject_result SCRAPER_DEFAULT_OFF_SPOOL_CREATED; return; fi
  if ! jq -e '.spoolPendingCount == 0' "$path" >/dev/null 2>&1; then pm_scraper_reject_result SCRAPER_DEFAULT_OFF_PENDING_UNEXPECTED; return; fi
  if ! jq -e '.timerAttemptCount == 0' "$path" >/dev/null 2>&1; then pm_scraper_reject_result SCRAPER_DEFAULT_OFF_TIMER_ACTIVITY; return; fi
  if ! jq -e '.networkAttemptCount == 0' "$path" >/dev/null 2>&1; then pm_scraper_reject_result SCRAPER_DEFAULT_OFF_NETWORK_ACTIVITY; return; fi
  if ! jq -e '.databaseAttemptCount == 0' "$path" >/dev/null 2>&1; then pm_scraper_reject_result SCRAPER_DEFAULT_OFF_DATABASE_ACTIVITY; return; fi
  if ! jq -e '.activeAdapterFactoryCalled == false' "$path" >/dev/null 2>&1; then pm_scraper_reject_result SCRAPER_DEFAULT_OFF_ACTIVE_FACTORY_CALLED; return; fi
  if ! jq -e '.drainCreated == false' "$path" >/dev/null 2>&1; then pm_scraper_reject_result SCRAPER_DEFAULT_OFF_DRAIN_CREATED; return; fi
  if ! jq -e '.chromiumLaunched == false' "$path" >/dev/null 2>&1; then pm_scraper_reject_result SCRAPER_DEFAULT_OFF_CHROMIUM_ACTIVITY; return; fi
  if ! jq -e '.maxContacted == false' "$path" >/dev/null 2>&1; then pm_scraper_reject_result SCRAPER_DEFAULT_OFF_MAX_CONTACTED; return; fi
  if ! jq -e '.providerAction == false' "$path" >/dev/null 2>&1; then pm_scraper_reject_result SCRAPER_DEFAULT_OFF_PROVIDER_ACTION; return; fi
  pm_scraper_finish_operation 0 NONE exited
}

pm_scraper_runtime_envelope_shape_valid() {
  local path=${1:?result path required}
  jq -se '
    length==1 and .[0] as $v | ($v|type)=="object" and
    ($v|keys|sort)==(["schemaVersion","status","failureStage","failureCode","appRootCategory",
      "nodeVersionCategory","nodeMajor","runtimeUid","runtimeGid","moduleLoadCompleted","moduleFacts",
      "exportFacts","disabledAdapterFacts","interceptorFacts","suppressedLogCount","suppressedWarnCount",
      "suppressedErrorCount","sourceContentsCaptured","environmentCaptured","profileDataCaptured",
      "persistedMessageContentsCaptured","resultSerialized"]|sort) and
    $v.schemaVersion==1 and ($v.status=="PASS" or $v.status=="FAIL") and
    $v.appRootCategory=="PINNED_APP_ROOT" and
    ($v.moduleFacts|keys|sort)==(["liveCaptureAdapter","authenticatedCaptureDrain","transportInterceptor"]|sort) and
    ([ $v.moduleFacts.liveCaptureAdapter,$v.moduleFacts.authenticatedCaptureDrain,$v.moduleFacts.transportInterceptor ] |
      all((keys|sort)==(["regularFile","symlink","sha256"]|sort))) and
    ($v.exportFacts|keys|sort)==(["createLiveCaptureAdapterFromEnvironment","TransportInterceptor"]|sort) and
    ($v.disabledAdapterFacts|keys|sort)==(["objectCreated","capturePhysicalFrameCallable","getCaptureHealthCallable","enabledFalse"]|sort) and
    ($v.interceptorFacts|keys|sort)==(["constructed","handleFrameCallable","getCaptureHealthCallable","detachCallable","detached"]|sort) and
    (["NONE","SOURCE_METADATA","MODULE_LOAD","EXPORT_CONTRACT","DISABLED_ADAPTER_CONTRACT","INTERCEPTOR_CONTRACT","DETACH","RESULT_SERIALIZATION","INTERNAL"] | index($v.failureStage)) != null and
    (["NONE","RUNTIME_MODULE_MISSING","RUNTIME_MODULE_METADATA_FAILED","RUNTIME_MODULE_SYMLINK","RUNTIME_MODULE_NOT_REGULAR",
      "RUNTIME_MODULE_LOAD_FAILED","RUNTIME_EXPORT_MISSING","RUNTIME_DISABLED_ADAPTER_CREATE_FAILED",
      "RUNTIME_DISABLED_ADAPTER_INVALID","RUNTIME_DISABLED_ADAPTER_HEALTH_FAILED","RUNTIME_DISABLED_ADAPTER_ENABLED",
      "RUNTIME_INTERCEPTOR_CONSTRUCT_FAILED","RUNTIME_INTERCEPTOR_INVALID","RUNTIME_INTERCEPTOR_DETACH_FAILED",
      "RUNTIME_CONSOLE_RESTORE_FAILED","RUNTIME_RESULT_SERIALIZATION_FAILED","RUNTIME_INTERNAL_FAILURE"] | index($v.failureCode)) != null and
    ([ $v.moduleLoadCompleted,$v.disabledAdapterFacts.objectCreated,$v.disabledAdapterFacts.capturePhysicalFrameCallable,
       $v.disabledAdapterFacts.getCaptureHealthCallable,$v.disabledAdapterFacts.enabledFalse,
       $v.interceptorFacts.constructed,$v.interceptorFacts.handleFrameCallable,$v.interceptorFacts.getCaptureHealthCallable,
       $v.interceptorFacts.detachCallable,$v.interceptorFacts.detached,$v.sourceContentsCaptured,$v.environmentCaptured,
       $v.profileDataCaptured,$v.persistedMessageContentsCaptured,$v.resultSerialized ] | all(type=="boolean")) and
    ([ $v.nodeMajor,$v.runtimeUid,$v.runtimeGid,$v.suppressedLogCount,$v.suppressedWarnCount,$v.suppressedErrorCount ] |
       all(type=="number" and isfinite and floor==.)) and
    $v.resultSerialized==true and $v.sourceContentsCaptured==false and $v.environmentCaptured==false and
    $v.profileDataCaptured==false and $v.persistedMessageContentsCaptured==false
  ' "$path" >/dev/null 2>&1
}

pm_record_scraper_runtime_facts() {
  local path=${1:?result path required}
  SCRAPER_RUNTIME_ENVELOPE_OBSERVED=true
  SCRAPER_RUNTIME_STATUS=$(jq -r '.status' "$path")
  SCRAPER_RUNTIME_FAILURE_STAGE=$(jq -r '.failureStage' "$path")
  SCRAPER_RUNTIME_FAILURE_CODE=$(jq -r '.failureCode' "$path")
  SCRAPER_RUNTIME_NODE_CATEGORY=$(jq -r '.nodeVersionCategory' "$path")
  SCRAPER_RUNTIME_NODE_MAJOR=$(jq -r '.nodeMajor' "$path")
  SCRAPER_RUNTIME_UID=$(jq -r '.runtimeUid' "$path")
  SCRAPER_RUNTIME_GID=$(jq -r '.runtimeGid' "$path")
  SCRAPER_RUNTIME_LIVE_SHA256=$(jq -r '.moduleFacts.liveCaptureAdapter.sha256' "$path")
  SCRAPER_RUNTIME_DRAIN_SHA256=$(jq -r '.moduleFacts.authenticatedCaptureDrain.sha256' "$path")
  SCRAPER_RUNTIME_TRANSPORT_SHA256=$(jq -r '.moduleFacts.transportInterceptor.sha256' "$path")
  SCRAPER_RUNTIME_LIVE_EXPORT_TYPE=$(jq -r '.exportFacts.createLiveCaptureAdapterFromEnvironment' "$path")
  SCRAPER_RUNTIME_TRANSPORT_EXPORT_TYPE=$(jq -r '.exportFacts.TransportInterceptor' "$path")
  SCRAPER_RUNTIME_DISABLED_ADAPTER_VALID=$(jq -r '.disabledAdapterFacts.objectCreated and .disabledAdapterFacts.capturePhysicalFrameCallable and .disabledAdapterFacts.getCaptureHealthCallable and .disabledAdapterFacts.enabledFalse' "$path")
  SCRAPER_RUNTIME_INTERCEPTOR_VALID=$(jq -r '.interceptorFacts.constructed and .interceptorFacts.handleFrameCallable and .interceptorFacts.getCaptureHealthCallable and .interceptorFacts.detachCallable and .interceptorFacts.detached' "$path")
}

pm_validate_scraper_runtime_contract() {
  local path=${1:?result path required} runner_exit=${2:-0} revision=${3:?revision required}
  local expected_live=${4:?live SHA required} expected_drain=${5:?drain SHA required} expected_transport=${6:?transport SHA required}
  local code classification check_id substep rejection_exit=$runner_exit
  (( rejection_exit != 0 )) || rejection_exit=65
  pm_scraper_begin_operation SCRAPER_RUNTIME_SOURCE_CHECK runtime_source internal_validator jq exited || return
  pm_scraper_mark_started
  if [[ ! -s $path ]]; then pm_scraper_finish_operation "$rejection_exit" SCRAPER_RUNTIME_OUTPUT_MISSING exited; return "$rejection_exit"; fi
  if ! pm_scraper_runtime_envelope_shape_valid "$path"; then
    pm_scraper_finish_operation "$rejection_exit" SCRAPER_RUNTIME_OUTPUT_MALFORMED exited; return "$rejection_exit"
  fi
  pm_record_scraper_runtime_facts "$path"
  if [[ $revision != 33eb40b87f77eee16fbf4ccd06a667ea4ce51e5a ]]; then
    pm_scraper_finish_operation 65 SCRAPER_RUNTIME_SOURCE_BINDING_MISMATCH exited; return 65
  fi
  if ! jq -e --arg live "$expected_live" --arg drain "$expected_drain" --arg transport "$expected_transport" '
      .moduleFacts.liveCaptureAdapter.regularFile==true and .moduleFacts.liveCaptureAdapter.symlink==false and
      .moduleFacts.authenticatedCaptureDrain.regularFile==true and .moduleFacts.authenticatedCaptureDrain.symlink==false and
      .moduleFacts.transportInterceptor.regularFile==true and .moduleFacts.transportInterceptor.symlink==false and
      .moduleFacts.liveCaptureAdapter.sha256==$live and .moduleFacts.authenticatedCaptureDrain.sha256==$drain and
      .moduleFacts.transportInterceptor.sha256==$transport' "$path" >/dev/null 2>&1; then
    if jq -e '[.moduleFacts[]?.symlink]|any(.==true)' "$path" >/dev/null 2>&1; then classification=SCRAPER_RUNTIME_MODULE_SYMLINK
    elif jq -e '[.moduleFacts[]?.regularFile]|any(.==false)' "$path" >/dev/null 2>&1; then classification=SCRAPER_RUNTIME_MODULE_MISSING
    else classification=SCRAPER_RUNTIME_SOURCE_BINDING_MISMATCH
    fi
    pm_scraper_finish_operation 65 "$classification" exited; return 65
  fi
  if [[ $runner_exit -ne 0 || $(jq -r '.status' "$path") != PASS ]]; then
    code=$(jq -r '.failureCode' "$path")
    case $code in
      RUNTIME_MODULE_MISSING | RUNTIME_MODULE_NOT_REGULAR | RUNTIME_MODULE_METADATA_FAILED | RUNTIME_MODULE_LOAD_FAILED) classification=SCRAPER_RUNTIME_MODULE_MISSING; check_id=SCRAPER_RUNTIME_SOURCE_CHECK; substep=runtime_source ;;
      RUNTIME_MODULE_SYMLINK) classification=SCRAPER_RUNTIME_MODULE_SYMLINK; check_id=SCRAPER_RUNTIME_SOURCE_CHECK; substep=runtime_source ;;
      RUNTIME_EXPORT_MISSING) classification=SCRAPER_RUNTIME_EXPORT_MISSING; check_id=SCRAPER_RUNTIME_EXPORT_CHECK; substep=runtime_exports ;;
      RUNTIME_DISABLED_ADAPTER_CREATE_FAILED | RUNTIME_DISABLED_ADAPTER_INVALID | RUNTIME_DISABLED_ADAPTER_HEALTH_FAILED | RUNTIME_DISABLED_ADAPTER_ENABLED) classification=SCRAPER_RUNTIME_DISABLED_ADAPTER_INVALID; check_id=SCRAPER_RUNTIME_DISABLED_ADAPTER_CHECK; substep=runtime_disabled_adapter ;;
      RUNTIME_INTERCEPTOR_CONSTRUCT_FAILED | RUNTIME_INTERCEPTOR_INVALID | RUNTIME_INTERCEPTOR_DETACH_FAILED) classification=SCRAPER_RUNTIME_INTERCEPTOR_INVALID; check_id=SCRAPER_RUNTIME_INTERCEPTOR_CHECK; substep=runtime_interceptor ;;
      *) classification=SCRAPER_RUNTIME_OUTPUT_MALFORMED; check_id=SCRAPER_RUNTIME_SOURCE_CHECK; substep=runtime_source ;;
    esac
    pm_scraper_begin_operation "$check_id" "$substep" internal_validator jq exited || return
    pm_scraper_mark_started
    pm_scraper_finish_operation "$rejection_exit" "$classification" exited
    return "$rejection_exit"
  fi
  if ! jq -e '.nodeVersionCategory=="SUPPORTED_NODE_MAJOR" and .nodeMajor>=20 and .nodeMajor<=24' "$path" >/dev/null; then
    pm_scraper_finish_operation 65 SCRAPER_RUNTIME_NODE_UNSUPPORTED exited; return 65
  fi
  if ! jq -e '.runtimeUid==1001 and .runtimeGid==1001' "$path" >/dev/null; then
    pm_scraper_finish_operation 65 SCRAPER_RUNTIME_IDENTITY_MISMATCH exited; return 65
  fi
  pm_scraper_finish_operation 0 NONE exited
  pm_scraper_begin_operation SCRAPER_RUNTIME_EXPORT_CHECK runtime_exports internal_validator jq exited || return
  pm_scraper_mark_started
  if ! jq -e '.moduleLoadCompleted==true and .exportFacts.createLiveCaptureAdapterFromEnvironment=="function" and .exportFacts.TransportInterceptor=="function"' "$path" >/dev/null; then
    pm_scraper_finish_operation 65 SCRAPER_RUNTIME_EXPORT_MISSING exited; return 65
  fi
  pm_scraper_finish_operation 0 NONE exited
  pm_scraper_begin_operation SCRAPER_RUNTIME_DISABLED_ADAPTER_CHECK runtime_disabled_adapter internal_validator jq exited || return
  pm_scraper_mark_started
  if ! jq -e '.disabledAdapterFacts.objectCreated==true and .disabledAdapterFacts.capturePhysicalFrameCallable==true and .disabledAdapterFacts.getCaptureHealthCallable==true and .disabledAdapterFacts.enabledFalse==true' "$path" >/dev/null; then
    pm_scraper_finish_operation 65 SCRAPER_RUNTIME_DISABLED_ADAPTER_INVALID exited; return 65
  fi
  pm_scraper_finish_operation 0 NONE exited
  pm_scraper_begin_operation SCRAPER_RUNTIME_INTERCEPTOR_CHECK runtime_interceptor internal_validator jq exited || return
  pm_scraper_mark_started
  if ! jq -e '.interceptorFacts.constructed==true and .interceptorFacts.handleFrameCallable==true and .interceptorFacts.getCaptureHealthCallable==true and .interceptorFacts.detachCallable==true and .interceptorFacts.detached==true' "$path" >/dev/null; then
    pm_scraper_finish_operation 65 SCRAPER_RUNTIME_INTERCEPTOR_INVALID exited; return 65
  fi
  pm_scraper_finish_operation 0 NONE exited
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

pm_assert_production_git_baseline() {
  local observed_head=${1:-} observed_status=${2:-} expected_head=${3:-} expected_status=${4:-}
  if [[ ! $observed_head =~ ^[0-9a-f]{40}$ || ! $observed_status =~ ^[0-9a-f]{64}$ ||
        ! $expected_head =~ ^[0-9a-f]{40}$ || ! $expected_status =~ ^[0-9a-f]{64}$ ||
        $observed_head != "$expected_head" || $observed_status != "$expected_status" ]]; then
    PROBE_ERROR_CLASSIFICATION=PRODUCTION_GIT_BASELINE_MISMATCH
    return 67
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
    .postgresStartup.status=="READY" and .postgresStartup.containerState=="running" and
    .postgresStartup.containerExitCode==0 and .postgresStartup.readinessAttempts>0 and
    .postgresStartup.readinessLastExit==0 and .postgresStartup.versionQueryAttempts>0 and
    .postgresStartup.versionLastExit==0 and .postgresStartup.versionMatched==true and
    .postgresStartup.expectedVersionText=="16.14" and .postgresStartup.expectedVersionNum==160014 and
    .postgresStartup.observedVersionNum==160014 and .postgresStartup.observedMajor==16 and
    .postgresStartup.observedMinor==14 and .postgresStartup.observedPatch==0 and
    .postgresStartup.versionClassification=="POSTGRES_VERSION_MATCHED" and
    (.postgresStartup.versionOutputCategory=="CANONICAL_NUMERIC" or
      .postgresStartup.versionOutputCategory=="WHITESPACE_NORMALIZED") and
    .postgresStartup.rawLogsCaptured==false and .postgresStartup.environmentValuesCaptured==false and
    .postgresStartup.credentialsCaptured==false and
    .restore.FULL_RESTORE_PROOF=="PASS" and .restore.objectCount==581 and
    .restore.requiredRelations==["_prisma_migrations","users","Contact","Chat"] and
    .restore.ledgerNameCount==46 and .restore.ledgerUniqueCount==46 and
    .restore.ledgerDuplicateCount==0 and .restore.ledgerInvalidFormatCount==1 and
    .restore.ledgerUnsafeNameCount==0 and
    .restore.ledgerNamingClassification=="RESTORE_LEDGER_HISTORICAL_NAME_ACCEPTED" and
    .restore.acceptedHistoricalNames==["0_init"] and
    .restore.ledgerNamesSha256=="d879288b3d8f4d38c1de8565987c231db32ddb322c20a6329519028d8b5a8114" and
    .restore.ledgerAttestationSha256=="3b77a5c161cbd9850ce3d45b38c2b0e5cc110d97b13f8b506e7723459766a4c3" and
    .restore.repositoryToLedgerCount==8 and .restore.ledgerToRepositoryCount==1 and
    .restore.representativeCounts.user.physicalRelation=="users" and
    .restore.representativeCounts.user.available==true and
    .migration.DISPOSABLE_MIGRATION_PROOF=="PASS" and .migration.beforeFinished==46 and
    .migration.afterFinished==54 and .migration.failed==0 and .migration.prismaDiffEmpty==false and
    .migration.prismaDiffStatus=="MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT" and
    .migration.prismaDiffEvidence.factsObserved==true and
    .migration.prismaDiffEvidence.rawByteCount>0 and .migration.prismaDiffEvidence.rawByteCount<=4096 and
    .migration.prismaDiffEvidence.sizeLimitBytes==4096 and
    .migration.prismaDiffEvidence.utf8Valid==true and
    .migration.prismaDiffEvidence.commentsBalanced==true and
    .migration.prismaDiffEvidence.quotesBalanced==true and
    .migration.prismaDiffEvidence.statementTerminationValid==true and
    (.migration.prismaDiffEvidence.transactionWrapperState=="ABSENT" or
      .migration.prismaDiffEvidence.transactionWrapperState=="VALID") and
    .migration.prismaDiffEvidence.factsFileCreated==true and
    .migration.prismaDiffEvidence.factsFileLoaded==true and
    .migration.prismaDiffEvidence.parserFailureStage=="NONE" and
    .migration.prismaDiffEvidence.parserFailureCode=="NONE" and
    .migration.prismaDiffEvidence.nonCommentStatementCount>=1 and
    (.migration.prismaDiffEvidence.alterTableCount==1 or .migration.prismaDiffEvidence.alterTableCount==2) and
    .migration.prismaDiffEvidence.affectedTableCount==1 and
    .migration.prismaDiffEvidence.expectedTablePresent==true and
    .migration.prismaDiffEvidence.submittedPhoneAddPresent==true and
    .migration.prismaDiffEvidence.submittedPhoneAtAddPresent==true and
    .migration.prismaDiffEvidence.unexpectedTablePresent==false and
    .migration.prismaDiffEvidence.unexpectedColumnPresent==false and
    .migration.prismaDiffEvidence.unexpectedOperationPresent==false and
    .migration.prismaDiffEvidence.defaultConstraintIndexPresent==false and
    .migration.prismaDiffEvidence.parserResult=="ACCEPTED" and
    (.migration.prismaDiffEvidence.normalizedSemanticSha256|test("^[0-9a-f]{64}$")) and
    .migration.prismaDiffEvidence.expectedSemanticMode=="LEGACY_TWO_COLUMN_DRIFT_EXPECTED" and
    .migration.prismaDiffEvidence.finalGateClassification=="MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT" and
    .migration.prismaDiffEvidence.rawDiffRetained==false and .migration.prismaDiffEvidence.rawSqlCaptured==false and
    .migration.acceptedLedgerOnlyMigrations==["20260717000000_add_driver_telegram_submitted_phone"] and
    .migration.postgresNetworkAlias.explicit==true and
    .migration.postgresNetworkAlias.databaseUrlHostBound==true and
    .migration.postgresNetworkAlias.observedNetworkCount==1 and
    .migration.postgresNetworkAlias.expectedNetworkPresent==true and
    .migration.postgresNetworkAlias.aliasArrayPresent==true and
    .migration.postgresNetworkAlias.expectedAliasPresent==true and
    .migration.postgresNetworkAlias.unexpectedNetworkPresent==false and
    .migration.postgresNetworkAlias.containerRunning==true and
    .migration.postgresNetworkAlias.rawInspectCaptured==false and
    .migration.postgresNetworkAlias.databaseUrlCaptured==false and
    .migration.postgresNetworkAlias.credentialsCaptured==false and
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
    .scraperRuntimeContract.verified==true and .scraperRuntimeContract.status=="PASS" and
    .scraperRuntimeContract.imageDigest=="sha256:abf4405f55ab1c84f319b00cdb8b561f76353001ba2543045fddb17dc6b46768" and
    .scraperRuntimeContract.expectedSourceCommit=="33eb40b87f77eee16fbf4ccd06a667ea4ce51e5a" and
    .scraperRuntimeContract.ociRevision=="33eb40b87f77eee16fbf4ccd06a667ea4ce51e5a" and
    .scraperRuntimeContract.nodeVersionCategory=="SUPPORTED_NODE_MAJOR" and
    .scraperRuntimeContract.nodeMajor>=20 and .scraperRuntimeContract.nodeMajor<=24 and
    .scraperRuntimeContract.runtimeUid==1001 and .scraperRuntimeContract.runtimeGid==1001 and
    .scraperRuntimeContract.moduleSha256.liveCaptureAdapter=="7b5a8c6b7b9d6020a52bef253c317f90eff070cfbe8ac98aed66381c6bc523a5" and
    .scraperRuntimeContract.moduleSha256.authenticatedCaptureDrain=="1bc464fc8eaf6d9111a6a4ba7eda3a4f4b4fdd63d677f7e620720e9f17889b37" and
    .scraperRuntimeContract.moduleSha256.transportInterceptor=="35c979f12d67447d176bac3641fc38eb75fa6a1adc0633e19171a6512e7192f7" and
    .scraperRuntimeContract.exportTypes.createLiveCaptureAdapterFromEnvironment=="function" and
    .scraperRuntimeContract.exportTypes.TransportInterceptor=="function" and
    .scraperRuntimeContract.disabledAdapterValid==true and .scraperRuntimeContract.interceptorValid==true and
    .scraperRuntimeContract.sourceContentsCaptured==false and
    .scraperRuntimeContract.environmentValuesCaptured==false and
    .scraperRuntimeContract.profileDataCaptured==false and
    .scraperRuntimeContract.persistedMessageContentsCaptured==false and
    .e2e.frames==1000 and .e2e.identicalFrames==100 and .e2e.captureLoss==0 and
    .e2e.accidentalDuplicateRawRows==0 and .e2e.wrongAccount==0 and .e2e.criticalSemanticRegressions==0 and
    .cleanup.containersRemaining==0 and .cleanup.networksRemaining==0 and
    .cleanup.volumesRemaining==0 and .cleanup.tempFilesRemaining==0 and
    .productionImmutability.before.productionHead=="e6a0a833fbb756216b058bfe326f9f9c77c4cc6d" and
    .productionImmutability.after.productionHead=="e6a0a833fbb756216b058bfe326f9f9c77c4cc6d" and
    .productionImmutability.before.productionStatusV2RawSha256=="2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b" and
    .productionImmutability.after.productionStatusV2RawSha256=="2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b" and
    .productionImmutability.before.acceptedProductionGitBaseline==true and
    .productionImmutability.after.acceptedProductionGitBaseline==true and
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
