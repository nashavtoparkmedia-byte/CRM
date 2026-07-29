#!/usr/bin/env bash
# Non-root failure-handoff and prior-residual fault matrix. No Docker or DB.
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PROBE="$SCRIPT_DIR/isolated-release-probe.sh"
DIAGNOSTICS="$SCRIPT_DIR/failure-diagnostics.sh"
RESIDUAL="$SCRIPT_DIR/residual-cleanup.sh"
TEST_TMP=$(mktemp -d /tmp/personal-max-stage8b1i-failure-handoff.XXXXXX)
FIXTURE_SCRIPT_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
FIXTURE_FAILURE_PATH="/var/tmp/personal-max-stage8b1i-isolated-release-proof.failure.${FIXTURE_SCRIPT_SHA}.json"
PASS_COUNT=0

cleanup_test_files() {
  rm -f -- "$FIXTURE_FAILURE_PATH"
  rm -rf -- "$TEST_TMP"
}
trap cleanup_test_files EXIT

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '%s=PASS\n' "$1"
}

expect_failure() {
  local expected=$1
  shift
  set +e
  "$@"
  local observed=$?
  set -e
  [[ $observed -eq $expected ]]
}

# shellcheck source=release/personal-max-stage8b1i/failure-diagnostics.sh
source "$DIAGNOSTICS"
# shellcheck source=release/personal-max-stage8b1i/residual-cleanup.sh
source "$RESIDUAL"

pm_safe_uint() { [[ ${1:-} =~ ^[0-9]+$ ]]; }
uint() { pm_safe_uint "${1:-}"; }
pm_preserve_original_exit() {
  local original=$1 cleanup=$2
  if (( original != 0 )); then printf '%s\n' "$original"; else printf '%s\n' "$cleanup"; fi
}

valid_failure_json() {
  local path=$1 mode=${2:-ISOLATED_RELEASE_PROOF_FAILURE} exit_code=${3:-1}
  printf '{"schemaVersion":1,"mode":"%s","script":{"sha256":"%s","checksumBound":true},"phase":"migration_verification","classification":"MIGRATION_PRISMA_DIFF_REJECTED","checkId":"MIGRATION_PRISMA_DIFF_GATE_CHECK","exitCode":%s,"diagnostics":{"rawCommandCaptured":false,"rawSqlCaptured":false,"rawStderrCaptured":false,"environmentValuesCaptured":false,"credentialsCaptured":false,"messageDataCaptured":false,"providerPayloadCaptured":false}}\n' \
    "$mode" "$FIXTURE_SCRIPT_SHA" "$exit_code" >"$path"
  chmod 0640 "$path"
}

# Only stat ownership is virtualized. All other timeout-bounded commands execute.
timeout() {
  local duration=$1
  shift
  if [[ ${1:-} == stat && " $* " == *" %U:%G:%a "* ]]; then
    printf 'root:codexbot:640\n'
    return 0
  fi
  command timeout "$duration" "$@"
}

rm -f -- "$FIXTURE_FAILURE_PATH"
valid_failure_json "$FIXTURE_FAILURE_PATH"
PM_SCRIPT_SHA256=$FIXTURE_SCRIPT_SHA
PM_FAILURE_PATH=$FIXTURE_FAILURE_PATH
PM_FAILURE_HANDOFF_COMPLETED=false
PROBE_SAFE_COMMAND_CLASS=disposable_migration

exec 9>"$TEST_TMP/direct-handoff.out"
PM_HANDOFF_FD=9
personal_max_stage8b1i_surface_existing_report 1 migration_verification \
  MIGRATION_PRISMA_DIFF_REJECTED MIGRATION_PRISMA_DIFF_GATE_CHECK PASS PRIMARY
grep -Fx 'ISOLATED_PROBE_FAILED' "$TEST_TMP/direct-handoff.out" >/dev/null
grep -Fx 'EXIT_CODE=1' "$TEST_TMP/direct-handoff.out" >/dev/null
pass exit_one_preserved

