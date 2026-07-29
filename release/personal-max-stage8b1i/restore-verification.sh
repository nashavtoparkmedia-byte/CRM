#!/usr/bin/env bash
# Privacy-safe restore verification for the disposable PostgreSQL instance.
# Query text and query results are never copied into a failure report.
# shellcheck disable=SC2034

pm_restore_check_id_is_safe() {
  case ${1:-} in
    NONE | RESTORE_LEDGER_FINISHED_CHECK | RESTORE_LEDGER_FAILED_CHECK | \
      RESTORE_LEDGER_NAMES_CHECK | RESTORE_CATALOG_TABLES_CHECK | \
      RESTORE_CATALOG_INDEXES_CHECK | RESTORE_CATALOG_CONSTRAINTS_CHECK | \
      RESTORE_REQUIRED_PRISMA_MIGRATIONS_RELATION_CHECK | \
      RESTORE_REQUIRED_USERS_RELATION_CHECK | RESTORE_REQUIRED_CONTACT_RELATION_CHECK | \
      RESTORE_REQUIRED_CHAT_RELATION_CHECK | RESTORE_REPRESENTATIVE_MIGRATIONS_CHECK | \
      RESTORE_REPRESENTATIVE_USER_CHECK | RESTORE_REPRESENTATIVE_CONTACT_CHECK | \
      RESTORE_REPRESENTATIVE_CHAT_CHECK | RESTORE_REPORT_RENDER_CHECK) return 0 ;;
    *) return 1 ;;
  esac
}

pm_restore_failure_class_is_safe() {
  case ${1:-} in
    RESTORE_QUERY_FAILED | RESTORE_REPRESENTATIVE_CHECK_FAILED) return 0 ;;
    *) return 1 ;;
  esac
}

pm_restore_enter_check() {
  local __pm_check_id=${1:-}
  pm_restore_check_id_is_safe "$__pm_check_id" || {
    PROBE_ERROR_CLASSIFICATION=RESTORE_QUERY_FAILED
    return 64
  }
  RESTORE_CHECK_ID=$__pm_check_id
}

pm_restore_container_available() {
  local __pm_restore_running=''
  if ! pm_capture_bounded_internal __pm_restore_running docker_disposable 30 \
      DISPOSABLE_DOCKER_TIMEOUT DISPOSABLE_CONTAINER_UNAVAILABLE \
      docker inspect --format '{{if .State.Running}}true{{else}}false{{end}}' "$PG_CONTAINER"; then
    PROBE_ERROR_CLASSIFICATION=DISPOSABLE_CONTAINER_UNAVAILABLE
    return 69
  fi
  if [[ $__pm_restore_running != true ]]; then
    PROBE_ERROR_CLASSIFICATION=DISPOSABLE_CONTAINER_UNAVAILABLE
    return 69
  fi
}

pm_restore_query_raw() {
  local __pm_target_name=${1:-} __pm_failure_class=${2:-} __pm_query=${3-}
  local __pm_restore_output=''
  pm_require_helper_out_name "$__pm_target_name" || return
  pm_restore_failure_class_is_safe "$__pm_failure_class" || {
    PROBE_ERROR_CLASSIFICATION=RESTORE_QUERY_FAILED
    return 64
  }
  pm_restore_container_available || return
  pm_capture_bounded_internal __pm_restore_output disposable_postgresql 120 \
    DISPOSABLE_DOCKER_TIMEOUT "$__pm_failure_class" docker exec "$PG_CONTAINER" \
    psql --no-psqlrc -X -A -t -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -c "$__pm_query" || return
  pm_assign_out "$__pm_target_name" "$__pm_restore_output"
}

pm_restore_query() {
  local __pm_target_name=${1:-} __pm_check_id=${2:-} __pm_failure_class=${3:-} __pm_query=${4-}
  pm_require_helper_out_name "$__pm_target_name" || return
  pm_restore_enter_check "$__pm_check_id" || return
  pm_restore_query_raw "$__pm_target_name" "$__pm_failure_class" "$__pm_query"
}

