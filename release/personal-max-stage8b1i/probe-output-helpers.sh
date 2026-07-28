#!/usr/bin/env bash
# shellcheck disable=SC2034

# Sourced after bounded-operations.sh. The pm_result_ bridge namespace is
# accepted by pm_capture_bounded but refused as a public target by these
# higher-level helpers, so Bash dynamic scoping cannot shadow caller outputs.

pm_validate_helper_out_name() {
  pm_validate_out_name "${1:-}" && [[ $1 != pm_result_* ]]
}

pm_require_helper_out_name() {
  pm_validate_helper_out_name "${1:-}" || {
    PROBE_ERROR_CLASSIFICATION=INVALID_OUT_PARAMETER
    return 64
  }
}

sha_of() {
  local __pm_target_name=${1:-} __pm_path=${2:-} pm_result_checksum_line=''
  pm_require_helper_out_name "$__pm_target_name" || return
  pm_capture_bounded pm_result_checksum_line filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
    sha256sum -- "$__pm_path" || return
  pm_assign_out "$__pm_target_name" "${pm_result_checksum_line%% *}"
}

free_bytes_at() {
  local __pm_target_name=${1:-} __pm_path=${2:-} pm_result_df_output=''
  local __pm_header __pm_data __pm_filesystem __pm_blocks __pm_used __pm_available __pm_capacity __pm_mountpoint
  pm_require_helper_out_name "$__pm_target_name" || return
  pm_capture_bounded pm_result_df_output filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
    df -B1 -P "$__pm_path" || return
  __pm_header=${pm_result_df_output%%$'\n'*}
  __pm_data=${pm_result_df_output#*$'\n'}
  [[ $__pm_data != "$pm_result_df_output" ]]
  read -r __pm_filesystem __pm_blocks __pm_used __pm_available __pm_capacity __pm_mountpoint <<<"$__pm_data"
  pm_safe_uint "$__pm_available" || return 65
  pm_assign_out "$__pm_target_name" "$__pm_available"
}

hash_sorted_text() {
  local __pm_target_name=${1:-} __pm_value=${2-}
  local pm_result_source_path='' pm_result_sorted_path='' pm_result_checksum_line='' __pm_digest
  pm_require_helper_out_name "$__pm_target_name" || return
  pm_capture_bounded pm_result_source_path filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
    mktemp "$TMP/hash-source.XXXXXX" || return
  pm_capture_bounded pm_result_sorted_path filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
    mktemp "$TMP/hash-sorted.XXXXXX" || return
  printf '%s\n' "$__pm_value" >"$pm_result_source_path"
  pm_write_bounded "$pm_result_sorted_path" filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
    env LC_ALL=C sort "$pm_result_source_path" || return
  pm_capture_bounded pm_result_checksum_line filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
    sha256sum -- "$pm_result_sorted_path" || return
  __pm_digest=${pm_result_checksum_line%% *}
  pm_run_bounded temp_cleanup 60 TEMP_REMOVAL_TIMEOUT TEMP_REMOVAL_TIMEOUT \
    rm -f -- "$pm_result_source_path" "$pm_result_sorted_path" || return
  pm_assign_out "$__pm_target_name" "$__pm_digest"
}

hash_raw_command() {
  local __pm_target_name=${1:-} __pm_command_class=${2:-} __pm_seconds=${3:-}
  local __pm_timeout_class=${4:-} __pm_failure_class=${5:-}
  local pm_result_raw_path='' pm_result_checksum_line='' __pm_digest __pm_status __pm_original_class
  pm_require_helper_out_name "$__pm_target_name" || return
  shift 5
  pm_capture_bounded pm_result_raw_path filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
    mktemp "$TMP/hash-raw.XXXXXX" || return
  if pm_write_bounded "$pm_result_raw_path" "$__pm_command_class" "$__pm_seconds" \
      "$__pm_timeout_class" "$__pm_failure_class" "$@"; then
    :
  else
    __pm_status=$?
    __pm_original_class=$PROBE_ERROR_CLASSIFICATION
    pm_run_bounded filesystem_metadata 60 TEMP_REMOVAL_TIMEOUT TEMP_REMOVAL_TIMEOUT \
      rm -f -- "$pm_result_raw_path" || true
    PROBE_ERROR_CLASSIFICATION=$__pm_original_class
    PROBE_SAFE_COMMAND_CLASS=$__pm_command_class
    return "$__pm_status"
  fi
  if pm_capture_bounded pm_result_checksum_line filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
      sha256sum -- "$pm_result_raw_path"; then
    __pm_digest=${pm_result_checksum_line%% *}
  else
    __pm_status=$?
    __pm_original_class=$PROBE_ERROR_CLASSIFICATION
    pm_run_bounded filesystem_metadata 60 TEMP_REMOVAL_TIMEOUT TEMP_REMOVAL_TIMEOUT \
      rm -f -- "$pm_result_raw_path" || true
    PROBE_ERROR_CLASSIFICATION=$__pm_original_class
    PROBE_SAFE_COMMAND_CLASS=filesystem_metadata
    return "$__pm_status"
  fi
  if [[ ! $__pm_digest =~ ^[0-9a-f]{64}$ ]]; then
    pm_run_bounded filesystem_metadata 60 TEMP_REMOVAL_TIMEOUT TEMP_REMOVAL_TIMEOUT \
      rm -f -- "$pm_result_raw_path" || true
    PROBE_ERROR_CLASSIFICATION=METADATA_FAILED
    PROBE_SAFE_COMMAND_CLASS=filesystem_metadata
    return 65
  fi
  pm_run_bounded filesystem_metadata 60 TEMP_REMOVAL_TIMEOUT TEMP_REMOVAL_TIMEOUT \
    rm -f -- "$pm_result_raw_path" || return
  PROBE_SAFE_COMMAND_CLASS=$__pm_command_class
  pm_assign_out "$__pm_target_name" "$__pm_digest"
}

cleanup_inventory() {
  local __pm_target_name=${1:-} __pm_kind=${2:-} __pm_seconds=${3:-} pm_result_inventory_output=''
  local __pm_run_id=${RUN_ID:-}
  pm_require_helper_out_name "$__pm_target_name" || return
  [[ $__pm_run_id =~ ^[0-9a-f]{12}$ ]] || return 64
  case $__pm_kind in
    containers) pm_capture_bounded pm_result_inventory_output cleanup "$__pm_seconds" \
      CONTAINER_REMOVAL_TIMEOUT CLEANUP_INCOMPLETE docker ps -aq --no-trunc \
      --filter "label=$STAGE_LABEL" --filter "label=$RUN_LABEL_KEY=$__pm_run_id" ;;
    networks) pm_capture_bounded pm_result_inventory_output cleanup "$__pm_seconds" \
      NETWORK_REMOVAL_TIMEOUT CLEANUP_INCOMPLETE docker network ls -q \
      --filter "label=$STAGE_LABEL" --filter "label=$RUN_LABEL_KEY=$__pm_run_id" ;;
    volumes) pm_capture_bounded pm_result_inventory_output cleanup "$__pm_seconds" \
      VOLUME_REMOVAL_TIMEOUT CLEANUP_INCOMPLETE docker volume ls -q \
      --filter "label=$STAGE_LABEL" --filter "label=$RUN_LABEL_KEY=$__pm_run_id" ;;
    *) return 64 ;;
  esac || return
  pm_assign_out "$__pm_target_name" "$pm_result_inventory_output"
}

