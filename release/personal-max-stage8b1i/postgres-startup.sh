#!/usr/bin/env bash
# Privacy-safe disposable PostgreSQL startup state machine.
# Raw logs, command output, environment values, credentials, and SQL results
# are never copied into diagnostics.
# shellcheck disable=SC2034

: "${POSTGRES_STARTUP_STATUS:=NOT_OBSERVED}"
: "${POSTGRES_STARTUP_LAST_OPERATION:=NOT_OBSERVED}"
: "${POSTGRES_CONTAINER_STATE:=not_observed}"
: "${POSTGRES_CONTAINER_EXIT_CODE:=not_observed}"
: "${POSTGRES_CONTAINER_HEALTH:=not_observed}"
: "${POSTGRES_READINESS_ATTEMPTS:=0}"
: "${POSTGRES_READINESS_TRANSIENT_COUNT:=0}"
: "${POSTGRES_READINESS_LAST_EXIT:=not_observed}"
: "${POSTGRES_VERSION_QUERY_ATTEMPTS:=0}"
: "${POSTGRES_VERSION_TRANSIENT_COUNT:=0}"
: "${POSTGRES_VERSION_LAST_EXIT:=not_observed}"
: "${POSTGRES_VERSION_MATCHED:=false}"
: "${POSTGRES_STARTUP_ELAPSED_SECONDS:=0}"

pm_postgres_check_id_is_safe() {
  case ${1:-} in
    POSTGRES_CONTAINER_START_CHECK | POSTGRES_READINESS_CHECK | \
      POSTGRES_SERVER_VERSION_QUERY_CHECK | POSTGRES_SERVER_VERSION_MATCH_CHECK) return 0 ;;
    *) return 1 ;;
  esac
}

pm_postgres_set_check() {
  local __pm_check_id=${1:-}
  pm_postgres_check_id_is_safe "$__pm_check_id" || {
    PROBE_ERROR_CLASSIFICATION=POSTGRES_READINESS_COMMAND_FAILED
    return 64
  }
  RESTORE_CHECK_ID=$__pm_check_id
}

pm_postgres_sleep() { sleep "$1"; }

pm_postgres_start_container() {
  local __pm_status
  pm_postgres_set_check POSTGRES_CONTAINER_START_CHECK || return
  POSTGRES_STARTUP_LAST_OPERATION=container_start
  POSTGRES_STARTUP_STATUS=CONTAINER_STARTING
  if pm_run_bounded docker_disposable 120 POSTGRES_CONTAINER_START_FAILED \
      POSTGRES_CONTAINER_START_FAILED "$@" >/dev/null; then
    PROBE_ERROR_CLASSIFICATION=NONE
    POSTGRES_STARTUP_STATUS=CONTAINER_STARTED
    return 0
  else
    __pm_status=$?
  fi
  PROBE_ERROR_CLASSIFICATION=POSTGRES_CONTAINER_START_FAILED
  POSTGRES_STARTUP_STATUS=CONTAINER_START_FAILED
  return "$__pm_status"
}

pm_postgres_observe_container() {
  local pm_result_postgres_state='' __pm_state __pm_exit __pm_health __pm_extra
  if ! pm_capture_bounded pm_result_postgres_state docker_metadata 30 \
      POSTGRES_READINESS_COMMAND_FAILED POSTGRES_READINESS_COMMAND_FAILED \
      docker inspect --format \
      '{{.State.Status}}|{{.State.ExitCode}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      "$PG_CONTAINER"; then
    PROBE_ERROR_CLASSIFICATION=POSTGRES_READINESS_COMMAND_FAILED
    return 69
  fi
  IFS='|' read -r __pm_state __pm_exit __pm_health __pm_extra <<<"$pm_result_postgres_state"
  case $__pm_state in created | running | restarting | removing | paused | exited | dead) ;;
    *) PROBE_ERROR_CLASSIFICATION=POSTGRES_READINESS_COMMAND_FAILED; return 65 ;;
  esac
  [[ $__pm_exit =~ ^[0-9]+$ ]] || { PROBE_ERROR_CLASSIFICATION=POSTGRES_READINESS_COMMAND_FAILED; return 65; }
  case $__pm_health in none | starting | healthy | unhealthy) ;;
    *) PROBE_ERROR_CLASSIFICATION=POSTGRES_READINESS_COMMAND_FAILED; return 65 ;;
  esac
  [[ -z $__pm_extra ]] || { PROBE_ERROR_CLASSIFICATION=POSTGRES_READINESS_COMMAND_FAILED; return 65; }
  POSTGRES_CONTAINER_STATE=$__pm_state
  POSTGRES_CONTAINER_EXIT_CODE=$__pm_exit
  POSTGRES_CONTAINER_HEALTH=$__pm_health
}