PM_FAILURE_HANDOFF_COMPLETED=false
original_report_sha=$(sha256sum "$FIXTURE_FAILURE_PATH" | awk '{print $1}')
saved_report_sha=$(declare -f personal_max_stage8b1i_report_sha)
personal_max_stage8b1i_report_sha() { return 74; }
expect_failure 74 personal_max_stage8b1i_surface_existing_report 1 migration_verification \
  MIGRATION_PRISMA_DIFF_REJECTED MIGRATION_PRISMA_DIFF_GATE_CHECK PASS PRIMARY
[[ -f $FIXTURE_FAILURE_PATH && $(sha256sum "$FIXTURE_FAILURE_PATH" | awk '{print $1}') == "$original_report_sha" ]]
eval "$saved_report_sha"
pass report_created_sha_failure

PM_FAILURE_HANDOFF_COMPLETED=false
saved_surface=$(declare -f personal_max_stage8b1i_surface_existing_report)
personal_max_stage8b1i_surface_existing_report() { return 74; }
exec 9>"$TEST_TMP/terminal-failure.out"
PM_HANDOFF_FD=9
expect_failure 1 personal_max_stage8b1i_emergency_diagnostics 1
grep -Fx 'FAILURE_REPORT_UNAVAILABLE' "$TEST_TMP/terminal-failure.out" >/dev/null
eval "$saved_surface"
pass terminal_summary_failure_fallback

extract_probe_function() {
  local name=$1
  sed -n "/^${name}() {/,/^}/p" "$PROBE"
}

run_trap_fixture() {
  local mode=$1 cleanup_exit=${2:-0} output_path=$3
  set +e
  (
    set -Eeuo pipefail
    exec 9>"$output_path"
    PM_HANDOFF_FD=9
    DIAGNOSTICS_LOADED=true
    CLEANUP_COMPLETED=false
    FAILURE_EXIT=0
    FAILURE_SOURCE_LINE=0
    ERROR_TRAP_ENTERED=false
    PROBE_PHASE=migration_verification
    PROBE_SAFE_COMMAND_CLASS=disposable_migration
    PROBE_ERROR_CLASSIFICATION=MIGRATION_PRISMA_DIFF_REJECTED
    MIGRATION_CHECK_ID=MIGRATION_PRISMA_DIFF_GATE_CHECK
    PM_FAILURE_HANDOFF_ATTEMPTED=false
    PM_FAILURE_HANDOFF_COMPLETED=false
    cleanup_disposable() {
      PROBE_PHASE=cleanup
      PROBE_SAFE_COMMAND_CLASS=cleanup
      PROBE_ERROR_CLASSIFICATION=CLEANUP_INCOMPLETE
      return "$cleanup_exit"
    }
    personal_max_stage8b1i_render_failure() {
      local original_exit=$1 source_line=$2 cleanup_ok=$3
      printf 'ISOLATED_PROBE_FAILED\nPHASE=%s\nCLASSIFICATION=%s\nCHECK_ID=%s\nEXIT_CODE=%s\nSOURCE_LINE=%s\nCLEANUP_STATUS=%s\n' \
        "$PROBE_PHASE" "$PROBE_ERROR_CLASSIFICATION" "$MIGRATION_CHECK_ID" \
        "$original_exit" "$source_line" "$cleanup_ok" >&9
      PM_FAILURE_HANDOFF_COMPLETED=true
    }
    eval "$(extract_probe_function on_error)"
    eval "$(extract_probe_function on_exit)"
    trap 'on_error $LINENO' ERR
    trap on_exit EXIT
    fail_operation() { return 1; }
    case $mode in
      direct) fail_operation ;;
      command_substitution) captured=$(fail_operation) ;;
      stdout_redirect) fail_operation >/dev/null ;;
      stderr_redirect) fail_operation 2>/dev/null ;;
      *) exit 64 ;;
    esac
  )
  local status=$?
  set -e
  printf '%s' "$status"
}

status=$(run_trap_fixture command_substitution 0 "$TEST_TMP/command-substitution.out")
[[ $status -eq 1 ]]
grep -Fx 'ISOLATED_PROBE_FAILED' "$TEST_TMP/command-substitution.out" >/dev/null
pass command_substitution_handoff

