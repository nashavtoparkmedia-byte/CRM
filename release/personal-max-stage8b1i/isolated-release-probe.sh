#!/usr/bin/env bash
# shellcheck disable=SC1091,SC2016,SC2034,SC2154
set -Eeuo pipefail
umask 077

readonly EXPECTED_PACKAGE_ROOT='/opt/codex-work/crm-personal-max-stage8b1r-release-hardening-20260727T220905Z/release/personal-max-stage8b1i'
readonly SUCCESS_REPORT='/var/tmp/personal-max-stage8b1i-isolated-release-proof.json'
readonly BACKUP_REPORT='/var/tmp/personal-max-stage8b1s-production-backup.json'
readonly BACKUP_REPORT_SHA256='f9b29d5fbe69b9a87d402bab3a19a1079797640549078b17a6ba8e7280415566'
readonly PREFLIGHT_REPORT='/var/tmp/personal-max-stage8b1r-production-readonly-preflight.json'
readonly PREFLIGHT_REPORT_SHA256='d6a6e4764c90a6f64af9c11b2b0c4eeb08b82c377b58990f939bd559688ac63b'
readonly DUMP_PATH='/var/backups/personal-max-stage8b1s-production-backup/database.dump'
readonly DUMP_SHA256='c76bda794cc053d32a42f41209d55252d90d02d3806f45c5b16a275544262a3f'
readonly DUMP_BYTES=45284314
readonly DUMP_OBJECTS=581
readonly GATEWAY_IMAGE='ghcr.io/nashavtoparkmedia-byte/crm-max-personal-gateway@sha256:dd718fd8e9e2ec52a0ee1c19b576d75a1035f9e251980351ebc04071dfe5d0de'
readonly SCRAPER_IMAGE='ghcr.io/nashavtoparkmedia-byte/crm-max-web-scraper@sha256:abf4405f55ab1c84f319b00cdb8b561f76353001ba2543045fddb17dc6b46768'
readonly POSTGRES_IMAGE='sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229'
readonly GATEWAY_DIGEST='sha256:dd718fd8e9e2ec52a0ee1c19b576d75a1035f9e251980351ebc04071dfe5d0de'
readonly SCRAPER_DIGEST='sha256:abf4405f55ab1c84f319b00cdb8b561f76353001ba2543045fddb17dc6b46768'
readonly POSTGRES_DIGEST='sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229'
readonly POSTGRES_VERSION='16.14'
readonly REQUIRED_FREE_BYTES=12500000000
readonly IMAGE_EXPANSION_BYTES=4323469515
readonly PROBE_BUDGET_BYTES=2172240240
readonly CLEANUP_RESERVE_BYTES=5368709120
readonly ATTESTED_PRODUCTION_LEDGER_SHA256='3b77a5c161cbd9850ce3d45b38c2b0e5cc110d97b13f8b506e7723459766a4c3'
readonly PRODUCTION_PROJECT_LABEL='com.docker.compose.project=crm'
readonly STAGE_LABEL='personal-max.stage=8b1i'
readonly RUN_LABEL_KEY='personal-max.run-id'
readonly EXPECTED_MIGRATIONS=(
  20260726162043_add_max_raw_transport_journal
  20260726190658_add_max_route_registry
  20260726205437_add_max_inbound_normalization
  20260726215715_add_max_per_chat_outbound_actor
  20260726225737_add_max_dispatch_ledger
  20260727053744_add_max_provider_confirmation_matcher
  20260727141925_add_max_shadow_semantic_comparison
  20260727154647_add_max_capture_ingress
)

PROBE_PHASE='bootstrap_complete'
PROBE_SAFE_COMMAND_CLASS='package_validation'
PM_SCRIPT_SHA256=''
PM_FAILURE_PATH=''
RUN_ID=''
PREFIX=''
TMP=''
TMP_REPORT=''
TMP_AFTER=''
NETWORK=''
PG_VOLUME=''
SPOOL_VOLUME=''
PG_CONTAINER=''
GATEWAY_CONTAINER=''
DIAGNOSTICS_LOADED=false
CLEANUP_COMPLETED=false
FAILURE_SOURCE_LINE=0
FAILURE_EXIT=0

fail() {
  local status=$1 phase=$2 command_class=$3
  PROBE_PHASE=$phase
  PROBE_SAFE_COMMAND_CLASS=$command_class
  return "$status"
}

sha_of() { sha256sum -- "$1" | awk '{print $1}'; }
hash_lines() { LC_ALL=C sort | sha256sum | awk '{print $1}'; }
uint() { [[ ${1:-} =~ ^[0-9]+$ ]]; }

production_snapshot() {
  local target=$1 ids states restarts volumes networks git_head git_status git_hash free_bytes
  ids=$(docker ps -aq --no-trunc --filter "label=$PRODUCTION_PROJECT_LABEL" | hash_lines)
  states=$(docker ps -aq --no-trunc --filter "label=$PRODUCTION_PROJECT_LABEL" | LC_ALL=C sort | while read -r id; do
    [[ -n $id ]] || continue
    docker inspect --format '{{.Id}}|{{.Name}}|{{.State.Status}}|{{.State.Running}}|{{.RestartCount}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.service"}}' "$id"
  done | hash_lines)
  restarts=$(docker ps -aq --no-trunc --filter "label=$PRODUCTION_PROJECT_LABEL" | LC_ALL=C sort | while read -r id; do
    [[ -n $id ]] || continue
    docker inspect --format '{{.Id}}|{{.RestartCount}}' "$id"
  done | hash_lines)
  volumes=$(docker volume ls -q --filter "label=$PRODUCTION_PROJECT_LABEL" | hash_lines)
  networks=$(docker network ls -q --filter "label=$PRODUCTION_PROJECT_LABEL" | hash_lines)
  git_head=$(GIT_OPTIONAL_LOCKS=0 git -C /opt/crm rev-parse HEAD)
  git_status=$(GIT_OPTIONAL_LOCKS=0 git -C /opt/crm status --porcelain=v2 --untracked-files=all | sha256sum | awk '{print $1}')
  git_hash=$(printf '%s|%s\n' "$git_head" "$git_status" | sha256sum | awk '{print $1}')
  free_bytes=$(df -B1 -P /var/lib/docker | awk 'NR==2{print $4}')
  uint "$free_bytes"
  jq -n --arg containerIdsHash "$ids" --arg serviceStatesHash "$states" --arg restartCountsHash "$restarts" \
    --arg volumeInventoryHash "$volumes" --arg networkInventoryHash "$networks" \
    --arg productionGitHash "$git_hash" --arg productionHead "$git_head" --arg productionStatusHash "$git_status" \
    --arg migrationLedgerAttestedHash "$ATTESTED_PRODUCTION_LEDGER_SHA256" --argjson freeBytes "$free_bytes" \
    '{containerIdsHash:$containerIdsHash,serviceStatesHash:$serviceStatesHash,restartCountsHash:$restartCountsHash,
      volumeInventoryHash:$volumeInventoryHash,networkInventoryHash:$networkInventoryHash,
      productionGitHash:$productionGitHash,productionHead:$productionHead,productionStatusHash:$productionStatusHash,
      migrationLedger:{hash:$migrationLedgerAttestedHash,source:"accepted-preflight-attestation",liveConnection:false},freeBytes:$freeBytes}' >"$target"
}

