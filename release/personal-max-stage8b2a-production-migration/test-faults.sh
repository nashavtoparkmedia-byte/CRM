#!/usr/bin/env bash
# shellcheck disable=SC2016
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd); script="$root/production-migration.sh"; pass=0
check() { "$@"; pass=$((pass+1)); }
schema_validate() {
  local fixture=$1
  python3 -c 'import json,sys,jsonschema; jsonschema.validate(json.load(sys.stdin),json.load(open(sys.argv[1],encoding="utf-8")))' "$root/report-schema.json" <<<"$fixture"
}
schema_reject() { if schema_validate "$1" >/dev/null 2>&1; then return 1; fi; }
check grep -Fq 'PERSONAL_MAX_ISOLATED_REPORT_SHA256' "$script"
check grep -Fq '.script=={sha256:$expectedProbeScriptSha,checksumBound:true}' "$script"
check grep -Fq '46|46|0' "$script"; check grep -Fq '54|54|0' "$script"
check grep -Fq '${#pg_set[@]} == 0' "$script"; check grep -Fq '${#pg_set[@]} != 1' "$script"
check grep -Fq 'long_transactions == 0' "$script"; check grep -Fq 'free_before >= MINIMUM_FREE_BYTES' "$script"
check grep -Fq -- '--name "$MIGRATION_RUNNER" --label "$RUNNER_STAGE_LABEL"' "$script"
check grep -Fq -- '--name "$PRISMA_DIFF_RUNNER" --label "$RUNNER_STAGE_LABEL"' "$script"
check grep -Fq 'personal-max.role=$MIGRATION_RUNNER_ROLE' "$script"
check grep -Fq 'personal-max.role=$PRISMA_DIFF_RUNNER_ROLE' "$script"
check grep -Fq 'RUNNER_SCRIPT_LABEL_KEY=$SCRIPT_SHA' "$script"
check grep -Fq 'RUNNER_TOKEN_LABEL_KEY=$RUNNER_TOKEN' "$script"
check grep -Fq '$label_value != "8b2a|$runner_role|$SCRIPT_SHA|$RUNNER_TOKEN"' "$script"
check grep -Fq 'PGOPTIONS=-c lock_timeout=$MIGRATION_LOCK_TIMEOUT_MS -c statement_timeout=$MIGRATION_STATEMENT_TIMEOUT_MS' "$script"
check grep -Fq 'PGOPTIONS=-c lock_timeout=$MIGRATION_LOCK_TIMEOUT_MS -c statement_timeout=$PRISMA_DIFF_STATEMENT_TIMEOUT_MS' "$script"
check grep -Fq -- '--entrypoint sh "$GATEWAY_IMAGE"' "$script"; check grep -Fq 'mv --no-clobber' "$script"
check grep -Fq -- "== 'amd64|linux|node'" "$script"; check grep -Fq 'test "$(id -u):$(id -g)" = "1000:1000"' "$script"
check grep -Fq 'destructiveRollback:false' "$root/failure-diagnostics.sh"; check grep -Fq 'DEPLOY_BLOCKED=YES' "$root/failure-diagnostics.sh"
check grep -Fq 'timeout --signal=TERM' "$script"
check grep -Fq 'rolled_back_at IS NOT NULL' "$script"
check grep -Fq 'function_collision_count' "$script"
check grep -Fq '20260717000000_add_driver_telegram_submitted_phone' "$script"
for invariant in MaxRawTransportEvent_replayAvailability_check MaxRawTransportEvent_quarantineConsistency_check MaxRawTransportEvent_payloadSizeBytes_check MaxRawTransportEvent_append_only max_raw_transport_event_append_only_guard; do check grep -Fq "$invariant" "$script"; done
check grep -Fq -- '--from-url "$DATABASE_URL" --to-schema-datamodel /app/prisma/schema.prisma --script --exit-code' "$script"
check grep -Fq 'appliedNamesObserved' "$root/failure-diagnostics.sh"
check grep -Fq 'configArchiveSha256:$configSha' "$root/failure-diagnostics.sh"
check grep -Fq 'cleanupComplete:$runnerCleanupComplete' "$root/failure-diagnostics.sh"
check grep -Fq 'runner_cleanup "$MIGRATION_RUNNER"' "$script"
check grep -Fq 'runner_cleanup "$PRISMA_DIFF_RUNNER"' "$script"
check grep -Fq 'verify_subordinate "$FAILURE_DIAGNOSTICS"' "$script"
check grep -Fq 'verify_subordinate "$REPORT_SUCCESS_FILTER"' "$script"
check grep -Fq 'verify_subordinate "$PRISMA_DRIFT_VALIDATOR"' "$script"
[[ $(grep -Fc 'env GIT_OPTIONAL_LOCKS=0 git -C /opt/crm status --porcelain=v2 --untracked-files=all | sha256sum' "$script") == 2 ]]; pass=$((pass+1))
if grep -F 'git -C /opt/crm status --porcelain=v2 --untracked-files=all | LC_ALL=C sort' "$script" >/dev/null; then exit 1; fi

