#!/usr/bin/env bash
# shellcheck disable=SC2016
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd); cd "$root"
rollout=dormant-rollout.sh
rollback=dormant-rollback.sh
schema_validate() {
  local fixture=$1
  python3 -c 'import json,sys,jsonschema; jsonschema.validate(json.load(sys.stdin),json.load(open(sys.argv[1],encoding="utf-8")))' report-schema.json <<<"$fixture"
}
schema_reject() { if schema_validate "$1" >/dev/null 2>&1; then return 1; fi; }

test "$(find . -maxdepth 1 -type f | wc -l)" -eq 15
bash -n "$rollout" "$rollback" failure-diagnostics.sh test-package.sh
if command -v shellcheck >/dev/null; then shellcheck -x "$rollout" "$rollback" failure-diagnostics.sh test-package.sh; fi
sha256sum -c SHA256SUMS
test "$(wc -l < SHA256SUMS)" -eq 14
cmp <(jq -r '.files[]|select(.!="SHA256SUMS")' MANIFEST.json | LC_ALL=C sort) <(awk '{print $2}' SHA256SUMS | LC_ALL=C sort)

jq -e '.stage=="8B2B" and (.files|length)==15 and .status=="PREPARED_NOT_EXECUTED" and
  .productionStatusHashMode=="RAW_PORCELAIN_V2_STREAM" and .acceptedMigrationBinding.prismaDiffStatus=="ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS" and
  .acceptedMigrationBinding.isolatedReportShaCrossBound==true and .acceptedMigrationBinding.exactEightNames==true and
  .acceptedMigrationBinding.runnerCleanupRequired==true and .acceptedMigrationBinding.databaseBinding=="POSTGRES_IDENTITY_FENCED"' MANIFEST.json >/dev/null
rollout_sha=$(sha256sum "$rollout" | awk '{print $1}')
rollback_sha=$(sha256sum "$rollback" | awk '{print $1}')
jq -e --arg rollout "$rollout_sha" --arg rollback "$rollback_sha" '.rolloutScriptSha256==$rollout and .rollbackScriptSha256==$rollback' MANIFEST.json >/dev/null
grep -Fq "$rollout_sha" owner-instructions.md
grep -Fq "$rollback_sha" owner-instructions.md

for binding in 'FAILURE_DIAGNOSTICS failure-diagnostics.sh' 'ACCEPTED_MIGRATION_FILTER accepted-migration-report.jq' 'COMPOSE_SOURCE dormant-gateway.compose.yml' 'ROLLBACK_SCRIPT dormant-rollback.sh'; do
  read -r variable artifact <<<"$binding"
  expected=$(awk -F"'" -v key="${variable}_SHA" '$0 ~ "^readonly " key "=" {print $2}' "$rollout")
  actual=$(sha256sum "$artifact" | awk '{print $1}')
  [[ $expected == "$actual" ]]
  jq -e --arg artifact "$artifact" --arg sha "$actual" '.hardBoundRuntimeArtifacts[$artifact]==$sha' MANIFEST.json >/dev/null
  tampered=$(sed '1s/$/ # tampered/' "$artifact" | sha256sum | awk '{print $1}')
  [[ $tampered != "$expected" ]]
done
verify_line=$(grep -n 'verify_subordinate "$FAILURE_DIAGNOSTICS"' "$rollout" | tail -n 1 | cut -d: -f1)
source_line=$(grep -n '^source "$FAILURE_DIAGNOSTICS"' "$rollout" | cut -d: -f1)
[[ $((source_line - verify_line)) == 1 ]]
grep -Fq -- '--arg isolated "$PERSONAL_MAX_ISOLATED_REPORT_SHA256"' "$rollout"
grep -Fq -- '--arg expectedMigrationScriptSha "$ACCEPTED_MIGRATION_SCRIPT_SHA"' "$rollout"
test "$(grep -Fc 'git -C /opt/crm status --porcelain=v2 --untracked-files=all | sha256sum' "$rollout")" -eq 2
if grep -F 'git -C /opt/crm status --porcelain=v2 --untracked-files=all | LC_ALL=C sort' "$rollout" >/dev/null; then exit 1; fi

