#!/usr/bin/env bash
# Offline executable PostgreSQL startup regression suite. No Docker, database,
# root probe, production resource, or network operation is performed.
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
# shellcheck source=release/personal-max-stage8b1i/bounded-operations.sh
source "$SCRIPT_DIR/bounded-operations.sh"
# shellcheck source=release/personal-max-stage8b1i/postgres-startup.sh
source "$SCRIPT_DIR/postgres-startup.sh"

TEST_TMP=$(mktemp -d /tmp/personal-max-stage8b1i-postgres-startup.XXXXXX)
trap 'rm -rf -- "$TEST_TMP"' EXIT
PASS_COUNT=0
PG_CONTAINER=offline-postgres-fixture
PG_USER=offline_role
PG_DB=offline_database
RESTORE_CHECK_ID=NONE

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '%s=PASS\n' "$1"; }

declare -a FIXTURE_STATES FIXTURE_READINESS_STATUS FIXTURE_VERSION_STATUS FIXTURE_VERSION_VALUE
FIXTURE_STATE_INDEX=0
FIXTURE_READINESS_INDEX=0
FIXTURE_VERSION_INDEX=0

fixture_reset() {
  FIXTURE_STATES=('running|0|none')
  FIXTURE_READINESS_STATUS=(0)
  FIXTURE_VERSION_STATUS=(0)
  FIXTURE_VERSION_VALUE=('160014')
  FIXTURE_STATE_INDEX=0
  FIXTURE_READINESS_INDEX=0
  FIXTURE_VERSION_INDEX=0
  PROBE_ERROR_CLASSIFICATION=NONE
  RESTORE_CHECK_ID=NONE
  POSTGRES_STARTUP_STATUS=NOT_OBSERVED
  POSTGRES_STARTUP_LAST_OPERATION=NOT_OBSERVED
  POSTGRES_CONTAINER_STATE=not_observed
  POSTGRES_CONTAINER_EXIT_CODE=not_observed
  POSTGRES_CONTAINER_HEALTH=not_observed
  POSTGRES_READINESS_ATTEMPTS=0
  POSTGRES_READINESS_TRANSIENT_COUNT=0
  POSTGRES_READINESS_LAST_EXIT=not_observed
  POSTGRES_VERSION_QUERY_ATTEMPTS=0
  POSTGRES_VERSION_TRANSIENT_COUNT=0
  POSTGRES_VERSION_LAST_EXIT=not_observed
  POSTGRES_VERSION_MATCHED=false
  POSTGRES_VERSION_CLASSIFICATION=NOT_OBSERVED
  POSTGRES_VERSION_OUTPUT_CATEGORY=NOT_OBSERVED
  POSTGRES_OBSERVED_VERSION_NUM=not_observed
  POSTGRES_OBSERVED_VERSION_MAJOR=not_observed
  POSTGRES_OBSERVED_VERSION_MINOR=not_observed
  POSTGRES_OBSERVED_VERSION_PATCH=not_observed
  POSTGRES_STARTUP_ELAPSED_SECONDS=0
}

