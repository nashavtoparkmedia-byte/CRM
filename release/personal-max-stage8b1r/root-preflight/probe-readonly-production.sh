#!/usr/bin/env bash
# Dynamic capture targets, sourced diagnostics globals, and single-quoted jq/awk programs are intentional.
# shellcheck disable=SC1091,SC2016,SC2034,SC2154
set -Eeuo pipefail
umask 077

readonly COMPOSE_FILE='/opt/crm/deploy/docker-compose.production.yml'
readonly PROJECT='crm'
readonly PROJECT_LABEL='com.docker.compose.project'
readonly SERVICE_LABEL='com.docker.compose.service'
readonly GATEWAY_IMAGE='ghcr.io/nashavtoparkmedia-byte/crm-max-personal-gateway@sha256:dd718fd8e9e2ec52a0ee1c19b576d75a1035f9e251980351ebc04071dfe5d0de'
readonly SCRAPER_IMAGE='ghcr.io/nashavtoparkmedia-byte/crm-max-web-scraper@sha256:abf4405f55ab1c84f319b00cdb8b561f76353001ba2543045fddb17dc6b46768'
readonly GATEWAY_COMPRESSED_BYTES=150067770
readonly SCRAPER_COMPRESSED_BYTES=714626133
readonly RESULT_PATH_EXPECTED='/var/tmp/personal-max-stage8b1r-production-readonly-preflight.json'
readonly RESULT_PATH=${PERSONAL_MAX_PREFLIGHT_RESULT_PATH:-$RESULT_PATH_EXPECTED}
readonly EXPECTED_SHA256=${PERSONAL_MAX_PREFLIGHT_SCRIPT_SHA256:-}
readonly FAILURE_PATH_PREFIX='/var/tmp/personal-max-stage8b1r-production-readonly-preflight.failure'
readonly FAILURE_DIAGNOSTICS_SHA256='0fd3e8a5b9c2c9df1762cb8ecb6ab3210dffc2cd645c25a8aa4c4a5270634d49'
readonly COMMAND_TIMEOUT_SECONDS=15
readonly DB_STATEMENT_TIMEOUT_MS=5000
readonly DB_LOCK_TIMEOUT_MS=1000

bootstrap_fail() {
  printf '%s\n' "$1" >&2
  exit "$2"
}

(( EUID == 0 )) || bootstrap_fail 'ROOT_REQUIRED' 77
[[ $EXPECTED_SHA256 =~ ^[0-9a-f]{64}$ ]] || bootstrap_fail 'CHECKSUM_BINDING_REQUIRED' 78

for mandatory_binary in awk chgrp chmod date df dirname docker find findmnt getent jq mktemp mv realpath rm runuser sed sha256sum sort stat tail timeout uname; do
  command -v "$mandatory_binary" >/dev/null 2>&1 || bootstrap_fail "MANDATORY_BINARY_MISSING: $mandatory_binary" 76
done

SCRIPT_PATH=$(realpath -- "${BASH_SOURCE[0]}") || bootstrap_fail 'SCRIPT_OR_RELEASE_UNREADABLE' 75
SCRIPT_DIR=$(dirname -- "$SCRIPT_PATH") || bootstrap_fail 'SCRIPT_OR_RELEASE_UNREADABLE' 75
RELEASE_ROOT=$(realpath -- "$SCRIPT_DIR/../../..") || bootstrap_fail 'SCRIPT_OR_RELEASE_UNREADABLE' 75
FAILURE_DIAGNOSTICS_PATH="$SCRIPT_DIR/failure-diagnostics.sh"
if [[ ! -r $SCRIPT_PATH || ! -r $FAILURE_DIAGNOSTICS_PATH || ! -r $RELEASE_ROOT/release/personal-max-stage8b1r/release-manifest.json || \
  ! -d $RELEASE_ROOT/gravity-mvp/prisma/migrations || ! -r $RELEASE_ROOT/gravity-mvp/prisma/migrations ]]; then
  bootstrap_fail 'SCRIPT_OR_RELEASE_UNREADABLE' 75
fi

ACTUAL_SHA256=$(sha256sum -- "$SCRIPT_PATH" | awk '{print $1}') || bootstrap_fail 'CHECKSUM_MISMATCH' 79
[[ $ACTUAL_SHA256 == "$EXPECTED_SHA256" ]] || bootstrap_fail 'CHECKSUM_MISMATCH' 79
ACTUAL_FAILURE_DIAGNOSTICS_SHA256=$(sha256sum -- "$FAILURE_DIAGNOSTICS_PATH" | awk '{print $1}') || bootstrap_fail 'CHECKSUM_MISMATCH' 79
[[ $ACTUAL_FAILURE_DIAGNOSTICS_SHA256 == "$FAILURE_DIAGNOSTICS_SHA256" ]] || bootstrap_fail 'CHECKSUM_MISMATCH' 79

if [[ $RESULT_PATH != "$RESULT_PATH_EXPECTED" || -e $RESULT_PATH || -L $RESULT_PATH ]]; then
  bootstrap_fail 'RESULT_PATH_UNSAFE' 80
fi
readonly FAILURE_PATH="$FAILURE_PATH_PREFIX.$ACTUAL_SHA256.json"
if [[ -e $FAILURE_PATH || -L $FAILURE_PATH ]]; then
  bootstrap_fail 'FAILURE_REPORT_PATH_UNSAFE' 80
fi
timeout 5 getent group codexbot >/dev/null 2>&1 || bootstrap_fail 'HANDOFF_GROUP_MISSING: codexbot' 84

# shellcheck source=release/personal-max-stage8b1r/root-preflight/failure-diagnostics.sh
source "$FAILURE_DIAGNOSTICS_PATH"

PREFLIGHT_PHASE='bootstrap_complete'
PREFLIGHT_SAFE_COMMAND_CLASS='unknown'
PREFLIGHT_ERROR_CLASSIFICATION='UNEXPECTED_COMMAND_FAILURE'
PM_DOCKER_METADATA_BEGUN=false
PM_POSTGRESQL_SESSION_BEGUN=false
PM_FAILURE_HANDLER_ACTIVE=false
PM_SUCCESS_TMP=''
PM_FAILURE_TMP=''
PSQL_CLASSIFIER_TMP=''
readonly PM_SCRIPT_SHA256="$ACTUAL_SHA256"
readonly PM_SUCCESS_PATH="$RESULT_PATH"
readonly PM_FAILURE_PATH="$FAILURE_PATH"
readonly PM_FAILURE_TMP_PREFIX="$FAILURE_PATH_PREFIX.tmp.$ACTUAL_SHA256"
readonly PM_REPORT_OWNER='root'
readonly PM_REPORT_GROUP='codexbot'
readonly PM_REPORT_READER='codexbot'
readonly PM_VERIFY_PRINCIPAL_ACCESS=true

restore_err_trap() {
  trap 'personal_max_handle_unexpected_failure "$?" "$LINENO"' ERR
}

cleanup_owned_temporary_files() {
  trap - ERR
  set +e
  if [[ -n ${PSQL_CLASSIFIER_TMP:-} && ( -e ${PSQL_CLASSIFIER_TMP:-} || -L ${PSQL_CLASSIFIER_TMP:-} ) ]]; then
    rm -f -- "$PSQL_CLASSIFIER_TMP" >/dev/null 2>&1
  fi
  if [[ -n ${PM_SUCCESS_TMP:-} && ( -e ${PM_SUCCESS_TMP:-} || -L ${PM_SUCCESS_TMP:-} ) ]]; then
    rm -f -- "$PM_SUCCESS_TMP" >/dev/null 2>&1
  fi
  if [[ -n ${PM_FAILURE_TMP:-} && ( -e ${PM_FAILURE_TMP:-} || -L ${PM_FAILURE_TMP:-} ) ]]; then
    rm -f -- "$PM_FAILURE_TMP" >/dev/null 2>&1
  fi
}

restore_err_trap
trap cleanup_owned_temporary_files EXIT

fail_unexpected() {
  local exit_code=$1 safe_class=$2 classification=$3
  local source_line=${BASH_LINENO[0]:-0}
  PREFLIGHT_SAFE_COMMAND_CLASS=$safe_class
  PREFLIGHT_ERROR_CLASSIFICATION=$classification
  personal_max_handle_unexpected_failure "$exit_code" "$source_line"
}

