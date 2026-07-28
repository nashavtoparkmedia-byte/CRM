#!/usr/bin/env bash
# shellcheck disable=SC2016
set -Eeuo pipefail
umask 077

readonly PACKAGE_ROOT='/opt/codex-work/crm-personal-max-stage8b2-autonomous-20260728T122700Z/release/personal-max-stage8b2-shadow-observation'
readonly MIGRATION_REPORT='/var/tmp/personal-max-stage8b2a-production-migration.json'
readonly DORMANT_REPORT='/var/tmp/personal-max-stage8b2b-dormant-gateway.json'
readonly GATEWAY_CONTAINER='personal-max-dormant-gateway'
readonly EXPECTED_DORMANT_NETWORK='personal-max-stage8b2b-dormant'
readonly ACCEPTED_GATEWAY_REF='ghcr.io/nashavtoparkmedia-byte/crm-max-personal-gateway@sha256:dd718fd8e9e2ec52a0ee1c19b576d75a1035f9e251980351ebc04071dfe5d0de'
readonly ACCEPTED_SCRAPER_REF='ghcr.io/nashavtoparkmedia-byte/crm-max-web-scraper@sha256:abf4405f55ab1c84f319b00cdb8b561f76353001ba2543045fddb17dc6b46768'
readonly ACCEPTED_IMAGE_SOURCE_COMMIT='33eb40b87f77eee16fbf4ccd06a667ea4ce51e5a'
readonly ACCEPTED_BACKUP_REPORT_SHA='f9b29d5fbe69b9a87d402bab3a19a1079797640549078b17a6ba8e7280415566'
readonly ACCEPTED_MIGRATION_SCRIPT_SHA='bf707cca672b350317717c2f611a371ca705fcc58c8eba8d6d0830e3715fe740'
readonly ACCEPTED_DORMANT_SCRIPT_SHA='b911aadacba8d3d6226dfd6b6a9e0445da02cc560d36e2be8b14984fb7dc35f5'
readonly ACCEPTED_DORMANT_ROLLBACK_SHA='d1260c5ad1eda416607ad87e0972d37d2cfaacb61117312a75c017e829a6f090'
readonly ACCEPTED_DORMANT_COMPOSE_SHA='3f9656117f5da8db510a9710744263384619aa371cac6fa7c8a7d3e50a352ca2'
readonly OBSERVATIONS_SQL_SHA='cf8c35c396281b2d9e3f440cf514c99aedf21aa7e32bfb549470f08d7f57c17d'
readonly EVALUATOR_SHA='617d84e617b63a76730baec3bf6217118abb0eec0b70fa6348625d52cfe8ae21'
readonly EXPECTED_MIGRATIONS_JSON='["20260726162043_add_max_raw_transport_journal","20260726190658_add_max_route_registry","20260726205437_add_max_inbound_normalization","20260726215715_add_max_per_chat_outbound_actor","20260726225737_add_max_dispatch_ledger","20260727053744_add_max_provider_confirmation_matcher","20260727141925_add_max_shadow_semantic_comparison","20260727154647_add_max_capture_ingress"]'
readonly ACCEPTED_LEDGER_ONLY_MIGRATION='20260717000000_add_driver_telegram_submitted_phone'
readonly PROJECT_LABEL='com.docker.compose.project=crm'
readonly POSTGRES_LABEL='com.docker.compose.service=postgres'
readonly SCRAPER_LABEL='com.docker.compose.service=max-web-scraper'
readonly ROLLBACK_RESERVE_BYTES=5368709120
readonly FAILURE_PREFIX='/var/tmp/personal-max-stage8b2-shadow-observation.failure'

TMP=''
PHASE='bootstrap'
CLASSIFICATION='UNEXPECTED_FAILURE'
SCRIPT_SHA=''

cleanup() {
  trap - EXIT
  if [[ -n ${TMP:-} && $TMP == /var/tmp/personal-max-shadow-observer.* && -d $TMP && ! -L $TMP ]]; then
    rm -rf -- "$TMP"
  fi
}
trap cleanup EXIT

fatal() {
  printf 'SHADOW_OBSERVER_FAILED:%s\n' "$1" >&2
  exit "${2:-1}"
}

verify_package_artifact() {
  local candidate=$1 expected_path=$2 expected_sha=$3 canonical actual_sha
  canonical=$(realpath -- "$candidate") || fatal PACKAGE_ARTIFACT_UNREADABLE 75
  [[ $canonical == "$expected_path" && -f $candidate && ! -L $candidate ]] || fatal PACKAGE_ARTIFACT_PATH_INVALID 75
  actual_sha=$(sha256sum -- "$candidate" | awk '{print $1}')
  [[ $actual_sha == "$expected_sha" ]] || fatal PACKAGE_ARTIFACT_CHECKSUM_MISMATCH 79
}

(( EUID == 0 )) || fatal ROOT_REQUIRED 77
[[ ${1:-} =~ ^[0-9a-f]{64}$ ]] || fatal CHECKSUM_BINDING_REQUIRED 78
for binary in awk cat chmod chown cp date df docker getent jq mktemp mv python3 realpath rm runuser sha256sum sort stat timeout tr wc; do
  command -v "$binary" >/dev/null || fatal "MANDATORY_BINARY_MISSING:$binary" 76
done
getent group codexbot >/dev/null || fatal CODEXBOT_GROUP_MISSING 76