status=$(run_trap_fixture stdout_redirect 0 "$TEST_TMP/stdout-redirect.out")
[[ $status -eq 1 ]]
grep -Fx 'ISOLATED_PROBE_FAILED' "$TEST_TMP/stdout-redirect.out" >/dev/null
pass stdout_redirect_handoff

status=$(run_trap_fixture stderr_redirect 0 "$TEST_TMP/stderr-redirect.out")
[[ $status -eq 1 ]]
grep -Fx 'ISOLATED_PROBE_FAILED' "$TEST_TMP/stderr-redirect.out" >/dev/null
pass stderr_redirect_handoff

status=$(run_trap_fixture direct 0 "$TEST_TMP/cleanup-success.out")
[[ $status -eq 1 ]]
grep -Fx 'CLEANUP_STATUS=true' "$TEST_TMP/cleanup-success.out" >/dev/null
pass cleanup_success

eval "$(extract_probe_function cleanup_temp_path)"
eval "$(extract_probe_function cleanup_disposable)"
cleanup_fixture="$TEST_TMP/current-run-temp"
mkdir "$cleanup_fixture"
RUN_ID=abcdef123456
TMP=$cleanup_fixture
TMP_REPORT=''
TMP_AFTER=''
CLEANUP_ATTEMPTED=false
CLEANUP_GLOBAL_DEADLINE=$((SECONDS + 30))
CLEANUP_TEMP_FILES_REMAINING=unknown
CLEANUP_ERROR_CLASSIFICATION=NONE
docker_cleanup_calls=0
cleanup_docker_objects() { docker_cleanup_calls=$((docker_cleanup_calls + 1)); return 0; }
cleanup_temp_path() { PROBE_ERROR_CLASSIFICATION=TEMP_REMOVAL_TIMEOUT; return 70; }
expect_failure 70 cleanup_disposable
[[ $docker_cleanup_calls -eq 1 && $CLEANUP_TEMP_FILES_REMAINING -eq 1 && -d $cleanup_fixture ]]
pass docker_cleanup_success_temp_cleanup_failure

status=$(run_trap_fixture direct 70 "$TEST_TMP/cleanup-plus-original.out")
[[ $status -eq 1 ]]
grep -Fx 'EXIT_CODE=1' "$TEST_TMP/cleanup-plus-original.out" >/dev/null
grep -Fx 'CLEANUP_STATUS=false' "$TEST_TMP/cleanup-plus-original.out" >/dev/null
pass cleanup_failure_original_exit_preserved

set_renderer_defaults() {
  PM_SCRIPT_SHA256=$FIXTURE_SCRIPT_SHA
  PM_FAILURE_PATH=$FIXTURE_FAILURE_PATH
  PM_FAILURE_HANDOFF_COMPLETED=false
  PROBE_PHASE=migration_verification
  PROBE_SAFE_COMMAND_CLASS=disposable_migration
  PROBE_ERROR_CLASSIFICATION=MIGRATION_PRISMA_DIFF_REJECTED
  MIGRATION_CHECK_ID=MIGRATION_PRISMA_DIFF_GATE_CHECK
  MIGRATION_SUBSTEP=prisma_diff_gate
  MIGRATION_RUNNER_ROLE=prisma_diff
  MIGRATION_COMMAND_CATEGORY=internal_validator
  MIGRATION_EXECUTABLE_CATEGORY=posix_shell
  MIGRATION_COMMAND_STARTED=true
  MIGRATION_ATTEMPT_COUNT=1
  MIGRATION_ELAPSED_SECONDS=0
  MIGRATION_ORIGINAL_EXIT=1
  MIGRATION_CONTAINER_STATE_CATEGORY=not_observed
  MIGRATION_PRIMARY_CLASSIFICATION=MIGRATION_PRISMA_DIFF_REJECTED
  REQUIRED_FREE_BYTES=12500000000
  PROBE_BUDGET_BYTES=2172240240
  CLEANUP_CONTAINERS_REMAINING=0
  CLEANUP_NETWORKS_REMAINING=0
  CLEANUP_VOLUMES_REMAINING=0
  CLEANUP_TEMP_FILES_REMAINING=0
  CLEANUP_ERROR_CLASSIFICATION=NONE
  ACCEPTED_PRODUCTION_HEAD=e6a0a833fbb756216b058bfe326f9f9c77c4cc6d
  ACCEPTED_PRODUCTION_STATUS_V2_RAW_SHA256=2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b
  OBSERVED_PRODUCTION_HEAD=$ACCEPTED_PRODUCTION_HEAD
  OBSERVED_PRODUCTION_STATUS_V2_RAW_SHA256=$ACCEPTED_PRODUCTION_STATUS_V2_RAW_SHA256
  GATEWAY_PREEXISTING_BEFORE_PULL=false
  SCRAPER_PREEXISTING_BEFORE_PULL=false
  GATEWAY_ACQUIRED_DURING_PROBE=false
  SCRAPER_ACQUIRED_DURING_PROBE=false
  FREE_BYTES_AFTER_CLEANUP=12500000000
  LEDGER_INVALID_NAMING_CATEGORIES_JSON='[]'
  LEDGER_ACCEPTED_HISTORICAL_NAMES_JSON='[]'
}

