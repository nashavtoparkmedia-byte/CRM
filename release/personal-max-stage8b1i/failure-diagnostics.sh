#!/usr/bin/env bash

# Sourced only after package checksum validation. This helper never records a
# failed command, arguments, SQL, stderr, environment values, or data content.

personal_max_stage8b1i_safe_phase() {
  case ${1:-} in
    bootstrap_complete | source_binding | storage_gate | production_snapshot_before | image_acquisition | \
      image_verification | post_pull_storage_gate | disposable_topology | postgresql_start | backup_restore | restore_verification | \
      migration_preflight | disposable_migration | migration_verification | gateway_negative | gateway_dormant | \
      gateway_active | scraper_default_off | e2e_outage | e2e_recovery | e2e_verification | \
      production_snapshot_after | cleanup | final_storage_gate | report_render | report_validation | report_handoff | completed) return 0 ;;
    *) return 1 ;;
  esac
}

personal_max_stage8b1i_safe_error() {
  case ${1:-} in
    NONE | UNEXPECTED_COMMAND_FAILURE | METADATA_TIMEOUT | METADATA_FAILED | GATEWAY_PULL_TIMEOUT | \
      SCRAPER_PULL_TIMEOUT | REGISTRY_AUTHENTICATION_DENIED | REGISTRY_MANIFEST_NOT_FOUND | \
      REGISTRY_DIGEST_MISMATCH | REGISTRY_ACCESS_UNAVAILABLE | DISPOSABLE_DOCKER_TIMEOUT | \
      DISPOSABLE_DOCKER_FAILED | RESTORE_LIST_TIMEOUT | RESTORE_LIST_FAILED | FULL_RESTORE_TIMEOUT | \
      FULL_RESTORE_FAILED | MIGRATION_INVENTORY_TIMEOUT | MIGRATION_SCAN_TIMEOUT | MIGRATE_DEPLOY_TIMEOUT | \
      MIGRATE_DEPLOY_FAILED | PRISMA_DIFF_TIMEOUT | PRISMA_DIFF_FAILED | GATEWAY_STARTUP_TIMEOUT | \
      GATEWAY_NEGATIVE_TIMEOUT | SYNTHETIC_HARNESS_TIMEOUT | GATEWAY_CLIENT_TIMEOUT | \
      POLLING_DEADLINE_EXCEEDED | CONTAINER_REMOVAL_TIMEOUT | NETWORK_REMOVAL_TIMEOUT | \
      VOLUME_REMOVAL_TIMEOUT | TEMP_REMOVAL_TIMEOUT | CLEANUP_GLOBAL_DEADLINE_EXCEEDED | \
      CLEANUP_INCOMPLETE | PRE_PULL_DISK_GATE_FAILED | POST_PULL_DISK_GATE_FAILED | FINAL_DISK_GATE_FAILED | \
      PRODUCTION_GIT_BASELINE_MISMATCH | \
      SUCCESS_REPORT_VALIDATION_TIMEOUT | SUCCESS_REPORT_MALFORMED | SUCCESS_REPORT_SAFETY_VIOLATION | \
      EXPECTED_FAILURE_NOT_OBSERVED | INVALID_OUT_PARAMETER | OUTPUT_TARGET_SCOPE_COLLISION | \
      EMERGENCY_DIAGNOSTICS_USED | \
      MIGRATION_COMMAND_NOT_STARTED | MIGRATION_DOCKER_CLI_FAILED | \
      MIGRATION_RUNNER_CREATE_FAILED | MIGRATION_RUNNER_START_FAILED | MIGRATION_RUNNER_EXITED | \
      MIGRATION_DOCKER_EXEC_FAILED | MIGRATION_CONTAINER_UNAVAILABLE | \
      MIGRATION_NETWORK_ALIAS_MISMATCH | MIGRATION_DATABASE_URL_CONSTRUCTION_FAILED | \
      MIGRATION_PRISMA_EXECUTABLE_MISSING | MIGRATION_PRISMA_COMMAND_REJECTED | \
      MIGRATION_PRISMA_EXIT_1 | MIGRATION_PRISMA_EXIT_2 | MIGRATION_PRISMA_TIMEOUT | \
      MIGRATION_SQL_BINDING_MISMATCH | MIGRATION_SQL_GATE_EXIT_2 | MIGRATION_DIRECTORY_MISSING | \
      MIGRATION_DEPLOY_FAILED | MIGRATION_POST_VERIFICATION_FAILED | MIGRATION_INTERNAL_VALIDATOR_FAILED | \
      MIGRATION_RUNTIME_FILE_UNREADABLE | MIGRATION_RUNNER_IDENTITY_MISMATCH | \
      MIGRATION_RUNNER_NETWORK_MISMATCH | MIGRATION_INVENTORY_FAILED | \
      MIGRATION_SHADOW_DATABASE_CREATE_FAILED | \
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

personal_max_stage8b1i_safe_check_id() {
  case ${1:-} in
    NONE | POSTGRES_CONTAINER_START_CHECK | POSTGRES_READINESS_CHECK | \
      POSTGRES_SERVER_VERSION_QUERY_CHECK | POSTGRES_SERVER_VERSION_MATCH_CHECK | \
      RESTORE_LEDGER_FINISHED_CHECK | RESTORE_LEDGER_FAILED_CHECK | \
      RESTORE_LEDGER_NAMES_CHECK | RESTORE_CATALOG_TABLES_CHECK | \
      RESTORE_CATALOG_INDEXES_CHECK | RESTORE_CATALOG_CONSTRAINTS_CHECK | \
      RESTORE_REQUIRED_PRISMA_MIGRATIONS_RELATION_CHECK | \
      RESTORE_REQUIRED_USERS_RELATION_CHECK | RESTORE_REQUIRED_CONTACT_RELATION_CHECK | \
      RESTORE_REQUIRED_CHAT_RELATION_CHECK | RESTORE_REPRESENTATIVE_MIGRATIONS_CHECK | \
      RESTORE_REPRESENTATIVE_USER_CHECK | RESTORE_REPRESENTATIVE_CONTACT_CHECK | \
      RESTORE_REPRESENTATIVE_CHAT_CHECK | RESTORE_REPORT_RENDER_CHECK | \
      MIGRATION_DATABASE_URL_CONSTRUCTION_CHECK | MIGRATION_INVENTORY_CHECK | \
      MIGRATION_PENDING_SET_CHECK | MIGRATION_REPOSITORY_COUNT_CHECK | \
      MIGRATION_APPLIED_ONLY_CHECK | MIGRATION_RUNTIME_BINDING_CHECK | \
      MIGRATION_SQL_RUNNER_CREATE_CHECK | MIGRATION_SQL_RUNNER_IDENTITY_CHECK | \
      MIGRATION_SQL_RUNNER_START_CHECK | MIGRATION_POSTGRES_ALIAS_CHECK | \
      MIGRATION_SHADOW_DATABASE_CREATE_CHECK | MIGRATION_PRISMA_RUNNER_CREATE_CHECK | \
      MIGRATION_PRISMA_RUNNER_IDENTITY_CHECK | MIGRATION_PRISMA_EXECUTABLE_CHECK | \
      MIGRATION_PRISMA_DEPLOY_CHECK | MIGRATION_POST_LEDGER_CHECK | \
      MIGRATION_POST_SCHEMA_CHECK | MIGRATION_PRISMA_DIFF_CHECK) return 0 ;;
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

personal_max_stage8b1i_cleanup_primary_temp() {
  local __pm_path=${PM_DIAGNOSTIC_TMP:-}
  PM_DIAGNOSTIC_TMP=''
  [[ -n $__pm_path ]] || return 0
  [[ $__pm_path =~ ^/var/tmp/personal-max-stage8b1i-isolated-release-proof\.failure\.tmp\.[A-Za-z0-9]{6}$ ]] || return 0
  [[ -f $__pm_path && ! -L $__pm_path ]] || return 0
  timeout 10 rm -f -- "$__pm_path" >/dev/null 2>&1
}

personal_max_stage8b1i_render_failure() {
  local original_exit=${1:-1} source_line=${2:-0} cleanup_ok=${3:-false}
  local safe_phase safe_class safe_error safe_check_id cleanup_error generated temporary identity final_identity permissions report_sha
  local post_pull_required post_pull_observed post_pull_deficit final_observed final_deficit cleanup_containers cleanup_networks cleanup_volumes cleanup_temp
  local cleanup_containers_json cleanup_networks_json cleanup_volumes_json cleanup_temp_json
  local ledger_name_count ledger_unique_count ledger_duplicate_count ledger_empty_count ledger_invalid_format_count ledger_unsafe_count
  local ledger_repository_to_count ledger_to_repository_count ledger_names_sha ledger_attestation_sha ledger_naming_classification
  local observed_production_head observed_production_status_sha
  local postgres_status postgres_operation postgres_state postgres_health postgres_exit_json
  local postgres_readiness_attempts postgres_readiness_transient postgres_readiness_last_json
  local postgres_version_attempts postgres_version_transient postgres_version_last_json
  local postgres_version_matched postgres_elapsed
  local postgres_expected_version_text postgres_expected_version_num
  local postgres_observed_version_num_json postgres_observed_major_json postgres_observed_minor_json postgres_observed_patch_json
  local postgres_version_classification postgres_version_output_category
  local migration_check_id migration_substep migration_role migration_command_category migration_executable_category
  local migration_command_started migration_attempt_count migration_elapsed migration_original_exit_json
  local migration_container_state migration_primary_classification
  [[ $original_exit =~ ^[1-9][0-9]*$ && $original_exit -le 255 ]] || original_exit=1
  [[ $source_line =~ ^[0-9]+$ ]] || source_line=0
  safe_phase=${PROBE_PHASE:-bootstrap_complete}
  personal_max_stage8b1i_safe_phase "$safe_phase" || safe_phase=bootstrap_complete
  safe_class=${PROBE_SAFE_COMMAND_CLASS:-unknown}
  personal_max_stage8b1i_safe_class "$safe_class" || safe_class=unknown
  safe_error=${PROBE_ERROR_CLASSIFICATION:-UNEXPECTED_COMMAND_FAILURE}
  personal_max_stage8b1i_safe_error "$safe_error" || safe_error=UNEXPECTED_COMMAND_FAILURE
  if [[ ${MIGRATION_CHECK_ID:-NONE} != NONE ]]; then safe_check_id=${MIGRATION_CHECK_ID}; else safe_check_id=${RESTORE_CHECK_ID:-NONE}; fi
  personal_max_stage8b1i_safe_check_id "$safe_check_id" || safe_check_id=NONE
  cleanup_error=${CLEANUP_ERROR_CLASSIFICATION:-NONE}
  personal_max_stage8b1i_safe_error "$cleanup_error" || cleanup_error=CLEANUP_INCOMPLETE
  [[ $cleanup_ok == true ]] || cleanup_ok=false
  pm_capture_bounded generated filesystem_metadata 30 METADATA_TIMEOUT METADATA_FAILED date -u +'%Y-%m-%dT%H:%M:%SZ' || generated='1970-01-01T00:00:00Z'
  post_pull_required=$((REQUIRED_FREE_BYTES + PROBE_BUDGET_BYTES))
  post_pull_observed=${FREE_BYTES_AFTER_PULL:-0}
  pm_safe_uint "$post_pull_observed" || post_pull_observed=0
  if (( post_pull_observed == 0 )); then
    post_pull_observed=${FREE_BYTES_AFTER_SCRAPER_PULL:-0}
    pm_safe_uint "$post_pull_observed" || post_pull_observed=0
  fi
  if (( post_pull_observed == 0 )); then
    post_pull_observed=${FREE_BYTES_AFTER_GATEWAY_PULL:-0}
    pm_safe_uint "$post_pull_observed" || post_pull_observed=0
  fi
  post_pull_deficit=$((post_pull_required > post_pull_observed ? post_pull_required - post_pull_observed : 0))
  final_observed=${FREE_BYTES_AFTER_CLEANUP:-0}
  pm_safe_uint "$final_observed" || final_observed=0
  final_deficit=$((REQUIRED_FREE_BYTES > final_observed ? REQUIRED_FREE_BYTES - final_observed : 0))
  cleanup_containers=${CLEANUP_CONTAINERS_REMAINING:-unknown}
  cleanup_networks=${CLEANUP_NETWORKS_REMAINING:-unknown}
  cleanup_volumes=${CLEANUP_VOLUMES_REMAINING:-unknown}
  cleanup_temp=${CLEANUP_TEMP_FILES_REMAINING:-unknown}
  if [[ $cleanup_containers =~ ^[0-9]+$ ]]; then cleanup_containers_json=$cleanup_containers; else cleanup_containers_json='"unknown"'; fi
  if [[ $cleanup_networks =~ ^[0-9]+$ ]]; then cleanup_networks_json=$cleanup_networks; else cleanup_networks_json='"unknown"'; fi
  if [[ $cleanup_volumes =~ ^[0-9]+$ ]]; then cleanup_volumes_json=$cleanup_volumes; else cleanup_volumes_json='"unknown"'; fi
  if [[ $cleanup_temp =~ ^[0-9]+$ ]]; then cleanup_temp_json=$cleanup_temp; else cleanup_temp_json='"unknown"'; fi
  ledger_name_count=${LEDGER_NAME_COUNT:-0}
  ledger_unique_count=${LEDGER_UNIQUE_COUNT:-0}
  ledger_duplicate_count=${LEDGER_DUPLICATE_COUNT:-0}
  ledger_empty_count=${LEDGER_EMPTY_NAME_COUNT:-0}
  ledger_invalid_format_count=${LEDGER_INVALID_FORMAT_COUNT:-0}
  ledger_unsafe_count=${LEDGER_UNSAFE_NAME_COUNT:-0}
  ledger_repository_to_count=${LEDGER_REPOSITORY_TO_LEDGER_COUNT:-0}
  ledger_to_repository_count=${LEDGER_TO_REPOSITORY_COUNT:-0}
  [[ $ledger_name_count =~ ^[0-9]+$ ]] || ledger_name_count=0
  [[ $ledger_unique_count =~ ^[0-9]+$ ]] || ledger_unique_count=0
  [[ $ledger_duplicate_count =~ ^[0-9]+$ ]] || ledger_duplicate_count=0
  [[ $ledger_empty_count =~ ^[0-9]+$ ]] || ledger_empty_count=0
  [[ $ledger_invalid_format_count =~ ^[0-9]+$ ]] || ledger_invalid_format_count=0
  [[ $ledger_unsafe_count =~ ^[0-9]+$ ]] || ledger_unsafe_count=0
  [[ $ledger_repository_to_count =~ ^[0-9]+$ ]] || ledger_repository_to_count=0
  [[ $ledger_to_repository_count =~ ^[0-9]+$ ]] || ledger_to_repository_count=0
  ledger_names_sha=${LEDGER_NAMES_SHA256:-not_observed}
  [[ $ledger_names_sha =~ ^[0-9a-f]{64}$ ]] || ledger_names_sha=not_observed
  ledger_attestation_sha=${LEDGER_ATTESTATION_SHA256:-not_observed}
  [[ $ledger_attestation_sha =~ ^[0-9a-f]{64}$ ]] || ledger_attestation_sha=not_observed
  ledger_naming_classification=${LEDGER_NAMING_CLASSIFICATION:-NOT_OBSERVED}
  case $ledger_naming_classification in
    NOT_OBSERVED | RESTORE_LEDGER_HISTORICAL_NAME_ACCEPTED | RESTORE_LEDGER_MODERN_NAMES) ;;
    *) ledger_naming_classification=NOT_OBSERVED ;;
  esac
  observed_production_head=${OBSERVED_PRODUCTION_HEAD:-not_observed}
  [[ $observed_production_head =~ ^[0-9a-f]{40}$ ]] || observed_production_head=not_observed
  observed_production_status_sha=${OBSERVED_PRODUCTION_STATUS_V2_RAW_SHA256:-not_observed}
  [[ $observed_production_status_sha =~ ^[0-9a-f]{64}$ ]] || observed_production_status_sha=not_observed
  postgres_status=${POSTGRES_STARTUP_STATUS:-NOT_OBSERVED}
  case $postgres_status in
    NOT_OBSERVED | CONTAINER_STARTING | CONTAINER_STARTED | CONTAINER_START_FAILED | \
      READINESS_POLLING | READINESS_CONFIRMED | READINESS_OBSERVATION_FAILED | \
      READINESS_COMMAND_FAILED | READINESS_TIMEOUT | CONTAINER_EXITED_DURING_STARTUP | \
      VERSION_QUERY_POLLING | VERSION_OBSERVATION_FAILED | VERSION_QUERY_FAILED | \
      VERSION_OUTPUT_MALFORMED | VERSION_MISMATCH | READY) ;;
    *) postgres_status=NOT_OBSERVED ;;
  esac
  postgres_operation=${POSTGRES_STARTUP_LAST_OPERATION:-NOT_OBSERVED}
  case $postgres_operation in NOT_OBSERVED | container_start | readiness_poll | server_version_query) ;; *) postgres_operation=NOT_OBSERVED ;; esac
  postgres_state=${POSTGRES_CONTAINER_STATE:-not_observed}
  case $postgres_state in not_observed | created | running | restarting | removing | paused | exited | dead) ;; *) postgres_state=not_observed ;; esac
  postgres_health=${POSTGRES_CONTAINER_HEALTH:-not_observed}
  case $postgres_health in not_observed | none | starting | healthy | unhealthy) ;; *) postgres_health=not_observed ;; esac
  if [[ ${POSTGRES_CONTAINER_EXIT_CODE:-} =~ ^[0-9]+$ ]]; then postgres_exit_json=${POSTGRES_CONTAINER_EXIT_CODE}; else postgres_exit_json='"not_observed"'; fi
  postgres_readiness_attempts=${POSTGRES_READINESS_ATTEMPTS:-0}
  postgres_readiness_transient=${POSTGRES_READINESS_TRANSIENT_COUNT:-0}
  postgres_version_attempts=${POSTGRES_VERSION_QUERY_ATTEMPTS:-0}
  postgres_version_transient=${POSTGRES_VERSION_TRANSIENT_COUNT:-0}
  postgres_elapsed=${POSTGRES_STARTUP_ELAPSED_SECONDS:-0}
  [[ $postgres_readiness_attempts =~ ^[0-9]+$ ]] || postgres_readiness_attempts=0
  [[ $postgres_readiness_transient =~ ^[0-9]+$ ]] || postgres_readiness_transient=0
  [[ $postgres_version_attempts =~ ^[0-9]+$ ]] || postgres_version_attempts=0
  [[ $postgres_version_transient =~ ^[0-9]+$ ]] || postgres_version_transient=0
  [[ $postgres_elapsed =~ ^[0-9]+$ ]] || postgres_elapsed=0
  if [[ ${POSTGRES_READINESS_LAST_EXIT:-} =~ ^[0-9]+$ ]]; then postgres_readiness_last_json=${POSTGRES_READINESS_LAST_EXIT}; else postgres_readiness_last_json='"not_observed"'; fi
  if [[ ${POSTGRES_VERSION_LAST_EXIT:-} =~ ^[0-9]+$ ]]; then postgres_version_last_json=${POSTGRES_VERSION_LAST_EXIT}; else postgres_version_last_json='"not_observed"'; fi
  postgres_version_matched=${POSTGRES_VERSION_MATCHED:-false}
  [[ $postgres_version_matched == true ]] || postgres_version_matched=false
  postgres_expected_version_text=${POSTGRES_VERSION:-16.14}
  [[ $postgres_expected_version_text == 16.14 ]] || postgres_expected_version_text=16.14
  postgres_expected_version_num=${POSTGRES_VERSION_NUM:-160014}
  [[ $postgres_expected_version_num == 160014 ]] || postgres_expected_version_num=160014
  if [[ ${POSTGRES_OBSERVED_VERSION_NUM:-} =~ ^[0-9]{6}$ ]]; then postgres_observed_version_num_json=${POSTGRES_OBSERVED_VERSION_NUM}; else postgres_observed_version_num_json='"not_observed"'; fi
  if [[ ${POSTGRES_OBSERVED_VERSION_MAJOR:-} =~ ^[0-9]+$ ]]; then postgres_observed_major_json=${POSTGRES_OBSERVED_VERSION_MAJOR}; else postgres_observed_major_json='"not_observed"'; fi
  if [[ ${POSTGRES_OBSERVED_VERSION_MINOR:-} =~ ^[0-9]+$ ]]; then postgres_observed_minor_json=${POSTGRES_OBSERVED_VERSION_MINOR}; else postgres_observed_minor_json='"not_observed"'; fi
  if [[ ${POSTGRES_OBSERVED_VERSION_PATCH:-} =~ ^[0-9]+$ ]]; then postgres_observed_patch_json=${POSTGRES_OBSERVED_VERSION_PATCH}; else postgres_observed_patch_json='"not_observed"'; fi
  postgres_version_classification=${POSTGRES_VERSION_CLASSIFICATION:-NOT_OBSERVED}
  case $postgres_version_classification in NOT_OBSERVED | POSTGRES_VERSION_QUERY_FAILED | POSTGRES_VERSION_OUTPUT_MALFORMED | POSTGRES_VERSION_MISMATCH | POSTGRES_VERSION_MATCHED) ;; *) postgres_version_classification=NOT_OBSERVED ;; esac
  postgres_version_output_category=${POSTGRES_VERSION_OUTPUT_CATEGORY:-NOT_OBSERVED}
  case $postgres_version_output_category in NOT_OBSERVED | CANONICAL_NUMERIC | WHITESPACE_NORMALIZED | MALFORMED) ;; *) postgres_version_output_category=NOT_OBSERVED ;; esac
  migration_check_id=${MIGRATION_CHECK_ID:-NONE}
  personal_max_stage8b1i_safe_check_id "$migration_check_id" || migration_check_id=NONE
  migration_substep=${MIGRATION_SUBSTEP:-NOT_STARTED}
  if ! declare -F pm_migration_substep_is_safe >/dev/null || ! pm_migration_substep_is_safe "$migration_substep"; then migration_substep=NOT_STARTED; fi
  migration_role=${MIGRATION_RUNNER_ROLE:-not_observed}
  if ! declare -F pm_migration_role_is_safe >/dev/null || ! pm_migration_role_is_safe "$migration_role"; then migration_role=not_observed; fi
  migration_command_category=${MIGRATION_COMMAND_CATEGORY:-not_observed}
  if ! declare -F pm_migration_command_category_is_safe >/dev/null || ! pm_migration_command_category_is_safe "$migration_command_category"; then migration_command_category=not_observed; fi
  migration_executable_category=${MIGRATION_EXECUTABLE_CATEGORY:-not_observed}
  if ! declare -F pm_migration_executable_category_is_safe >/dev/null || ! pm_migration_executable_category_is_safe "$migration_executable_category"; then migration_executable_category=not_observed; fi
  migration_command_started=${MIGRATION_COMMAND_STARTED:-false}
  [[ $migration_command_started == true ]] || migration_command_started=false
  migration_attempt_count=${MIGRATION_ATTEMPT_COUNT:-0}
  [[ $migration_attempt_count =~ ^[0-9]+$ ]] || migration_attempt_count=0
  migration_elapsed=${MIGRATION_ELAPSED_SECONDS:-0}
  [[ $migration_elapsed =~ ^[0-9]+$ ]] || migration_elapsed=0
  if [[ ${MIGRATION_ORIGINAL_EXIT:-} =~ ^[0-9]+$ && ${MIGRATION_ORIGINAL_EXIT} -le 255 ]]; then migration_original_exit_json=${MIGRATION_ORIGINAL_EXIT}; else migration_original_exit_json='"not_observed"'; fi
  migration_container_state=${MIGRATION_CONTAINER_STATE_CATEGORY:-not_observed}
  if ! declare -F pm_migration_state_is_safe >/dev/null || ! pm_migration_state_is_safe "$migration_container_state"; then migration_container_state=not_observed; fi
  migration_primary_classification=${MIGRATION_PRIMARY_CLASSIFICATION:-NONE}
  personal_max_stage8b1i_safe_error "$migration_primary_classification" || migration_primary_classification=NONE

  if [[ -e $PM_FAILURE_PATH || -L $PM_FAILURE_PATH ]]; then
    printf 'ISOLATED_PROBE_FAILED\nPHASE=%s\nEXIT_CODE=%s\nFAILURE_REPORT_PATH_UNSAFE\n' "$safe_phase" "$original_exit" >&2
    return 74
  fi
  pm_capture_bounded temporary filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
    mktemp /var/tmp/personal-max-stage8b1i-isolated-release-proof.failure.tmp.XXXXXX || return 74
  PM_DIAGNOSTIC_TMP=$temporary
  pm_run_bounded report_handoff 60 METADATA_TIMEOUT METADATA_FAILED chmod 0600 "$temporary" || return 74
  pm_write_bounded "$temporary" report_render 60 METADATA_TIMEOUT METADATA_FAILED jq -n \
    --arg generatedAt "$generated" --arg scriptSha256 "$PM_SCRIPT_SHA256" \
    --arg phase "$safe_phase" --arg safeCommandClass "$safe_class" --arg classification "$safe_error" \
    --arg checkId "$safe_check_id" \
    --arg ledgerNamesSha256 "$ledger_names_sha" --arg ledgerAttestationSha256 "$ledger_attestation_sha" \
    --arg ledgerNamingClassification "$ledger_naming_classification" \
    --arg acceptedProductionHead "$ACCEPTED_PRODUCTION_HEAD" \
    --arg acceptedProductionStatusV2RawSha256 "$ACCEPTED_PRODUCTION_STATUS_V2_RAW_SHA256" \
    --arg observedProductionHead "$observed_production_head" \
    --arg observedProductionStatusV2RawSha256 "$observed_production_status_sha" \
    --arg postgresStatus "$postgres_status" --arg postgresOperation "$postgres_operation" \
    --arg postgresContainerState "$postgres_state" --arg postgresContainerHealth "$postgres_health" \
    --argjson postgresContainerExitCode "$postgres_exit_json" \
    --argjson postgresReadinessAttempts "$postgres_readiness_attempts" \
    --argjson postgresReadinessTransientCount "$postgres_readiness_transient" \
    --argjson postgresReadinessLastExit "$postgres_readiness_last_json" \
    --argjson postgresVersionQueryAttempts "$postgres_version_attempts" \
    --argjson postgresVersionTransientCount "$postgres_version_transient" \
    --argjson postgresVersionLastExit "$postgres_version_last_json" \
    --argjson postgresVersionMatched "$postgres_version_matched" --argjson postgresElapsedSeconds "$postgres_elapsed" \
    --arg postgresExpectedVersionText "$postgres_expected_version_text" \
    --argjson postgresExpectedVersionNum "$postgres_expected_version_num" \
    --argjson postgresObservedVersionNum "$postgres_observed_version_num_json" \
    --argjson postgresObservedMajor "$postgres_observed_major_json" \
    --argjson postgresObservedMinor "$postgres_observed_minor_json" \
    --argjson postgresObservedPatch "$postgres_observed_patch_json" \
    --arg postgresVersionClassification "$postgres_version_classification" \
    --arg postgresVersionOutputCategory "$postgres_version_output_category" \
    --arg migrationCheckId "$migration_check_id" --arg migrationSubstep "$migration_substep" --arg migrationRunnerRole "$migration_role" \
    --arg migrationCommandCategory "$migration_command_category" \
    --arg migrationExecutableCategory "$migration_executable_category" \
    --argjson migrationCommandStarted "$migration_command_started" \
    --argjson migrationAttemptCount "$migration_attempt_count" --argjson migrationElapsedSeconds "$migration_elapsed" \
    --argjson migrationOriginalExit "$migration_original_exit_json" \
    --arg migrationContainerState "$migration_container_state" \
    --arg migrationPrimaryClassification "$migration_primary_classification" \
    --argjson ledgerNameCount "$ledger_name_count" --argjson ledgerUniqueCount "$ledger_unique_count" \
    --argjson ledgerDuplicateCount "$ledger_duplicate_count" --argjson ledgerEmptyCount "$ledger_empty_count" \
    --argjson ledgerInvalidFormatCount "$ledger_invalid_format_count" --argjson ledgerUnsafeCount "$ledger_unsafe_count" \
    --argjson repositoryToLedgerCount "$ledger_repository_to_count" --argjson ledgerToRepositoryCount "$ledger_to_repository_count" \
    --argjson invalidNamingCategories "${LEDGER_INVALID_NAMING_CATEGORIES_JSON:-[]}" \
    --argjson acceptedHistoricalNames "${LEDGER_ACCEPTED_HISTORICAL_NAMES_JSON:-[]}" \
    --arg cleanupErrorClassification "$cleanup_error" \
    --argjson exitCode "$original_exit" --argjson sourceLine "$source_line" \
    --argjson cleanupCompleted "$cleanup_ok" \
    --argjson cleanupContainers "$cleanup_containers_json" --argjson cleanupNetworks "$cleanup_networks_json" \
    --argjson cleanupVolumes "$cleanup_volumes_json" --argjson cleanupTemp "$cleanup_temp_json" \
    --argjson gatewayPreexisting "${GATEWAY_PREEXISTING_BEFORE_PULL:-false}" \
    --arg gatewayImageIdBefore "${GATEWAY_IMAGE_ID_BEFORE:-not_observed}" \
    --argjson gatewayAcquired "${GATEWAY_ACQUIRED_DURING_PROBE:-false}" \
    --argjson scraperPreexisting "${SCRAPER_PREEXISTING_BEFORE_PULL:-false}" \
    --arg scraperImageIdBefore "${SCRAPER_IMAGE_ID_BEFORE:-not_observed}" \
    --argjson scraperAcquired "${SCRAPER_ACQUIRED_DURING_PROBE:-false}" \
    --argjson freeBeforePull "${FREE_BYTES_BEFORE_PULL:-0}" --argjson freeAfterGatewayPull "${FREE_BYTES_AFTER_GATEWAY_PULL:-0}" \
    --argjson freeAfterScraperPull "${FREE_BYTES_AFTER_SCRAPER_PULL:-0}" --argjson freeAfterPull "$post_pull_observed" \
    --argjson freeAfterCleanup "$final_observed" --argjson postPullRequired "$post_pull_required" \
    --argjson postPullDeficit "$post_pull_deficit" --argjson finalRequired "$REQUIRED_FREE_BYTES" --argjson finalDeficit "$final_deficit" \
    '{schemaVersion:1,mode:"ISOLATED_RELEASE_PROOF_FAILURE",generatedAt:$generatedAt,
      script:{sha256:$scriptSha256,checksumBound:true},phase:$phase,safeCommandClass:$safeCommandClass,
      classification:$classification,checkId:$checkId,exitCode:$exitCode,sourceLine:$sourceLine,
      postgresStartup:{status:$postgresStatus,lastOperation:$postgresOperation,
        containerState:$postgresContainerState,containerExitCode:$postgresContainerExitCode,
        healthStatus:$postgresContainerHealth,readinessAttempts:$postgresReadinessAttempts,
        readinessTransientCount:$postgresReadinessTransientCount,readinessLastExit:$postgresReadinessLastExit,
        versionQueryAttempts:$postgresVersionQueryAttempts,versionTransientCount:$postgresVersionTransientCount,
        versionLastExit:$postgresVersionLastExit,versionMatched:$postgresVersionMatched,
        expectedVersionText:$postgresExpectedVersionText,expectedVersionNum:$postgresExpectedVersionNum,
        observedVersionNum:$postgresObservedVersionNum,observedMajor:$postgresObservedMajor,
        observedMinor:$postgresObservedMinor,observedPatch:$postgresObservedPatch,
        versionClassification:$postgresVersionClassification,versionOutputCategory:$postgresVersionOutputCategory,
        elapsedSeconds:$postgresElapsedSeconds,rawLogsCaptured:false,environmentValuesCaptured:false,
        credentialsCaptured:false,commandArgumentsCaptured:false},
      migrationPreflight:{checkId:$migrationCheckId,substep:$migrationSubstep,runnerRole:$migrationRunnerRole,
        commandCategory:$migrationCommandCategory,executableCategory:$migrationExecutableCategory,
        commandStarted:$migrationCommandStarted,attemptCount:$migrationAttemptCount,
        elapsedSeconds:$migrationElapsedSeconds,originalExitCode:$migrationOriginalExit,
        containerStateCategory:$migrationContainerState,primaryClassification:$migrationPrimaryClassification,
        rawStderrCaptured:false,rawCommandCaptured:false,environmentValuesCaptured:false,
        databaseUrlCaptured:false,credentialsCaptured:false,sqlCaptured:false,businessDataCaptured:false},
      ledgerDiagnostics:{ledgerNameCount:$ledgerNameCount,ledgerUniqueCount:$ledgerUniqueCount,
        ledgerDuplicateCount:$ledgerDuplicateCount,ledgerEmptyNameCount:$ledgerEmptyCount,
        ledgerInvalidFormatCount:$ledgerInvalidFormatCount,ledgerUnsafeNameCount:$ledgerUnsafeCount,
        ledgerNamesSha256:$ledgerNamesSha256,ledgerAttestationSha256:$ledgerAttestationSha256,
        namingClassification:$ledgerNamingClassification,invalidNamingCategories:$invalidNamingCategories,
        acceptedHistoricalNames:$acceptedHistoricalNames,repositoryToLedgerCount:$repositoryToLedgerCount,
        ledgerToRepositoryCount:$ledgerToRepositoryCount,sqlCaptured:false,queryResultsCaptured:false},
      cleanup:{completed:$cleanupCompleted,errorClassification:$cleanupErrorClassification,
        containersRemaining:$cleanupContainers,networksRemaining:$cleanupNetworks,
        volumesRemaining:$cleanupVolumes,tempFilesRemaining:$cleanupTemp,labelScoped:true,globalPrune:false},
      images:{gateway:{preexistingBeforePull:$gatewayPreexisting,imageIdBeforePull:$gatewayImageIdBefore,
          acquiredDuringProbe:$gatewayAcquired,retained:true},
        scraper:{preexistingBeforePull:$scraperPreexisting,imageIdBeforePull:$scraperImageIdBefore,
          acquiredDuringProbe:$scraperAcquired,retained:true},acceptedImagesRetained:true,genericImageRemoval:false},
      storage:{freeBytesBeforePull:$freeBeforePull,freeBytesAfterGatewayPull:$freeAfterGatewayPull,
        freeBytesAfterScraperPull:$freeAfterScraperPull,freeBytesAfterPull:$freeAfterPull,
        freeBytesAfterCleanup:$freeAfterCleanup,postPullRequiredBytes:$postPullRequired,
        postPullDeficitBytes:$postPullDeficit,finalRequiredBytes:$finalRequired,finalDeficitBytes:$finalDeficit},
      productionImmutability:{productionDatabaseConnections:0,
        productionMigrationLedgerSource:"accepted_preflight_attestation",productionMutationAuthorized:false,
        acceptedProductionHead:$acceptedProductionHead,
        acceptedProductionStatusV2RawSha256:$acceptedProductionStatusV2RawSha256,
        observedProductionHead:$observedProductionHead,
        observedProductionStatusV2RawSha256:$observedProductionStatusV2RawSha256},
      diagnostics:{rawCommandCaptured:false,rawSqlCaptured:false,rawStderrCaptured:false,
        environmentValuesCaptured:false,credentialsCaptured:false,messageDataCaptured:false,providerPayloadCaptured:false},
      safety:{productionDDL:false,productionDML:false,productionMigration:false,restart:false,deploy:false,
        browserLaunched:false,maxContacted:false,providerAction:false,productionNetworkAttached:false,
        productionVolumeMounted:false,profileMounted:false},
      recommendedNextAction:"CODEX_REVIEW_ISOLATED_FAILURE_REPORT"}' || return 74
  pm_run_bounded report_handoff 60 METADATA_TIMEOUT METADATA_FAILED chgrp codexbot "$temporary" || return 74
  pm_run_bounded report_handoff 60 METADATA_TIMEOUT METADATA_FAILED chmod 0640 "$temporary" || return 74
  pm_capture_bounded permissions report_handoff 60 METADATA_TIMEOUT METADATA_FAILED stat -Lc '%U:%G:%a' "$temporary" || return 74
  [[ -f $temporary && ! -L $temporary && $permissions == root:codexbot:640 ]]
  pm_capture_bounded identity report_handoff 60 METADATA_TIMEOUT METADATA_FAILED stat -Lc '%d:%i' "$temporary" || return 74
  pm_run_bounded report_handoff 60 METADATA_TIMEOUT METADATA_FAILED \
    mv --no-clobber --no-target-directory -- "$temporary" "$PM_FAILURE_PATH" || return 74
  PM_DIAGNOSTIC_TMP=''
  pm_capture_bounded final_identity report_handoff 60 METADATA_TIMEOUT METADATA_FAILED stat -Lc '%d:%i' "$PM_FAILURE_PATH" || return 74
  [[ $identity == "$final_identity" ]]
  sha_of report_sha "$PM_FAILURE_PATH" || return 74
  printf 'ISOLATED_PROBE_FAILED\nPHASE=%s\nSAFE_COMMAND_CLASS=%s\nCLASSIFICATION=%s\nCHECK_ID=%s\nEXIT_CODE=%s\nFAILURE_REPORT_PATH=%s\nFAILURE_REPORT_SHA256=%s\nREPORT_OWNER=root\nREPORT_GROUP=codexbot\nREPORT_MODE=0640\n' \
    "$safe_phase" "$safe_class" "$safe_error" "$safe_check_id" "$original_exit" "$PM_FAILURE_PATH" "$report_sha"
  return 0
}

