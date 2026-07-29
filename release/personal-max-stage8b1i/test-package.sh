#!/usr/bin/env bash
# Static/non-root contract suite. It never executes the root probe or Docker.
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
readonly PROBE="$SCRIPT_DIR/isolated-release-probe.sh"
readonly DIAGNOSTICS="$SCRIPT_DIR/failure-diagnostics.sh"
readonly BOUNDED="$SCRIPT_DIR/bounded-operations.sh"
readonly OUTPUT_HELPERS="$SCRIPT_DIR/probe-output-helpers.sh"
readonly RESTORE_VERIFICATION="$SCRIPT_DIR/restore-verification.sh"
readonly POSTGRES_STARTUP="$SCRIPT_DIR/postgres-startup.sh"
readonly MIGRATION_SQL_GATE="$SCRIPT_DIR/migration-sql-gate.sh"
readonly MIGRATION_SQL_BINDINGS="$SCRIPT_DIR/migration-sql-bindings.txt"
readonly PRISMA_LEGACY_DIFF_GATE="$SCRIPT_DIR/prisma-legacy-diff-gate.sh"
readonly FAULTS="$SCRIPT_DIR/test-bounded-faults.sh"
readonly OUTPUT_HANDOFF="$SCRIPT_DIR/test-output-handoff.sh"
readonly RESTORE_TESTS="$SCRIPT_DIR/test-restore-verification.sh"
readonly LEDGER_TESTS="$SCRIPT_DIR/test-ledger-verification.sh"
readonly POSTGRES_STARTUP_TESTS="$SCRIPT_DIR/test-postgres-startup.sh"
readonly SCRAPER_HARNESS="$SCRIPT_DIR/synthetic-scraper-harness.js"
readonly CLIENT_HARNESS="$SCRIPT_DIR/gateway-client-harness.js"
readonly BACKUP_REPORT='/var/tmp/personal-max-stage8b1s-production-backup.json'
readonly BACKUP_SHA='f9b29d5fbe69b9a87d402bab3a19a1079797640549078b17a6ba8e7280415566'
readonly FAILURE_REPORT='/var/tmp/personal-max-stage8b1i-isolated-release-proof.failure.2474859594be528910bd29c960ba2c37fe08d5f6bcccec67f596138d1bc3d3e0.json'
readonly FAILURE_REPORT_SHA='4645c6aa3810c574b602a0c8d2e7df12cbcfd701f5292a04ed022782013fdcbd'
readonly ARCHITECTURE='/opt/codex-work/releases/personal-max-transport-architecture-20260726T132916Z'
readonly SHELLCHECK_BIN=${1:-shellcheck}
readonly REPOSITORY_MIGRATIONS="$SCRIPT_DIR/../../gravity-mvp/prisma/migrations"

TEST_TMP=$(mktemp -d /tmp/personal-max-stage8b1i-package.XXXXXX)
trap 'rm -rf -- "$TEST_TMP"' EXIT
PACKAGE_PASS_COUNT=0
PACKAGE_SKIP_COUNT=0

pass() { PACKAGE_PASS_COUNT=$((PACKAGE_PASS_COUNT + 1)); printf '%s=PASS\n' "$1"; }
require_fixed() { grep -F -- "$2" "$1" >/dev/null; }
refuse_pattern() { ! grep -Eq -- "$2" "$1"; }

[[ $(id -u) -ne 0 ]]
[[ -f $BACKUP_REPORT && ! -L $BACKUP_REPORT && $(sha256sum -- "$BACKUP_REPORT" | awk '{print $1}') == "$BACKUP_SHA" ]]
jq -e '.mode=="PRODUCTION_BACKUP_METADATA" and .dump.structuralValidation=="PASS" and .dump.bytes>0 and .dump.objectCount==581 and .restore.FULL_RESTORE_PROOF=="PENDING_ISOLATED_ROOT_PROBE"' "$BACKUP_REPORT" >/dev/null
pass backup_acceptance
[[ $(stat -Lc '%U:%G:%a' "$BACKUP_REPORT") == root:codexbot:640 && -r $BACKUP_REPORT && ! -w $BACKUP_REPORT ]]
pass backup_permission_contract
[[ -f $FAILURE_REPORT && ! -L $FAILURE_REPORT && -r $FAILURE_REPORT && ! -w $FAILURE_REPORT ]]
[[ $(stat -Lc '%U:%G:%a' "$FAILURE_REPORT") == root:codexbot:640 ]]
[[ $(sha256sum -- "$FAILURE_REPORT" | awk '{print $1}') == "$FAILURE_REPORT_SHA" ]]
jq -e '.script.sha256=="2474859594be528910bd29c960ba2c37fe08d5f6bcccec67f596138d1bc3d3e0" and
  .phase=="postgresql_start" and .classification=="DISPOSABLE_DOCKER_FAILED" and
  .checkId=="NONE" and .exitCode==2 and .sourceLine==563 and
  .images.acceptedImagesRetained==true and .cleanup.completed==true and
  .cleanup.containersRemaining==0 and .cleanup.networksRemaining==0 and .cleanup.volumesRemaining==0 and
  .cleanup.tempFilesRemaining==0 and .productionImmutability.productionDatabaseConnections==0 and
  ([.diagnostics.rawCommandCaptured,.diagnostics.rawSqlCaptured,.diagnostics.rawStderrCaptured,
    .diagnostics.environmentValuesCaptured,.diagnostics.credentialsCaptured,.diagnostics.messageDataCaptured,
    .diagnostics.providerPayloadCaptured]|all(.==false)) and
  ([.safety.productionDDL,.safety.productionDML,.safety.productionMigration,.safety.restart,.safety.deploy,
    .safety.browserLaunched,.safety.maxContacted,.safety.providerAction,.safety.productionNetworkAttached,
    .safety.productionVolumeMounted,.safety.profileMounted]|all(.==false))' "$FAILURE_REPORT" >/dev/null
