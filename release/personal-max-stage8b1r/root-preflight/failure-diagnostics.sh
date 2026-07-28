#!/usr/bin/env bash

# This file is sourced only after its SHA-256 has been verified by the root
# preflight bootstrap. Keep diagnostics bounded: never record the failed
# command, its arguments, SQL, stderr, environment values, or content paths.

personal_max_phase_is_safe() {
  case ${1:-} in
    bootstrap_complete | docker_server_metadata | project_container_discovery_before | \
      production_service_snapshot_before | volume_snapshot_before | filesystem_snapshot_before | \
      host_metadata | service_inventory | scraper_discovery | scraper_process_metadata | \
      postgres_discovery | postgres_catalog_session | migration_ledger | raw_table_catalog | \
      activity_catalog | image_inventory | disk_budget | backup_metadata | \
      project_container_discovery_after | production_service_snapshot_after | \
      volume_snapshot_after | immutability_comparison | report_render | report_handoff | completed)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

personal_max_command_class_is_safe() {
  case ${1:-} in
    docker_ps | docker_inspect | docker_top | docker_info | docker_image_inspect | \
      docker_volume_ls | postgres_discovery | psql_catalog | jq_render | \
      filesystem_stat | report_handoff | unknown)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

personal_max_error_classification_is_safe() {
  case ${1:-} in
    UNEXPECTED_COMMAND_FAILURE | DOCKER_SERVER_UNAVAILABLE | DOCKER_METADATA_UNAVAILABLE | \
      SERVICE_CARDINALITY_CONFLICT | PROJECT_LABEL_MISMATCH | SERVICE_LABEL_MISMATCH | \
      POSTGRES_DISCOVERY_UNAVAILABLE | PSQL_UNAVAILABLE | PSQL_TIMEOUT | \
      PSQL_PERMISSION_DENIED | PSQL_MALFORMED_OUTPUT | JSON_RENDER_FAILED | \
      FILESYSTEM_METADATA_UNAVAILABLE | BACKUP_METADATA_UNAVAILABLE | \
      REPORT_HANDOFF_FAILED | PRODUCTION_DRIFT_DETECTED)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

personal_max_failure_fallback() {
  local reason=${1:-FAILURE_REPORT_CREATION_FAILED}
  local original_exit=${2:-1}

  [[ $original_exit =~ ^[1-9][0-9]*$ && $original_exit -le 255 ]] || original_exit=1
  if [[ -n ${PM_FAILURE_TMP:-} && ( -e ${PM_FAILURE_TMP:-} || -L ${PM_FAILURE_TMP:-} ) ]]; then
    rm -f -- "$PM_FAILURE_TMP" >/dev/null 2>&1 || true
  fi
  if [[ -n ${PM_SUCCESS_TMP:-} && ( -e ${PM_SUCCESS_TMP:-} || -L ${PM_SUCCESS_TMP:-} ) ]]; then
    rm -f -- "$PM_SUCCESS_TMP" >/dev/null 2>&1 || true
  fi
  printf 'PREFLIGHT_FAILED\nPREFLIGHT_PHASE=%s\nPREFLIGHT_SAFE_COMMAND_CLASS=%s\nPREFLIGHT_EXIT_CODE=%s\n%s\n' \
    "${PREFLIGHT_PHASE:-unknown}" "${PREFLIGHT_SAFE_COMMAND_CLASS:-unknown}" "$original_exit" "$reason" >&2
  trap - EXIT
  exit "$original_exit"
}