pm_restore_query_internal() {
  local __pm_internal_target=${1:-} __pm_check_id=${2:-} __pm_failure_class=${3:-} __pm_query=${4-}
  pm_validate_internal_out_name "$__pm_internal_target" || {
    PROBE_ERROR_CLASSIFICATION=INVALID_OUT_PARAMETER
    return 64
  }
  pm_reject_out_collision "$__pm_internal_target" \
    __pm_internal_target __pm_check_id __pm_failure_class __pm_query || return
  pm_restore_enter_check "$__pm_check_id" || return
  pm_restore_failure_class_is_safe "$__pm_failure_class" || {
    PROBE_ERROR_CLASSIFICATION=RESTORE_QUERY_FAILED
    return 64
  }
  pm_restore_container_available || return
  pm_capture_bounded_internal "$__pm_internal_target" disposable_postgresql 120 \
    DISPOSABLE_DOCKER_TIMEOUT "$__pm_failure_class" docker exec "$PG_CONTAINER" \
    psql --no-psqlrc -X -A -t -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -c "$__pm_query"
}

pm_restore_assert_uint_equal() {
  local __pm_value=${1:-} __pm_expected=${2:-} __pm_classification=${3:-}
  if ! pm_safe_uint "$__pm_value" || ! pm_safe_uint "$__pm_expected" || (( __pm_value != __pm_expected )); then
    PROBE_ERROR_CLASSIFICATION=$__pm_classification
    return 67
  fi
}

pm_restore_assert_uint_positive() {
  local __pm_value=${1:-} __pm_classification=${2:-}
  if ! pm_safe_uint "$__pm_value" || (( __pm_value == 0 )); then
    PROBE_ERROR_CLASSIFICATION=$__pm_classification
    return 67
  fi
}

pm_restore_require_relation() {
  local __pm_check_id=${1:-} __pm_presence_query=${2-} __pm_relation_present=''
  pm_restore_query_internal __pm_relation_present "$__pm_check_id" RESTORE_QUERY_FAILED "$__pm_presence_query" || return
  if [[ $__pm_relation_present != t ]]; then
    PROBE_ERROR_CLASSIFICATION=RESTORE_REQUIRED_RELATION_MISSING
    return 67
  fi
}

pm_restore_optional_representative() {
  local __pm_count_target=${1:-} __pm_available_target=${2:-} __pm_check_id=${3:-}
  local __pm_presence_query=${4-} __pm_count_query=${5-} __pm_relation_present='' __pm_count_value=''
  pm_require_helper_out_name "$__pm_count_target" || return
  pm_require_helper_out_name "$__pm_available_target" || return
  [[ $__pm_count_target != "$__pm_available_target" ]] || return 64
  pm_restore_query_internal __pm_relation_present "$__pm_check_id" RESTORE_QUERY_FAILED "$__pm_presence_query" || return
  case $__pm_relation_present in
    f)
      pm_assign_out "$__pm_count_target" null
      pm_assign_out "$__pm_available_target" false
      return 0
      ;;
    t) ;;
    *)
      PROBE_ERROR_CLASSIFICATION=RESTORE_REPRESENTATIVE_CHECK_FAILED
      return 67
      ;;
  esac
  pm_restore_query_internal __pm_count_value "$__pm_check_id" RESTORE_REPRESENTATIVE_CHECK_FAILED "$__pm_count_query" || return
  if ! pm_safe_uint "$__pm_count_value"; then
    PROBE_ERROR_CLASSIFICATION=RESTORE_REPRESENTATIVE_CHECK_FAILED
    return 67
  fi
  pm_assign_out "$__pm_count_target" "$__pm_count_value"
  pm_assign_out "$__pm_available_target" true
}

pm_restore_json_capture() {
  local __pm_target_name=${1:-} __pm_filter=${2:-} __pm_json=${3-} __pm_json_value=''
  pm_require_helper_out_name "$__pm_target_name" || return
  pm_capture_bounded_internal __pm_json_value report_render 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
    jq -r "$__pm_filter" <<<"$__pm_json" || return
  pm_assign_out "$__pm_target_name" "$__pm_json_value"
}

pm_restore_json_capture_internal() {
  local __pm_internal_target=${1:-} __pm_filter=${2:-} __pm_json=${3-}
  pm_validate_internal_out_name "$__pm_internal_target" || {
    PROBE_ERROR_CLASSIFICATION=INVALID_OUT_PARAMETER
    return 64
  }
  pm_reject_out_collision "$__pm_internal_target" __pm_internal_target __pm_filter __pm_json || return
  pm_capture_bounded_internal "$__pm_internal_target" report_render 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
    jq -r "$__pm_filter" <<<"$__pm_json"
}

pm_restore_ledger_fail() {
  PROBE_ERROR_CLASSIFICATION=${1:-RESTORE_LEDGER_EXPECTED_SET_MISMATCH}
  return 67
}