pass failure_report_acceptance
free=$(df -B1 -P /var/lib/docker | awk 'NR==2{print $4}')
[[ $free =~ ^[0-9]+$ && $((free - 2172240240)) -ge 12500000000 && $((free - 2172240240 - 5368709120)) -ge 0 ]]
pass post_backup_storage_gate

bash -n "$PROBE" "$DIAGNOSTICS" "$BOUNDED" "$OUTPUT_HELPERS" "$RESTORE_VERIFICATION" "$POSTGRES_STARTUP" \
  "$FAULTS" "$OUTPUT_HANDOFF" "$RESTORE_TESTS" "$LEDGER_TESTS" "$POSTGRES_STARTUP_TESTS" "$SCRIPT_DIR/test-package.sh"
sh -n "$MIGRATION_SQL_GATE"
sh -n "$PRISMA_LEGACY_DIFF_GATE"
pass bash_syntax
if command -v "$SHELLCHECK_BIN" >/dev/null 2>&1; then
  "$SHELLCHECK_BIN" -x -S warning "$PROBE" "$DIAGNOSTICS" "$BOUNDED" "$OUTPUT_HELPERS" "$RESTORE_VERIFICATION" "$POSTGRES_STARTUP" \
    "$MIGRATION_SQL_GATE" "$PRISMA_LEGACY_DIFF_GATE" "$FAULTS" "$OUTPUT_HANDOFF" "$RESTORE_TESTS" "$LEDGER_TESTS" "$POSTGRES_STARTUP_TESTS" "$SCRIPT_DIR/test-package.sh"
  pass shellcheck
else
  PACKAGE_SKIP_COUNT=$((PACKAGE_SKIP_COUNT + 1))
  printf 'shellcheck=SKIP_NOT_INSTALLED\n'
fi
for evidence in 'pm_run_bounded()' 'pm_capture_bounded()' 'pm_write_bounded()' \
  '"$PM_TIMEOUT_BIN" --signal=TERM --kill-after=10s "${seconds}s"'; do require_fixed "$BOUNDED" "$evidence"; done
pass timeout_wrapper_contract
require_fixed "$PROBE" 'docker_metadata 60 METADATA_TIMEOUT'
require_fixed "$BOUNDED" '900s docker pull'
require_fixed "$PROBE" 'backup_validation 120 RESTORE_LIST_TIMEOUT'
require_fixed "$PROBE" 'backup_validation 1200 FULL_RESTORE_TIMEOUT'
require_fixed "$PROBE" 'disposable_migration 900 MIGRATE_DEPLOY_TIMEOUT'
require_fixed "$PROBE" 'disposable_migration 600 PRISMA_DIFF_TIMEOUT'
require_fixed "$PROBE" 'synthetic_harness 600 SYNTHETIC_HARNESS_TIMEOUT'
pass long_operation_timeout_guards
require_fixed "$BOUNDED" 'pm_poll_until()'
require_fixed "$PROBE" 'pm_poll_until 180 240 POLLING_DEADLINE_EXCEEDED'
require_fixed "$PROBE" 'pm_poll_until 60 90 GATEWAY_STARTUP_TIMEOUT'
pass polling_deadline_guards
for evidence in POSTGRES_CONTAINER_START_CHECK POSTGRES_READINESS_CHECK \
  POSTGRES_SERVER_VERSION_QUERY_CHECK POSTGRES_SERVER_VERSION_MATCH_CHECK \
  POSTGRES_CONTAINER_START_FAILED POSTGRES_CONTAINER_EXITED_DURING_STARTUP \
  POSTGRES_READINESS_TIMEOUT POSTGRES_READINESS_COMMAND_FAILED \
  POSTGRES_VERSION_QUERY_FAILED POSTGRES_VERSION_MISMATCH; do
  require_fixed "$POSTGRES_STARTUP" "$evidence"
