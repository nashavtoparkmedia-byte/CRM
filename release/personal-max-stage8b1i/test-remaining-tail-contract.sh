#!/usr/bin/env bash
# Offline remaining-tail source-contract and fault-injection matrix.
# It does not invoke Docker, connect to a database, or execute the root probe.
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
readonly PROBE="$SCRIPT_DIR/isolated-release-probe.sh"
readonly DIAGNOSTICS="$SCRIPT_DIR/failure-diagnostics.sh"
readonly BOUNDED="$SCRIPT_DIR/bounded-operations.sh"
readonly TEXT_CANARY_REPOSITORY='/home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z'
readonly TEXT_CANARY_BRANCH='feature/personal-max-text-canary-autonomous-20260728T211316Z'
readonly TEXT_CANARY_COMMIT='5debe647a5320adbc51ed94fd7c0ab87d6468a4f'

# shellcheck source=release/personal-max-stage8b1i/bounded-operations.sh
source "$BOUNDED"
# shellcheck source=release/personal-max-stage8b1i/failure-diagnostics.sh
source "$DIAGNOSTICS"

TEST_TMP=$(mktemp -d /tmp/personal-max-stage8b1i-remaining-tail.XXXXXX)
trap 'rm -rf -- "$TEST_TMP"' EXIT
PASS_COUNT=0
PROBE_PHASE=bootstrap_complete
PROBE_SAFE_COMMAND_CLASS=package_validation
PROBE_ERROR_CLASSIFICATION=NONE

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '%s=PASS\n' "$1"; }
require_fixed() { rg -F -- "$2" "$1" >/dev/null; }

pm_tail_timeout() {
  shift 3
  "$@"
}
PM_TIMEOUT_BIN=pm_tail_timeout

phase_block() {
  local start_phase=${1:?start phase required} stop_phase=${2:?stop phase required}
  awk -v start="pm_enter_phase $start_phase " -v stop="pm_enter_phase $stop_phase " '
    index($0, start) {active=1}
    active && index($0, stop) && !index($0, start) {exit}
    active {print}
  ' "$PROBE"
}

require_phase_classification() {
  local start_phase=${1:?start phase required} stop_phase=${2:?stop phase required}
  local classification=${3:?classification required}
  phase_block "$start_phase" "$stop_phase" | rg -F -- "$classification" >/dev/null
  personal_max_stage8b1i_safe_phase "$start_phase"
  personal_max_stage8b1i_safe_error "$classification"
}

run_bounded_fault() {
  local name=${1:?name required} phase=${2:?phase required} classification=${3:?classification required}
  local status
  PROBE_PHASE=$phase
  PROBE_SAFE_COMMAND_CLASS=package_validation
  PROBE_ERROR_CLASSIFICATION=NONE
  set +e
  pm_run_bounded package_validation 5 METADATA_TIMEOUT "$classification" sh -c 'exit 1'
  status=$?
  set -e
  [[ $status -eq 1 && $PROBE_ERROR_CLASSIFICATION == "$classification" ]]
  personal_max_stage8b1i_safe_phase "$phase"
  personal_max_stage8b1i_safe_error "$classification"
  pass "$name"
}

# Required case 39: gateway negative configuration failure.
require_phase_classification gateway_negative gateway_dormant GATEWAY_NEGATIVE_VALIDATION_FAILED
run_bounded_fault gateway_negative_failure gateway_negative GATEWAY_NEGATIVE_VALIDATION_FAILED

# Required case 40: dormant gateway readiness failure.
require_phase_classification gateway_dormant gateway_active GATEWAY_DORMANT_READINESS_FAILED
run_bounded_fault gateway_dormant_failure gateway_dormant GATEWAY_DORMANT_READINESS_FAILED

# Additional remaining-tail boundary: active gateway readiness.
require_phase_classification gateway_active scraper_default_off GATEWAY_ACTIVE_READINESS_FAILED
run_bounded_fault gateway_active_failure gateway_active GATEWAY_ACTIVE_READINESS_FAILED

# Additional remaining-tail boundaries: scraper default-off and spool setup.
require_phase_classification scraper_default_off e2e_outage SCRAPER_DEFAULT_OFF_FAILED
run_bounded_fault scraper_default_off_failure scraper_default_off SCRAPER_DEFAULT_OFF_FAILED
require_phase_classification scraper_default_off e2e_outage SPOOL_INITIALIZATION_FAILED
run_bounded_fault spool_initialization_failure scraper_default_off SPOOL_INITIALIZATION_FAILED