personal_max_stage8b1i_write_emergency_json() {
  local __pm_path=${1:?path required} __pm_exit=${2:-1} __pm_phase=${3:-bootstrap_complete}
  local __pm_classification=${4:-UNEXPECTED_COMMAND_FAILURE} __pm_script_sha=${PM_SCRIPT_SHA256:-}
  local __pm_check_id
  if [[ ${MIGRATION_CHECK_ID:-NONE} != NONE ]]; then __pm_check_id=${MIGRATION_CHECK_ID}; else __pm_check_id=${RESTORE_CHECK_ID:-NONE}; fi
  [[ $__pm_exit =~ ^[1-9][0-9]*$ && $__pm_exit -le 255 ]] || __pm_exit=1
  personal_max_stage8b1i_safe_phase "$__pm_phase" || __pm_phase=bootstrap_complete
  personal_max_stage8b1i_safe_error "$__pm_classification" || __pm_classification=UNEXPECTED_COMMAND_FAILURE
  personal_max_stage8b1i_safe_check_id "$__pm_check_id" || __pm_check_id=NONE
  [[ $__pm_script_sha =~ ^[0-9a-f]{64}$ ]] || __pm_script_sha=0000000000000000000000000000000000000000000000000000000000000000
  (set -o noclobber; : >"$__pm_path") 2>/dev/null || return 74
  printf '{"schemaVersion":1,"mode":"ISOLATED_RELEASE_PROOF_EMERGENCY_FAILURE","script":{"sha256":"%s","checksumBound":true},"phase":"%s","classification":"%s","checkId":"%s","exitCode":%s,"diagnostics":{"rawCommandCaptured":false,"rawSqlCaptured":false,"rawStderrCaptured":false,"environmentValuesCaptured":false,"credentialsCaptured":false,"messageDataCaptured":false,"providerPayloadCaptured":false},"safety":{"productionDDL":false,"productionDML":false,"productionMigration":false,"restart":false,"deploy":false,"browserLaunched":false,"maxContacted":false,"providerAction":false}}\n' \
    "$__pm_script_sha" "$__pm_phase" "$__pm_classification" "$__pm_check_id" "$__pm_exit" >"$__pm_path" || return 74
}