run_required_capture() {
  local target_name=$1 safe_class=$2 classification=$3
  local captured_output command_status source_line
  shift 3
  source_line=${BASH_LINENO[0]:-0}
  PREFLIGHT_SAFE_COMMAND_CLASS=$safe_class
  PREFLIGHT_ERROR_CLASSIFICATION=$classification
  trap - ERR
  set +e
  captured_output=$("$@" 2>/dev/null)
  command_status=$?
  set -e
  restore_err_trap
  if (( command_status != 0 )); then
    personal_max_handle_unexpected_failure "$command_status" "$source_line"
  fi
  printf -v "$target_name" '%s' "$captured_output"
}

run_required_no_output() {
  local ignored_output
  run_required_capture ignored_output "$@"
}

run_optional_capture() {
  local target_name=$1
  local captured_output command_status
  shift
  trap - ERR
  set +e
  captured_output=$("$@" 2>/dev/null)
  command_status=$?
  set -e
  restore_err_trap
  printf -v "$target_name" '%s' "$captured_output"
  PROBE_STATUS=$command_status
}

require_nonempty() {
  local value=$1 safe_class=$2 classification=$3
  [[ -n $value ]] || fail_unexpected 65 "$safe_class" "$classification"
}

require_uint() {
  local value=$1 safe_class=$2 classification=$3
  [[ $value =~ ^[0-9]+$ ]] || fail_unexpected 65 "$safe_class" "$classification"
}

require_boolean() {
  local value=$1 safe_class=$2 classification=$3
  [[ $value == true || $value == false ]] || fail_unexpected 65 "$safe_class" "$classification"
}

jq_filter_text() {
  local filter=$1 input_text=$2
  jq -c "$filter" <<<"$input_text"
}

jq_validate_text() {
  local filter=$1 input_text=$2
  jq -e "$filter" >/dev/null <<<"$input_text"
}

require_json() {
  local value=$1 filter=${2:-.}
  local ignored
  run_optional_capture ignored jq_validate_text "$filter" "$value"
  (( PROBE_STATUS == 0 )) || fail_unexpected 65 jq_render JSON_RENDER_FAILED
}

hash_literal() {
  printf '%s\n' "$1" | sha256sum | awk '{print $1}'
}

hash_value() {
  local target_name=$1 value=$2
  run_required_capture "$target_name" filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE hash_literal "$value"
}

sort_unique_text() {
  LC_ALL=C sort -u <<<"$1"
}

docker_read() {
  timeout --signal=TERM --kill-after=2 "$COMMAND_TIMEOUT_SECONDS" docker "$@"
}

verify_container_labels() {
  local container_id=$1 expected_service=${2:-}
  local labels observed_project observed_service
  run_required_capture labels docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format \
    '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' "$container_id"
  IFS='|' read -r observed_project observed_service <<<"$labels"
  [[ $observed_project == "$PROJECT" ]] || fail_unexpected 90 docker_inspect PROJECT_LABEL_MISMATCH
  if [[ -n $expected_service && $observed_service != "$expected_service" ]]; then
    fail_unexpected 91 docker_inspect SERVICE_LABEL_MISMATCH
  fi
}

collect_project_snapshot() {
  local target_name=$1
  local raw_list sorted_list container_id result=''
  run_required_capture raw_list docker_ps DOCKER_METADATA_UNAVAILABLE docker_read ps -aq --no-trunc \
    --filter "label=$PROJECT_LABEL=$PROJECT"
  run_required_capture sorted_list docker_ps DOCKER_METADATA_UNAVAILABLE sort_unique_text "$raw_list"
  while IFS= read -r container_id; do
    [[ -n $container_id ]] || continue
    [[ $container_id =~ ^[0-9a-f]{64}$ ]] || fail_unexpected 65 docker_ps DOCKER_METADATA_UNAVAILABLE
    verify_container_labels "$container_id"
    [[ -z $result ]] || result+=$'\n'
    result+=$container_id
  done <<<"$sorted_list"
  printf -v "$target_name" '%s' "$result"
}

collect_service_snapshot() {
  local target_name=$1 container_list=$2
  local container_id row result=''
  while IFS= read -r container_id; do
    [[ -n $container_id ]] || continue
    verify_container_labels "$container_id"
    run_required_capture row docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format \
      '{{.Id}}|{{.State.Status}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.Config.Image}}' "$container_id"
    require_nonempty "$row" docker_inspect DOCKER_METADATA_UNAVAILABLE
    [[ -z $result ]] || result+=$'\n'
    result+=$row
  done <<<"$container_list"
  printf -v "$target_name" '%s' "$result"
}

collect_volume_snapshot() {
  local target_name=$1 raw_list sorted_list
  run_required_capture raw_list docker_volume_ls DOCKER_METADATA_UNAVAILABLE docker_read volume ls -q
  run_required_capture sorted_list docker_volume_ls DOCKER_METADATA_UNAVAILABLE sort_unique_text "$raw_list"
  printf -v "$target_name" '%s' "$sorted_list"
}

discover_running_service() {
  local target_name=$1 service=$2
  local raw_list sorted_list container_id discovery_class discovery_error
  local -a container_ids=()
  discovery_class=docker_ps
  discovery_error=DOCKER_METADATA_UNAVAILABLE
  if [[ $service == postgres ]]; then
    discovery_class=postgres_discovery
    discovery_error=POSTGRES_DISCOVERY_UNAVAILABLE
  fi
  run_required_capture raw_list "$discovery_class" "$discovery_error" docker_read ps -q --no-trunc \
    --filter "label=$PROJECT_LABEL=$PROJECT" --filter "label=$SERVICE_LABEL=$service"
  run_required_capture sorted_list docker_ps DOCKER_METADATA_UNAVAILABLE sort_unique_text "$raw_list"
  if [[ -n $sorted_list ]]; then
    mapfile -t container_ids <<<"$sorted_list"
  fi
  case ${#container_ids[@]} in
    0)
      printf -v "$target_name" '%s' ''
      ;;
    1)
      container_id=${container_ids[0]}
      [[ $container_id =~ ^[0-9a-f]{64}$ ]] || fail_unexpected 65 "$discovery_class" "$discovery_error"
      verify_container_labels "$container_id" "$service"
      printf -v "$target_name" '%s' "$container_id"
      ;;
    *)
      fail_unexpected 92 "$discovery_class" SERVICE_CARDINALITY_CONFLICT
      ;;
  esac
}

df_block_row() {
  df -B1 -P "$1" | awk 'NR==2{print $2"|"$3"|"$4"|"$5}'
}

df_inode_row() {
  df -PiP "$1" | awk 'NR==2{print $2"|"$3"|"$4"|"$5}'
}

collect_disk_row() {
  local target_name=$1 requested_path=$2 existing_path=$2
  local mount_raw mount_json block_line inode_line parent
  local total_bytes used_bytes available_bytes used_percent inode_total inode_used inode_available inode_used_percent result
  while [[ ! -e $existing_path && $existing_path != / ]]; do
    run_required_capture parent filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE dirname -- "$existing_path"
    existing_path=$parent
  done
  run_required_capture mount_raw filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE findmnt -J -T "$existing_path" -o TARGET,SOURCE,FSTYPE,OPTIONS
  run_required_capture mount_json jq_render JSON_RENDER_FAILED jq_filter_text '.filesystems[0]' "$mount_raw"
  require_json "$mount_json" 'type=="object"'
  run_required_capture block_line filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE df_block_row "$existing_path"
  run_required_capture inode_line filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE df_inode_row "$existing_path"
  IFS='|' read -r total_bytes used_bytes available_bytes used_percent <<<"$block_line"
  IFS='|' read -r inode_total inode_used inode_available inode_used_percent <<<"$inode_line"
  require_uint "$total_bytes" filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE
  require_uint "$used_bytes" filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE
  require_uint "$available_bytes" filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE
  require_uint "$inode_total" filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE
  require_uint "$inode_used" filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE
  require_uint "$inode_available" filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE
  run_required_capture result jq_render JSON_RENDER_FAILED jq -nc --arg path "$requested_path" --arg resolvedPath "$existing_path" \
    --argjson mount "$mount_json" --argjson totalBytes "$total_bytes" --argjson usedBytes "$used_bytes" \
    --argjson availableBytes "$available_bytes" --arg usedPercent "$used_percent" --argjson inodeTotal "$inode_total" \
    --argjson inodeUsed "$inode_used" --argjson inodeAvailable "$inode_available" --arg inodeUsedPercent "$inode_used_percent" \
    '{path:$path,resolvedPath:$resolvedPath,mount:$mount,totalBytes:$totalBytes,usedBytes:$usedBytes,availableBytes:$availableBytes,usedPercent:$usedPercent,inodes:{total:$inodeTotal,used:$inodeUsed,available:$inodeAvailable,usedPercent:$inodeUsedPercent}}'
  printf -v "$target_name" '%s' "$result"
}