labelled_ids() {
  docker ps -aq --no-trunc --filter "label=$STAGE_LABEL" --filter "label=$RUN_LABEL_KEY=$RUN_ID"
}

cleanup_docker_objects() {
  local failed=0 objects object
  [[ -n ${RUN_ID:-} ]] || return 0
  PROBE_PHASE='cleanup'
  PROBE_SAFE_COMMAND_CLASS='cleanup'
  objects=$(labelled_ids 2>/dev/null) || failed=1
  for object in $objects; do docker rm -f "$object" >/dev/null 2>&1 || failed=1; done
  objects=$(docker network ls -q --filter "label=$STAGE_LABEL" --filter "label=$RUN_LABEL_KEY=$RUN_ID" 2>/dev/null) || failed=1
  for object in $objects; do docker network rm "$object" >/dev/null 2>&1 || failed=1; done
  objects=$(docker volume ls -q --filter "label=$STAGE_LABEL" --filter "label=$RUN_LABEL_KEY=$RUN_ID" 2>/dev/null) || failed=1
  for object in $objects; do docker volume rm "$object" >/dev/null 2>&1 || failed=1; done
  [[ -z $(labelled_ids 2>/dev/null) ]] || failed=1
  [[ -z $(docker network ls -q --filter "label=$STAGE_LABEL" --filter "label=$RUN_LABEL_KEY=$RUN_ID" 2>/dev/null) ]] || failed=1
  [[ -z $(docker volume ls -q --filter "label=$STAGE_LABEL" --filter "label=$RUN_LABEL_KEY=$RUN_ID" 2>/dev/null) ]] || failed=1
  (( failed == 0 ))
}

cleanup_disposable() {
  local failed=0
  cleanup_docker_objects || failed=1
  if [[ -n ${TMP:-} ]]; then
    case $TMP in /var/tmp/personal-max-stage8b1i."$RUN_ID".*) rm -rf -- "$TMP" || failed=1 ;; *) failed=1 ;; esac
  fi
  if [[ -n ${TMP_REPORT:-} && ( -e ${TMP_REPORT:-} || -L ${TMP_REPORT:-} ) ]]; then
    case $TMP_REPORT in /var/tmp/personal-max-stage8b1i-success.tmp.*) rm -f -- "$TMP_REPORT" || failed=1 ;; *) failed=1 ;; esac
  fi
  if [[ -n ${TMP_AFTER:-} && ( -e ${TMP_AFTER:-} || -L ${TMP_AFTER:-} ) ]]; then
    case $TMP_AFTER in /var/tmp/personal-max-stage8b1i-after.tmp.*) rm -f -- "$TMP_AFTER" || failed=1 ;; *) failed=1 ;; esac
  fi
  (( failed == 0 ))
}

on_error() {
  local status=$? line=${1:-0}
  (( status != 0 )) || status=1
  FAILURE_EXIT=$status
  FAILURE_SOURCE_LINE=$line
  exit "$status"
}

on_exit() {
  local status=$? cleanup_ok=false
  trap - ERR EXIT
  set +e
  (( FAILURE_EXIT != 0 )) && status=$FAILURE_EXIT
  cleanup_disposable
  if (( $? == 0 )); then cleanup_ok=true; CLEANUP_COMPLETED=true; else cleanup_ok=false; (( status != 0 )) || status=70; fi
  if (( status != 0 )) && [[ $DIAGNOSTICS_LOADED == true ]]; then
    personal_max_stage8b1i_render_failure "$status" "$FAILURE_SOURCE_LINE" "$cleanup_ok"
    status=$?
  fi
  exit "$status"
}

trap 'on_error $LINENO' ERR
trap on_exit EXIT

