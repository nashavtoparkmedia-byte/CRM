#!/usr/bin/env bash
# Offline migration-preflight diagnostics and permission regression suite.
# No Docker socket, database, root probe, migration, network, MAX, or provider
# action is used. The docker command below is a shell fixture only.
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd -P)
readonly REPO_ROOT
source "$SCRIPT_DIR/bounded-operations.sh"
source "$SCRIPT_DIR/probe-output-helpers.sh"
source "$SCRIPT_DIR/migration-preflight.sh"

TEST_TMP=$(mktemp -d /tmp/personal-max-stage8b1i-migration-preflight.XXXXXX)
trap 'chmod -R u+rwX "$TEST_TMP" 2>/dev/null || true; rm -rf -- "$TEST_TMP"' EXIT
TMP=$TEST_TMP
PASS_COUNT=0
PROBE_ERROR_CLASSIFICATION=NONE
PROBE_SAFE_COMMAND_CLASS=package_validation

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '%s=PASS\n' "$1"; }
pm_test_timeout() { shift 3; "$@"; }
PM_TIMEOUT_BIN=pm_test_timeout

MOCK_CREATE_STATUS=0
MOCK_CREATE_OUTPUT=fixture-container-id
MOCK_START_STATUS=0
MOCK_START_STDERR=''
MOCK_INSPECT_STATUS=0
MOCK_CONTAINER_STATE=exited
MOCK_CONTAINER_EXIT=0

docker() {
  case ${1:-} in
    create)
      printf '%s\n' "$MOCK_CREATE_OUTPUT"
      return "$MOCK_CREATE_STATUS"
      ;;
    start)
      [[ -z $MOCK_START_STDERR ]] || printf '%s\n' "$MOCK_START_STDERR" >&2
      return "$MOCK_START_STATUS"
      ;;
    inspect)
      (( MOCK_INSPECT_STATUS == 0 )) || return "$MOCK_INSPECT_STATUS"
      printf '%s|%s\n' "$MOCK_CONTAINER_STATE" "$MOCK_CONTAINER_EXIT"
      ;;
    *) return 64 ;;
  esac
}

reset_runner() {
  MOCK_CREATE_STATUS=0
  MOCK_CREATE_OUTPUT=fixture-container-id
  MOCK_START_STATUS=0
  MOCK_START_STDERR=''
  MOCK_INSPECT_STATUS=0
  MOCK_CONTAINER_STATE=exited
  MOCK_CONTAINER_EXIT=0
  PROBE_ERROR_CLASSIFICATION=NONE
  MIGRATION_PRIMARY_CLASSIFICATION=NONE
}

old_gate="$TEST_TMP/old-unreadable-gate.sh"
cp -- "$SCRIPT_DIR/migration-sql-gate.sh" "$old_gate"
chmod 000 "$old_gate"
set +e
/bin/sh "$old_gate" "$REPO_ROOT/gravity-mvp/prisma/migrations" "$SCRIPT_DIR/migration-sql-bindings.txt" >/dev/null 2>/dev/null
old_status=$?
set -e
[[ $old_status -eq 2 ]]
pass old_permission_failure_reproduced

runtime_gate="$TEST_TMP/runtime-gate.sh"
pm_migration_prepare_runtime_file "$SCRIPT_DIR/migration-sql-gate.sh" "$runtime_gate" \
  9faf24f9aacbd48c27d5e8cff8b0bfdcc92570a9d314232969fd684d70539bda 1000 1000
runtime_stat=$(stat -c '%u:%g:%a' "$runtime_gate")
IFS=: read -r runtime_uid runtime_gid runtime_mode <<<"$runtime_stat"
pm_migration_mode_allows_read "$runtime_uid" "$runtime_gid" "$runtime_mode" 1000 1000
/bin/sh "$runtime_gate" "$REPO_ROOT/gravity-mvp/prisma/migrations" "$SCRIPT_DIR/migration-sql-bindings.txt" >/dev/null
[[ $runtime_mode == 444 ]]
pass corrected_runtime_binding

reset_runner
MOCK_START_STATUS=2
MOCK_CONTAINER_EXIT=2
set +e
pm_migration_start_runner fixture sql_gate "$TEST_TMP/sql-gate.out"
exit_two_status=$?
set -e
[[ $exit_two_status -eq 2 && $MIGRATION_CHECK_ID == MIGRATION_SQL_RUNNER_START_CHECK && \
  $MIGRATION_PRIMARY_CLASSIFICATION == MIGRATION_SQL_GATE_EXIT_2 && $MIGRATION_ORIGINAL_EXIT -eq 2 && \
  $MIGRATION_CONTAINER_STATE_CATEGORY == exited ]]
pass exit_two_source_attribution