collect_image_fact() {
  local target_name=$1 ref=$2 compressed_bytes=$3
  local image_id image_size repo_digests_raw repo_digests result
  PREFLIGHT_SAFE_COMMAND_CLASS=docker_image_inspect
  PREFLIGHT_ERROR_CLASSIFICATION=DOCKER_METADATA_UNAVAILABLE
  run_optional_capture image_id docker_read image inspect --format '{{.Id}}' "$ref"
  case $PROBE_STATUS in
    0)
      require_nonempty "$image_id" docker_image_inspect DOCKER_METADATA_UNAVAILABLE
      run_required_capture image_size docker_image_inspect DOCKER_METADATA_UNAVAILABLE docker_read image inspect --format '{{.Size}}' "$ref"
      require_uint "$image_size" docker_image_inspect DOCKER_METADATA_UNAVAILABLE
      run_required_capture repo_digests_raw docker_image_inspect DOCKER_METADATA_UNAVAILABLE docker_read image inspect --format '{{json .RepoDigests}}' "$ref"
      run_required_capture repo_digests jq_render JSON_RENDER_FAILED jq_filter_text '(.//[])|sort' "$repo_digests_raw"
      require_json "$repo_digests" 'type=="array"'
      run_required_capture result jq_render JSON_RENDER_FAILED jq -nc --arg ref "$ref" --argjson compressedBytes "$compressed_bytes" \
        --arg imageId "$image_id" --argjson localUnpackedBytes "$image_size" --argjson repoDigests "$repo_digests" \
        '{ref:$ref,presentLocally:true,compressedRegistryBytes:$compressedBytes,imageId:$imageId,localUnpackedBytes:$localUnpackedBytes,repoDigests:$repoDigests}'
      ;;
    1)
      run_required_capture result jq_render JSON_RENDER_FAILED jq -nc --arg ref "$ref" --argjson compressedBytes "$compressed_bytes" \
        '{ref:$ref,presentLocally:false,compressedRegistryBytes:$compressedBytes,imageId:null,localUnpackedBytes:null,repoDigests:[]}'
      ;;
    *)
      fail_unexpected "$PROBE_STATUS" docker_image_inspect DOCKER_METADATA_UNAVAILABLE
      ;;
  esac
  printf -v "$target_name" '%s' "$result"
}

classify_psql_stderr() {
  awk 'BEGIN { result="unavailable" }
    { line=tolower($0) }
    line ~ /permission denied|insufficient privilege|must be owner|not permitted/ { result="permission_denied" }
    END { print result }'
}

