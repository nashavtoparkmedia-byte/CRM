#!/usr/bin/env bash

# Sourced only after checksum verification by create-production-backup.sh.
# Diagnostics are deliberately bounded. Never record the failed command,
# arguments, stderr, SQL, environment values, database names, or file contents.

personal_max_backup_phase_is_safe() {
  case ${1:-} in
    bootstrap_complete | source_report_validation | free_space_gate | container_discovery | \
      production_snapshot_before | backup_directory | migration_ledger_validation | database_dump | dump_verification | \
      config_archive | production_snapshot_after | immutability_comparison | metadata_render | \
      report_handoff | completed)
      return 0
      ;;
    *) return 1 ;;
  esac
}

personal_max_backup_command_class_is_safe() {
  case ${1:-} in
    filesystem_metadata | report_validation | docker_ps | docker_inspect | docker_exec_read | migration_ledger_read | \
      pg_dump_read | pg_restore_list | config_archive | metadata_render | report_handoff | unknown)
      return 0
      ;;
    *) return 1 ;;
  esac
}

personal_max_backup_error_class_is_safe() {
  case ${1:-} in
    UNEXPECTED_COMMAND_FAILURE | SOURCE_REPORT_INVALID | FREE_SPACE_GATE_FAILED | \
      DOCKER_SERVER_UNAVAILABLE | SERVICE_CARDINALITY_CONFLICT | LABEL_MISMATCH | \
      PRODUCTION_SNAPSHOT_FAILED | BACKUP_PATH_UNSAFE | MIGRATION_LEDGER_UNREADABLE | DATABASE_DUMP_FAILED | \
      DUMP_VERIFICATION_FAILED | CONFIG_ARCHIVE_FAILED | PRODUCTION_DRIFT_DETECTED | \
      METADATA_RENDER_FAILED | REPORT_HANDOFF_FAILED)
      return 0
      ;;
    *) return 1 ;;
  esac
}

personal_max_backup_failure_fallback() {
  local reason=${1:-FAILURE_REPORT_CREATION_FAILED}
  local original_exit=${2:-1}
  [[ $original_exit =~ ^[1-9][0-9]*$ && $original_exit -le 255 ]] || original_exit=1
  if [[ -n ${PM_FAILURE_TMP:-} && ( -e ${PM_FAILURE_TMP:-} || -L ${PM_FAILURE_TMP:-} ) ]]; then
    rm -f -- "$PM_FAILURE_TMP" >/dev/null 2>&1 || true
  fi
  if [[ -n ${PM_METADATA_TMP:-} && ( -e ${PM_METADATA_TMP:-} || -L ${PM_METADATA_TMP:-} ) ]]; then
    rm -f -- "$PM_METADATA_TMP" >/dev/null 2>&1 || true
  fi
  printf 'BACKUP_FAILED\nBACKUP_PHASE=%s\nBACKUP_SAFE_COMMAND_CLASS=%s\nBACKUP_EXIT_CODE=%s\n%s\n' \
    "${BACKUP_PHASE:-bootstrap_complete}" "${BACKUP_SAFE_COMMAND_CLASS:-unknown}" \
    "$original_exit" "$reason" >&2
  trap - EXIT
  exit "$original_exit"
}

