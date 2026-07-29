#!/usr/bin/env bash
# Executable non-root restore-verification regression suite. No Docker is run.
# shellcheck disable=SC2034,SC2154
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
readonly PROBE="$SCRIPT_DIR/isolated-release-probe.sh"
readonly DIAGNOSTICS="$SCRIPT_DIR/failure-diagnostics.sh"
readonly SCHEMA="$SCRIPT_DIR/../../gravity-mvp/prisma/schema.prisma"
# shellcheck source=release/personal-max-stage8b1i/bounded-operations.sh
source "$SCRIPT_DIR/bounded-operations.sh"
# shellcheck source=release/personal-max-stage8b1i/probe-output-helpers.sh
source "$SCRIPT_DIR/probe-output-helpers.sh"
# shellcheck source=release/personal-max-stage8b1i/restore-verification.sh
source "$SCRIPT_DIR/restore-verification.sh"
ORIGINAL_RESTORE_QUERY_RAW=$(declare -f pm_restore_query_raw)
readonly ORIGINAL_RESTORE_QUERY_RAW

TEST_TMP=$(mktemp -d /tmp/personal-max-stage8b1i-restore.XXXXXX)
trap 'rm -rf -- "$TEST_TMP"' EXIT
TMP=$TEST_TMP
PG_CONTAINER=fixture-postgres
PG_USER=fixture_user
PG_DB=fixture_database
RESTORE_CHECK_ID=NONE
PROBE_ERROR_CLASSIFICATION=NONE
PASS_COUNT=0
DOCKER_CALLS=0
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
find "$SCRIPT_DIR/../../gravity-mvp/prisma/migrations" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | \
  LC_ALL=C sort >"$TMP/repository-migrations"

docker() { DOCKER_CALLS=$((DOCKER_CALLS + 1)); return 99; }
pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '%s=PASS\n' "$1"; }

fixture_ledger_json() {
  jq -r '.database.migration.applied | map(tojson) | join(", ") | "["+.+"]"' "$PREFLIGHT_REPORT"
}

fixture_reset() {
  FIXTURE_CONTAINER_AVAILABLE=true
  FIXTURE_FINISHED=46
  FIXTURE_FAILED=0
  FIXTURE_TABLES=24
  FIXTURE_INDEXES=31
  FIXTURE_CONSTRAINTS=19
  FIXTURE_REQUIRED_MISSING=''
  FIXTURE_SQL_EXIT_CHECK=''
  FIXTURE_REPRESENTATIVE_EXIT_CHECK=''
  FIXTURE_LEDGER_JSON=$(fixture_ledger_json)
  FIXTURE_LAST_USERS_REQUIRED_QUERY=''
  FIXTURE_LAST_USERS_REPRESENTATIVE_QUERY=''
  PROBE_ERROR_CLASSIFICATION=NONE
  RESTORE_CHECK_ID=NONE
}