run_psql_query() {
  local target_name=$1 sql=$2
  local captured_output command_status stderr_class source_line temp_status
  source_line=${BASH_LINENO[0]:-0}
  PREFLIGHT_SAFE_COMMAND_CLASS=psql_catalog
  PREFLIGHT_ERROR_CLASSIFICATION=PSQL_UNAVAILABLE
  trap - ERR
  set +e
  PSQL_CLASSIFIER_TMP=$(mktemp /var/tmp/personal-max-stage8b1r-psql-classification.tmp.XXXXXX)
  temp_status=$?
  if (( temp_status == 0 )); then
    chmod 0600 "$PSQL_CLASSIFIER_TMP"
    temp_status=$?
  fi
  set -e
  restore_err_trap
  if (( temp_status != 0 )); then
    personal_max_handle_unexpected_failure "$temp_status" "$source_line"
  fi

  trap - ERR
  set +e
  # shellcheck disable=SC2016 # POSTGRES_* and positional parameters expand only in the container shell.
  captured_output=$(timeout --signal=TERM --kill-after=2 "$COMMAND_TIMEOUT_SECONDS" docker exec "$postgres_id" sh -ceu '
    export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=$2 -c lock_timeout=$3"
    exec psql --no-psqlrc -v ON_ERROR_STOP=1 -X -A -t --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "$1"
  ' sh "$sql" "$DB_STATEMENT_TIMEOUT_MS" "$DB_LOCK_TIMEOUT_MS" 2> >(classify_psql_stderr >"$PSQL_CLASSIFIER_TMP"))
  command_status=$?
  stderr_class=$(<"$PSQL_CLASSIFIER_TMP")
  rm -f -- "$PSQL_CLASSIFIER_TMP"
  temp_status=$?
  PSQL_CLASSIFIER_TMP=''
  set -e
  restore_err_trap
  if (( temp_status != 0 )); then
    PREFLIGHT_ERROR_CLASSIFICATION=FILESYSTEM_METADATA_UNAVAILABLE
    personal_max_handle_unexpected_failure "$temp_status" "$source_line"
  fi
  if (( command_status == 124 )); then
    PREFLIGHT_ERROR_CLASSIFICATION=PSQL_TIMEOUT
    personal_max_handle_unexpected_failure "$command_status" "$source_line"
  fi
  if (( command_status != 0 )); then
    if [[ $stderr_class == permission_denied ]]; then
      PREFLIGHT_ERROR_CLASSIFICATION=PSQL_PERMISSION_DENIED
    else
      PREFLIGHT_ERROR_CLASSIFICATION=PSQL_UNAVAILABLE
    fi
    personal_max_handle_unexpected_failure "$command_status" "$source_line"
  fi
  if [[ -z $captured_output ]]; then
    PREFLIGHT_ERROR_CLASSIFICATION=PSQL_MALFORMED_OUTPUT
    personal_max_handle_unexpected_failure 65 "$source_line"
  fi
  PSQL_QUERY_STATUS=success
  printf -v "$target_name" '%s' "$captured_output"
}

find_expected_migrations() {
  find "$RELEASE_ROOT/gravity-mvp/prisma/migrations" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | \
    LC_ALL=C sort | jq -R . | jq -s .
}

latest_backup_metadata() {
  timeout 5 find "$1" -maxdepth 2 -type f -printf '%T@|%s|%p\n' | LC_ALL=C sort -nr | sed -n '1p'
}

add_incomplete_fact() {
  local code=$1 updated
  run_required_capture updated jq_render JSON_RENDER_FAILED jq -c --arg code "$code" '. + [$code] | unique' <<<"$incomplete_facts"
  incomplete_facts=$updated
}

run_required_capture PM_SUCCESS_TMP report_handoff REPORT_HANDOFF_FAILED mktemp \
  /var/tmp/personal-max-stage8b1r-production-readonly-preflight.tmp.XXXXXX
run_required_no_output report_handoff REPORT_HANDOFF_FAILED chmod 0600 "$PM_SUCCESS_TMP"

PREFLIGHT_PHASE='docker_server_metadata'
PM_DOCKER_METADATA_BEGUN=true
run_required_capture docker_server_version docker_info DOCKER_SERVER_UNAVAILABLE docker_read version --format '{{.Server.Version}}'
require_nonempty "$docker_server_version" docker_info DOCKER_SERVER_UNAVAILABLE
run_required_capture docker_root docker_info DOCKER_SERVER_UNAVAILABLE docker_read info --format '{{.DockerRootDir}}'
require_nonempty "$docker_root" docker_info DOCKER_SERVER_UNAVAILABLE
run_required_capture docker_driver docker_info DOCKER_SERVER_UNAVAILABLE docker_read info --format '{{.Driver}}'
require_nonempty "$docker_driver" docker_info DOCKER_SERVER_UNAVAILABLE
run_required_capture docker_runtime_raw docker_info DOCKER_SERVER_UNAVAILABLE docker_read info --format '{{json .Runtimes}}'
run_required_capture docker_runtime jq_render JSON_RENDER_FAILED jq_filter_text '(.//{})|keys|sort' "$docker_runtime_raw"
require_json "$docker_runtime" 'type=="array"'

PREFLIGHT_PHASE='project_container_discovery_before'
collect_project_snapshot containers_before
hash_value containers_before_hash "$containers_before"

PREFLIGHT_PHASE='production_service_snapshot_before'
collect_service_snapshot services_before "$containers_before"
hash_value services_before_hash "$services_before"

PREFLIGHT_PHASE='volume_snapshot_before'
collect_volume_snapshot volumes_before
hash_value volumes_before_hash "$volumes_before"

PREFLIGHT_PHASE='filesystem_snapshot_before'
collect_disk_row disk_before /opt/crm

PREFLIGHT_PHASE='host_metadata'
run_required_capture os_id filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE awk -F= '$1=="ID"{gsub(/"/,"",$2);print $2}' /etc/os-release
run_required_capture os_version filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE awk -F= '$1=="VERSION_ID"{gsub(/"/,"",$2);print $2}' /etc/os-release
run_required_capture kernel filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE uname -sr
run_required_capture architecture filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE uname -m
run_required_capture compose_file_sha256 filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE sha256sum -- "$COMPOSE_FILE"
compose_file_sha256=${compose_file_sha256%% *}
[[ $compose_file_sha256 =~ ^[0-9a-f]{64}$ ]] || fail_unexpected 65 filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE
run_required_capture compose_file_size filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE stat -Lc '%s' "$COMPOSE_FILE"
run_required_capture compose_file_mode filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE stat -Lc '%a' "$COMPOSE_FILE"
require_uint "$compose_file_size" filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE
require_uint "$compose_file_mode" filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE

PREFLIGHT_PHASE='service_inventory'
service_rows='[]'
postgres_data_path=''
while IFS= read -r id; do
  [[ -n $id ]] || continue
  run_required_capture labels docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format \
    '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}' "$id"
  IFS='|' read -r observed_project service <<<"$labels"
  [[ $observed_project == "$PROJECT" ]] || fail_unexpected 90 docker_inspect PROJECT_LABEL_MISMATCH
  [[ -n $service && $service != '<no value>' ]] || service='unlabelled'
  run_required_capture container_id docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format '{{.Id}}' "$id"
  run_required_capture container_name docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format '{{.Name}}' "$id"
  container_name=${container_name#/}
  run_required_capture image_id docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format '{{.Image}}' "$id"
  run_required_capture configured_image docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format '{{.Config.Image}}' "$id"
  run_required_capture configured_user docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format '{{.Config.User}}' "$id"
  run_required_capture repo_digests_raw docker_image_inspect DOCKER_METADATA_UNAVAILABLE docker_read image inspect --format '{{json .RepoDigests}}' "$image_id"
  run_required_capture repo_digests jq_render JSON_RENDER_FAILED jq_filter_text '(.//[])|sort' "$repo_digests_raw"
  require_json "$repo_digests" 'type=="array"'
  run_required_capture pid docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format '{{.State.Pid}}' "$id"
  run_required_capture mounts_raw docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format '{{json .Mounts}}' "$id"
  run_required_capture mounts jq_render JSON_RENDER_FAILED jq_filter_text '(.//[])|map({type:.Type,name:(.Name//null),source:.Source,destination:.Destination,readWrite:.RW})' "$mounts_raw"
  require_json "$mounts" 'type=="array"'
  run_required_capture networks_raw docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format '{{json .NetworkSettings.Networks}}' "$id"
  run_required_capture networks jq_render JSON_RENDER_FAILED jq_filter_text '(.//{})|keys|sort' "$networks_raw"
  require_json "$networks" 'type=="array"'
  run_required_capture ports_raw docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format '{{json .NetworkSettings.Ports}}' "$id"
  run_required_capture ports jq_render JSON_RENDER_FAILED jq_filter_text './/{}' "$ports_raw"
  require_json "$ports" 'type=="object"'
  run_required_capture restart_policy docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$id"
  run_required_capture health docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}not-configured{{end}}' "$id"
  run_required_capture status docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format '{{.State.Status}}' "$id"
  run_required_capture running docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format '{{.State.Running}}' "$id"
  run_required_capture restart_count docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format '{{.RestartCount}}' "$id"
  run_required_capture started_at docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format '{{.State.StartedAt}}' "$id"
  require_boolean "$running" docker_inspect DOCKER_METADATA_UNAVAILABLE
  require_uint "$restart_count" docker_inspect DOCKER_METADATA_UNAVAILABLE
  runtime_uid='unavailable'
  runtime_gid='unavailable'
  if [[ $pid =~ ^[1-9][0-9]*$ && -r /proc/$pid/status ]]; then
    run_optional_capture runtime_uid_candidate awk '/^Uid:/{print $2}' "/proc/$pid/status"
    if (( PROBE_STATUS == 0 )) && [[ $runtime_uid_candidate =~ ^[0-9]+$ ]]; then runtime_uid=$runtime_uid_candidate; fi
    run_optional_capture runtime_gid_candidate awk '/^Gid:/{print $2}' "/proc/$pid/status"
    if (( PROBE_STATUS == 0 )) && [[ $runtime_gid_candidate =~ ^[0-9]+$ ]]; then runtime_gid=$runtime_gid_candidate; fi
  fi
  run_required_capture metadata jq_render JSON_RENDER_FAILED jq -nc --arg id "$container_id" --arg name "$container_name" \
    --arg imageId "$image_id" --argjson repoDigests "$repo_digests" --arg configuredImage "$configured_image" \
    --arg configuredUser "$configured_user" --argjson mounts "$mounts" --argjson networks "$networks" --argjson ports "$ports" \
    --arg restartPolicy "$restart_policy" --arg health "$health" --arg status "$status" --argjson running "$running" \
    --argjson restartCount "$restart_count" --arg startedAt "$started_at" \
    '{id:$id,name:$name,imageId:$imageId,repoDigests:$repoDigests,configuredImage:$configuredImage,configuredUser:$configuredUser,mounts:$mounts,networks:$networks,ports:$ports,restartPolicy:$restartPolicy,health:$health,status:$status,running:$running,restartCount:$restartCount,startedAt:$startedAt}'
  run_required_capture service_rows jq_render JSON_RENDER_FAILED jq -c --arg service "$service" --arg runtimeUid "$runtime_uid" \
    --arg runtimeGid "$runtime_gid" --argjson metadata "$metadata" '. + [{service:$service,runtimeUid:$runtimeUid,runtimeGid:$runtimeGid,metadata:$metadata}]' <<<"$service_rows"
  if [[ $service == postgres && $running == true ]]; then
    run_required_capture postgres_data_path jq_render JSON_RENDER_FAILED jq -r 'first(.[]?|select(.destination=="/var/lib/postgresql/data")|.source)//""' <<<"$mounts"
  fi
done <<<"$containers_before"
run_required_capture dependencies jq_render JSON_RENDER_FAILED jq -c \
  '[.[] as $service | $service.metadata.networks[]? | {network:.,service:$service.service}] | group_by(.network) | map({network:.[0].network,services:(map(.service)|sort)})' <<<"$service_rows"

PREFLIGHT_PHASE='scraper_discovery'
scraper='{"observable":false,"status":"SERVICE_NOT_RUNNING","reason":"max-web-scraper has no running project-labeled container"}'
scraper_id=''
scraper_top_available=false
discover_running_service scraper_id max-web-scraper

PREFLIGHT_PHASE='scraper_process_metadata'
if [[ -n $scraper_id ]]; then
  PREFLIGHT_SAFE_COMMAND_CLASS=docker_top
  PREFLIGHT_ERROR_CLASSIFICATION=DOCKER_METADATA_UNAVAILABLE
  run_optional_capture process_table docker_read top "$scraper_id" -eo uid,gid,comm
  case $PROBE_STATUS in
    0)
      scraper_top_available=true
      run_required_capture process_rows docker_top DOCKER_METADATA_UNAVAILABLE tail -n +2 <<<"$process_table"
      run_required_capture node_count docker_top DOCKER_METADATA_UNAVAILABLE awk '$3=="node" || $3=="tini"{count++} END{print count+0}' <<<"$process_rows"
      run_required_capture browser_count docker_top DOCKER_METADATA_UNAVAILABLE awk 'tolower($3) ~ /^(chromium|chrome|chrome_crashpad|headless_shell)$/{count++} END{print count+0}' <<<"$process_rows"
      require_uint "$node_count" docker_top DOCKER_METADATA_UNAVAILABLE
      require_uint "$browser_count" docker_top DOCKER_METADATA_UNAVAILABLE
      ;;
    1 | 124)
      node_count=0
      browser_count=0
      ;;
    *)
      fail_unexpected "$PROBE_STATUS" docker_top DOCKER_METADATA_UNAVAILABLE
      ;;
  esac
  run_required_capture profile_mount_raw docker_inspect DOCKER_METADATA_UNAVAILABLE docker_read inspect --format '{{json .Mounts}}' "$scraper_id"
  run_required_capture profile_mount jq_render JSON_RENDER_FAILED jq_filter_text \
    '(.//[])|map(select(.Destination=="/app/user_data" or .Destination=="/app/userData")|{type:.Type,name:(.Name//null),source:.Source,destination:.Destination,readWrite:.RW})' "$profile_mount_raw"
  run_required_capture scraper jq_render JSON_RENDER_FAILED jq -nc --argjson topAvailable "$scraper_top_available" \
    --argjson nodeCount "$node_count" --argjson browserCount "$browser_count" --argjson profileMount "$profile_mount" \
    '{observable:true,processMetadata:{available:$topAvailable,status:(if $topAvailable then "OBSERVED" else "OPTIONAL_DOCKER_TOP_UNAVAILABLE" end)},nodeOrTiniProcessCount:$nodeCount,browserProcessCount:$browserCount,profileMount:$profileMount,listenerOwnership:{observable:false,status:"NOT_EXECUTED",reason:"listener inspection could expose browser/profile details"}}'