pm_capture_bounded() {
  local target=$1
  shift 5
  local value
  if [[ ${1:-} == stat && " $* " == *" %U:%G:%a "* ]]; then
    value=root:codexbot:640
  elif [[ ${1:-} == stat && " $* " == *" %d:%i "* ]]; then
    value=fixture-identity
  else
    value=$("$@")
  fi
  printf -v "$target" '%s' "$value"
}
pm_run_bounded() {
  shift 4
  if [[ ${1:-} == chgrp ]]; then return 0; fi
  "$@"
}
pm_write_bounded() {
  local target=$1
  shift 5
  "$@" >"$target"
}
pm_migration_substep_is_safe() { return 0; }
pm_migration_role_is_safe() { return 0; }
pm_migration_command_category_is_safe() { return 0; }
pm_migration_executable_category_is_safe() { return 0; }
pm_migration_state_is_safe() { return 0; }

rm -f -- "$FIXTURE_FAILURE_PATH"
set_renderer_defaults
saved_write=$(declare -f pm_write_bounded)
pm_write_bounded() { return 74; }
expect_failure 74 personal_max_stage8b1i_render_failure 1 165 true
[[ ! -e $FIXTURE_FAILURE_PATH ]]
eval "$saved_write"
personal_max_stage8b1i_cleanup_primary_temp || true
pass primary_render_failure_before_move

rm -f -- "$FIXTURE_FAILURE_PATH"
set_renderer_defaults
saved_surface=$(declare -f personal_max_stage8b1i_surface_existing_report)
personal_max_stage8b1i_surface_existing_report() { return 74; }
expect_failure 74 personal_max_stage8b1i_render_failure 1 165 true
[[ -f $FIXTURE_FAILURE_PATH ]]
eval "$saved_surface"
pass primary_render_failure_after_move

rm -f -- "$FIXTURE_FAILURE_PATH"
set_renderer_defaults
exec 9>"$TEST_TMP/emergency-success.out"
PM_HANDOFF_FD=9
expect_failure 1 personal_max_stage8b1i_emergency_diagnostics 1
[[ -f $FIXTURE_FAILURE_PATH ]]
grep -Fx 'REPORT_HANDOFF=EMERGENCY' "$TEST_TMP/emergency-success.out" >/dev/null
pass emergency_report_success

rm -f -- "$FIXTURE_FAILURE_PATH"
set_renderer_defaults
PM_FAILURE_PATH="$TEST_TMP/not-an-accepted-failure-path.json"
exec 9>"$TEST_TMP/emergency-unavailable.out"
PM_HANDOFF_FD=9
expect_failure 1 personal_max_stage8b1i_emergency_diagnostics 1
grep -Fx 'FAILURE_REPORT_UNAVAILABLE' "$TEST_TMP/emergency-unavailable.out" >/dev/null
pass emergency_report_unavailable_explicit