done
require_fixed "$POSTGRES_STARTUP" '1 | 2)'
require_fixed "$POSTGRES_STARTUP" 'PROBE_ERROR_CLASSIFICATION=NONE'
require_fixed "$POSTGRES_STARTUP" 'Raw logs, command output, environment values, credentials, and SQL results'
require_fixed "$PROBE" 'pm_postgres_wait_readiness 90 120'
require_fixed "$PROBE" 'pm_postgres_wait_version server_version "$POSTGRES_VERSION" 30 60'
pass postgres_startup_state_machine
require_fixed "$PROBE" 'CLEANUP_GLOBAL_DEADLINE=$((SECONDS + 300))'
for evidence in CONTAINER_REMOVAL_TIMEOUT NETWORK_REMOVAL_TIMEOUT VOLUME_REMOVAL_TIMEOUT TEMP_REMOVAL_TIMEOUT CLEANUP_GLOBAL_DEADLINE_EXCEEDED; do
  rg -F "$evidence" "$PROBE" "$BOUNDED" >/dev/null
done
pass cleanup_deadline_guards
for evidence in GATEWAY_PULL_TIMEOUT SCRAPER_PULL_TIMEOUT REGISTRY_AUTHENTICATION_DENIED REGISTRY_MANIFEST_NOT_FOUND REGISTRY_DIGEST_MISMATCH REGISTRY_ACCESS_UNAVAILABLE; do
  require_fixed "$BOUNDED" "$evidence"
done
pass registry_failure_classifications
for evidence in FREE_BYTES_AFTER_GATEWAY_PULL FREE_BYTES_AFTER_SCRAPER_PULL POST_PULL_DISK_GATE_FAILED FINAL_DISK_GATE_FAILED; do require_fixed "$PROBE" "$evidence"; done
require_fixed "$PROBE" 'IMAGE_EXPANSION_REQUIRED_BYTES=0'
require_fixed "$PROBE" 'GATEWAY_PREEXISTING_BEFORE_PULL == true && $SCRAPER_PREEXISTING_BEFORE_PULL == true'
pass disk_gate_contract
require_fixed "$PROBE" 'pm_validate_success_report "$TMP_REPORT"'
require_fixed "$BOUNDED" 'SUCCESS_REPORT_MALFORMED'
pass success_report_validation
require_fixed "$BOUNDED" 'SUCCESS_REPORT_SAFETY_VIOLATION'
require_fixed "$BOUNDED" '.safety.productionDDL'
pass safety_field_validation
fault_output=$("$FAULTS")
[[ $fault_output == *'FAULT_TEST_COUNT=20'* && $fault_output == *'ERR_TRAP_BOUNDARY=VERIFIED'* && \
  $fault_output == *'ROOT_PROBE_EXECUTED=NO'* && $fault_output == *'DOCKER_EXECUTED=NO'* ]]
[[ $(grep -c '=PASS$' <<<"$fault_output") -eq 20 ]]
pass no_silent_failure_matrix
handoff_output=$("$OUTPUT_HANDOFF")
[[ $handoff_output == *'OLD_FIXTURE=FAIL_AS_EXPECTED'* && $handoff_output == *'FIXED_IMPLEMENTATION=PASS'* && \
  $handoff_output == *'EXECUTABLE_TEST_COUNT=36'* && $handoff_output == *'ROOT_PROBE_EXECUTED=NO'* && \
  $handoff_output == *'DOCKER_EXECUTED=NO'* ]]
[[ $(grep -c '=PASS$' <<<"$handoff_output") -eq 37 ]]
require_fixed "$BOUNDED" 'local -n __pm_out_ref="$__pm_target_name"'
require_fixed "$BOUNDED" '^[a-zA-Z_][a-zA-Z0-9_]*$'
refuse_pattern "$PROBE" '(^|[[:space:]])eval([[:space:]]|$)'
refuse_pattern "$PROBE" 'pm_capture_bounded[[:space:]]+__pm_'
refuse_pattern "$OUTPUT_HELPERS" 'pm_capture_bounded[[:space:]]+__pm_'
require_fixed "$OUTPUT_HELPERS" 'pm_result_'
pass output_handoff_regression
restore_output=$("$RESTORE_TESTS")
[[ $restore_output == *'RESTORE_REGRESSION_TEST_COUNT=25'* && \
  $restore_output == *'OLD_FAILURE=REPRODUCED'* && $restore_output == *'FIXED_PATH=PASS'* && \
  $restore_output == *'ROOT_PROBE_EXECUTED=NO'* && $restore_output == *'DOCKER_EXECUTED=NO'* ]]
[[ $(grep -c '=PASS$' <<<"$restore_output") -eq 26 ]]
pass restore_verification_regression
ledger_output=$("$LEDGER_TESTS")
[[ $ledger_output == *'LEDGER_REGRESSION_TEST_COUNT=22'* && \
  $ledger_output == *'OLD_LEDGER_FAILURE=REPRODUCED'* && \
  $ledger_output == *'CORRECTED_HISTORICAL_FIXTURE=PASS'* && \
  $ledger_output == *'ROOT_PROBE_EXECUTED=NO'* && $ledger_output == *'DOCKER_EXECUTED=NO'* && \
  $ledger_output == *'DATABASE_CONNECTED=NO'* ]]