fi

PREFLIGHT_PHASE='postgres_discovery'
database='{"observable":false,"status":"SERVICE_NOT_RUNNING","reason":"postgres has no running project-labeled container","queriesNotExecuted":["exact MaxRawTransportEvent count","duplicate full scan","exact NULL full scans","EXPLAIN ANALYZE"],"queryRisk":"full-table scans excluded"}'
postgres_id=''
discover_running_service postgres_id postgres
PM_POSTGRESQL_SESSION_BEGUN=false
migration_ledger_hash_before='unavailable'
migration_ledger_hash_after='unavailable'
database_size_bytes=0
raw_total_bytes=0
raw_table_present=false
capture_index_present=false
capture_unique_index_present=false
migration_present=f
raw_present=f

PREFLIGHT_PHASE='postgres_catalog_session'
if [[ -n $postgres_id ]]; then
  PM_POSTGRESQL_SESSION_BEGUN=true
  run_psql_query db_name 'SELECT current_database()'
  run_psql_query server_version 'SHOW server_version'
  run_psql_query server_version_num "SELECT current_setting('server_version_num')"
  run_psql_query persistent_lock_timeout "SELECT setting||unit FROM pg_settings WHERE name='lock_timeout'"
  run_psql_query persistent_statement_timeout "SELECT setting||unit FROM pg_settings WHERE name='statement_timeout'"
  run_psql_query maintenance_work_mem "SELECT setting||unit FROM pg_settings WHERE name='maintenance_work_mem'"
  run_psql_query database_size_bytes 'SELECT pg_database_size(current_database())'
  require_uint "$server_version_num" psql_catalog PSQL_MALFORMED_OUTPUT
  require_uint "$database_size_bytes" psql_catalog PSQL_MALFORMED_OUTPUT
fi

PREFLIGHT_PHASE='migration_ledger'
if [[ -n $postgres_id ]]; then
  run_psql_query migration_present "SELECT to_regclass('public.\"_prisma_migrations\"') IS NOT NULL"
  [[ $migration_present == t || $migration_present == f ]] || fail_unexpected 65 psql_catalog PSQL_MALFORMED_OUTPUT
  if [[ $migration_present == t ]]; then
    run_psql_query migration_total 'SELECT count(*) FROM "_prisma_migrations"'
    run_psql_query migration_finished 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'
    run_psql_query migration_failed 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL'
    run_psql_query applied_migrations "SELECT COALESCE(json_agg(migration_name ORDER BY started_at)::text,'[]') FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"
    run_psql_query failed_migrations "SELECT COALESCE(json_agg(migration_name ORDER BY started_at)::text,'[]') FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL"
    require_uint "$migration_total" psql_catalog PSQL_MALFORMED_OUTPUT
    require_uint "$migration_finished" psql_catalog PSQL_MALFORMED_OUTPUT
    require_uint "$migration_failed" psql_catalog PSQL_MALFORMED_OUTPUT
  else
    migration_total=0
    migration_finished=0
    migration_failed=0
    applied_migrations='[]'
    failed_migrations='[]'
  fi
  require_json "$applied_migrations" 'type=="array"'
  require_json "$failed_migrations" 'type=="array"'
  hash_value migration_ledger_hash_before "$applied_migrations"
  run_required_capture expected_migrations filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE find_expected_migrations
  require_json "$expected_migrations" 'type=="array"'
  run_required_capture pending_migrations jq_render JSON_RENDER_FAILED jq -nc --argjson expected "$expected_migrations" \
    --argjson applied "$applied_migrations" '$expected-$applied'
fi

PREFLIGHT_PHASE='raw_table_catalog'
if [[ -n $postgres_id ]]; then
  run_psql_query raw_present "SELECT to_regclass('public.\"MaxRawTransportEvent\"') IS NOT NULL"
  [[ $raw_present == t || $raw_present == f ]] || fail_unexpected 65 psql_catalog PSQL_MALFORMED_OUTPUT
  if [[ $raw_present == t ]]; then
    raw_table_present=true
    run_psql_query raw_estimated_rows "SELECT GREATEST(reltuples,0)::bigint FROM pg_class WHERE oid='public.\"MaxRawTransportEvent\"'::regclass"
    run_psql_query raw_total_bytes "SELECT pg_total_relation_size('public.\"MaxRawTransportEvent\"')"
    run_psql_query raw_table_bytes "SELECT pg_relation_size('public.\"MaxRawTransportEvent\"')"
    run_psql_query raw_index_bytes "SELECT pg_indexes_size('public.\"MaxRawTransportEvent\"')"
    run_psql_query indexes "SELECT COALESCE(json_agg(json_build_object('name',indexrelid::regclass::text,'bytes',pg_relation_size(indexrelid)) ORDER BY indexrelid::regclass::text)::text,'[]') FROM pg_index WHERE indrelid='public.\"MaxRawTransportEvent\"'::regclass"
    run_psql_query constraints "SELECT COALESCE(json_agg(conname ORDER BY conname)::text,'[]') FROM pg_constraint WHERE conrelid='public.\"MaxRawTransportEvent\"'::regclass"
    run_psql_query null_fractions "SELECT COALESCE(json_agg(json_build_object('column',attname,'nullFraction',null_frac) ORDER BY attname)::text,'[]') FROM pg_stats WHERE schemaname='public' AND tablename='MaxRawTransportEvent' AND attname IN ('accountId','captureEnvelopeId')"
    run_psql_query capture_column "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='MaxRawTransportEvent' AND column_name='captureEnvelopeId')"
    run_psql_query capture_index "SELECT to_regclass('public.\"MaxRawTransportEvent_accountId_captureEnvelopeId_idx\"') IS NOT NULL"
    run_psql_query capture_unique_index "SELECT to_regclass('public.\"MaxRawTransportEvent_accountId_captureEnvelopeId_key\"') IS NOT NULL"
    run_psql_query locks "SELECT COALESCE(json_agg(json_build_object('mode',mode,'granted',granted,'count',count) ORDER BY mode,granted)::text,'[]') FROM (SELECT mode,granted,count(*)::int AS count FROM pg_locks WHERE relation='public.\"MaxRawTransportEvent\"'::regclass GROUP BY mode,granted) s"
    for numeric_value in "$raw_estimated_rows" "$raw_total_bytes" "$raw_table_bytes" "$raw_index_bytes"; do
      require_uint "$numeric_value" psql_catalog PSQL_MALFORMED_OUTPUT
    done
    require_json "$indexes" 'type=="array"'
    require_json "$constraints" 'type=="array"'
    require_json "$null_fractions" 'type=="array"'
    require_json "$locks" 'type=="array"'
    [[ $capture_column == t || $capture_column == f ]] || fail_unexpected 65 psql_catalog PSQL_MALFORMED_OUTPUT
    [[ $capture_index == t || $capture_index == f ]] || fail_unexpected 65 psql_catalog PSQL_MALFORMED_OUTPUT
    [[ $capture_unique_index == t || $capture_unique_index == f ]] || fail_unexpected 65 psql_catalog PSQL_MALFORMED_OUTPUT
    [[ $capture_index == t ]] && capture_index_present=true
    [[ $capture_unique_index == t ]] && capture_unique_index_present=true
  else
    raw_estimated_rows=0
    raw_total_bytes=0
    raw_table_bytes=0
    raw_index_bytes=0
    indexes='[]'
    constraints='[]'
    null_fractions='[]'
    capture_column=f
    capture_index=f
    capture_unique_index=f
    locks='[]'
  fi