for output in command-substitution.out stdout-redirect.out stderr-redirect.out cleanup-success.out cleanup-plus-original.out; do
  [[ -s $TEST_TMP/$output ]]
done
pass no_silent_nonzero_exit

[[ $(grep -c '^ISOLATED_PROBE_FAILED$' "$TEST_TMP/cleanup-success.out") -eq 1 ]]
pass no_duplicate_report_handoff

[[ $(grep -c '^ISOLATED_PROBE_FAILED$' "$TEST_TMP/cleanup-plus-original.out") -eq 1 ]]
pass no_trap_recursion

grep -Fx 'PHASE=migration_verification' "$TEST_TMP/cleanup-plus-original.out" >/dev/null
pass original_phase_preserved

grep -Fx 'CLASSIFICATION=MIGRATION_PRISMA_DIFF_REJECTED' "$TEST_TMP/cleanup-plus-original.out" >/dev/null
pass original_classification_preserved

grep -Fx 'CHECK_ID=MIGRATION_PRISMA_DIFF_GATE_CHECK' "$TEST_TMP/cleanup-plus-original.out" >/dev/null
pass original_check_id_preserved

grep -Fx 'EXIT_CODE=1' "$TEST_TMP/cleanup-plus-original.out" >/dev/null
pass original_exit_preserved

pm_prior_residual_metadata_is_safe "$PM_PRIOR_RESIDUAL_PATH" 1:2:0:0:700:directory false
pass exact_residual_metadata_accepted

expect_failure 1 pm_prior_residual_metadata_is_safe /var/tmp/personal-max-stage8b1i.bad 1:2:0:0:700:directory false
pass wrong_residual_path_rejected

rg -F '[[ -d $PM_PRIOR_RESIDUAL_PATH && ! -L $PM_PRIOR_RESIDUAL_PATH ]]' "$RESIDUAL" >/dev/null
pass residual_symlink_rejected_contract

expect_failure 1 pm_prior_residual_metadata_is_safe "$PM_PRIOR_RESIDUAL_PATH" 1:2:1000:1000:755:directory false
pass wrong_residual_owner_mode_rejected

expect_failure 1 pm_prior_residual_report_is_safe "$PM_LATEST_ACCEPTED_FAILURE_REPORT" \
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa root:codexbot:640 "$PM_LATEST_ACCEPTED_SCRIPT_SHA256"
pass wrong_residual_report_sha_rejected

pm_prior_residual_report_is_safe "$PM_LATEST_ACCEPTED_FAILURE_REPORT" "$PM_LATEST_ACCEPTED_FAILURE_REPORT_SHA256" \
  root:codexbot:640 "$PM_LATEST_ACCEPTED_SCRIPT_SHA256"
pass exact_residual_report_binding_accepted

rg -F '[[ $CLEANUP_ATTEMPTED == false ]] || return 0' "$PROBE" >/dev/null
rg -F '[[ $PM_FAILURE_HANDOFF_ATTEMPTED == false ]]' "$PROBE" >/dev/null
pass cleanup_and_handoff_once_guards

rg -F 'personal_max_stage8b1i_surface_existing_report' "$DIAGNOSTICS" >/dev/null
rg -F 'EXISTING_AFTER_PRIMARY_FAILURE' "$DIAGNOSTICS" >/dev/null
pass existing_report_after_partial_renderer_surfaced

rg -F 'exec 9>/dev/tty' "$PROBE" >/dev/null
rg -F 'personal_max_stage8b1i_emit_terminal' "$DIAGNOSTICS" >/dev/null
pass dedicated_terminal_handoff_descriptor

printf 'FAILURE_HANDOFF_TEST_COUNT=%s\n' "$PASS_COUNT"
printf 'ROOT_PROBE_EXECUTED=NO\n'
printf 'DOCKER_EXECUTED=NO\n'
printf 'DATABASE_CONNECTED=NO\n'
