#!/usr/bin/env bash
# Real non-root/nounset regression tests. No Docker or root probe execution.
# shellcheck disable=SC2034,SC2154
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=release/personal-max-stage8b1i/bounded-operations.sh
source "$SCRIPT_DIR/bounded-operations.sh"
# shellcheck source=release/personal-max-stage8b1i/failure-diagnostics.sh
source "$SCRIPT_DIR/failure-diagnostics.sh"

TEST_TMP=$(mktemp -d /tmp/personal-max-stage8b1i-output-handoff.XXXXXX)
trap 'rm -rf -- "$TEST_TMP"' EXIT
PASS_COUNT=0
PROBE_PHASE=storage_gate
PROBE_SAFE_COMMAND_CLASS=filesystem_metadata
PROBE_ERROR_CLASSIFICATION=NONE
PM_SCRIPT_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PM_FAILURE_PATH=/var/tmp/personal-max-stage8b1i-isolated-release-proof.failure.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json
SUCCESS_REPORT="$TEST_TMP/success.json"
REQUIRED_FREE_BYTES=12500000000
PROBE_BUDGET_BYTES=2172240240
CLEANUP_CONTAINERS_REMAINING=unknown
CLEANUP_NETWORKS_REMAINING=unknown
CLEANUP_VOLUMES_REMAINING=unknown
CLEANUP_TEMP_FILES_REMAINING=unknown
GATEWAY_PREEXISTING_BEFORE_PULL=false
SCRAPER_PREEXISTING_BEFORE_PULL=false
GATEWAY_ACQUIRED_DURING_PROBE=false
SCRAPER_ACQUIRED_DURING_PROBE=false

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '%s=PASS\n' "$1"; }

old_pm_capture_bounded_fixture() {
  local target_name=$1 output
  shift
  output=$("$@")
  printf -v "$target_name" '%s' "$output"
}

old_fixture_caller() {
  local output
  old_pm_capture_bounded_fixture output printf old-value
  printf '%s' "$output"
}

set +e
old_fixture_stderr=$(bash -c 'set -u; old_pm_capture_bounded_fixture() { local target_name=$1 output; shift; output=$("$@"); printf -v "$target_name" "%s" "$output"; }; old_fixture_caller() { local output; old_pm_capture_bounded_fixture output printf old-value; printf "%s" "$output"; }; old_fixture_caller' 2>&1)
old_fixture_status=$?
set -e
[[ $old_fixture_status -ne 0 && $old_fixture_stderr == *'unbound variable'* ]]
pass old_defect_reproduction

capture_named_target() {
  local __case_name=$1
  local "$__case_name"
  pm_capture_bounded "$__case_name" mock 5 METADATA_TIMEOUT METADATA_FAILED printf collision-safe
  local -n __case_ref="$__case_name"
  [[ $__case_ref == collision-safe ]]
}

for collision_name in output status line data source target target_name command_class seconds timeout_class failure_class had_errexit captured result; do
  capture_named_target "$collision_name"
done
pass collision_matrix

fixed_output_caller() {
  local output
  pm_capture_bounded output mock 5 METADATA_TIMEOUT METADATA_FAILED printf fixed-value
  printf '%s' "$output"
}
[[ $(fixed_output_caller) == fixed-value ]]
pass fixed_exact_caller

unset empty_result || true
pm_capture_bounded empty_result mock 5 METADATA_TIMEOUT METADATA_FAILED printf ''
[[ ${empty_result+x} == x && -z $empty_result ]]
pass empty_stdout

pm_capture_bounded one_line mock 5 METADATA_TIMEOUT METADATA_FAILED printf one-line
[[ $one_line == one-line ]]
pass one_line_stdout

pm_capture_bounded multiline mock 5 METADATA_TIMEOUT METADATA_FAILED printf 'one\ntwo\nthree'
[[ $multiline == $'one\ntwo\nthree' ]]
pass multiline_stdout

pm_capture_bounded trailing mock 5 METADATA_TIMEOUT METADATA_FAILED printf 'trailing\n\n'
[[ $trailing == trailing ]]
pass trailing_newline_semantics

set +e
pm_capture_bounded exit_one mock 5 METADATA_TIMEOUT METADATA_FAILED sh -c 'exit 1'
exit_one_status=$?
set -e
[[ $exit_one_status -eq 1 && $PROBE_ERROR_CLASSIFICATION == METADATA_FAILED ]]
pass command_exit_1

