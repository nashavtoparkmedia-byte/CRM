#!/usr/bin/env bash
# Offline PostgreSQL network-alias binding and diagnostic regression suite.
# The docker command is a shell fixture; no Docker socket, database, root,
# network, MAX, provider, browser, deploy, migration, or restart is used.
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
source "$SCRIPT_DIR/bounded-operations.sh"
source "$SCRIPT_DIR/probe-output-helpers.sh"
source "$SCRIPT_DIR/migration-preflight.sh"

PASS_COUNT=0
PROBE_ERROR_CLASSIFICATION=NONE
PROBE_SAFE_COMMAND_CLASS=package_validation
NETWORK=personal-max-stage8b1i-abcdef123456-internal
ALIAS=personal-max-stage8b1i-abcdef123456-postgres-dns
readonly NETWORK ALIAS

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '%s=PASS\n' "$1"; }
pm_test_timeout() { shift 3; "$@"; }
PM_TIMEOUT_BIN=pm_test_timeout
MOCK_INSPECT_STATUS=0

docker() {
  [[ ${1:-} == inspect ]] || return 64
  return "$MOCK_INSPECT_STATUS"
}

reset_alias_state() {
  PROBE_ERROR_CLASSIFICATION=NONE
  MIGRATION_PRIMARY_CLASSIFICATION=NONE
  MIGRATION_ORIGINAL_EXIT=not_observed
  MIGRATION_CHECK_ID=NONE
  MIGRATION_POSTGRES_ALIAS_VALIDATION_CLASSIFICATION=NONE
}

expect_alias_failure() {
  local __pm_name=$1 __pm_facts=$2 __pm_class=$3 __pm_exit=${4:-65} __pm_status
  reset_alias_state
  set +e
  pm_migration_validate_alias_facts "$__pm_facts" "$NETWORK" "$ALIAS" >/dev/null 2>&1
  __pm_status=$?
  set -e
  [[ $__pm_status -eq $__pm_exit && $MIGRATION_PRIMARY_CLASSIFICATION == "$__pm_class" && \
    $MIGRATION_POSTGRES_ALIAS_VALIDATION_CLASSIFICATION == "$__pm_class" ]]
  pass "$__pm_name"
}

expect_alias_failure exact_current_failure_fixture '' MIGRATION_POSTGRES_NETWORK_FACTS_MALFORMED

reset_alias_state
pm_migration_validate_alias_facts \
  '{"running":true,"networks":{"personal-max-stage8b1i-abcdef123456-internal":{"Aliases":["personal-max-stage8b1i-abcdef123456-postgres-dns"]}}}' \
  "$NETWORK" "$ALIAS"
[[ $MIGRATION_PRIMARY_CLASSIFICATION == NONE && $MIGRATION_POSTGRES_OBSERVED_NETWORK_COUNT -eq 1 && \
  $MIGRATION_POSTGRES_EXPECTED_NETWORK_PRESENT == true && $MIGRATION_POSTGRES_ALIAS_ARRAY_PRESENT == true && \
  $MIGRATION_POSTGRES_EXPECTED_ALIAS_PRESENT == true && $MIGRATION_POSTGRES_UNEXPECTED_NETWORK_PRESENT == false ]]
pass exact_network_and_alias

expect_alias_failure alias_null \
  '{"running":true,"networks":{"personal-max-stage8b1i-abcdef123456-internal":{"Aliases":null}}}' \
  MIGRATION_POSTGRES_ALIAS_ARRAY_MISSING
expect_alias_failure alias_empty \
  '{"running":true,"networks":{"personal-max-stage8b1i-abcdef123456-internal":{"Aliases":[]}}}' \
  MIGRATION_POSTGRES_ALIAS_MISSING
expect_alias_failure expected_alias_absent \
  '{"running":true,"networks":{"personal-max-stage8b1i-abcdef123456-internal":{"Aliases":["different-alias"]}}}' \
  MIGRATION_POSTGRES_ALIAS_MISMATCH
expect_alias_failure alias_substring_only \
  '{"running":true,"networks":{"personal-max-stage8b1i-abcdef123456-internal":{"Aliases":["personal-max-stage8b1i-abcdef123456-postgres-dns-extra"]}}}' \
  MIGRATION_POSTGRES_ALIAS_MISMATCH
expect_alias_failure wrong_network \
  '{"running":true,"networks":{"personal-max-stage8b1i-abcdef123456-other":{"Aliases":["personal-max-stage8b1i-abcdef123456-postgres-dns"]}}}' \
  MIGRATION_POSTGRES_UNEXPECTED_NETWORK
