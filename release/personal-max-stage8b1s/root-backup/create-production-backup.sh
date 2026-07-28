#!/usr/bin/env bash
# Dynamic capture targets and the single-quoted in-container commands are intentional.
# shellcheck disable=SC1091,SC2016,SC2034,SC2154,SC2178
set -Eeuo pipefail
umask 077

readonly PROJECT='crm'
readonly SERVICE='postgres'
readonly PROJECT_LABEL='com.docker.compose.project'
readonly SERVICE_LABEL='com.docker.compose.service'
readonly SOURCE_REPORT='/var/tmp/personal-max-stage8b1r-production-readonly-preflight.json'
readonly SOURCE_REPORT_SHA256='d6a6e4764c90a6f64af9c11b2b0c4eeb08b82c377b58990f939bd559688ac63b'
readonly BACKUP_PARENT='/var/backups'
readonly BACKUP_DIRECTORY='/var/backups/personal-max-stage8b1s-production-backup'
readonly SUCCESS_REPORT='/var/tmp/personal-max-stage8b1s-production-backup.json'
readonly FAILURE_REPORT_PREFIX='/var/tmp/personal-max-stage8b1s-production-backup.failure'
readonly MINIMUM_FREE_BEFORE_BYTES=12500000000
readonly ROLLBACK_RESERVE_BYTES=5368709120
readonly COMMAND_TIMEOUT_SECONDS=30
readonly DUMP_TIMEOUT_SECONDS=1800
readonly DIAGNOSTICS_SHA256='6d367992812301783f7118fc72f1820fdb6884c98409a6dfff127eb0614dab28'
readonly EXPECTED_SHA256=${PERSONAL_MAX_BACKUP_SCRIPT_SHA256:-}
readonly -a CONFIG_SOURCE_FILES=(
  '/opt/crm/deploy/docker-compose.production.yml'
  '/opt/crm/.env.production'
  '/opt/crm/deploy/nginx/nginx.conf'
  '/opt/crm/deploy/nginx/conf.d/default.conf'
  '/opt/crm/deploy/nginx/templates/bot-admin.conf.template'
  '/opt/crm/deploy/nginx/templates/crm.conf.template'
)

bootstrap_fail() {
  printf '%s\n' "$1" >&2
  exit "$2"
}

(( EUID == 0 )) || bootstrap_fail 'ROOT_REQUIRED' 77
[[ $EXPECTED_SHA256 =~ ^[0-9a-f]{64}$ ]] || bootstrap_fail 'CHECKSUM_BINDING_REQUIRED' 78
for binary in awk chgrp chmod chown date df dirname docker getent jq mkdir mktemp mv realpath rm runuser sha256sum sort stat tar timeout wc; do
  command -v "$binary" >/dev/null 2>&1 || bootstrap_fail "MANDATORY_BINARY_MISSING: $binary" 76
done

SCRIPT_PATH=$(realpath -- "${BASH_SOURCE[0]}") || bootstrap_fail 'SCRIPT_OR_PACKAGE_UNREADABLE' 75
SCRIPT_DIR=$(dirname -- "$SCRIPT_PATH") || bootstrap_fail 'SCRIPT_OR_PACKAGE_UNREADABLE' 75
DIAGNOSTICS_PATH="$SCRIPT_DIR/failure-diagnostics.sh"
[[ -f $SCRIPT_PATH && ! -L $SCRIPT_PATH && -r $SCRIPT_PATH && \
  -f $DIAGNOSTICS_PATH && ! -L $DIAGNOSTICS_PATH && -r $DIAGNOSTICS_PATH ]] || \
  bootstrap_fail 'SCRIPT_OR_PACKAGE_UNREADABLE' 75
ACTUAL_SHA256=$(sha256sum -- "$SCRIPT_PATH" | awk '{print $1}') || bootstrap_fail 'CHECKSUM_MISMATCH' 79
[[ $ACTUAL_SHA256 == "$EXPECTED_SHA256" ]] || bootstrap_fail 'CHECKSUM_MISMATCH' 79
ACTUAL_DIAGNOSTICS_SHA256=$(sha256sum -- "$DIAGNOSTICS_PATH" | awk '{print $1}') || bootstrap_fail 'CHECKSUM_MISMATCH' 79
[[ $ACTUAL_DIAGNOSTICS_SHA256 == "$DIAGNOSTICS_SHA256" ]] || bootstrap_fail 'CHECKSUM_MISMATCH' 79
[[ -d $BACKUP_PARENT && ! -L $BACKUP_PARENT ]] || bootstrap_fail 'BACKUP_PARENT_UNSAFE' 80
if [[ -e $BACKUP_DIRECTORY || -L $BACKUP_DIRECTORY || -e $SUCCESS_REPORT || -L $SUCCESS_REPORT ]]; then
  bootstrap_fail 'BACKUP_PATH_ALREADY_EXISTS' 80