image_presence() {
  local __pm_boolean_target=${1:-} __pm_id_target=${2:-} __pm_ref=${3:-} pm_result_image_id=''
  pm_require_helper_out_name "$__pm_boolean_target" || return
  pm_require_helper_out_name "$__pm_id_target" || return
  [[ $__pm_boolean_target != "$__pm_id_target" ]] || return 64
  pm_capture_bounded pm_result_image_id docker_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
    docker image ls --no-trunc --quiet "$__pm_ref" || return
  if [[ -z $pm_result_image_id ]]; then
    pm_assign_out "$__pm_boolean_target" false
    pm_assign_out "$__pm_id_target" absent
    return 0
  fi
  [[ $pm_result_image_id =~ ^sha256:[0-9a-f]{64}$ ]] || return 65
  pm_assign_out "$__pm_boolean_target" true
  pm_assign_out "$__pm_id_target" "$pm_result_image_id"
}

psql_value() {
  local __pm_target_name=${1:-} __pm_query=${2-} pm_result_psql_output=''
  pm_require_helper_out_name "$__pm_target_name" || return
  pm_capture_bounded pm_result_psql_output disposable_postgresql 120 \
    DISPOSABLE_DOCKER_TIMEOUT DISPOSABLE_DOCKER_FAILED docker exec "$PG_CONTAINER" \
    psql --no-psqlrc -X -A -t -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -c "$__pm_query" || return
  pm_assign_out "$__pm_target_name" "$pm_result_psql_output"
}