script_path=$(realpath -- "${BASH_SOURCE[0]}")
[[ $script_path =~ ^/var/tmp/personal-max-shadow-observer[.]snapshot[.][A-Za-z0-9]+$ ]] || fatal SCRIPT_SNAPSHOT_PATH_INVALID 75
[[ -f $script_path && ! -L $script_path ]] || fatal SCRIPT_SNAPSHOT_TYPE_INVALID 75
[[ $(stat -Lc '%U:%G:%a' "$script_path") == root:root:700 ]] || fatal SCRIPT_SNAPSHOT_OWNERSHIP_INVALID 75
SCRIPT_SHA=$(sha256sum -- "$script_path" | awk '{print $1}')
[[ $SCRIPT_SHA == "$1" ]] || fatal CHECKSUM_MISMATCH 79
verify_package_artifact "$PACKAGE_ROOT/observations.sql" "$PACKAGE_ROOT/observations.sql" "$OBSERVATIONS_SQL_SHA"
verify_package_artifact "$PACKAGE_ROOT/evaluate.py" "$PACKAGE_ROOT/evaluate.py" "$EVALUATOR_SHA"

on_error() {
  local original=${1:-1}
  local line=${2:-0}
  local failure_timestamp failure_tmp failure_report failure_sha
  trap - ERR
  set +e
  printf 'SHADOW_OBSERVER_FAILED:phase=%s classification=%s line=%s exit=%s\n' "$PHASE" "$CLASSIFICATION" "$line" "$original" >&2
  failure_timestamp=$(date -u +'%Y%m%dT%H%M%SZ')
  failure_report="$FAILURE_PREFIX.$SCRIPT_SHA.$failure_timestamp.json"
  if [[ ! -e $failure_report && ! -L $failure_report ]]; then
    failure_tmp=$(mktemp "/var/tmp/personal-max-stage8b2-shadow-observation.failure.$SCRIPT_SHA.XXXXXXXX")
    jq -n --arg scriptSha "$SCRIPT_SHA" --arg phase "$PHASE" --arg classification "$CLASSIFICATION" \
      --argjson line "$line" --argjson exitCode "$original" '
      {schemaVersion:2,mode:"SHADOW_OBSERVATION_FAILURE",script:{sha256:$scriptSha,checksumBound:true},failure:{phase:$phase,classification:$classification,line:$line,exitCode:$exitCode},safety:{databaseReadOnly:true,ddl:false,dml:false,dockerMutation:false,deploy:false,restart:false,browserLaunched:false,maxContacted:false,providerAction:false,secretsPrinted:false,rawAccountIdPrinted:false}}' >"$failure_tmp"
    chown root:codexbot "$failure_tmp"
    chmod 0640 "$failure_tmp"
    if mv --no-clobber "$failure_tmp" "$failure_report"; then
      failure_sha=$(sha256sum -- "$failure_report" | awk '{print $1}')
      printf 'SANITIZED_FAILURE_PATH=%s\nSANITIZED_FAILURE_SHA256=%s\n' "$failure_report" "$failure_sha" >&2
    fi
  fi
  exit "$original"
}
trap 'on_error "$?" "$LINENO"' ERR

PHASE='arguments'
CLASSIFICATION='INPUT_INVALID'
case ${2:-} in
  dormant|default-off|one-account|ab) target=$2 ;;
  *) false ;;
esac
case ${3:-} in
  5m) seconds=300 ;;
  30m) seconds=1800 ;;
  2h) seconds=7200 ;;
  24h) seconds=86400 ;;
  *) false ;;
esac
[[ ${PERSONAL_MAX_MIGRATION_REPORT_SHA256:-} =~ ^[0-9a-f]{64}$ ]]
[[ ${PERSONAL_MAX_DORMANT_REPORT_SHA256:-} =~ ^[0-9a-f]{64}$ ]]
account_csv=${PERSONAL_MAX_OBSERVATION_ACCOUNT_IDS:-}
account_pattern='[A-Za-z0-9][A-Za-z0-9._:-]{0,127}'
case $target in
  dormant)
    [[ -z $account_csv ]]
    ;;
  one-account)
    [[ $account_csv =~ ^${account_pattern}$ ]]
    ;;
  default-off)
    [[ $account_csv =~ ^${account_pattern}(,${account_pattern})?$ ]]
    ;;
  ab)
    [[ $account_csv =~ ^${account_pattern},${account_pattern}$ ]]
    IFS=, read -r account_one account_two <<<"$account_csv"
    [[ $account_one != "$account_two" ]]
    ;;
esac
if [[ -n $account_csv ]]; then
  IFS=, read -ra observation_accounts <<<"$account_csv"
  for observation_account in "${observation_accounts[@]}"; do
    case ${observation_account,,} in
      true|false|0|1|all) false ;;
    esac
  done
fi
if [[ $target == one-account || $target == ab ]]; then
  spool_limit=${PERSONAL_MAX_OBSERVATION_SPOOL_LIMIT_BYTES:-}
  [[ $spool_limit =~ ^[0-9]+$ ]]
  (( spool_limit >= 1048576 && spool_limit <= 10737418240 ))
  spool_limit_evidence='OPERATOR_BOUND_NOT_RUNTIME_OBSERVED'
else
  spool_limit=0
  spool_limit_evidence='NOT_REQUIRED_FOR_TARGET'
fi

PHASE='temporary_workspace'
CLASSIFICATION='TEMPORARY_WORKSPACE_FAILED'
TMP=$(mktemp -d /var/tmp/personal-max-shadow-observer.XXXXXXXX)
chmod 0700 "$TMP"
chown root:root "$TMP"
cp --no-preserve=mode,ownership -- "$PACKAGE_ROOT/observations.sql" "$TMP/observations.sql"
cp --no-preserve=mode,ownership -- "$PACKAGE_ROOT/evaluate.py" "$TMP/evaluate.py"
chown root:root "$TMP/observations.sql" "$TMP/evaluate.py"
chmod 0600 "$TMP/observations.sql" "$TMP/evaluate.py"
[[ $(sha256sum -- "$TMP/observations.sql" | awk '{print $1}') == "$OBSERVATIONS_SQL_SHA" ]]
[[ $(sha256sum -- "$TMP/evaluate.py" | awk '{print $1}') == "$EVALUATOR_SHA" ]]

