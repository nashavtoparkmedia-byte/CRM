#!/usr/bin/env bash

# Sourced only after package checksum validation. This helper never records a
# failed command, arguments, SQL, stderr, environment values, or data content.

personal_max_stage8b1i_safe_phase() {
  case ${1:-} in
    bootstrap_complete | source_binding | storage_gate | production_snapshot_before | image_acquisition | \
      image_verification | disposable_topology | postgresql_start | backup_restore | restore_verification | \
      migration_preflight | disposable_migration | migration_verification | gateway_negative | gateway_dormant | \
      gateway_active | scraper_default_off | e2e_outage | e2e_recovery | e2e_verification | \
      production_snapshot_after | cleanup | report_render | report_handoff | completed) return 0 ;;
    *) return 1 ;;
  esac
}

personal_max_stage8b1i_safe_class() {
  case ${1:-} in
    package_validation | filesystem_metadata | docker_metadata | docker_pull | docker_disposable | \
      backup_validation | disposable_postgresql | disposable_migration | synthetic_http | synthetic_harness | \
      cleanup | report_render | report_handoff | unknown) return 0 ;;
    *) return 1 ;;
  esac
}

personal_max_stage8b1i_render_failure() {
  local original_exit=${1:-1} source_line=${2:-0} cleanup_ok=${3:-false}
  local safe_phase safe_class generated temporary identity final_identity permissions report_sha
  [[ $original_exit =~ ^[1-9][0-9]*$ && $original_exit -le 255 ]] || original_exit=1
  [[ $source_line =~ ^[0-9]+$ ]] || source_line=0
  safe_phase=${PROBE_PHASE:-bootstrap_complete}
  personal_max_stage8b1i_safe_phase "$safe_phase" || safe_phase=bootstrap_complete
  safe_class=${PROBE_SAFE_COMMAND_CLASS:-unknown}
  personal_max_stage8b1i_safe_class "$safe_class" || safe_class=unknown
  [[ $cleanup_ok == true ]] || cleanup_ok=false
  generated=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

  if [[ -e $PM_FAILURE_PATH || -L $PM_FAILURE_PATH ]]; then
    printf 'ISOLATED_PROBE_FAILED\nPHASE=%s\nEXIT_CODE=%s\nFAILURE_REPORT_PATH_UNSAFE\n' "$safe_phase" "$original_exit" >&2
    return "$original_exit"
  fi
  temporary=$(mktemp /var/tmp/personal-max-stage8b1i-isolated-release-proof.failure.tmp.XXXXXX)
  chmod 0600 "$temporary"
  jq -n \
    --arg generatedAt "$generated" --arg scriptSha256 "$PM_SCRIPT_SHA256" \
    --arg phase "$safe_phase" --arg safeCommandClass "$safe_class" \
    --argjson exitCode "$original_exit" --argjson sourceLine "$source_line" \
    --argjson cleanupCompleted "$cleanup_ok" \
    '{schemaVersion:1,mode:"ISOLATED_RELEASE_PROOF_FAILURE",generatedAt:$generatedAt,
      script:{sha256:$scriptSha256,checksumBound:true},phase:$phase,safeCommandClass:$safeCommandClass,
      exitCode:$exitCode,sourceLine:$sourceLine,cleanup:{completed:$cleanupCompleted},
      diagnostics:{rawCommandCaptured:false,rawSqlCaptured:false,rawStderrCaptured:false,
        environmentValuesCaptured:false,credentialsCaptured:false,messageDataCaptured:false,providerPayloadCaptured:false},
      safety:{productionDDL:false,productionDML:false,productionMigration:false,restart:false,deploy:false,
        browserLaunched:false,maxContacted:false,providerAction:false},
      recommendedNextAction:"CODEX_REVIEW_ISOLATED_FAILURE_REPORT"}' >"$temporary"
  chgrp codexbot "$temporary"
  chmod 0640 "$temporary"
  permissions=$(stat -Lc '%U:%G:%a' "$temporary")
  [[ -f $temporary && ! -L $temporary && $permissions == root:codexbot:640 ]]
  identity=$(stat -Lc '%d:%i' "$temporary")
  mv --no-clobber --no-target-directory -- "$temporary" "$PM_FAILURE_PATH"
  final_identity=$(stat -Lc '%d:%i' "$PM_FAILURE_PATH")
  [[ $identity == "$final_identity" ]]
  report_sha=$(sha256sum -- "$PM_FAILURE_PATH" | awk '{print $1}')
  printf 'ISOLATED_PROBE_FAILED\nPHASE=%s\nSAFE_COMMAND_CLASS=%s\nEXIT_CODE=%s\nFAILURE_REPORT_PATH=%s\nFAILURE_REPORT_SHA256=%s\nREPORT_OWNER=root\nREPORT_GROUP=codexbot\nREPORT_MODE=0640\n' \
    "$safe_phase" "$safe_class" "$original_exit" "$PM_FAILURE_PATH" "$report_sha"
  return "$original_exit"
}