personal_max_stage8b1i_emergency_diagnostics() {
  local __pm_original_exit=${1:-1} __pm_phase=${PROBE_PHASE:-bootstrap_complete}
  local __pm_classification=${PROBE_ERROR_CLASSIFICATION:-UNEXPECTED_COMMAND_FAILURE}
  local __pm_target=${PM_FAILURE_PATH:-} __pm_temporary
  [[ $__pm_original_exit =~ ^[1-9][0-9]*$ && $__pm_original_exit -le 255 ]] || __pm_original_exit=1
  personal_max_stage8b1i_safe_phase "$__pm_phase" || __pm_phase=bootstrap_complete
  personal_max_stage8b1i_safe_error "$__pm_classification" || __pm_classification=UNEXPECTED_COMMAND_FAILURE
  personal_max_stage8b1i_cleanup_primary_temp || true
  if [[ ! $__pm_target =~ ^/var/tmp/personal-max-stage8b1i-isolated-release-proof\.failure\.[0-9a-f]{64}\.json$ || -e $__pm_target || -L $__pm_target ]]; then
    printf 'ISOLATED_PROBE_FAILED\nPHASE=%s\nCLASSIFICATION=%s\nEXIT_CODE=%s\nFAILURE_REPORT_UNAVAILABLE\n' \
      "$__pm_phase" "$__pm_classification" "$__pm_original_exit" >&2
    return "$__pm_original_exit"
  fi
  __pm_temporary="${__pm_target}.emergency.$$.${RANDOM}.tmp"
  if ! personal_max_stage8b1i_write_emergency_json "$__pm_temporary" "$__pm_original_exit" "$__pm_phase" "$__pm_classification" || \
    ! timeout 10 chmod 0600 "$__pm_temporary" 2>/dev/null || \
    ! timeout 10 chgrp codexbot "$__pm_temporary" 2>/dev/null || \
    ! timeout 10 chmod 0640 "$__pm_temporary" 2>/dev/null || \
    ! timeout 10 mv --no-clobber --no-target-directory -- "$__pm_temporary" "$__pm_target" 2>/dev/null; then
    timeout 10 rm -f -- "$__pm_temporary" >/dev/null 2>&1 || true
    printf 'ISOLATED_PROBE_FAILED\nPHASE=%s\nCLASSIFICATION=%s\nEXIT_CODE=%s\nFAILURE_REPORT_UNAVAILABLE\n' \
      "$__pm_phase" "$__pm_classification" "$__pm_original_exit" >&2
    return "$__pm_original_exit"
  fi
  printf 'ISOLATED_PROBE_FAILED\nPHASE=%s\nCLASSIFICATION=%s\nEXIT_CODE=%s\nFAILURE_REPORT_PATH=%s\nEMERGENCY_DIAGNOSTICS=YES\n' \
    "$__pm_phase" "$__pm_classification" "$__pm_original_exit" "$__pm_target"
  return "$__pm_original_exit"
}
