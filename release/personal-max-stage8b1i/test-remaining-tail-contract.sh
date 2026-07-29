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
require_phase_classification gateway_active scraper_runtime_contract GATEWAY_ACTIVE_READINESS_FAILED
run_bounded_fault gateway_active_failure gateway_active GATEWAY_ACTIVE_READINESS_FAILED

# Additional remaining-tail boundaries: pinned scraper runtime, default-off, and spool setup.
require_phase_classification scraper_runtime_contract scraper_default_off SCRAPER_RUNTIME_SOURCE_BINDING_MISMATCH
run_bounded_fault scraper_runtime_contract_failure scraper_runtime_contract SCRAPER_RUNTIME_SOURCE_BINDING_MISMATCH
require_phase_classification scraper_default_off e2e_outage SCRAPER_DEFAULT_OFF_HARNESS_EXITED
run_bounded_fault scraper_default_off_failure scraper_default_off SCRAPER_DEFAULT_OFF_HARNESS_EXITED
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
  'pm_enter_phase scraper_runtime_contract synthetic_harness' \
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
  GATEWAY_ACTIVE_READINESS_FAILED SCRAPER_RUNTIME_REVISION_MISSING \
  SCRAPER_RUNTIME_SOURCE_BINDING_MISMATCH SCRAPER_RUNTIME_MODULE_MISSING SCRAPER_RUNTIME_MODULE_SYMLINK \
  SCRAPER_RUNTIME_EXPORT_MISSING SCRAPER_RUNTIME_DISABLED_ADAPTER_INVALID SCRAPER_RUNTIME_INTERCEPTOR_INVALID \
  SCRAPER_RUNTIME_NODE_UNSUPPORTED SCRAPER_RUNTIME_IDENTITY_MISMATCH SCRAPER_RUNTIME_OUTPUT_MISSING \
  SCRAPER_RUNTIME_OUTPUT_MALFORMED SCRAPER_DEFAULT_OFF_MODE_MISSING SCRAPER_DEFAULT_OFF_MODE_MISMATCH \
  SCRAPER_DEFAULT_OFF_HARNESS_EXITED SCRAPER_DEFAULT_OFF_OUTPUT_MISSING SCRAPER_DEFAULT_OFF_OUTPUT_MALFORMED \
  SCRAPER_DEFAULT_OFF_INSTRUMENTATION_FAILED SCRAPER_DEFAULT_OFF_DEPENDENCY_LOAD_FAILED \
  SCRAPER_DEFAULT_OFF_ADAPTER_CREATE_FAILED SCRAPER_DEFAULT_OFF_ADAPTER_CONTRACT_FAILED \
  SCRAPER_DEFAULT_OFF_INTERCEPTOR_CONSTRUCT_FAILED SCRAPER_DEFAULT_OFF_FRAME_DISPATCH_FAILED \
  SCRAPER_DEFAULT_OFF_HEALTH_READ_FAILED SCRAPER_DEFAULT_OFF_DETACH_FAILED SCRAPER_DEFAULT_OFF_RESTORE_FAILED \
  SCRAPER_DEFAULT_OFF_RESULT_SERIALIZATION_FAILED \
  SCRAPER_DEFAULT_OFF_ENABLED_UNEXPECTED SCRAPER_DEFAULT_OFF_FRAME_NOT_HANDLED SCRAPER_DEFAULT_OFF_SPOOL_CREATED \
  SCRAPER_DEFAULT_OFF_PENDING_UNEXPECTED SCRAPER_DEFAULT_OFF_TIMER_ACTIVITY SCRAPER_DEFAULT_OFF_NETWORK_ACTIVITY \
  SCRAPER_DEFAULT_OFF_DATABASE_ACTIVITY SCRAPER_DEFAULT_OFF_ACTIVE_FACTORY_CALLED SCRAPER_DEFAULT_OFF_DRAIN_CREATED \
  SCRAPER_DEFAULT_OFF_CHROMIUM_ACTIVITY SCRAPER_DEFAULT_OFF_MAX_CONTACTED SCRAPER_DEFAULT_OFF_PROVIDER_ACTION \
  SPOOL_INITIALIZATION_FAILED \
  E2E_OUTAGE_FAILED E2E_RECOVERY_FAILED GATEWAY_CLIENT_VERIFICATION_FAILED \
  E2E_VERIFICATION_FAILED PRODUCTION_SNAPSHOT_MISMATCH SUCCESS_REPORT_RENDER_FAILED \
  SUCCESS_REPORT_MALFORMED SUCCESS_REPORT_HANDOFF_FAILED SUCCESS_TERMINAL_HANDOFF_FAILED; do
  personal_max_stage8b1i_safe_error "$classification"
