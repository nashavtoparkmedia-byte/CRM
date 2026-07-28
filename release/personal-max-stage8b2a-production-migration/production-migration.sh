#!/usr/bin/env bash
# shellcheck disable=SC1091,SC2016
set -Eeuo pipefail
umask 077

readonly PACKAGE_ROOT='/opt/codex-work/crm-personal-max-stage8b2-autonomous-20260728T122700Z/release/personal-max-stage8b2a-production-migration'
readonly ISOLATED_REPORT='/var/tmp/personal-max-stage8b1i-isolated-release-proof.json'
readonly ACCEPTED_BACKUP_REPORT='/var/tmp/personal-max-stage8b1s-production-backup.json'
readonly ACCEPTED_BACKUP_REPORT_SHA='f9b29d5fbe69b9a87d402bab3a19a1079797640549078b17a6ba8e7280415566'
readonly PREFLIGHT_REPORT='/var/tmp/personal-max-stage8b1r-production-readonly-preflight.json'
readonly PREFLIGHT_REPORT_SHA='d6a6e4764c90a6f64af9c11b2b0c4eeb08b82c377b58990f939bd559688ac63b'
readonly GATEWAY_IMAGE='ghcr.io/nashavtoparkmedia-byte/crm-max-personal-gateway@sha256:dd718fd8e9e2ec52a0ee1c19b576d75a1035f9e251980351ebc04071dfe5d0de'
readonly POSTGRES_IMAGE_ID='sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229'
readonly PRODUCTION_HEAD='e6a0a833fbb756216b058bfe326f9f9c77c4cc6d'
readonly PRODUCTION_STATUS_V2_SHA='2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b'
readonly SUCCESS_REPORT='/var/tmp/personal-max-stage8b2a-production-migration.json'
readonly FAILURE_REPORT_PREFIX='/var/tmp/personal-max-stage8b2a-production-migration.failure'
readonly BACKUP_PARENT='/var/backups'
readonly BACKUP_PREFIX='/var/backups/personal-max-stage8b2a-pre-migration-'
readonly MINIMUM_FREE_BYTES=12500000000
readonly ROLLBACK_RESERVE_BYTES=5368709120
readonly COMMAND_TIMEOUT=60
readonly MIGRATION_TIMEOUT=900
readonly PROJECT_LABEL='com.docker.compose.project=crm'
readonly POSTGRES_LABEL='com.docker.compose.service=postgres'
readonly GRAVITY_LABEL='com.docker.compose.service=gravity-mvp'
readonly -a EXPECTED_MIGRATIONS=(
  20260726162043_add_max_raw_transport_journal
  20260726190658_add_max_route_registry
  20260726205437_add_max_inbound_normalization
  20260726215715_add_max_per_chat_outbound_actor
  20260726225737_add_max_dispatch_ledger
  20260727053744_add_max_provider_confirmation_matcher
  20260727141925_add_max_shadow_semantic_comparison
  20260727154647_add_max_capture_ingress
)

MIGRATION_PHASE='bootstrap'
MIGRATION_CLASSIFICATION='UNEXPECTED_FAILURE'
MIGRATION_STARTED=false
FRESH_BACKUP_CREATED=false
BACKUP_DIRECTORY=''
TMP=''
POSTGRES_ID=''
GRAVITY_ID=''
NETWORK_NAME=''
pg_ids=''
gravity_ids=''
network_json=''
PROJECT_HASH_BEFORE=''
RESTART_HASH_BEFORE=''
SCRIPT_SHA=''
FAILURE_REPORT=''
APPLIED_AFTER_FAILURE_JSON='[]'

bootstrap_fail() { printf '%s\n' "$1" >&2; exit "$2"; }
(( EUID == 0 )) || bootstrap_fail ROOT_REQUIRED 77
[[ ${1:-} =~ ^[0-9a-f]{64}$ ]] || bootstrap_fail CHECKSUM_BINDING_REQUIRED 78
[[ ${PERSONAL_MAX_ISOLATED_REPORT_SHA256:-} =~ ^[0-9a-f]{64}$ ]] || bootstrap_fail ISOLATED_REPORT_SHA_BINDING_REQUIRED 78
for binary in awk chgrp chmod chown cmp date df docker getent git grep jq mktemp mv readlink realpath rm runuser sha256sum sort stat tar timeout wc; do
  command -v "$binary" >/dev/null || bootstrap_fail "MANDATORY_BINARY_MISSING:$binary" 76