set +e
pm_capture_bounded exit_124 mock 5 METADATA_TIMEOUT METADATA_FAILED sh -c 'exit 124'
exit_124_status=$?
set -e
[[ $exit_124_status -eq 124 && $PROBE_ERROR_CLASSIFICATION == METADATA_TIMEOUT ]]
pass command_exit_124

set +e
pm_capture_bounded timed_out mock 1 SYNTHETIC_HARNESS_TIMEOUT METADATA_FAILED sh -c 'sleep 2'
timeout_status=$?
set -e
[[ $timeout_status -eq 124 && $PROBE_ERROR_CLASSIFICATION == SYNTHETIC_HARNESS_TIMEOUT ]]
pass real_timeout

nested_capture() {
  local result
  pm_capture_bounded result mock 5 METADATA_TIMEOUT METADATA_FAILED printf nested
  printf '%s' "$result"
}
[[ $(nested_capture) == nested ]]
pass nested_function

cleanup_capture() {
  local output
  pm_capture_bounded output cleanup 5 CONTAINER_REMOVAL_TIMEOUT CLEANUP_INCOMPLETE "$@" || return
  printf '%s' "$output"
}
[[ -z $(cleanup_capture printf '') ]]
pass cleanup_empty_inventory

set +e
cleanup_capture sh -c 'exit 1' >/dev/null
cleanup_failure_status=$?
set -e
[[ $cleanup_failure_status -eq 1 && $PROBE_ERROR_CLASSIFICATION == CLEANUP_INCOMPLETE ]]
pass cleanup_inventory_failure

set +e
primary_failure_stderr=$( (pm_capture_bounded() { return 64; }; personal_max_stage8b1i_render_failure 42 97 false) 2>&1)
primary_failure_status=$?
set -e
[[ $primary_failure_status -eq 74 && $primary_failure_stderr != *'unbound variable'* ]]
pass diagnostics_after_capture_failure

emergency_path="$TEST_TMP/sanitized-failure.json"
(pm_capture_bounded() { return 64; }; pm_run_bounded() { return 64; }; \
  personal_max_stage8b1i_write_emergency_json "$emergency_path" 42 storage_gate METADATA_FAILED)
jq -e '.mode=="ISOLATED_RELEASE_PROOF_EMERGENCY_FAILURE" and .exitCode==42 and
  .diagnostics.rawCommandCaptured==false and .diagnostics.rawSqlCaptured==false and
  .diagnostics.rawStderrCaptured==false and .diagnostics.credentialsCaptured==false' "$emergency_path" >/dev/null
pass emergency_without_wrapper_library

preserved=$(pm_preserve_original_exit 42 70)
[[ $preserved == 42 ]]
pass original_exit_preserved

[[ $old_fixture_stderr == *'unbound variable'* && $primary_failure_stderr != *'unbound variable'* ]]
pass no_new_unbound_variable

[[ ! -e $SUCCESS_REPORT && ! -L $SUCCESS_REPORT ]]
pass success_report_absent_on_failure

[[ -f $emergency_path && ! -L $emergency_path ]]
pass sanitized_failure_created

invalid_target_status=0
set +e
pm_capture_bounded 'bad-target' mock 5 METADATA_TIMEOUT METADATA_FAILED printf refused
invalid_target_status=$?
set -e
[[ $invalid_target_status -eq 64 && $PROBE_ERROR_CLASSIFICATION == INVALID_OUT_PARAMETER ]]
pass invalid_target_refused

reserved_target_status=0
set +e
pm_capture_bounded __pm_internal mock 5 METADATA_TIMEOUT METADATA_FAILED printf refused
reserved_target_status=$?
set -e
[[ $reserved_target_status -eq 64 && $PROBE_ERROR_CLASSIFICATION == INVALID_OUT_PARAMETER ]]
pass reserved_prefix_refused

if rg -n '(password|database_url|postgresql://|hmac|private[_ -]?key|token|secret-value)' \
  "$emergency_path" "$TEST_TMP"/*.json >/dev/null; then exit 1; fi
pass no_secret_leakage

[[ $PASS_COUNT -eq 22 ]]
printf 'OLD_FIXTURE=FAIL_AS_EXPECTED\nFIXED_IMPLEMENTATION=PASS\nEXECUTABLE_TEST_COUNT=22\nROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\n'