accepted_drift=$(printf '%s\n' '/* warning */' '-- AlterTable' 'ALTER TABLE "DriverTelegram" DROP COLUMN "submittedPhone",' 'DROP COLUMN "submittedPhoneAt";' | awk -f "$root/validate-accepted-prisma-drift.awk")
[[ $accepted_drift == ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS ]]; pass=$((pass+1))
accepted_qualified=$(printf '%s\n' 'ALTER TABLE "public"."DriverTelegram" DROP COLUMN "submittedPhoneAt";' 'ALTER TABLE "public"."DriverTelegram" DROP COLUMN "submittedPhone";' | awk -f "$root/validate-accepted-prisma-drift.awk")
[[ $accepted_qualified == ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS ]]; pass=$((pass+1))
if printf '%s\n' 'ALTER TABLE "DriverTelegram" DROP COLUMN "submittedPhone";' | awk -f "$root/validate-accepted-prisma-drift.awk" >/dev/null; then exit 1; fi
if printf '%s\n' 'ALTER TABLE "DriverTelegram" DROP COLUMN "submittedPhone", DROP COLUMN "submittedPhoneAt";' 'DROP TABLE "Contact";' | awk -f "$root/validate-accepted-prisma-drift.awk" >/dev/null; then exit 1; fi

expected_script_sha=$(sha256sum "$script" | awk '{print $1}')
expected_image='ghcr.io/nashavtoparkmedia-byte/crm-max-personal-gateway@sha256:669172fc4ac650e7bffa5c8095b812526f337c75c2811cde747d318d320eddd0'
success_fixture=$(jq -n --arg scriptSha "$expected_script_sha" --arg image "$expected_image" '{schemaVersion:1,mode:"PRODUCTION_MIGRATION_EVIDENCE",script:{sha256:$scriptSha,checksumBound:true},bindings:{isolatedReportSha256:("d"*64),acceptedBackupReportSha256:"f9b29d5fbe69b9a87d402bab3a19a1079797640549078b17a6ba8e7280415566"},databaseBinding:{source:"postgres-container-env",projectLabel:"crm",serviceLabel:"postgres",envKeys:["POSTGRES_USER","POSTGRES_PASSWORD","POSTGRES_DB"],urlHost:"postgres",urlPort:5432,urlSchema:"public",inspectMode:"0600",envMode:"0600",networkName:"crm_internal",networkProjectLabel:"crm",networkComposeLabel:"crm_internal",alias:"postgres",runnerNetworkCount:1,containerIdentityStable:true,credentialsPrinted:false,credentialsInArguments:false},image:{ref:$image,digestBound:true},freshBackup:{directory:"/var/backups/personal-max-stage8b2a-pre-migration-20260728T120000Z",status:"VALIDATED",structuralValidation:"PASS",dumpSha256:("b"*64),configArchiveSha256:("c"*64),dumpBytes:1,objectCount:1},migration:{before:{total:46,finished:46,failed:0},after:{total:54,finished:54,failed:0},appliedNames:["20260726162043_add_max_raw_transport_journal","20260726190658_add_max_route_registry","20260726205437_add_max_inbound_normalization","20260726215715_add_max_per_chat_outbound_actor","20260726225737_add_max_dispatch_ledger","20260727053744_add_max_provider_confirmation_matcher","20260727141925_add_max_shadow_semantic_comparison","20260727154647_add_max_capture_ingress"],acceptedLedgerOnlyMigrations:["20260717000000_add_driver_telegram_submitted_phone"],rawRows:0,prismaDiffEmpty:false,prismaDiffStatus:"ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS",prismaDiffRawSqlIncluded:false},schema:{rawJournalConstraints:["MaxRawTransportEvent_payloadSizeBytes_check","MaxRawTransportEvent_quarantineConsistency_check","MaxRawTransportEvent_replayAvailability_check"],appendOnlyTrigger:"MaxRawTransportEvent_append_only",appendOnlyFunction:"max_raw_transport_event_append_only_guard"},runners:{migration:{name:"personal-max-stage8b2a-migration-runner",cleanupState:"ABSENT_AFTER_SUCCESS"},prismaDiff:{name:"personal-max-stage8b2a-prisma-diff-runner",cleanupState:"ABSENT_AFTER_SUCCESS"},allOwnedRunnersAbsent:true},production:{containerHashBefore:("e"*64),containerHashAfter:("e"*64),restartCountsUnchanged:true,gitUnchanged:true},storage:{freeBytesBefore:12500000000,freeBytesAfter:12500000000,rollbackReserveBytes:5368709120},safety:{deploy:false,restart:false,captureEnabled:false,gatewayStarted:false,scraperChanged:false,destructiveRollback:false,secretsPrinted:false,providerAction:false,maxContacted:false}}')
report_gate=(jq -e --arg expectedScriptSha "$expected_script_sha" --arg expectedImage "$expected_image" -f "$root/report-success.jq")
"${report_gate[@]}" <<<"$success_fixture" >/dev/null; pass=$((pass+1))
check schema_validate "$success_fixture"
check schema_reject "$(jq '.unexpected=true' <<<"$success_fixture")"
check schema_reject "$(jq 'del(.bindings.isolatedReportSha256)' <<<"$success_fixture")"
check schema_reject "$(jq '.databaseBinding.credentialsInArguments=true' <<<"$success_fixture")"
check schema_reject "$(jq '.databaseBinding.runnerNetworkCount=2' <<<"$success_fixture")"
check schema_reject "$(jq '.schema.appendOnlyTrigger="unexpected_trigger"' <<<"$success_fixture")"
check schema_reject "$(jq '.safety.providerAction=true' <<<"$success_fixture")"
if "${report_gate[@]}" <<<"$(jq '.migration.prismaDiffStatus="UNEXPECTED_DRIFT"' <<<"$success_fixture")" >/dev/null; then exit 1; fi
if "${report_gate[@]}" <<<"$(jq '.migration.prismaDiffRawSqlIncluded=true' <<<"$success_fixture")" >/dev/null; then exit 1; fi
if "${report_gate[@]}" <<<"$(jq '.runners.prismaDiff.cleanupState="STILL_PRESENT"' <<<"$success_fixture")" >/dev/null; then exit 1; fi
if "${report_gate[@]}" <<<"$(jq 'del(.schema.appendOnlyTrigger)' <<<"$success_fixture")" >/dev/null; then exit 1; fi
if jq -e --arg expectedScriptSha "$(printf tampered | sha256sum | awk '{print $1}')" --arg expectedImage "$expected_image" -f "$root/report-success.jq" <<<"$success_fixture" >/dev/null; then exit 1; fi

