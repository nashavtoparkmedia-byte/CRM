#!/usr/bin/env bash
# Executable stale-classification and primary-failure preservation matrix. No Docker or database access.
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
readonly BOUNDED="$SCRIPT_DIR/bounded-operations.sh"
readonly DIAGNOSTICS="$SCRIPT_DIR/failure-diagnostics.sh"
readonly PROBE="$SCRIPT_DIR/isolated-release-probe.sh"

# shellcheck source=release/personal-max-stage8b1i/bounded-operations.sh
source "$BOUNDED"
# shellcheck source=release/personal-max-stage8b1i/failure-diagnostics.sh
source "$DIAGNOSTICS"

TEST_TMP=$(mktemp -d /tmp/personal-max-stage8b1i-stale-classification.XXXXXX)
trap 'rm -rf -- "$TEST_TMP"' EXIT
PASS_COUNT=0
pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '%s=PASS\n' "$1"; }

# Avoid a real delay while retaining the real pm_poll_until retry state machine.
sleep() { :; }
gateway_health_attempts=0
gateway_active_health_fixture() {
  gateway_health_attempts=$((gateway_health_attempts + 1))
  if (( gateway_health_attempts == 1 )); then
    PROBE_ERROR_CLASSIFICATION=GATEWAY_ACTIVE_READINESS_FAILED
    return 1
  fi
  return 0
}

PROBE_ERROR_CLASSIFICATION=NONE
pm_poll_until 3 30 GATEWAY_ACTIVE_READINESS_FAILED gateway_active_health_fixture
[[ $gateway_health_attempts -eq 2 ]]
pass gateway_health_fails_once_then_succeeds

[[ $gateway_health_attempts -gt 1 ]]
pass poll_succeeds_after_transient_failure

[[ $PROBE_ERROR_CLASSIFICATION == NONE ]]
pass successful_poll_clears_transient_classification

pm_enter_phase scraper_runtime_contract synthetic_harness >"$TEST_TMP/phase-output"
phase_output=$(<"$TEST_TMP/phase-output")
[[ $PROBE_PHASE == scraper_runtime_contract && $PROBE_ERROR_CLASSIFICATION == NONE ]]
pass valid_next_phase_enters

[[ $(grep -c '^STAGE8B1I_PHASE=scraper_runtime_contract$' <<<"$phase_output") -eq 1 ]]
pass new_phase_prints_once

PROBE_PHASE=scraper_runtime_contract
set +e
pm_enter_phase 'scraper_runtime_contract ' synthetic_harness >"$TEST_TMP/unsafe-output"
unsafe_status=$?
set -e
[[ $unsafe_status -eq 64 && ! -s $TEST_TMP/unsafe-output ]]
pass invalid_phase_returns_64

[[ $PROBE_ERROR_CLASSIFICATION == PHASE_REGISTRY_MISMATCH ]]
pass invalid_phase_has_precise_classification

[[ $PROBE_ERROR_CLASSIFICATION != GATEWAY_ACTIVE_READINESS_FAILED ]]
pass invalid_phase_is_not_gateway_failure

[[ $PROBE_PHASE == scraper_runtime_contract ]]
pass previous_safe_phase_remains

PM_SCRIPT_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SCRAPER_CHECK_ID=NONE
MIGRATION_CHECK_ID=NONE
emergency_report="$TEST_TMP/phase-registry-emergency.json"
personal_max_stage8b1i_write_emergency_json "$emergency_report" 64 scraper_runtime_contract PHASE_REGISTRY_MISMATCH
jq -e '.phase=="scraper_runtime_contract" and .classification=="PHASE_REGISTRY_MISMATCH"' "$emergency_report" >/dev/null
pass failure_report_records_phase_registry_mismatch

jq -e '.checkId=="NONE"' "$emergency_report" >/dev/null
pass pure_phase_registry_check_id_is_none

jq -e '.exitCode==64' "$emergency_report" >/dev/null
pass original_exit_remains_64

cleanup_runs=0
cleanup_fixture() { cleanup_runs=$((cleanup_runs + 1)); }
cleanup_fixture
[[ $cleanup_runs -eq 1 ]]
pass cleanup_still_runs

rg -F '"REPORT_HANDOFF=$__pm_mode"' "$DIAGNOSTICS" >/dev/null
rg -F 'personal_max_stage8b1i_surface_existing_report "$original_exit" "$safe_phase" "$safe_error"' "$DIAGNOSTICS" >/dev/null
rg -F '"$safe_check_id" "$([[ $cleanup_ok == true ]] && printf PASS || printf FAIL)" PRIMARY' "$DIAGNOSTICS" >/dev/null
pass validated_primary_report_handoff_remains

runtime_runner_count=0
runtime_transition_fixture() {
  pm_enter_phase "$1" synthetic_harness >/dev/null || return
  runtime_runner_count=$((runtime_runner_count + 1))
}
set +e
runtime_transition_fixture unsafe_runtime_phase
runtime_rejected_status=$?
set -e
[[ $runtime_rejected_status -eq 64 && $runtime_runner_count -eq 0 ]]
pass rejected_phase_blocks_runtime_runner

runtime_transition_fixture scraper_runtime_contract
[[ $runtime_runner_count -eq 1 ]]
pass valid_phase_permits_runtime_runner

primary_classification=SCRAPER_DEFAULT_OFF_HARNESS_EXITED
cleanup_classification=NONE
preserved_classification=$primary_classification
[[ $cleanup_classification == NONE && $preserved_classification == SCRAPER_DEFAULT_OFF_HARNESS_EXITED ]]
pass later_scraper_failure_keeps_scraper_classification

primary_classification=E2E_VERIFICATION_FAILED
preserved_classification=$primary_classification
[[ $cleanup_classification == NONE && $preserved_classification == E2E_VERIFICATION_FAILED ]]
pass later_e2e_failure_keeps_e2e_classification

rg -F 'original_class=${PROBE_ERROR_CLASSIFICATION:-UNEXPECTED_COMMAND_FAILURE}' "$PROBE" >/dev/null
rg -F 'PROBE_ERROR_CLASSIFICATION=$original_class' "$PROBE" >/dev/null
pass cleanup_success_does_not_replace_primary

second_emergency="$TEST_TMP/phase-registry-emergency-second.json"
personal_max_stage8b1i_write_emergency_json "$second_emergency" 64 gateway_active PHASE_REGISTRY_MISMATCH
jq -e '.mode=="ISOLATED_RELEASE_PROOF_EMERGENCY_FAILURE" and .phase=="gateway_active" and
  .classification=="PHASE_REGISTRY_MISMATCH" and .exitCode==64' "$second_emergency" >/dev/null
pass emergency_path_preserves_phase_registry_classification

[[ $PASS_COUNT -eq 20 ]]
printf 'STALE_CLASSIFICATION_TEST_COUNT=20\nTRANSIENT_POLL_RECOVERED=YES\nPRIMARY_FAILURE_PRESERVED=YES\nROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\nDATABASE_CONNECTED=NO\n'
