#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly COMPOSE_FILE='/opt/crm/deploy/docker-compose.production.yml'
readonly PROJECT='crm'
readonly GATEWAY_IMAGE='ghcr.io/nashavtoparkmedia-byte/crm-max-personal-gateway@sha256:dd718fd8e9e2ec52a0ee1c19b576d75a1035f9e251980351ebc04071dfe5d0de'
readonly SCRAPER_IMAGE='ghcr.io/nashavtoparkmedia-byte/crm-max-web-scraper@sha256:abf4405f55ab1c84f319b00cdb8b561f76353001ba2543045fddb17dc6b46768'
readonly GATEWAY_COMPRESSED_BYTES=150067770
readonly SCRAPER_COMPRESSED_BYTES=714626133
readonly RESULT_PATH_EXPECTED='/var/tmp/personal-max-stage8b1r-production-readonly-preflight.json'
readonly RESULT_PATH=${PERSONAL_MAX_PREFLIGHT_RESULT_PATH:-$RESULT_PATH_EXPECTED}
readonly EXPECTED_SHA256=${PERSONAL_MAX_PREFLIGHT_SCRIPT_SHA256:-}
readonly COMMAND_TIMEOUT_SECONDS=15
readonly DB_STATEMENT_TIMEOUT_MS=5000
readonly DB_LOCK_TIMEOUT_MS=1000

SCRIPT_PATH=$(realpath -- "${BASH_SOURCE[0]}")
SCRIPT_DIR=$(dirname -- "$SCRIPT_PATH")
RELEASE_ROOT=$(realpath -- "$SCRIPT_DIR/../../..")

if [[ $(id -u) -ne 0 ]]; then
  echo 'ROOT_REQUIRED: Docker metadata and the in-container read-only PostgreSQL session require root' >&2
  exit 77