failure_fixture=$(jq -n --arg scriptSha "$expected_script_sha" '{schemaVersion:1,mode:"PRODUCTION_MIGRATION_FAILURE",phase:"migration_execution",classification:"MIGRATION_FAILED",exitCode:70,sourceLine:321,
  script:{sha256:$scriptSha},freshBackup:{created:true,directory:"/var/backups/personal-max-stage8b2a-pre-migration-20260728T120000Z",status:"VALIDATED",dumpSha256:("b"*64),dumpBytes:1,objectCount:1,configArchiveSha256:("c"*64),validated:true,preserve:true},
  migration:{started:true,appliedNamesObserved:["20260726162043_add_max_raw_transport_journal"],destructiveRollback:false,deployBlocked:true},
  runners:{migration:{name:"personal-max-stage8b2a-migration-runner",cleanupState:"ABSENT"},prismaDiff:{name:"personal-max-stage8b2a-prisma-diff-runner",cleanupState:"NOT_CREATED"},cleanupComplete:true},
  diagnostics:{commandCaptured:false,sqlCaptured:false,stderrCaptured:false,environmentCaptured:false,credentialsCaptured:false}}')
check schema_validate "$failure_fixture"
check schema_reject "$(jq '.diagnostics.sqlCaptured=true' <<<"$failure_fixture")"
check schema_reject "$(jq 'del(.runners.cleanupComplete)' <<<"$failure_fixture")"
check schema_reject "$(jq '.migration.unobservedClaim=false' <<<"$failure_fixture")"

