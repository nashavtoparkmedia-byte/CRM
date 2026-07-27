#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

COMPOSE_FILE='/opt/crm/deploy/docker-compose.production.yml'
PROJECT='crm'

if [[ $(id -u) -ne 0 ]]; then
  echo 'ROOT_REQUIRED: this probe is read-only but must inspect production Docker metadata' >&2
  exit 77
fi
for command in docker jq df; do command -v "$command" >/dev/null; done
test -r "$COMPOSE_FILE"
docker compose version >/dev/null

mapfile -t running_services < <(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" ps --services --status running | sort)
container_ids=()
service_rows='[]'
for service in "${running_services[@]}"; do
  id=$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" ps -q "$service")
  test -n "$id"
  container_ids+=("$id")
  image_id=$(docker inspect --format '{{.Image}}' "$id")
  repo_digests=$(docker image inspect "$image_id" | jq '.[0].RepoDigests // [] | sort')
  inspect=$(docker inspect "$id" | jq --argjson repoDigests "$repo_digests" '.[0] | {
    id:.Id,
    name:(.Name|ltrimstr("/")),
    imageId:.Image,
    repoDigests:$repoDigests,
    configuredImage:.Config.Image,
    configuredUser:(.Config.User//""),
    mounts:[.Mounts[]|{type:.Type,name:(.Name//null),source:.Source,destination:.Destination,readWrite:.RW}],
    networks:(.NetworkSettings.Networks|keys|sort),
    restartPolicy:.HostConfig.RestartPolicy.Name,
    health:(.State.Health.Status//"not-configured"),
    running:.State.Running
  }')
  uid=$(docker exec "$id" id -u 2>/dev/null || printf 'unavailable')
  gid=$(docker exec "$id" id -g 2>/dev/null || printf 'unavailable')
  service_rows=$(jq -c --arg service "$service" --arg uid "$uid" --arg gid "$gid" --argjson inspect "$inspect" \
    '. + [{service:$service,runtimeUid:$uid,runtimeGid:$gid,metadata:$inspect}]' <<<"$service_rows")
done

scraper_processes='{"observable":false,"reason":"max-web-scraper service not running"}'
scraper_id=$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" ps -q max-web-scraper 2>/dev/null || true)
if [[ -n "$scraper_id" ]]; then
  process_names=$(docker top "$scraper_id" -eo comm 2>/dev/null | tail -n +2 || true)
  node_count=$(grep -Ec '^(node|tini)$' <<<"$process_names" || true)
  browser_count=$(grep -Eic '^(chromium|chrome|chrome_crashpad|headless_shell)$' <<<"$process_names" || true)
  profile_mount=$(docker inspect "$scraper_id" | jq '.[0].Mounts | map(select(.Destination=="/app/user_data" or .Destination=="/app/userData")|{type:.Type,name:(.Name//null),source:.Source,destination:.Destination,readWrite:.RW})')
  scraper_processes=$(jq -nc --argjson nodeCount "$node_count" --argjson browserCount "$browser_count" --argjson profileMount "$profile_mount" \
    '{observable:true,nodeOrTiniProcessCount:$nodeCount,browserProcessCount:$browserCount,profileMount:$profileMount,listenerOwnership:{observable:false,reason:"Docker process metadata cannot prove CDP listener cardinality without inspecting message/profile content"}}')
fi

database='{"observable":false,"reason":"postgres service not running or safe psql query unavailable","duplicatePrecheck":{"executed":false,"status":"PENDING_APPROVED_MIGRATION_WINDOW","reason":"Potential full-table duplicate scan is intentionally excluded from this metadata-only probe"}}'
postgres_id=$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" ps -q postgres 2>/dev/null || true)
if [[ -n "$postgres_id" ]]; then
  server_version_num='' lock_timeout='' statement_timeout='' migration_present='' migration_total='' migration_finished='' migration_failed=''
  raw_present='' raw_rows='' raw_bytes='' capture_envelope_column='' capture_envelope_index='' capture_envelope_unique_index=''
  set +e
  db_result=$(docker exec "$postgres_id" sh -ceu '
    export PGOPTIONS="-c default_transaction_read_only=on"
    psql_safe() { psql --no-psqlrc -v ON_ERROR_STOP=1 -X -A -t --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" "$@"; }
    server_version_num=$(psql_safe -c "SELECT current_setting('\''server_version_num'\'')")
    lock_timeout=$(psql_safe -c "SELECT current_setting('\''lock_timeout'\'')")
    statement_timeout=$(psql_safe -c "SELECT current_setting('\''statement_timeout'\'')")
    migration_present=$(psql_safe -c "SELECT to_regclass('\''public.\"_prisma_migrations\"'\'') IS NOT NULL")
    if [ "$migration_present" = t ]; then
      migration_total=$(psql_safe -c "SELECT count(*) FROM \"_prisma_migrations\"")
      migration_finished=$(psql_safe -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")
      migration_failed=$(psql_safe -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL")
    else migration_total=0; migration_finished=0; migration_failed=0; fi
    raw_present=$(psql_safe -c "SELECT to_regclass('\''public.\"MaxRawTransportEvent\"'\'') IS NOT NULL")
    if [ "$raw_present" = t ]; then
      raw_rows=$(psql_safe -c "SELECT count(*) FROM \"MaxRawTransportEvent\"")
      raw_bytes=$(psql_safe -c "SELECT pg_total_relation_size('\''public.\"MaxRawTransportEvent\"'\'')")
      capture_envelope_column=$(psql_safe -c "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='\''public'\'' AND table_name='\''MaxRawTransportEvent'\'' AND column_name='\''captureEnvelopeId'\'')")
      capture_envelope_index=$(psql_safe -c "SELECT to_regclass('\''public.\"MaxRawTransportEvent_accountId_captureEnvelopeId_idx\"'\'') IS NOT NULL")
      capture_envelope_unique_index=$(psql_safe -c "SELECT to_regclass('\''public.\"MaxRawTransportEvent_accountId_captureEnvelopeId_key\"'\'') IS NOT NULL")
    else raw_rows=0; raw_bytes=0; capture_envelope_column=f; capture_envelope_index=f; capture_envelope_unique_index=f; fi
    printf "%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n" "$server_version_num" "$lock_timeout" "$statement_timeout" "$migration_present" "$migration_total" "$migration_finished" "$migration_failed" "$raw_present" "$raw_rows" "$raw_bytes" "$capture_envelope_column" "$capture_envelope_index" "$capture_envelope_unique_index"
  ' 2>/dev/null)
  db_code=$?
  set -e
  if [[ $db_code -eq 0 && "$db_result" != *$'\n'* && $(awk -F'|' '{print NF}' <<<"$db_result") -eq 13 ]]; then
    IFS='|' read -r server_version_num lock_timeout statement_timeout migration_present migration_total migration_finished migration_failed raw_present raw_rows raw_bytes capture_envelope_column capture_envelope_index capture_envelope_unique_index <<<"$db_result"
  fi
  if [[ $db_code -eq 0 && "$server_version_num" =~ ^[0-9]+$ && "$migration_present" =~ ^(t|f)$ && "$migration_total" =~ ^[0-9]+$ && "$migration_finished" =~ ^[0-9]+$ && "$migration_failed" =~ ^[0-9]+$ && "$raw_present" =~ ^(t|f)$ && "$raw_rows" =~ ^[0-9]+$ && "$raw_bytes" =~ ^[0-9]+$ && "$capture_envelope_column" =~ ^(t|f)$ && "$capture_envelope_index" =~ ^(t|f)$ && "$capture_envelope_unique_index" =~ ^(t|f)$ ]]; then
    database=$(jq -nc \
      --argjson serverVersionNumber "$server_version_num" --arg lockTimeout "$lock_timeout" --arg statementTimeout "$statement_timeout" \
      --arg migrationLedgerPresent "$migration_present" --argjson migrationTotal "$migration_total" \
      --argjson migrationFinished "$migration_finished" --argjson migrationFailed "$migration_failed" \
      --arg rawTablePresent "$raw_present" --argjson rawRows "$raw_rows" --argjson rawBytes "$raw_bytes" \
      --arg captureEnvelopeColumn "$capture_envelope_column" --arg captureEnvelopeIndex "$capture_envelope_index" --arg captureEnvelopeUniqueIndex "$capture_envelope_unique_index" \
      '{observable:true,serverVersionNumber:$serverVersionNumber,sessionTimeouts:{lockTimeout:$lockTimeout,statementTimeout:$statementTimeout},migrationLedgerPresent:($migrationLedgerPresent=="t"),migrationTotal:$migrationTotal,migrationFinished:$migrationFinished,migrationFailed:$migrationFailed,rawTablePresent:($rawTablePresent=="t"),rawRows:$rawRows,rawTotalBytes:$rawBytes,captureEnvelopeIdColumnPresent:($captureEnvelopeColumn=="t"),indexes:{accountCaptureEnvelope:($captureEnvelopeIndex=="t"),accountCaptureEnvelopeUnique:($captureEnvelopeUniqueIndex=="t")},duplicatePrecheck:{executed:false,status:"PENDING_APPROVED_MIGRATION_WINDOW",reason:"Potential full-table duplicate scan is intentionally excluded from this metadata-only probe"}}')
  fi
fi

disk='[]'
for path in /var/lib/docker /var/lib/crm /opt/crm; do
  if [[ -e "$path" ]]; then
    row=$(df -Pk "$path" | awk -v path="$path" 'NR==2{printf "{\"path\":\"%s\",\"availableKiB\":%s,\"capacity\":\"%s\"}",path,$4,$5}')
    disk=$(jq -c --argjson row "$row" '. + [$row]' <<<"$disk")
  fi
done

jq -n \
  --arg schemaVersion '1' --arg composeFile "$COMPOSE_FILE" --arg project "$PROJECT" \
  --argjson services "$service_rows" --argjson scraperProcesses "$scraper_processes" \
  --argjson database "$database" --argjson disk "$disk" \
  '{schemaVersion:($schemaVersion|tonumber),mode:"READ_ONLY_PRODUCTION_METADATA",composeFile:$composeFile,project:$project,services:$services,scraper:$scraperProcesses,database:$database,disk:$disk,redaction:{environmentValuesPrinted:false,secretsPrinted:false,messageContentRead:false,chromiumProfileContentRead:false},mutations:{containers:false,images:false,networks:false,volumes:false,files:false,ownership:false,permissions:false,migrations:false}}'