fi

PREFLIGHT_PHASE='activity_catalog'
if [[ -n $postgres_id ]]; then
  run_psql_query active_sessions "SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state<>'idle'"
  run_psql_query long_transactions "SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND xact_start IS NOT NULL AND now()-xact_start>interval '5 minutes'"
  run_psql_query oldest_transaction_seconds "SELECT COALESCE(EXTRACT(epoch FROM max(now()-xact_start))::bigint,0) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND xact_start IS NOT NULL"
  run_psql_query replication_connections 'SELECT count(*) FROM pg_stat_replication'
  run_psql_query in_recovery 'SELECT pg_is_in_recovery()'
  for numeric_value in "$active_sessions" "$long_transactions" "$oldest_transaction_seconds" "$replication_connections"; do
    require_uint "$numeric_value" psql_catalog PSQL_MALFORMED_OUTPUT
  done
  [[ $in_recovery == t || $in_recovery == f ]] || fail_unexpected 65 psql_catalog PSQL_MALFORMED_OUTPUT
  run_required_capture database jq_render JSON_RENDER_FAILED jq -nc \
    --arg dbName "$db_name" --arg serverVersion "$server_version" --argjson serverVersionNumber "$server_version_num" \
    --arg persistentLockTimeout "$persistent_lock_timeout" --arg persistentStatementTimeout "$persistent_statement_timeout" \
    --arg maintenanceWorkMem "$maintenance_work_mem" --argjson databaseSizeBytes "$database_size_bytes" \
    --arg migrationLedgerPresent "$migration_present" --argjson migrationTotal "$migration_total" --argjson migrationFinished "$migration_finished" \
    --argjson migrationFailed "$migration_failed" --argjson appliedMigrations "$applied_migrations" --argjson failedMigrations "$failed_migrations" \
    --argjson pendingMigrations "$pending_migrations" --arg migrationLedgerHash "$migration_ledger_hash_before" --arg rawTablePresent "$raw_present" \
    --argjson rawEstimatedRows "$raw_estimated_rows" --argjson rawTotalBytes "$raw_total_bytes" --argjson rawTableBytes "$raw_table_bytes" \
    --argjson rawIndexBytes "$raw_index_bytes" --argjson indexes "$indexes" --argjson constraints "$constraints" --argjson nullFractions "$null_fractions" \
    --arg captureEnvelopeColumn "$capture_column" --arg captureEnvelopeIndex "$capture_index" --arg captureEnvelopeUniqueIndex "$capture_unique_index" \
    --argjson locks "$locks" --argjson activeSessions "$active_sessions" --argjson longTransactions "$long_transactions" \
    --argjson oldestTransactionSeconds "$oldest_transaction_seconds" --argjson replicationConnections "$replication_connections" --arg inRecovery "$in_recovery" \
    '{observable:true,queryResultContract:["success","unavailable","timeout","permission_denied","malformed_output"],databaseName:$dbName,serverVersion:$serverVersion,serverVersionNumber:$serverVersionNumber,databaseSizeBytes:$databaseSizeBytes,persistentSettings:{lockTimeout:$persistentLockTimeout,statementTimeout:$persistentStatementTimeout,maintenanceWorkMem:$maintenanceWorkMem},probeSessionBounds:{defaultTransactionReadOnly:true,statementTimeoutMs:'"$DB_STATEMENT_TIMEOUT_MS"',lockTimeoutMs:'"$DB_LOCK_TIMEOUT_MS"'},migration:{ledgerPresent:($migrationLedgerPresent=="t"),total:$migrationTotal,finished:$migrationFinished,failed:$migrationFailed,applied:$appliedMigrations,failedNames:$failedMigrations,pending:$pendingMigrations,ledgerHash:$migrationLedgerHash},rawTable:{name:"MaxRawTransportEvent",present:($rawTablePresent=="t"),exactRowCount:{status:"NOT_EXECUTED",reason:"unbounded full-table count excluded"},estimatedRows:$rawEstimatedRows,totalBytes:$rawTotalBytes,tableBytes:$rawTableBytes,indexBytes:$rawIndexBytes,indexes:$indexes,constraints:$constraints,nullFractionsFromStatistics:$nullFractions,captureEnvelopeIdColumnPresent:($captureEnvelopeColumn=="t"),indexCollisions:{ordinary:($captureEnvelopeIndex=="t"),unique:($captureEnvelopeUniqueIndex=="t")},constraintCollisionNames:$constraints,duplicateCount:{status:"NOT_EXECUTED",reason:"full-table group scan requires an approved maintenance window"},exactNullCounts:{status:"NOT_EXECUTED",reason:"full-table scans excluded"},locks:$locks},activity:{activeSessions:$activeSessions,longTransactionsOverFiveMinutes:$longTransactions,oldestTransactionSeconds:$oldestTransactionSeconds},replication:{connections:$replicationConnections,inRecovery:($inRecovery=="t")},queriesNotExecuted:["exact MaxRawTransportEvent count","duplicate full scan","exact NULL full scans","EXPLAIN ANALYZE"]}'
fi

PREFLIGHT_PHASE='image_inventory'
collect_image_fact gateway_image "$GATEWAY_IMAGE" "$GATEWAY_COMPRESSED_BYTES"
collect_image_fact scraper_image "$SCRAPER_IMAGE" "$SCRAPER_COMPRESSED_BYTES"
run_required_capture gateway_present jq_render JSON_RENDER_FAILED jq -r '.presentLocally' <<<"$gateway_image"
run_required_capture scraper_present jq_render JSON_RENDER_FAILED jq -r '.presentLocally' <<<"$scraper_image"
require_boolean "$gateway_present" jq_render JSON_RENDER_FAILED
require_boolean "$scraper_present" jq_render JSON_RENDER_FAILED
missing_compressed_bytes=0
[[ $gateway_present == true ]] || missing_compressed_bytes=$((missing_compressed_bytes + GATEWAY_COMPRESSED_BYTES))
[[ $scraper_present == true ]] || missing_compressed_bytes=$((missing_compressed_bytes + SCRAPER_COMPRESSED_BYTES))

PREFLIGHT_PHASE='disk_budget'
require_uint "$database_size_bytes" psql_catalog PSQL_MALFORMED_OUTPUT
require_uint "$raw_total_bytes" psql_catalog PSQL_MALFORMED_OUTPUT
pull_unpack_min_bytes=$((missing_compressed_bytes * 3))
pull_unpack_max_bytes=$((missing_compressed_bytes * 5))
backup_estimate_bytes=$(((database_size_bytes * 125 + 99) / 100))
migration_temp_estimate_bytes=0
if [[ $raw_table_present == true && ( $capture_index_present == false || $capture_unique_index_present == false ) ]]; then
  migration_temp_estimate_bytes=$((raw_total_bytes * 2))