grep -Fq 'pull_policy: never' dormant-gateway.compose.yml
grep -Fq 'internal: true' dormant-gateway.compose.yml
grep -Fq 'ports: []' dormant-gateway.compose.yml
grep -Fq 'volumes: []' dormant-gateway.compose.yml
grep -Fq 'user: "1000:1000"' dormant-gateway.compose.yml
grep -Fq 'read_only: true' dormant-gateway.compose.yml
for flag in MAX_RAW_JOURNAL_ENABLED MAX_INBOUND_NORMALIZER_ENABLED MAX_SHADOW_COMPARISON_ENABLED MAX_PERSONAL_LIVE_CAPTURE_ENABLED; do grep -Fq "$flag: \"\"" dormant-gateway.compose.yml; done
if rg -n '(MAX_PERSONAL_GATEWAY_DATABASE_URL|MAX_PERSONAL_CAPTURE_HMAC_KEYS_JSON|MAX_PERSONAL_GATEWAY_BROWSER_OWNER|MAX_PERSONAL_GATEWAY_CHROMIUM_PROFILE_PATH)' dormant-gateway.compose.yml; then exit 1; fi
if rg -n '(ports:[[:space:]]*$|-[[:space:]]*["'\'']?[0-9]+:|/app/user_data|crm_internal|docker (system|volume|network) prune)' dormant-gateway.compose.yml "$rollout" "$rollback"; then exit 1; fi
if grep -Eq '^[[:space:]]+image: [^@]+:[A-Za-z0-9._-]+$' dormant-gateway.compose.yml; then exit 1; fi

grep -Fq 'package_path=$(realpath -- "$PACKAGE_ROOT")' "$rollback"
grep -Fq 'SCRIPT_SHA=$(sha_file "$script_path")' "$rollback"
grep -Fq '[[ $SCRIPT_SHA == "$1" ]]' "$rollback"
grep -Fq '[[ $(sha_file "$COMPOSE_RUNTIME") == "$COMPOSE_SOURCE_SHA" ]]' "$rollback"
grep -Fq 'container_identity=' "$rollback"
grep -Fq 'network_identity=' "$rollback"
grep -Fq 'phase target_validation TARGET_IDENTITY_MISMATCH' "$rollback"
grep -Fq 'docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_RUNTIME" down --timeout 30' "$rollback"
grep -Fq 'rm -- "$COMPOSE_RUNTIME"' "$rollback"
grep -Fq 'rmdir -- "$STATE_DIR"' "$rollback"
grep -Fq '[[ ! -e $COMPOSE_RUNTIME && ! -L $COMPOSE_RUNTIME && ! -e $STATE_DIR && ! -L $STATE_DIR ]]' "$rollback"
grep -Fq 'trap '\''on_error "$?" "$LINENO"'\'' ERR' "$rollback"
grep -Fq 'personal_max_dormant_rollback_failure "$original" "$line" "$PHASE" "$CLASSIFICATION"' "$rollback"
grep -Fq 'mv --no-clobber "$tmp" "$report"' failure-diagnostics.sh
grep -Fq 'chown root:codexbot "$tmp"' failure-diagnostics.sh
grep -Fq 'chmod 0640 "$tmp"' failure-diagnostics.sh
grep -Fq 'RUNTIME_CONFIG_OBSERVED_STATE' "$rollout"
grep -Fq 'STATE_DIRECTORY_OBSERVED_STATE' "$rollout"
grep -Fq 'RUNTIME_CONFIG_OBSERVED_STATE' "$rollback"
grep -Fq 'STATE_DIRECTORY_OBSERVED_STATE' "$rollback"
grep -Fq 'DORMANT_GATEWAY_ROLLBACK_FAILURE' failure-diagnostics.sh
if rg -n '(CONTAINER_CREATED|NETWORK_CREATED|runtimeConfigCreated|stateDirectoryCreated)' "$rollout" "$rollback" failure-diagnostics.sh; then exit 1; fi
for binding in 'FAILURE_DIAGNOSTICS failure-diagnostics.sh' 'COMPOSE_SOURCE dormant-gateway.compose.yml'; do
  read -r variable artifact <<<"$binding"
  expected=$(awk -F"'" -v key="${variable}_SHA" '$0 ~ "^readonly " key "=" {print $2}' "$rollback")
  actual=$(sha256sum "$artifact" | awk '{print $1}')
  [[ $expected == "$actual" ]]
done
rollback_verify_line=$(grep -n 'verify_subordinate "$FAILURE_DIAGNOSTICS"' "$rollback" | tail -n 1 | cut -d: -f1)
rollback_source_line=$(grep -n '^source "$FAILURE_DIAGNOSTICS"' "$rollback" | cut -d: -f1)
[[ $((rollback_source_line - rollback_verify_line)) == 1 ]]
if rg -n '(docker rm|docker network rm|docker (system|volume|network) prune)' "$rollback"; then exit 1; fi

