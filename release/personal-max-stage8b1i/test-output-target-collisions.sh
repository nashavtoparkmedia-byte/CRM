#!/usr/bin/env bash
# Systematic non-root output-target collision suite. No Docker, database,
# network, root probe, migration, deploy, MAX, or provider action is performed.
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
source "$SCRIPT_DIR/bounded-operations.sh"
source "$SCRIPT_DIR/probe-output-helpers.sh"
source "$SCRIPT_DIR/postgres-startup.sh"
source "$SCRIPT_DIR/restore-verification.sh"

TEST_TMP=$(mktemp -d /tmp/personal-max-stage8b1i-output-collisions.XXXXXX)
trap 'rm -rf -- "$TEST_TMP"' EXIT
TMP=$TEST_TMP
PASS_COUNT=0
PROBE_ERROR_CLASSIFICATION=NONE
PROBE_SAFE_COMMAND_CLASS=package_validation
RESTORE_CHECK_ID=NONE
PG_CONTAINER=offline-postgres
PG_USER=offline-role
PG_DB=offline-database
STAGE_LABEL='personal-max.stage=8b1i'
RUN_LABEL_KEY='personal-max.run-id'
RUN_ID=abcdef123456

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '%s=PASS\n' "$1"; }
pm_test_timeout() { shift 3; "$@"; }
PM_TIMEOUT_BIN=pm_test_timeout

broken_child() {
  local __pm_target_name=$1 pm_result_postgres_version=''
  pm_result_postgres_version=160014
  pm_assign_out "$__pm_target_name" "$pm_result_postgres_version"
}
broken_caller() {
  local pm_result_postgres_version=''
  broken_child pm_result_postgres_version
  [[ -z $pm_result_postgres_version ]]
}
broken_caller
pass current_postgres_collision_reproduced

COLLISION_VERSION_MODE=success
COLLISION_VERSION_ATTEMPT=0
pm_postgres_capture_version_internal() {
  local __pm_internal_target=${1:-}
  COLLISION_VERSION_ATTEMPT=$((COLLISION_VERSION_ATTEMPT + 1))
  if [[ $COLLISION_VERSION_MODE == retry && $COLLISION_VERSION_ATTEMPT -eq 1 ]]; then return 2; fi
  pm_assign_internal_out "$__pm_internal_target" 160014
}
pm_result_postgres_version=''
pm_postgres_execute_version pm_result_postgres_version
[[ $pm_result_postgres_version == 160014 ]]
pass corrected_postgres_handoff

pm_result_checksum_line=old
sha_of pm_result_checksum_line "$SCRIPT_DIR/bounded-operations.sh"
[[ $pm_result_checksum_line =~ ^[0-9a-f]{64}$ && $pm_result_checksum_line != old ]]
pass semantically_similar_names

PROBE_ERROR_CLASSIFICATION=NONE
set +e
pm_capture_bounded_internal __pm_capture_value package_validation 5 METADATA_TIMEOUT METADATA_FAILED printf refused
collision_status=$?
set -e
[[ $collision_status -eq 65 && $PROBE_ERROR_CLASSIFICATION == OUTPUT_TARGET_SCOPE_COLLISION ]]
pass identical_internal_name_rejected

depth_two_child() {
  local __pm_target_name=$1 __pm_depth_value=''
  pm_capture_bounded_internal __pm_depth_value package_validation 5 METADATA_TIMEOUT METADATA_FAILED printf depth-two
  pm_assign_out "$__pm_target_name" "$__pm_depth_value"
}
depth_two_parent() {
  local pm_result_depth_two=''
  depth_two_child pm_result_depth_two
  [[ $pm_result_depth_two == depth-two ]]
}
depth_two_parent
pass nested_depth_two

depth_three_leaf() {
  local __pm_target_name=$1 __pm_leaf_value=''
  pm_capture_bounded_internal __pm_leaf_value package_validation 5 METADATA_TIMEOUT METADATA_FAILED printf depth-three
  pm_assign_out "$__pm_target_name" "$__pm_leaf_value"
}
depth_three_middle() {
  local __pm_target_name=$1
  depth_three_leaf "$__pm_target_name"
}
depth_three_parent() {
  local pm_result_depth_three=''
  depth_three_middle pm_result_depth_three
  [[ $pm_result_depth_three == depth-three ]]
}
depth_three_parent
pass nested_depth_three

pm_capture_bounded empty_output package_validation 5 METADATA_TIMEOUT METADATA_FAILED printf ''
[[ ${empty_output+x} == x && -z $empty_output ]]
pass empty_output

pm_capture_bounded one_line_output package_validation 5 METADATA_TIMEOUT METADATA_FAILED printf one-line
[[ $one_line_output == one-line ]]
pass one_line_output

pm_capture_bounded multiline_output package_validation 5 METADATA_TIMEOUT METADATA_FAILED printf 'one\ntwo\nthree'
[[ $multiline_output == $'one\ntwo\nthree' ]]
pass multiline_output