fi
readonly FAILURE_REPORT="$FAILURE_REPORT_PREFIX.$ACTUAL_SHA256.json"
if [[ -e $FAILURE_REPORT || -L $FAILURE_REPORT ]]; then
  bootstrap_fail 'FAILURE_REPORT_PATH_UNSAFE' 80
fi
timeout 5 getent group codexbot >/dev/null 2>&1 || bootstrap_fail 'HANDOFF_GROUP_MISSING: codexbot' 84

# shellcheck source=release/personal-max-stage8b1s/root-backup/failure-diagnostics.sh
source "$DIAGNOSTICS_PATH"

BACKUP_PHASE='bootstrap_complete'
BACKUP_SAFE_COMMAND_CLASS='unknown'
BACKUP_ERROR_CLASSIFICATION='UNEXPECTED_COMMAND_FAILURE'
PM_FAILURE_HANDLER_ACTIVE=false
PM_BACKUP_DIRECTORY_CREATED=false
PM_DUMP_STARTED=false
PM_DUMP_COMPLETED=false
PM_STRUCTURAL_VALIDATION_COMPLETED=false
PM_CONFIG_ARCHIVE_COMPLETED=false
PM_METADATA_TMP=''
PM_FAILURE_TMP=''
readonly PM_SCRIPT_SHA256="$ACTUAL_SHA256"
readonly PM_FAILURE_PATH="$FAILURE_REPORT"
readonly PM_FAILURE_TMP_PREFIX="$FAILURE_REPORT_PREFIX.tmp.$ACTUAL_SHA256"
readonly PM_REPORT_OWNER='root'
readonly PM_REPORT_GROUP='codexbot'
readonly PM_REPORT_READER='codexbot'
readonly PM_VERIFY_PRINCIPAL_ACCESS=true

restore_err_trap() {
  trap 'personal_max_backup_handle_failure "$?" "$LINENO"' ERR
}

cleanup_metadata_temporary() {
  trap - ERR
  set +e
  if [[ -n ${PM_METADATA_TMP:-} && ( -e ${PM_METADATA_TMP:-} || -L ${PM_METADATA_TMP:-} ) ]]; then
    rm -f -- "$PM_METADATA_TMP" >/dev/null 2>&1
  fi
  if [[ -n ${PM_FAILURE_TMP:-} && ( -e ${PM_FAILURE_TMP:-} || -L ${PM_FAILURE_TMP:-} ) ]]; then
    rm -f -- "$PM_FAILURE_TMP" >/dev/null 2>&1
  fi
}