[[ $(grep -c '=PASS$' <<<"$ledger_output") -eq 23 ]]
pass ledger_verification_regression
postgres_startup_output=$("$POSTGRES_STARTUP_TESTS")
[[ $postgres_startup_output == *'POSTGRES_STARTUP_TEST_COUNT=22'* && \
  $postgres_startup_output == *'PREVIOUS_FAILURE=REPRODUCED'* && \
  $postgres_startup_output == *'CORRECTED_FIXTURE=PASS'* && \
  $postgres_startup_output == *'ROOT_PROBE_EXECUTED=NO'* && \
  $postgres_startup_output == *'DOCKER_EXECUTED=NO'* && \
  $postgres_startup_output == *'DATABASE_CONNECTED=NO'* ]]
[[ $(grep -c '=PASS$' <<<"$postgres_startup_output") -eq 23 ]]
pass postgres_startup_regression

migration_gate_output=$(sh "$MIGRATION_SQL_GATE" "$REPOSITORY_MIGRATIONS" "$MIGRATION_SQL_BINDINGS")
[[ $migration_gate_output == MIGRATION_SQL_GATE=PASS && $(wc -l <"$MIGRATION_SQL_BINDINGS") -eq 8 ]]
pass exact_migration_sql_binding
mkdir -p "$TEST_TMP/migrations"
cp -a "$REPOSITORY_MIGRATIONS/." "$TEST_TMP/migrations/"
printf '\nDROP TABLE "forbidden";\n' >>"$TEST_TMP/migrations/20260726162043_add_max_raw_transport_journal/migration.sql"
mutated_sha=$(sha256sum -- "$TEST_TMP/migrations/20260726162043_add_max_raw_transport_journal/migration.sql" | awk '{print $1}')
awk -v replacement="$mutated_sha" 'NR==1{$1=replacement} {print $1 "  " $2}' "$MIGRATION_SQL_BINDINGS" >"$TEST_TMP/mutated-bindings.txt"
set +e
sh "$MIGRATION_SQL_GATE" "$TEST_TMP/migrations" "$TEST_TMP/mutated-bindings.txt" >/dev/null 2>&1
mutation_gate_status=$?
set -e
[[ $mutation_gate_status -eq 67 ]]
pass destructive_migration_refusal
printf '%s\n' '-- AlterTable' \
  'ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone" TEXT,' \
  'ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);' >"$TEST_TMP/accepted-prisma-diff.sql"
prisma_gate_output=$(sh "$PRISMA_LEGACY_DIFF_GATE" "$TEST_TMP/accepted-prisma-diff.sql")
[[ $prisma_gate_output == PRISMA_DIFF_STATUS=ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS ]]
pass accepted_legacy_prisma_diff
cp "$TEST_TMP/accepted-prisma-diff.sql" "$TEST_TMP/rejected-prisma-diff.sql"
printf '%s\n' 'ALTER TABLE "DriverTelegram" ADD COLUMN "unexpected" TEXT;' >>"$TEST_TMP/rejected-prisma-diff.sql"
set +e
sh "$PRISMA_LEGACY_DIFF_GATE" "$TEST_TMP/rejected-prisma-diff.sql" >/dev/null 2>&1
prisma_gate_status=$?
set -e
[[ $prisma_gate_status -ne 0 ]]
pass unexpected_prisma_diff_refused
require_fixed "$PROBE" '[[ $PM_SCRIPT_SHA256 == "$1" ]]'
require_fixed "$PROBE" 'sha256sum -c SHA256SUMS'
pass checksum_binding
for binding in \
  "failure-diagnostics.sh:FAILURE_DIAGNOSTICS_SHA256:e490cf4aadeb4e3471dd6fe846ade5cd1981a9bae5a0ac6edd3d8cc2de7b5288" \
  "bounded-operations.sh:BOUNDED_OPERATIONS_SHA256:5bfaeac3722b8187f83db2bb0b9eabf48eae4b2d67cdae9b63f8e861affb1a30" \
  "probe-output-helpers.sh:PROBE_OUTPUT_HELPERS_SHA256:da46e47aad0953609f284cbb52a6b3860fc169719ad06653b89450a4f0e43e11" \
  "restore-verification.sh:RESTORE_VERIFICATION_SHA256:0a4b0b0bd69a1e9e1a0177c3d57c4e88f9b047883520c373cc809bcb6e19706f" \
  "postgres-startup.sh:POSTGRES_STARTUP_SHA256:4c48fc4158bb571a53d82418c80bd08a4a1ebc66ba9ab73bed8478d518095df2" \
  "migration-sql-gate.sh:MIGRATION_SQL_GATE_SHA256:25d643e416b5bd96b5de2a16bef1d7ec7d74a79b633c7cb8c9a475441116fd9f" \
  "migration-sql-bindings.txt:MIGRATION_SQL_BINDINGS_SHA256:9128eba91ecb5ce9d010015031050379cd45941fff93bef721df889040a56f8f" \
  "prisma-legacy-diff-gate.sh:PRISMA_LEGACY_DIFF_GATE_SHA256:552383e215c3d4f3a6b5ae81556cd3d7888430ecfb66196cd983e3f29a736db8" \
  "synthetic-scraper-harness.js:SYNTHETIC_SCRAPER_HARNESS_SHA256:85d3b4f7b63829b054cfcb61af3d9c786b8dbcf0e9d52aa01be86fbef85a917e" \
  "gateway-client-harness.js:GATEWAY_CLIENT_HARNESS_SHA256:f1f8c3f5a60a0cf45f44904d8f708f760d02b6553c3b86d05e1ecbbd8cd25428"; do
  IFS=: read -r artifact constant digest <<<"$binding"
  require_fixed "$PROBE" "readonly $constant='$digest'"
  require_fixed "$PROBE" "bootstrap_verify_runtime_artifact $artifact \"\$$constant\""