# Replace only the disposable-query backend. The complete production restore
# verification state machine remains the implementation under test.
pm_restore_query_raw() {
  local __pm_target_name=${1:-} __pm_failure_class=${2:-} __pm_query=${3-} __pm_value=''
  if [[ $FIXTURE_CONTAINER_AVAILABLE != true ]]; then
    PROBE_ERROR_CLASSIFICATION=DISPOSABLE_CONTAINER_UNAVAILABLE
    return 69
  fi
  if [[ $__pm_query == *'FROM "User"'* ]]; then
    PROBE_ERROR_CLASSIFICATION=$__pm_failure_class
    return 1
  fi
  if [[ $RESTORE_CHECK_ID == "$FIXTURE_SQL_EXIT_CHECK" ]]; then
    PROBE_ERROR_CLASSIFICATION=RESTORE_QUERY_FAILED
    return 1
  fi
  if [[ $RESTORE_CHECK_ID == "$FIXTURE_REPRESENTATIVE_EXIT_CHECK" && $__pm_query != *to_regclass* ]]; then
    PROBE_ERROR_CLASSIFICATION=RESTORE_REPRESENTATIVE_CHECK_FAILED
    return 1
  fi
  if [[ $__pm_query == *'OptionalFixture'* ]]; then
    __pm_value=f
  else
    case $RESTORE_CHECK_ID in
      RESTORE_LEDGER_FINISHED_CHECK) __pm_value=$FIXTURE_FINISHED ;;
      RESTORE_LEDGER_FAILED_CHECK) __pm_value=$FIXTURE_FAILED ;;
      RESTORE_LEDGER_NAMES_CHECK) __pm_value=$FIXTURE_LEDGER_JSON ;;
      RESTORE_CATALOG_TABLES_CHECK) __pm_value=$FIXTURE_TABLES ;;
      RESTORE_CATALOG_INDEXES_CHECK) __pm_value=$FIXTURE_INDEXES ;;
      RESTORE_CATALOG_CONSTRAINTS_CHECK) __pm_value=$FIXTURE_CONSTRAINTS ;;
      RESTORE_REQUIRED_PRISMA_MIGRATIONS_RELATION_CHECK) [[ $FIXTURE_REQUIRED_MISSING == prisma ]] && __pm_value=f || __pm_value=t ;;
      RESTORE_REQUIRED_USERS_RELATION_CHECK)
        FIXTURE_LAST_USERS_REQUIRED_QUERY=$__pm_query
        [[ $FIXTURE_REQUIRED_MISSING == users ]] && __pm_value=f || __pm_value=t
        ;;
      RESTORE_REQUIRED_CONTACT_RELATION_CHECK) [[ $FIXTURE_REQUIRED_MISSING == contact ]] && __pm_value=f || __pm_value=t ;;
      RESTORE_REQUIRED_CHAT_RELATION_CHECK) [[ $FIXTURE_REQUIRED_MISSING == chat ]] && __pm_value=f || __pm_value=t ;;
      RESTORE_REPRESENTATIVE_MIGRATIONS_CHECK) [[ $__pm_query == *to_regclass* ]] && __pm_value=t || __pm_value=46 ;;
      RESTORE_REPRESENTATIVE_USER_CHECK)
        FIXTURE_LAST_USERS_REPRESENTATIVE_QUERY=$__pm_query
        [[ $__pm_query == *to_regclass* ]] && __pm_value=t || __pm_value=7
        ;;
      RESTORE_REPRESENTATIVE_CONTACT_CHECK) [[ $__pm_query == *to_regclass* ]] && __pm_value=t || __pm_value=8 ;;
      RESTORE_REPRESENTATIVE_CHAT_CHECK) [[ $__pm_query == *to_regclass* ]] && __pm_value=t || __pm_value=9 ;;
      *) PROBE_ERROR_CLASSIFICATION=RESTORE_QUERY_FAILED; return 64 ;;
    esac
  fi
  pm_assign_out "$__pm_target_name" "$__pm_value"
}

expect_full_failure() {
  local __pm_expected_class=$1 __pm_expected_check=$2 __pm_status
  set +e
  pm_restore_verify_database >/dev/null
  __pm_status=$?
  set -e
  (( __pm_status != 0 ))
  [[ $PROBE_ERROR_CLASSIFICATION == "$__pm_expected_class" && $RESTORE_CHECK_ID == "$__pm_expected_check" ]]
}

run_actual_backend_case() {
  local __pm_mode=$1
  (
    eval "$ORIGINAL_RESTORE_QUERY_RAW"
    pm_test_timeout() { shift 3; "$@"; }
    docker() {
      if [[ $__pm_mode == unavailable ]]; then return 1; fi
      if [[ ${1:-} == inspect ]]; then printf 'true\n'; return 0; fi
      return 1
    }
    PM_TIMEOUT_BIN=pm_test_timeout
    PROBE_ERROR_CLASSIFICATION=NONE
    RESTORE_CHECK_ID=NONE
    set +e
    pm_restore_query actual_backend_value RESTORE_LEDGER_FINISHED_CHECK RESTORE_QUERY_FAILED 'SELECT 1'
    actual_backend_status=$?
    set -e
    printf '%s|%s|%s\n' "$actual_backend_status" "$PROBE_ERROR_CLASSIFICATION" "$RESTORE_CHECK_ID"
  )
}