fi
run_required_capture root_total_bytes jq_render JSON_RENDER_FAILED jq -r '.totalBytes' <<<"$disk_before"
run_required_capture root_available_bytes jq_render JSON_RENDER_FAILED jq -r '.availableBytes' <<<"$disk_before"
require_uint "$root_total_bytes" filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE
require_uint "$root_available_bytes" filesystem_stat FILESYSTEM_METADATA_UNAVAILABLE
reserve_bytes=$((root_total_bytes / 10))
(( reserve_bytes >= 5368709120 )) || reserve_bytes=5368709120
required_min_bytes=$((pull_unpack_min_bytes + backup_estimate_bytes + migration_temp_estimate_bytes + reserve_bytes))
required_max_bytes=$((pull_unpack_max_bytes + backup_estimate_bytes + migration_temp_estimate_bytes + reserve_bytes))
projected_min_remaining=$((root_available_bytes - required_max_bytes))
disk_verdict='INCOMPLETE_REQUIRED_DB_FACTS'
run_required_capture database_observable jq_render JSON_RENDER_FAILED jq -r '.observable' <<<"$database"
require_boolean "$database_observable" jq_render JSON_RENDER_FAILED
if [[ $database_observable == true ]]; then
  if (( root_available_bytes >= required_max_bytes )); then
    disk_verdict='SUFFICIENT_CONSERVATIVE_BUDGET'
  else
    disk_verdict='INSUFFICIENT_CONSERVATIVE_BUDGET'
  fi
fi
disk='[]'
for disk_path in /opt/crm "$docker_root" "$postgres_data_path" "$RELEASE_ROOT/release/personal-max-stage8b1r"; do
  [[ -n $disk_path ]] || continue
  collect_disk_row row "$disk_path"
  run_required_capture disk jq_render JSON_RENDER_FAILED jq -c --argjson row "$row" '. + [$row]' <<<"$disk"
done