pm_restore_analyze_ledger_json() {
  local __pm_ledger_json=${1-} __pm_canonical=''
  pm_restore_enter_check RESTORE_LEDGER_NAMES_CHECK || return
  if ! pm_run_bounded report_render 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
      jq -e 'type=="array" and all(.[]; type=="string")' <<<"$__pm_ledger_json" >/dev/null; then
    PROBE_ERROR_CLASSIFICATION=RESTORE_QUERY_FAILED
    return 65
  fi
  pm_restore_json_capture LEDGER_NAME_COUNT 'length' "$__pm_ledger_json" || return
  pm_restore_json_capture LEDGER_UNIQUE_COUNT 'unique|length' "$__pm_ledger_json" || return
  LEDGER_DUPLICATE_COUNT=$((LEDGER_NAME_COUNT - LEDGER_UNIQUE_COUNT))
  pm_restore_json_capture LEDGER_EMPTY_NAME_COUNT '[.[]|select(length==0)]|length' "$__pm_ledger_json" || return
  pm_restore_json_capture LEDGER_UNSAFE_NAME_COUNT \
    '[.[]|select(length==0 or any(explode[]; . < 32 or . == 127) or (test("^[A-Za-z0-9][A-Za-z0-9._-]*$")|not))]|length' \
    "$__pm_ledger_json" || return
  pm_restore_json_capture LEDGER_INVALID_FORMAT_COUNT \
    '[.[]|select(test("^[0-9]{14}_[a-z0-9_]+$")|not)]|length' "$__pm_ledger_json" || return
  pm_restore_json_capture LEDGER_ACCEPTED_HISTORICAL_NAMES_JSON \
    '[.[]|select(test("^[0-9]{14}_[a-z0-9_]+$")|not)]|sort|tojson' "$__pm_ledger_json" || return
  pm_restore_json_capture LEDGER_INVALID_NAMING_CATEGORIES_JSON '
    [.[] as $name | select($name|test("^[0-9]{14}_[a-z0-9_]+$")|not) |
      (if ($name|test("^[0-9]{14}_")|not) then "non_14_digit_prefix" else empty end),
      (if ($name|test("[A-Z]")) then "uppercase_character" else empty end),
      (if ($name|contains("-")) then "hyphenated_historical_name" else empty end),
      (if (($name|test("^[0-9]{14}_")) and ($name|test("[A-Z-]")|not)) then "other_safe_historical_format" else empty end)
    ]|unique|tojson' "$__pm_ledger_json" || return
  pm_restore_json_capture_internal __pm_canonical 'sort|tojson' "$__pm_ledger_json" || return
  hash_sorted_text LEDGER_NAMES_SHA256 "$__pm_canonical" || return
  hash_sorted_text LEDGER_ATTESTATION_SHA256 "$__pm_ledger_json" || return
  (( LEDGER_NAME_COUNT == 46 )) || pm_restore_ledger_fail RESTORE_LEDGER_COUNT_MISMATCH || return
  (( LEDGER_DUPLICATE_COUNT == 0 )) || pm_restore_ledger_fail RESTORE_LEDGER_DUPLICATE_NAME || return
  (( LEDGER_EMPTY_NAME_COUNT == 0 && LEDGER_UNSAFE_NAME_COUNT == 0 )) || \
    pm_restore_ledger_fail RESTORE_LEDGER_UNSAFE_NAME || return
}