personal_max_backup_handle_failure() {
  local original_exit=${1:-1}
  local source_line=${2:-0}
  local generated_at safe_phase safe_class safe_error backup_directory_created
  local dump_started dump_completed structural_validation_completed config_archive_completed
  local permissions report_identity final_identity report_sha readable_status writable_status

  [[ $original_exit =~ ^[1-9][0-9]*$ && $original_exit -le 255 ]] || original_exit=1
  [[ $source_line =~ ^[0-9]+$ ]] || source_line=0
  if [[ ${PM_FAILURE_HANDLER_ACTIVE:-false} == true ]]; then
    personal_max_backup_failure_fallback FAILURE_HANDLER_REENTRY "$original_exit"
  fi
  PM_FAILURE_HANDLER_ACTIVE=true
  trap - ERR
  set +e

  safe_phase=${BACKUP_PHASE:-bootstrap_complete}
  personal_max_backup_phase_is_safe "$safe_phase" || safe_phase=bootstrap_complete
  safe_class=${BACKUP_SAFE_COMMAND_CLASS:-unknown}
  personal_max_backup_command_class_is_safe "$safe_class" || safe_class=unknown
  safe_error=${BACKUP_ERROR_CLASSIFICATION:-UNEXPECTED_COMMAND_FAILURE}
  personal_max_backup_error_class_is_safe "$safe_error" || safe_error=UNEXPECTED_COMMAND_FAILURE
  BACKUP_PHASE=$safe_phase
  BACKUP_SAFE_COMMAND_CLASS=$safe_class

  generated_at=$(date -u +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)
  [[ $generated_at =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || \
    generated_at='1970-01-01T00:00:00Z'
  backup_directory_created=false
  dump_started=false
  dump_completed=false
  structural_validation_completed=false
  config_archive_completed=false
  [[ ${PM_BACKUP_DIRECTORY_CREATED:-false} == true ]] && backup_directory_created=true
  [[ ${PM_DUMP_STARTED:-false} == true ]] && dump_started=true
  [[ ${PM_DUMP_COMPLETED:-false} == true ]] && dump_completed=true
  [[ ${PM_STRUCTURAL_VALIDATION_COMPLETED:-false} == true ]] && structural_validation_completed=true
  [[ ${PM_CONFIG_ARCHIVE_COMPLETED:-false} == true ]] && config_archive_completed=true
  [[ ${PM_SCRIPT_SHA256:-} =~ ^[0-9a-f]{64}$ ]] || \
    personal_max_backup_failure_fallback FAILURE_REPORT_SCRIPT_SHA_UNSAFE "$original_exit"
  if [[ -e $PM_FAILURE_PATH || -L $PM_FAILURE_PATH ]]; then
    personal_max_backup_failure_fallback FAILURE_REPORT_PATH_UNSAFE "$original_exit"
  fi

  PM_FAILURE_TMP=$(mktemp "${PM_FAILURE_TMP_PREFIX}.XXXXXX") || \
    personal_max_backup_failure_fallback FAILURE_REPORT_TEMP_CREATE_FAILED "$original_exit"
  chmod 0600 "$PM_FAILURE_TMP" >/dev/null 2>&1 || \
    personal_max_backup_failure_fallback FAILURE_REPORT_TEMP_MODE_FAILED "$original_exit"
  printf '{\n  "schemaVersion": 1,\n  "mode": "PRODUCTION_BACKUP_FAILURE",\n  "generatedAt": "%s",\n  "scriptSha256": "%s",\n  "phase": "%s",\n  "safeCommandClass": "%s",\n  "safeErrorClassification": "%s",\n  "exitCode": %s,\n  "sourceLine": %s,\n  "successReportCreated": false,\n  "backupDirectoryCreated": %s,\n  "dumpStarted": %s,\n  "dumpCompleted": %s,\n  "structuralValidationCompleted": %s,\n  "configArchiveCompleted": %s,\n  "DockerMutation": false,\n  "DDL": false,\n  "DML": false,\n  "migration": false,\n  "restart": false,\n  "deploy": false,\n  "browserLaunched": false,\n  "maxContacted": false,\n  "providerAction": false,\n  "secretsPrinted": false,\n  "rawCommandCaptured": false,\n  "rawSqlCaptured": false,\n  "rawStderrCaptured": false,\n  "recommendedNextAction": "CODEX_REVIEW_BACKUP_FAILURE_REPORT"\n}\n' \
    "$generated_at" "$PM_SCRIPT_SHA256" "$safe_phase" "$safe_class" "$safe_error" \
    "$original_exit" "$source_line" "$backup_directory_created" "$dump_started" \
    "$dump_completed" "$structural_validation_completed" "$config_archive_completed" \
    >"$PM_FAILURE_TMP" || personal_max_backup_failure_fallback FAILURE_REPORT_RENDER_FAILED "$original_exit"

  chgrp "$PM_REPORT_GROUP" "$PM_FAILURE_TMP" >/dev/null 2>&1 || \
    personal_max_backup_failure_fallback FAILURE_REPORT_GROUP_FAILED "$original_exit"
  chmod 0640 "$PM_FAILURE_TMP" >/dev/null 2>&1 || \
    personal_max_backup_failure_fallback FAILURE_REPORT_MODE_FAILED "$original_exit"
  permissions=$(stat -Lc '%U:%G:%a' "$PM_FAILURE_TMP" 2>/dev/null)
  report_identity=$(stat -Lc '%d:%i' "$PM_FAILURE_TMP" 2>/dev/null)
  [[ -f $PM_FAILURE_TMP && ! -L $PM_FAILURE_TMP && \
    $permissions == "$PM_REPORT_OWNER:$PM_REPORT_GROUP:640" ]] || \
    personal_max_backup_failure_fallback FAILURE_REPORT_TEMP_HANDOFF_UNSAFE "$original_exit"
  mv --no-clobber --no-target-directory -- "$PM_FAILURE_TMP" "$PM_FAILURE_PATH" >/dev/null 2>&1 || \
    personal_max_backup_failure_fallback FAILURE_REPORT_MOVE_FAILED "$original_exit"
  PM_FAILURE_TMP=''
  final_identity=$(stat -Lc '%d:%i' "$PM_FAILURE_PATH" 2>/dev/null)
  permissions=$(stat -Lc '%U:%G:%a' "$PM_FAILURE_PATH" 2>/dev/null)
  [[ -f $PM_FAILURE_PATH && ! -L $PM_FAILURE_PATH && $final_identity == "$report_identity" && \
    $permissions == "$PM_REPORT_OWNER:$PM_REPORT_GROUP:640" ]] || \
    personal_max_backup_failure_fallback FAILURE_REPORT_FINAL_HANDOFF_UNSAFE "$original_exit"
  if [[ ${PM_VERIFY_PRINCIPAL_ACCESS:-true} == true ]]; then
    timeout 5 runuser -u "$PM_REPORT_READER" -- test -r "$PM_FAILURE_PATH" >/dev/null 2>&1
    readable_status=$?
    (( readable_status == 0 )) || \
      personal_max_backup_failure_fallback FAILURE_REPORT_READER_ACCESS_FAILED "$original_exit"
    timeout 5 runuser -u "$PM_REPORT_READER" -- test -w "$PM_FAILURE_PATH" >/dev/null 2>&1
    writable_status=$?
    (( writable_status != 0 )) || \
      personal_max_backup_failure_fallback FAILURE_REPORT_READER_WRITABLE "$original_exit"
  fi
  report_sha=$(sha256sum -- "$PM_FAILURE_PATH" 2>/dev/null | awk '{print $1}')
  [[ $report_sha =~ ^[0-9a-f]{64}$ ]] || \
    personal_max_backup_failure_fallback FAILURE_REPORT_CHECKSUM_FAILED "$original_exit"
  if [[ -n ${PM_METADATA_TMP:-} && ( -e ${PM_METADATA_TMP:-} || -L ${PM_METADATA_TMP:-} ) ]]; then
    rm -f -- "$PM_METADATA_TMP" >/dev/null 2>&1 || \
      personal_max_backup_failure_fallback METADATA_TEMP_CLEANUP_FAILED "$original_exit"
  fi
  PM_METADATA_TMP=''
  trap - EXIT
  printf 'BACKUP_FAILED\nBACKUP_PHASE=%s\nBACKUP_SAFE_COMMAND_CLASS=%s\nBACKUP_EXIT_CODE=%s\nFAILURE_REPORT_PATH=%s\nFAILURE_REPORT_SHA256=%s\nREPORT_OWNER=root\nREPORT_GROUP=codexbot\nREPORT_MODE=0640\nCODEXBOT_READABLE=YES\nCODEXBOT_WRITABLE=NO\n' \
    "$safe_phase" "$safe_class" "$original_exit" "$PM_FAILURE_PATH" "$report_sha"
  exit "$original_exit"
}
