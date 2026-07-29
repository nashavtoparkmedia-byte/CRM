#!/usr/bin/env bash
# Executable bidirectional phase-registry and exact route contract. No Docker or database access.
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
readonly BOUNDED="$SCRIPT_DIR/bounded-operations.sh"
readonly DIAGNOSTICS="$SCRIPT_DIR/failure-diagnostics.sh"
readonly PROBE="$SCRIPT_DIR/isolated-release-probe.sh"
readonly SCHEMA="$SCRIPT_DIR/report-schema.json"

# shellcheck source=release/personal-max-stage8b1i/bounded-operations.sh
source "$BOUNDED"
# shellcheck source=release/personal-max-stage8b1i/failure-diagnostics.sh
source "$DIAGNOSTICS"

TEST_TMP=$(mktemp -d /tmp/personal-max-stage8b1i-phase-registry.XXXXXX)
trap 'rm -rf -- "$TEST_TMP"' EXIT
PASS_COUNT=0
pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '%s=PASS\n' "$1"; }

pm_registered_phases >"$TEST_TMP/bounded-phases"
personal_max_stage8b1i_registered_phases >"$TEST_TMP/diagnostic-phases"
jq -r '.allOf[1].then.properties.phase.enum[]' "$SCHEMA" >"$TEST_TMP/primary-schema-phases"
jq -r '.allOf[2].then.properties.phase.enum[]' "$SCHEMA" >"$TEST_TMP/emergency-schema-phases"
awk '$1=="pm_enter_phase" {print $2}' "$PROBE" >"$TEST_TMP/probe-literal-phases"

[[ $(wc -l <"$TEST_TMP/bounded-phases") -eq 30 ]]
pass authoritative_phase_count

[[ $(grep -c '^scraper_runtime_contract$' "$TEST_TMP/bounded-phases") -eq 1 ]]
pass scraper_runtime_contract_registered

cmp "$TEST_TMP/bounded-phases" "$TEST_TMP/diagnostic-phases" >/dev/null
pass bounded_diagnostics_exact_sync

cmp "$TEST_TMP/bounded-phases" "$TEST_TMP/primary-schema-phases" >/dev/null
pass primary_report_schema_exact_sync

cmp "$TEST_TMP/bounded-phases" "$TEST_TMP/emergency-schema-phases" >/dev/null
pass emergency_report_schema_exact_sync

while IFS= read -r phase; do pm_phase_is_safe "$phase"; done <"$TEST_TMP/probe-literal-phases"
pass every_probe_literal_registered

while IFS= read -r phase; do grep -Fx -- "$phase" "$TEST_TMP/primary-schema-phases" >/dev/null; done <"$TEST_TMP/probe-literal-phases"
pass every_probe_literal_in_report_schema

cat >"$TEST_TMP/expected-route" <<'EOF'
source_binding
storage_gate
production_snapshot_before
image_acquisition
post_pull_storage_gate
image_acquisition
post_pull_storage_gate
image_verification
disposable_topology
postgresql_start
backup_restore
migration_preflight
restore_verification
migration_preflight
disposable_migration
migration_verification
gateway_negative
gateway_dormant
gateway_active
scraper_runtime_contract
scraper_default_off
e2e_outage
e2e_recovery
gateway_active
e2e_verification
final_storage_gate
production_snapshot_after
report_render
report_validation
report_handoff
completed
EOF
awk '
  $1=="pm_enter_phase" && $2=="source_binding" {route=1}
  route && $1=="pm_enter_phase" {print $2}
' "$PROBE" >"$TEST_TMP/actual-route"
cmp "$TEST_TMP/expected-route" "$TEST_TMP/actual-route" >/dev/null
pass exact_monotonic_route

while IFS= read -r phase; do rg -x "$phase" "$TEST_TMP/actual-route" >/dev/null; done < <(sort -u "$TEST_TMP/expected-route")
pass every_expected_route_phase_present

[[ $(grep -c '^gateway_active$' "$TEST_TMP/actual-route") -eq 2 ]]
pass repeated_gateway_active_exact

runtime_line=$(grep -n '^scraper_runtime_contract$' "$TEST_TMP/actual-route" | cut -d: -f1)
default_line=$(grep -n '^scraper_default_off$' "$TEST_TMP/actual-route" | cut -d: -f1)
[[ $runtime_line -lt $default_line ]]
pass runtime_before_default_off

PROBE_PHASE=gateway_active
PROBE_ERROR_CLASSIFICATION=GATEWAY_ACTIVE_READINESS_FAILED
set +e
pm_enter_phase unknown_phase package_validation >"$TEST_TMP/unknown-output"
unknown_status=$?
set -e
[[ $unknown_status -eq 64 && $PROBE_ERROR_CLASSIFICATION == PHASE_REGISTRY_MISMATCH &&
  $PROBE_PHASE == gateway_active && ! -s $TEST_TMP/unknown-output ]]
pass unknown_phase_rejected_exactly

for unsafe in '' gateway 'gateway_active_extra' ' gateway_active' 'gateway_active ' $'gateway_active\n'; do
  if pm_phase_is_safe "$unsafe"; then exit 1; fi
done
pass empty_substring_whitespace_rejected

transition_count=0
while IFS= read -r phase; do
  PROBE_ERROR_CLASSIFICATION=GATEWAY_ACTIVE_READINESS_FAILED
  pm_enter_phase "$phase" package_validation >"$TEST_TMP/phase-output"
  [[ $PROBE_PHASE == "$phase" && $PROBE_ERROR_CLASSIFICATION == NONE ]]
  [[ $(<"$TEST_TMP/phase-output") == "STAGE8B1I_PHASE=$phase" ]]
  transition_count=$((transition_count + 1))
done <"$TEST_TMP/actual-route"
[[ $transition_count -eq 31 ]]
pass actual_route_never_returns_64

[[ $(rg -c "printf 'STAGE8B1I_PHASE=%s" "$BOUNDED") -eq 1 ]]
[[ $(rg -c "printf 'STAGE8B1I_PHASE=bootstrap_complete" "$PROBE") -eq 1 ]]
pass phase_output_sources_bounded

while IFS= read -r phase; do personal_max_stage8b1i_safe_phase "$phase"; done <"$TEST_TMP/bounded-phases"
pass failure_reports_accept_every_phase

comm -23 <(sort "$TEST_TMP/bounded-phases") <(sort "$TEST_TMP/primary-schema-phases") | grep -q . && exit 1 || true
pass no_registered_phase_absent_from_schema

comm -13 <(sort "$TEST_TMP/bounded-phases") <(sort "$TEST_TMP/primary-schema-phases") | grep -q . && exit 1 || true
pass no_schema_phase_accidentally_executable

rg -x prior_residual_cleanup "$TEST_TMP/bounded-phases" >/dev/null
! rg -x prior_residual_cleanup "$TEST_TMP/actual-route" >/dev/null
pass historical_dormant_phase_deliberate

[[ $(tail -n1 "$TEST_TMP/actual-route") == completed ]]
pass completed_is_exact_terminal_phase

[[ $PASS_COUNT -eq 20 ]]
printf 'PHASE_REGISTRY_TEST_COUNT=20\nREGISTERED_PHASE_COUNT=30\nROUTE_TRANSITION_COUNT=31\nROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\nDATABASE_CONNECTED=NO\n'