done
require_fixed "$PROBE" 'bootstrap_verify_runtime_path SHA256SUMS'
refuse_pattern "$PROBE" 'SHA256SUMS_SHA256|EXPECTED_SHA256SUMS'
last_anchor_line=$(grep -nF 'bootstrap_verify_runtime_artifact gateway-client-harness.js' "$PROBE" | cut -d: -f1)
first_source_line=$(grep -nF 'source "$PACKAGE_ROOT/failure-diagnostics.sh"' "$PROBE" | cut -d: -f1)
[[ $last_anchor_line -lt $first_source_line ]]
require_fixed "$OUTPUT_HANDOFF" 'paired_runtime_artifact_substitution_refused'
pass transitive_runtime_artifact_binding
require_fixed "$PROBE" "$BACKUP_SHA"
require_fixed "$PROBE" 'sha_of observed_sha "$DUMP_PATH"'
require_fixed "$PROBE" '[[ $observed_sha == "$DUMP_SHA256" ]]'
pass backup_sha_binding
jq -e '.images.gateway.digest=="sha256:dd718fd8e9e2ec52a0ee1c19b576d75a1035f9e251980351ebc04071dfe5d0de" and .images.scraper.digest=="sha256:abf4405f55ab1c84f319b00cdb8b561f76353001ba2543045fddb17dc6b46768" and .images.postgresql.digest=="sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229"' "$SCRIPT_DIR/accepted-images.json" >/dev/null
pass image_digest_binding
require_fixed "$PROBE" "readonly POSTGRES_VERSION='16.14'"
jq -e '.images.postgresql.requiredServerVersion=="16.14"' "$SCRIPT_DIR/accepted-images.json" >/dev/null
pass postgresql_16_14_binding

refuse_pattern "$PROBE" 'crm_internal|--network[=[:space:]]+host'
pass production_network_refusal
refuse_pattern "$PROBE" 'crm_postgres_data|crm_max_user_data|crm_[A-Za-z0-9_-]+:/[A-Za-z]'
pass production_volume_refusal
refuse_pattern "$PROBE" '/app/user_data|/app/userData|CHROMIUM_PROFILE|MAX_PROFILE'
pass profile_mount_refusal
refuse_pattern "$PROBE" '(^|[[:space:]])(-p|--publish)([=[:space:]]|$)|--publish-all'
pass public_port_refusal
require_fixed "$PROBE" 'PREFIX="personal-max-stage8b1i-$RUN_ID"'
require_fixed "$PROBE" 'docker ps -aq --no-trunc --filter "name=^/${name}$"'
require_fixed "$PROBE" 'docker network inspect "$NETWORK"'
pass name_collision_guards
require_fixed "$OUTPUT_HELPERS" '--filter "label=$STAGE_LABEL" --filter "label=$RUN_LABEL_KEY=$__pm_run_id"'
require_fixed "$PROBE" 'cleanup_docker_objects'
pass label_scoped_cleanup
refuse_pattern "$PROBE" 'docker[[:space:]]+(system[[:space:]]+)?prune|docker[[:space:]]+image[[:space:]]+prune'
pass no_global_prune
refuse_pattern "$PROBE" 'docker([ -])compose|compose[[:space:]]+-f'
pass no_docker_compose
refuse_pattern "$PROBE" '\.env\.production'
pass no_env_production_read
require_fixed "$PROBE" 'productionDatabaseConnections:0'
refuse_pattern "$PROBE" 'docker[[:space:]]+exec[[:space:]]+[^ ]*(crm-postgres|postgres_id)|postgresql://[^ ]*@crm-postgres'
pass no_production_db_connection

for evidence in 'pg_restore --list' 'pg_restore --exit-on-error --no-owner --no-acl' 'FULL_RESTORE_PROOF:"PASS"'; do require_fixed "$PROBE" "$evidence"; done
for evidence in 'pm_restore_assert_uint_equal "$ledger_before_finished" 46' \
  'pm_restore_assert_uint_positive "$catalog_tables"' 'RESTORE_REQUIRED_USERS_RELATION_CHECK' \
  'SELECT count(*) FROM "users"'; do require_fixed "$RESTORE_VERIFICATION" "$evidence"; done