set +e
pm_migration_reject_before_command MIGRATION_DATABASE_URL_CONSTRUCTION_CHECK database_url_construction \
  host_validator internal_validator shell_builtin MIGRATION_COMMAND_NOT_STARTED 64
not_started_status=$?
set -e
[[ $not_started_status -eq 64 && $MIGRATION_COMMAND_STARTED == false && \
  $MIGRATION_CONTAINER_STATE_CATEGORY == command_not_started ]]
pass command_not_started

reset_runner
MOCK_CREATE_STATUS=125
set +e
pm_migration_create_runner create_result MIGRATION_SQL_RUNNER_CREATE_CHECK sql_runner_create sql_gate docker create fixture
cli_status=$?
set -e
[[ $cli_status -eq 125 && $MIGRATION_PRIMARY_CLASSIFICATION == MIGRATION_DOCKER_CLI_FAILED ]]
pass docker_cli_failure

reset_runner
MOCK_CREATE_STATUS=1
set +e
pm_migration_create_runner create_result MIGRATION_SQL_RUNNER_CREATE_CHECK sql_runner_create sql_gate docker create fixture
create_status=$?
set -e
[[ $create_status -eq 1 && $MIGRATION_PRIMARY_CLASSIFICATION == MIGRATION_RUNNER_CREATE_FAILED ]]
pass container_creation_failure

reset_runner
MOCK_START_STATUS=3
MOCK_CONTAINER_EXIT=3
set +e
pm_migration_start_runner fixture sql_gate "$TEST_TMP/generic-exit.out"
runner_status=$?
set -e
[[ $runner_status -eq 3 && $MIGRATION_PRIMARY_CLASSIFICATION == MIGRATION_RUNNER_EXITED ]]
pass container_exited

for fixture in '127:MIGRATION_PRISMA_EXECUTABLE_MISSING:missing_runner_executable' \
  '1:MIGRATION_PRISMA_EXIT_1:prisma_exit_1' '2:MIGRATION_PRISMA_EXIT_2:prisma_exit_2'; do
  IFS=: read -r fixture_exit fixture_class fixture_name <<<"$fixture"
  reset_runner
  MOCK_START_STATUS=$fixture_exit
  MOCK_CONTAINER_EXIT=$fixture_exit
  set +e
  pm_migration_start_runner fixture prisma_deploy "$TEST_TMP/$fixture_name.out"
  fixture_status=$?
  set -e
  [[ $fixture_status -eq $fixture_exit && $MIGRATION_PRIMARY_CLASSIFICATION == "$fixture_class" ]]
  pass "$fixture_name"
done

reset_runner
MOCK_START_STATUS=124
set +e
pm_migration_start_runner fixture prisma_deploy "$TEST_TMP/prisma-timeout.out"
timeout_status=$?
set -e
[[ $timeout_status -eq 124 && $MIGRATION_PRIMARY_CLASSIFICATION == MIGRATION_PRISMA_TIMEOUT ]]
pass prisma_timeout

safe_url=preserved
set +e
pm_migration_build_database_url safe_url valid_user not-a-secret valid-host valid_db
url_status=$?
set -e
[[ $url_status -eq 64 && $safe_url == preserved && \
  $MIGRATION_PRIMARY_CLASSIFICATION == MIGRATION_DATABASE_URL_CONSTRUCTION_FAILED ]]
pass invalid_database_url_without_disclosure

set +e
pm_migration_validate_alias_facts 'fixture-network|["different-alias"]' \
  personal-max-stage8b1i-abcdef123456-internal personal-max-stage8b1i-abcdef123456-postgres
alias_status=$?
set -e
[[ $alias_status -eq 65 && $MIGRATION_PRIMARY_CLASSIFICATION == MIGRATION_NETWORK_ALIAS_MISMATCH ]]
pass missing_network_alias

set +e
pm_migration_validate_runner_identity 'wrong-image|1000:1000|none' accepted-image 1000:1000 none sql_gate
identity_status=$?
set -e
[[ $identity_status -eq 65 && $MIGRATION_PRIMARY_CLASSIFICATION == MIGRATION_RUNNER_IDENTITY_MISMATCH ]]
pass wrong_runner_identity

bad_bindings="$TEST_TMP/bad-bindings.txt"
cp -- "$SCRIPT_DIR/migration-sql-bindings.txt" "$bad_bindings"
sed -i '1s/^./0/' "$bad_bindings"
set +e
/bin/sh "$SCRIPT_DIR/migration-sql-gate.sh" "$REPO_ROOT/gravity-mvp/prisma/migrations" "$bad_bindings" >/dev/null 2>/dev/null
binding_status=$?
set -e
[[ $binding_status -ne 0 && $(pm_migration_runner_exit_classification sql_gate 64) == MIGRATION_SQL_BINDING_MISMATCH ]]
pass migration_binding_mismatch