[[ $(id -u) -eq 0 ]] || { printf 'ROOT_REQUIRED\n' >&2; exit 77; }
[[ $# -eq 1 && $1 =~ ^[0-9a-f]{64}$ ]] || { printf 'CHECKSUM_ARGUMENT_REQUIRED\n' >&2; exit 64; }
PACKAGE_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly PACKAGE_ROOT
[[ $PACKAGE_ROOT == "$EXPECTED_PACKAGE_ROOT" ]] || { printf 'PACKAGE_PATH_REFUSED\n' >&2; exit 65; }
PM_SCRIPT_SHA256=$(sha_of "$PACKAGE_ROOT/isolated-release-probe.sh")
[[ $PM_SCRIPT_SHA256 == "$1" ]] || { printf 'SCRIPT_CHECKSUM_MISMATCH\n' >&2; exit 66; }
PM_FAILURE_PATH="/var/tmp/personal-max-stage8b1i-isolated-release-proof.failure.${PM_SCRIPT_SHA256}.json"
[[ ! -e $SUCCESS_REPORT && ! -L $SUCCESS_REPORT && ! -e $PM_FAILURE_PATH && ! -L $PM_FAILURE_PATH ]] || {
  printf 'NO_CLOBBER_REPORT_PATH_EXISTS\n' >&2; exit 73;
}
for command in docker jq sha256sum stat realpath df git awk sed grep comm cmp timeout openssl find sort seq runuser; do
  command -v "$command" >/dev/null || { printf 'REQUIRED_COMMAND_MISSING=%s\n' "$command" >&2; exit 69; }
done
(cd "$PACKAGE_ROOT" && sha256sum -c SHA256SUMS >/dev/null)
# shellcheck source=release/personal-max-stage8b1i/failure-diagnostics.sh
source "$PACKAGE_ROOT/failure-diagnostics.sh"
DIAGNOSTICS_LOADED=true

PROBE_PHASE='source_binding'
PROBE_SAFE_COMMAND_CLASS='package_validation'
[[ $(sha_of "$BACKUP_REPORT") == "$BACKUP_REPORT_SHA256" ]]
[[ $(stat -Lc '%U:%G:%a' "$BACKUP_REPORT") == root:codexbot:640 && -f $BACKUP_REPORT && ! -L $BACKUP_REPORT ]]
jq -e --arg dumpSha "$DUMP_SHA256" --argjson dumpBytes "$DUMP_BYTES" --argjson objects "$DUMP_OBJECTS" \
  '.schemaVersion==1 and .mode=="PRODUCTION_BACKUP_METADATA" and .dump.sha256==$dumpSha and
   .dump.bytes==$dumpBytes and .dump.format=="custom" and .dump.noOwner==true and .dump.noAcl==true and
   .dump.objectCount==$objects and .dump.structuralValidation=="PASS" and
   .migrationLedger.total==46 and .migrationLedger.finished==46 and .migrationLedger.failed==0 and
   .migrationLedger.sourceReportMatched==true and .production.containerHashes.before==.production.containerHashes.after and
   .production.restartCount.before==.production.restartCount.after and .restore.FULL_RESTORE_PROOF=="PENDING_ISOLATED_ROOT_PROBE" and
   ([.safety.DockerMutation,.safety.DDL,.safety.DML,.safety.migration,.safety.restart,.safety.deploy,
     .safety.imagePull,.safety.imageLoad,.safety.browserLaunched,.safety.maxContacted,.safety.providerAction]|all(.==false))' "$BACKUP_REPORT" >/dev/null
[[ $(sha_of "$PREFLIGHT_REPORT") == "$PREFLIGHT_REPORT_SHA256" ]]
[[ -f $DUMP_PATH && ! -L $DUMP_PATH && $(stat -Lc '%U:%G:%a:%s' "$DUMP_PATH") == "root:root:600:$DUMP_BYTES" ]]
[[ $(sha_of "$DUMP_PATH") == "$DUMP_SHA256" ]]

RUN_ID=$(tr -d '-' </proc/sys/kernel/random/uuid | cut -c1-12)
[[ $RUN_ID =~ ^[0-9a-f]{12}$ ]]
PREFIX="personal-max-stage8b1i-$RUN_ID"
NETWORK="$PREFIX-internal"
PG_VOLUME="$PREFIX-postgres"
SPOOL_VOLUME="$PREFIX-spool"
PG_CONTAINER="$PREFIX-postgres"
GATEWAY_CONTAINER="$PREFIX-gateway"
TMP=$(mktemp -d "/var/tmp/personal-max-stage8b1i.$RUN_ID.XXXXXX")
chmod 0700 "$TMP"

PROBE_PHASE='storage_gate'
PROBE_SAFE_COMMAND_CLASS='filesystem_metadata'
free_before=$(df -B1 -P /var/lib/docker | awk 'NR==2{print $4}')
uint "$free_before"
projected_free=$((free_before - IMAGE_EXPANSION_BYTES - PROBE_BUDGET_BYTES))
(( projected_free >= REQUIRED_FREE_BYTES ))
(( free_before - IMAGE_EXPANSION_BYTES - PROBE_BUDGET_BYTES - CLEANUP_RESERVE_BYTES >= 0 ))

PROBE_PHASE='production_snapshot_before'
PROBE_SAFE_COMMAND_CLASS='docker_metadata'
[[ -z $(docker ps -aq --no-trunc --filter "label=$STAGE_LABEL") ]]
production_snapshot "$TMP/production-before.json"

for name in "$PG_CONTAINER" "$GATEWAY_CONTAINER"; do
  [[ -z $(docker ps -aq --no-trunc --filter "name=^/${name}$") ]]
done
! docker network inspect "$NETWORK" >/dev/null 2>&1
! docker volume inspect "$PG_VOLUME" >/dev/null 2>&1
! docker volume inspect "$SPOOL_VOLUME" >/dev/null 2>&1

PROBE_PHASE='image_acquisition'
PROBE_SAFE_COMMAND_CLASS='docker_pull'
docker pull "$GATEWAY_IMAGE" >"$TMP/gateway-pull.log" 2>&1
docker pull "$SCRAPER_IMAGE" >"$TMP/scraper-pull.log" 2>&1
[[ $(docker image inspect --format '{{.Id}}' "$POSTGRES_IMAGE") == "$POSTGRES_DIGEST" ]]

verify_image() {
  local ref=$1 digest=$2 role=$3 os architecture digests
  os=$(docker image inspect --format '{{.Os}}' "$ref")
  architecture=$(docker image inspect --format '{{.Architecture}}' "$ref")
  [[ $os == linux && $architecture == amd64 ]]
  digests=$(docker image inspect --format '{{json .RepoDigests}}' "$ref")
  jq -e --arg digest "$digest" 'any(.[]; endswith("@"+$digest))' <<<"$digests" >/dev/null
  if docker image history --no-trunc --format '{{.CreatedBy}}' "$ref" | grep -Eiq '(password|secret|token|private[_ -]?key)[=:][^ ]{8,}'; then
    fail 67 image_verification docker_metadata
  fi
  printf '%s\n' "$role" >/dev/null
}

PROBE_PHASE='image_verification'
PROBE_SAFE_COMMAND_CLASS='docker_metadata'
verify_image "$GATEWAY_IMAGE" "$GATEWAY_DIGEST" gateway
verify_image "$SCRAPER_IMAGE" "$SCRAPER_DIGEST" scraper
[[ $(docker image inspect --format '{{.Os}}|{{.Architecture}}|{{.Id}}' "$POSTGRES_IMAGE") == "linux|amd64|$POSTGRES_DIGEST" ]]
gateway_user=$(docker run --rm --name "$PREFIX-gateway-usercheck" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" \
  --network none --entrypoint node "$GATEWAY_IMAGE" -e 'process.stdout.write(`${process.getuid()}:${process.getgid()}`)')
scraper_user=$(docker run --rm --name "$PREFIX-scraper-usercheck" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" \
  --network none --entrypoint node "$SCRAPER_IMAGE" -e 'process.stdout.write(`${process.getuid()}:${process.getgid()}`)')
postgres_version_output=$(docker run --rm --name "$PREFIX-postgres-version" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" \
  --network none --entrypoint postgres "$POSTGRES_IMAGE" --version)
[[ $gateway_user == 1000:1000 && $scraper_user == 1001:1001 && $postgres_version_output == *"$POSTGRES_VERSION"* ]]

PG_USER="pm_${RUN_ID}"
PG_DB="pm_${RUN_ID}"
PG_SHADOW_DB="pm_${RUN_ID}_shadow"
PG_PASSWORD=$(openssl rand -hex 32)
HMAC_KEY_ID="stage8b1i-$RUN_ID"
HMAC_SECRET=$(openssl rand -hex 48)
ACCOUNT_A="stage8b1i-a-$RUN_ID"
ACCOUNT_B="stage8b1i-b-$RUN_ID"
DATABASE_URL="postgresql://$PG_USER:$PG_PASSWORD@$PG_CONTAINER:5432/$PG_DB?schema=public"
SHADOW_DATABASE_URL="postgresql://$PG_USER:$PG_PASSWORD@$PG_CONTAINER:5432/$PG_SHADOW_DB?schema=public"
printf 'POSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\n' "$PG_USER" "$PG_PASSWORD" "$PG_DB" >"$TMP/postgres.env"
printf 'DATABASE_URL=%s\nMAX_PERSONAL_GATEWAY_DATABASE_URL=%s\nMAX_PERSONAL_CAPTURE_HMAC_KEYS_JSON={"%s":"%s"}\nMAX_PERSONAL_GATEWAY_BIND_HOST=0.0.0.0\nMAX_PERSONAL_GATEWAY_PRIVATE_NETWORK=required\nMAX_RAW_JOURNAL_ENABLED=%s,%s\nMAX_INBOUND_NORMALIZER_ENABLED=%s,%s\nMAX_SHADOW_COMPARISON_ENABLED=%s,%s\nMAX_PERSONAL_LIVE_CAPTURE_ENABLED=%s,%s\nMAX_PERSONAL_GATEWAY_WORKER_POLL_MS=100\nMAX_PERSONAL_GATEWAY_WORKER_BATCH_SIZE=100\n' \
  "$DATABASE_URL" "$DATABASE_URL" "$HMAC_KEY_ID" "$HMAC_SECRET" "$ACCOUNT_A" "$ACCOUNT_B" "$ACCOUNT_A" "$ACCOUNT_B" \
  "$ACCOUNT_A" "$ACCOUNT_B" "$ACCOUNT_A" "$ACCOUNT_B" >"$TMP/gateway.env"
printf 'DATABASE_URL=%s\nMAX_PERSONAL_GATEWAY_DATABASE_URL=%s\nMAX_PERSONAL_GATEWAY_BIND_HOST=0.0.0.0\nMAX_PERSONAL_GATEWAY_PRIVATE_NETWORK=required\nMAX_RAW_JOURNAL_ENABLED=%s\n' \
  "$DATABASE_URL" "$DATABASE_URL" "$ACCOUNT_A" >"$TMP/missing-hmac.env"
printf 'DATABASE_URL=%s\nSHADOW_DATABASE_URL=%s\n' "$DATABASE_URL" "$SHADOW_DATABASE_URL" >"$TMP/migration.env"
printf 'MAX_PERSONAL_CAPTURE_HMAC_KEY_ID=%s\nMAX_PERSONAL_CAPTURE_HMAC_SECRET=%s\n' "$HMAC_KEY_ID" "$HMAC_SECRET" >"$TMP/client.env"
chmod 0600 "$TMP"/*.env

PROBE_PHASE='disposable_topology'
PROBE_SAFE_COMMAND_CLASS='docker_disposable'
docker network create --internal --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" "$NETWORK" >/dev/null
docker volume create --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" "$PG_VOLUME" >/dev/null
docker volume create --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" "$SPOOL_VOLUME" >/dev/null

PROBE_PHASE='postgresql_start'
PROBE_SAFE_COMMAND_CLASS='docker_disposable'
docker run -d --name "$PG_CONTAINER" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" \
  --env-file "$TMP/postgres.env" -v "$PG_VOLUME:/var/lib/postgresql/data" -v "$DUMP_PATH:/backup/database.dump:ro" "$POSTGRES_IMAGE" >/dev/null
for _ in $(seq 1 90); do
  docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null
server_version=$(docker exec "$PG_CONTAINER" psql --no-psqlrc -X -A -t -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -c 'SHOW server_version')
[[ $server_version == "$POSTGRES_VERSION" ]]

PROBE_PHASE='backup_restore'
PROBE_SAFE_COMMAND_CLASS='backup_validation'
docker exec "$PG_CONTAINER" pg_restore --list /backup/database.dump >"$TMP/dump.list"
object_count=$(awk 'NF && $1 !~ /^;/{count++} END{print count+0}' "$TMP/dump.list")
[[ $object_count -eq $DUMP_OBJECTS ]]
restore_started=$(date +%s)
docker exec "$PG_CONTAINER" pg_restore --exit-on-error --no-owner --no-acl -U "$PG_USER" -d "$PG_DB" /backup/database.dump >"$TMP/restore.log" 2>&1
restore_seconds=$(( $(date +%s) - restore_started ))

psql_value() {
  docker exec "$PG_CONTAINER" psql --no-psqlrc -X -A -t -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -c "$1"
}

PROBE_PHASE='restore_verification'
PROBE_SAFE_COMMAND_CLASS='disposable_postgresql'
ledger_before_finished=$(psql_value 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
ledger_before_failed=$(psql_value 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL')
[[ $ledger_before_finished -eq 46 && $ledger_before_failed -eq 0 ]]
psql_value "SELECT migration_name FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name" >"$TMP/ledger-before"
catalog_tables=$(psql_value "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")
catalog_indexes=$(psql_value "SELECT count(*) FROM pg_indexes WHERE schemaname='public'")
catalog_constraints=$(psql_value "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'")
[[ $catalog_tables -gt 0 && $catalog_indexes -gt 0 && $catalog_constraints -gt 0 ]]
jq -n --argjson migrations "$(psql_value 'SELECT count(*) FROM "_prisma_migrations"')" \
  --argjson users "$(psql_value 'SELECT count(*) FROM "User"')" \
  --argjson contacts "$(psql_value 'SELECT count(*) FROM "Contact"')" \
  --argjson chats "$(psql_value 'SELECT count(*) FROM "Chat"')" \
  '{migrations:$migrations,users:$users,contacts:$contacts,chats:$chats,contentPrinted:false}' >"$TMP/representative-counts.json"

PROBE_PHASE='migration_preflight'
PROBE_SAFE_COMMAND_CLASS='disposable_migration'
docker run --rm --name "$PREFIX-migration-inventory" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network none \
  --entrypoint sh "$GATEWAY_IMAGE" -ceu 'for directory in /app/prisma/migrations/*; do test -d "$directory" && basename "$directory"; done | sort' >"$TMP/repository-migrations"
comm -23 "$TMP/repository-migrations" "$TMP/ledger-before" >"$TMP/pending-before"
printf '%s\n' "${EXPECTED_MIGRATIONS[@]}" | sort >"$TMP/expected-migrations"
cmp "$TMP/expected-migrations" "$TMP/pending-before"
[[ $(wc -l <"$TMP/repository-migrations") -eq 53 ]]
comm -13 "$TMP/repository-migrations" "$TMP/ledger-before" >"$TMP/applied-only"
[[ $(<"$TMP/applied-only") == 20260717000000_add_driver_telegram_submitted_phone ]]
docker run --rm --name "$PREFIX-migration-scan" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network none \
  --entrypoint sh "$GATEWAY_IMAGE" -ceu 'for name in "$@"; do file="/app/prisma/migrations/$name/migration.sql"; test -f "$file"; if grep -Eiq "^[[:space:]]*(DROP|TRUNCATE|DELETE|UPDATE|INSERT)[[:space:]]|^[[:space:]]*ALTER[[:space:]].*[[:space:]]DROP[[:space:]]" "$file"; then exit 67; fi; done' \
  sh "${EXPECTED_MIGRATIONS[@]}"
docker exec "$PG_CONTAINER" createdb -U "$PG_USER" "$PG_SHADOW_DB"

PROBE_PHASE='disposable_migration'
PROBE_SAFE_COMMAND_CLASS='disposable_migration'
migration_started=$(date +%s)
docker run --rm --name "$PREFIX-migration-apply" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" \
  --env-file "$TMP/migration.env" --entrypoint sh "$GATEWAY_IMAGE" -ceu \
  'exec /app/node_modules/.bin/prisma migrate deploy --schema /app/prisma/schema.prisma' >"$TMP/migration.log" 2>&1
migration_seconds=$(( $(date +%s) - migration_started ))

PROBE_PHASE='migration_verification'
PROBE_SAFE_COMMAND_CLASS='disposable_migration'
ledger_after_finished=$(psql_value 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
ledger_after_failed=$(psql_value 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL')
[[ $ledger_after_finished -eq 54 && $ledger_after_failed -eq 0 ]]
psql_value "SELECT migration_name FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name" >"$TMP/ledger-after"
comm -13 "$TMP/ledger-before" "$TMP/ledger-after" >"$TMP/applied-now"
cmp "$TMP/expected-migrations" "$TMP/applied-now"
migration_names_sql=$(printf "'%s'," "${EXPECTED_MIGRATIONS[@]}")
migration_names_sql=${migration_names_sql%,}
migration_durations=$(psql_value "SELECT COALESCE(json_agg(json_build_object('name',migration_name,'durationMs',GREATEST(0,ROUND(EXTRACT(EPOCH FROM (finished_at-started_at))*1000)::bigint)) ORDER BY migration_name),'[]'::json)::text FROM \"_prisma_migrations\" WHERE migration_name IN ($migration_names_sql) AND finished_at IS NOT NULL AND rolled_back_at IS NULL")
jq -e 'length==8 and all(.[]; (.name|type)=="string" and (.durationMs|type)=="number" and .durationMs>=0)' <<<"$migration_durations" >/dev/null
[[ $(psql_value "SELECT to_regclass('public.\"MaxRawTransportEvent\"') IS NOT NULL") == t ]]
[[ $(psql_value "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='MaxRawTransportEvent' AND column_name='captureEnvelopeId')") == t ]]
[[ $(psql_value "SELECT to_regclass('public.\"MaxRawTransportEvent_accountId_captureEnvelopeId_idx\"') IS NOT NULL") == t ]]
[[ $(psql_value "SELECT to_regclass('public.\"MaxRawTransportEvent_accountId_captureEnvelopeId_key\"') IS NOT NULL") == t ]]
docker run --rm --name "$PREFIX-prisma-diff" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" \
  --env-file "$TMP/migration.env" --entrypoint sh "$GATEWAY_IMAGE" -ceu \
  'exec /app/node_modules/.bin/prisma migrate diff --from-migrations /app/prisma/migrations --to-url "$DATABASE_URL" --shadow-database-url "$SHADOW_DATABASE_URL" --exit-code' \
  >"$TMP/prisma-diff.log" 2>&1

PROBE_PHASE='gateway_negative'
PROBE_SAFE_COMMAND_CLASS='docker_disposable'
set +e
timeout 15 docker run --rm --name "$PREFIX-gateway-missing-hmac" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" \
  --network "$NETWORK" --env-file "$TMP/missing-hmac.env" "$GATEWAY_IMAGE" >"$TMP/missing-hmac.log" 2>&1
missing_hmac_status=$?
timeout 15 docker run --rm --name "$PREFIX-gateway-invalid-config" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" \
  --network "$NETWORK" -e MAX_RAW_JOURNAL_ENABLED='*' "$GATEWAY_IMAGE" >"$TMP/invalid-config.log" 2>&1
invalid_config_status=$?
set -e
[[ $missing_hmac_status -ne 0 && $missing_hmac_status -ne 124 && $invalid_config_status -ne 0 && $invalid_config_status -ne 124 ]]

PROBE_PHASE='gateway_dormant'
PROBE_SAFE_COMMAND_CLASS='docker_disposable'
docker run -d --name "$PREFIX-gateway-dormant" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" "$GATEWAY_IMAGE" >/dev/null
for _ in $(seq 1 30); do
  docker exec "$PREFIX-gateway-dormant" node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.status===200?0:1))" >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PREFIX-gateway-dormant" node -e "fetch('http://127.0.0.1:8080/ready').then(async r=>{const v=await r.json();process.exit(r.status===200&&v.state==='dormant-ready'?0:1)})"
docker rm -f "$PREFIX-gateway-dormant" >/dev/null

start_gateway() {
  docker run -d --name "$GATEWAY_CONTAINER" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" \
    --network-alias max-personal-gateway --env-file "$TMP/gateway.env" "$GATEWAY_IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$GATEWAY_CONTAINER" node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.status===200?0:1))" >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$GATEWAY_CONTAINER" node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.status===200?0:1))"
}

PROBE_PHASE='gateway_active'
PROBE_SAFE_COMMAND_CLASS='docker_disposable'
start_gateway

PROBE_PHASE='scraper_default_off'
PROBE_SAFE_COMMAND_CLASS='synthetic_harness'
docker run --rm --name "$PREFIX-scraper-default-off" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network none \
  -v "$PACKAGE_ROOT/synthetic-scraper-harness.js:/tmp/stage8b1i-harness.js:ro" --entrypoint node "$SCRAPER_IMAGE" \
  /tmp/stage8b1i-harness.js >"$TMP/default-off.json"
jq -e '.defaultOffNoSpool==true and .timers==false and .network==false and .database==false' "$TMP/default-off.json" >/dev/null
docker run --rm --name "$PREFIX-spool-init" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --user 0:0 --network none \
  -v "$SPOOL_VOLUME:/spool" --entrypoint sh "$SCRAPER_IMAGE" -ceu 'chown 1001:1001 /spool; chmod 0700 /spool'

PROBE_PHASE='e2e_outage'
PROBE_SAFE_COMMAND_CLASS='synthetic_harness'
docker stop "$PG_CONTAINER" >/dev/null
docker exec "$GATEWAY_CONTAINER" node -e "fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.status===503?0:1))"
docker start "$PG_CONTAINER" >/dev/null
for _ in $(seq 1 60); do docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1 && break; sleep 1; done
docker rm -f "$GATEWAY_CONTAINER" >/dev/null
docker run --rm --name "$PREFIX-scraper-capture-a" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network none \
  -e MAX_PERSONAL_ACCOUNT_ID="$ACCOUNT_A" -e MAX_PERSONAL_LIVE_CAPTURE_ENABLED="$ACCOUNT_A" \
  -e MAX_PERSONAL_CAPTURE_SPOOL_PATH=/spool/account-a -e STAGE8B1I_HARNESS_MODE=capture-only \
  -e STAGE8B1I_FRAME_COUNT=500 -e STAGE8B1I_IDENTICAL_COUNT=100 \
  -v "$SPOOL_VOLUME:/spool" -v "$PACKAGE_ROOT/synthetic-scraper-harness.js:/tmp/stage8b1i-harness.js:ro" \
  --entrypoint node "$SCRAPER_IMAGE" /tmp/stage8b1i-harness.js >"$TMP/capture-a.json"
docker run --rm --name "$PREFIX-scraper-retry-a" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" \
  --env-file "$TMP/client.env" -e MAX_PERSONAL_ACCOUNT_ID="$ACCOUNT_A" -e MAX_PERSONAL_LIVE_CAPTURE_ENABLED="$ACCOUNT_A" \
  -e MAX_PERSONAL_CAPTURE_SPOOL_PATH=/spool/account-a -e MAX_PERSONAL_CAPTURE_INGRESS_URL=http://max-personal-gateway:8080/v1/capture \
  -e STAGE8B1I_HARNESS_MODE=retry-only -e STAGE8B1I_DRAIN_ATTEMPTS=10 \
  -v "$SPOOL_VOLUME:/spool" -v "$PACKAGE_ROOT/synthetic-scraper-harness.js:/tmp/stage8b1i-harness.js:ro" \
  --entrypoint node "$SCRAPER_IMAGE" /tmp/stage8b1i-harness.js >"$TMP/retry-a.json"
jq -e '.retryCount>0 and .pendingAfter>0 and .lostBeforeSpoolCount==0' "$TMP/retry-a.json" >/dev/null

PROBE_PHASE='e2e_recovery'
PROBE_SAFE_COMMAND_CLASS='synthetic_harness'
start_gateway
docker run --rm --name "$PREFIX-scraper-capture-b" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" \
  --env-file "$TMP/client.env" -e MAX_PERSONAL_ACCOUNT_ID="$ACCOUNT_B" -e MAX_PERSONAL_LIVE_CAPTURE_ENABLED="$ACCOUNT_B" \
  -e MAX_PERSONAL_CAPTURE_SPOOL_PATH=/spool/account-b -e MAX_PERSONAL_CAPTURE_INGRESS_URL=http://max-personal-gateway:8080/v1/capture \
  -e STAGE8B1I_HARNESS_MODE=capture-and-drain -e STAGE8B1I_FRAME_COUNT=500 -e STAGE8B1I_IDENTICAL_COUNT=0 \
  -v "$SPOOL_VOLUME:/spool" -v "$PACKAGE_ROOT/synthetic-scraper-harness.js:/tmp/stage8b1i-harness.js:ro" \
  --entrypoint node "$SCRAPER_IMAGE" /tmp/stage8b1i-harness.js >"$TMP/capture-b.json"
docker run --rm --name "$PREFIX-scraper-drain-a" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" \
  --env-file "$TMP/client.env" -e MAX_PERSONAL_ACCOUNT_ID="$ACCOUNT_A" -e MAX_PERSONAL_LIVE_CAPTURE_ENABLED="$ACCOUNT_A" \
  -e MAX_PERSONAL_CAPTURE_SPOOL_PATH=/spool/account-a -e MAX_PERSONAL_CAPTURE_INGRESS_URL=http://max-personal-gateway:8080/v1/capture \
  -e STAGE8B1I_HARNESS_MODE=drain-only -e STAGE8B1I_DRAIN_ATTEMPTS=120 \
  -v "$SPOOL_VOLUME:/spool" -v "$PACKAGE_ROOT/synthetic-scraper-harness.js:/tmp/stage8b1i-harness.js:ro" \
  --entrypoint node "$SCRAPER_IMAGE" /tmp/stage8b1i-harness.js >"$TMP/drain-a.json"
docker run --rm --name "$PREFIX-spool-permissions" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network none \
  -v "$SPOOL_VOLUME:/spool" --entrypoint sh "$SCRAPER_IMAGE" -ceu \
  'test "$(stat -c %u:%g:%a /spool)" = 1001:1001:700; find /spool -type d ! -perm 0700 -print -quit | grep -q . && exit 1 || true; find /spool -type f ! -perm 0600 -print -quit | grep -q . && exit 1 || true'
docker rm -f "$GATEWAY_CONTAINER" >/dev/null
start_gateway

PROBE_PHASE='gateway_active'
PROBE_SAFE_COMMAND_CLASS='synthetic_http'
docker run --rm --name "$PREFIX-gateway-client" --label "$STAGE_LABEL" --label "$RUN_LABEL_KEY=$RUN_ID" --network "$NETWORK" \
  --env-file "$TMP/client.env" -e STAGE8B1I_ACCOUNT_A="$ACCOUNT_A" \
  -v "$PACKAGE_ROOT/gateway-client-harness.js:/tmp/stage8b1i-client.js:ro" --entrypoint node "$SCRAPER_IMAGE" \
  /tmp/stage8b1i-client.js >"$TMP/gateway-client.json"
jq -e 'all(.missingAuthDenied,.invalidAuthDenied,.wrongAccountDenied,.requestSizeLimit,.authenticatedIngress,.idempotentRetry; .==true)' "$TMP/gateway-client.json" >/dev/null

PROBE_PHASE='e2e_verification'
PROBE_SAFE_COMMAND_CLASS='disposable_postgresql'
for _ in $(seq 1 180); do
  normalized=$(psql_value "SELECT count(*) FROM \"MaxInboundNormalizationResult\" WHERE \"accountId\" IN ('$ACCOUNT_A','$ACCOUNT_B')")
  compared=$(psql_value "SELECT count(*) FROM \"MaxShadowComparisonResult\" WHERE \"accountId\" IN ('$ACCOUNT_A','$ACCOUNT_B')")
  [[ $normalized -ge 1001 && $compared -ge 1001 ]] && break
  sleep 1
done
physical_frames=$(psql_value "SELECT count(*) FROM \"MaxRawTransportEvent\" WHERE \"accountId\" IN ('$ACCOUNT_A','$ACCOUNT_B') AND \"eventType\" IS DISTINCT FROM 'stage8b1i-idempotency'")
idempotency_rows=$(psql_value "SELECT count(*) FROM \"MaxRawTransportEvent\" WHERE \"accountId\"='$ACCOUNT_A' AND \"eventType\"='stage8b1i-idempotency'")
identical_frames=$(psql_value "SELECT COALESCE(max(c),0) FROM (SELECT count(*) c FROM \"MaxRawTransportEvent\" WHERE \"accountId\" IN ('$ACCOUNT_A','$ACCOUNT_B') GROUP BY \"accountId\",\"payloadSha256\" HAVING count(*)>1) grouped")
duplicate_envelopes=$(psql_value "SELECT count(*) FROM (SELECT 1 FROM \"MaxRawTransportEvent\" WHERE \"accountId\" IN ('$ACCOUNT_A','$ACCOUNT_B') GROUP BY \"accountId\",\"captureEnvelopeId\" HAVING count(*)>1) duplicated")
wrong_account=$(psql_value "SELECT count(*) FROM \"MaxRawTransportEvent\" WHERE \"accountId\"='stage8b1i-wrong-account'")
critical_regressions=$(psql_value "SELECT count(*) FROM \"MaxShadowComparisonResult\" WHERE \"accountId\" IN ('$ACCOUNT_A','$ACCOUNT_B') AND \"highestSeverity\"='critical'")
quarantined_results=$(psql_value "SELECT count(*) FROM \"MaxInboundNormalizationResult\" WHERE \"accountId\" IN ('$ACCOUNT_A','$ACCOUNT_B') AND status='quarantined'")
unsupported_results=$(psql_value "SELECT count(*) FROM \"MaxInboundNormalizationResult\" WHERE \"accountId\" IN ('$ACCOUNT_A','$ACCOUNT_B') AND status='unsupported'")
[[ $physical_frames -eq 1000 && $idempotency_rows -eq 1 && $identical_frames -eq 100 && $duplicate_envelopes -eq 0 && $wrong_account -eq 0 && $critical_regressions -eq 0 ]]
[[ $quarantined_results -ge 2 && $unsupported_results -ge 2 ]]
[[ $normalized -ge 1001 && $compared -ge 1001 ]]

docker rm -f "$GATEWAY_CONTAINER" >/dev/null
cleanup_docker_objects
CLEANUP_COMPLETED=true
TMP_REPORT=$(mktemp /var/tmp/personal-max-stage8b1i-success.tmp.XXXXXX)
chmod 0600 "$TMP_REPORT"

PROBE_PHASE='production_snapshot_after'
PROBE_SAFE_COMMAND_CLASS='docker_metadata'
TMP_AFTER=$(mktemp /var/tmp/personal-max-stage8b1i-after.tmp.XXXXXX)
chmod 0600 "$TMP_AFTER"
production_snapshot "$TMP_AFTER"
production_unchanged=false
jq -S 'del(.freeBytes)' "$TMP/production-before.json" >"$TMP/production-before-core.json"
jq -S 'del(.freeBytes)' "$TMP_AFTER" >"$TMP/production-after-core.json"
cmp "$TMP/production-before-core.json" "$TMP/production-after-core.json" >/dev/null && production_unchanged=true
[[ $production_unchanged == true ]]
free_after=$(jq -r '.freeBytes' "$TMP_AFTER")
[[ -z $(docker ps -aq --no-trunc --filter "label=$STAGE_LABEL" --filter "label=$RUN_LABEL_KEY=$RUN_ID") ]]
[[ -z $(docker network ls -q --filter "label=$STAGE_LABEL" --filter "label=$RUN_LABEL_KEY=$RUN_ID") ]]
[[ -z $(docker volume ls -q --filter "label=$STAGE_LABEL" --filter "label=$RUN_LABEL_KEY=$RUN_ID") ]]

PROBE_PHASE='report_render'
PROBE_SAFE_COMMAND_CLASS='report_render'
jq -n --arg generatedAt "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" --arg scriptSha256 "$PM_SCRIPT_SHA256" \
  --arg backupReportSha256 "$BACKUP_REPORT_SHA256" --arg dumpSha256 "$DUMP_SHA256" --argjson dumpBytes "$DUMP_BYTES" \
  --arg gatewayRef "$GATEWAY_IMAGE" --arg scraperRef "$SCRAPER_IMAGE" --arg postgresqlRef "$POSTGRES_IMAGE" \
  --arg gatewayUser "$gateway_user" --arg scraperUser "$scraper_user" --arg postgresqlVersion "$server_version" \
  --argjson objectCount "$object_count" --argjson restoreSeconds "$restore_seconds" \
  --argjson beforeFinished "$ledger_before_finished" --argjson afterFinished "$ledger_after_finished" \
  --argjson failed "$ledger_after_failed" --argjson appliedNames "$(jq -R . <"$TMP/applied-now" | jq -s .)" \
  --argjson migrationSeconds "$migration_seconds" --argjson migrationDurations "$migration_durations" \
  --argjson representativeCounts "$(<"$TMP/representative-counts.json")" \
  --argjson physicalFrames "$physical_frames" --argjson identicalFrames "$identical_frames" \
  --argjson normalized "$normalized" --argjson compared "$compared" --argjson quarantinedResults "$quarantined_results" \
  --argjson unsupportedResults "$unsupported_results" --argjson retryCount "$(jq -r '.retryCount' "$TMP/retry-a.json")" \
  --argjson before "$(<"$TMP/production-before.json")" --argjson after "$(<"$TMP_AFTER")" \
  --argjson freeBytesBefore "$free_before" --argjson freeBytesAfter "$free_after" \
  '{schemaVersion:1,mode:"ISOLATED_RELEASE_PROOF",generatedAt:$generatedAt,script:{sha256:$scriptSha256,checksumBound:true},
    bindings:{backupReportSha256:$backupReportSha256,dumpSha256:$dumpSha256,dumpBytes:$dumpBytes},
    restore:{FULL_RESTORE_PROOF:"PASS",objectCount:$objectCount,ledgerFinished:$beforeFinished,ledgerFailed:0,
      catalogIntegrity:true,representativeCounts:$representativeCounts,durationSeconds:$restoreSeconds,userDataPrinted:false},
    migration:{DISPOSABLE_MIGRATION_PROOF:"PASS",appliedNames:$appliedNames,beforeFinished:$beforeFinished,
      afterFinished:$afterFinished,failed:$failed,prismaDiffEmpty:true,durationSeconds:$migrationSeconds,
      perMigrationDurations:$migrationDurations,repositoryDirectoryCount:53,appliedOnlyLegacyCount:1,productionMigration:false},
    images:{gateway:{ref:$gatewayRef,runtimeUser:$gatewayUser,digestVerified:true},scraper:{ref:$scraperRef,runtimeUser:$scraperUser,digestVerified:true},
      postgresql:{ref:$postgresqlRef,version:$postgresqlVersion,digestVerified:true,exactProductionImageId:true},architecture:"linux/amd64",mutableTags:false,retained:true},
    executable:{dormant:true,invalidConfigFailsClosed:true,missingHmacFailsClosed:true,authenticatedIngress:true,authDenied:true,requestSizeLimit:true},
    e2e:{actualHook:true,frames:$physicalFrames,identicalFrames:$identicalFrames,accounts:2,retryStorm:$retryCount,
      gatewayOutage:true,databaseOutage:true,scraperRestart:true,gatewayRestart:true,spoolRecovery:true,normalized:$normalized,compared:$compared,
      quarantined:$quarantinedResults,unsupported:$unsupportedResults,captureLoss:0,accidentalDuplicateRawRows:0,
      wrongAccount:0,criticalSemanticRegressions:0},
    cleanup:{containersRemaining:0,networksRemaining:0,volumesRemaining:0,tempFilesRemaining:0,labelScoped:true,globalPrune:false},
    productionImmutability:{before:$before,after:$after,unchanged:true,productionDatabaseConnections:0},
    storage:{freeBytesBefore:$freeBytesBefore,freeBytesAfter:$freeBytesAfter,imageExpansionBudgetBytes:'"$IMAGE_EXPANSION_BYTES"',
      restoreProbeBudgetBytes:'"$PROBE_BUDGET_BYTES"',cleanupReserveBytes:'"$CLEANUP_RESERVE_BYTES"'},
    safety:{productionDDL:false,productionDML:false,productionMigration:false,restart:false,deploy:false,browserLaunched:false,
      maxContacted:false,providerAction:false,productionNetworkAttached:false,productionVolumeMounted:false,profileMounted:false}}' >"$TMP_REPORT"

rm -f -- "$TMP_AFTER"
TMP_AFTER=''
rm -rf -- "$TMP"
TMP=''
PROBE_PHASE='report_handoff'
PROBE_SAFE_COMMAND_CLASS='report_handoff'
chgrp codexbot "$TMP_REPORT"
chmod 0640 "$TMP_REPORT"
[[ $(stat -Lc '%U:%G:%a' "$TMP_REPORT") == root:codexbot:640 && -f $TMP_REPORT && ! -L $TMP_REPORT ]]
report_identity=$(stat -Lc '%d:%i' "$TMP_REPORT")
mv --no-clobber --no-target-directory -- "$TMP_REPORT" "$SUCCESS_REPORT"
[[ $(stat -Lc '%d:%i' "$SUCCESS_REPORT") == "$report_identity" ]]
timeout 5 runuser -u codexbot -- test -r "$SUCCESS_REPORT"
set +e
timeout 5 runuser -u codexbot -- test -w "$SUCCESS_REPORT"
codexbot_write_status=$?
set -e
[[ $codexbot_write_status -ne 0 ]]
report_sha=$(sha_of "$SUCCESS_REPORT")
PROBE_PHASE='completed'
PROBE_SAFE_COMMAND_CLASS='report_handoff'
trap - ERR EXIT
printf 'ISOLATED_RELEASE_PROOF_COMPLETED\nREPORT_PATH=%s\nREPORT_SHA256=%s\nREPORT_OWNER=root\nREPORT_GROUP=codexbot\nREPORT_MODE=0640\nCODEXBOT_READABLE=YES\nCODEXBOT_WRITABLE=NO\nFULL_RESTORE_PROOF=PASS\nDISPOSABLE_MIGRATION_PROOF=PASS\nPRODUCTION_UNCHANGED=YES\nCLEANUP=PASS\n' \
  "$SUCCESS_REPORT" "$report_sha"