pm_capture_bounded trailing_output package_validation 5 METADATA_TIMEOUT METADATA_FAILED printf 'value\n\n'
[[ $trailing_output == value ]]
pass trailing_newline_semantics

normalized_version=''
pm_postgres_validate_version_num normalized_version $' \t160014\t ' 160014
[[ $normalized_version == 160014 && $POSTGRES_VERSION_OUTPUT_CATEGORY == WHITESPACE_NORMALIZED ]]
pass whitespace_normalized_version

set +e
pm_capture_bounded 'bad-target' package_validation 5 METADATA_TIMEOUT METADATA_FAILED printf refused
invalid_status=$?
set -e
[[ $invalid_status -eq 64 && $PROBE_ERROR_CLASSIFICATION == INVALID_OUT_PARAMETER ]]
pass invalid_destination

set +e
pm_capture_bounded __pm_external package_validation 5 METADATA_TIMEOUT METADATA_FAILED printf refused
reserved_status=$?
set -e
[[ $reserved_status -eq 64 && $PROBE_ERROR_CLASSIFICATION == INVALID_OUT_PARAMETER ]]
pass reserved_destination

unset previously_unset || true
pm_capture_bounded previously_unset package_validation 5 METADATA_TIMEOUT METADATA_FAILED printf initialized
[[ $previously_unset == initialized ]]
pass destination_unset_before_call

old_destination=old
pm_capture_bounded old_destination package_validation 5 METADATA_TIMEOUT METADATA_FAILED printf new
[[ $old_destination == new ]]
pass destination_old_value_replaced

failed_destination=preserved
set +e
pm_capture_bounded failed_destination package_validation 5 METADATA_TIMEOUT METADATA_FAILED sh -c 'exit 7'
failed_status=$?
set -e
[[ $failed_status -eq 7 && $failed_destination == preserved && $PROBE_ERROR_CLASSIFICATION == METADATA_FAILED ]]
pass failed_command_no_false_overwrite

PROBE_ERROR_CLASSIFICATION=POSTGRES_VERSION_QUERY_FAILED
matched_version=''
pm_postgres_validate_version_num matched_version 160014 160014
[[ $matched_version == 160014 && $PROBE_ERROR_CLASSIFICATION == NONE && \
  $POSTGRES_VERSION_CLASSIFICATION == POSTGRES_VERSION_MATCHED ]]
pass success_clears_stale_classification

pm_postgres_observe_container() {
  POSTGRES_CONTAINER_STATE=running
  POSTGRES_CONTAINER_EXIT_CODE=0
  POSTGRES_CONTAINER_HEALTH=none
}
COLLISION_VERSION_MODE=retry
COLLISION_VERSION_ATTEMPT=0
POSTGRES_VERSION_QUERY_ATTEMPTS=0
POSTGRES_VERSION_TRANSIENT_COUNT=0
POSTGRES_VERSION_LAST_EXIT=not_observed
POSTGRES_STARTUP_ELAPSED_SECONDS=0
retry_version=''
pm_postgres_wait_version retry_version 160014 3 30
[[ $retry_version == 160014 && $POSTGRES_VERSION_QUERY_ATTEMPTS -eq 2 && \
  $POSTGRES_VERSION_TRANSIENT_COUNT -eq 1 && $POSTGRES_STARTUP_STATUS == READY ]]
pass output_handoff_after_retry

restore_value=''
pm_restore_json_capture restore_value '.value' '{"value":"restore-safe"}'
[[ $restore_value == restore-safe ]]
pass restore_verification_handoff

LEDGER_NAME_COUNT=old
pm_restore_json_capture LEDGER_NAME_COUNT 'length' '["a","b"]'
[[ $LEDGER_NAME_COUNT -eq 2 ]]
pass ledger_verification_handoff

READINESS_FIXTURE_ATTEMPT=0
pm_postgres_execute_readiness() {
  READINESS_FIXTURE_ATTEMPT=$((READINESS_FIXTURE_ATTEMPT + 1))
  (( READINESS_FIXTURE_ATTEMPT > 1 ))
}
POSTGRES_READINESS_ATTEMPTS=0
POSTGRES_READINESS_TRANSIENT_COUNT=0
POSTGRES_READINESS_LAST_EXIT=not_observed
pm_postgres_wait_readiness 3 30
[[ $POSTGRES_READINESS_ATTEMPTS -eq 2 && $POSTGRES_READINESS_TRANSIENT_COUNT -eq 1 && \
  $POSTGRES_STARTUP_STATUS == READINESS_CONFIRMED ]]
pass postgres_readiness_handoff

docker() {
  [[ ${1:-} == ps ]] && printf 'fixture-a\nfixture-b\n'
}
cleanup_output=''
cleanup_inventory cleanup_output containers 5
[[ $cleanup_output == $'fixture-a\nfixture-b' ]]
pass cleanup_inventory_handoff