accepted_probe_sha=$(awk -F"'" '/^readonly ACCEPTED_ISOLATED_PROBE_SCRIPT_SHA=/{print $2}' "$script")
[[ $accepted_probe_sha =~ ^[0-9a-f]{64}$ ]]; pass=$((pass+1))
isolated_script_fixture=$(jq -n --arg sha "$accepted_probe_sha" '{script:{sha256:$sha,checksumBound:true}}')
jq -e --arg expectedProbeScriptSha "$accepted_probe_sha" '.script=={sha256:$expectedProbeScriptSha,checksumBound:true}' <<<"$isolated_script_fixture" >/dev/null; pass=$((pass+1))
if jq -e --arg expectedProbeScriptSha "$(printf substituted-probe | sha256sum | awk '{print $1}')" '.script=={sha256:$expectedProbeScriptSha,checksumBound:true}' <<<"$isolated_script_fixture" >/dev/null; then exit 1; fi

for binding in 'FAILURE_DIAGNOSTICS failure-diagnostics.sh' 'REPORT_SUCCESS_FILTER report-success.jq' 'PRISMA_DRIFT_VALIDATOR validate-accepted-prisma-drift.awk' 'DATABASE_URL_HELPER postgres-database-url.py'; do
  read -r variable artifact <<<"$binding"
  expected=$(awk -F"'" -v key="${variable}_SHA" '$0 ~ "^readonly " key "=" {print $2}' "$script")
  actual=$(sha256sum "$root/$artifact" | awk '{print $1}')
  [[ $expected == "$actual" ]]; pass=$((pass+1))
  tampered=$(sed '1s/$/ # tampered/' "$root/$artifact" | sha256sum | awk '{print $1}')
  [[ $tampered != "$expected" ]] || exit 1
done
verify_line=$(grep -n 'verify_subordinate "$FAILURE_DIAGNOSTICS"' "$script" | tail -n 1 | cut -d: -f1)
source_line=$(grep -n '^source "$FAILURE_DIAGNOSTICS"' "$script" | cut -d: -f1)
[[ $((source_line - verify_line)) == 1 ]]; pass=$((pass+1))
if rg -n '(docker (compose|system prune|volume prune)|--publish|-p [0-9]|migrate resolve|DROP TABLE|DELETE FROM "_prisma_migrations")' "$script"; then exit 1; fi
if rg -n '(POSTGRES_PASSWORD=[^$"{]|DATABASE_URL=postgresql://[A-Za-z0-9]|postgresql://[A-Za-z0-9._%+-]+:[^{$[:space:]]+@)' "$root" --glob '!test-faults.sh' --glob '!test-postgres-binding.py'; then exit 1; fi
PYTHONDONTWRITEBYTECODE=1 python3 "$root/test-postgres-binding.py"
printf 'PHASE_B_FAULT_CONTRACT_PASS=%s\n' "$pass"
