#!/usr/bin/env bash
# Real non-root/nounset regression tests. No Docker or root probe execution.
# shellcheck disable=SC2034,SC2154
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=release/personal-max-stage8b1i/bounded-operations.sh
source "$SCRIPT_DIR/bounded-operations.sh"
# shellcheck source=release/personal-max-stage8b1i/probe-output-helpers.sh
source "$SCRIPT_DIR/probe-output-helpers.sh"
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
TMP=$TEST_TMP
STAGE_LABEL='personal-max.stage=8b1i'
RUN_LABEL_KEY='personal-max.run-id'
RUN_ID=abcdef123456
PG_CONTAINER=stage8b1i-test-postgres
PG_USER=stage8b1i_test
PG_DB=stage8b1i_test

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

actual_sha=$(sha256sum -- "$SCRIPT_DIR/bounded-operations.sh" | awk '{print $1}')
actual_sha_target() {
  local __case_name=$1
  local "$__case_name"
  sha_of "$__case_name" "$SCRIPT_DIR/bounded-operations.sh"
  local -n __case_ref="$__case_name"
  [[ $__case_ref == "$actual_sha" ]]
}
for collision_name in output status line data source target target_name command_class seconds timeout_class failure_class had_errexit captured result; do
  actual_sha_target "$collision_name"
done
pass actual_sha_helper_collision_matrix

local_free=''
free_bytes_at local_free "$TEST_TMP"
[[ $local_free =~ ^[0-9]+$ && $local_free -gt 0 ]]
pass actual_free_bytes_helper

sorted_hash=''
hash_sorted_text sorted_hash $'z\na\nz'
expected_sorted_hash=$(printf 'a\nz\nz\n' | sha256sum | awk '{print $1}')
[[ $sorted_hash == "$expected_sorted_hash" ]]
pass actual_hash_sorted_helper

raw_hash=''
hash_raw_command raw_hash mock 5 METADATA_TIMEOUT METADATA_FAILED printf 'z\na\n'
expected_raw_hash=$(printf 'z\na\n' | sha256sum | awk '{print $1}')
unexpected_sorted_hash=$(printf 'z\na\n' | LC_ALL=C sort | sha256sum | awk '{print $1}')
[[ $raw_hash == "$expected_raw_hash" && $raw_hash != "$unexpected_sorted_hash" ]]
pass actual_hash_raw_command_helper

accepted_head=e6a0a833fbb756216b058bfe326f9f9c77c4cc6d
accepted_status=2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b
pm_assert_production_git_baseline "$accepted_head" "$accepted_status" "$accepted_head" "$accepted_status"
set +e
pm_assert_production_git_baseline "$accepted_head" \
  da66236a87d28812c710b2773b1d0375cd94c1a29cdd3b808e424d2a0482b5dc \
  "$accepted_head" "$accepted_status"
baseline_status=$?
set -e
[[ $baseline_status -eq 67 && $PROBE_ERROR_CLASSIFICATION == PRODUCTION_GIT_BASELINE_MISMATCH ]]
pass production_git_baseline_gate

pm_test_timeout() {
  shift 3
  "$@"
}

docker() {
  case ${PM_TEST_DOCKER_MODE:-} in
    cleanup_empty) return 0 ;;
    cleanup_multiline) printf 'object-a\nobject-b\n' ;;
    cleanup_failure) return 1 ;;
    image_present) printf 'sha256:%064d\n' 0 ;;
    image_absent) return 0 ;;
    image_failure) return 1 ;;
    psql_value) printf '42\n' ;;
    *) return 64 ;;
  esac
}

PM_TIMEOUT_BIN=pm_test_timeout
PM_TEST_DOCKER_MODE=cleanup_empty
actual_inventory=sentinel
cleanup_inventory actual_inventory containers 5
[[ -z $actual_inventory ]]
PM_TEST_DOCKER_MODE=cleanup_multiline
cleanup_inventory actual_inventory networks 5
[[ $actual_inventory == $'object-a\nobject-b' ]]
pass actual_cleanup_inventory_outputs

PM_TEST_DOCKER_MODE=cleanup_failure
set +e
cleanup_inventory actual_inventory volumes 5
actual_cleanup_status=$?
set -e
[[ $actual_cleanup_status -eq 1 && $PROBE_ERROR_CLASSIFICATION == CLEANUP_INCOMPLETE ]]
pass actual_cleanup_inventory_failure

PM_TEST_DOCKER_MODE=image_present
image_present=false
image_id=absent
image_presence image_present image_id example.invalid/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
[[ $image_present == true && $image_id == sha256:0000000000000000000000000000000000000000000000000000000000000000 ]]
PM_TEST_DOCKER_MODE=image_absent
image_presence image_present image_id example.invalid/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
[[ $image_present == false && $image_id == absent ]]
pass actual_image_presence_outputs

PM_TEST_DOCKER_MODE=image_failure
set +e
image_presence image_present image_id example.invalid/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
actual_image_status=$?
set -e
[[ $actual_image_status -eq 1 && $PROBE_ERROR_CLASSIFICATION == METADATA_FAILED ]]
pass actual_image_presence_failure

PM_TEST_DOCKER_MODE=psql_value
actual_psql=''
psql_value actual_psql 'SELECT 42'
[[ $actual_psql == 42 ]]
pass actual_psql_value_helper

pm_result_checksum_line=''
sha_of pm_result_checksum_line "$SCRIPT_DIR/bounded-operations.sh"
[[ $pm_result_checksum_line == "$actual_sha" ]]
pass approved_pm_result_destination