pass disposable_restore_contract
for migration in 20260726162043_add_max_raw_transport_journal 20260726190658_add_max_route_registry \
  20260726205437_add_max_inbound_normalization 20260726215715_add_max_per_chat_outbound_actor \
  20260726225737_add_max_dispatch_ledger 20260727053744_add_max_provider_confirmation_matcher \
  20260727141925_add_max_shadow_semantic_comparison 20260727154647_add_max_capture_ingress; do
  require_fixed "$PROBE" "$migration"
done
require_fixed "$PROBE" 'ledger_after_finished -eq 54'
require_fixed "$PROBE" 'prisma migrate diff'
require_fixed "$PROBE" 'prisma_diff_empty=false'
require_fixed "$PROBE" 'prisma_diff_status=ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS'
require_fixed "$PROBE" 'acceptedLedgerOnlyMigrations:["20260717000000_add_driver_telegram_submitted_phone"]'
require_fixed "$BOUNDED" '.migration.acceptedLedgerOnlyMigrations==["20260717000000_add_driver_telegram_submitted_phone"]'
pass exact_eight_migration_contract
for evidence in gateway-missing-hmac gateway-invalid-config gateway-dormant authenticatedIngress requestSizeLimit; do require_fixed "$PROBE" "$evidence"; done
for evidence in missingAuthDenied invalidAuthDenied wrongAccountDenied idempotentRetry; do require_fixed "$CLIENT_HARNESS" "$evidence"; done
pass gateway_executable_contract
for evidence in createLiveCaptureAdapterFromEnvironment TransportInterceptor defaultOffNoSpool actualTransportHook lostBeforeSpoolCount; do require_fixed "$SCRAPER_HARNESS" "$evidence"; done
pass scraper_synthetic_contract
for evidence in 'STAGE8B1I_FRAME_COUNT=500' 'STAGE8B1I_IDENTICAL_COUNT=100' retry-only gatewayOutage databaseOutage spoolRecovery 'physical_frames -eq 1000' 'critical_regressions -eq 0'; do require_fixed "$PROBE" "$evidence"; done
pass end_to_end_contract

require_fixed "$PROBE" "trap 'on_error \$LINENO' ERR"
require_fixed "$PROBE" 'trap on_exit EXIT'
require_fixed "$DIAGNOSTICS" 'rawCommandCaptured:false'
require_fixed "$DIAGNOSTICS" 'credentialsCaptured:false'
require_fixed "$DIAGNOSTICS" 'checkId:$checkId'
for evidence in RESTORE_LEDGER_COUNT_MISMATCH RESTORE_LEDGER_DUPLICATE_NAME RESTORE_LEDGER_UNSAFE_NAME \
  RESTORE_LEDGER_EXPECTED_SET_MISMATCH RESTORE_REQUIRED_RELATION_MISSING RESTORE_CATALOG_INTEGRITY_FAILED \
  RESTORE_REPRESENTATIVE_CHECK_FAILED RESTORE_QUERY_FAILED DISPOSABLE_CONTAINER_UNAVAILABLE; do
  require_fixed "$DIAGNOSTICS" "$evidence"
done
for evidence in POSTGRES_CONTAINER_START_FAILED POSTGRES_CONTAINER_EXITED_DURING_STARTUP \
  POSTGRES_READINESS_TIMEOUT POSTGRES_READINESS_COMMAND_FAILED POSTGRES_VERSION_QUERY_FAILED \
  POSTGRES_VERSION_MISMATCH POSTGRES_CONTAINER_START_CHECK POSTGRES_READINESS_CHECK \
  POSTGRES_SERVER_VERSION_QUERY_CHECK POSTGRES_SERVER_VERSION_MATCH_CHECK; do
  require_fixed "$DIAGNOSTICS" "$evidence"
done
for evidence in 'postgresStartup:{status:$postgresStatus' 'rawLogsCaptured:false' \
  'environmentValuesCaptured:false' 'credentialsCaptured:false' 'commandArgumentsCaptured:false'; do
  require_fixed "$DIAGNOSTICS" "$evidence"
