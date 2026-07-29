#!/usr/bin/env bash
# Non-root migration-ledger integrity regression suite. No Docker or database.
# shellcheck disable=SC2034
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
readonly RESTORE_HELPER="$SCRIPT_DIR/restore-verification.sh"
readonly DIAGNOSTICS="$SCRIPT_DIR/failure-diagnostics.sh"
readonly PROBE="$SCRIPT_DIR/isolated-release-probe.sh"
PREFLIGHT_REPORT='/var/tmp/personal-max-stage8b1r-production-readonly-preflight.json'
ATTESTED_PRODUCTION_LEDGER_SHA256='3b77a5c161cbd9850ce3d45b38c2b0e5cc110d97b13f8b506e7723459766a4c3'
ACCEPTED_LEDGER_ONLY_MIGRATION='20260717000000_add_driver_telegram_submitted_phone'
EXPECTED_MIGRATIONS=(
  20260726162043_add_max_raw_transport_journal
  20260726190658_add_max_route_registry
  20260726205437_add_max_inbound_normalization
  20260726215715_add_max_per_chat_outbound_actor
  20260726225737_add_max_dispatch_ledger
  20260727053744_add_max_provider_confirmation_matcher
  20260727141925_add_max_shadow_semantic_comparison
  20260727154647_add_max_capture_ingress
)

# shellcheck source=release/personal-max-stage8b1i/bounded-operations.sh
source "$SCRIPT_DIR/bounded-operations.sh"
# shellcheck source=release/personal-max-stage8b1i/probe-output-helpers.sh
source "$SCRIPT_DIR/probe-output-helpers.sh"
# shellcheck source=release/personal-max-stage8b1i/restore-verification.sh
source "$RESTORE_HELPER"

TMP=$(mktemp -d /tmp/personal-max-stage8b1i-ledger.XXXXXX)
trap 'rm -rf -- "$TMP"' EXIT
PASS_COUNT=0
RESTORE_CHECK_ID=NONE
PROBE_ERROR_CLASSIFICATION=NONE

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '%s=PASS\n' "$1"; }

postgres_style_json() {
  jq -r 'map(tojson) | join(", ") | "["+.+"]"' <<<"$1"
}

reset_diagnostics() {
  PROBE_ERROR_CLASSIFICATION=NONE
  RESTORE_CHECK_ID=NONE
  LEDGER_NAME_COUNT=0
  LEDGER_UNIQUE_COUNT=0
  LEDGER_DUPLICATE_COUNT=0
  LEDGER_EMPTY_NAME_COUNT=0
  LEDGER_INVALID_FORMAT_COUNT=0
  LEDGER_UNSAFE_NAME_COUNT=0
  LEDGER_REPOSITORY_TO_LEDGER_COUNT=0
  LEDGER_TO_REPOSITORY_COUNT=0
  LEDGER_NAMES_SHA256=not_observed
  LEDGER_ATTESTATION_SHA256=not_observed
  LEDGER_INVALID_NAMING_CATEGORIES_JSON='[]'
  LEDGER_ACCEPTED_HISTORICAL_NAMES_JSON='[]'
  LEDGER_NAMING_CLASSIFICATION=NOT_OBSERVED
}

expect_analyze_failure() {
  local expected=$1 ledger_json=$2 status
  reset_diagnostics
  set +e
  pm_restore_analyze_ledger_json "$ledger_json" >/dev/null
  status=$?
  set -e
  [[ $status -eq 67 && $PROBE_ERROR_CLASSIFICATION == "$expected" && $RESTORE_CHECK_ID == RESTORE_LEDGER_NAMES_CHECK ]]
}

expect_validate_failure() {
  local expected=$1 ledger_json=$2 preflight=$3 repository=$4 status
  reset_diagnostics
  set +e
  pm_restore_validate_ledger_json "$ledger_json" "$preflight" "$repository" >/dev/null
  status=$?
  set -e
  [[ $status -eq 67 && $PROBE_ERROR_CLASSIFICATION == "$expected" && $RESTORE_CHECK_ID == RESTORE_LEDGER_NAMES_CHECK ]]
}