set +e
/bin/sh "$SCRIPT_DIR/migration-sql-gate.sh" "$TEST_TMP/missing-migrations" "$SCRIPT_DIR/migration-sql-bindings.txt" >/dev/null 2>/dev/null
missing_dir_status=$?
pm_migration_reject_before_command MIGRATION_RUNTIME_BINDING_CHECK runtime_file_binding sql_gate \
  internal_validator posix_shell MIGRATION_DIRECTORY_MISSING 66
missing_dir_class_status=$?
set -e
[[ $missing_dir_status -eq 66 && $(pm_migration_runner_exit_classification sql_gate "$missing_dir_status") == MIGRATION_DIRECTORY_MISSING && \
  $missing_dir_class_status -eq 66 && \
  $MIGRATION_PRIMARY_CLASSIFICATION == MIGRATION_DIRECTORY_MISSING ]]
pass missing_migration_directory

[[ $(wc -l <"$SCRIPT_DIR/migration-sql-bindings.txt") -eq 8 ]]
/bin/sh "$SCRIPT_DIR/migration-sql-gate.sh" "$REPO_ROOT/gravity-mvp/prisma/migrations" \
  "$SCRIPT_DIR/migration-sql-bindings.txt" >/dev/null
pass exact_eight_preserved

pm_migration_enter_check MIGRATION_SQL_RUNNER_START_CHECK sql_runner_start sql_gate docker_start docker_cli
set +e
pm_migration_record_failure MIGRATION_SQL_GATE_EXIT_2 2 exited
first_status=$?
PROBE_ERROR_CLASSIFICATION=DISPOSABLE_DOCKER_FAILED
pm_migration_record_failure MIGRATION_RUNNER_EXITED 3 exited
second_status=$?
set -e
[[ $first_status -eq 2 && $second_status -eq 2 && $MIGRATION_PRIMARY_CLASSIFICATION == MIGRATION_SQL_GATE_EXIT_2 && \
  $PROBE_ERROR_CLASSIFICATION == MIGRATION_SQL_GATE_EXIT_2 && $MIGRATION_ORIGINAL_EXIT -eq 2 ]]
pass primary_classification_preserved

for check in MIGRATION_DATABASE_URL_CONSTRUCTION_CHECK MIGRATION_INVENTORY_CHECK MIGRATION_PENDING_SET_CHECK \
  MIGRATION_REPOSITORY_COUNT_CHECK MIGRATION_APPLIED_ONLY_CHECK MIGRATION_RUNTIME_BINDING_CHECK \
  MIGRATION_SQL_RUNNER_CREATE_CHECK MIGRATION_SQL_RUNNER_IDENTITY_CHECK MIGRATION_SQL_RUNNER_START_CHECK \
  MIGRATION_POSTGRES_ALIAS_CHECK MIGRATION_SHADOW_DATABASE_CREATE_CHECK MIGRATION_PRISMA_RUNNER_CREATE_CHECK \
  MIGRATION_PRISMA_RUNNER_IDENTITY_CHECK MIGRATION_PRISMA_EXECUTABLE_CHECK MIGRATION_PRISMA_DEPLOY_CHECK \
  MIGRATION_POST_LEDGER_CHECK MIGRATION_POST_SCHEMA_CHECK MIGRATION_PRISMA_DIFF_CHECK; do
  pm_migration_check_id_is_safe "$check"
  [[ $check != NONE ]]
done
pass check_id_never_none_after_entry

rg -F 'trap on_exit EXIT' "$SCRIPT_DIR/isolated-release-probe.sh" >/dev/null
rg -F -- '--filter "label=$STAGE_LABEL"' "$SCRIPT_DIR/probe-output-helpers.sh" >/dev/null
rg -F -- '--filter "label=$RUN_LABEL_KEY=$__pm_run_id"' "$SCRIPT_DIR/probe-output-helpers.sh" >/dev/null
rg -F 'globalPrune:false' "$SCRIPT_DIR/failure-diagnostics.sh" >/dev/null
pass cleanup_contract_preserved

rg -F "readonly ACCEPTED_PRODUCTION_HEAD='e6a0a833fbb756216b058bfe326f9f9c77c4cc6d'" \
  "$SCRIPT_DIR/isolated-release-probe.sh" >/dev/null
rg -F "readonly ACCEPTED_PRODUCTION_STATUS_V2_RAW_SHA256='2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b'" \
  "$SCRIPT_DIR/isolated-release-probe.sh" >/dev/null
pass production_immutability_constants