PHASE='evidence_binding'
CLASSIFICATION='BOUND_EVIDENCE_INVALID'
for bound_report in "$MIGRATION_REPORT" "$DORMANT_REPORT"; do
  [[ -f $bound_report && ! -L $bound_report ]]
  [[ $(stat -Lc '%U:%G:%a' "$bound_report") == root:codexbot:640 ]]
  timeout 5 runuser -u codexbot -- test -r "$bound_report"
  if timeout 5 runuser -u codexbot -- test -w "$bound_report"; then false; fi
done
timeout 5 cp --no-preserve=mode,ownership -- "$MIGRATION_REPORT" "$TMP/migration-report.json"
timeout 5 cp --no-preserve=mode,ownership -- "$DORMANT_REPORT" "$TMP/dormant-report.json"
chown root:root "$TMP/migration-report.json" "$TMP/dormant-report.json"
chmod 0600 "$TMP/migration-report.json" "$TMP/dormant-report.json"
for evidence_snapshot in "$TMP/migration-report.json" "$TMP/dormant-report.json"; do
  [[ -f $evidence_snapshot && ! -L $evidence_snapshot ]]
  [[ $(stat -Lc '%U:%G:%a' "$evidence_snapshot") == root:root:600 ]]
done
[[ $(sha256sum -- "$TMP/migration-report.json" | awk '{print $1}') == "$PERSONAL_MAX_MIGRATION_REPORT_SHA256" ]]
[[ $(sha256sum -- "$TMP/dormant-report.json" | awk '{print $1}') == "$PERSONAL_MAX_DORMANT_REPORT_SHA256" ]]
jq -e --arg scriptSha "$ACCEPTED_MIGRATION_SCRIPT_SHA" --arg image "$ACCEPTED_GATEWAY_REF" \
  --arg backupSha "$ACCEPTED_BACKUP_REPORT_SHA" --arg ledgerOnly "$ACCEPTED_LEDGER_ONLY_MIGRATION" \
  --argjson migrations "$EXPECTED_MIGRATIONS_JSON" '
  (keys|sort)==(["bindings","freshBackup","image","migration","mode","production","runners","safety","schema","schemaVersion","script","storage"]|sort) and
  .schemaVersion==1 and .mode=="PRODUCTION_MIGRATION_EVIDENCE" and
  .script=={sha256:$scriptSha,checksumBound:true} and
  .bindings=={isolatedReportSha256:.bindings.isolatedReportSha256,acceptedBackupReportSha256:$backupSha} and
  (.bindings.isolatedReportSha256|type)=="string" and (.bindings.isolatedReportSha256|test("^[0-9a-f]{64}$")) and
  .image=={ref:$image,digestBound:true} and
  (.freshBackup|keys|sort)==(["configArchiveSha256","directory","dumpBytes","dumpSha256","objectCount","status","structuralValidation"]|sort) and
  .freshBackup.status=="VALIDATED" and .freshBackup.structuralValidation=="PASS" and
  (.freshBackup.directory|test("^/var/backups/personal-max-stage8b2a-pre-migration-[0-9]{8}T[0-9]{6}Z$")) and
  (.freshBackup.dumpSha256|test("^[0-9a-f]{64}$")) and (.freshBackup.configArchiveSha256|test("^[0-9a-f]{64}$")) and
  .freshBackup.dumpBytes>0 and .freshBackup.objectCount>0 and
  (.migration|keys|sort)==(["acceptedLedgerOnlyMigrations","after","appliedNames","before","prismaDiffEmpty","prismaDiffRawSqlIncluded","prismaDiffStatus","rawRows"]|sort) and
  .migration.before=={total:46,finished:46,failed:0} and .migration.after=={total:54,finished:54,failed:0} and
  .migration.appliedNames==$migrations and .migration.acceptedLedgerOnlyMigrations==[$ledgerOnly] and
  .migration.rawRows==0 and .migration.prismaDiffEmpty==false and
  .migration.prismaDiffStatus=="ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS" and .migration.prismaDiffRawSqlIncluded==false and
  .schema=={rawJournalConstraints:["MaxRawTransportEvent_payloadSizeBytes_check","MaxRawTransportEvent_quarantineConsistency_check","MaxRawTransportEvent_replayAvailability_check"],appendOnlyTrigger:"MaxRawTransportEvent_append_only",appendOnlyFunction:"max_raw_transport_event_append_only_guard"} and
  .runners=={migration:{name:"personal-max-stage8b2a-migration-runner",cleanupState:"ABSENT_AFTER_SUCCESS"},prismaDiff:{name:"personal-max-stage8b2a-prisma-diff-runner",cleanupState:"ABSENT_AFTER_SUCCESS"},allOwnedRunnersAbsent:true} and
  (.production|keys|sort)==(["containerHashAfter","containerHashBefore","gitUnchanged","restartCountsUnchanged"]|sort) and
  (.production.containerHashBefore|test("^[0-9a-f]{64}$")) and .production.containerHashAfter==.production.containerHashBefore and
  .production.restartCountsUnchanged==true and .production.gitUnchanged==true and
  .storage=={freeBytesBefore:.storage.freeBytesBefore,freeBytesAfter:.storage.freeBytesAfter,rollbackReserveBytes:5368709120} and
  .storage.freeBytesBefore>0 and .storage.freeBytesAfter>=5368709120 and
  .safety=={deploy:false,restart:false,captureEnabled:false,gatewayStarted:false,scraperChanged:false,destructiveRollback:false,secretsPrinted:false,providerAction:false,maxContacted:false}