fi
if [[ ! "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'CHECKSUM_BINDING_REQUIRED: PERSONAL_MAX_PREFLIGHT_SCRIPT_SHA256 must be an exact SHA-256' >&2
  exit 78
fi
ACTUAL_SHA256=$(sha256sum -- "$SCRIPT_PATH" | awk '{print $1}')
if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
  echo 'CHECKSUM_MISMATCH: refusing production inspection' >&2
  exit 79
fi
if [[ "$RESULT_PATH" != "$RESULT_PATH_EXPECTED" || -e "$RESULT_PATH" || -L "$RESULT_PATH" ]]; then
  echo 'RESULT_PATH_UNSAFE: expected a new fixed /var/tmp report path' >&2
  exit 80
fi

for command in awk chgrp chmod date df dirname docker find findmnt getent head jq mktemp mv realpath runuser sha256sum sort stat timeout uname; do
  command -v "$command" >/dev/null
done
if ! timeout 5 getent group codexbot >/dev/null; then
  echo 'HANDOFF_GROUP_MISSING: required group codexbot does not exist; final report was not created' >&2
  exit 84
fi
test -r "$COMPOSE_FILE"
test -d "$RELEASE_ROOT/gravity-mvp/prisma/migrations"
docker compose version >/dev/null

TMP_RESULT=$(mktemp /var/tmp/personal-max-stage8b1r-production-readonly-preflight.tmp.XXXXXX)
chmod 600 "$TMP_RESULT"
trap 'rm -f -- "$TMP_RESULT"' EXIT

docker_read() {
  timeout --signal=TERM --kill-after=2 "$COMMAND_TIMEOUT_SECONDS" docker "$@"
}

hash_text() {
  sha256sum | awk '{print $1}'
}

snapshot_containers() {
  docker_read compose -p "$PROJECT" -f "$COMPOSE_FILE" ps -aq | sort
}

snapshot_services() {
  local container_id
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    docker_read inspect --format '{{.Id}}|{{.State.Status}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.Config.Image}}' "$container_id"
  done < <(snapshot_containers)
}

snapshot_volumes() {
  docker_read volume ls -q | sort
}

disk_row() {
  local requested_path=$1 existing_path=$1 mount_json block_line inode_line
  while [[ ! -e "$existing_path" && "$existing_path" != / ]]; do existing_path=$(dirname -- "$existing_path"); done
  mount_json=$(findmnt -J -T "$existing_path" -o TARGET,SOURCE,FSTYPE,OPTIONS | jq '.filesystems[0]')
  block_line=$(df -B1 -P "$existing_path" | awk 'NR==2{print $2"|"$3"|"$4"|"$5}')
  inode_line=$(df -PiP "$existing_path" | awk 'NR==2{print $2"|"$3"|"$4"|"$5}')
  IFS='|' read -r total_bytes used_bytes available_bytes used_percent <<<"$block_line"
  IFS='|' read -r inode_total inode_used inode_available inode_used_percent <<<"$inode_line"
  jq -nc --arg path "$requested_path" --arg resolvedPath "$existing_path" --argjson mount "$mount_json" \
    --argjson totalBytes "$total_bytes" --argjson usedBytes "$used_bytes" --argjson availableBytes "$available_bytes" \
    --arg usedPercent "$used_percent" --argjson inodeTotal "$inode_total" --argjson inodeUsed "$inode_used" \
    --argjson inodeAvailable "$inode_available" --arg inodeUsedPercent "$inode_used_percent" \
    '{path:$path,resolvedPath:$resolvedPath,mount:$mount,totalBytes:$totalBytes,usedBytes:$usedBytes,availableBytes:$availableBytes,usedPercent:$usedPercent,inodes:{total:$inodeTotal,used:$inodeUsed,available:$inodeAvailable,usedPercent:$inodeUsedPercent}}'
}

image_fact() {
  local ref=$1 compressed_bytes=$2 inspect
  if inspect=$(docker_read image inspect "$ref" 2>/dev/null); then
    jq -nc --arg ref "$ref" --argjson compressedBytes "$compressed_bytes" --argjson inspect "$inspect" \
      '{ref:$ref,presentLocally:true,compressedRegistryBytes:$compressedBytes,imageId:$inspect[0].Id,localUnpackedBytes:$inspect[0].Size,repoDigests:($inspect[0].RepoDigests//[])}'
  else
    jq -nc --arg ref "$ref" --argjson compressedBytes "$compressed_bytes" \
      '{ref:$ref,presentLocally:false,compressedRegistryBytes:$compressedBytes,imageId:null,localUnpackedBytes:null,repoDigests:[]}'
  fi
}

containers_before=$(snapshot_containers)
services_before=$(snapshot_services)
volumes_before=$(snapshot_volumes)
containers_before_hash=$(printf '%s\n' "$containers_before" | hash_text)
services_before_hash=$(printf '%s\n' "$services_before" | hash_text)
volumes_before_hash=$(printf '%s\n' "$volumes_before" | hash_text)
disk_before=$(disk_row /opt/crm)

os_id=$(awk -F= '$1=="ID"{gsub(/"/,"",$2);print $2}' /etc/os-release)
os_version=$(awk -F= '$1=="VERSION_ID"{gsub(/"/,"",$2);print $2}' /etc/os-release)
kernel=$(uname -sr)
architecture=$(uname -m)
docker_server_version=$(docker_read version --format '{{.Server.Version}}')
docker_compose_version=$(docker compose version --short)
docker_root=$(docker_read info --format '{{.DockerRootDir}}')
docker_driver=$(docker_read info --format '{{.Driver}}')
docker_runtime=$(docker_read info --format '{{json .Runtimes}}' | jq 'keys|sort')

service_rows='[]'
postgres_data_path=''
while IFS= read -r id; do
  [[ -n "$id" ]] || continue
  inspect=$(docker_read inspect "$id")
  service=$(jq -r '.[0].Config.Labels["com.docker.compose.service"] // "unlabelled"' <<<"$inspect")
  image_id=$(jq -r '.[0].Image' <<<"$inspect")
  repo_digests=$(docker_read image inspect "$image_id" | jq '.[0].RepoDigests // [] | sort')
  pid=$(jq -r '.[0].State.Pid' <<<"$inspect")
  runtime_uid='unavailable'
  runtime_gid='unavailable'
  if [[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/status" ]]; then
    runtime_uid=$(awk '/^Uid:/{print $2}' "/proc/$pid/status")
    runtime_gid=$(awk '/^Gid:/{print $2}' "/proc/$pid/status")
  fi
  metadata=$(jq --argjson repoDigests "$repo_digests" '.[0] | {
    id:.Id,name:(.Name|ltrimstr("/")),imageId:.Image,repoDigests:$repoDigests,
    configuredImage:.Config.Image,configuredUser:(.Config.User//""),
    mounts:[.Mounts[]|{type:.Type,name:(.Name//null),source:.Source,destination:.Destination,readWrite:.RW}],
    networks:(.NetworkSettings.Networks|keys|sort),ports:(.NetworkSettings.Ports//{}),
    restartPolicy:.HostConfig.RestartPolicy.Name,health:(.State.Health.Status//"not-configured"),
    status:.State.Status,running:.State.Running,restartCount:.RestartCount,startedAt:.State.StartedAt
  }' <<<"$inspect")
  service_rows=$(jq -c --arg service "$service" --arg runtimeUid "$runtime_uid" --arg runtimeGid "$runtime_gid" --argjson metadata "$metadata" \
    '. + [{service:$service,runtimeUid:$runtimeUid,runtimeGid:$runtimeGid,metadata:$metadata}]' <<<"$service_rows")
  if [[ "$service" == postgres && $(jq -r '.[0].State.Running' <<<"$inspect") == true ]]; then
    postgres_data_path=$(jq -r '.[0].Mounts[]?|select(.Destination=="/var/lib/postgresql/data")|.Source' <<<"$inspect" | head -n1)
  fi
done <<<"$containers_before"
dependencies=$(jq '[.[] as $service | $service.metadata.networks[]? | {network:.,service:$service.service}] | group_by(.network) | map({network:.[0].network,services:(map(.service)|sort)})' <<<"$service_rows")

scraper='{"observable":false,"reason":"max-web-scraper service not running"}'
scraper_id=$(docker_read compose -p "$PROJECT" -f "$COMPOSE_FILE" ps -q max-web-scraper 2>/dev/null || true)
if [[ -n "$scraper_id" ]]; then
  process_rows=$(docker_read top "$scraper_id" -eo uid,gid,comm 2>/dev/null | tail -n +2 || true)
  node_count=$(awk '$3=="node" || $3=="tini"{count++} END{print count+0}' <<<"$process_rows")
  browser_count=$(awk 'tolower($3) ~ /^(chromium|chrome|chrome_crashpad|headless_shell)$/{count++} END{print count+0}' <<<"$process_rows")
  profile_mount=$(docker_read inspect "$scraper_id" | jq '.[0].Mounts | map(select(.Destination=="/app/user_data" or .Destination=="/app/userData")|{type:.Type,name:(.Name//null),source:.Source,destination:.Destination,readWrite:.RW})')
  scraper=$(jq -nc --argjson nodeCount "$node_count" --argjson browserCount "$browser_count" --argjson profileMount "$profile_mount" \
    '{observable:true,nodeOrTiniProcessCount:$nodeCount,browserProcessCount:$browserCount,profileMount:$profileMount,listenerOwnership:{observable:false,status:"NOT_EXECUTED",reason:"listener inspection could expose browser/profile details"}}')
fi

database='{"observable":false,"reason":"postgres service not running or bounded read-only psql unavailable","queriesNotExecuted":["exact MaxRawTransportEvent count","duplicate full scan","exact NULL full scans","EXPLAIN ANALYZE"],"queryRisk":"full-table scans excluded"}'
postgres_id=$(docker_read compose -p "$PROJECT" -f "$COMPOSE_FILE" ps -q postgres 2>/dev/null || true)
migration_ledger_hash_before='unavailable'
migration_ledger_hash_after='unavailable'
database_size_bytes=0
raw_total_bytes=0
raw_table_present=false
capture_index_present=false
capture_unique_index_present=false

if [[ -n "$postgres_id" ]]; then
  psql_query() {
    local sql=$1
    # shellcheck disable=SC2016 # POSTGRES_* and positional arguments expand only inside the container shell.
    timeout --signal=TERM --kill-after=2 "$COMMAND_TIMEOUT_SECONDS" docker exec "$postgres_id" sh -ceu '
      export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=$2 -c lock_timeout=$3"
      exec psql --no-psqlrc -v ON_ERROR_STOP=1 -X -A -t --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "$1"
    ' sh "$sql" "$DB_STATEMENT_TIMEOUT_MS" "$DB_LOCK_TIMEOUT_MS" 2>/dev/null
  }

  db_name=$(psql_query 'SELECT current_database()')
  server_version=$(psql_query 'SHOW server_version')
  server_version_num=$(psql_query "SELECT current_setting('server_version_num')")
  persistent_lock_timeout=$(psql_query "SELECT setting||unit FROM pg_settings WHERE name='lock_timeout'")
  persistent_statement_timeout=$(psql_query "SELECT setting||unit FROM pg_settings WHERE name='statement_timeout'")
  maintenance_work_mem=$(psql_query "SELECT setting||unit FROM pg_settings WHERE name='maintenance_work_mem'")
  database_size_bytes=$(psql_query 'SELECT pg_database_size(current_database())')
  migration_present=$(psql_query "SELECT to_regclass('public.\"_prisma_migrations\"') IS NOT NULL")
  if [[ "$migration_present" == t ]]; then
    migration_total=$(psql_query 'SELECT count(*) FROM "_prisma_migrations"')
    migration_finished=$(psql_query 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
    migration_failed=$(psql_query 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL')
    applied_migrations=$(psql_query "SELECT COALESCE(json_agg(migration_name ORDER BY started_at)::text,'[]') FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
    failed_migrations=$(psql_query "SELECT COALESCE(json_agg(migration_name ORDER BY started_at)::text,'[]') FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")
  else
    migration_total=0; migration_finished=0; migration_failed=0; applied_migrations='[]'; failed_migrations='[]'
  fi
  jq -e 'type=="array"' <<<"$applied_migrations" >/dev/null
  jq -e 'type=="array"' <<<"$failed_migrations" >/dev/null
  migration_ledger_hash_before=$(printf '%s' "$applied_migrations" | hash_text)
  expected_migrations=$(find "$RELEASE_ROOT/gravity-mvp/prisma/migrations" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | jq -R . | jq -s .)
  pending_migrations=$(jq -nc --argjson expected "$expected_migrations" --argjson applied "$applied_migrations" '$expected-$applied')

  raw_present=$(psql_query "SELECT to_regclass('public.\"MaxRawTransportEvent\"') IS NOT NULL")
  if [[ "$raw_present" == t ]]; then
    raw_table_present=true
    raw_estimated_rows=$(psql_query "SELECT GREATEST(reltuples,0)::bigint FROM pg_class WHERE oid='public.\"MaxRawTransportEvent\"'::regclass")
    raw_total_bytes=$(psql_query "SELECT pg_total_relation_size('public.\"MaxRawTransportEvent\"')")
    raw_table_bytes=$(psql_query "SELECT pg_relation_size('public.\"MaxRawTransportEvent\"')")
    raw_index_bytes=$(psql_query "SELECT pg_indexes_size('public.\"MaxRawTransportEvent\"')")
    indexes=$(psql_query "SELECT COALESCE(json_agg(json_build_object('name',indexrelid::regclass::text,'bytes',pg_relation_size(indexrelid)) ORDER BY indexrelid::regclass::text)::text,'[]') FROM pg_index WHERE indrelid='public.\"MaxRawTransportEvent\"'::regclass")
    constraints=$(psql_query "SELECT COALESCE(json_agg(conname ORDER BY conname)::text,'[]') FROM pg_constraint WHERE conrelid='public.\"MaxRawTransportEvent\"'::regclass")
    null_fractions=$(psql_query "SELECT COALESCE(json_agg(json_build_object('column',attname,'nullFraction',null_frac) ORDER BY attname)::text,'[]') FROM pg_stats WHERE schemaname='public' AND tablename='MaxRawTransportEvent' AND attname IN ('accountId','captureEnvelopeId')")
    capture_column=$(psql_query "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='MaxRawTransportEvent' AND column_name='captureEnvelopeId')")
    capture_index=$(psql_query "SELECT to_regclass('public.\"MaxRawTransportEvent_accountId_captureEnvelopeId_idx\"') IS NOT NULL")
    capture_unique_index=$(psql_query "SELECT to_regclass('public.\"MaxRawTransportEvent_accountId_captureEnvelopeId_key\"') IS NOT NULL")
    [[ "$capture_index" == t ]] && capture_index_present=true
    [[ "$capture_unique_index" == t ]] && capture_unique_index_present=true
    locks=$(psql_query "SELECT COALESCE(json_agg(json_build_object('mode',mode,'granted',granted,'count',count) ORDER BY mode,granted)::text,'[]') FROM (SELECT mode,granted,count(*)::int AS count FROM pg_locks WHERE relation='public.\"MaxRawTransportEvent\"'::regclass GROUP BY mode,granted) s")
  else
    raw_estimated_rows=0; raw_total_bytes=0; raw_table_bytes=0; raw_index_bytes=0; indexes='[]'; constraints='[]'; null_fractions='[]'; capture_column=f; capture_index=f; capture_unique_index=f; locks='[]'
  fi
  active_sessions=$(psql_query "SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state<>'idle'")
  long_transactions=$(psql_query "SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND xact_start IS NOT NULL AND now()-xact_start>interval '5 minutes'")
  oldest_transaction_seconds=$(psql_query "SELECT COALESCE(EXTRACT(epoch FROM max(now()-xact_start))::bigint,0) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND xact_start IS NOT NULL")
  replication_connections=$(psql_query 'SELECT count(*) FROM pg_stat_replication')
  in_recovery=$(psql_query 'SELECT pg_is_in_recovery()')
  database=$(jq -nc \
    --arg dbName "$db_name" --arg serverVersion "$server_version" --argjson serverVersionNumber "$server_version_num" \
    --arg persistentLockTimeout "$persistent_lock_timeout" --arg persistentStatementTimeout "$persistent_statement_timeout" --arg maintenanceWorkMem "$maintenance_work_mem" \
    --argjson databaseSizeBytes "$database_size_bytes" --arg migrationLedgerPresent "$migration_present" --argjson migrationTotal "$migration_total" \
    --argjson migrationFinished "$migration_finished" --argjson migrationFailed "$migration_failed" --argjson appliedMigrations "$applied_migrations" \
    --argjson failedMigrations "$failed_migrations" --argjson pendingMigrations "$pending_migrations" --arg migrationLedgerHash "$migration_ledger_hash_before" \
    --arg rawTablePresent "$raw_present" --argjson rawEstimatedRows "$raw_estimated_rows" --argjson rawTotalBytes "$raw_total_bytes" \
    --argjson rawTableBytes "$raw_table_bytes" --argjson rawIndexBytes "$raw_index_bytes" --argjson indexes "$indexes" --argjson constraints "$constraints" \
    --argjson nullFractions "$null_fractions" --arg captureEnvelopeColumn "$capture_column" --arg captureEnvelopeIndex "$capture_index" \
    --arg captureEnvelopeUniqueIndex "$capture_unique_index" --argjson locks "$locks" --argjson activeSessions "$active_sessions" \
    --argjson longTransactions "$long_transactions" --argjson oldestTransactionSeconds "$oldest_transaction_seconds" \
    --argjson replicationConnections "$replication_connections" --arg inRecovery "$in_recovery" \
    '{observable:true,databaseName:$dbName,serverVersion:$serverVersion,serverVersionNumber:$serverVersionNumber,databaseSizeBytes:$databaseSizeBytes,
      persistentSettings:{lockTimeout:$persistentLockTimeout,statementTimeout:$persistentStatementTimeout,maintenanceWorkMem:$maintenanceWorkMem},
      probeSessionBounds:{defaultTransactionReadOnly:true,statementTimeoutMs:'"$DB_STATEMENT_TIMEOUT_MS"',lockTimeoutMs:'"$DB_LOCK_TIMEOUT_MS"'},
      migration:{ledgerPresent:($migrationLedgerPresent=="t"),total:$migrationTotal,finished:$migrationFinished,failed:$migrationFailed,applied:$appliedMigrations,failedNames:$failedMigrations,pending:$pendingMigrations,ledgerHash:$migrationLedgerHash},
      rawTable:{name:"MaxRawTransportEvent",present:($rawTablePresent=="t"),exactRowCount:{status:"NOT_EXECUTED",reason:"unbounded full-table count excluded"},estimatedRows:$rawEstimatedRows,totalBytes:$rawTotalBytes,tableBytes:$rawTableBytes,indexBytes:$rawIndexBytes,indexes:$indexes,constraints:$constraints,nullFractionsFromStatistics:$nullFractions,captureEnvelopeIdColumnPresent:($captureEnvelopeColumn=="t"),indexCollisions:{ordinary:($captureEnvelopeIndex=="t"),unique:($captureEnvelopeUniqueIndex=="t")},constraintCollisionNames:$constraints,duplicateCount:{status:"NOT_EXECUTED",reason:"full-table group scan requires an approved maintenance window"},exactNullCounts:{status:"NOT_EXECUTED",reason:"full-table scans excluded"},locks:$locks},
      activity:{activeSessions:$activeSessions,longTransactionsOverFiveMinutes:$longTransactions,oldestTransactionSeconds:$oldestTransactionSeconds},
      replication:{connections:$replicationConnections,inRecovery:($inRecovery=="t")},
      queriesNotExecuted:["exact MaxRawTransportEvent count","duplicate full scan","exact NULL full scans","EXPLAIN ANALYZE"]}')
fi

gateway_image=$(image_fact "$GATEWAY_IMAGE" "$GATEWAY_COMPRESSED_BYTES")
scraper_image=$(image_fact "$SCRAPER_IMAGE" "$SCRAPER_COMPRESSED_BYTES")
missing_compressed_bytes=0
[[ $(jq -r '.presentLocally' <<<"$gateway_image") == true ]] || missing_compressed_bytes=$((missing_compressed_bytes + GATEWAY_COMPRESSED_BYTES))
[[ $(jq -r '.presentLocally' <<<"$scraper_image") == true ]] || missing_compressed_bytes=$((missing_compressed_bytes + SCRAPER_COMPRESSED_BYTES))
pull_unpack_min_bytes=$((missing_compressed_bytes * 3))
pull_unpack_max_bytes=$((missing_compressed_bytes * 5))
backup_estimate_bytes=$(((database_size_bytes * 125 + 99) / 100))
migration_temp_estimate_bytes=0
if [[ "$raw_table_present" == true && ( "$capture_index_present" == false || "$capture_unique_index_present" == false ) ]]; then
  migration_temp_estimate_bytes=$((raw_total_bytes * 2))
fi
root_total_bytes=$(jq -r '.totalBytes' <<<"$disk_before")
root_available_bytes=$(jq -r '.availableBytes' <<<"$disk_before")
reserve_bytes=$((root_total_bytes / 10))
(( reserve_bytes >= 5368709120 )) || reserve_bytes=5368709120
required_min_bytes=$((pull_unpack_min_bytes + backup_estimate_bytes + migration_temp_estimate_bytes + reserve_bytes))
required_max_bytes=$((pull_unpack_max_bytes + backup_estimate_bytes + migration_temp_estimate_bytes + reserve_bytes))
projected_min_remaining=$((root_available_bytes - required_max_bytes))
disk_verdict='INCOMPLETE_REQUIRED_DB_FACTS'
if [[ $(jq -r '.observable' <<<"$database") == true ]]; then
  if (( root_available_bytes >= required_max_bytes )); then disk_verdict='SUFFICIENT_CONSERVATIVE_BUDGET'; else disk_verdict='INSUFFICIENT_CONSERVATIVE_BUDGET'; fi
fi

disk='[]'
for path in /opt/crm "$docker_root" "$postgres_data_path" "$RELEASE_ROOT/release/personal-max-stage8b1r"; do
  [[ -n "$path" ]] || continue
  row=$(disk_row "$path")
  disk=$(jq -c --argjson row "$row" '. + [$row]' <<<"$disk")
done

backup_candidates='[]'
for backup_dir in /opt/crm/backups /opt/backups /var/backups; do
  [[ -d "$backup_dir" ]] || continue
  latest=$(timeout 5 find "$backup_dir" -maxdepth 2 -type f -printf '%T@|%s|%p\n' 2>/dev/null | sort -nr | head -n1 || true)
  [[ -n "$latest" ]] || continue
  mtime_epoch=${latest%%|*}; remainder=${latest#*|}; backup_size=${remainder%%|*}; backup_path=${remainder#*|}
  row=$(jq -nc --arg path "$backup_path" --arg mtimeEpoch "$mtime_epoch" --argjson sizeBytes "$backup_size" '{path:$path,mtimeEpoch:$mtimeEpoch,sizeBytes:$sizeBytes,contentInspected:false}')
  backup_candidates=$(jq -c --argjson row "$row" '. + [$row]' <<<"$backup_candidates")
done
backup=$(jq -nc --argjson candidates "$backup_candidates" --argjson requiredNewBackupBytes "$backup_estimate_bytes" \
  '{mechanism:{status:"NOT_PROVEN",reason:"only bounded backup-file metadata was inspected"},latestCandidates:$candidates,restoreEvidence:{status:"NOT_PROVEN"},requiredNewBackupBytes:$requiredNewBackupBytes,includesTargetTables:{status:"NOT_PROVEN"},configStateBackup:{status:"NOT_PROVEN",reason:"secret-bearing configuration content was not inspected"}}')

containers_after=$(snapshot_containers)
services_after=$(snapshot_services)
volumes_after=$(snapshot_volumes)
containers_after_hash=$(printf '%s\n' "$containers_after" | hash_text)
services_after_hash=$(printf '%s\n' "$services_after" | hash_text)
volumes_after_hash=$(printf '%s\n' "$volumes_after" | hash_text)
disk_after=$(disk_row /opt/crm)
if [[ $(jq -r '.observable' <<<"$database") == true ]]; then
  if [[ "$migration_present" == t ]]; then
    migration_ledger_hash_after=$(psql_query "SELECT COALESCE(json_agg(migration_name ORDER BY started_at)::text,'[]') FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL" | hash_text)
  else
    migration_ledger_hash_after=$(printf '[]' | hash_text)
  fi
fi

unexpected_changes=false
[[ "$containers_before_hash" == "$containers_after_hash" ]] || unexpected_changes=true
[[ "$services_before_hash" == "$services_after_hash" ]] || unexpected_changes=true
[[ "$volumes_before_hash" == "$volumes_after_hash" ]] || unexpected_changes=true
[[ "$migration_ledger_hash_before" == "$migration_ledger_hash_after" ]] || unexpected_changes=true
existing_relevant_image_bytes=$(jq -n --argjson gateway "$gateway_image" --argjson scraper "$scraper_image" '[($gateway.localUnpackedBytes//0),($scraper.localUnpackedBytes//0)]|add')
root_gate_complete=false
if [[ $(jq -r '.observable' <<<"$database") == true && $(jq 'length' <<<"$service_rows") -gt 0 && "$disk_verdict" != INCOMPLETE_REQUIRED_DB_FACTS ]]; then
  root_gate_complete=true
fi

jq -n \
  --arg scriptSha256 "$ACTUAL_SHA256" --arg resultPath "$RESULT_PATH" --arg composeFile "$COMPOSE_FILE" --arg project "$PROJECT" \
  --arg osId "$os_id" --arg osVersion "$os_version" --arg kernel "$kernel" --arg architecture "$architecture" \
  --arg dockerVersion "$docker_server_version" --arg composeVersion "$docker_compose_version" --arg dockerRoot "$docker_root" --arg dockerDriver "$docker_driver" \
  --argjson dockerRuntimes "$docker_runtime" --argjson services "$service_rows" --argjson dependencies "$dependencies" --argjson scraper "$scraper" --argjson database "$database" \
  --argjson gatewayImage "$gateway_image" --argjson scraperImage "$scraper_image" --argjson disk "$disk" --argjson backup "$backup" \
  --argjson existingRelevantImageBytes "$existing_relevant_image_bytes" --argjson missingCompressedBytes "$missing_compressed_bytes" --argjson pullUnpackMinBytes "$pull_unpack_min_bytes" --argjson pullUnpackMaxBytes "$pull_unpack_max_bytes" \
  --argjson backupEstimateBytes "$backup_estimate_bytes" --argjson migrationTempEstimateBytes "$migration_temp_estimate_bytes" --argjson reserveBytes "$reserve_bytes" \
  --argjson requiredMinBytes "$required_min_bytes" --argjson requiredMaxBytes "$required_max_bytes" --argjson projectedMinRemaining "$projected_min_remaining" --arg diskVerdict "$disk_verdict" \
  --arg containersBeforeHash "$containers_before_hash" --arg servicesBeforeHash "$services_before_hash" --arg volumesBeforeHash "$volumes_before_hash" \
  --arg containersAfterHash "$containers_after_hash" --arg servicesAfterHash "$services_after_hash" --arg volumesAfterHash "$volumes_after_hash" \
  --arg migrationLedgerHashBefore "$migration_ledger_hash_before" --arg migrationLedgerHashAfter "$migration_ledger_hash_after" \
  --argjson diskBefore "$disk_before" --argjson diskAfter "$disk_after" --arg unexpectedChanges "$unexpected_changes" --arg rootGateComplete "$root_gate_complete" \
  '{schemaVersion:2,mode:"READ_ONLY_PRODUCTION_PREFLIGHT",generatedAt:(now|todate),script:{sha256:$scriptSha256,checksumBound:true,resultPath:$resultPath},
    host:{os:{id:$osId,version:$osVersion},kernel:$kernel,architecture:$architecture,docker:{serverVersion:$dockerVersion,composeVersion:$composeVersion,dataRoot:$dockerRoot,storageDriver:$dockerDriver,runtimes:$dockerRuntimes}},
    production:{composeFile:$composeFile,project:$project,services:$services,dependenciesByNetwork:$dependencies,scraper:$scraper,environment:{valuesInspected:false,namesInspected:false,reason:"docker environment omitted to prevent value exposure"}},
    acceptedImages:{gateway:$gatewayImage,scraper:$scraperImage,registryManifestProvenance:"immutable digest manifests observed without pull on 2026-07-28"},database:$database,
    storage:{filesystems:$disk,budget:{existingRelevantImageBytes:$existingRelevantImageBytes,missingCompressedImageBytes:$missingCompressedBytes,pullAndUnpackEstimateBytes:{minimum:$pullUnpackMinBytes,conservativeMaximum:$pullUnpackMaxBytes,method:"3x to 5x immutable compressed layer bytes"},backupEstimateBytes:$backupEstimateBytes,migrationTemporaryEstimateBytes:$migrationTempEstimateBytes,minimumRollbackOperationalReserveBytes:$reserveBytes,requiredBytes:{minimum:$requiredMinBytes,conservativeMaximum:$requiredMaxBytes},projectedRemainingAtConservativeMaximum:$projectedMinRemaining,verdict:$diskVerdict}},backup:$backup,
    immutability:{before:{containerIdsHash:$containersBeforeHash,serviceStatesHash:$servicesBeforeHash,volumesHash:$volumesBeforeHash,migrationLedgerHash:$migrationLedgerHashBefore,disk:$diskBefore},after:{containerIdsHash:$containersAfterHash,serviceStatesHash:$servicesAfterHash,volumesHash:$volumesAfterHash,migrationLedgerHash:$migrationLedgerHashAfter,disk:$diskAfter},unexpectedChanges:($unexpectedChanges=="true")},
    gate:{complete:($rootGateComplete=="true"),reason:(if $rootGateComplete=="true" then "mandatory root facts collected" else "mandatory production database or runtime facts incomplete" end)},
    safety:{defaultTransactionReadOnly:true,boundedCommands:true,fullTableScans:false,ddl:false,dml:false,migrations:false,locksRequested:false,containersCreated:false,containersRestarted:false,imagesPulled:false,cleanup:false,browserLaunched:false,maxContacted:false,providerAction:false,secretsPrinted:false,environmentValuesRead:false,messageContentRead:false,profileContentRead:false,productionFilesWritten:false,sanitizedReportWritten:true,transientDockerExecProcesses:true,dockerExecPurpose:"bounded read-only PostgreSQL catalog queries",filesystemReadsMayUpdateAtimeAccordingToMountPolicy:true,hostAndDatabaseReadsMayWarmCaches:true,externalNetworkUsed:false}}' >"$TMP_RESULT"
jq -e '.safety.secretsPrinted==false and .safety.ddl==false and .safety.dml==false' "$TMP_RESULT" >/dev/null || {
  echo 'SAFETY_CONDITION_FAILED: sanitized report validation failed' >&2
  exit 81
}
chgrp codexbot "$TMP_RESULT"
chmod 0640 "$TMP_RESULT"
tmp_identity=$(stat -Lc '%d:%i' "$TMP_RESULT")
if [[ ! -f "$TMP_RESULT" || -L "$TMP_RESULT" || $(stat -Lc '%U:%G:%a' "$TMP_RESULT") != root:codexbot:640 ]]; then
  echo 'TEMP_RESULT_HANDOFF_UNSAFE: expected a regular root:codexbot mode 0640 file' >&2
  exit 85
fi
mv --no-clobber --no-target-directory -- "$TMP_RESULT" "$RESULT_PATH"
if [[ -e "$TMP_RESULT" || -L "$TMP_RESULT" ]]; then
  echo 'RESULT_PATH_RACE_DETECTED: final path appeared before atomic move; existing path was not changed' >&2
  exit 86
fi
trap - EXIT
if [[ ! -f "$RESULT_PATH" || -L "$RESULT_PATH" || $(stat -Lc '%d:%i' "$RESULT_PATH") != "$tmp_identity" || $(stat -Lc '%U:%G:%a' "$RESULT_PATH") != root:codexbot:640 ]]; then
  echo 'FINAL_RESULT_HANDOFF_UNSAFE: expected the atomically moved regular root:codexbot mode 0640 file' >&2
  exit 87
fi
if ! timeout 5 runuser -u codexbot -- test -r "$RESULT_PATH"; then
  echo 'CODEXBOT_READABILITY_FAILED: sanitized report is not readable by codexbot' >&2
  exit 88
fi
if timeout 5 runuser -u codexbot -- test -w "$RESULT_PATH"; then
  echo 'CODEXBOT_WRITABILITY_FAILED: sanitized report must not be writable by codexbot' >&2
  exit 89
fi
printf 'SANITIZED_RESULT_PATH=%s\nSANITIZED_RESULT_SHA256=%s\nRESULT_OWNER=root\nRESULT_GROUP=codexbot\nRESULT_MODE=0640\nCODEXBOT_READABLE=YES\nCODEXBOT_WRITABLE=NO\n' \
  "$RESULT_PATH" "$(sha256sum -- "$RESULT_PATH" | awk '{print $1}')"
if [[ "$unexpected_changes" == true ]]; then
  echo 'PRODUCTION_DRIFT_DETECTED: inspect the sanitized report; no automatic remediation was attempted' >&2
  exit 82
fi
if [[ "$root_gate_complete" != true ]]; then
  echo 'MANDATORY_FACTS_INCOMPLETE: inspect the sanitized report' >&2
  exit 83
fi