isolated_sha=$(printf isolated-proof | sha256sum | awk '{print $1}')
wrong_isolated_sha=$(printf wrong-isolated-proof | sha256sum | awk '{print $1}')
migration_script_sha=$(awk -F"'" '/^readonly ACCEPTED_MIGRATION_SCRIPT_SHA=/{print $2}' "$rollout")
expected_image='ghcr.io/nashavtoparkmedia-byte/crm-max-personal-gateway@sha256:dd718fd8e9e2ec52a0ee1c19b576d75a1035f9e251980351ebc04071dfe5d0de'
migration_fixture=$(jq -n --arg isolated "$isolated_sha" --arg migrationScript "$migration_script_sha" --arg image "$expected_image" '
  {schemaVersion:1,mode:"PRODUCTION_MIGRATION_EVIDENCE",script:{sha256:$migrationScript,checksumBound:true},
   bindings:{isolatedReportSha256:$isolated,acceptedBackupReportSha256:"f9b29d5fbe69b9a87d402bab3a19a1079797640549078b17a6ba8e7280415566"},
   databaseBinding:{source:"postgres-container-env",projectLabel:"crm",serviceLabel:"postgres",envKeys:["POSTGRES_USER","POSTGRES_PASSWORD","POSTGRES_DB"],urlHost:"postgres",urlPort:5432,urlSchema:"public",inspectMode:"0600",envMode:"0600",networkName:"crm_internal",networkProjectLabel:"crm",networkComposeLabel:"internal",alias:"postgres",runnerNetworkCount:1,containerIdentityStable:true,credentialsPrinted:false,credentialsInArguments:false},
   image:{ref:$image,digestBound:true},freshBackup:{directory:"/var/backups/personal-max-stage8b2a-pre-migration-20260728T120000Z",status:"VALIDATED",structuralValidation:"PASS",dumpSha256:("b"*64),configArchiveSha256:("c"*64),dumpBytes:1,objectCount:1},
   migration:{before:{total:46,finished:46,failed:0},after:{total:54,finished:54,failed:0},appliedNames:["20260726162043_add_max_raw_transport_journal","20260726190658_add_max_route_registry","20260726205437_add_max_inbound_normalization","20260726215715_add_max_per_chat_outbound_actor","20260726225737_add_max_dispatch_ledger","20260727053744_add_max_provider_confirmation_matcher","20260727141925_add_max_shadow_semantic_comparison","20260727154647_add_max_capture_ingress"],acceptedLedgerOnlyMigrations:["20260717000000_add_driver_telegram_submitted_phone"],rawRows:0,prismaDiffEmpty:false,prismaDiffStatus:"ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS",prismaDiffRawSqlIncluded:false},
   schema:{rawJournalConstraints:["MaxRawTransportEvent_payloadSizeBytes_check","MaxRawTransportEvent_quarantineConsistency_check","MaxRawTransportEvent_replayAvailability_check"],appendOnlyTrigger:"MaxRawTransportEvent_append_only",appendOnlyFunction:"max_raw_transport_event_append_only_guard"},
   runners:{migration:{name:"personal-max-stage8b2a-migration-runner",cleanupState:"ABSENT_AFTER_SUCCESS"},prismaDiff:{name:"personal-max-stage8b2a-prisma-diff-runner",cleanupState:"ABSENT_AFTER_SUCCESS"},allOwnedRunnersAbsent:true},
   production:{containerHashBefore:("e"*64),containerHashAfter:("e"*64),restartCountsUnchanged:true,gitUnchanged:true},storage:{freeBytesBefore:12500000000,freeBytesAfter:12500000000,rollbackReserveBytes:5368709120},
   safety:{deploy:false,restart:false,captureEnabled:false,gatewayStarted:false,scraperChanged:false,destructiveRollback:false,secretsPrinted:false,providerAction:false,maxContacted:false}}')
migration_gate=(jq -e --arg isolated "$isolated_sha" --arg expectedMigrationScriptSha "$migration_script_sha" --arg expectedImage "$expected_image" -f accepted-migration-report.jq)
"${migration_gate[@]}" <<<"$migration_fixture" >/dev/null
if jq -e --arg isolated "$wrong_isolated_sha" --arg expectedMigrationScriptSha "$migration_script_sha" --arg expectedImage "$expected_image" -f accepted-migration-report.jq <<<"$migration_fixture" >/dev/null; then exit 1; fi
if "${migration_gate[@]}" <<<"$(jq '.bindings.acceptedBackupReportSha256=("0"*64)' <<<"$migration_fixture")" >/dev/null; then exit 1; fi
if "${migration_gate[@]}" <<<"$(jq '.script.sha256=("0"*64)' <<<"$migration_fixture")" >/dev/null; then exit 1; fi
if "${migration_gate[@]}" <<<"$(jq '.image.ref="mutable:latest"' <<<"$migration_fixture")" >/dev/null; then exit 1; fi
if "${migration_gate[@]}" <<<"$(jq '.freshBackup.dumpBytes=0' <<<"$migration_fixture")" >/dev/null; then exit 1; fi
if "${migration_gate[@]}" <<<"$(jq '.migration.prismaDiffEmpty=true' <<<"$migration_fixture")" >/dev/null; then exit 1; fi
if "${migration_gate[@]}" <<<"$(jq '.migration.appliedNames += ["unexpected_migration"]' <<<"$migration_fixture")" >/dev/null; then exit 1; fi
if "${migration_gate[@]}" <<<"$(jq '.runners.migration.cleanupState="STILL_PRESENT"' <<<"$migration_fixture")" >/dev/null; then exit 1; fi
if "${migration_gate[@]}" <<<"$(jq '.schema.rawJournalConstraints=[]' <<<"$migration_fixture")" >/dev/null; then exit 1; fi
if "${migration_gate[@]}" <<<"$(jq '.safety.providerAction=true' <<<"$migration_fixture")" >/dev/null; then exit 1; fi
if "${migration_gate[@]}" <<<"$(jq '.databaseBinding.containerIdentityStable=false' <<<"$migration_fixture")" >/dev/null; then exit 1; fi
if "${migration_gate[@]}" <<<"$(jq '.databaseBinding.credentialsInArguments=true' <<<"$migration_fixture")" >/dev/null; then exit 1; fi

compose_sha=$(sha256sum dormant-gateway.compose.yml | awk '{print $1}')
migration_report_sha=$(printf accepted-migration-report | sha256sum | awk '{print $1}')
rollout_fixture=$(jq -n --arg scriptSha "$rollout_sha" --arg rollbackSha "$rollback_sha" --arg composeSha "$compose_sha" \
  --arg isolatedSha "$isolated_sha" --arg migrationReportSha "$migration_report_sha" --arg migrationScriptSha "$migration_script_sha" --arg image "$expected_image" '
  {schemaVersion:1,mode:"DORMANT_GATEWAY_ROLLOUT",script:{sha256:$scriptSha,checksumBound:true},
   bindings:{isolatedReportSha256:$isolatedSha,migrationReportSha256:$migrationReportSha,migrationScriptSha256:$migrationScriptSha},
   acceptedMigration:{reportValidated:true,productionMigrationScriptSha256:$migrationScriptSha,gatewayImage:$image,isolatedReportShaCrossBound:true,
    freshBackupStatus:"VALIDATED",appliedCount:8,runnerCleanup:"PASS",safety:"PASS",databaseBinding:"POSTGRES_IDENTITY_FENCED",prismaDiffEmpty:false,
    prismaDiffStatus:"ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS",prismaDiffRawSqlIncluded:false,
    acceptedLedgerOnlyMigrations:["20260717000000_add_driver_telegram_submitted_phone"]},
   image:{ref:$image,runtimeUser:"1000:1000"},
   runtime:{container:"personal-max-dormant-gateway",network:"personal-max-stage8b2b-dormant",networkInternal:true,publicPorts:0,mounts:0,health:"PASS",readiness:"dormant-ready",restartPolicy:"unless-stopped"},
   behavior:{databaseConfigured:false,databaseWrites:0,captureEnabled:false,senderActive:false,browserLaunched:false,maxContacted:false,providerAction:false},
   production:{hashBefore:("a"*64),hashAfter:("a"*64),unchanged:true,restartCountsUnchanged:true},storage:{freeBytesBefore:12500000000},
   rollback:{available:true,automatic:false,scriptSha256:$rollbackSha,composeSha256:$composeSha}}')
schema_validate "$rollout_fixture"
schema_reject "$(jq '.unexpected=true' <<<"$rollout_fixture")"
schema_reject "$(jq 'del(.bindings.migrationReportSha256)' <<<"$rollout_fixture")"
schema_reject "$(jq '.behavior.providerAction=true' <<<"$rollout_fixture")"
schema_reject "$(jq '.runtime.publicPorts=1' <<<"$rollout_fixture")"
schema_reject "$(jq '.acceptedMigration.databaseBinding="UNTRUSTED"' <<<"$rollout_fixture")"

rollout_failure_fixture=$(jq -n --arg scriptSha "$rollout_sha" '
  {schemaVersion:1,mode:"DORMANT_GATEWAY_ROLLOUT_FAILURE",phase:"dormant_start",classification:"DORMANT_START_FAILED",exitCode:70,sourceLine:200,scriptSha256:$scriptSha,
   resources:{observation:"DOCKER_AVAILABLE",container:{name:"personal-max-dormant-gateway",state:"PRESENT_OWNED"},network:{name:"personal-max-stage8b2b-dormant",state:"PRESENT_OWNED"},
    runtimeConfig:{path:"/var/lib/personal-max-stage8b2b/dormant-gateway.compose.yml",state:"PRESENT_OWNED"},stateDirectory:{path:"/var/lib/personal-max-stage8b2b",state:"PRESENT_OWNED"},cleanupAutomatic:false},
   safety:{productionDatabaseChanged:false,scraperChanged:false,profileChanged:false,maxContacted:false,providerAction:false}}')
schema_validate "$rollout_failure_fixture"
schema_reject "$(jq '.resources.container.state="CREATED"' <<<"$rollout_failure_fixture")"
schema_reject "$(jq 'del(.resources.runtimeConfig)' <<<"$rollout_failure_fixture")"
schema_reject "$(jq '.resources.containerCreated=false' <<<"$rollout_failure_fixture")"

rollback_fixture=$(jq -n --arg scriptSha "$rollback_sha" --arg composeSha "$compose_sha" '
  {schemaVersion:1,mode:"DORMANT_GATEWAY_ROLLBACK",scriptSha256:$scriptSha,composeSha256:$composeSha,logSha256:("f"*64),
   verifiedTarget:{container:"personal-max-dormant-gateway",network:"personal-max-stage8b2b-dormant",stage:"8b2b",mode:"dormant",mounts:0,publicPorts:0},
   containerRemoved:true,networkRemoved:true,runtimeConfigRemoved:true,stateDirectoryRemoved:true,
   production:{hashBefore:("e"*64),hashAfter:("e"*64),unchanged:true},databaseChanged:false,scraperChanged:false,profileChanged:false,globalPrune:false}')
schema_validate "$rollback_fixture"
schema_reject "$(jq 'del(.stateDirectoryRemoved)' <<<"$rollback_fixture")"
schema_reject "$(jq '.containerRemoved=false' <<<"$rollback_fixture")"
schema_reject "$(jq '.cleanupRetried=false' <<<"$rollback_fixture")"

rollback_failure_fixture=$(jq -n --arg scriptSha "$rollback_sha" '
  {schemaVersion:1,mode:"DORMANT_GATEWAY_ROLLBACK_FAILURE",phase:"state_directory_cleanup",classification:"STATE_DIRECTORY_CLEANUP_FAILED",exitCode:1,sourceLine:222,scriptSha256:$scriptSha,
   resources:{observation:"DOCKER_AVAILABLE",container:{name:"personal-max-dormant-gateway",state:"ABSENT"},network:{name:"personal-max-stage8b2b-dormant",state:"ABSENT"},
    runtimeConfig:{path:"/var/lib/personal-max-stage8b2b/dormant-gateway.compose.yml",state:"ABSENT"},stateDirectory:{path:"/var/lib/personal-max-stage8b2b",state:"PRESENT_OWNED"},cleanupAutomatic:false},
   scope:{databaseMutationAttempted:false,scraperMutationAttempted:false,profileMutationAttempted:false,globalPruneAttempted:false,automaticRetry:false}}')
schema_validate "$rollback_failure_fixture"
schema_reject "$(jq '.resources.stateDirectory.state="REMOVED"' <<<"$rollback_failure_fixture")"
schema_reject "$(jq 'del(.classification)' <<<"$rollback_failure_fixture")"
schema_reject "$(jq '.scope.automaticRetry=true' <<<"$rollback_failure_fixture")"

if rg -n '(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})' .; then exit 1; fi
printf 'PHASE_C_PACKAGE_PASS\n'