' "$TMP/migration-report.json" >/dev/null
migration_isolated_sha=$(jq -r '.bindings.isolatedReportSha256' "$TMP/migration-report.json")
jq -e --arg scriptSha "$ACCEPTED_DORMANT_SCRIPT_SHA" --arg image "$ACCEPTED_GATEWAY_REF" \
  --arg migrationSha "$PERSONAL_MAX_MIGRATION_REPORT_SHA256" --arg isolatedSha "$migration_isolated_sha" \
  --arg migrationScriptSha "$ACCEPTED_MIGRATION_SCRIPT_SHA" --arg rollbackScriptSha "$ACCEPTED_DORMANT_ROLLBACK_SHA" \
  --arg composeSha "$ACCEPTED_DORMANT_COMPOSE_SHA" --arg ledgerOnly "$ACCEPTED_LEDGER_ONLY_MIGRATION" '
  (keys|sort)==(["acceptedMigration","behavior","bindings","image","mode","production","rollback","runtime","schemaVersion","script","storage"]|sort) and
  .schemaVersion==1 and .mode=="DORMANT_GATEWAY_ROLLOUT" and
  .script=={sha256:$scriptSha,checksumBound:true} and
  .bindings=={isolatedReportSha256:$isolatedSha,migrationReportSha256:$migrationSha,migrationScriptSha256:$migrationScriptSha} and
  .acceptedMigration=={reportValidated:true,productionMigrationScriptSha256:$migrationScriptSha,gatewayImage:$image,isolatedReportShaCrossBound:true,
    freshBackupStatus:"VALIDATED",appliedCount:8,runnerCleanup:"PASS",safety:"PASS",prismaDiffEmpty:false,
    prismaDiffStatus:"ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS",prismaDiffRawSqlIncluded:false,acceptedLedgerOnlyMigrations:[$ledgerOnly]} and
  .image=={ref:$image,runtimeUser:"1000:1000"} and
  .runtime=={container:"personal-max-dormant-gateway",network:"personal-max-stage8b2b-dormant",networkInternal:true,publicPorts:0,mounts:0,health:"PASS",readiness:"dormant-ready",restartPolicy:"unless-stopped"} and
  .behavior=={databaseConfigured:false,databaseWrites:0,captureEnabled:false,senderActive:false,browserLaunched:false,maxContacted:false,providerAction:false} and
  (.production|keys|sort)==(["hashAfter","hashBefore","restartCountsUnchanged","unchanged"]|sort) and
  (.production.hashBefore|test("^[0-9a-f]{64}$")) and .production.hashAfter==.production.hashBefore and .production.unchanged==true and .production.restartCountsUnchanged==true and
  .storage=={freeBytesBefore:.storage.freeBytesBefore} and .storage.freeBytesBefore>0 and
  .rollback=={available:true,automatic:false,scriptSha256:$rollbackScriptSha,composeSha256:$composeSha}
' "$TMP/dormant-report.json" >/dev/null
end_epoch=$(date -u +%s)
start_epoch=$((end_epoch-seconds))
timestamp=$(date -u +'%Y%m%dT%H%M%SZ')
report="/var/tmp/personal-max-stage8b2-shadow-observation-$target-${3}-$timestamp.json"
[[ ! -e $report && ! -L $report ]]