done
pass failure_diagnostics
require_fixed "$DIAGNOSTICS" 'ISOLATED_PROBE_FAILED'
require_fixed "$PROBE" 'DIAGNOSTICS_LOADED=true'
require_fixed "$DIAGNOSTICS" 'personal_max_stage8b1i_cleanup_primary_temp'
diagnostics_source_line=$(grep -n 'source "$PACKAGE_ROOT/failure-diagnostics.sh"' "$PROBE" | cut -d: -f1)
bounded_source_line=$(grep -n 'source "$PACKAGE_ROOT/bounded-operations.sh"' "$PROBE" | cut -d: -f1)
[[ $diagnostics_source_line -lt $bounded_source_line ]]
pass no_silent_failure
require_fixed "$PROBE" 'chgrp codexbot "$TMP_REPORT"'
require_fixed "$PROBE" 'chmod 0640 "$TMP_REPORT"'
require_fixed "$PROBE" 'mv --no-clobber --no-target-directory'
pass report_permission_contract
for evidence in containerIdsHash serviceStatesHash restartCountsHash volumeInventoryHash networkInventoryHash productionGitHash migrationLedger; do require_fixed "$PROBE" "$evidence"; done
require_fixed "$PROBE" "jq -S 'del(.freeBytes)'"
pass production_immutability_contract
require_fixed "$PROBE" "readonly ACCEPTED_PRODUCTION_HEAD='e6a0a833fbb756216b058bfe326f9f9c77c4cc6d'"
require_fixed "$PROBE" "readonly ACCEPTED_PRODUCTION_STATUS_V2_RAW_SHA256='2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b'"
require_fixed "$PROBE" 'hash_raw_command git_status_hash filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED'
require_fixed "$PROBE" 'git -C /opt/crm status --porcelain=v2 --untracked-files=all'
require_fixed "$PROBE" 'pm_assert_production_git_baseline "$git_head" "$git_status_hash"'
require_fixed "$PROBE" 'productionStatusV2RawSha256:$productionStatusV2RawSha256'
refuse_pattern "$PROBE" 'hash_sorted_text[[:space:]]+git_status_hash'
snapshot_line=$(grep -nF 'production_snapshot "$TMP/production-before.json"' "$PROBE" | cut -d: -f1)
image_acquisition_line=$(grep -nF 'pm_enter_phase image_acquisition docker_pull' "$PROBE" | head -n1 | cut -d: -f1)
[[ $snapshot_line -lt $image_acquisition_line ]]
pass accepted_production_git_pre_gate

jq -e '.schemaVersion==1 and .incident=="RESTORE_LEDGER_NAMES_CHECK" and
  .failedAttempt.failureReportSha256=="9197be647171a35553189a0526a2d6e205442f15965f5ce0ae1c8a1934bd73bd" and
  .observedIntegrity.ledgerNameCount==46 and .observedIntegrity.ledgerUniqueCount==46 and
  .observedIntegrity.ledgerDuplicateCount==0 and .observedIntegrity.ledgerUnsafeNameCount==0 and
  .observedIntegrity.acceptedHistoricalNames==["0_init"] and
  .observedIntegrity.repositoryToLedgerCount==8 and .observedIntegrity.ledgerToRepositoryCount==1 and
  .acceptedEvidence.productionLedgerAttestationSha256=="3b77a5c161cbd9850ce3d45b38c2b0e5cc110d97b13f8b506e7723459766a4c3" and
  .repair.preparedScriptSha256=="2474859594be528910bd29c960ba2c37fe08d5f6bcccec67f596138d1bc3d3e0" and
  .repair.rootProbeRerun==false and .safety.productionMutationNow==false' \
  "$SCRIPT_DIR/ledger-failure-forensic.json" >/dev/null
jq -e '.schemaVersion==1 and .incident=="POSTGRESQL_START_FAILURE" and
  .failedAttempt.failureReportSha256=="4645c6aa3810c574b602a0c8d2e7df12cbcfd701f5292a04ed022782013fdcbd" and
  .failedAttempt.sourceLine==563 and .failedAttempt.exitCode==2 and
  .sourceMapping.exactFirstFailedOperation=="SERVER_VERSION_QUERY" and
  .sourceMapping.containerStartReturnedSuccess==true and
  .sourceMapping.readinessPollReturnedSuccess==true and
  .sourceMapping.containerStateRecorded==false and
  .sourceMapping.underlyingCauseProvable==false and
  .repair.preparedScriptSha256=="0aeb46c3f285c680a23c368e1bc95071bd26758bbcb3d6f7b301c6b82f7c49ee" and
  .repair.rootProbeRerun==false and .safety.dockerExecutionNow==false and
  .safety.productionDatabaseConnectedNow==false' \
  "$SCRIPT_DIR/postgres-startup-forensic.json" >/dev/null