done
pass remaining_classification_allowlist

# Expanded executable-invocation source contracts for every not-yet-reached runner.
runtime_contract_block=$(phase_block scraper_runtime_contract scraper_default_off)
for evidence in 'SCRAPER_RUNTIME_SOURCE_CHECK' 'runtime_revision' \
  'org.opencontainers.image.revision' 'SCRAPER_RUNTIME_CONTRACT_CHECK' \
  'scraper-runtime-contract.js:/tmp/stage8b1i-runtime-contract.js:ro' '--network none' \
  'pm_validate_scraper_runtime_contract "$TMP/scraper-runtime-contract.json"'; do
  rg -F -- "$evidence" <<<"$runtime_contract_block" >/dev/null
done
for forbidden in MAX_PERSONAL_ACCOUNT_ID MAX_PERSONAL_LIVE_CAPTURE_ENABLED \
  MAX_PERSONAL_CAPTURE_INGRESS_URL DATABASE_URL '--env-file' profile; do
  ! rg -F -- "$forbidden" <<<"$runtime_contract_block" >/dev/null
done
pass scraper_runtime_contract_runner_contract

default_off_block=$(phase_block scraper_default_off e2e_outage)
for evidence in 'SCRAPER_DEFAULT_OFF_RUN_CHECK' \
  '-e STAGE8B1I_HARNESS_MODE="$DEFAULT_OFF_HARNESS_MODE"' '--network none' \
  'pm_validate_scraper_default_off_result "$TMP/default-off.json"'; do
  rg -F -- "$evidence" <<<"$default_off_block" >/dev/null
done
require_fixed "$BOUNDED" 'SCRAPER_DEFAULT_OFF_RESULT_CHECK'
for forbidden in MAX_PERSONAL_ACCOUNT_ID MAX_PERSONAL_LIVE_CAPTURE_ENABLED \
  MAX_PERSONAL_CAPTURE_INGRESS_URL DATABASE_URL '--env-file'; do
  ! rg -F -- "$forbidden" <<<"$(awk '/PREFIX-scraper-default-off/{active=1} active{print} /stage8b1i-harness.js; then/{exit}' <<<"$default_off_block")" >/dev/null
done
pass default_off_runner_contract

for evidence in SPOOL_INITIALIZATION_CHECK '--user 0:0' '--network none' '"$SPOOL_VOLUME:/spool"' \
  'chown 1001:1001 /spool' 'chmod 0700 /spool'; do
  rg -F -- "$evidence" <<<"$default_off_block" >/dev/null
done
pass spool_initialization_runner_contract

outage_block=$(phase_block e2e_outage e2e_recovery)
for evidence in 'docker stop "$PG_CONTAINER"' 'status===503' 'docker start "$PG_CONTAINER"' \
  'PREFIX-scraper-capture-a' '--network none' 'MAX_PERSONAL_ACCOUNT_ID="$ACCOUNT_A"' \
  'MAX_PERSONAL_LIVE_CAPTURE_ENABLED="$ACCOUNT_A"' 'MAX_PERSONAL_CAPTURE_SPOOL_PATH=/spool/account-a' \
  'STAGE8B1I_HARNESS_MODE=capture-only' 'STAGE8B1I_FRAME_COUNT=500' 'STAGE8B1I_IDENTICAL_COUNT=100' \
  '"$SPOOL_VOLUME:/spool"'; do
  rg -F -- "$evidence" <<<"$outage_block" >/dev/null
done
capture_a_block=$(awk '/PREFIX-scraper-capture-a/{active=1} active{print} /stage8b1i-harness.js/{exit}' <<<"$outage_block")
! rg -F 'MAX_PERSONAL_CAPTURE_INGRESS_URL' <<<"$capture_a_block" >/dev/null
pass outage_capture_runner_contract

for evidence in 'PREFIX-scraper-retry-a' '--network "$NETWORK"' '--env-file "$TMP/client.env"' \
  'MAX_PERSONAL_ACCOUNT_ID="$ACCOUNT_A"' 'MAX_PERSONAL_CAPTURE_INGRESS_URL=http://max-personal-gateway:8080/v1/capture' \
  'STAGE8B1I_HARNESS_MODE=retry-only' 'STAGE8B1I_DRAIN_ATTEMPTS=10' \
  '.retryCount>0 and .pendingAfter>0 and .lostBeforeSpoolCount==0'; do
  rg -F -- "$evidence" <<<"$outage_block" >/dev/null
done
pass outage_retry_runner_contract

