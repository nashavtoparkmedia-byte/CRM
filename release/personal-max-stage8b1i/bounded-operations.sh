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
      GATEWAY_ACTIVE_READINESS_FAILED | SCRAPER_DEFAULT_OFF_FAILED | SPOOL_INITIALIZATION_FAILED | \
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