expect_alias_failure multiple_networks \
  '{"running":true,"networks":{"personal-max-stage8b1i-abcdef123456-internal":{"Aliases":["personal-max-stage8b1i-abcdef123456-postgres-dns"]},"personal-max-stage8b1i-abcdef123456-other":{"Aliases":[]}}}' \
  MIGRATION_POSTGRES_UNEXPECTED_NETWORK
expect_alias_failure malformed_json '{not-json' MIGRATION_POSTGRES_NETWORK_FACTS_MALFORMED

reset_alias_state
set +e
pm_migration_reject_before_command MIGRATION_POSTGRES_ALIAS_CHECK postgres_alias_validation postgres \
  docker_inspect docker_cli MIGRATION_COMMAND_NOT_STARTED 64
not_started_status=$?
set -e
[[ $not_started_status -eq 64 && $MIGRATION_COMMAND_STARTED == false && $MIGRATION_CHECK_ID == MIGRATION_POSTGRES_ALIAS_CHECK ]]
pass inspect_command_not_started

reset_alias_state
MOCK_INSPECT_STATUS=125
set +e
pm_migration_capture_bounded ignored MIGRATION_POSTGRES_ALIAS_CHECK postgres_alias_validation postgres \
  docker_inspect docker_cli 30 MIGRATION_POSTGRES_INSPECT_FAILED MIGRATION_POSTGRES_INSPECT_FAILED docker inspect fixture
cli_status=$?
set -e
[[ $cli_status -eq 125 && $MIGRATION_PRIMARY_CLASSIFICATION == MIGRATION_DOCKER_CLI_FAILED && \
  $MIGRATION_ORIGINAL_EXIT -eq 125 ]]
pass docker_cli_exit_125

reset_alias_state
MOCK_INSPECT_STATUS=1
set +e
pm_migration_capture_bounded ignored MIGRATION_POSTGRES_ALIAS_CHECK postgres_alias_validation postgres \
  docker_inspect docker_cli 30 MIGRATION_POSTGRES_INSPECT_FAILED MIGRATION_POSTGRES_INSPECT_FAILED docker inspect fixture
unavailable_status=$?
set -e
[[ $unavailable_status -eq 1 && $MIGRATION_PRIMARY_CLASSIFICATION == MIGRATION_POSTGRES_INSPECT_FAILED ]]
pass container_unavailable
MOCK_INSPECT_STATUS=0

expect_alias_failure container_not_running \
  '{"running":false,"networks":{"personal-max-stage8b1i-abcdef123456-internal":{"Aliases":["personal-max-stage8b1i-abcdef123456-postgres-dns"]}}}' \
  MIGRATION_CONTAINER_UNAVAILABLE 69

rg -U -- '--network "\$NETWORK" \\\n+  --network-alias "\$EXPECTED_POSTGRES_ALIAS"' "$SCRIPT_DIR/isolated-release-probe.sh" >/dev/null
pass explicit_alias_in_launch

rg -F 'pm_migration_build_database_url DATABASE_URL "$PG_USER" "$PG_PASSWORD" "$EXPECTED_POSTGRES_ALIAS" "$PG_DB"' \
  "$SCRIPT_DIR/isolated-release-probe.sh" >/dev/null