restore_err_trap
trap cleanup_metadata_temporary EXIT
started_at=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
[[ $started_at =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || \
  bootstrap_fail 'CLOCK_METADATA_INVALID' 74

fail_backup() {
  local exit_code=$1 safe_class=$2 error_class=$3
  local source_line=${BASH_LINENO[0]:-0}
  BACKUP_SAFE_COMMAND_CLASS=$safe_class
  BACKUP_ERROR_CLASSIFICATION=$error_class
  personal_max_backup_handle_failure "$exit_code" "$source_line"
}

run_capture() {
  local target_name=$1 safe_class=$2 error_class=$3
  local output status source_line
  shift 3
  source_line=${BASH_LINENO[0]:-0}
  BACKUP_SAFE_COMMAND_CLASS=$safe_class
  BACKUP_ERROR_CLASSIFICATION=$error_class
  trap - ERR
  set +e
  output=$("$@" 2>/dev/null)
  status=$?
  set -e
  restore_err_trap
  if (( status != 0 )); then
    personal_max_backup_handle_failure "$status" "$source_line"
  fi
  printf -v "$target_name" '%s' "$output"
}

docker_read() {
  timeout --signal=TERM --kill-after=5 "$COMMAND_TIMEOUT_SECONDS" docker "$@"
}

hash_text() {
  printf '%s\n' "$1" | sha256sum | awk '{print $1}'
}

collect_project_snapshot() {
  local target_name=$1 raw_ids sorted_ids container_id row rows=''
  run_capture raw_ids docker_ps PRODUCTION_SNAPSHOT_FAILED docker_read ps -aq --no-trunc \
    --filter "label=$PROJECT_LABEL=$PROJECT"
  sorted_ids=$(printf '%s\n' "$raw_ids" | awk 'NF' | LC_ALL=C sort -u)
  while IFS= read -r container_id; do
    [[ -n $container_id ]] || continue
    [[ $container_id =~ ^[0-9a-f]{64}$ ]] || fail_backup 65 docker_ps PRODUCTION_SNAPSHOT_FAILED
    run_capture row docker_inspect PRODUCTION_SNAPSHOT_FAILED docker_read inspect --format \
      '{{.Id}}|{{.State.Status}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.Config.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' \
      "$container_id"
    [[ $row == *"|$PROJECT|"* ]] || fail_backup 91 docker_inspect LABEL_MISMATCH
    rows+="$row"$'\n'
  done <<<"$sorted_ids"
  printf -v "$target_name" '%s' "$(printf '%s' "$rows" | LC_ALL=C sort)"
}

BACKUP_PHASE='source_report_validation'
BACKUP_SAFE_COMMAND_CLASS='report_validation'
BACKUP_ERROR_CLASSIFICATION='SOURCE_REPORT_INVALID'
[[ -f $SOURCE_REPORT && ! -L $SOURCE_REPORT && -r $SOURCE_REPORT ]] || \
  fail_backup 81 report_validation SOURCE_REPORT_INVALID
run_capture observed_source_sha report_validation SOURCE_REPORT_INVALID sha256sum -- "$SOURCE_REPORT"
observed_source_sha=${observed_source_sha%% *}
[[ $observed_source_sha == "$SOURCE_REPORT_SHA256" ]] || fail_backup 81 report_validation SOURCE_REPORT_INVALID
run_capture source_schema report_validation SOURCE_REPORT_INVALID jq -er '.schemaVersion' "$SOURCE_REPORT"
run_capture database_size_bytes report_validation SOURCE_REPORT_INVALID jq -er '.database.databaseSizeBytes' "$SOURCE_REPORT"
run_capture report_backup_estimate_bytes report_validation SOURCE_REPORT_INVALID jq -er '.storage.budget.backupEstimateBytes' "$SOURCE_REPORT"
run_capture source_migration_total report_validation SOURCE_REPORT_INVALID jq -er '.database.migration.total' "$SOURCE_REPORT"
run_capture source_migration_finished report_validation SOURCE_REPORT_INVALID jq -er '.database.migration.finished' "$SOURCE_REPORT"
run_capture source_migration_failed report_validation SOURCE_REPORT_INVALID jq -er '.database.migration.failed' "$SOURCE_REPORT"
[[ $source_schema == 3 && $database_size_bytes =~ ^[1-9][0-9]*$ && \
  $report_backup_estimate_bytes =~ ^[1-9][0-9]*$ && $source_migration_total =~ ^[0-9]+$ && \
  $source_migration_finished =~ ^[0-9]+$ && $source_migration_failed =~ ^[0-9]+$ ]] || \
  fail_backup 81 report_validation SOURCE_REPORT_INVALID
(( report_backup_estimate_bytes >= database_size_bytes )) || fail_backup 81 report_validation SOURCE_REPORT_INVALID

config_source_bytes=0
for source_file in "${CONFIG_SOURCE_FILES[@]}"; do
  [[ $source_file == /opt/crm/* && -f $source_file && ! -L $source_file ]] || \
    fail_backup 82 filesystem_metadata SOURCE_REPORT_INVALID
  run_capture source_size filesystem_metadata SOURCE_REPORT_INVALID stat -Lc '%s' "$source_file"
  [[ $source_size =~ ^[0-9]+$ ]] || fail_backup 82 filesystem_metadata SOURCE_REPORT_INVALID
  config_source_bytes=$((config_source_bytes + source_size))
done

calculated_estimate_bytes=$(((database_size_bytes * 5 + 3) / 4))
backup_estimate_bytes=$report_backup_estimate_bytes
(( calculated_estimate_bytes > backup_estimate_bytes )) && backup_estimate_bytes=$calculated_estimate_bytes
temporary_dump_budget_bytes=$backup_estimate_bytes
minimum_required_free_bytes=$((backup_estimate_bytes + temporary_dump_budget_bytes + config_source_bytes + ROLLBACK_RESERVE_BYTES))
free_gate_bytes=$MINIMUM_FREE_BEFORE_BYTES
(( minimum_required_free_bytes > free_gate_bytes )) && free_gate_bytes=$minimum_required_free_bytes

BACKUP_PHASE='free_space_gate'
BACKUP_SAFE_COMMAND_CLASS='filesystem_metadata'
BACKUP_ERROR_CLASSIFICATION='FREE_SPACE_GATE_FAILED'
run_capture free_bytes_before filesystem_metadata FREE_SPACE_GATE_FAILED df -B1 --output=avail "$BACKUP_PARENT"
free_bytes_before=$(awk 'NR==2{print $1}' <<<"$free_bytes_before")
[[ $free_bytes_before =~ ^[0-9]+$ ]] || fail_backup 83 filesystem_metadata FREE_SPACE_GATE_FAILED
(( free_bytes_before >= free_gate_bytes )) || fail_backup 83 filesystem_metadata FREE_SPACE_GATE_FAILED

BACKUP_PHASE='container_discovery'
BACKUP_SAFE_COMMAND_CLASS='docker_ps'
BACKUP_ERROR_CLASSIFICATION='DOCKER_SERVER_UNAVAILABLE'
run_capture raw_postgres_ids docker_ps DOCKER_SERVER_UNAVAILABLE docker_read ps -q --no-trunc \
  --filter "label=$PROJECT_LABEL=$PROJECT" --filter "label=$SERVICE_LABEL=$SERVICE"
mapfile -t postgres_ids < <(printf '%s\n' "$raw_postgres_ids" | awk 'NF' | LC_ALL=C sort -u)
(( ${#postgres_ids[@]} == 1 )) || fail_backup 90 docker_ps SERVICE_CARDINALITY_CONFLICT
POSTGRES_CONTAINER_ID=${postgres_ids[0]}
[[ $POSTGRES_CONTAINER_ID =~ ^[0-9a-f]{64}$ ]] || fail_backup 90 docker_ps SERVICE_CARDINALITY_CONFLICT
run_capture observed_labels docker_inspect LABEL_MISMATCH docker_read inspect --format \
  '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Status}}' \
  "$POSTGRES_CONTAINER_ID"
[[ $observed_labels == "$PROJECT|$SERVICE|running" ]] || fail_backup 91 docker_inspect LABEL_MISMATCH

BACKUP_PHASE='production_snapshot_before'
BACKUP_SAFE_COMMAND_CLASS='docker_inspect'
BACKUP_ERROR_CLASSIFICATION='PRODUCTION_SNAPSHOT_FAILED'
collect_project_snapshot project_snapshot_before
project_snapshot_hash_before=$(hash_text "$project_snapshot_before")
container_id_hash=$(hash_text "$POSTGRES_CONTAINER_ID")
run_capture restart_count_before docker_inspect PRODUCTION_SNAPSHOT_FAILED docker_read inspect --format '{{.RestartCount}}' "$POSTGRES_CONTAINER_ID"
[[ $restart_count_before =~ ^[0-9]+$ ]] || fail_backup 65 docker_inspect PRODUCTION_SNAPSHOT_FAILED

BACKUP_PHASE='backup_directory'
BACKUP_SAFE_COMMAND_CLASS='filesystem_metadata'
BACKUP_ERROR_CLASSIFICATION='BACKUP_PATH_UNSAFE'
mkdir -m 0700 -- "$BACKUP_DIRECTORY"
PM_BACKUP_DIRECTORY_CREATED=true
chown root:root "$BACKUP_DIRECTORY"
chmod 0700 "$BACKUP_DIRECTORY"
[[ $(stat -Lc '%U:%G:%a' "$BACKUP_DIRECTORY") == root:root:700 ]] || \
  fail_backup 85 filesystem_metadata BACKUP_PATH_UNSAFE

readonly DUMP_PATH="$BACKUP_DIRECTORY/database.dump"
readonly DUMP_LIST_PATH="$BACKUP_DIRECTORY/database.list"
readonly CONFIG_ARCHIVE_PATH="$BACKUP_DIRECTORY/production-config.tar.gz"
readonly DUMP_TMP="$BACKUP_DIRECTORY/database.dump.partial"
readonly DUMP_LIST_TMP="$BACKUP_DIRECTORY/database.list.partial"
readonly CONFIG_ARCHIVE_TMP="$BACKUP_DIRECTORY/production-config.tar.gz.partial"
for output_path in "$DUMP_PATH" "$DUMP_LIST_PATH" "$CONFIG_ARCHIVE_PATH" "$DUMP_TMP" "$DUMP_LIST_TMP" "$CONFIG_ARCHIVE_TMP"; do
  [[ ! -e $output_path && ! -L $output_path ]] || fail_backup 80 filesystem_metadata BACKUP_PATH_UNSAFE
done

BACKUP_PHASE='database_dump'
BACKUP_SAFE_COMMAND_CLASS='docker_exec_read'
BACKUP_ERROR_CLASSIFICATION='DATABASE_DUMP_FAILED'
run_capture database_name_hash docker_exec_read DATABASE_DUMP_FAILED docker_read exec "$POSTGRES_CONTAINER_ID" \
  sh -ceu 'test -n "${POSTGRES_DB:-}"; printf "%s" "$POSTGRES_DB" | sha256sum | cut -d " " -f 1'
[[ $database_name_hash =~ ^[0-9a-f]{64}$ ]] || fail_backup 65 docker_exec_read DATABASE_DUMP_FAILED
run_capture postgresql_version docker_exec_read DATABASE_DUMP_FAILED docker_read exec "$POSTGRES_CONTAINER_ID" \
  sh -ceu 'test -n "${POSTGRES_USER:-}" && test -n "${POSTGRES_DB:-}"; export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000"; exec psql --no-psqlrc --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --command "SHOW server_version"'
postgresql_version=$(awk 'NF{gsub(/^[[:space:]]+|[[:space:]]+$/,""); print; exit}' <<<"$postgresql_version")
[[ $postgresql_version =~ ^[0-9]+([.][0-9]+)+ ]] || fail_backup 65 docker_exec_read DATABASE_DUMP_FAILED

BACKUP_PHASE='migration_ledger_validation'
BACKUP_SAFE_COMMAND_CLASS='migration_ledger_read'
BACKUP_ERROR_CLASSIFICATION='MIGRATION_LEDGER_UNREADABLE'
run_capture migration_ledger_state migration_ledger_read MIGRATION_LEDGER_UNREADABLE docker_read exec "$POSTGRES_CONTAINER_ID" \
  sh -ceu 'test -n "${POSTGRES_USER:-}" && test -n "${POSTGRES_DB:-}"; export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000"; exec psql --no-psqlrc --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --tuples-only --no-align --field-separator=\| --command "SELECT count(*), count(*) FILTER (WHERE finished_at IS NOT NULL), count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) FROM \"_prisma_migrations\""'
migration_ledger_state=$(awk 'NF{gsub(/[[:space:]\r]/,""); print; exit}' <<<"$migration_ledger_state")
IFS='|' read -r migration_total migration_finished migration_failed <<<"$migration_ledger_state"
[[ $migration_total =~ ^[0-9]+$ && $migration_finished =~ ^[0-9]+$ && $migration_failed =~ ^[0-9]+$ && \
  $migration_total == "$source_migration_total" && $migration_finished == "$source_migration_finished" && \
  $migration_failed == "$source_migration_failed" ]] || fail_backup 98 migration_ledger_read MIGRATION_LEDGER_UNREADABLE

BACKUP_PHASE='database_dump'
BACKUP_SAFE_COMMAND_CLASS='docker_exec_read'
BACKUP_ERROR_CLASSIFICATION='DATABASE_DUMP_FAILED'
PM_DUMP_STARTED=true
BACKUP_SAFE_COMMAND_CLASS='pg_dump_read'
BACKUP_ERROR_CLASSIFICATION='DATABASE_DUMP_FAILED'
trap - ERR
set +e
timeout --signal=TERM --kill-after=10 "$DUMP_TIMEOUT_SECONDS" docker exec "$POSTGRES_CONTAINER_ID" \
  sh -ceu 'test -n "${POSTGRES_USER:-}" && test -n "${POSTGRES_DB:-}"; export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=0 -c lock_timeout=1000"; exec pg_dump --format=custom --compress=6 --no-owner --no-acl --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"' \
  >"$DUMP_TMP" 2>/dev/null
dump_status=$?
set -e
restore_err_trap
(( dump_status == 0 )) || personal_max_backup_handle_failure "$dump_status" "$LINENO"
chmod 0600 "$DUMP_TMP"
chown root:root "$DUMP_TMP"
[[ -s $DUMP_TMP && ! -L $DUMP_TMP && $(stat -Lc '%U:%G:%a' "$DUMP_TMP") == root:root:600 ]] || \
  fail_backup 92 pg_dump_read DATABASE_DUMP_FAILED
PM_DUMP_COMPLETED=true

BACKUP_PHASE='dump_verification'
BACKUP_SAFE_COMMAND_CLASS='pg_restore_list'
BACKUP_ERROR_CLASSIFICATION='DUMP_VERIFICATION_FAILED'
trap - ERR
set +e
timeout --signal=TERM --kill-after=5 "$COMMAND_TIMEOUT_SECONDS" docker exec -i "$POSTGRES_CONTAINER_ID" \
  pg_restore --list <"$DUMP_TMP" >"$DUMP_LIST_TMP" 2>/dev/null
list_status=$?
set -e
restore_err_trap
(( list_status == 0 )) || personal_max_backup_handle_failure "$list_status" "$LINENO"
chmod 0600 "$DUMP_LIST_TMP"
chown root:root "$DUMP_LIST_TMP"
object_count=$(awk 'NF && substr($0,1,1)!=";"{n++} END{print n+0}' "$DUMP_LIST_TMP")
[[ $object_count =~ ^[1-9][0-9]*$ ]] || fail_backup 93 pg_restore_list DUMP_VERIFICATION_FAILED
run_capture dump_sha256 filesystem_metadata DUMP_VERIFICATION_FAILED sha256sum -- "$DUMP_TMP"
dump_sha256=${dump_sha256%% *}
run_capture dump_bytes filesystem_metadata DUMP_VERIFICATION_FAILED stat -Lc '%s' "$DUMP_TMP"
[[ $dump_sha256 =~ ^[0-9a-f]{64}$ && $dump_bytes =~ ^[1-9][0-9]*$ ]] || \
  fail_backup 93 filesystem_metadata DUMP_VERIFICATION_FAILED
mv --no-clobber --no-target-directory -- "$DUMP_TMP" "$DUMP_PATH"
mv --no-clobber --no-target-directory -- "$DUMP_LIST_TMP" "$DUMP_LIST_PATH"
[[ ! -e $DUMP_TMP && ! -L $DUMP_TMP && ! -e $DUMP_LIST_TMP && ! -L $DUMP_LIST_TMP && \
  -f $DUMP_PATH && ! -L $DUMP_PATH && -f $DUMP_LIST_PATH && ! -L $DUMP_LIST_PATH ]] || \
  fail_backup 93 filesystem_metadata DUMP_VERIFICATION_FAILED
PM_STRUCTURAL_VALIDATION_COMPLETED=true

BACKUP_PHASE='config_archive'
BACKUP_SAFE_COMMAND_CLASS='config_archive'
BACKUP_ERROR_CLASSIFICATION='CONFIG_ARCHIVE_FAILED'
tar --create --gzip --absolute-names --file="$CONFIG_ARCHIVE_TMP" -- "${CONFIG_SOURCE_FILES[@]}" 2>/dev/null
chmod 0600 "$CONFIG_ARCHIVE_TMP"
chown root:root "$CONFIG_ARCHIVE_TMP"
[[ -s $CONFIG_ARCHIVE_TMP && ! -L $CONFIG_ARCHIVE_TMP && \
  $(stat -Lc '%U:%G:%a' "$CONFIG_ARCHIVE_TMP") == root:root:600 ]] || \
  fail_backup 94 config_archive CONFIG_ARCHIVE_FAILED
tar --list --gzip --file="$CONFIG_ARCHIVE_TMP" >/dev/null 2>&1 || \
  fail_backup 94 config_archive CONFIG_ARCHIVE_FAILED
run_capture config_archive_sha256 filesystem_metadata CONFIG_ARCHIVE_FAILED sha256sum -- "$CONFIG_ARCHIVE_TMP"
config_archive_sha256=${config_archive_sha256%% *}
run_capture config_archive_bytes filesystem_metadata CONFIG_ARCHIVE_FAILED stat -Lc '%s' "$CONFIG_ARCHIVE_TMP"
[[ $config_archive_sha256 =~ ^[0-9a-f]{64}$ && $config_archive_bytes =~ ^[1-9][0-9]*$ ]] || \
  fail_backup 94 filesystem_metadata CONFIG_ARCHIVE_FAILED
mv --no-clobber --no-target-directory -- "$CONFIG_ARCHIVE_TMP" "$CONFIG_ARCHIVE_PATH"
[[ ! -e $CONFIG_ARCHIVE_TMP && ! -L $CONFIG_ARCHIVE_TMP && \
  -f $CONFIG_ARCHIVE_PATH && ! -L $CONFIG_ARCHIVE_PATH ]] || \
  fail_backup 94 filesystem_metadata CONFIG_ARCHIVE_FAILED
PM_CONFIG_ARCHIVE_COMPLETED=true

BACKUP_PHASE='production_snapshot_after'
BACKUP_SAFE_COMMAND_CLASS='docker_inspect'
BACKUP_ERROR_CLASSIFICATION='PRODUCTION_SNAPSHOT_FAILED'
collect_project_snapshot project_snapshot_after
project_snapshot_hash_after=$(hash_text "$project_snapshot_after")
run_capture restart_count_after docker_inspect PRODUCTION_SNAPSHOT_FAILED docker_read inspect --format '{{.RestartCount}}' "$POSTGRES_CONTAINER_ID"
[[ $restart_count_after =~ ^[0-9]+$ ]] || fail_backup 65 docker_inspect PRODUCTION_SNAPSHOT_FAILED

BACKUP_PHASE='immutability_comparison'
BACKUP_SAFE_COMMAND_CLASS='docker_inspect'
BACKUP_ERROR_CLASSIFICATION='PRODUCTION_DRIFT_DETECTED'
[[ $project_snapshot_hash_after == "$project_snapshot_hash_before" && \
  $restart_count_after == "$restart_count_before" ]] || fail_backup 95 docker_inspect PRODUCTION_DRIFT_DETECTED
run_capture free_bytes_after filesystem_metadata FREE_SPACE_GATE_FAILED df -B1 --output=avail "$BACKUP_PARENT"
free_bytes_after=$(awk 'NR==2{print $1}' <<<"$free_bytes_after")
[[ $free_bytes_after =~ ^[0-9]+$ ]] || fail_backup 83 filesystem_metadata FREE_SPACE_GATE_FAILED
(( free_bytes_after >= ROLLBACK_RESERVE_BYTES )) || fail_backup 83 filesystem_metadata FREE_SPACE_GATE_FAILED
projected_free_after_estimate=$((free_bytes_before - backup_estimate_bytes - temporary_dump_budget_bytes - config_source_bytes))
(( projected_free_after_estimate >= ROLLBACK_RESERVE_BYTES )) || fail_backup 83 filesystem_metadata FREE_SPACE_GATE_FAILED
for backup_file in "$DUMP_PATH" "$DUMP_LIST_PATH" "$CONFIG_ARCHIVE_PATH"; do
  [[ -f $backup_file && ! -L $backup_file && $(stat -Lc '%U:%G:%a' "$backup_file") == root:root:600 ]] || \
    fail_backup 85 filesystem_metadata BACKUP_PATH_UNSAFE
done

BACKUP_PHASE='metadata_render'
BACKUP_SAFE_COMMAND_CLASS='metadata_render'
BACKUP_ERROR_CLASSIFICATION='METADATA_RENDER_FAILED'
ended_at=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
[[ $started_at =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T && $ended_at =~ Z$ ]] || \
  fail_backup 96 metadata_render METADATA_RENDER_FAILED
PM_METADATA_TMP=$(mktemp "/var/tmp/personal-max-stage8b1s-production-backup.tmp.$ACTUAL_SHA256.XXXXXX")
chmod 0600 "$PM_METADATA_TMP"
jq -n \
  --arg scriptSha256 "$ACTUAL_SHA256" \
  --arg sourceReportSha256 "$observed_source_sha" \
  --arg dumpPath "$DUMP_PATH" \
  --arg dumpSha256 "$dump_sha256" \
  --arg databaseNameHash "$database_name_hash" \
  --arg postgresqlVersion "$postgresql_version" \
  --arg configArchivePath "$CONFIG_ARCHIVE_PATH" \
  --arg configArchiveSha256 "$config_archive_sha256" \
  --arg startedAt "$started_at" \
  --arg endedAt "$ended_at" \
  --arg containerIdHash "$container_id_hash" \
  --arg projectHashBefore "$project_snapshot_hash_before" \
  --arg projectHashAfter "$project_snapshot_hash_after" \
  --argjson dumpBytes "$dump_bytes" \
  --argjson configArchiveBytes "$config_archive_bytes" \
  --argjson objectCount "$object_count" \
  --argjson sourceFileCount "${#CONFIG_SOURCE_FILES[@]}" \
  --argjson restartCountBefore "$restart_count_before" \
  --argjson restartCountAfter "$restart_count_after" \
  --argjson databaseSizeEstimateBytes "$database_size_bytes" \
  --argjson migrationTotal "$migration_total" \
  --argjson migrationFinished "$migration_finished" \
  --argjson migrationFailed "$migration_failed" \
  --argjson backupEstimateBytes "$backup_estimate_bytes" \
  --argjson temporaryDumpBudgetBytes "$temporary_dump_budget_bytes" \
  --argjson minimumFreeGateBytes "$free_gate_bytes" \
  --argjson freeBytesBefore "$free_bytes_before" \
  --argjson freeBytesAfter "$free_bytes_after" \
  --argjson projectedFreeAfterEstimate "$projected_free_after_estimate" \
  '{schemaVersion:1,mode:"PRODUCTION_BACKUP_METADATA",scriptSha256:$scriptSha256,
    sourceReportSha256:$sourceReportSha256,database:{nameHash:$databaseNameHash,
    postgresqlVersion:$postgresqlVersion,sizeEstimateBytes:$databaseSizeEstimateBytes},
    dump:{path:$dumpPath,bytes:$dumpBytes,sha256:$dumpSha256,format:"custom",
    noOwner:true,noAcl:true,objectCount:$objectCount,structuralValidation:"PASS"},
    migrationLedger:{readable:true,total:$migrationTotal,finished:$migrationFinished,
    failed:$migrationFailed,sourceReportMatched:true},
    configArchive:{path:$configArchivePath,bytes:$configArchiveBytes,sha256:$configArchiveSha256,
    sourceFileCount:$sourceFileCount,contentsPrinted:false},time:{startedAt:$startedAt,endedAt:$endedAt},
    production:{containerIdHash:$containerIdHash,containerHashes:{before:$projectHashBefore,
    after:$projectHashAfter},restartCount:{before:$restartCountBefore,after:$restartCountAfter}},
    storage:{backupEstimateBytes:$backupEstimateBytes,temporaryDumpBudgetBytes:$temporaryDumpBudgetBytes,
    minimumFreeGateBytes:$minimumFreeGateBytes,freeBytesBefore:$freeBytesBefore,
    freeBytesAfter:$freeBytesAfter,projectedFreeAfterEstimate:$projectedFreeAfterEstimate,
    rollbackReserveBytes:5368709120},
    restore:{BACKUP_STRUCTURAL_VALIDATION:"PASS",FULL_RESTORE_PROOF:"PENDING_ISOLATED_ROOT_PROBE"},
    safety:{DockerMutation:false,DDL:false,DML:false,migration:false,restart:false,deploy:false,
    imagePull:false,imageLoad:false,browserLaunched:false,maxContacted:false,providerAction:false,
    secretsPrinted:false,messageDataPrinted:false}}' >"$PM_METADATA_TMP"
jq -e '.mode=="PRODUCTION_BACKUP_METADATA" and .dump.structuralValidation=="PASS" and
  .migrationLedger.readable==true and .migrationLedger.sourceReportMatched==true and
  .restore.FULL_RESTORE_PROOF=="PENDING_ISOLATED_ROOT_PROBE" and .safety.DDL==false and
  .safety.DML==false and .safety.migration==false and .safety.restart==false and
  .safety.deploy==false and .safety.secretsPrinted==false' "$PM_METADATA_TMP" >/dev/null || \
  fail_backup 96 metadata_render METADATA_RENDER_FAILED

BACKUP_PHASE='report_handoff'
BACKUP_SAFE_COMMAND_CLASS='report_handoff'
BACKUP_ERROR_CLASSIFICATION='REPORT_HANDOFF_FAILED'
chgrp codexbot "$PM_METADATA_TMP"
chmod 0640 "$PM_METADATA_TMP"
metadata_identity=$(stat -Lc '%d:%i' "$PM_METADATA_TMP")
[[ $(stat -Lc '%U:%G:%a' "$PM_METADATA_TMP") == root:codexbot:640 ]] || \
  fail_backup 97 report_handoff REPORT_HANDOFF_FAILED
mv --no-clobber --no-target-directory -- "$PM_METADATA_TMP" "$SUCCESS_REPORT"
PM_METADATA_TMP=''
[[ -f $SUCCESS_REPORT && ! -L $SUCCESS_REPORT && \
  $(stat -Lc '%d:%i' "$SUCCESS_REPORT") == "$metadata_identity" && \
  $(stat -Lc '%U:%G:%a' "$SUCCESS_REPORT") == root:codexbot:640 ]] || \
  fail_backup 97 report_handoff REPORT_HANDOFF_FAILED
timeout 5 runuser -u codexbot -- test -r "$SUCCESS_REPORT" || fail_backup 97 report_handoff REPORT_HANDOFF_FAILED
if timeout 5 runuser -u codexbot -- test -w "$SUCCESS_REPORT"; then
  fail_backup 97 report_handoff REPORT_HANDOFF_FAILED
fi
success_report_sha=$(sha256sum -- "$SUCCESS_REPORT" | awk '{print $1}')
[[ $success_report_sha =~ ^[0-9a-f]{64}$ ]] || fail_backup 97 report_handoff REPORT_HANDOFF_FAILED

BACKUP_PHASE='completed'
trap - ERR
trap - EXIT
printf 'BACKUP_COMPLETED\nSANITIZED_RESULT_PATH=%s\nSANITIZED_RESULT_SHA256=%s\nDB_DUMP_PATH=%s\nDB_DUMP_SHA256=%s\nDB_DUMP_BYTES=%s\nCONFIG_ARCHIVE_PATH=%s\nCONFIG_ARCHIVE_SHA256=%s\nCONFIG_ARCHIVE_BYTES=%s\nOBJECT_COUNT=%s\nREPORT_OWNER=root\nREPORT_GROUP=codexbot\nREPORT_MODE=0640\nBACKUP_STRUCTURAL_VALIDATION=PASS\nFULL_RESTORE_PROOF=PENDING_ISOLATED_ROOT_PROBE\nCODEXBOT_READABLE=YES\nCODEXBOT_WRITABLE=NO\nPRODUCTION_RESTARTED=NO\nDDL=NO\nDML=NO\nMIGRATION=NO\nDEPLOY=NO\n' \
  "$SUCCESS_REPORT" "$success_report_sha" "$DUMP_PATH" "$dump_sha256" "$dump_bytes" \
  "$CONFIG_ARCHIVE_PATH" "$config_archive_sha256" "$config_archive_bytes" "$object_count"
