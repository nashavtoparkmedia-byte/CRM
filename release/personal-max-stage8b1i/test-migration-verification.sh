#!/usr/bin/env bash
# Offline migration-verification state-machine regression suite. All execution
# adapters are shell fixtures: no root, Docker, database, network, migration,
# MAX, provider, browser, deploy, or restart action is performed.
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
readonly FAILURE_REPORT='/var/tmp/personal-max-stage8b1i-isolated-release-proof.failure.6ebdbd0221c4fb395f5a255ded0f18a3e63b6f677baa644e5b0dd0296992f1f3.json'
readonly FAILURE_REPORT_SHA256='0203c1287fc2415367e10852fb83bb8001f558f2484c8e6cafe14d86c7d3dd67'
readonly FAILED_SCRIPT_SHA256='6ebdbd0221c4fb395f5a255ded0f18a3e63b6f677baa644e5b0dd0296992f1f3'
readonly FAILED_SOURCE_COMMIT='d62c990d74d1b99f455ab24e95d9f8a225bf9d40'
readonly EXACT_EIGHT_SHA256='9128eba91ecb5ce9d010015031050379cd45941fff93bef721df889040a56f8f'

(( EUID != 0 ))

# shellcheck source=release/personal-max-stage8b1i/migration-preflight.sh
source "$SCRIPT_DIR/migration-preflight.sh"

PASS_COUNT=0
MOCK_RUN_STATUS=0
MOCK_WRITE_STATUS=0
MOCK_PSQL_STATUS=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '%s=PASS\n' "$1"
}

pm_restore_errexit() {
  [[ $1 == true ]] && set -e || set +e
}

pm_run_bounded() {
  local __pm_timeout_class=$3 __pm_failure_class=$4
  if (( MOCK_RUN_STATUS == 0 )); then
    PROBE_ERROR_CLASSIFICATION=NONE
    return 0
  fi
  if (( MOCK_RUN_STATUS == 124 )); then
    PROBE_ERROR_CLASSIFICATION=$__pm_timeout_class
  else
    PROBE_ERROR_CLASSIFICATION=$__pm_failure_class
  fi
  return "$MOCK_RUN_STATUS"
}

pm_write_bounded() {
  local __pm_timeout_class=$4 __pm_failure_class=$5
  if (( MOCK_WRITE_STATUS == 0 )); then
    PROBE_ERROR_CLASSIFICATION=NONE
    return 0
  fi
  if (( MOCK_WRITE_STATUS == 124 )); then
    PROBE_ERROR_CLASSIFICATION=$__pm_timeout_class
  else
    PROBE_ERROR_CLASSIFICATION=$__pm_failure_class
  fi
  return "$MOCK_WRITE_STATUS"
}

psql_value() {
  local __pm_target=$1
  if (( MOCK_PSQL_STATUS == 0 )); then
    printf -v "$__pm_target" '%s' fixture-value
  fi
  return "$MOCK_PSQL_STATUS"
}

reset_state() {
  PROBE_ERROR_CLASSIFICATION=NONE
  MIGRATION_CHECK_ID=NONE
  MIGRATION_SUBSTEP=NOT_STARTED
  MIGRATION_RUNNER_ROLE=not_observed
  MIGRATION_COMMAND_CATEGORY=not_observed
  MIGRATION_EXECUTABLE_CATEGORY=not_observed
  MIGRATION_COMMAND_STARTED=false
  MIGRATION_ATTEMPT_COUNT=0
  MIGRATION_ELAPSED_SECONDS=0
  MIGRATION_ORIGINAL_EXIT=not_observed
  MIGRATION_CONTAINER_STATE_CATEGORY=not_observed
  MIGRATION_PRIMARY_CLASSIFICATION=NONE
  MOCK_RUN_STATUS=0
  MOCK_WRITE_STATUS=0
  MOCK_PSQL_STATUS=0
}

expect_psql_failure() {
  local __pm_name=$1 __pm_check=$2 __pm_substep=$3 __pm_classification=$4 __pm_exit=$5
  local __pm_value='' __pm_status
  reset_state
  MOCK_PSQL_STATUS=$__pm_exit
  set +e
  pm_migration_psql_value __pm_value "$__pm_check" "$__pm_substep" offline-query-fixture "$__pm_classification"
  __pm_status=$?
  set -e
  [[ $__pm_status -eq $__pm_exit && $MIGRATION_CHECK_ID == "$__pm_check" && \
    $MIGRATION_SUBSTEP == "$__pm_substep" && $MIGRATION_RUNNER_ROLE == postgres && \
    $MIGRATION_COMMAND_CATEGORY == docker_exec && $MIGRATION_EXECUTABLE_CATEGORY == postgres_client && \
    $MIGRATION_COMMAND_STARTED == true && $MIGRATION_ATTEMPT_COUNT -eq 1 && \
    $MIGRATION_ORIGINAL_EXIT -eq $__pm_exit && $MIGRATION_CONTAINER_STATE_CATEGORY == running && \
    $MIGRATION_PRIMARY_CLASSIFICATION == "$__pm_classification" && \
    $PROBE_ERROR_CLASSIFICATION == "$__pm_classification" ]]
  pass "$__pm_name"
}