production_hash=''
hash_raw_command production_hash package_validation 5 METADATA_TIMEOUT METADATA_FAILED printf 'production-status-bytes\n'
[[ $production_hash == $(printf 'production-status-bytes\n' | sha256sum | awk '{print $1}') ]]
pass production_hash_handoff

rendered_report=''
pm_capture_bounded rendered_report report_render 5 METADATA_TIMEOUT METADATA_FAILED \
  jq -cn '{mode:"SAFE_FIXTURE",credentialsCaptured:false}'
jq -e '.mode=="SAFE_FIXTURE" and .credentialsCaptured==false' <<<"$rendered_report" >/dev/null
pass report_render_handoff

RUNTIME_FILES=(
  isolated-release-probe.sh bounded-operations.sh probe-output-helpers.sh postgres-startup.sh
  restore-verification.sh migration-preflight.sh failure-diagnostics.sh migration-sql-gate.sh
  prisma-legacy-diff-gate.sh prisma-diff-semantic-parser.py
)
runtime_paths=()
for runtime_file in "${RUNTIME_FILES[@]}"; do runtime_paths+=("$SCRIPT_DIR/$runtime_file"); done
if rg -n '(^|[[:space:]])eval([[:space:]]|$)' "${runtime_paths[@]}" >/dev/null; then exit 1; fi
pass no_runtime_eval

if rg -n 'printf[[:space:]]+-v' "${runtime_paths[@]}" >/dev/null; then exit 1; fi
pass no_unsafe_printf_v

unchanged_detection=old
pm_capture_bounded unchanged_detection package_validation 5 METADATA_TIMEOUT METADATA_FAILED printf definitely-new
[[ $unchanged_detection == definitely-new ]]
pass no_silent_success_with_unchanged_destination

set +e
broken_caller
old_collision_status=$?
set -e
[[ $old_collision_status -eq 0 ]]
pass old_collision_fixture_fails_handoff

corrected_real_helper() {
  local pm_result_postgres_version=''
  COLLISION_VERSION_MODE=success
  COLLISION_VERSION_ATTEMPT=0
  pm_postgres_execute_version pm_result_postgres_version
  [[ $pm_result_postgres_version == 160014 ]]
}
corrected_real_helper
pass corrected_real_helper_fixture

OUTPUT_LAYER_FILES=(
  "$SCRIPT_DIR/isolated-release-probe.sh"
  "$SCRIPT_DIR/bounded-operations.sh"
  "$SCRIPT_DIR/probe-output-helpers.sh"
  "$SCRIPT_DIR/postgres-startup.sh"
  "$SCRIPT_DIR/restore-verification.sh"
  "$SCRIPT_DIR/migration-preflight.sh"
)
if rg -n '\blocal\b[^\n]*(pm_result_|restore_result_)' "${OUTPUT_LAYER_FILES[@]}" >/dev/null; then exit 1; fi
if rg -n 'pm_capture_bounded[[:space:]]+__pm_' "${OUTPUT_LAYER_FILES[@]}" >/dev/null; then exit 1; fi
if rg --pcre2 -n 'pm_capture_bounded_internal[[:space:]]+(?!__pm_)[a-zA-Z_]' "${OUTPUT_LAYER_FILES[@]}" >/dev/null; then exit 1; fi
nameref_count=$(rg -n 'local -n|declare -n' "${runtime_paths[@]}" | wc -l)
[[ $nameref_count -eq 4 ]]
rg -F 'local -n __pm_out_ref="$__pm_target_name"' "$SCRIPT_DIR/bounded-operations.sh" >/dev/null
rg -F 'local -n __pm_assignment_ref="$__pm_assignment_target"' "$SCRIPT_DIR/bounded-operations.sh" >/dev/null
rg -F 'local -n __pm_out_ref="$__pm_target_name"' "$SCRIPT_DIR/isolated-release-probe.sh" >/dev/null
rg -F 'local -n __pm_assignment_ref="$__pm_assignment_target"' "$SCRIPT_DIR/isolated-release-probe.sh" >/dev/null
for internal_function in pm_assign_internal_out pm_capture_bounded_internal \
  pm_postgres_capture_version_internal pm_restore_query_internal pm_restore_json_capture_internal; do
  body=$(awk -v fn="$internal_function" '$0 ~ "^" fn "\\(\\)" {inside=1} inside{print} inside && /^}/{exit}' \
    "$SCRIPT_DIR/bounded-operations.sh" "$SCRIPT_DIR/postgres-startup.sh" "$SCRIPT_DIR/restore-verification.sh")
  [[ $body == *'pm_validate_internal_out_name'* && $body == *'pm_reject_out_collision'* ]]
done
pass full_package_source_audit

[[ $PASS_COUNT -eq 30 ]]
printf 'OUTPUT_TARGET_COLLISION_TEST_COUNT=30\nDYNAMIC_SCOPE_COLLISION_PROVEN=YES\nSTATIC_SOURCE_AUDIT=PASS\nROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\nDATABASE_CONNECTED=NO\n'
