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
  FIXTURE_VERSION_VALUE=('16.14')
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
pm_postgres_wait_version server_version 16.14 3 30
[[ $server_version == 16.14 && $POSTGRES_VERSION_MATCHED == true && \
  $RESTORE_CHECK_ID == POSTGRES_SERVER_VERSION_MATCH_CHECK ]]
pass version_query_success

fixture_reset
FIXTURE_VERSION_STATUS=(125)
server_version=''
set +e
pm_postgres_wait_version server_version 16.14 3 30
status=$?
set -e
[[ $status -eq 125 && $PROBE_ERROR_CLASSIFICATION == POSTGRES_VERSION_QUERY_FAILED && \
  $RESTORE_CHECK_ID == POSTGRES_SERVER_VERSION_QUERY_CHECK ]]
pass version_query_failure

fixture_reset
FIXTURE_VERSION_VALUE=('15.9')
server_version=''
set +e
pm_postgres_wait_version server_version 16.14 3 30
status=$?
set -e
[[ $status -eq 67 && $PROBE_ERROR_CLASSIFICATION == POSTGRES_VERSION_MISMATCH && \
  $RESTORE_CHECK_ID == POSTGRES_SERVER_VERSION_MATCH_CHECK && $POSTGRES_VERSION_MATCHED == false ]]
pass version_mismatch

fixture_reset
PROBE_ERROR_CLASSIFICATION=POSTGRES_READINESS_COMMAND_FAILED
FIXTURE_READINESS_STATUS=(2 0)
pm_postgres_wait_readiness 3 30
[[ $PROBE_ERROR_CLASSIFICATION == NONE && $POSTGRES_STARTUP_STATUS == READINESS_CONFIRMED ]]
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
pass no_raw_logs

grep -F 'environmentValuesCaptured:false' "$SCRIPT_DIR/failure-diagnostics.sh" >/dev/null
pass no_environment_values

grep -F 'credentialsCaptured:false' "$SCRIPT_DIR/failure-diagnostics.sh" >/dev/null
pass no_credentials

fixture_reset
FIXTURE_READINESS_STATUS=(125)
set +e
pm_postgres_wait_readiness 3 30
status=$?
set -e
[[ $status -ne 0 && $PROBE_ERROR_CLASSIFICATION != NONE && $RESTORE_CHECK_ID != NONE ]]
pass no_silent_failure

old_postgres_startup_fixture() {
  local old_version='' old_status
  pm_postgres_wait_readiness 3 30 || return
  RESTORE_CHECK_ID=NONE
  if pm_postgres_execute_version old_version; then old_status=0; else old_status=$?; fi
  (( old_status == 0 )) || PROBE_ERROR_CLASSIFICATION=DISPOSABLE_DOCKER_FAILED
  return "$old_status"
}
fixture_reset
FIXTURE_VERSION_STATUS=(2)
set +e
old_postgres_startup_fixture
status=$?
set -e
[[ $status -eq 2 && $PROBE_ERROR_CLASSIFICATION == DISPOSABLE_DOCKER_FAILED && $RESTORE_CHECK_ID == NONE ]]
pass previous_failure_reproduced

fixture_reset
FIXTURE_VERSION_STATUS=(2 0)
FIXTURE_VERSION_VALUE=('' '16.14')
server_version=''
pm_postgres_wait_readiness 3 30
pm_postgres_wait_version server_version 16.14 3 30
[[ $server_version == 16.14 && $POSTGRES_VERSION_QUERY_ATTEMPTS -eq 2 && \
  $POSTGRES_VERSION_TRANSIENT_COUNT -eq 1 && $POSTGRES_STARTUP_STATUS == READY ]]
pass corrected_startup_fixture

fixture_reset
FIXTURE_READINESS_STATUS=(2 0)
set -e
pm_postgres_wait_readiness 3 30
[[ $- == *e* ]]
pass errexit_state_preserved

[[ $PASS_COUNT -eq 22 ]]
printf 'POSTGRES_STARTUP_TEST_COUNT=22\nPREVIOUS_FAILURE=REPRODUCED\nCORRECTED_FIXTURE=PASS\nROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\nDATABASE_CONNECTED=NO\n'