done
SCRIPT_PATH=$(realpath -- "${BASH_SOURCE[0]}") || bootstrap_fail SCRIPT_UNREADABLE 75
[[ $SCRIPT_PATH == "$PACKAGE_ROOT/production-migration.sh" && -f $SCRIPT_PATH && ! -L $SCRIPT_PATH ]] || bootstrap_fail SCRIPT_PATH_INVALID 75
SCRIPT_SHA=$(sha256sum -- "$SCRIPT_PATH" | awk '{print $1}')
[[ $SCRIPT_SHA == "$1" ]] || bootstrap_fail CHECKSUM_MISMATCH 79
FAILURE_REPORT="$FAILURE_REPORT_PREFIX.$SCRIPT_SHA.json"
[[ ! -e $SUCCESS_REPORT && ! -L $SUCCESS_REPORT && ! -e $FAILURE_REPORT && ! -L $FAILURE_REPORT ]] || bootstrap_fail REPORT_PATH_EXISTS 80
[[ -d $BACKUP_PARENT && ! -L $BACKUP_PARENT ]] || bootstrap_fail BACKUP_PARENT_UNSAFE 80
timeout 5 getent group codexbot >/dev/null || bootstrap_fail HANDOFF_GROUP_MISSING 84
source "$PACKAGE_ROOT/failure-diagnostics.sh"