pm_postgres_execute_readiness() {
  pm_run_bounded docker_disposable 30 POSTGRES_READINESS_COMMAND_FAILED \
    POSTGRES_READINESS_COMMAND_FAILED docker exec "$PG_CONTAINER" \
    pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1
}

pm_postgres_wait_readiness() {
  local __pm_max_attempts=${1:-} __pm_elapsed_limit=${2:-}
  local __pm_started=$SECONDS __pm_attempt __pm_status __pm_elapsed
  pm_safe_uint "$__pm_max_attempts" && pm_safe_uint "$__pm_elapsed_limit" || return 64
  (( __pm_max_attempts > 0 && __pm_elapsed_limit > 0 )) || return 64
  pm_postgres_set_check POSTGRES_READINESS_CHECK || return
  POSTGRES_STARTUP_LAST_OPERATION=readiness_poll
  POSTGRES_STARTUP_STATUS=READINESS_POLLING
  for (( __pm_attempt=1; __pm_attempt<=__pm_max_attempts; __pm_attempt++ )); do
    POSTGRES_READINESS_ATTEMPTS=$__pm_attempt
    if ! pm_postgres_observe_container; then
      PROBE_ERROR_CLASSIFICATION=POSTGRES_READINESS_COMMAND_FAILED
      POSTGRES_STARTUP_STATUS=READINESS_OBSERVATION_FAILED
      return 69
    fi
    case $POSTGRES_CONTAINER_STATE in
      exited | dead)
        PROBE_ERROR_CLASSIFICATION=POSTGRES_CONTAINER_EXITED_DURING_STARTUP
        POSTGRES_STARTUP_STATUS=CONTAINER_EXITED_DURING_STARTUP
        return 69
        ;;
      running)
        if pm_postgres_execute_readiness; then __pm_status=0; else __pm_status=$?; fi
        POSTGRES_READINESS_LAST_EXIT=$__pm_status
        case $__pm_status in
          0)
            PROBE_ERROR_CLASSIFICATION=NONE
            POSTGRES_STARTUP_STATUS=READINESS_CONFIRMED
            POSTGRES_STARTUP_ELAPSED_SECONDS=$((SECONDS - __pm_started))
            return 0
            ;;
          1 | 2)
            POSTGRES_READINESS_TRANSIENT_COUNT=$((POSTGRES_READINESS_TRANSIENT_COUNT + 1))
            PROBE_ERROR_CLASSIFICATION=NONE
            ;;
          *)
            PROBE_ERROR_CLASSIFICATION=POSTGRES_READINESS_COMMAND_FAILED
            POSTGRES_STARTUP_STATUS=READINESS_COMMAND_FAILED
            POSTGRES_STARTUP_ELAPSED_SECONDS=$((SECONDS - __pm_started))
            return "$__pm_status"
            ;;
        esac
        ;;
      *)
        POSTGRES_READINESS_TRANSIENT_COUNT=$((POSTGRES_READINESS_TRANSIENT_COUNT + 1))
        POSTGRES_READINESS_LAST_EXIT=not_invoked
        PROBE_ERROR_CLASSIFICATION=NONE
        ;;
    esac
    __pm_elapsed=$((SECONDS - __pm_started))
    POSTGRES_STARTUP_ELAPSED_SECONDS=$__pm_elapsed
    if (( __pm_attempt == __pm_max_attempts || __pm_elapsed >= __pm_elapsed_limit )); then
      PROBE_ERROR_CLASSIFICATION=POSTGRES_READINESS_TIMEOUT
      POSTGRES_STARTUP_STATUS=READINESS_TIMEOUT
      return 124
    fi
    pm_postgres_sleep 1
  done
}

pm_postgres_execute_version() {
  local __pm_target_name=${1:-} pm_result_postgres_version=''
  pm_validate_out_name "$__pm_target_name" || return
  pm_capture_bounded pm_result_postgres_version disposable_postgresql 30 \
    POSTGRES_VERSION_QUERY_FAILED POSTGRES_VERSION_QUERY_FAILED \
    docker exec "$PG_CONTAINER" psql --no-psqlrc -X -A -t -v ON_ERROR_STOP=1 \
    -U "$PG_USER" -d "$PG_DB" -c 'SHOW server_version' || return
  pm_assign_out "$__pm_target_name" "$pm_result_postgres_version"
}