# Required cases 41 and 42: outage and recovery.
require_phase_classification e2e_outage e2e_recovery E2E_OUTAGE_FAILED
run_bounded_fault e2e_outage_failure e2e_outage E2E_OUTAGE_FAILED
require_phase_classification e2e_recovery gateway_active E2E_RECOVERY_FAILED
run_bounded_fault e2e_recovery_failure e2e_recovery E2E_RECOVERY_FAILED

# Additional remaining-tail boundary: authenticated gateway client verification.
second_gateway_block=$(awk '
  /pm_enter_phase gateway_active synthetic_http/ {active=1}
  active && /pm_enter_phase e2e_verification / {exit}
  active {print}
' "$PROBE")
rg -F 'GATEWAY_CLIENT_VERIFICATION_FAILED' <<<"$second_gateway_block" >/dev/null
run_bounded_fault gateway_client_failure gateway_active GATEWAY_CLIENT_VERIFICATION_FAILED

# Required case 43: final E2E database assertions fail closed under one class.
require_phase_classification e2e_verification final_storage_gate E2E_VERIFICATION_FAILED
run_bounded_fault e2e_verification_failure e2e_verification E2E_VERIFICATION_FAILED

# Required case 44: cleanup failure remains explicit.
require_fixed "$PROBE" 'pm_enter_phase cleanup cleanup'
set +e
pm_assert_cleanup_zero 1 0 0 0
cleanup_status=$?
set -e
[[ $cleanup_status -ne 0 && $PROBE_ERROR_CLASSIFICATION == CLEANUP_INCOMPLETE ]]
pass cleanup_failure

# Additional remaining-tail boundary: final storage gate.
require_phase_classification final_storage_gate production_snapshot_after FINAL_DISK_GATE_FAILED
set +e
pm_check_disk_gate 99 100 FINAL_DISK_GATE_FAILED
storage_status=$?
set -e
[[ $storage_status -ne 0 && $PROBE_ERROR_CLASSIFICATION == FINAL_DISK_GATE_FAILED ]]
pass final_storage_failure

# Required case 45: production before/after mismatch has its own classification.
require_phase_classification production_snapshot_after report_render PRODUCTION_SNAPSHOT_MISMATCH
run_bounded_fault production_snapshot_mismatch production_snapshot_after PRODUCTION_SNAPSHOT_MISMATCH

# Required case 46: report rendering failure.
require_phase_classification report_render report_validation SUCCESS_REPORT_RENDER_FAILED
set +e
pm_write_bounded "$TEST_TMP/render.json" report_render 5 METADATA_TIMEOUT SUCCESS_REPORT_RENDER_FAILED sh -c 'exit 1'
render_status=$?
set -e
[[ $render_status -eq 1 && $PROBE_ERROR_CLASSIFICATION == SUCCESS_REPORT_RENDER_FAILED && ! -s $TEST_TMP/render.json ]]
pass success_report_render_failure

# Required case 47: report validation failure.
require_fixed "$PROBE" 'pm_enter_phase report_validation report_render'
printf '{malformed\n' >"$TEST_TMP/malformed-report.json"
set +e
pm_validate_success_report "$TEST_TMP/malformed-report.json"
validation_status=$?
set -e
[[ $validation_status -ne 0 && $PROBE_ERROR_CLASSIFICATION == SUCCESS_REPORT_MALFORMED ]]
pass success_report_validation_failure

# Additional remaining-tail boundary: permission/no-clobber handoff failure.
require_phase_classification report_handoff completed SUCCESS_REPORT_HANDOFF_FAILED
run_bounded_fault success_report_handoff_failure report_handoff SUCCESS_REPORT_HANDOFF_FAILED

# Required case 48: the completed marker has a dedicated, preserved terminal FD.
completed_block=$(awk '
  /pm_enter_phase completed report_handoff/ {active=1}
  active {print}
' "$PROBE")
rg -F 'ISOLATED_RELEASE_PROOF_COMPLETED' <<<"$completed_block" >/dev/null
rg -F 'personal_max_stage8b1i_emit_terminal' <<<"$completed_block" >/dev/null
require_fixed "$DIAGNOSTICS" '>&"$__pm_fd"'
rg -F 'SUCCESS_TERMINAL_HANDOFF_FAILED' <<<"$completed_block" >/dev/null
rg -F 'trap - ERR EXIT' <<<"$completed_block" >/dev/null
exec 8>"$TEST_TMP/terminal-handoff.txt"
printf 'ISOLATED_RELEASE_PROOF_COMPLETED\n' >&8
exec 8>&-
[[ $(<"$TEST_TMP/terminal-handoff.txt") == ISOLATED_RELEASE_PROOF_COMPLETED ]]
pass success_terminal_handoff

# Cleanup and report fallback stay reachable from every post-diagnostics failure.
on_exit_block=$(sed -n '/^on_exit()/,/^}/p' "$PROBE")
for evidence in cleanup_disposable personal_max_stage8b1i_render_failure personal_max_stage8b1i_emergency_diagnostics \
  pm_preserve_original_exit; do
  rg -F "$evidence" <<<"$on_exit_block" >/dev/null
done
require_fixed "$PROBE" 'trap on_exit EXIT'
require_fixed "$PROBE" 'DIAGNOSTICS_LOADED=true'
pass cleanup_report_reachability

# Remaining phase order is monotonic through completed.
previous_line=0
for marker in \
  'pm_enter_phase migration_verification disposable_migration' \
  'pm_enter_phase gateway_negative docker_disposable' \
  'pm_enter_phase gateway_dormant docker_disposable' \
  'pm_enter_phase scraper_default_off synthetic_harness' \
  'pm_enter_phase e2e_outage synthetic_harness' \
  'pm_enter_phase e2e_recovery synthetic_harness' \
  'pm_enter_phase e2e_verification disposable_postgresql' \
  'pm_enter_phase final_storage_gate filesystem_metadata' \
  'pm_enter_phase production_snapshot_after docker_metadata' \
  'pm_enter_phase report_render report_render' \
  'pm_enter_phase report_validation report_render' \
  'pm_enter_phase report_handoff report_handoff' \
  'pm_enter_phase completed report_handoff'; do
  marker_line=$(rg -n -F "$marker" "$PROBE" | head -n1 | cut -d: -f1)
  [[ $marker_line =~ ^[0-9]+$ && $marker_line -gt $previous_line ]]
  previous_line=$marker_line
done
pass remaining_phase_order

# Reports expose allowlisted metadata only, never raw commands, SQL, secrets, or data.
for evidence in rawCommandCaptured:false rawSqlCaptured:false rawStderrCaptured:false \
  environmentValuesCaptured:false credentialsCaptured:false messageDataCaptured:false \
  providerPayloadCaptured:false businessDataCaptured:false; do
  require_fixed "$DIAGNOSTICS" "$evidence"
done
! rg -n 'set[[:space:]]+-x|printenv|env[[:space:]]*\|[[:space:]]*(sort|jq)|declare[[:space:]]+-p' \
  "$PROBE" "$DIAGNOSTICS" >/dev/null
pass privacy_contract

# Every exact remaining-tail classification is accepted by failure diagnostics.
for classification in GATEWAY_NEGATIVE_VALIDATION_FAILED GATEWAY_DORMANT_READINESS_FAILED \
  GATEWAY_ACTIVE_READINESS_FAILED SCRAPER_DEFAULT_OFF_FAILED SPOOL_INITIALIZATION_FAILED \
  E2E_OUTAGE_FAILED E2E_RECOVERY_FAILED GATEWAY_CLIENT_VERIFICATION_FAILED \
  E2E_VERIFICATION_FAILED PRODUCTION_SNAPSHOT_MISMATCH SUCCESS_REPORT_RENDER_FAILED \
  SUCCESS_REPORT_MALFORMED SUCCESS_REPORT_HANDOFF_FAILED SUCCESS_TERMINAL_HANDOFF_FAILED; do
  personal_max_stage8b1i_safe_error "$classification"
done
pass remaining_classification_allowlist

# Required case 50: the separate text-canary branch remains exact and clean.
[[ -d $TEXT_CANARY_REPOSITORY/.git ]]
[[ $(env GIT_OPTIONAL_LOCKS=0 git -C "$TEXT_CANARY_REPOSITORY" branch --show-current) == "$TEXT_CANARY_BRANCH" ]]
[[ $(env GIT_OPTIONAL_LOCKS=0 git -C "$TEXT_CANARY_REPOSITORY" rev-parse HEAD) == "$TEXT_CANARY_COMMIT" ]]
[[ $(env GIT_OPTIONAL_LOCKS=0 git -C "$TEXT_CANARY_REPOSITORY" rev-parse "refs/remotes/origin/$TEXT_CANARY_BRANCH") == "$TEXT_CANARY_COMMIT" ]]
[[ -z $(env GIT_OPTIONAL_LOCKS=0 git -C "$TEXT_CANARY_REPOSITORY" status --porcelain=v1 --untracked-files=all) ]]
pass text_canary_unchanged

[[ $PASS_COUNT -eq 21 ]]
printf 'REMAINING_TAIL_TEST_COUNT=21\nREQUIRED_REGRESSION_CASES_COVERED=11\nROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\nDATABASE_CONNECTED=NO\n'