pm_restore_validate_ledger_json() {
  local __pm_ledger_json=${1-} __pm_preflight=${2:-} __pm_repository_inventory=${3:-}
  local __pm_preflight_hash=''
  local __pm_repo_count='' __pm_repo_unique_count=''

  pm_restore_analyze_ledger_json "$__pm_ledger_json" || return

  if [[ ! -f $__pm_preflight || -L $__pm_preflight || ! -f $__pm_repository_inventory || -L $__pm_repository_inventory ]]; then
    pm_restore_ledger_fail RESTORE_LEDGER_EXPECTED_SET_MISMATCH
    return
  fi
  if ! pm_run_bounded package_validation 60 METADATA_TIMEOUT RESTORE_LEDGER_EXPECTED_SET_MISMATCH \
      jq -e --arg ledgerHash "$ATTESTED_PRODUCTION_LEDGER_SHA256" '
        .database.migration.ledgerPresent==true and .database.migration.total==46 and
        .database.migration.finished==46 and .database.migration.failed==0 and
        (.database.migration.applied|length)==46 and (.database.migration.applied|unique|length)==46 and
        .database.migration.ledgerHash==$ledgerHash and (.database.migration.pending|length)==8' \
      "$__pm_preflight" >/dev/null; then
    pm_restore_ledger_fail RESTORE_LEDGER_EXPECTED_SET_MISMATCH
    return
  fi
  pm_capture_bounded_internal __pm_preflight_hash report_render 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
    jq -r '.database.migration.ledgerHash' "$__pm_preflight" || return

  pm_write_bounded "$TMP/ledger-before.unsorted" report_render 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
    jq -r '.[]' <<<"$__pm_ledger_json" || return
  pm_write_bounded "$TMP/ledger-before" filesystem_metadata 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
    env LC_ALL=C sort "$TMP/ledger-before.unsorted" || return
  pm_write_bounded "$TMP/accepted-ledger" report_render 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
    jq -r '.database.migration.applied[]' "$__pm_preflight" || return
  pm_write_bounded "$TMP/accepted-ledger.sorted" filesystem_metadata 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
    env LC_ALL=C sort "$TMP/accepted-ledger" || return
  pm_write_bounded "$TMP/accepted-pending" report_render 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
    jq -r '.database.migration.pending[]' "$__pm_preflight" || return
  pm_write_bounded "$TMP/accepted-pending.sorted" filesystem_metadata 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
    env LC_ALL=C sort "$TMP/accepted-pending" || return
  pm_write_bounded "$TMP/expected-migrations" filesystem_metadata 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
    printf '%s\n' "${EXPECTED_MIGRATIONS[@]}" || return
  pm_write_bounded "$TMP/expected-migrations.sorted" filesystem_metadata 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
    env LC_ALL=C sort "$TMP/expected-migrations" || return

  pm_capture_bounded_internal __pm_repo_count filesystem_metadata 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
    awk 'NF{count++} END{print count+0}' "$__pm_repository_inventory" || return
  pm_capture_bounded_internal __pm_repo_unique_count filesystem_metadata 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
    awk 'NF && !seen[$0]++{count++} END{print count+0}' "$__pm_repository_inventory" || return
  pm_write_bounded "$TMP/repository-to-ledger" filesystem_metadata 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
    comm -23 "$__pm_repository_inventory" "$TMP/ledger-before" || return
  pm_write_bounded "$TMP/ledger-to-repository" filesystem_metadata 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
    comm -13 "$__pm_repository_inventory" "$TMP/ledger-before" || return
  pm_capture_bounded LEDGER_REPOSITORY_TO_LEDGER_COUNT filesystem_metadata 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
    awk 'NF{count++} END{print count+0}' "$TMP/repository-to-ledger" || return
  pm_capture_bounded LEDGER_TO_REPOSITORY_COUNT filesystem_metadata 60 METADATA_TIMEOUT RESTORE_QUERY_FAILED \
    awk 'NF{count++} END{print count+0}' "$TMP/ledger-to-repository" || return

  if [[ $__pm_preflight_hash != "$ATTESTED_PRODUCTION_LEDGER_SHA256" ||
        $LEDGER_ATTESTATION_SHA256 != "$ATTESTED_PRODUCTION_LEDGER_SHA256" ||
        $__pm_repo_count != 53 || $__pm_repo_unique_count != 53 ||
        $LEDGER_REPOSITORY_TO_LEDGER_COUNT != 8 || $LEDGER_TO_REPOSITORY_COUNT != 1 ]] ||
      ! cmp -s "$TMP/ledger-before" "$TMP/accepted-ledger.sorted" ||
      ! cmp -s "$TMP/accepted-pending.sorted" "$TMP/expected-migrations.sorted" ||
      ! cmp -s "$TMP/repository-to-ledger" "$TMP/expected-migrations.sorted" ||
      [[ $(<"$TMP/ledger-to-repository") != "$ACCEPTED_LEDGER_ONLY_MIGRATION" ]]; then
    pm_restore_ledger_fail RESTORE_LEDGER_EXPECTED_SET_MISMATCH
    return
  fi

  if (( LEDGER_INVALID_FORMAT_COUNT > 0 )); then
    LEDGER_NAMING_CLASSIFICATION=RESTORE_LEDGER_HISTORICAL_NAME_ACCEPTED
  else
    LEDGER_NAMING_CLASSIFICATION=RESTORE_LEDGER_MODERN_NAMES
  fi
}