bootstrap_functions=$(
  sed -n '/^bootstrap_validate_out_name()/p' "$SCRIPT_DIR/isolated-release-probe.sh"
  sed -n '/^bootstrap_validate_internal_out_name()/p' "$SCRIPT_DIR/isolated-release-probe.sh"
  sed -n '/^bootstrap_reject_out_collision()/,/^}/p' "$SCRIPT_DIR/isolated-release-probe.sh"
  sed -n '/^bootstrap_assign_out()/,/^}/p' "$SCRIPT_DIR/isolated-release-probe.sh"
  sed -n '/^bootstrap_assign_internal_out()/,/^}/p' "$SCRIPT_DIR/isolated-release-probe.sh"
  sed -n '/^bootstrap_capture()/,/^}/p' "$SCRIPT_DIR/isolated-release-probe.sh"
  sed -n '/^bootstrap_capture_internal()/,/^}/p' "$SCRIPT_DIR/isolated-release-probe.sh"
  sed -n '/^bootstrap_verify_runtime_path()/,/^}/p' "$SCRIPT_DIR/isolated-release-probe.sh"
  sed -n '/^bootstrap_verify_runtime_artifact()/,/^}/p' "$SCRIPT_DIR/isolated-release-probe.sh"
)
bash -c 'set -Eeuo pipefail; eval "$1"; for name in output status line data source target target_name command_class seconds timeout_class failure_class had_errexit captured result; do run_case() { local "$name"; bootstrap_capture "$name" 5 printf ok; local -n ref="$name"; [[ $ref == ok ]]; }; run_case; done' \
  sh "$bootstrap_functions"
pass actual_bootstrap_collision_matrix

PACKAGE_ROOT="$SCRIPT_DIR" bash -c 'set -Eeuo pipefail; eval "$1";
  bootstrap_verify_runtime_artifact failure-diagnostics.sh 6b8b84c9e9d9477f827b82735c7bdb46cd26de6123256b1ee9c4dd249fa37c98
  bootstrap_verify_runtime_artifact bounded-operations.sh 1c502260909157be33b64369b0f4163b32c9cd224d5aa81115053a1a110566a5
  bootstrap_verify_runtime_artifact probe-output-helpers.sh 64f4a885a1f109130059f9466712d5b9088cfe9154ad580903694b17403eeed7
  bootstrap_verify_runtime_artifact restore-verification.sh 996721573f9b243598c2380497e44a8aafd2800330500256ddc53c2ef6779547
  bootstrap_verify_runtime_artifact postgres-startup.sh 54276af4a969b0003c907e249e1fdef04d2b8da6c101cc898aecc6d5685b56e3
  bootstrap_verify_runtime_artifact migration-preflight.sh ee913ba6221e929b0d98877206cc68cce04a26067766820d0db9f3cf83503189
  bootstrap_verify_runtime_artifact migration-sql-gate.sh 9faf24f9aacbd48c27d5e8cff8b0bfdcc92570a9d314232969fd684d70539bda
  bootstrap_verify_runtime_artifact migration-sql-bindings.txt 9128eba91ecb5ce9d010015031050379cd45941fff93bef721df889040a56f8f
  bootstrap_verify_runtime_artifact prisma-legacy-diff-gate.sh a4e45ce793ffbcc70b37ee72b6d96b5c0728471aa87c02ae92737fce574f350b
  bootstrap_verify_runtime_artifact prisma-diff-semantic-parser.py 2a3ffb3006dc923715e13af4faecbacc1141ea24c85ccb09c9f0c51983cdae03
  bootstrap_verify_runtime_artifact synthetic-scraper-harness.js 85d3b4f7b63829b054cfcb61af3d9c786b8dbcf0e9d52aa01be86fbef85a917e
  bootstrap_verify_runtime_artifact gateway-client-harness.js f1f8c3f5a60a0cf45f44904d8f708f760d02b6553c3b86d05e1ecbbd8cd25428' \
  sh "$bootstrap_functions"
pass actual_runtime_artifact_anchor_set

tamper_root="$TEST_TMP/paired-substitution"
tamper_sentinel="$TEST_TMP/tampered-helper-executed"
mkdir -p "$tamper_root"
printf '%s\n' ': >"$TAMPER_SENTINEL"' >"$tamper_root/probe-output-helpers.sh"
tampered_helper_sha=$(sha256sum -- "$tamper_root/probe-output-helpers.sh" | awk '{print $1}')
printf '%s  %s\n' "$tampered_helper_sha" probe-output-helpers.sh >"$tamper_root/SHA256SUMS"
(cd "$tamper_root" && sha256sum -c SHA256SUMS >/dev/null)
set +e
tamper_output=$(PACKAGE_ROOT="$tamper_root" TAMPER_SENTINEL="$tamper_sentinel" \
  bash -c 'set -Eeuo pipefail; eval "$1"; if bootstrap_verify_runtime_artifact probe-output-helpers.sh "$2"; then source "$PACKAGE_ROOT/probe-output-helpers.sh"; exit 0; else status=$?; [[ ! -e $TAMPER_SENTINEL ]]; exit "$status"; fi' \
  sh "$bootstrap_functions" 64f4a885a1f109130059f9466712d5b9088cfe9154ad580903694b17403eeed7 2>&1)
tamper_status=$?
set -e
[[ $tamper_status -eq 66 && $tamper_output == *'RUNTIME_ARTIFACT_CHECKSUM_MISMATCH=probe-output-helpers.sh'* && ! -e $tamper_sentinel ]]
pass paired_runtime_artifact_substitution_refused

[[ $PASS_COUNT -eq 36 ]]
printf 'OLD_FIXTURE=FAIL_AS_EXPECTED\nFIXED_IMPLEMENTATION=PASS\nEXECUTABLE_TEST_COUNT=36\nROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\n'