fixture_reset
pm_restore_verify_database
[[ $FIXTURE_LAST_USERS_REQUIRED_QUERY == *'public."users"'* ]]
[[ $FIXTURE_LAST_USERS_REPRESENTATIVE_QUERY == *'FROM "users"'* ]]
[[ $FIXTURE_LAST_USERS_REPRESENTATIVE_QUERY != *'FROM "User"'* ]]
jq -e '.user.physicalRelation=="users" and .user.available==true and .contentPrinted==false' \
  "$TMP/representative-counts.json" >/dev/null
pass mapped_table_names

fixture_reset
optional_count=sentinel
optional_available=true
pm_restore_optional_representative optional_count optional_available RESTORE_REPRESENTATIVE_USER_CHECK \
  'SELECT to_regclass('\''public."OptionalFixture"'\'') IS NOT NULL' 'SELECT count(*) FROM "OptionalFixture"'
[[ $optional_count == null && $optional_available == false ]]
pass optional_representative_absent

fixture_reset
FIXTURE_REQUIRED_MISSING=users
expect_full_failure RESTORE_REQUIRED_RELATION_MISSING RESTORE_REQUIRED_USERS_RELATION_CHECK
pass required_relation_absent

fixture_reset
pm_restore_verify_database
[[ $ledger_before_finished -eq 46 && $ledger_before_failed -eq 0 ]]
pass ledger_46_46_0

fixture_reset
FIXTURE_FAILED=1
expect_full_failure RESTORE_LEDGER_COUNT_MISMATCH RESTORE_LEDGER_FAILED_CHECK
pass failed_ledger_entry

fixture_reset
FIXTURE_FAILED=1
expect_full_failure RESTORE_LEDGER_COUNT_MISMATCH RESTORE_LEDGER_FAILED_CHECK
pass rolled_back_ledger_entry

fixture_reset
FIXTURE_TABLES=0
expect_full_failure RESTORE_CATALOG_INTEGRITY_FAILED RESTORE_CATALOG_TABLES_CHECK
pass catalog_tables_zero

fixture_reset
FIXTURE_INDEXES=0
expect_full_failure RESTORE_CATALOG_INTEGRITY_FAILED RESTORE_CATALOG_INDEXES_CHECK
pass catalog_indexes_zero

fixture_reset
FIXTURE_CONSTRAINTS=0
expect_full_failure RESTORE_CATALOG_INTEGRITY_FAILED RESTORE_CATALOG_CONSTRAINTS_CHECK
pass catalog_constraints_zero

actual_sql_failure=$(run_actual_backend_case sql_exit)
[[ $actual_sql_failure == '1|RESTORE_QUERY_FAILED|RESTORE_LEDGER_FINISHED_CHECK' ]]
pass sql_exit_one

actual_container_failure=$(run_actual_backend_case unavailable)
[[ $actual_container_failure == '69|DISPOSABLE_CONTAINER_UNAVAILABLE|RESTORE_LEDGER_FINISHED_CHECK' ]]
pass container_unavailable

fixture_reset
FIXTURE_REQUIRED_MISSING=contact
expect_full_failure RESTORE_REQUIRED_RELATION_MISSING RESTORE_REQUIRED_CONTACT_RELATION_CHECK
pm_restore_check_id_is_safe "$RESTORE_CHECK_ID"
pass exact_safe_check_id

! rg -n -- '--arg (rawSql|sql|query)|rawSqlCaptured:true|queryText' "$DIAGNOSTICS" >/dev/null
pass no_sql_in_failure_report