valid_password=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
database_url=''
pm_migration_build_database_url database_url valid_user "$valid_password" "$ALIAS" valid_db
[[ $database_url == *@"$ALIAS":5432/* ]]
pass database_url_exact_alias

rg -F 'pm_migration_build_database_url SHADOW_DATABASE_URL "$PG_USER" "$PG_PASSWORD" "$EXPECTED_POSTGRES_ALIAS" "$PG_SHADOW_DB"' \
  "$SCRIPT_DIR/isolated-release-probe.sh" >/dev/null
shadow_database_url=''
pm_migration_build_database_url shadow_database_url valid_user "$valid_password" "$ALIAS" valid_shadow
[[ $shadow_database_url == *@"$ALIAS":5432/* ]]
pass shadow_database_url_exact_alias

if rg -n 'printf.*(DATABASE_URL|SHADOW_DATABASE_URL)' "$SCRIPT_DIR/migration-preflight.sh" \
    "$SCRIPT_DIR/failure-diagnostics.sh" >/dev/null; then exit 1; fi
pass database_urls_not_emitted

sentinel_password=SECRET_ALIAS_TEST_SENTINEL
captured=$(pm_migration_build_database_url ignored valid_user "$sentinel_password" "$ALIAS" valid_db 2>&1 || true)
[[ $captured != *SECRET_ALIAS_TEST_SENTINEL* ]]
pass password_not_emitted

raw_fixture='{"running":true,"networks":{"personal-max-stage8b1i-abcdef123456-internal":{"Aliases":["RAW_INSPECT_SENTINEL"]}}}'
captured=$(pm_migration_validate_alias_facts "$raw_fixture" "$NETWORK" "$ALIAS" 2>&1 || true)
[[ $captured != *RAW_INSPECT_SENTINEL* ]]
rg -F 'rawInspectCaptured:false' "$SCRIPT_DIR/failure-diagnostics.sh" >/dev/null
pass raw_inspect_not_emitted

pm_migration_enter_check MIGRATION_POSTGRES_ALIAS_CHECK postgres_alias_validation postgres internal_validator docker_cli
set +e
pm_migration_record_failure MIGRATION_POSTGRES_ALIAS_MISMATCH 65 running
first_status=$?
PROBE_ERROR_CLASSIFICATION=MIGRATION_NETWORK_ALIAS_MISMATCH
pm_migration_record_failure MIGRATION_NETWORK_ALIAS_MISMATCH 66 running
second_status=$?
set -e
[[ $first_status -eq 65 && $second_status -eq 65 && \
  $MIGRATION_PRIMARY_CLASSIFICATION == MIGRATION_POSTGRES_ALIAS_MISMATCH ]]
pass primary_classification_preserved
[[ $MIGRATION_ORIGINAL_EXIT -eq 65 ]]
pass original_exit_preserved
[[ $MIGRATION_CHECK_ID == MIGRATION_POSTGRES_ALIAS_CHECK && $MIGRATION_CHECK_ID != NONE ]]
pass check_id_not_none

rg -F 'trap on_exit EXIT' "$SCRIPT_DIR/isolated-release-probe.sh" >/dev/null
rg -F 'globalPrune:false' "$SCRIPT_DIR/failure-diagnostics.sh" >/dev/null
pass cleanup_contract_preserved

rg -F "readonly ACCEPTED_PRODUCTION_HEAD='e6a0a833fbb756216b058bfe326f9f9c77c4cc6d'" \
  "$SCRIPT_DIR/isolated-release-probe.sh" >/dev/null
rg -F "readonly ACCEPTED_PRODUCTION_STATUS_V2_RAW_SHA256='2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b'" \
  "$SCRIPT_DIR/isolated-release-probe.sh" >/dev/null
pass production_fingerprints_unchanged

[[ $(wc -l <"$SCRIPT_DIR/migration-sql-bindings.txt") -eq 8 ]]
[[ $(sha256sum "$SCRIPT_DIR/migration-sql-bindings.txt" | awk '{print $1}') == \
  9128eba91ecb5ce9d010015031050379cd45941fff93bef721df889040a56f8f ]]
pass exact_eight_unchanged

CANARY=/home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z
[[ $(git -C "$CANARY" branch --show-current) == feature/personal-max-text-canary-autonomous-20260728T211316Z ]]
[[ $(git -C "$CANARY" rev-parse HEAD) == 5debe647a5320adbc51ed94fd7c0ab87d6468a4f ]]
[[ -z $(git -C "$CANARY" status --porcelain=v2) ]]
pass text_canary_untouched

reset_alias_state
PROBE_ERROR_CLASSIFICATION=MIGRATION_POSTGRES_ALIAS_MISMATCH
MIGRATION_PRIMARY_CLASSIFICATION=MIGRATION_POSTGRES_ALIAS_MISMATCH
pm_migration_validate_alias_facts \
  '{"running":true,"networks":{"personal-max-stage8b1i-abcdef123456-internal":{"Aliases":["personal-max-stage8b1i-abcdef123456-postgres-dns"]}}}' \
  "$NETWORK" "$ALIAS"
[[ $MIGRATION_PRIMARY_CLASSIFICATION == NONE && $PROBE_ERROR_CLASSIFICATION == NONE && \
  $MIGRATION_ORIGINAL_EXIT -eq 0 && $MIGRATION_POSTGRES_ALIAS_VALIDATION_CLASSIFICATION == NONE ]]
pass success_clears_transient

migration_sha=$(sha256sum "$SCRIPT_DIR/migration-preflight.sh" | awk '{print $1}')
diagnostics_sha=$(sha256sum "$SCRIPT_DIR/failure-diagnostics.sh" | awk '{print $1}')
rg -F "readonly MIGRATION_PREFLIGHT_SHA256='$migration_sha'" "$SCRIPT_DIR/isolated-release-probe.sh" >/dev/null
rg -F "readonly FAILURE_DIAGNOSTICS_SHA256='$diagnostics_sha'" "$SCRIPT_DIR/isolated-release-probe.sh" >/dev/null
pass package_hard_bindings_exact

[[ $PASS_COUNT -eq 28 ]]
printf 'POSTGRES_NETWORK_ALIAS_TEST_COUNT=28\nROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\nDATABASE_CONNECTED=NO\n'