expect_run_failure() {
  local __pm_name=$1 __pm_check=$2 __pm_substep=$3 __pm_role=$4 __pm_category=$5
  local __pm_executable=$6 __pm_classification=$7 __pm_exit=$8 __pm_status
  reset_state
  MOCK_RUN_STATUS=$__pm_exit
  set +e
  pm_migration_run_bounded "$__pm_check" "$__pm_substep" "$__pm_role" "$__pm_category" "$__pm_executable" \
    30 MIGRATION_SCAN_TIMEOUT "$__pm_classification" offline-command-fixture
  __pm_status=$?
  set -e
  [[ $__pm_status -eq $__pm_exit && $MIGRATION_CHECK_ID == "$__pm_check" && \
    $MIGRATION_SUBSTEP == "$__pm_substep" && $MIGRATION_RUNNER_ROLE == "$__pm_role" && \
    $MIGRATION_COMMAND_CATEGORY == "$__pm_category" && $MIGRATION_EXECUTABLE_CATEGORY == "$__pm_executable" && \
    $MIGRATION_COMMAND_STARTED == true && $MIGRATION_ATTEMPT_COUNT -eq 1 && \
    $MIGRATION_ORIGINAL_EXIT -eq $__pm_exit && $MIGRATION_CONTAINER_STATE_CATEGORY == not_observed && \
    $MIGRATION_PRIMARY_CLASSIFICATION == "$__pm_classification" && \
    $PROBE_ERROR_CLASSIFICATION == "$__pm_classification" ]]
  pass "$__pm_name"
}

[[ -f $FAILURE_REPORT && ! -L $FAILURE_REPORT && -r $FAILURE_REPORT && ! -w $FAILURE_REPORT ]]
observed_report_sha=$(sha256sum -- "$FAILURE_REPORT" | awk '{print $1}')
observed_report_stat=$(stat -Lc '%U:%G:%a:%s' -- "$FAILURE_REPORT")
[[ $observed_report_sha == "$FAILURE_REPORT_SHA256" && $observed_report_stat == root:codexbot:640:5519 ]]
jq -e --arg scriptSha "$FAILED_SCRIPT_SHA256" '
  .schemaVersion==1 and .mode=="ISOLATED_RELEASE_PROOF_FAILURE" and
  .script.sha256==$scriptSha and .script.checksumBound==true and
  .phase=="migration_verification" and .safeCommandClass=="disposable_migration" and
  .classification=="PRISMA_DIFF_FAILED" and .checkId=="MIGRATION_PRISMA_DIFF_CHECK" and
  .exitCode==1 and .sourceLine==165 and
  .migrationPreflight.checkId=="MIGRATION_PRISMA_DIFF_CHECK" and
  .migrationPreflight.substep=="prisma_diff" and .migrationPreflight.runnerRole=="prisma_diff" and
  .migrationPreflight.commandCategory=="internal_validator" and
  .migrationPreflight.executableCategory=="posix_shell" and
  .migrationPreflight.commandStarted==true and .migrationPreflight.attemptCount==1 and
  .migrationPreflight.originalExitCode==1 and
  .migrationPreflight.primaryClassification=="PRISMA_DIFF_FAILED" and
  .cleanup.completed==true and .cleanup.errorClassification=="NONE" and
  .cleanup.containersRemaining==0 and .cleanup.networksRemaining==0 and
  .cleanup.volumesRemaining==0 and .cleanup.tempFilesRemaining==0 and
  .productionImmutability.acceptedProductionHead==.productionImmutability.observedProductionHead and
  .productionImmutability.acceptedProductionStatusV2RawSha256==.productionImmutability.observedProductionStatusV2RawSha256 and
  ([.diagnostics.rawCommandCaptured,.diagnostics.rawSqlCaptured,.diagnostics.rawStderrCaptured,
    .diagnostics.environmentValuesCaptured,.diagnostics.credentialsCaptured,
    .diagnostics.messageDataCaptured,.diagnostics.providerPayloadCaptured,
    .safety.productionDDL,.safety.productionDML,.safety.productionMigration,.safety.restart,
    .safety.deploy,.safety.browserLaunched,.safety.maxContacted,.safety.providerAction,
    .safety.productionNetworkAttached,.safety.productionVolumeMounted,.safety.profileMounted] | all(.==false))' \
  "$FAILURE_REPORT" >/dev/null
pass exact_current_report_accepted