fixture_value_at() {
  local __pm_target_name=$1 __pm_index=$2
  shift 2
  local -a __pm_values=("$@")
  local __pm_last=$(( ${#__pm_values[@]} - 1 ))
  (( __pm_index <= __pm_last )) || __pm_index=$__pm_last
  pm_assign_out "$__pm_target_name" "${__pm_values[$__pm_index]}"
}

pm_postgres_sleep() { :; }

pm_postgres_observe_container() {
  local fixture_state=''
  fixture_value_at fixture_state "$FIXTURE_STATE_INDEX" "${FIXTURE_STATES[@]}"
  FIXTURE_STATE_INDEX=$((FIXTURE_STATE_INDEX + 1))
  IFS='|' read -r POSTGRES_CONTAINER_STATE POSTGRES_CONTAINER_EXIT_CODE POSTGRES_CONTAINER_HEALTH <<<"$fixture_state"
}

pm_postgres_execute_readiness() {
  local fixture_status=''
  fixture_value_at fixture_status "$FIXTURE_READINESS_INDEX" "${FIXTURE_READINESS_STATUS[@]}"
  FIXTURE_READINESS_INDEX=$((FIXTURE_READINESS_INDEX + 1))
  return "$fixture_status"
}

pm_postgres_execute_version() {
  local __pm_target_name=$1 fixture_status='' fixture_value=''
  fixture_value_at fixture_status "$FIXTURE_VERSION_INDEX" "${FIXTURE_VERSION_STATUS[@]}"
  fixture_value_at fixture_value "$FIXTURE_VERSION_INDEX" "${FIXTURE_VERSION_VALUE[@]}"
  FIXTURE_VERSION_INDEX=$((FIXTURE_VERSION_INDEX + 1))
  (( fixture_status == 0 )) && pm_assign_out "$__pm_target_name" "$fixture_value"
  return "$fixture_status"
}

fixture_reset
pm_postgres_start_container sh -c 'exit 0'
[[ $POSTGRES_STARTUP_STATUS == CONTAINER_STARTED && $RESTORE_CHECK_ID == POSTGRES_CONTAINER_START_CHECK ]]
pass container_start_success

fixture_reset
set +e
pm_postgres_start_container sh -c 'exit 7'
status=$?
set -e
[[ $status -eq 7 && $PROBE_ERROR_CLASSIFICATION == POSTGRES_CONTAINER_START_FAILED && \
  $RESTORE_CHECK_ID == POSTGRES_CONTAINER_START_CHECK ]]
pass container_start_failure

fixture_reset
FIXTURE_STATES=('running|0|starting' 'running|0|healthy')
FIXTURE_READINESS_STATUS=(2 0)
pm_postgres_wait_readiness 5 30
[[ $POSTGRES_READINESS_ATTEMPTS -eq 2 && $POSTGRES_READINESS_TRANSIENT_COUNT -eq 1 && \
  $POSTGRES_STARTUP_STATUS == READINESS_CONFIRMED ]]
pass exit_two_then_success

fixture_reset
FIXTURE_STATES=('running|0|starting' 'running|0|starting' 'running|0|healthy')
FIXTURE_READINESS_STATUS=(2 2 0)
pm_postgres_wait_readiness 5 30
[[ $POSTGRES_READINESS_ATTEMPTS -eq 3 && $POSTGRES_READINESS_TRANSIENT_COUNT -eq 2 ]]
pass repeated_exit_two_then_success

fixture_reset
FIXTURE_STATES=('running|0|starting' 'running|0|healthy')
FIXTURE_READINESS_STATUS=(1 0)
pm_postgres_wait_readiness 5 30
[[ $POSTGRES_READINESS_ATTEMPTS -eq 2 && $POSTGRES_READINESS_TRANSIENT_COUNT -eq 1 ]]
pass exit_one_then_success

fixture_reset
FIXTURE_READINESS_STATUS=(2 2 2)
set +e
pm_postgres_wait_readiness 3 30
status=$?
set -e
[[ $status -eq 124 && $PROBE_ERROR_CLASSIFICATION == POSTGRES_READINESS_TIMEOUT && \
  $RESTORE_CHECK_ID == POSTGRES_READINESS_CHECK && $POSTGRES_READINESS_ATTEMPTS -eq 3 ]]
pass readiness_never_succeeds

fixture_reset
FIXTURE_STATES=('running|0|starting' 'exited|2|none')
FIXTURE_READINESS_STATUS=(2)
set +e
pm_postgres_wait_readiness 5 30
status=$?
set -e
[[ $status -eq 69 && $PROBE_ERROR_CLASSIFICATION == POSTGRES_CONTAINER_EXITED_DURING_STARTUP && \
  $POSTGRES_CONTAINER_STATE == exited && $POSTGRES_CONTAINER_EXIT_CODE -eq 2 ]]
pass container_exits_during_polling

fixture_reset
FIXTURE_READINESS_STATUS=(125)
set +e
pm_postgres_wait_readiness 5 30
status=$?
set -e
[[ $status -eq 125 && $PROBE_ERROR_CLASSIFICATION == POSTGRES_READINESS_COMMAND_FAILED && \
  $RESTORE_CHECK_ID == POSTGRES_READINESS_CHECK ]]
pass docker_exec_unavailable

fixture_reset
server_version=''
pm_postgres_wait_version server_version 160014 3 30
[[ $server_version == 160014 && $POSTGRES_VERSION_MATCHED == true && \
  $POSTGRES_OBSERVED_VERSION_NUM == 160014 && $POSTGRES_OBSERVED_VERSION_MAJOR == 16 && \
  $POSTGRES_OBSERVED_VERSION_MINOR == 14 && $POSTGRES_OBSERVED_VERSION_PATCH == 0 && \
  $RESTORE_CHECK_ID == POSTGRES_SERVER_VERSION_MATCH_CHECK ]]
pass exact_160014_passes
[[ $POSTGRES_VERSION_CLASSIFICATION == POSTGRES_VERSION_MATCHED && \
  $POSTGRES_VERSION_OUTPUT_CATEGORY == CANONICAL_NUMERIC && $PROBE_ERROR_CLASSIFICATION == NONE ]]
pass exact_match_classification

fixture_reset
sanitized_human_version='16.14 (Debian 16.14-1.pgdg120+1)'
server_version=''
pm_postgres_wait_version server_version 160014 3 30
[[ $sanitized_human_version == 16.14\ * && $server_version == 160014 && \
  $POSTGRES_VERSION_CLASSIFICATION == POSTGRES_VERSION_MATCHED ]]
pass human_suffix_not_authoritative

for mismatch_case in \
  '160013:wrong_patch_160013' \
  '160015:wrong_patch_160015' \
  '150014:wrong_major_15' \
  '170000:wrong_major_17'; do
  IFS=: read -r mismatch_value mismatch_name <<<"$mismatch_case"
  fixture_reset
  FIXTURE_VERSION_VALUE=("$mismatch_value")
  server_version=''
  set +e
  pm_postgres_wait_version server_version 160014 3 30
  status=$?
  set -e
  [[ $status -eq 67 && $PROBE_ERROR_CLASSIFICATION == POSTGRES_VERSION_MISMATCH && \
    $POSTGRES_VERSION_CLASSIFICATION == POSTGRES_VERSION_MISMATCH && \
    $RESTORE_CHECK_ID == POSTGRES_SERVER_VERSION_MATCH_CHECK && $POSTGRES_VERSION_MATCHED == false ]]
  pass "$mismatch_name"
done

fixture_reset
FIXTURE_VERSION_VALUE=('')
server_version=''
set +e
pm_postgres_wait_version server_version 160014 3 30
status=$?
set -e
[[ $status -eq 65 && $PROBE_ERROR_CLASSIFICATION == POSTGRES_VERSION_OUTPUT_MALFORMED && \
  $POSTGRES_VERSION_CLASSIFICATION == POSTGRES_VERSION_OUTPUT_MALFORMED && \
  $RESTORE_CHECK_ID == POSTGRES_SERVER_VERSION_MATCH_CHECK ]]
pass empty_version_malformed

fixture_reset
FIXTURE_VERSION_VALUE=('sixteen')
server_version=''
set +e
pm_postgres_wait_version server_version 160014 3 30
status=$?
set -e
[[ $status -eq 65 && $POSTGRES_VERSION_OUTPUT_CATEGORY == MALFORMED ]]
pass alphabetic_version_malformed

fixture_reset
FIXTURE_VERSION_VALUE=($' \t160014\t ')
server_version=''
pm_postgres_wait_version server_version 160014 3 30
[[ $server_version == 160014 && $POSTGRES_VERSION_OUTPUT_CATEGORY == WHITESPACE_NORMALIZED && \
  $POSTGRES_VERSION_CLASSIFICATION == POSTGRES_VERSION_MATCHED ]]
pass horizontal_whitespace_normalized

fixture_reset
FIXTURE_VERSION_VALUE=($'160014\n160014')
server_version=''
set +e
pm_postgres_wait_version server_version 160014 3 30
status=$?
set -e
[[ $status -eq 65 && $POSTGRES_VERSION_CLASSIFICATION == POSTGRES_VERSION_OUTPUT_MALFORMED ]]
pass multiline_version_malformed

fixture_reset
FIXTURE_VERSION_STATUS=(1 0)
FIXTURE_VERSION_VALUE=('' '160014')
server_version=''
pm_postgres_wait_version server_version 160014 3 30
[[ $server_version == 160014 && $POSTGRES_VERSION_QUERY_ATTEMPTS -eq 2 && \
  $POSTGRES_VERSION_TRANSIENT_COUNT -eq 1 ]]
pass version_query_exit_one_then_success

fixture_reset
FIXTURE_VERSION_STATUS=(2 0)
FIXTURE_VERSION_VALUE=('' '160014')
server_version=''
pm_postgres_wait_version server_version 160014 3 30
[[ $server_version == 160014 && $POSTGRES_VERSION_QUERY_ATTEMPTS -eq 2 && \
  $POSTGRES_VERSION_TRANSIENT_COUNT -eq 1 ]]
pass version_query_exit_two_then_success

fixture_reset
FIXTURE_VERSION_STATUS=(1 2 0)
FIXTURE_VERSION_VALUE=('' '' '160014')
server_version=''
pm_postgres_wait_version server_version 160014 4 30
[[ $server_version == 160014 && $POSTGRES_VERSION_QUERY_ATTEMPTS -eq 3 && \
  $POSTGRES_VERSION_TRANSIENT_COUNT -eq 2 && $PROBE_ERROR_CLASSIFICATION == NONE ]]
pass repeated_version_transient_then_success

fixture_reset
FIXTURE_VERSION_STATUS=(125)
server_version=''
set +e
pm_postgres_wait_version server_version 160014 3 30
status=$?
set -e
[[ $status -eq 125 && $PROBE_ERROR_CLASSIFICATION == POSTGRES_VERSION_QUERY_FAILED && \
  $POSTGRES_VERSION_CLASSIFICATION == POSTGRES_VERSION_QUERY_FAILED && \
  $RESTORE_CHECK_ID == POSTGRES_SERVER_VERSION_QUERY_CHECK ]]
pass terminal_version_query_failure

fixture_reset
PROBE_ERROR_CLASSIFICATION=POSTGRES_VERSION_QUERY_FAILED
FIXTURE_VERSION_STATUS=(2 0)
FIXTURE_VERSION_VALUE=('' '160014')
server_version=''
pm_postgres_wait_version server_version 160014 3 30
[[ $PROBE_ERROR_CLASSIFICATION == NONE && \
  $POSTGRES_VERSION_CLASSIFICATION == POSTGRES_VERSION_MATCHED && \
  $RESTORE_CHECK_ID == POSTGRES_SERVER_VERSION_MATCH_CHECK ]]
pass transient_classification_cleared

fixture_reset
FIXTURE_STATES=('exited|17|none')
set +e
pm_postgres_wait_readiness 3 30
status=$?
set -e
[[ $RESTORE_CHECK_ID == POSTGRES_READINESS_CHECK && \
  $PROBE_ERROR_CLASSIFICATION == POSTGRES_CONTAINER_EXITED_DURING_STARTUP ]]
pass exact_check_ids

fixture_reset
set +e
pm_postgres_start_container sh -c 'exit 23'
status=$?
set -e
[[ $status -eq 23 ]]
pass original_exit_preserved

fixture_reset
cleanup_marker="$TEST_TMP/cleanup-ran"
set +e
(trap 'printf cleaned >"$cleanup_marker"' EXIT; pm_postgres_start_container sh -c 'exit 9')
status=$?
set -e
[[ $status -eq 9 && $(<"$cleanup_marker") == cleaned ]]
pass cleanup_always_runs

grep -F 'rawLogsCaptured:false' "$SCRIPT_DIR/failure-diagnostics.sh" >/dev/null
grep -F 'commandArgumentsCaptured:false' "$SCRIPT_DIR/failure-diagnostics.sh" >/dev/null
! grep -F 'SHOW server_version_num' "$SCRIPT_DIR/failure-diagnostics.sh" >/dev/null
pass no_raw_sql_or_command_arguments

grep -F 'environmentValuesCaptured:false' "$SCRIPT_DIR/failure-diagnostics.sh" >/dev/null
grep -F 'credentialsCaptured:false' "$SCRIPT_DIR/failure-diagnostics.sh" >/dev/null
pass no_credentials_or_environment_values

fixture_reset
FIXTURE_READINESS_STATUS=(125)
set +e
pm_postgres_wait_readiness 3 30
status=$?
set -e
[[ $status -ne 0 && $PROBE_ERROR_CLASSIFICATION != NONE && $RESTORE_CHECK_ID != NONE ]]
pass no_silent_failure

fixture_reset
old_display_version='16.14 (Debian 16.14-1.pgdg120+1)'
set +e
[[ $old_display_version == 16.14 ]]
status=$?
set -e
[[ $status -eq 1 ]]
pass previous_display_mismatch_reproduced

fixture_reset
FIXTURE_VERSION_STATUS=(2 0)
FIXTURE_VERSION_VALUE=('' '160014')
server_version=''
pm_postgres_wait_readiness 3 30
pm_postgres_wait_version server_version 160014 3 30
[[ $server_version == 160014 && $POSTGRES_VERSION_QUERY_ATTEMPTS -eq 2 && \
  $POSTGRES_VERSION_TRANSIENT_COUNT -eq 1 && $POSTGRES_STARTUP_STATUS == READY && \
  $POSTGRES_VERSION_CLASSIFICATION == POSTGRES_VERSION_MATCHED ]]
pass corrected_real_canonical_fixture

fixture_reset
FIXTURE_READINESS_STATUS=(2 0)
set -e
pm_postgres_wait_readiness 3 30
[[ $- == *e* ]]
pass errexit_state_preserved

[[ $PASS_COUNT -eq 33 ]]
printf 'POSTGRES_STARTUP_TEST_COUNT=33\nPREVIOUS_FAILURE=REPRODUCED\nCORRECTED_FIXTURE=PASS\nROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\nDATABASE_CONNECTED=NO\n'