PHASE='postgres_discovery'
CLASSIFICATION='POSTGRES_RUNTIME_UNAVAILABLE'
timeout 30 docker ps -q --no-trunc --filter "label=$PROJECT_LABEL" --filter "label=$POSTGRES_LABEL" >"$TMP/postgres-ids.txt"
sort -u "$TMP/postgres-ids.txt" -o "$TMP/postgres-ids.txt"
mapfile -t pg_ids <"$TMP/postgres-ids.txt"
(( ${#pg_ids[@]} == 1 ))
pg_id=${pg_ids[0]}
[[ $(timeout 30 docker inspect --format '{{.State.Status}}' "$pg_id") == running ]]

PHASE='database_observation'
CLASSIFICATION='DATABASE_OBSERVATION_FAILED'
{
  printf '\\set start_epoch %s\n' "$start_epoch"
  printf '\\set end_epoch %s\n' "$end_epoch"
  printf "\\set account_csv '%s'\n" "$account_csv"
  cat "$TMP/observations.sql"
} >"$TMP/query.sql"
chmod 0600 "$TMP/query.sql"
timeout --signal=TERM --kill-after=10 60 docker exec -i "$pg_id" sh -ceu 'export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000"; exec psql --no-psqlrc -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <"$TMP/query.sql" >"$TMP/database.json"
jq -e '.schemaVersion==2 and (.databaseSnapshotIdentity|type)=="string" and (.accounts|type)=="array" and .accountCount==(.accounts|length) and (.totals.rawJournalRows|type)=="number" and (.totals.rawJournalRowsPerSecond|type)=="number" and (.schemaState.migrationLedger|type)=="object" and (.schemaState.rawJournal|type)=="object"' "$TMP/database.json" >/dev/null

PHASE='gateway_runtime_observation'
CLASSIFICATION='GATEWAY_RUNTIME_UNAVAILABLE'
gateway_id=$(timeout 30 docker inspect --format '{{.Id}}' "$GATEWAY_CONTAINER")
gateway_state=$(timeout 30 docker inspect --format '{{.State.Status}}' "$gateway_id")
gateway_health=$(timeout 30 docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$gateway_id")
gateway_restarts=$(timeout 30 docker inspect --format '{{.RestartCount}}' "$gateway_id")
gateway_image_id=$(timeout 30 docker inspect --format '{{.Image}}' "$gateway_id")
gateway_configured_ref=$(timeout 30 docker inspect --format '{{.Config.Image}}' "$gateway_id")
gateway_revision=$(timeout 30 docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$gateway_id")
gateway_lifecycle=$(timeout 30 docker inspect --format '{{index .Config.Labels "personal-max.lifecycle"}}' "$gateway_id")
gateway_started_at=$(timeout 30 docker inspect --format '{{.State.StartedAt}}' "$gateway_id")
gateway_started_epoch=$(date -u -d "$gateway_started_at" +%s)
gateway_runtime_user=$(timeout 30 docker inspect --format '{{.Config.User}}' "$gateway_id")
gateway_restart_policy=$(timeout 30 docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$gateway_id")
gateway_public_port_bindings=$(timeout 30 docker inspect --format '{{len .HostConfig.PortBindings}}' "$gateway_id")
gateway_mount_count=$(timeout 30 docker inspect --format '{{len .Mounts}}' "$gateway_id")
gateway_readonly_rootfs=$(timeout 30 docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$gateway_id")
gateway_privileged=$(timeout 30 docker inspect --format '{{.HostConfig.Privileged}}' "$gateway_id")
gateway_cap_drop=$(timeout 30 docker inspect --format '{{json .HostConfig.CapDrop}}' "$gateway_id" | jq -c 'if type=="array" then sort else [] end')
gateway_cap_add=$(timeout 30 docker inspect --format '{{json .HostConfig.CapAdd}}' "$gateway_id" | jq -c 'if type=="array" then sort else [] end')
gateway_security_opt=$(timeout 30 docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$gateway_id" | jq -c 'if type=="array" then sort else [] end')
gateway_init=$(timeout 30 docker inspect --format '{{.HostConfig.Init}}' "$gateway_id")
gateway_pids_limit=$(timeout 30 docker inspect --format '{{.HostConfig.PidsLimit}}' "$gateway_id")
gateway_network_names=$(timeout 30 docker inspect --format '{{json .NetworkSettings.Networks}}' "$gateway_id" | jq -c 'if type=="object" then keys|sort else [] end')
if jq -e --arg expected "$EXPECTED_DORMANT_NETWORK" 'index($expected)!=null' <<<"$gateway_network_names" >/dev/null; then
  case $(timeout 30 docker network inspect --format '{{.Internal}}' "$EXPECTED_DORMANT_NETWORK") in
    true) gateway_network_internal=true ;;
    false) gateway_network_internal=false ;;
    *) gateway_network_internal=null ;;
  esac
else
  gateway_network_internal=null
fi
gateway_compose_project=$(timeout 30 docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$gateway_id")
gateway_compose_service=$(timeout 30 docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$gateway_id")
gateway_stage_label=$(timeout 30 docker inspect --format '{{index .Config.Labels "personal-max.stage"}}' "$gateway_id")
gateway_mode_label=$(timeout 30 docker inspect --format '{{index .Config.Labels "personal-max.mode"}}' "$gateway_id")
[[ $gateway_revision != '<no value>' ]] || gateway_revision=''
[[ $gateway_lifecycle != '<no value>' ]] || gateway_lifecycle=''
[[ $gateway_compose_project != '<no value>' ]] || gateway_compose_project=''
[[ $gateway_compose_service != '<no value>' ]] || gateway_compose_service=''
[[ $gateway_stage_label != '<no value>' ]] || gateway_stage_label=''
[[ $gateway_mode_label != '<no value>' ]] || gateway_mode_label=''
gateway_repo_digests=$(timeout 30 docker image inspect --format '{{json .RepoDigests}}' "$gateway_image_id" | jq -c 'if type=="array" then . else [] end')
if jq -e --arg accepted "$ACCEPTED_GATEWAY_REF" 'index($accepted)!=null' <<<"$gateway_repo_digests" >/dev/null; then gateway_digest_present=true; else gateway_digest_present=false; fi
timeout 30 docker exec "$gateway_id" node -e 'fetch("http://127.0.0.1:8080/health").then(async r=>process.stdout.write(JSON.stringify({status:r.status,body:await r.json()}))).catch(()=>process.exit(2))' >"$TMP/health.json"
timeout 30 docker exec "$gateway_id" node -e 'fetch("http://127.0.0.1:8080/ready").then(async r=>process.stdout.write(JSON.stringify({status:r.status,body:await r.json()}))).catch(()=>process.exit(2))' >"$TMP/ready.json"
timeout 30 docker exec "$gateway_id" node -e 'fetch("http://127.0.0.1:8080/metrics").then(async r=>{if(r.status!==200)process.exit(2);process.stdout.write(await r.text())}).catch(()=>process.exit(2))' >"$TMP/metrics.txt"

metric() {
  awk -v key="max_personal_$1" '
    $1==key {count++; value=$2}
    END {
      if (count==1 && value ~ /^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$/) print value
      else print "null"
    }
  ' "$TMP/metrics.txt"
}
capture_accepted=$(metric capture_accepted)
retries=$(metric idempotent_retry_count)
lost=$(metric lost_before_spool)
wrong_account=$(metric wrong_account_differences)
critical_runtime=$(metric critical_regressions)
spool_pending=$(metric spool_pending)
spool_bytes=$(metric spool_bytes)
spool_oldest=$(metric oldest_pending_age_ms)
drain_failures=$(metric drain_failures)
metrics_complete=$(jq -n \
  --argjson capture "$capture_accepted" --argjson retries "$retries" --argjson lost "$lost" \
  --argjson wrong "$wrong_account" --argjson critical "$critical_runtime" --argjson pending "$spool_pending" \
  --argjson bytes "$spool_bytes" --argjson oldest "$spool_oldest" --argjson failures "$drain_failures" \
  '[$capture,$retries,$lost,$wrong,$critical,$pending,$bytes,$oldest,$failures] | all(. != null)')

jq -n --arg containerId "$gateway_id" --arg state "$gateway_state" --arg health "$gateway_health" \
  --argjson restarts "$gateway_restarts" --arg acceptedRef "$ACCEPTED_GATEWAY_REF" \
  --arg configuredRef "$gateway_configured_ref" --arg imageId "$gateway_image_id" \
  --argjson repoDigests "$gateway_repo_digests" --argjson acceptedDigestPresent "$gateway_digest_present" \
  --arg sourceRevision "$gateway_revision" --arg lifecycle "$gateway_lifecycle" --argjson startedAtEpoch "$gateway_started_epoch" \
  --arg runtimeUser "$gateway_runtime_user" --arg restartPolicy "$gateway_restart_policy" \
  --argjson publicPortBindings "$gateway_public_port_bindings" --argjson mountCount "$gateway_mount_count" \
  --argjson readonlyRootfs "$gateway_readonly_rootfs" --argjson privileged "$gateway_privileged" \
  --argjson capDrop "$gateway_cap_drop" --argjson capAdd "$gateway_cap_add" --argjson securityOpt "$gateway_security_opt" \
  --argjson init "$gateway_init" --argjson pidsLimit "$gateway_pids_limit" \
  --argjson networkNames "$gateway_network_names" --argjson expectedNetworkInternal "$gateway_network_internal" \
  --arg composeProject "$gateway_compose_project" --arg composeService "$gateway_compose_service" \
  --arg stageLabel "$gateway_stage_label" --arg modeLabel "$gateway_mode_label" \
  --slurpfile healthHttp "$TMP/health.json" --slurpfile readyHttp "$TMP/ready.json" '
  {containerId:$containerId,containerState:$state,dockerHealth:$health,restartCount:$restarts,
   image:{acceptedRef:$acceptedRef,configuredRef:$configuredRef,imageId:$imageId,repoDigests:$repoDigests,acceptedDigestPresent:$acceptedDigestPresent},
   sourceRevision:$sourceRevision,lifecycle:$lifecycle,startedAtEpoch:$startedAtEpoch,runtimeUser:$runtimeUser,restartPolicy:$restartPolicy,
   publicPortBindings:$publicPortBindings,mountCount:$mountCount,networkNames:$networkNames,expectedNetworkInternal:$expectedNetworkInternal,
   composeIdentity:{project:$composeProject,service:$composeService,stage:$stageLabel,mode:$modeLabel},
   securityConfig:{readonlyRootfs:$readonlyRootfs,privileged:$privileged,capDrop:$capDrop,capAdd:$capAdd,securityOpt:$securityOpt,init:$init,pidsLimit:$pidsLimit},
   http:{healthStatus:$healthHttp[0].status,mode:$healthHttp[0].body.mode,enabledAccountCount:$healthHttp[0].body.enabledAccountCount,
         enabledAccountAliases:(if $healthHttp[0].body.enabledAccountCount==0 then [] else null end),
         accountIdentityStatus:(if $healthHttp[0].body.enabledAccountCount==0 then "EMPTY_SCOPE_CONFIRMED" else "UNKNOWN_RUNTIME_DOES_NOT_EXPOSE_HASHED_ACCOUNT_SCOPE" end),
         readinessStatus:$readyHttp[0].status,readinessState:$readyHttp[0].body.state,
         senderModulesInactive:$readyHttp[0].body.senderModulesInactive,providerActionsInactive:$readyHttp[0].body.providerActionsInactive}}' >"$TMP/gateway.json"

PHASE='scraper_runtime_observation'
CLASSIFICATION='SCRAPER_RUNTIME_OBSERVATION_FAILED'
if [[ $target == dormant ]]; then
  jq -n '{requiredForTarget:false,observed:false,observationStatus:"NOT_IN_TARGET_SCOPE",containerCount:null,containerState:null,dockerHealth:null,restartCount:null,startedAtEpoch:null,image:null,sourceRevision:null,profileMount:null,existingFlowHealthy:null}' >"$TMP/scraper.json"
else
  timeout 30 docker ps -aq --no-trunc --filter "label=$PROJECT_LABEL" --filter "label=$SCRAPER_LABEL" >"$TMP/scraper-ids.txt"
  sort -u "$TMP/scraper-ids.txt" -o "$TMP/scraper-ids.txt"
  mapfile -t scraper_ids <"$TMP/scraper-ids.txt"
  scraper_count=${#scraper_ids[@]}
  if (( scraper_count == 1 )); then
    scraper_id=${scraper_ids[0]}
    scraper_state=$(timeout 30 docker inspect --format '{{.State.Status}}' "$scraper_id")
    scraper_health=$(timeout 30 docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$scraper_id")
    scraper_restarts=$(timeout 30 docker inspect --format '{{.RestartCount}}' "$scraper_id")
    scraper_started_at=$(timeout 30 docker inspect --format '{{.State.StartedAt}}' "$scraper_id")
    scraper_started_epoch=$(date -u -d "$scraper_started_at" +%s)
    scraper_image_id=$(timeout 30 docker inspect --format '{{.Image}}' "$scraper_id")
    scraper_configured_ref=$(timeout 30 docker inspect --format '{{.Config.Image}}' "$scraper_id")
    scraper_revision=$(timeout 30 docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$scraper_id")
    [[ $scraper_revision != '<no value>' ]] || scraper_revision=''
    scraper_repo_digests=$(timeout 30 docker image inspect --format '{{json .RepoDigests}}' "$scraper_image_id" | jq -c 'if type=="array" then . else [] end')
    if jq -e --arg accepted "$ACCEPTED_SCRAPER_REF" 'index($accepted)!=null' <<<"$scraper_repo_digests" >/dev/null; then scraper_digest_present=true; else scraper_digest_present=false; fi
    profile_destination_count=$(timeout 30 docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/user_data"}}1{{end}}{{end}}' "$scraper_id" | tr -cd 1 | wc -c)
    profile_exact_count=$(timeout 30 docker inspect --format '{{range .Mounts}}{{if and (eq .Destination "/app/user_data") (eq .Type "volume")}}{{if .RW}}1{{end}}{{end}}{{end}}' "$scraper_id" | tr -cd 1 | wc -c)
    if (( profile_destination_count == 1 && profile_exact_count == 1 )); then profile_rw=true; else profile_rw=false; fi
    jq -n --argjson count "$scraper_count" --arg containerId "$scraper_id" --arg state "$scraper_state" --arg health "$scraper_health" \
      --argjson restarts "$scraper_restarts" --argjson startedAtEpoch "$scraper_started_epoch" --arg acceptedRef "$ACCEPTED_SCRAPER_REF" --arg configuredRef "$scraper_configured_ref" \
      --arg imageId "$scraper_image_id" --argjson repoDigests "$scraper_repo_digests" --argjson acceptedDigestPresent "$scraper_digest_present" \
      --arg sourceRevision "$scraper_revision" --argjson profileCount "$profile_destination_count" --argjson profileRw "$profile_rw" '
      {requiredForTarget:true,observed:true,observationStatus:"OBSERVED",containerCount:$count,containerId:$containerId,containerState:$state,dockerHealth:$health,restartCount:$restarts,startedAtEpoch:$startedAtEpoch,
       image:{acceptedRef:$acceptedRef,configuredRef:$configuredRef,imageId:$imageId,repoDigests:$repoDigests,acceptedDigestPresent:$acceptedDigestPresent},sourceRevision:$sourceRevision,
       profileMount:{destination:"/app/user_data",exactCount:$profileCount,readWrite:$profileRw},existingFlowHealthy:null}' >"$TMP/scraper.json"
  else
    jq -n --argjson count "$scraper_count" '{requiredForTarget:true,observed:false,observationStatus:"EXPECTED_EXACTLY_ONE_CONTAINER",containerCount:$count,containerState:null,dockerHealth:null,restartCount:null,startedAtEpoch:null,image:null,sourceRevision:null,profileMount:null,existingFlowHealthy:null}' >"$TMP/scraper.json"
  fi
fi

PHASE='storage_observation'
CLASSIFICATION='STORAGE_OBSERVATION_FAILED'
docker_root=$(timeout 30 docker info --format '{{.DockerRootDir}}')
[[ $docker_root == /* && -d $docker_root ]]
free_bytes=$(df -B1 --output=avail "$docker_root" | awk 'NR==2{print $1}')
[[ $free_bytes =~ ^[0-9]+$ ]]

PHASE='report_assembly'
CLASSIFICATION='REPORT_ASSEMBLY_FAILED'
projection_applies=$(jq -n --arg revision "$gateway_revision" --arg accepted "$ACCEPTED_IMAGE_SOURCE_COMMIT" --argjson digest "$gateway_digest_present" '$revision==$accepted and $digest')
sender_observed=$(jq -e '.body | has("senderModulesInactive")' "$TMP/ready.json" >/dev/null && printf true || printf false)
provider_observed=$(jq -e '.body | has("providerActionsInactive")' "$TMP/ready.json" >/dev/null && printf true || printf false)
sender_disabled=$(jq -r 'if .body.senderModulesInactive==true then "true" else "false" end' "$TMP/ready.json")
provider_inactive=$(jq -r 'if .body.providerActionsInactive==true then "true" else "false" end' "$TMP/ready.json")

jq -n --arg target "$target" --arg windowMode "$3" --arg scriptSha "$SCRIPT_SHA" \
  --arg migrationSha "$PERSONAL_MAX_MIGRATION_REPORT_SHA256" --arg dormantSha "$PERSONAL_MAX_DORMANT_REPORT_SHA256" \
  --arg expectedSourceCommit "$ACCEPTED_IMAGE_SOURCE_COMMIT" \
  --argjson startEpoch "$start_epoch" --argjson endEpoch "$end_epoch" --argjson seconds "$seconds" \
  --slurpfile migrationEvidence "$TMP/migration-report.json" --slurpfile dormantEvidence "$TMP/dormant-report.json" \
  --slurpfile database "$TMP/database.json" --slurpfile gateway "$TMP/gateway.json" --slurpfile scraper "$TMP/scraper.json" \
  --argjson metricsComplete "$metrics_complete" --argjson captureAccepted "$capture_accepted" --argjson retries "$retries" \
  --argjson lost "$lost" --argjson wrongAccount "$wrong_account" --argjson criticalRuntime "$critical_runtime" \
  --argjson drainFailures "$drain_failures" --argjson spoolPending "$spool_pending" --argjson spoolBytes "$spool_bytes" \
  --argjson spoolOldest "$spool_oldest" --argjson spoolLimit "$spool_limit" --arg spoolLimitEvidence "$spool_limit_evidence" \
  --arg dockerRoot "$docker_root" --argjson freeBytes "$free_bytes" --argjson reserve "$ROLLBACK_RESERVE_BYTES" \
  --argjson projectionApplies "$projection_applies" --argjson senderObserved "$sender_observed" --argjson senderDisabled "$sender_disabled" \
  --argjson providerObserved "$provider_observed" --argjson providerInactive "$provider_inactive" '
  {schemaVersion:2,mode:"SHADOW_OBSERVATION",target:$target,script:{sha256:$scriptSha,checksumBound:true},
   bindings:{migrationReport:{sha256:$migrationSha,evidence:$migrationEvidence[0]},dormantRolloutReport:{sha256:$dormantSha,evidence:$dormantEvidence[0]}},
   window:{mode:$windowMode,startEpoch:$startEpoch,endEpoch:$endEpoch,seconds:$seconds},
   release:{expectedImageSourceCommit:$expectedSourceCommit,gatewaySourceRevision:$gateway[0].sourceRevision,scraperSourceRevision:$scraper[0].sourceRevision},
   database:$database[0],runtime:{gateway:$gateway[0],scraper:$scraper[0]},
   runtimeCounters:{scope:"gateway_process_lifetime",metricsComplete:$metricsComplete,captureAcceptedEnvelopes:$captureAccepted,idempotentRetries:$retries,lostBeforeSpool:$lost,wrongAccount:$wrongAccount,criticalRegressions:$criticalRuntime,drainFailures:$drainFailures,spoolPending:$spoolPending,spoolBytes:$spoolBytes,oldestSpoolAgeMs:$spoolOldest,spoolLimitBytes:$spoolLimit,spoolLimitEvidence:$spoolLimitEvidence},
   ownership:{browserOwnersObserved:null,browserOwnershipStatus:"UNKNOWN_REQUIRES_SEPARATE_AUTHORIZED_RUNTIME_METADATA",listenerOwnersObserved:null,listenerOwnershipStatus:"UNKNOWN_REQUIRES_SEPARATE_AUTHORIZED_RUNTIME_METADATA"},
   observability:{physicalFrames:{count:null,status:"UNKNOWN_NO_WINDOW_ALIGNED_PHYSICAL_FRAME_SOURCE",rawJournalRowsAreNotPhysicalFrames:true}},
   disk:{dockerRoot:$dockerRoot,freeBytes:$freeBytes,rollbackReserveBytes:$reserve,belowReserve:($freeBytes<$reserve)},
   sourceContracts:{projectionDisabled:{value:true,factKind:"SOURCE_BOUND_CONTRACT",runtimeObserved:false,sourceCommit:$expectedSourceCommit,appliesToObservedGateway:$projectionApplies,
      files:[{path:"max-personal-gateway/src/runtime/main.ts",sha256:"8c73af79aa02d7ad620161b8d5ada465a041f09f86f957c1effcd5956b14e4ca"},{path:"max-personal-gateway/src/runtime/ShadowPipeline.ts",sha256:"7385c7339ab999b536f64bc5afe3910792021a8e47430ec5e2c4dbb13c58e90a"},{path:"max-personal-gateway/src/runtime/config.ts",sha256:"cb5fc7851cfb5623316d4215c98b42a2b0b32955d5da3839fa65ea6a334ff79c"}]},
      senderDisabled:{value:$senderDisabled,runtimeReadinessObserved:$senderObserved},providerActionsInactive:{value:$providerInactive,runtimeReadinessObserved:$providerObserved}},
   recoveryEvidence:{reconnectRecovery:null,restartRecovery:null,status:"NOT_EXECUTED_REQUIRES_SEPARATE_AUTHORIZATION"},
   privacy:{messageText:false,payload:false,phone:false,displayName:false,contactData:false,providerPayload:false,credentials:false,hmac:false,rawAccountId:false},
   safety:{databaseReadOnly:true,statementTimeoutMs:5000,lockTimeoutMs:1000,ddl:false,dml:false,dockerMutation:false,deploy:false,restart:false,browserLaunched:false,maxContacted:false,providerAction:false,secretsPrinted:false,environmentValuesInspected:false,rawAccountIdPrinted:false},
   action:{rollbackExecuted:false,enablementFrozen:false}}' >"$TMP/report-base.json"

PYTHONDONTWRITEBYTECODE=1 python3 "$TMP/evaluate.py" "$TMP/report-base.json" "$target" >"$TMP/evaluation.json"
jq --slurpfile evaluation "$TMP/evaluation.json" '. + {evaluation:$evaluation[0]} | .action.enablementFrozen=$evaluation[0].freezeEnablement' "$TMP/report-base.json" >"$TMP/report.json"
jq -e '
  .schemaVersion==2 and .mode=="SHADOW_OBSERVATION" and
  .privacy=={messageText:false,payload:false,phone:false,displayName:false,contactData:false,providerPayload:false,credentials:false,hmac:false,rawAccountId:false} and
  .action.rollbackExecuted==false and (.evaluation.verdict=="ACCEPT" or .evaluation.verdict=="FREEZE_ENABLEMENT")
' "$TMP/report.json" >/dev/null
PYTHONDONTWRITEBYTECODE=1 python3 "$TMP/evaluate.py" --validate-final "$TMP/report.json" "$target" >/dev/null
[[ $(timeout 30 docker inspect --format '{{.Id}}|{{.Name}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.Image}}|{{.Config.Image}}' "$gateway_id") == "$gateway_id|/$GATEWAY_CONTAINER|$gateway_started_at|$gateway_restarts|$gateway_image_id|$gateway_configured_ref" ]]

PHASE='report_handoff'
CLASSIFICATION='REPORT_HANDOFF_FAILED'
chown root:codexbot "$TMP/report.json"
chmod 0640 "$TMP/report.json"
mv --no-clobber "$TMP/report.json" "$report"
timeout 5 runuser -u codexbot -- test -r "$report"
if timeout 5 runuser -u codexbot -- test -w "$report"; then false; fi
report_sha=$(sha256sum -- "$report" | awk '{print $1}')
verdict=$(jq -r '.evaluation.verdict' "$report")
triggers=$(jq -c '.evaluation.triggers' "$report")
trap - ERR
printf 'SHADOW_OBSERVATION_COMPLETED\nSANITIZED_RESULT_PATH=%s\nSANITIZED_RESULT_SHA256=%s\nTARGET=%s\nWINDOW=%s\nVERDICT=%s\nTRIGGERS=%s\nROLLBACK_EXECUTED=NO\n' "$report" "$report_sha" "$target" "$3" "$verdict" "$triggers"
