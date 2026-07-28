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
  local pm_result_restore_running=''
  if ! pm_capture_bounded pm_result_restore_running docker_disposable 30 \
      DISPOSABLE_DOCKER_TIMEOUT DISPOSABLE_CONTAINER_UNAVAILABLE \
      docker inspect --format '{{if .State.Running}}true{{else}}false{{end}}' "$PG_CONTAINER"; then
    PROBE_ERROR_CLASSIFICATION=DISPOSABLE_CONTAINER_UNAVAILABLE
    return 69
  fi
  if [[ $pm_result_restore_running != true ]]; then
    PROBE_ERROR_CLASSIFICATION=DISPOSABLE_CONTAINER_UNAVAILABLE
    return 69
  fi
}

pm_restore_query_raw() {
  local __pm_target_name=${1:-} __pm_failure_class=${2:-} __pm_query=${3-}
  local pm_result_restore_output=''
  pm_require_helper_out_name "$__pm_target_name" || return
  pm_restore_failure_class_is_safe "$__pm_failure_class" || {
    PROBE_ERROR_CLASSIFICATION=RESTORE_QUERY_FAILED
    return 64
  }
  pm_restore_container_available || return
  pm_capture_bounded pm_result_restore_output disposable_postgresql 120 \
    DISPOSABLE_DOCKER_TIMEOUT "$__pm_failure_class" docker exec "$PG_CONTAINER" \
    psql --no-psqlrc -X -A -t -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -c "$__pm_query" || return
  pm_assign_out "$__pm_target_name" "$pm_result_restore_output"
}

pm_restore_query() {
  local __pm_target_name=${1:-} __pm_check_id=${2:-} __pm_failure_class=${3:-} __pm_query=${4-}
  pm_require_helper_out_name "$__pm_target_name" || return
  pm_restore_enter_check "$__pm_check_id" || return
  pm_restore_query_raw "$__pm_target_name" "$__pm_failure_class" "$__pm_query"
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
  local __pm_check_id=${1:-} __pm_presence_query=${2-} restore_result_relation_present=''
  pm_restore_query restore_result_relation_present "$__pm_check_id" RESTORE_QUERY_FAILED "$__pm_presence_query" || return
  if [[ $restore_result_relation_present != t ]]; then
    PROBE_ERROR_CLASSIFICATION=RESTORE_REQUIRED_RELATION_MISSING
    return 67
  fi
}

pm_restore_optional_representative() {
  local __pm_count_target=${1:-} __pm_available_target=${2:-} __pm_check_id=${3:-}
  local __pm_presence_query=${4-} __pm_count_query=${5-} restore_result_relation_present='' restore_result_count=''
  pm_require_helper_out_name "$__pm_count_target" || return
  pm_require_helper_out_name "$__pm_available_target" || return
  [[ $__pm_count_target != "$__pm_available_target" ]] || return 64
  pm_restore_query restore_result_relation_present "$__pm_check_id" RESTORE_QUERY_FAILED "$__pm_presence_query" || return
  case $restore_result_relation_present in
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
  pm_restore_query restore_result_count "$__pm_check_id" RESTORE_REPRESENTATIVE_CHECK_FAILED "$__pm_count_query" || return
  if ! pm_safe_uint "$restore_result_count"; then
    PROBE_ERROR_CLASSIFICATION=RESTORE_REPRESENTATIVE_CHECK_FAILED
    return 67
  fi
  pm_assign_out "$__pm_count_target" "$restore_result_count"
  pm_assign_out "$__pm_available_target" true
}

pm_restore_verify_database() {
  local ledger_name_count ledger_unique_count

  pm_restore_query ledger_before_finished RESTORE_LEDGER_FINISHED_CHECK RESTORE_QUERY_FAILED \
    'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL' || return
  pm_restore_assert_uint_equal "$ledger_before_finished" 46 RESTORE_LEDGER_MISMATCH || return

  pm_restore_query ledger_before_failed RESTORE_LEDGER_FAILED_CHECK RESTORE_QUERY_FAILED \
    'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL' || return
  pm_restore_assert_uint_equal "$ledger_before_failed" 0 RESTORE_LEDGER_MISMATCH || return

  pm_restore_query ledger_before RESTORE_LEDGER_NAMES_CHECK RESTORE_QUERY_FAILED \
    'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name' || return
  ledger_name_count=$(awk 'NF{count++} END{print count+0}' <<<"$ledger_before")
  ledger_unique_count=$(printf '%s\n' "$ledger_before" | awk 'NF' | LC_ALL=C sort -u | awk 'END{print NR+0}')
  if (( ledger_name_count != 46 || ledger_unique_count != 46 )) || \
      grep -Ev '^[0-9]{14}_[a-z0-9_]+$' <<<"$ledger_before" >/dev/null; then
    PROBE_ERROR_CLASSIFICATION=RESTORE_LEDGER_MISMATCH
    return 67
  fi
  pm_write_bounded "$TMP/ledger-before" disposable_postgresql 60 \
    RESTORE_QUERY_FAILED RESTORE_LEDGER_MISMATCH printf '%s\n' "$ledger_before" || return

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