pm_restore_verify_database() {
  pm_restore_query ledger_before_finished RESTORE_LEDGER_FINISHED_CHECK RESTORE_QUERY_FAILED \
    'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL' || return
  pm_restore_assert_uint_equal "$ledger_before_finished" 46 RESTORE_LEDGER_COUNT_MISMATCH || return

  pm_restore_query ledger_before_failed RESTORE_LEDGER_FAILED_CHECK RESTORE_QUERY_FAILED \
    'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL' || return
  pm_restore_assert_uint_equal "$ledger_before_failed" 0 RESTORE_LEDGER_COUNT_MISMATCH || return

  pm_restore_query ledger_before_json RESTORE_LEDGER_NAMES_CHECK RESTORE_QUERY_FAILED \
    'SELECT COALESCE(json_agg(migration_name ORDER BY started_at)::text,'\''[]'\'') FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL' || return
  pm_restore_validate_ledger_json "$ledger_before_json" "$PREFLIGHT_REPORT" "$TMP/repository-migrations" || return

  pm_restore_query catalog_tables RESTORE_CATALOG_TABLES_CHECK RESTORE_QUERY_FAILED \
    "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'" || return
  pm_restore_assert_uint_positive "$catalog_tables" RESTORE_CATALOG_INTEGRITY_FAILED || return
  pm_restore_query catalog_indexes RESTORE_CATALOG_INDEXES_CHECK RESTORE_QUERY_FAILED \
    "SELECT count(*) FROM pg_indexes WHERE schemaname='public'" || return
  pm_restore_assert_uint_positive "$catalog_indexes" RESTORE_CATALOG_INTEGRITY_FAILED || return
  pm_restore_query catalog_constraints RESTORE_CATALOG_CONSTRAINTS_CHECK RESTORE_QUERY_FAILED \
    "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'" || return
  pm_restore_assert_uint_positive "$catalog_constraints" RESTORE_CATALOG_INTEGRITY_FAILED || return

  pm_restore_require_relation RESTORE_REQUIRED_PRISMA_MIGRATIONS_RELATION_CHECK \
    'SELECT to_regclass('\''public."_prisma_migrations"'\'') IS NOT NULL' || return
  pm_restore_require_relation RESTORE_REQUIRED_USERS_RELATION_CHECK \
    'SELECT to_regclass('\''public."users"'\'') IS NOT NULL' || return
  pm_restore_require_relation RESTORE_REQUIRED_CONTACT_RELATION_CHECK \
    'SELECT to_regclass('\''public."Contact"'\'') IS NOT NULL' || return
  pm_restore_require_relation RESTORE_REQUIRED_CHAT_RELATION_CHECK \
    'SELECT to_regclass('\''public."Chat"'\'') IS NOT NULL' || return

  pm_restore_optional_representative representative_migrations representative_migrations_available \
    RESTORE_REPRESENTATIVE_MIGRATIONS_CHECK \
    'SELECT to_regclass('\''public."_prisma_migrations"'\'') IS NOT NULL' \
    'SELECT count(*) FROM "_prisma_migrations"' || return
  pm_restore_optional_representative representative_users representative_users_available \
    RESTORE_REPRESENTATIVE_USER_CHECK \
    'SELECT to_regclass('\''public."users"'\'') IS NOT NULL' \
    'SELECT count(*) FROM "users"' || return
  pm_restore_optional_representative representative_contacts representative_contacts_available \
    RESTORE_REPRESENTATIVE_CONTACT_CHECK \
    'SELECT to_regclass('\''public."Contact"'\'') IS NOT NULL' \
    'SELECT count(*) FROM "Contact"' || return
  pm_restore_optional_representative representative_chats representative_chats_available \
    RESTORE_REPRESENTATIVE_CHAT_CHECK \
    'SELECT to_regclass('\''public."Chat"'\'') IS NOT NULL' \
    'SELECT count(*) FROM "Chat"' || return

  pm_restore_enter_check RESTORE_REPORT_RENDER_CHECK || return
  pm_write_bounded "$TMP/representative-counts.json" report_render 60 \
    METADATA_TIMEOUT RESTORE_REPRESENTATIVE_CHECK_FAILED jq -n \
    --argjson migrations "$representative_migrations" --argjson migrationsAvailable "$representative_migrations_available" \
    --argjson users "$representative_users" --argjson usersAvailable "$representative_users_available" \
    --argjson contacts "$representative_contacts" --argjson contactsAvailable "$representative_contacts_available" \
    --argjson chats "$representative_chats" --argjson chatsAvailable "$representative_chats_available" \
    '{prismaMigrations:{physicalRelation:"_prisma_migrations",available:$migrationsAvailable,count:$migrations},
      user:{physicalRelation:"users",available:$usersAvailable,count:$users},
      contact:{physicalRelation:"Contact",available:$contactsAvailable,count:$contacts},
      chat:{physicalRelation:"Chat",available:$chatsAvailable,count:$chats},contentPrinted:false}' || return
}