PREFLIGHT_PHASE='backup_metadata'
backup_candidates='[]'
backup_directory_seen=false
for backup_dir in /opt/crm/backups /opt/backups /var/backups; do
  [[ -d $backup_dir ]] || continue
  backup_directory_seen=true
  run_required_capture latest filesystem_stat BACKUP_METADATA_UNAVAILABLE latest_backup_metadata "$backup_dir"
  [[ -n $latest ]] || continue
  mtime_epoch=${latest%%|*}
  remainder=${latest#*|}
  backup_size=${remainder%%|*}
  backup_path=${remainder#*|}
  require_uint "$backup_size" filesystem_stat BACKUP_METADATA_UNAVAILABLE
  [[ $mtime_epoch =~ ^[0-9]+([.][0-9]+)?$ ]] || fail_unexpected 65 filesystem_stat BACKUP_METADATA_UNAVAILABLE
  run_required_capture row jq_render JSON_RENDER_FAILED jq -nc --arg path "$backup_path" --arg mtimeEpoch "$mtime_epoch" \
    --argjson sizeBytes "$backup_size" '{path:$path,mtimeEpoch:$mtimeEpoch,sizeBytes:$sizeBytes,contentInspected:false}'
  run_required_capture backup_candidates jq_render JSON_RENDER_FAILED jq -c --argjson row "$row" '. + [$row]' <<<"$backup_candidates"
done
run_required_capture backup jq_render JSON_RENDER_FAILED jq -nc --argjson candidates "$backup_candidates" \
  --argjson requiredNewBackupBytes "$backup_estimate_bytes" \
  '{mechanism:{status:"NOT_PROVEN",reason:"only bounded backup-file metadata was inspected"},latestCandidates:$candidates,restoreEvidence:{status:"NOT_PROVEN"},requiredNewBackupBytes:$requiredNewBackupBytes,includesTargetTables:{status:"NOT_PROVEN"},configStateBackup:{status:"NOT_PROVEN",reason:"secret-bearing configuration content was not inspected"}}'

PREFLIGHT_PHASE='project_container_discovery_after'
collect_project_snapshot containers_after
hash_value containers_after_hash "$containers_after"

PREFLIGHT_PHASE='production_service_snapshot_after'
collect_service_snapshot services_after "$containers_after"
hash_value services_after_hash "$services_after"

PREFLIGHT_PHASE='volume_snapshot_after'
collect_volume_snapshot volumes_after
hash_value volumes_after_hash "$volumes_after"

PREFLIGHT_PHASE='immutability_comparison'
collect_disk_row disk_after /opt/crm
if [[ -n $postgres_id ]]; then
  if [[ $migration_present == t ]]; then
    run_psql_query applied_migrations_after "SELECT COALESCE(json_agg(migration_name ORDER BY started_at)::text,'[]') FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"
    require_json "$applied_migrations_after" 'type=="array"'
    hash_value migration_ledger_hash_after "$applied_migrations_after"
  else
    hash_value migration_ledger_hash_after '[]'
  fi
fi
unexpected_changes=false
[[ $containers_before_hash == "$containers_after_hash" ]] || unexpected_changes=true
[[ $services_before_hash == "$services_after_hash" ]] || unexpected_changes=true
[[ $volumes_before_hash == "$volumes_after_hash" ]] || unexpected_changes=true
[[ $migration_ledger_hash_before == "$migration_ledger_hash_after" ]] || unexpected_changes=true
[[ $unexpected_changes == false ]] || fail_unexpected 82 unknown PRODUCTION_DRIFT_DETECTED
run_required_capture existing_relevant_image_bytes jq_render JSON_RENDER_FAILED jq -n --argjson gateway "$gateway_image" \
  --argjson scraper "$scraper_image" '[($gateway.localUnpackedBytes//0),($scraper.localUnpackedBytes//0)]|add'
require_uint "$existing_relevant_image_bytes" jq_render JSON_RENDER_FAILED

incomplete_facts='[]'
[[ $backup_directory_seen == true ]] || add_incomplete_fact OPTIONAL_BACKUP_DIRECTORY_ABSENT
[[ $gateway_present == true ]] || add_incomplete_fact ACCEPTED_GATEWAY_IMAGE_ABSENT_LOCALLY
[[ $scraper_present == true ]] || add_incomplete_fact ACCEPTED_SCRAPER_IMAGE_ABSENT_LOCALLY
[[ -n $scraper_id ]] || add_incomplete_fact SCRAPER_SERVICE_NOT_RUNNING
[[ $raw_present == t ]] || add_incomplete_fact RAW_JOURNAL_TABLE_ABSENT
[[ $migration_present == t ]] || add_incomplete_fact MIGRATION_LEDGER_ABSENT
[[ $scraper_top_available == true || -z $scraper_id ]] || add_incomplete_fact OPTIONAL_DOCKER_TOP_UNAVAILABLE
add_incomplete_fact LISTENER_OWNERSHIP_NOT_SAFELY_OBSERVABLE
add_incomplete_fact BACKUP_MECHANISM_NOT_PROVEN
add_incomplete_fact FULL_TABLE_SCANS_INTENTIONALLY_SKIPPED
run_required_capture incomplete_fact_count jq_render JSON_RENDER_FAILED jq 'length' <<<"$incomplete_facts"
run_required_capture service_count jq_render JSON_RENDER_FAILED jq 'length' <<<"$service_rows"
require_uint "$incomplete_fact_count" jq_render JSON_RENDER_FAILED
require_uint "$service_count" jq_render JSON_RENDER_FAILED
root_gate_complete=false
if [[ $database_observable == true && $service_count -gt 0 && $disk_verdict != INCOMPLETE_REQUIRED_DB_FACTS && $incomplete_fact_count -eq 0 ]]; then
  root_gate_complete=true
fi

PREFLIGHT_PHASE='report_render'
run_required_capture report_json jq_render JSON_RENDER_FAILED jq -n \
  --arg scriptSha256 "$ACTUAL_SHA256" --arg resultPath "$RESULT_PATH" --arg failurePath "$FAILURE_PATH" --arg composeFile "$COMPOSE_FILE" --arg project "$PROJECT" \
  --arg osId "$os_id" --arg osVersion "$os_version" --arg kernel "$kernel" --arg architecture "$architecture" \
  --arg dockerVersion "$docker_server_version" --arg dockerRoot "$docker_root" --arg dockerDriver "$docker_driver" \
  --arg composeFileSha256 "$compose_file_sha256" --argjson composeFileSize "$compose_file_size" --arg composeFileMode "$compose_file_mode" \
  --argjson dockerRuntimes "$docker_runtime" --argjson services "$service_rows" --argjson dependencies "$dependencies" --argjson scraper "$scraper" --argjson database "$database" \
  --argjson gatewayImage "$gateway_image" --argjson scraperImage "$scraper_image" --argjson disk "$disk" --argjson backup "$backup" --argjson incompleteFacts "$incomplete_facts" \
  --argjson existingRelevantImageBytes "$existing_relevant_image_bytes" --argjson missingCompressedBytes "$missing_compressed_bytes" --argjson pullUnpackMinBytes "$pull_unpack_min_bytes" --argjson pullUnpackMaxBytes "$pull_unpack_max_bytes" \
  --argjson backupEstimateBytes "$backup_estimate_bytes" --argjson migrationTempEstimateBytes "$migration_temp_estimate_bytes" --argjson reserveBytes "$reserve_bytes" \
  --argjson requiredMinBytes "$required_min_bytes" --argjson requiredMaxBytes "$required_max_bytes" --argjson projectedMinRemaining "$projected_min_remaining" --arg diskVerdict "$disk_verdict" \
  --arg containersBeforeHash "$containers_before_hash" --arg servicesBeforeHash "$services_before_hash" --arg volumesBeforeHash "$volumes_before_hash" \
  --arg containersAfterHash "$containers_after_hash" --arg servicesAfterHash "$services_after_hash" --arg volumesAfterHash "$volumes_after_hash" \
  --arg migrationLedgerHashBefore "$migration_ledger_hash_before" --arg migrationLedgerHashAfter "$migration_ledger_hash_after" \
  --argjson diskBefore "$disk_before" --argjson diskAfter "$disk_after" --arg rootGateComplete "$root_gate_complete" \
  '{schemaVersion:3,mode:"READ_ONLY_PRODUCTION_PREFLIGHT",generatedAt:(now|todate),script:{sha256:$scriptSha256,checksumBound:true,resultPath:$resultPath,failureResultPath:$failurePath},host:{os:{id:$osId,version:$osVersion},kernel:$kernel,architecture:$architecture,docker:{serverVersion:$dockerVersion,composeCliExecuted:false,dataRoot:$dockerRoot,storageDriver:$dockerDriver,runtimes:$dockerRuntimes}},production:{composeFile:$composeFile,composeFileEvidence:{sha256:$composeFileSha256,sizeBytes:$composeFileSize,mode:$composeFileMode,contentsPrinted:false,rendered:false,environmentInterpolated:false},project:$project,discovery:{source:"Docker Engine labels",projectLabel:"com.docker.compose.project=crm",composeCliUsed:false},services:$services,dependenciesByNetwork:$dependencies,scraper:$scraper,environment:{valuesInspected:false,namesInspected:false,configEnvInspected:false,envFilesRead:false,reason:"narrow Docker inspect projections exclude container environment"}},acceptedImages:{gateway:$gatewayImage,scraper:$scraperImage,registryManifestProvenance:"immutable digest manifests observed without pull on 2026-07-28"},database:$database,storage:{filesystems:$disk,budget:{existingRelevantImageBytes:$existingRelevantImageBytes,missingCompressedImageBytes:$missingCompressedBytes,pullAndUnpackEstimateBytes:{minimum:$pullUnpackMinBytes,conservativeMaximum:$pullUnpackMaxBytes,method:"3x to 5x immutable compressed layer bytes"},backupEstimateBytes:$backupEstimateBytes,migrationTemporaryEstimateBytes:$migrationTempEstimateBytes,minimumRollbackOperationalReserveBytes:$reserveBytes,requiredBytes:{minimum:$requiredMinBytes,conservativeMaximum:$requiredMaxBytes},projectedRemainingAtConservativeMaximum:$projectedMinRemaining,verdict:$diskVerdict}},backup:$backup,immutability:{before:{containerIdsHash:$containersBeforeHash,serviceStatesHash:$servicesBeforeHash,volumesHash:$volumesBeforeHash,migrationLedgerHash:$migrationLedgerHashBefore,disk:$diskBefore},after:{containerIdsHash:$containersAfterHash,serviceStatesHash:$servicesAfterHash,volumesHash:$volumesAfterHash,migrationLedgerHash:$migrationLedgerHashAfter,disk:$diskAfter},unexpectedChanges:false},gate:{complete:($rootGateComplete=="true"),incompleteFacts:$incompleteFacts,reason:(if $rootGateComplete=="true" then "mandatory root facts collected" else "classified mandatory facts incomplete" end)},safety:{defaultTransactionReadOnly:true,boundedCommands:true,fullTableScans:false,ddl:false,dml:false,migrations:false,locksRequested:false,containersCreated:false,containersRestarted:false,imagesPulled:false,cleanup:false,browserLaunched:false,maxContacted:false,providerAction:false,secretsPrinted:false,environmentValuesRead:false,messageContentRead:false,profileContentRead:false,productionFilesWritten:false,sanitizedReportWritten:true,transientDockerExecProcesses:true,dockerExecPurpose:"bounded read-only PostgreSQL catalog queries",filesystemReadsMayUpdateAtimeAccordingToMountPolicy:true,hostAndDatabaseReadsMayWarmCaches:true,externalNetworkUsed:false}}'
printf '%s\n' "$report_json" >"$PM_SUCCESS_TMP"
success_json=$(<"$PM_SUCCESS_TMP")
require_json "$success_json" '.safety.secretsPrinted==false and .safety.ddl==false and .safety.dml==false and .mode=="READ_ONLY_PRODUCTION_PREFLIGHT"'

PREFLIGHT_PHASE='report_handoff'
run_required_no_output report_handoff REPORT_HANDOFF_FAILED chgrp codexbot "$PM_SUCCESS_TMP"
run_required_no_output report_handoff REPORT_HANDOFF_FAILED chmod 0640 "$PM_SUCCESS_TMP"
run_required_capture tmp_identity report_handoff REPORT_HANDOFF_FAILED stat -Lc '%d:%i' "$PM_SUCCESS_TMP"
run_required_capture tmp_permissions report_handoff REPORT_HANDOFF_FAILED stat -Lc '%U:%G:%a' "$PM_SUCCESS_TMP"
[[ -f $PM_SUCCESS_TMP && ! -L $PM_SUCCESS_TMP && $tmp_permissions == root:codexbot:640 ]] || fail_unexpected 85 report_handoff REPORT_HANDOFF_FAILED
run_required_no_output report_handoff REPORT_HANDOFF_FAILED mv --no-clobber --no-target-directory -- "$PM_SUCCESS_TMP" "$RESULT_PATH"
if [[ -e $PM_SUCCESS_TMP || -L $PM_SUCCESS_TMP ]]; then
  fail_unexpected 86 report_handoff REPORT_HANDOFF_FAILED
fi
PM_SUCCESS_TMP=''
run_required_capture final_identity report_handoff REPORT_HANDOFF_FAILED stat -Lc '%d:%i' "$RESULT_PATH"
run_required_capture final_permissions report_handoff REPORT_HANDOFF_FAILED stat -Lc '%U:%G:%a' "$RESULT_PATH"
[[ -f $RESULT_PATH && ! -L $RESULT_PATH && $final_identity == "$tmp_identity" && $final_permissions == root:codexbot:640 ]] || \
  fail_unexpected 87 report_handoff REPORT_HANDOFF_FAILED
run_required_no_output report_handoff REPORT_HANDOFF_FAILED timeout 5 runuser -u codexbot -- test -r "$RESULT_PATH"
run_optional_capture writable_check timeout 5 runuser -u codexbot -- test -w "$RESULT_PATH"
(( PROBE_STATUS != 0 )) || fail_unexpected 89 report_handoff REPORT_HANDOFF_FAILED
run_required_capture result_sha256 report_handoff REPORT_HANDOFF_FAILED sha256sum -- "$RESULT_PATH"
result_sha256=${result_sha256%% *}
[[ $result_sha256 =~ ^[0-9a-f]{64}$ ]] || fail_unexpected 65 report_handoff REPORT_HANDOFF_FAILED

PREFLIGHT_PHASE='completed'
trap - ERR
trap - EXIT
printf 'SANITIZED_RESULT_PATH=%s\nSANITIZED_RESULT_SHA256=%s\nRESULT_OWNER=root\nRESULT_GROUP=codexbot\nRESULT_MODE=0640\nCODEXBOT_READABLE=YES\nCODEXBOT_WRITABLE=NO\n' \
  "$RESULT_PATH" "$result_sha256"
if [[ $root_gate_complete != true ]]; then
  printf 'MANDATORY_FACTS_INCOMPLETE\n'
  exit 83
fi
