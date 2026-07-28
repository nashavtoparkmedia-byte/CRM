#!/usr/bin/env bash
# Static/non-root contract suite. It never executes the root probe or Docker.
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
readonly PROBE="$SCRIPT_DIR/isolated-release-probe.sh"
readonly DIAGNOSTICS="$SCRIPT_DIR/failure-diagnostics.sh"
readonly BOUNDED="$SCRIPT_DIR/bounded-operations.sh"
readonly FAULTS="$SCRIPT_DIR/test-bounded-faults.sh"
readonly SCRAPER_HARNESS="$SCRIPT_DIR/synthetic-scraper-harness.js"
readonly CLIENT_HARNESS="$SCRIPT_DIR/gateway-client-harness.js"
readonly BACKUP_REPORT='/var/tmp/personal-max-stage8b1s-production-backup.json'
readonly BACKUP_SHA='f9b29d5fbe69b9a87d402bab3a19a1079797640549078b17a6ba8e7280415566'
readonly ARCHITECTURE='/opt/codex-work/releases/personal-max-transport-architecture-20260726T132916Z'
readonly SHELLCHECK_BIN=${1:-shellcheck}

pass() { printf '%s=PASS\n' "$1"; }
require_fixed() { grep -F -- "$2" "$1" >/dev/null; }
refuse_pattern() { ! grep -Eq -- "$2" "$1"; }

[[ $(id -u) -ne 0 ]]
[[ -f $BACKUP_REPORT && ! -L $BACKUP_REPORT && $(sha256sum -- "$BACKUP_REPORT" | awk '{print $1}') == "$BACKUP_SHA" ]]
jq -e '.mode=="PRODUCTION_BACKUP_METADATA" and .dump.structuralValidation=="PASS" and .dump.bytes>0 and .dump.objectCount==581 and .restore.FULL_RESTORE_PROOF=="PENDING_ISOLATED_ROOT_PROBE"' "$BACKUP_REPORT" >/dev/null
pass backup_acceptance
[[ $(stat -Lc '%U:%G:%a' "$BACKUP_REPORT") == root:codexbot:640 && -r $BACKUP_REPORT && ! -w $BACKUP_REPORT ]]
pass backup_permission_contract
free=$(df -B1 -P /var/lib/docker | awk 'NR==2{print $4}')
[[ $free =~ ^[0-9]+$ && $((free - 4323469515 - 2172240240)) -ge 12500000000 && $((free - 4323469515 - 2172240240 - 5368709120)) -ge 0 ]]
pass post_backup_storage_gate

bash -n "$PROBE" "$DIAGNOSTICS" "$BOUNDED" "$FAULTS" "$SCRIPT_DIR/test-package.sh"
pass bash_syntax
[[ -x $SHELLCHECK_BIN ]]
"$SHELLCHECK_BIN" -x -S warning "$PROBE" "$DIAGNOSTICS" "$BOUNDED" "$FAULTS" "$SCRIPT_DIR/test-package.sh"
pass shellcheck
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
require_fixed "$PROBE" '[[ $PM_SCRIPT_SHA256 == "$1" ]]'
require_fixed "$PROBE" 'sha256sum -c SHA256SUMS'
pass checksum_binding
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
require_fixed "$PROBE" '--filter "label=$STAGE_LABEL" --filter "label=$RUN_LABEL_KEY=$RUN_ID"'
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

for evidence in 'pg_restore --list' 'pg_restore --exit-on-error --no-owner --no-acl' 'ledger_before_finished -eq 46' 'catalog_tables -gt 0' 'FULL_RESTORE_PROOF:"PASS"'; do require_fixed "$PROBE" "$evidence"; done
pass disposable_restore_contract
for migration in 20260726162043_add_max_raw_transport_journal 20260726190658_add_max_route_registry \
  20260726205437_add_max_inbound_normalization 20260726215715_add_max_per_chat_outbound_actor \
  20260726225737_add_max_dispatch_ledger 20260727053744_add_max_provider_confirmation_matcher \
  20260727141925_add_max_shadow_semantic_comparison 20260727154647_add_max_capture_ingress; do
  require_fixed "$PROBE" "$migration"
done
require_fixed "$PROBE" 'ledger_after_finished -eq 54'
require_fixed "$PROBE" 'prisma migrate diff'
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
pass failure_diagnostics
require_fixed "$DIAGNOSTICS" 'ISOLATED_PROBE_FAILED'
require_fixed "$PROBE" 'DIAGNOSTICS_LOADED=true'
pass no_silent_failure
require_fixed "$PROBE" 'chgrp codexbot "$TMP_REPORT"'
require_fixed "$PROBE" 'chmod 0640 "$TMP_REPORT"'
require_fixed "$PROBE" 'mv --no-clobber --no-target-directory'
pass report_permission_contract
for evidence in containerIdsHash serviceStatesHash restartCountsHash volumeInventoryHash networkInventoryHash productionGitHash migrationLedger; do require_fixed "$PROBE" "$evidence"; done
require_fixed "$PROBE" "jq -S 'del(.freeBytes)'"
pass production_immutability_contract

jq -e '.schemaVersion==1 and .stage=="8B1I" and .mode=="PREPARED_NOT_EXECUTED" and .rootProbe.executed==false and .safety.stage8B2Started==false' "$SCRIPT_DIR/MANIFEST.json" >/dev/null
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

printf 'ROOT_PROBE_EXECUTED=NO\nDOCKER_EXECUTED=NO\nPACKAGE_TEST_COUNT=43\nFAULT_SCENARIO_COUNT=20\n'