recovery_block=$(phase_block e2e_recovery gateway_active)
for evidence in 'PREFIX-scraper-capture-b' 'MAX_PERSONAL_ACCOUNT_ID="$ACCOUNT_B"' \
  'MAX_PERSONAL_CAPTURE_SPOOL_PATH=/spool/account-b' 'STAGE8B1I_HARNESS_MODE=capture-and-drain' \
  'STAGE8B1I_FRAME_COUNT=500' 'STAGE8B1I_IDENTICAL_COUNT=0' \
  'PREFIX-scraper-drain-a' 'MAX_PERSONAL_ACCOUNT_ID="$ACCOUNT_A"' \
  'MAX_PERSONAL_CAPTURE_SPOOL_PATH=/spool/account-a' 'STAGE8B1I_HARNESS_MODE=drain-only' \
  'STAGE8B1I_DRAIN_ATTEMPTS=120' '--network "$NETWORK"' '"$SPOOL_VOLUME:/spool"'; do
  rg -F -- "$evidence" <<<"$recovery_block" >/dev/null
done
drain_a_block=$(awk '/PREFIX-scraper-drain-a/{active=1} active{print} /stage8b1i-harness.js/{exit}' <<<"$recovery_block")
! rg -F 'STAGE8B1I_FRAME_COUNT' <<<"$drain_a_block" >/dev/null
! rg -F 'STAGE8B1I_IDENTICAL_COUNT' <<<"$drain_a_block" >/dev/null
pass recovery_account_isolation_runner_contract

gateway_client_block=$(phase_block gateway_active e2e_verification)
for evidence in 'PREFIX-gateway-client' '--network "$NETWORK"' '--env-file "$TMP/client.env"' \
  'STAGE8B1I_ACCOUNT_A="$ACCOUNT_A"' 'gateway-client-harness.js:/tmp/stage8b1i-client.js:ro' \
  'GATEWAY_CLIENT_VERIFICATION_FAILED'; do
  rg -F -- "$evidence" <<<"$gateway_client_block" >/dev/null
done
pass gateway_client_runner_contract

verification_block=$(phase_block e2e_verification final_storage_gate)
for evidence in 'pm_poll_until 180 240 E2E_VERIFICATION_FAILED' \
  'MaxRawTransportEvent' 'MaxInboundNormalizationResult' 'MaxShadowComparisonResult' \
  '$ACCOUNT_A' '$ACCOUNT_B' '$wrong_account -eq 0' '$duplicate_envelopes -eq 0'; do
  rg -F -- "$evidence" <<<"$verification_block" >/dev/null
done
pass e2e_verification_runner_contract

for evidence in 'free_bytes_at FREE_BYTES_AFTER_CLEANUP /var/lib/docker' \
  'pm_check_disk_gate "$FREE_BYTES_AFTER_CLEANUP" "$REQUIRED_FREE_BYTES" FINAL_DISK_GATE_FAILED' \
  'production_snapshot "$TMP_AFTER"' 'cmp "$TMP/production-before-core.json" "$TMP/production-after-core.json"' \
  'pm_validate_success_report "$TMP_REPORT"' 'chgrp codexbot "$TMP_REPORT"' 'chmod 0640 "$TMP_REPORT"' \
  'mv --no-clobber --no-target-directory'; do
  require_fixed "$PROBE" "$evidence"
done
pass final_storage_production_report_contract

# Required case 50: the separate text-canary branch remains exact and clean.
[[ -d $TEXT_CANARY_REPOSITORY/.git ]]
[[ $(env GIT_OPTIONAL_LOCKS=0 git -C "$TEXT_CANARY_REPOSITORY" branch --show-current) == "$TEXT_CANARY_BRANCH" ]]
[[ $(env GIT_OPTIONAL_LOCKS=0 git -C "$TEXT_CANARY_REPOSITORY" rev-parse HEAD) == "$TEXT_CANARY_COMMIT" ]]
[[ $(env GIT_OPTIONAL_LOCKS=0 git -C "$TEXT_CANARY_REPOSITORY" rev-parse "refs/remotes/origin/$TEXT_CANARY_BRANCH") == "$TEXT_CANARY_COMMIT" ]]
[[ -z $(env GIT_OPTIONAL_LOCKS=0 git -C "$TEXT_CANARY_REPOSITORY" status --porcelain=v1 --untracked-files=all) ]]
pass text_canary_unchanged

[[ $PASS_COUNT -eq 31 ]]
printf 'REMAINING_TAIL_TEST_COUNT=31\nREQUIRED_REGRESSION_CASES_COVERED=21\nROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\nDATABASE_CONNECTED=NO\n'