bound_script_sha=$(git -C "$SCRIPT_DIR" show "$FAILED_SOURCE_COMMIT:release/personal-max-stage8b1i/isolated-release-probe.sh" | sha256sum | awk '{print $1}')
bound_helper_line=$(git -C "$SCRIPT_DIR" show "$FAILED_SOURCE_COMMIT:release/personal-max-stage8b1i/migration-preflight.sh" | sed -n '165p')
bound_top_level=$(git -C "$SCRIPT_DIR" show "$FAILED_SOURCE_COMMIT:release/personal-max-stage8b1i/isolated-release-probe.sh" | sed -n '741,743p')
[[ $bound_script_sha == "$FAILED_SCRIPT_SHA256" && \
  $bound_helper_line == *'pm_migration_record_failure "${PROBE_ERROR_CLASSIFICATION:-$__pm_failure_class}" "$__pm_status" not_observed'* && \
  $bound_top_level == *'pm_migration_run_bounded MIGRATION_PRISMA_DIFF_CHECK prisma_diff prisma_diff internal_validator posix_shell'* && \
  $bound_top_level == *'sh "$PACKAGE_ROOT/prisma-legacy-diff-gate.sh" "$TMP/prisma-diff.log" >/dev/null'* ]]
pass exact_current_source_mapping

expect_psql_failure migration_finished_count_failure MIGRATION_POST_FINISHED_COUNT_CHECK \
  post_finished_count MIGRATION_POST_FINISHED_COUNT_QUERY_FAILED 7
expect_psql_failure migration_failed_count_failure MIGRATION_POST_FAILED_COUNT_CHECK \
  post_failed_count MIGRATION_POST_FAILED_COUNT_QUERY_FAILED 8
expect_run_failure migration_ledger_count_mismatch MIGRATION_POST_LEDGER_COUNT_CHECK \
  post_ledger_count host_validator internal_validator shell_builtin MIGRATION_POST_LEDGER_COUNT_MISMATCH 9
expect_run_failure migration_applied_set_mismatch MIGRATION_POST_APPLIED_SET_COMPARE_CHECK \
  post_applied_set_compare host_validator internal_validator coreutils MIGRATION_POST_APPLIED_SET_MISMATCH 10
expect_run_failure migration_duration_json_malformed MIGRATION_DURATION_RESULT_CHECK \
  duration_result_validation host_validator internal_validator coreutils MIGRATION_DURATION_RESULT_MALFORMED 11
expect_run_failure migration_schema_table_missing MIGRATION_SCHEMA_TABLE_CHECK \
  schema_table_validation host_validator internal_validator shell_builtin MIGRATION_SCHEMA_TABLE_MISSING 12
expect_run_failure migration_schema_column_missing MIGRATION_SCHEMA_COLUMN_CHECK \
  schema_column_validation host_validator internal_validator shell_builtin MIGRATION_SCHEMA_COLUMN_MISSING 13
expect_run_failure migration_schema_index_missing MIGRATION_SCHEMA_INDEX_CHECK \
  schema_index_validation host_validator internal_validator shell_builtin MIGRATION_SCHEMA_INDEX_MISSING 14
expect_run_failure migration_schema_unique_key_missing MIGRATION_SCHEMA_UNIQUE_KEY_CHECK \
  schema_unique_key_validation host_validator internal_validator shell_builtin MIGRATION_SCHEMA_UNIQUE_KEY_MISSING 15

reset_state
MOCK_WRITE_STATUS=16
set +e
pm_migration_write_bounded /offline/prisma-diff.log MIGRATION_PRISMA_DIFF_EXECUTION_CHECK prisma_diff_execution \
  prisma_diff prisma docker_cli 600 PRISMA_DIFF_TIMEOUT MIGRATION_PRISMA_DIFF_EXECUTION_FAILED offline-command-fixture
diff_execution_status=$?
set -e
[[ $diff_execution_status -eq 16 && $MIGRATION_CHECK_ID == MIGRATION_PRISMA_DIFF_EXECUTION_CHECK && \
  $MIGRATION_SUBSTEP == prisma_diff_execution && $MIGRATION_RUNNER_ROLE == prisma_diff && \
  $MIGRATION_COMMAND_CATEGORY == prisma && $MIGRATION_EXECUTABLE_CATEGORY == docker_cli && \
  $MIGRATION_COMMAND_STARTED == true && $MIGRATION_ATTEMPT_COUNT -eq 1 && \
  $MIGRATION_ORIGINAL_EXIT -eq 16 && $MIGRATION_PRIMARY_CLASSIFICATION == MIGRATION_PRISMA_DIFF_EXECUTION_FAILED ]]
pass migration_prisma_diff_execution_failure

expect_run_failure migration_prisma_diff_legacy_gate_rejection MIGRATION_PRISMA_DIFF_GATE_CHECK \
  prisma_diff_gate prisma_diff internal_validator posix_shell MIGRATION_PRISMA_DIFF_REJECTED 1

[[ $(wc -l <"$SCRIPT_DIR/migration-sql-bindings.txt") -eq 8 && \
  $(sha256sum -- "$SCRIPT_DIR/migration-sql-bindings.txt" | awk '{print $1}') == "$EXACT_EIGHT_SHA256" ]]
pass exact_eight_unchanged

[[ $PASS_COUNT -eq 14 ]]
printf 'MIGRATION_VERIFICATION_TEST_COUNT=14\nROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\nDATABASE_CONNECTED=NO\n'