pm_postgres_wait_version() {
  local __pm_target_name=${1:-} __pm_expected=${2:-} __pm_max_attempts=${3:-} __pm_elapsed_limit=${4:-}
  local __pm_started=$SECONDS __pm_attempt __pm_status=69 __pm_elapsed pm_result_postgres_version=''
  pm_validate_out_name "$__pm_target_name" || return
  pm_safe_uint "$__pm_max_attempts" && pm_safe_uint "$__pm_elapsed_limit" || return 64
  (( __pm_max_attempts > 0 && __pm_elapsed_limit > 0 )) || return 64
  pm_postgres_set_check POSTGRES_SERVER_VERSION_QUERY_CHECK || return
  POSTGRES_STARTUP_LAST_OPERATION=server_version_query
  POSTGRES_STARTUP_STATUS=VERSION_QUERY_POLLING
  for (( __pm_attempt=1; __pm_attempt<=__pm_max_attempts; __pm_attempt++ )); do
    POSTGRES_VERSION_QUERY_ATTEMPTS=$__pm_attempt
    if ! pm_postgres_observe_container; then
      PROBE_ERROR_CLASSIFICATION=POSTGRES_VERSION_QUERY_FAILED
      POSTGRES_STARTUP_STATUS=VERSION_OBSERVATION_FAILED
      return 69
    fi
    case $POSTGRES_CONTAINER_STATE in
      exited | dead)
        PROBE_ERROR_CLASSIFICATION=POSTGRES_CONTAINER_EXITED_DURING_STARTUP
        POSTGRES_STARTUP_STATUS=CONTAINER_EXITED_DURING_STARTUP
        return 69
        ;;
      running)
        if pm_postgres_execute_version pm_result_postgres_version; then __pm_status=0; else __pm_status=$?; fi
        POSTGRES_VERSION_LAST_EXIT=$__pm_status
        case $__pm_status in
          0)
            pm_postgres_set_check POSTGRES_SERVER_VERSION_MATCH_CHECK || return
            if [[ $pm_result_postgres_version != "$__pm_expected" ]]; then
              POSTGRES_VERSION_MATCHED=false
              PROBE_ERROR_CLASSIFICATION=POSTGRES_VERSION_MISMATCH
              POSTGRES_STARTUP_STATUS=VERSION_MISMATCH
              return 67
            fi
            pm_assign_out "$__pm_target_name" "$pm_result_postgres_version" || return
            POSTGRES_VERSION_MATCHED=true
            PROBE_ERROR_CLASSIFICATION=NONE
            POSTGRES_STARTUP_STATUS=READY
            POSTGRES_STARTUP_ELAPSED_SECONDS=$((POSTGRES_STARTUP_ELAPSED_SECONDS + SECONDS - __pm_started))
            return 0
            ;;
          1 | 2)
            POSTGRES_VERSION_TRANSIENT_COUNT=$((POSTGRES_VERSION_TRANSIENT_COUNT + 1))
            PROBE_ERROR_CLASSIFICATION=NONE
            ;;
          *)
            PROBE_ERROR_CLASSIFICATION=POSTGRES_VERSION_QUERY_FAILED
            POSTGRES_STARTUP_STATUS=VERSION_QUERY_FAILED
            return "$__pm_status"
            ;;
        esac
        ;;
      *)
        POSTGRES_VERSION_TRANSIENT_COUNT=$((POSTGRES_VERSION_TRANSIENT_COUNT + 1))
        POSTGRES_VERSION_LAST_EXIT=not_invoked
        PROBE_ERROR_CLASSIFICATION=NONE
        ;;
    esac
    __pm_elapsed=$((SECONDS - __pm_started))
    if (( __pm_attempt == __pm_max_attempts || __pm_elapsed >= __pm_elapsed_limit )); then
      PROBE_ERROR_CLASSIFICATION=POSTGRES_VERSION_QUERY_FAILED
      POSTGRES_STARTUP_STATUS=VERSION_QUERY_FAILED
      return "$__pm_status"
    fi
    pm_postgres_sleep 1
  done
}