actual_array=$(jq -c '.database.migration.applied' "$PREFLIGHT_REPORT")
actual_ledger=$(postgres_style_json "$actual_array")
modern_array=$(for index in $(seq 1 46); do printf '20260101%06d_modern_%02d\n' "$index" "$index"; done | \
  jq -R -s -c 'split("\n")|map(select(length>0))')
modern_ledger=$(postgres_style_json "$modern_array")
find "$SCRIPT_DIR/../../gravity-mvp/prisma/migrations" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | \
  LC_ALL=C sort >"$TMP/repository-migrations"

reset_diagnostics
pm_restore_analyze_ledger_json "$modern_ledger"
[[ $LEDGER_NAME_COUNT -eq 46 && $LEDGER_UNIQUE_COUNT -eq 46 && $LEDGER_INVALID_FORMAT_COUNT -eq 0 ]]
pass unique_modern_names

reset_diagnostics
pm_restore_analyze_ledger_json "$actual_ledger"
[[ $LEDGER_INVALID_FORMAT_COUNT -eq 1 && $LEDGER_UNSAFE_NAME_COUNT -eq 0 &&
   $LEDGER_ACCEPTED_HISTORICAL_NAMES_JSON == '["0_init"]' ]]
pass legitimate_historical_name

reset_diagnostics
pm_restore_validate_ledger_json "$actual_ledger" "$PREFLIGHT_REPORT" "$TMP/repository-migrations"
[[ $LEDGER_TO_REPOSITORY_COUNT -eq 1 && $(<"$TMP/ledger-to-repository") == "$ACCEPTED_LEDGER_ONLY_MIGRATION" ]]
pass accepted_ledger_only_migration

duplicate_array=$(jq -c '.[45]=.[0]' <<<"$actual_array")
expect_analyze_failure RESTORE_LEDGER_DUPLICATE_NAME "$(postgres_style_json "$duplicate_array")"
pass duplicate_name

empty_array=$(jq -c '.[45]=""' <<<"$actual_array")
expect_analyze_failure RESTORE_LEDGER_UNSAFE_NAME "$(postgres_style_json "$empty_array")"
[[ $LEDGER_EMPTY_NAME_COUNT -eq 1 ]]
pass empty_name

control_array=$(jq -c '.[45]="unsafe\u0001name"' <<<"$actual_array")
expect_analyze_failure RESTORE_LEDGER_UNSAFE_NAME "$(postgres_style_json "$control_array")"
pass control_character

newline_array=$(jq -c '.[45]="unsafe\nname"' <<<"$actual_array")
expect_analyze_failure RESTORE_LEDGER_UNSAFE_NAME "$(postgres_style_json "$newline_array")"
pass unsafe_newline_structure

short_array=$(jq -c '.[0:45]' <<<"$actual_array")
expect_analyze_failure RESTORE_LEDGER_COUNT_MISMATCH "$(postgres_style_json "$short_array")"
pass forty_five_names

long_array=$(jq -c '.+["20260718000000_unexpected_extra"]' <<<"$actual_array")
expect_analyze_failure RESTORE_LEDGER_COUNT_MISMATCH "$(postgres_style_json "$long_array")"
pass forty_seven_names

reset_diagnostics
pm_restore_validate_ledger_json "$actual_ledger" "$PREFLIGHT_REPORT" "$TMP/repository-migrations"
[[ $LEDGER_REPOSITORY_TO_LEDGER_COUNT -eq 8 ]]
cmp -s "$TMP/repository-to-ledger" "$TMP/expected-migrations.sorted"
pass expected_eight_pending

jq '.database.migration.pending += ["20260729000000_unexpected_ninth"]' "$PREFLIGHT_REPORT" >"$TMP/preflight-ninth.json"
expect_validate_failure RESTORE_LEDGER_EXPECTED_SET_MISMATCH "$actual_ledger" "$TMP/preflight-ninth.json" "$TMP/repository-migrations"
pass unexpected_ninth_pending

reset_diagnostics
pm_restore_validate_ledger_json "$actual_ledger" "$PREFLIGHT_REPORT" "$TMP/repository-migrations"
[[ $(wc -l <"$TMP/ledger-to-repository") -eq 1 && $(<"$TMP/ledger-to-repository") == "$ACCEPTED_LEDGER_ONLY_MIGRATION" ]]
pass exact_accepted_ledger_only_difference