personal_max_handle_unexpected_failure() {
  local original_exit=${1:-1}
  local source_line=${2:-0}
  local generated_at success_result_created temporary_result_detected final_report_existed
  local docker_metadata_begun postgresql_session_begun
  local report_identity report_sha actual_identity actual_permissions
  local safe_phase safe_command_class safe_error_classification
  local json_status handoff_status readable_status writable_status

  [[ $original_exit =~ ^[1-9][0-9]*$ && $original_exit -le 255 ]] || original_exit=1
  [[ $source_line =~ ^[0-9]+$ ]] || source_line=0

  if [[ ${PM_FAILURE_HANDLER_ACTIVE:-false} == true ]]; then
    personal_max_failure_fallback FAILURE_HANDLER_REENTRY "$original_exit"
  fi
  PM_FAILURE_HANDLER_ACTIVE=true
  trap - ERR
  set +e

  safe_phase=${PREFLIGHT_PHASE:-unknown}
  personal_max_phase_is_safe "$safe_phase" || safe_phase=bootstrap_complete
  safe_command_class=${PREFLIGHT_SAFE_COMMAND_CLASS:-unknown}
  personal_max_command_class_is_safe "$safe_command_class" || safe_command_class=unknown
  safe_error_classification=${PREFLIGHT_ERROR_CLASSIFICATION:-UNEXPECTED_COMMAND_FAILURE}
  personal_max_error_classification_is_safe "$safe_error_classification" || safe_error_classification=UNEXPECTED_COMMAND_FAILURE
  PREFLIGHT_PHASE=$safe_phase
  PREFLIGHT_SAFE_COMMAND_CLASS=$safe_command_class

  generated_at=$(date -u +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)
  [[ $generated_at =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || generated_at='1970-01-01T00:00:00Z'
  success_result_created=false
  final_report_existed=false
  temporary_result_detected=false
  [[ -f $PM_SUCCESS_PATH && ! -L $PM_SUCCESS_PATH ]] && success_result_created=true
  [[ -e $PM_SUCCESS_PATH || -L $PM_SUCCESS_PATH ]] && final_report_existed=true
  [[ -n ${PM_SUCCESS_TMP:-} && ( -e ${PM_SUCCESS_TMP:-} || -L ${PM_SUCCESS_TMP:-} ) ]] && temporary_result_detected=true
  docker_metadata_begun=false
  postgresql_session_begun=false
  [[ ${PM_DOCKER_METADATA_BEGUN:-false} == true ]] && docker_metadata_begun=true
  [[ ${PM_POSTGRESQL_SESSION_BEGUN:-false} == true ]] && postgresql_session_begun=true
  [[ ${PM_SCRIPT_SHA256:-} =~ ^[0-9a-f]{64}$ ]] || personal_max_failure_fallback FAILURE_REPORT_SCRIPT_SHA_UNSAFE "$original_exit"

  if [[ -e $PM_FAILURE_PATH || -L $PM_FAILURE_PATH ]]; then
    personal_max_failure_fallback FAILURE_REPORT_PATH_UNSAFE "$original_exit"
  fi

  PM_FAILURE_TMP=$(mktemp "${PM_FAILURE_TMP_PREFIX}.XXXXXX")
  [[ -n $PM_FAILURE_TMP && -f $PM_FAILURE_TMP && ! -L $PM_FAILURE_TMP ]] || \
    personal_max_failure_fallback FAILURE_REPORT_TEMP_CREATE_FAILED "$original_exit"
  chmod 0600 "$PM_FAILURE_TMP" >/dev/null 2>&1
  [[ $(stat -Lc '%a' "$PM_FAILURE_TMP" 2>/dev/null) == 600 ]] || \
    personal_max_failure_fallback FAILURE_REPORT_TEMP_MODE_FAILED "$original_exit"

  printf '{\n  "schemaVersion": 1,\n  "mode": "READ_ONLY_PRODUCTION_PREFLIGHT_FAILURE",\n  "generatedAt": "%s",\n  "scriptSha256": "%s",\n  "phase": "%s",\n  "safeCommandClass": "%s",\n  "safeErrorClassification": "%s",\n  "exitCode": %s,\n  "sourceLine": %s,\n  "successResultPath": "%s",\n  "successResultCreated": %s,\n  "temporaryResultDetected": %s,\n  "dockerMetadataCollectionBegun": %s,\n  "postgresqlSessionBegun": %s,\n  "finalReportExisted": %s,\n  "DockerMutation": false,\n  "DDL": false,\n  "DML": false,\n  "migration": false,\n  "restart": false,\n  "deploy": false,\n  "browserLaunched": false,\n  "maxContacted": false,\n  "providerAction": false,\n  "secretsPrinted": false,\n  "recommendedNextAction": "CODEX_REVIEW_FAILURE_REPORT"\n}\n' \
    "$generated_at" "$PM_SCRIPT_SHA256" "$safe_phase" "$safe_command_class" \
    "$safe_error_classification" "$original_exit" "$source_line" "$PM_SUCCESS_PATH" \
    "$success_result_created" "$temporary_result_detected" "$docker_metadata_begun" \
    "$postgresql_session_begun" "$final_report_existed" >"$PM_FAILURE_TMP"
  json_status=$?
  (( json_status == 0 )) || personal_max_failure_fallback FAILURE_REPORT_RENDER_FAILED "$original_exit"

  chgrp "$PM_REPORT_GROUP" "$PM_FAILURE_TMP" >/dev/null 2>&1
  handoff_status=$?
  (( handoff_status == 0 )) || personal_max_failure_fallback FAILURE_REPORT_GROUP_FAILED "$original_exit"
  chmod 0640 "$PM_FAILURE_TMP" >/dev/null 2>&1
  handoff_status=$?
  (( handoff_status == 0 )) || personal_max_failure_fallback FAILURE_REPORT_MODE_FAILED "$original_exit"
  report_identity=$(stat -Lc '%d:%i' "$PM_FAILURE_TMP" 2>/dev/null)
  actual_permissions=$(stat -Lc '%U:%G:%a' "$PM_FAILURE_TMP" 2>/dev/null)
  [[ -f $PM_FAILURE_TMP && ! -L $PM_FAILURE_TMP && $actual_permissions == "$PM_REPORT_OWNER:$PM_REPORT_GROUP:640" ]] || \
    personal_max_failure_fallback FAILURE_REPORT_TEMP_HANDOFF_UNSAFE "$original_exit"

  mv --no-clobber --no-target-directory -- "$PM_FAILURE_TMP" "$PM_FAILURE_PATH" >/dev/null 2>&1
  handoff_status=$?
  (( handoff_status == 0 )) || personal_max_failure_fallback FAILURE_REPORT_MOVE_FAILED "$original_exit"
  if [[ -e $PM_FAILURE_TMP || -L $PM_FAILURE_TMP ]]; then
    personal_max_failure_fallback FAILURE_REPORT_PATH_UNSAFE "$original_exit"
  fi
  PM_FAILURE_TMP=''

  actual_identity=$(stat -Lc '%d:%i' "$PM_FAILURE_PATH" 2>/dev/null)
  actual_permissions=$(stat -Lc '%U:%G:%a' "$PM_FAILURE_PATH" 2>/dev/null)
  [[ -f $PM_FAILURE_PATH && ! -L $PM_FAILURE_PATH && $actual_identity == "$report_identity" && \
    $actual_permissions == "$PM_REPORT_OWNER:$PM_REPORT_GROUP:640" ]] || \
    personal_max_failure_fallback FAILURE_REPORT_FINAL_HANDOFF_UNSAFE "$original_exit"

  if [[ ${PM_VERIFY_PRINCIPAL_ACCESS:-true} == true ]]; then
    timeout 5 runuser -u "$PM_REPORT_READER" -- test -r "$PM_FAILURE_PATH" >/dev/null 2>&1
    readable_status=$?
    (( readable_status == 0 )) || personal_max_failure_fallback FAILURE_REPORT_READER_ACCESS_FAILED "$original_exit"
    timeout 5 runuser -u "$PM_REPORT_READER" -- test -w "$PM_FAILURE_PATH" >/dev/null 2>&1
    writable_status=$?
    (( writable_status != 0 )) || personal_max_failure_fallback FAILURE_REPORT_READER_WRITEABLE "$original_exit"
  fi

  report_sha=$(sha256sum -- "$PM_FAILURE_PATH" 2>/dev/null | awk '{print $1}')
  [[ $report_sha =~ ^[0-9a-f]{64}$ ]] || personal_max_failure_fallback FAILURE_REPORT_CHECKSUM_FAILED "$original_exit"

  if [[ -n ${PM_SUCCESS_TMP:-} && ( -e ${PM_SUCCESS_TMP:-} || -L ${PM_SUCCESS_TMP:-} ) ]]; then
    rm -f -- "$PM_SUCCESS_TMP" >/dev/null 2>&1 || personal_max_failure_fallback SUCCESS_TEMP_CLEANUP_FAILED "$original_exit"
  fi
  PM_SUCCESS_TMP=''
  trap - EXIT
  printf 'PREFLIGHT_FAILED\nPREFLIGHT_PHASE=%s\nPREFLIGHT_SAFE_COMMAND_CLASS=%s\nPREFLIGHT_EXIT_CODE=%s\nFAILURE_REPORT_PATH=%s\nFAILURE_REPORT_SHA256=%s\nREPORT_OWNER=%s\nREPORT_GROUP=%s\nREPORT_MODE=0640\nCODEXBOT_READABLE=YES\nCODEXBOT_WRITABLE=NO\n' \
    "$safe_phase" "$safe_command_class" "$original_exit" "$PM_FAILURE_PATH" "$report_sha" \
    "$PM_REPORT_OWNER" "$PM_REPORT_GROUP"
  exit "$original_exit"
}