cleanup() {
  local original=${1:-0}
  trap - ERR EXIT
  set +e
  if [[ -n ${TMP:-} && -d ${TMP:-} && ! -L ${TMP:-} ]]; then rm -rf -- "$TMP" >/dev/null 2>&1; fi
  return "$original"
}
on_error() {
  local original=${1:-1} line=${2:-0}
  trap - ERR; set +e
  if [[ ${MIGRATION_STARTED:-false} == true && -n ${POSTGRES_ID:-} ]]; then
    failure_names=$(psql_read 'SELECT migration_name FROM "_prisma_migrations" WHERE migration_name LIKE '\''20260726%'\'' OR migration_name LIKE '\''20260727%'\'' ORDER BY migration_name' 2>/dev/null || true)
    if [[ -n $failure_names ]]; then
      APPLIED_AFTER_FAILURE_JSON=$(printf '%s\n' "$failure_names" | jq -Rsc 'split("\n")[:-1]' 2>/dev/null || printf '[]')
    fi
  fi
  personal_max_migration_failure "$original" "$line" "$MIGRATION_PHASE" "$MIGRATION_CLASSIFICATION" \
    "$MIGRATION_STARTED" "$FRESH_BACKUP_CREATED" "$BACKUP_DIRECTORY" "$SCRIPT_SHA" "$FAILURE_REPORT" "$APPLIED_AFTER_FAILURE_JSON"
  cleanup "$original"; exit "$original"
}
trap 'on_error "$?" "$LINENO"' ERR
trap 'cleanup "$?"' EXIT

phase() { MIGRATION_PHASE=$1; MIGRATION_CLASSIFICATION=$2; printf 'STAGE8B2A_PHASE=%s\n' "$MIGRATION_PHASE"; }
run() { local seconds=$1; shift; timeout --signal=TERM --kill-after=10 "$seconds" "$@"; }
capture() { local -n __out=$1; local seconds=$2; shift 2; __out=$(run "$seconds" "$@"); }
sha_file() { sha256sum -- "$1" | awk '{print $1}'; }
hash_sorted() { LC_ALL=C sort | sha256sum | awk '{print $1}'; }
psql_read() {
  run "$COMMAND_TIMEOUT" docker exec "$POSTGRES_ID" sh -ceu \
    'export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000"; exec psql --no-psqlrc -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh "$1"
}
project_hash() {
  run "$COMMAND_TIMEOUT" docker ps -aq --no-trunc --filter "label=$PROJECT_LABEL" | awk 'NF' | sort -u | while IFS= read -r id; do
    run "$COMMAND_TIMEOUT" docker inspect --format '{{.Id}}|{{.State.Status}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.service"}}' "$id"
  done | hash_sorted
}
restart_hash() {
  run "$COMMAND_TIMEOUT" docker ps -aq --no-trunc --filter "label=$PROJECT_LABEL" | awk 'NF' | sort -u | while IFS= read -r id; do
    run "$COMMAND_TIMEOUT" docker inspect --format '{{.Id}}|{{.RestartCount}}' "$id"
  done | hash_sorted
}

phase package_validation PACKAGE_INVALID
(cd "$PACKAGE_ROOT" && sha256sum -c SHA256SUMS >/dev/null)

phase isolated_proof_binding ISOLATED_PROOF_INVALID
[[ -f $ISOLATED_REPORT && ! -L $ISOLATED_REPORT && $(stat -Lc '%U:%G:%a' "$ISOLATED_REPORT") == root:codexbot:640 ]]
[[ $(sha_file "$ISOLATED_REPORT") == "$PERSONAL_MAX_ISOLATED_REPORT_SHA256" ]]
run 5 runuser -u codexbot -- test -r "$ISOLATED_REPORT"
if run 5 runuser -u codexbot -- test -w "$ISOLATED_REPORT"; then false; fi
jq -e --argjson expected "$(printf '%s\n' "${EXPECTED_MIGRATIONS[@]}" | jq -Rsc 'split("\n")[:-1]')" '
  .schemaVersion==1 and .mode=="ISOLATED_RELEASE_PROOF" and
  .restore.FULL_RESTORE_PROOF=="PASS" and .migration.DISPOSABLE_MIGRATION_PROOF=="PASS" and
  (.migration.appliedNames|sort)==($expected|sort) and .migration.beforeFinished==46 and
  .migration.afterFinished==54 and .migration.failed==0 and .migration.prismaDiffEmpty==true and
  .e2e.captureLoss==0 and .e2e.accidentalDuplicateRawRows==0 and .e2e.wrongAccount==0 and
  .e2e.criticalSemanticRegressions==0 and .cleanup.containersRemaining==0 and
  .cleanup.networksRemaining==0 and .cleanup.volumesRemaining==0 and .cleanup.tempFilesRemaining==0 and
  .productionImmutability.unchanged==true and .productionImmutability.productionDatabaseConnections==0 and
  .safety.productionDDL==false and .safety.productionDML==false and .safety.productionMigration==false and
  .safety.restart==false and .safety.deploy==false and .safety.browserLaunched==false and
  .safety.maxContacted==false and .safety.providerAction==false' "$ISOLATED_REPORT" >/dev/null

phase accepted_evidence_binding ACCEPTED_EVIDENCE_INVALID
[[ $(sha_file "$ACCEPTED_BACKUP_REPORT") == "$ACCEPTED_BACKUP_REPORT_SHA" ]]
[[ $(sha_file "$PREFLIGHT_REPORT") == "$PREFLIGHT_REPORT_SHA" ]]
jq -e '.mode=="PRODUCTION_BACKUP_METADATA" and .dump.structuralValidation=="PASS" and .migrationLedger.total==46 and .migrationLedger.finished==46 and .migrationLedger.failed==0' "$ACCEPTED_BACKUP_REPORT" >/dev/null

phase production_git_gate PRODUCTION_DRIFT
[[ $(git -C /opt/crm rev-parse HEAD) == "$PRODUCTION_HEAD" ]]
status_sha=$(git -C /opt/crm status --porcelain=v2 --untracked-files=all | LC_ALL=C sort | sha256sum | awk '{print $1}')
[[ $status_sha == "$PRODUCTION_STATUS_V2_SHA" ]]

phase storage_gate STORAGE_REFUSAL
free_before=$(df -B1 --output=avail "$BACKUP_PARENT" | awk 'NR==2{print $1}')
[[ $free_before =~ ^[0-9]+$ ]] && (( free_before >= MINIMUM_FREE_BYTES ))

phase runtime_discovery RUNTIME_DISCOVERY_FAILED
capture pg_ids "$COMMAND_TIMEOUT" docker ps -q --no-trunc --filter "label=$PROJECT_LABEL" --filter "label=$POSTGRES_LABEL"
mapfile -t pg_set < <(printf '%s\n' "$pg_ids" | awk 'NF' | sort -u)
(( ${#pg_set[@]} == 1 )); POSTGRES_ID=${pg_set[0]}
capture gravity_ids "$COMMAND_TIMEOUT" docker ps -q --no-trunc --filter "label=$PROJECT_LABEL" --filter "label=$GRAVITY_LABEL"
mapfile -t gravity_set < <(printf '%s\n' "$gravity_ids" | awk 'NF' | sort -u)
(( ${#gravity_set[@]} == 1 )); GRAVITY_ID=${gravity_set[0]}
[[ $(run "$COMMAND_TIMEOUT" docker inspect --format '{{.State.Status}}|{{.Image}}' "$POSTGRES_ID") == "running|$POSTGRES_IMAGE_ID" ]]
capture network_json "$COMMAND_TIMEOUT" docker inspect --format '{{json .NetworkSettings.Networks}}' "$POSTGRES_ID"
mapfile -t networks < <(jq -r 'keys[]' <<<"$network_json")
(( ${#networks[@]} == 1 )); NETWORK_NAME=${networks[0]}; [[ $NETWORK_NAME == crm_internal ]]
PROJECT_HASH_BEFORE=$(project_hash); RESTART_HASH_BEFORE=$(restart_hash)
pg_version=$(psql_read 'SHOW server_version' | awk 'NF{gsub(/^[[:space:]]+|[[:space:]]+$/,""); print; exit}')
[[ $pg_version == 16.14 ]]

phase database_preflight DATABASE_PREFLIGHT_REFUSAL
ledger_state=$(psql_read "SELECT count(*)::text||'|'||count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::text||'|'||count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)::text FROM \"_prisma_migrations\"")
[[ $ledger_state == '46|46|0' ]]
long_transactions=$(psql_read "SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND xact_start IS NOT NULL AND now()-xact_start>interval '5 minutes'")
active_sessions=$(psql_read "SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state<>'idle'")
[[ $long_transactions == 0 && $active_sessions == 0 ]]
[[ $(psql_read "SELECT to_regclass('public.\"MaxRawTransportEvent\"') IS NULL") == t ]]
collision_count=$(psql_read "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['MaxRawTransportEvent','MaxRawTransportProcessing','MaxRawTransportCursor','MaxInboundNormalizationResult','MaxInboundNormalizedEvent','MaxRouteConversation','MaxOutboundCommand','MaxOutboundConversationActor','MaxOutboundCommandReservation','MaxOutboundDispatch','MaxOutboundDispatchLane','MaxOutboundDispatchAttempt','MaxOutboundDispatchTransition','MaxOutboundReconciliationTask','MaxProviderConfirmationEvidence','MaxProviderConfirmationResolution','MaxProviderConfirmationDecision','MaxProviderConfirmationCursor','MaxShadowComparisonRun','MaxShadowComparisonResult','MaxShadowSemanticDiff','MaxShadowComparisonCursor','MaxRouteIdentityBinding','MaxRouteObservation','MaxRouteConflict'])")
function_collision_count=$(psql_read "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname ~ '^max_(raw_transport|route|outbound|provider_confirmation|shadow_)'")
[[ $collision_count == 0 && $function_collision_count == 0 ]]
ledger_before=$(psql_read 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name')

phase accepted_image_gate IMAGE_GATE_FAILED
[[ $(run "$COMMAND_TIMEOUT" docker image inspect --format '{{join .RepoDigests "\n"}}' "$GATEWAY_IMAGE" | grep -Fx "$GATEWAY_IMAGE") == "$GATEWAY_IMAGE" ]]
[[ $(run "$COMMAND_TIMEOUT" docker image inspect --format '{{.Architecture}}|{{.Os}}|{{.Config.User}}' "$GATEWAY_IMAGE") == 'amd64|linux|1000:1000' ]]
TMP=$(mktemp -d /var/tmp/personal-max-stage8b2a.XXXXXXXX); chmod 0700 "$TMP"; chown root:root "$TMP"
run "$COMMAND_TIMEOUT" docker run --rm --network none --entrypoint sh "$GATEWAY_IMAGE" -ceu '
  for d in /app/prisma/migrations/*; do test -d "$d" && basename "$d"; done | sort' >"$TMP/repository-migrations"
comm -23 "$TMP/repository-migrations" <(printf '%s\n' "$ledger_before") >"$TMP/pending"
printf '%s\n' "${EXPECTED_MIGRATIONS[@]}" | sort >"$TMP/expected"
cmp "$TMP/expected" "$TMP/pending"; [[ $(wc -l <"$TMP/repository-migrations") == 53 ]]

phase fresh_backup FRESH_BACKUP_FAILED
timestamp=$(date -u +'%Y%m%dT%H%M%SZ'); BACKUP_DIRECTORY="$BACKUP_PREFIX$timestamp"
[[ ! -e $BACKUP_DIRECTORY && ! -L $BACKUP_DIRECTORY ]]
mkdir -m 0700 -- "$BACKUP_DIRECTORY"; chown root:root "$BACKUP_DIRECTORY"; FRESH_BACKUP_CREATED=true
dump_tmp="$BACKUP_DIRECTORY/database.dump.partial"; dump_path="$BACKUP_DIRECTORY/database.dump"
run 1800 docker exec "$POSTGRES_ID" sh -ceu 'exec pg_dump --format=custom --compress=6 --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >"$dump_tmp"
chmod 0600 "$dump_tmp"; chown root:root "$dump_tmp"; [[ -s $dump_tmp && ! -L $dump_tmp ]]
run "$COMMAND_TIMEOUT" docker exec -i "$POSTGRES_ID" pg_restore --list <"$dump_tmp" >"$BACKUP_DIRECTORY/database.list.partial"
object_count=$(awk 'NF && substr($0,1,1)!=";"{n++} END{print n+0}' "$BACKUP_DIRECTORY/database.list.partial"); (( object_count > 0 ))
chmod 0600 "$BACKUP_DIRECTORY/database.list.partial"; chown root:root "$BACKUP_DIRECTORY/database.list.partial"
tar --create --gzip --absolute-names --file="$BACKUP_DIRECTORY/production-config.tar.gz.partial" -- /opt/crm/deploy/docker-compose.production.yml /opt/crm/.env.production
chmod 0600 "$BACKUP_DIRECTORY/production-config.tar.gz.partial"; chown root:root "$BACKUP_DIRECTORY/production-config.tar.gz.partial"
tar --list --gzip --file="$BACKUP_DIRECTORY/production-config.tar.gz.partial" >/dev/null
mv --no-clobber "$dump_tmp" "$dump_path"; mv --no-clobber "$BACKUP_DIRECTORY/database.list.partial" "$BACKUP_DIRECTORY/database.list"
mv --no-clobber "$BACKUP_DIRECTORY/production-config.tar.gz.partial" "$BACKUP_DIRECTORY/production-config.tar.gz"
dump_sha=$(sha_file "$dump_path"); dump_bytes=$(stat -Lc '%s' "$dump_path"); config_sha=$(sha_file "$BACKUP_DIRECTORY/production-config.tar.gz")

phase secret_binding SECRET_BINDING_FAILED
run "$COMMAND_TIMEOUT" docker exec "$GRAVITY_ID" sh -ceu 'test -n "${DATABASE_URL:-}"; printf "DATABASE_URL=%s\n" "$DATABASE_URL"' >"$TMP/migration.env"
chmod 0600 "$TMP/migration.env"; chown root:root "$TMP/migration.env"; [[ $(grep -c '^DATABASE_URL=' "$TMP/migration.env") == 1 ]]

phase migration_apply MIGRATION_PARTIAL_FAILURE
MIGRATION_STARTED=true
run "$MIGRATION_TIMEOUT" docker run --rm --network "$NETWORK_NAME" --env-file "$TMP/migration.env" --entrypoint sh "$GATEWAY_IMAGE" -ceu \
  'exec /app/node_modules/.bin/prisma migrate deploy --schema /app/prisma/schema.prisma' >"$TMP/migration.log" 2>&1

phase migration_verification MIGRATION_VERIFICATION_FAILED
ledger_after_state=$(psql_read "SELECT count(*)::text||'|'||count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::text||'|'||count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)::text FROM \"_prisma_migrations\"")
[[ $ledger_after_state == '54|54|0' ]]
ledger_after=$(psql_read 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name')
comm -13 <(printf '%s\n' "$ledger_before") <(printf '%s\n' "$ledger_after") >"$TMP/applied-now"; cmp "$TMP/expected" "$TMP/applied-now"
[[ $(psql_read "SELECT to_regclass('public.\"MaxRawTransportEvent\"') IS NOT NULL") == t ]]
[[ $(psql_read "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='MaxRawTransportEvent' AND column_name='captureEnvelopeId')") == t ]]
[[ $(psql_read "SELECT to_regclass('public.\"MaxRawTransportEvent_accountId_captureEnvelopeId_idx\"') IS NOT NULL") == t ]]
[[ $(psql_read "SELECT to_regclass('public.\"MaxRawTransportEvent_accountId_captureEnvelopeId_key\"') IS NOT NULL") == t ]]
[[ $(psql_read 'SELECT count(*) FROM "MaxRawTransportEvent"') == 0 ]]
run 600 docker run --rm --network "$NETWORK_NAME" --env-file "$TMP/migration.env" --entrypoint sh "$GATEWAY_IMAGE" -ceu \
  'exec /app/node_modules/.bin/prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel /app/prisma/schema.prisma --exit-code' >"$TMP/prisma-diff.log" 2>&1

phase production_immutability PRODUCTION_DRIFT
PROJECT_HASH_AFTER=$(project_hash); RESTART_HASH_AFTER=$(restart_hash)
[[ $PROJECT_HASH_AFTER == "$PROJECT_HASH_BEFORE" && $RESTART_HASH_AFTER == "$RESTART_HASH_BEFORE" ]]
[[ $(git -C /opt/crm rev-parse HEAD) == "$PRODUCTION_HEAD" ]]
status_after=$(git -C /opt/crm status --porcelain=v2 --untracked-files=all | LC_ALL=C sort | sha256sum | awk '{print $1}')
[[ $status_after == "$PRODUCTION_STATUS_V2_SHA" ]]
free_after=$(df -B1 --output=avail "$BACKUP_PARENT" | awk 'NR==2{print $1}'); (( free_after >= ROLLBACK_RESERVE_BYTES ))

phase report_handoff REPORT_HANDOFF_FAILED
report_tmp=$(mktemp "/var/tmp/personal-max-stage8b2a-production-migration.$SCRIPT_SHA.XXXXXX")
jq -n --arg scriptSha "$SCRIPT_SHA" --arg isolatedSha "$PERSONAL_MAX_ISOLATED_REPORT_SHA256" --arg image "$GATEWAY_IMAGE" \
  --arg backupDirectory "$BACKUP_DIRECTORY" --arg dumpSha "$dump_sha" --arg configSha "$config_sha" \
  --arg beforeHash "$PROJECT_HASH_BEFORE" --arg afterHash "$PROJECT_HASH_AFTER" --argjson dumpBytes "$dump_bytes" \
  --argjson objectCount "$object_count" --argjson freeBefore "$free_before" --argjson freeAfter "$free_after" \
  --argjson applied "$(jq -Rsc 'split("\n")[:-1]' "$TMP/applied-now")" '
  {schemaVersion:1,mode:"PRODUCTION_MIGRATION_EVIDENCE",script:{sha256:$scriptSha,checksumBound:true},
   bindings:{isolatedReportSha256:$isolatedSha,acceptedBackupReportSha256:"f9b29d5fbe69b9a87d402bab3a19a1079797640549078b17a6ba8e7280415566"},
   image:{ref:$image,digestBound:true},freshBackup:{directory:$backupDirectory,dumpSha256:$dumpSha,dumpBytes:$dumpBytes,objectCount:$objectCount,configArchiveSha256:$configSha,structuralValidation:"PASS"},
   migration:{before:{total:46,finished:46,failed:0},after:{total:54,finished:54,failed:0},appliedNames:$applied,rawRows:0,prismaDiffEmpty:true},
   production:{containerHashBefore:$beforeHash,containerHashAfter:$afterHash,restartCountsUnchanged:true,gitUnchanged:true},
   storage:{freeBytesBefore:$freeBefore,freeBytesAfter:$freeAfter,rollbackReserveBytes:5368709120},
   safety:{deploy:false,restart:false,captureEnabled:false,gatewayStarted:false,scraperChanged:false,destructiveRollback:false,secretsPrinted:false,providerAction:false,maxContacted:false}}' >"$report_tmp"
jq -e -f "$PACKAGE_ROOT/report-success.jq" "$report_tmp" >/dev/null
chown root:codexbot "$report_tmp"; chmod 0640 "$report_tmp"; mv --no-clobber "$report_tmp" "$SUCCESS_REPORT"
run 5 runuser -u codexbot -- test -r "$SUCCESS_REPORT"; if run 5 runuser -u codexbot -- test -w "$SUCCESS_REPORT"; then false; fi
report_sha=$(sha_file "$SUCCESS_REPORT")
trap - ERR EXIT; cleanup 0
printf 'STAGE8B2A_MIGRATION_COMPLETED\nSANITIZED_RESULT_PATH=%s\nSANITIZED_RESULT_SHA256=%s\nFRESH_BACKUP_DIRECTORY=%s\nDEPLOY=NO\nRESTART=NO\nCAPTURE_ENABLED=NO\n' "$SUCCESS_REPORT" "$report_sha" "$BACKUP_DIRECTORY"