awk '$0!="20260315184000_add_unified_messaging"' "$TMP/repository-migrations" >"$TMP/repository-second-ledger-only"
expect_validate_failure RESTORE_LEDGER_EXPECTED_SET_MISMATCH "$actual_ledger" "$PREFLIGHT_REPORT" "$TMP/repository-second-ledger-only"
[[ $LEDGER_TO_REPOSITORY_COUNT -eq 2 ]]
pass second_ledger_only_difference

reset_diagnostics
pm_restore_analyze_ledger_json "$actual_ledger"
sorted_hash=$LEDGER_NAMES_SHA256
reversed_array=$(jq -c 'reverse' <<<"$actual_array")
reset_diagnostics
pm_restore_analyze_ledger_json "$(postgres_style_json "$reversed_array")"
[[ $LEDGER_NAMES_SHA256 == "$sorted_hash" ]]
pass stable_sorted_ledger_hash

changed_array=$(jq -c '.[45]="20260717000000_changed_safe_name"' <<<"$actual_array")
reset_diagnostics
pm_restore_analyze_ledger_json "$(postgres_style_json "$changed_array")"
[[ $LEDGER_NAMES_SHA256 != "$sorted_hash" ]]
pass changed_ledger_hash

rg -F 'ledgerDiagnostics:{ledgerNameCount:$ledgerNameCount' "$DIAGNOSTICS" >/dev/null
rg -F 'sqlCaptured:false,queryResultsCaptured:false' "$DIAGNOSTICS" >/dev/null
pass privacy_safe_diagnostic_output

! rg -n -- '--arg (rawSql|sql|query)|rawSqlCaptured:true|queryText:' "$DIAGNOSTICS" >/dev/null
pass no_sql_in_report

! rg -n -- 'representative_(users|contacts|chats)|messageContent|databaseRow' "$DIAGNOSTICS" >/dev/null
pass no_database_content

rg -F 'cleanup_disposable' "$PROBE" >/dev/null
rg -F '"$CLEANUP_VOLUMES_REMAINING" 0' "$PROBE" >/dev/null
pass cleanup_still_runs

old_invalid_count=$(jq '[.database.migration.applied[]|select(test("^[0-9]{14}_[a-z0-9_]+$")|not)]|length' "$PREFLIGHT_REPORT")
[[ $old_invalid_count -eq 1 ]]
pass old_failure_reproduced

reset_diagnostics
pm_restore_validate_ledger_json "$actual_ledger" "$PREFLIGHT_REPORT" "$TMP/repository-migrations"
[[ $LEDGER_NAMING_CLASSIFICATION == RESTORE_LEDGER_HISTORICAL_NAME_ACCEPTED &&
   $LEDGER_ATTESTATION_SHA256 == "$ATTESTED_PRODUCTION_LEDGER_SHA256" &&
   $LEDGER_REPOSITORY_TO_LEDGER_COUNT -eq 8 && $LEDGER_TO_REPOSITORY_COUNT -eq 1 ]]
pass corrected_real_historical_fixture

safe_historical_array=$(jq -c '.[45]="Legacy-Historical-Name"' <<<"$modern_array")
reset_diagnostics
pm_restore_analyze_ledger_json "$(postgres_style_json "$safe_historical_array")"
[[ $LEDGER_UNSAFE_NAME_COUNT -eq 0 && $LEDGER_INVALID_FORMAT_COUNT -eq 1 &&
   $LEDGER_INVALID_NAMING_CATEGORIES_JSON == *'uppercase_character'* &&
   $LEDGER_INVALID_NAMING_CATEGORIES_JSON == *'hyphenated_historical_name'* ]]
pass safe_uppercase_hyphen_category

[[ $PASS_COUNT -eq 22 ]]
printf 'LEDGER_REGRESSION_TEST_COUNT=22\nOLD_LEDGER_FAILURE=REPRODUCED\nCORRECTED_HISTORICAL_FIXTURE=PASS\nROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\nDATABASE_CONNECTED=NO\n'