jq -e '.schemaVersion==1 and .stage=="8B1I" and .mode=="PREPARED_NOT_EXECUTED" and
  .rootProbe.executed==false and
  .rootProbe.sha256=="0aeb46c3f285c680a23c368e1bc95071bd26758bbcb3d6f7b301c6b82f7c49ee" and
  .rootProbe.runtimeArtifactBindingCount==10 and .rootProbe.runtimeArtifactChecksBeforeFirstUse==true and
  .rootProbe.sha256sumsRole=="complete_package_ledger_not_trust_anchor" and
  .rootProbe.pairedHelperAndLedgerSubstitutionRefused==true and
  (.runtimeArtifactBindings|length)==10 and
  .runtimeArtifactBindings["probe-output-helpers.sh"]=="da46e47aad0953609f284cbb52a6b3860fc169719ad06653b89450a4f0e43e11" and
  .runtimeArtifactBindings["failure-diagnostics.sh"]=="e490cf4aadeb4e3471dd6fe846ade5cd1981a9bae5a0ac6edd3d8cc2de7b5288" and
  .runtimeArtifactBindings["bounded-operations.sh"]=="5bfaeac3722b8187f83db2bb0b9eabf48eae4b2d67cdae9b63f8e861affb1a30" and
  .runtimeArtifactBindings["restore-verification.sh"]=="0a4b0b0bd69a1e9e1a0177c3d57c4e88f9b047883520c373cc809bcb6e19706f" and
  .runtimeArtifactBindings["postgres-startup.sh"]=="4c48fc4158bb571a53d82418c80bd08a4a1ebc66ba9ab73bed8478d518095df2" and
  .restoreVerification.failureReportSha256=="c2cf0e2cb2e19e3f59d791c03af02163fe5571ffab7c993749b39a026948d2de" and
  .restoreVerification.exactCause=="PRISMA_USER_MODEL_MAPPED_TO_USERS" and
  .ledgerVerificationRepair.failureReportSha256=="9197be647171a35553189a0526a2d6e205442f15965f5ce0ae1c8a1934bd73bd" and
  .ledgerVerificationRepair.exactFailedCheck=="RESTORE_LEDGER_NAMES_CHECK" and
  .ledgerVerificationRepair.exactCause=="STRICT_MODERN_NAME_REGEX_APPLIED_TO_SAFE_HISTORICAL_LEDGER" and
  .ledgerVerificationRepair.ledgerNameCount==46 and .ledgerVerificationRepair.ledgerUniqueCount==46 and
  .ledgerVerificationRepair.ledgerDuplicateCount==0 and .ledgerVerificationRepair.ledgerUnsafeNameCount==0 and
  .ledgerVerificationRepair.acceptedHistoricalNames==["0_init"] and
  .ledgerVerificationRepair.productionLedgerAttestationSha256=="3b77a5c161cbd9850ce3d45b38c2b0e5cc110d97b13f8b506e7723459766a4c3" and
  .ledgerVerificationRepair.canonicalSortedLedgerNamesSha256=="d879288b3d8f4d38c1de8565987c231db32ddb322c20a6329519028d8b5a8114" and
  .ledgerVerificationRepair.repositoryToLedgerCount==8 and .ledgerVerificationRepair.ledgerToRepositoryCount==1 and
  .ledgerVerificationRepair.rootProbeRerun==false and
  .postgresStartupRepair.failureReportSha256=="4645c6aa3810c574b602a0c8d2e7df12cbcfd701f5292a04ed022782013fdcbd" and
  .postgresStartupRepair.sourceLine==563 and .postgresStartupRepair.exitCode==2 and
  .postgresStartupRepair.exactFirstFailedOperation=="SERVER_VERSION_QUERY" and
  .postgresStartupRepair.containerStartReturnedSuccess==true and
  .postgresStartupRepair.readinessPollReturnedSuccess==true and
  .postgresStartupRepair.containerStateEvidence=="NOT_RECORDED" and
  .postgresStartupRepair.underlyingCause=="INSUFFICIENT_SAFE_EVIDENCE" and
  .postgresStartupRepair.regressionScenarioCount==22 and
  .postgresStartupRepair.rootProbeRerun==false and
  .migrationValidation.exactSqlBindingCount==8 and
  .migrationValidation.prismaDiffEmpty==false and
  .migrationValidation.prismaDiffStatus=="ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS" and
  .migrationValidation.acceptedLedgerOnlyMigrations==["20260717000000_add_driver_telegram_submitted_phone"] and
  .safety.stage8B2Started==false' "$SCRIPT_DIR/MANIFEST.json" >/dev/null
pass manifest_validation
(cd "$SCRIPT_DIR" && sha256sum -c SHA256SUMS >/dev/null)
pass sha256sums_validation
if rg -n --hidden --glob '!SHA256SUMS' '(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16})' "$SCRIPT_DIR" >/dev/null; then exit 1; fi
pass secret_scan
refuse_pattern "$PROBE" '(docker[[:space:]]+(rm|stop|restart|kill)[[:space:]]+[^\n]*(crm-|com\.docker\.compose\.project)|git[[:space:]]+-C[[:space:]]+/opt/crm[[:space:]]+(checkout|reset|clean|commit)|/opt/crm/[^ ]*[[:space:]]*(>|>>))'
pass protected_path_scan
git -C "$SCRIPT_DIR/../.." diff --check
if rg -n '[[:blank:]]+$' "$SCRIPT_DIR" >/dev/null; then exit 1; fi
pass git_diff_check
(cd "$ARCHITECTURE" && sha256sum -c SHA256SUMS >/dev/null)
pass architecture_checksum

printf 'ROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\nDATABASE_CONNECTED=NO\nPACKAGE_TEST_COUNT=%s\nPACKAGE_TEST_SKIPPED=%s\nFAULT_SCENARIO_COUNT=20\nOUTPUT_HANDOFF_TEST_COUNT=36\nRESTORE_REGRESSION_TEST_COUNT=25\nLEDGER_REGRESSION_TEST_COUNT=22\nPOSTGRES_STARTUP_TEST_COUNT=22\n' \
  "$PACKAGE_PASS_COUNT" "$PACKAGE_SKIP_COUNT"