for classification in MIGRATION_RUNNER_CREATE_FAILED MIGRATION_RUNNER_START_FAILED MIGRATION_RUNNER_EXITED \
  MIGRATION_DOCKER_CLI_FAILED MIGRATION_DOCKER_EXEC_FAILED MIGRATION_CONTAINER_UNAVAILABLE \
  MIGRATION_NETWORK_ALIAS_MISMATCH MIGRATION_DATABASE_URL_CONSTRUCTION_FAILED \
  MIGRATION_PRISMA_EXECUTABLE_MISSING MIGRATION_PRISMA_COMMAND_REJECTED MIGRATION_PRISMA_EXIT_1 \
  MIGRATION_PRISMA_EXIT_2 MIGRATION_PRISMA_TIMEOUT MIGRATION_SQL_BINDING_MISMATCH \
  MIGRATION_DIRECTORY_MISSING MIGRATION_DEPLOY_FAILED MIGRATION_POST_VERIFICATION_FAILED \
  MIGRATION_INTERNAL_VALIDATOR_FAILED MIGRATION_RUNTIME_FILE_UNREADABLE; do
  pm_migration_classification_is_safe "$classification"
  rg -F "$classification" "$SCRIPT_DIR/failure-diagnostics.sh" >/dev/null
done
jq -e '(.allOf[1].then.required|index("migrationPreflight")) and
  (.allOf[1].then.properties.migrationPreflight.required|index("primaryClassification")) and
  .allOf[1].then.properties.migrationPreflight.properties.rawStderrCaptured.const==false and
  .allOf[1].then.properties.migrationPreflight.properties.databaseUrlCaptured.const==false and
  .allOf[1].then.properties.migrationPreflight.properties.credentialsCaptured.const==false' \
  "$SCRIPT_DIR/report-schema.json" >/dev/null
pass report_schema_classifications

if rg -n 'printf.*(DATABASE_URL|__pm_password)|echo.*(DATABASE_URL|__pm_password)' \
    "$SCRIPT_DIR/migration-preflight.sh" "$SCRIPT_DIR/failure-diagnostics.sh" >/dev/null; then exit 1; fi
rg -F 'databaseUrlCaptured:false' "$SCRIPT_DIR/failure-diagnostics.sh" >/dev/null
rg -F 'credentialsCaptured:false' "$SCRIPT_DIR/failure-diagnostics.sh" >/dev/null
pass secrets_absent

reset_runner
MOCK_START_STATUS=2
MOCK_CONTAINER_EXIT=2
MOCK_START_STDERR='PRIVATE_STDERR_SENTINEL'
set +e
stderr_output=$(pm_migration_start_runner fixture sql_gate "$TEST_TMP/stderr.out" 2>&1)
stderr_status=$?
set -e
[[ $stderr_status -eq 2 && $stderr_output != *PRIVATE_STDERR_SENTINEL* && \
  ! -s $TEST_TMP/stderr.out ]]
pass raw_stderr_not_emitted

reset_runner
PROBE_ERROR_CLASSIFICATION=MIGRATION_PRISMA_EXIT_2
MIGRATION_PRIMARY_CLASSIFICATION=MIGRATION_PRISMA_EXIT_2
pm_migration_start_runner fixture prisma_deploy "$TEST_TMP/success.out"
[[ $MIGRATION_ORIGINAL_EXIT -eq 0 && $MIGRATION_PRIMARY_CLASSIFICATION == NONE && \
  $PROBE_ERROR_CLASSIFICATION == NONE && $MIGRATION_COMMAND_STARTED == true && $MIGRATION_ATTEMPT_COUNT -eq 1 ]]
pass successful_preflight_clears_transient

gate_sha=$(sha256sum "$SCRIPT_DIR/migration-sql-gate.sh" | awk '{print $1}')
bindings_sha=$(sha256sum "$SCRIPT_DIR/migration-sql-bindings.txt" | awk '{print $1}')
[[ $gate_sha == 9faf24f9aacbd48c27d5e8cff8b0bfdcc92570a9d314232969fd684d70539bda && \
  $bindings_sha == 9128eba91ecb5ce9d010015031050379cd45941fff93bef721df889040a56f8f ]]
rg -F "readonly MIGRATION_SQL_GATE_SHA256='$gate_sha'" "$SCRIPT_DIR/isolated-release-probe.sh" >/dev/null
rg -F "readonly MIGRATION_SQL_BINDINGS_SHA256='$bindings_sha'" "$SCRIPT_DIR/isolated-release-probe.sh" >/dev/null
pass package_checksum_bindings

[[ $PASS_COUNT -eq 26 ]]
printf 'MIGRATION_PREFLIGHT_TEST_COUNT=26\nOLD_EXIT_2_REPRODUCED=YES\nCORRECTED_PERMISSION_FIXTURE=PASS\nROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\nDATABASE_CONNECTED=NO\n'