! rg -n -- '--arg (queryResult|resultRows)|queryResult|database contents' "$DIAGNOSTICS" >/dev/null
pass no_query_result_in_failure_report

! rg -n -- 'PG_PASSWORD|DATABASE_URL|HMAC_SECRET|credentialsCaptured:true' "$DIAGNOSTICS" >/dev/null
pass no_credentials_in_failure_report

preserved=$(pm_preserve_original_exit 42 70)
[[ $preserved == 42 ]]
pass original_exit_preserved

rg -F 'cleanup_disposable' "$PROBE" >/dev/null
rg -F '"$CLEANUP_VOLUMES_REMAINING" 0' "$PROBE" >/dev/null
pass cleanup_still_runs

rg -F 'NO_CLOBBER_REPORT_PATH_EXISTS' "$PROBE" >/dev/null
rg -F 'mv --no-clobber --no-target-directory' "$PROBE" >/dev/null
pass package_no_clobber

fixture_reset
old_invalid_count=$(jq '[.database.migration.applied[]|select(test("^[0-9]{14}_[a-z0-9_]+$")|not)]|length' "$PREFLIGHT_REPORT")
[[ $old_invalid_count -eq 1 ]]
pass old_failure_reproduced

fixture_reset
pm_restore_verify_database
[[ $RESTORE_CHECK_ID == RESTORE_REPORT_RENDER_CHECK && $representative_users -eq 7 ]]
pass corrected_fixture_passes

fixture_reset
FIXTURE_LEDGER_JSON=$(jq -r '.database.migration.applied | .[45]=.[0] | map(tojson) | join(", ") | "["+.+"]"' "$PREFLIGHT_REPORT")
expect_full_failure RESTORE_LEDGER_DUPLICATE_NAME RESTORE_LEDGER_NAMES_CHECK
pass ledger_names_mismatch

fixture_reset
FIXTURE_REPRESENTATIVE_EXIT_CHECK=RESTORE_REPRESENTATIVE_CONTACT_CHECK
expect_full_failure RESTORE_REPRESENTATIVE_CHECK_FAILED RESTORE_REPRESENTATIVE_CONTACT_CHECK
pass representative_failure_classification

for classification in RESTORE_LEDGER_COUNT_MISMATCH RESTORE_LEDGER_DUPLICATE_NAME RESTORE_LEDGER_UNSAFE_NAME \
  RESTORE_LEDGER_EXPECTED_SET_MISMATCH RESTORE_LEDGER_HISTORICAL_NAME_ACCEPTED RESTORE_REQUIRED_RELATION_MISSING \
  RESTORE_CATALOG_INTEGRITY_FAILED RESTORE_REPRESENTATIVE_CHECK_FAILED RESTORE_QUERY_FAILED \
  DISPOSABLE_CONTAINER_UNAVAILABLE; do
  pm_error_classification_is_safe "$classification"
done
pass restore_classification_allowlist

rg -F 'RESTORE_REPORT_RENDER_CHECK' "$SCRIPT_DIR/restore-verification.sh" >/dev/null
rg -F 'checkId:$checkId' "$DIAGNOSTICS" >/dev/null
pass report_render_check_id

user_model=$(sed -n '/^model User {/,/^}/p' "$SCHEMA")
chat_model=$(sed -n '/^model Chat {/,/^}/p' "$SCHEMA")
contact_model=$(sed -n '/^model Contact {/,/^}/p' "$SCHEMA")
grep -F '@@map("users")' <<<"$user_model" >/dev/null
! grep -F '@@map(' <<<"$chat_model" >/dev/null
! grep -F '@@map(' <<<"$contact_model" >/dev/null
pass prisma_mapping_audit

[[ $PASS_COUNT -eq 25 && $DOCKER_CALLS -eq 0 ]]
printf 'RESTORE_REGRESSION_TEST_COUNT=25\nOLD_FAILURE=REPRODUCED\nFIXED_PATH=PASS\nROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\n'
