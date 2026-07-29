#!/usr/bin/env bash

# Exact prior-run residual cleanup. This helper is sourced only after its own
# SHA-256 binding is verified by isolated-release-probe.sh. It never removes a
# wildcard, Docker object, image, mount, backup, profile, or production path.

readonly PM_PRIOR_RESIDUAL_PATH='/var/tmp/personal-max-stage8b1i.fee32e594eba.NKiRfY'
readonly PM_PRIOR_RESIDUAL_RUN_ID='fee32e594eba'
readonly PM_PRIOR_RESIDUAL_ORIGIN_SCRIPT_SHA256='57d7cba75198c002de902d1ef569681eb14d89e594ca9488214cd99fb3ec4d38'
readonly PM_LATEST_ACCEPTED_FAILURE_REPORT='/var/tmp/personal-max-stage8b1i-isolated-release-proof.failure.6ebdbd0221c4fb395f5a255ded0f18a3e63b6f677baa644e5b0dd0296992f1f3.json'
readonly PM_LATEST_ACCEPTED_FAILURE_REPORT_SHA256='0203c1287fc2415367e10852fb83bb8001f558f2484c8e6cafe14d86c7d3dd67'
readonly PM_LATEST_ACCEPTED_SCRIPT_SHA256='6ebdbd0221c4fb395f5a255ded0f18a3e63b6f677baa644e5b0dd0296992f1f3'

: "${PRIOR_RESIDUAL_CLEANUP_ATTEMPTED:=false}"
: "${PRIOR_RESIDUAL_CLEANUP_COMPLETED:=false}"
: "${PRIOR_RESIDUAL_PROCESS_REFERENCES:=unknown}"
: "${PRIOR_RESIDUAL_DOCKER_OBJECTS:=unknown}"

pm_prior_residual_metadata_is_safe() {
  local __pm_path=${1:-} __pm_identity=${2:-} __pm_mount=${3:-unknown}
  [[ $__pm_path == "$PM_PRIOR_RESIDUAL_PATH" && \
    $__pm_path =~ ^/var/tmp/personal-max-stage8b1i\.[0-9a-f]{12}\.[A-Za-z0-9]{6}$ && \
    $__pm_identity =~ ^[0-9]+:[0-9]+:0:0:700:directory$ && $__pm_mount == false ]]
}

pm_prior_residual_report_is_safe() {
  local __pm_path=${1:-} __pm_sha=${2:-} __pm_stat=${3:-} __pm_script=${4:-}
  [[ $__pm_path == "$PM_LATEST_ACCEPTED_FAILURE_REPORT" && \
    $__pm_sha == "$PM_LATEST_ACCEPTED_FAILURE_REPORT_SHA256" && \
    $__pm_stat == root:codexbot:640 && $__pm_script == "$PM_LATEST_ACCEPTED_SCRIPT_SHA256" ]]
}

pm_prior_residual_process_scan() {
  pm_run_bounded prior_residual_cleanup 30 PRIOR_RESIDUAL_IN_USE PRIOR_RESIDUAL_IN_USE \
    bash -c '
      target=$1
      for link in /proc/[0-9]*/cwd /proc/[0-9]*/root /proc/[0-9]*/exe /proc/[0-9]*/fd/*; do
        [ -L "$link" ] || continue
        resolved=$(readlink -f -- "$link" 2>/dev/null) || exit 11
        case $resolved in "$target"|"$target"/*) exit 10 ;; esac
      done
    ' stage8b1i-residual-scan "$PM_PRIOR_RESIDUAL_PATH"
}

pm_cleanup_prior_residual() {
  local __pm_report_sha='' __pm_report_stat='' __pm_report_script='' __pm_residual_identity=''
  local __pm_residual_identity_final='' __pm_production_head='' __pm_production_status_line=''
  local __pm_production_status_sha='' __pm_containers='' __pm_networks='' __pm_volumes=''
  local __pm_mount_status
  [[ $PRIOR_RESIDUAL_CLEANUP_ATTEMPTED == false ]] || {
    PROBE_ERROR_CLASSIFICATION=PRIOR_RESIDUAL_CLEANUP_REENTRY
    return 70
  }
  PRIOR_RESIDUAL_CLEANUP_ATTEMPTED=true
  pm_enter_phase prior_residual_cleanup filesystem_metadata || return

  [[ -d $PM_PRIOR_RESIDUAL_PATH && ! -L $PM_PRIOR_RESIDUAL_PATH ]] || {
    PROBE_ERROR_CLASSIFICATION=PRIOR_RESIDUAL_PATH_UNSAFE
    return 70
  }
  pm_capture_bounded_internal __pm_residual_identity filesystem_metadata 30 METADATA_TIMEOUT PRIOR_RESIDUAL_METADATA_FAILED \
    stat -c '%d:%i:%u:%g:%a:%F' -- "$PM_PRIOR_RESIDUAL_PATH" || return
  pm_prior_residual_metadata_is_safe "$PM_PRIOR_RESIDUAL_PATH" "$__pm_residual_identity" false || {
    PROBE_ERROR_CLASSIFICATION=PRIOR_RESIDUAL_METADATA_FAILED
    return 70
  }
  if pm_run_bounded filesystem_metadata 30 METADATA_TIMEOUT PRIOR_RESIDUAL_MOUNTPOINT_REFUSED \
      mountpoint -q -- "$PM_PRIOR_RESIDUAL_PATH"; then
    PROBE_ERROR_CLASSIFICATION=PRIOR_RESIDUAL_MOUNTPOINT_REFUSED
    return 70
  else
    __pm_mount_status=$?
    [[ $__pm_mount_status -eq 1 ]] || return "$__pm_mount_status"
    PROBE_ERROR_CLASSIFICATION=NONE
  fi
  pm_prior_residual_process_scan || {
    PRIOR_RESIDUAL_PROCESS_REFERENCES=unknown
    PROBE_ERROR_CLASSIFICATION=PRIOR_RESIDUAL_IN_USE
    return 70
  }
  PRIOR_RESIDUAL_PROCESS_REFERENCES=0

  pm_capture_bounded_internal __pm_containers docker_metadata 30 METADATA_TIMEOUT PRIOR_RESIDUAL_DOCKER_OBJECTS_PRESENT \
    docker ps -aq --no-trunc --filter "label=$STAGE_LABEL" --filter "label=$RUN_LABEL_KEY=$PM_PRIOR_RESIDUAL_RUN_ID" || return
  pm_capture_bounded_internal __pm_networks docker_metadata 30 METADATA_TIMEOUT PRIOR_RESIDUAL_DOCKER_OBJECTS_PRESENT \
    docker network ls -q --filter "label=$STAGE_LABEL" --filter "label=$RUN_LABEL_KEY=$PM_PRIOR_RESIDUAL_RUN_ID" || return
  pm_capture_bounded_internal __pm_volumes docker_metadata 30 METADATA_TIMEOUT PRIOR_RESIDUAL_DOCKER_OBJECTS_PRESENT \
    docker volume ls -q --filter "label=$STAGE_LABEL" --filter "label=$RUN_LABEL_KEY=$PM_PRIOR_RESIDUAL_RUN_ID" || return
  [[ -z $__pm_containers && -z $__pm_networks && -z $__pm_volumes ]] || {
    PRIOR_RESIDUAL_DOCKER_OBJECTS=present
    PROBE_ERROR_CLASSIFICATION=PRIOR_RESIDUAL_DOCKER_OBJECTS_PRESENT
    return 70
  }
  PRIOR_RESIDUAL_DOCKER_OBJECTS=0

  [[ -f $PM_LATEST_ACCEPTED_FAILURE_REPORT && ! -L $PM_LATEST_ACCEPTED_FAILURE_REPORT ]] || {
    PROBE_ERROR_CLASSIFICATION=PRIOR_RESIDUAL_REPORT_REFUSED
    return 70
  }
  pm_capture_bounded_internal __pm_report_sha filesystem_metadata 30 METADATA_TIMEOUT PRIOR_RESIDUAL_REPORT_REFUSED \
    sha256sum -- "$PM_LATEST_ACCEPTED_FAILURE_REPORT" || return
  __pm_report_sha=${__pm_report_sha%% *}
  pm_capture_bounded_internal __pm_report_stat filesystem_metadata 30 METADATA_TIMEOUT PRIOR_RESIDUAL_REPORT_REFUSED \
    stat -Lc '%U:%G:%a' -- "$PM_LATEST_ACCEPTED_FAILURE_REPORT" || return
  pm_capture_bounded_internal __pm_report_script filesystem_metadata 30 METADATA_TIMEOUT PRIOR_RESIDUAL_REPORT_REFUSED \
    jq -er --arg script "$PM_LATEST_ACCEPTED_SCRIPT_SHA256" \
      'select(.schemaVersion==1 and .mode=="ISOLATED_RELEASE_PROOF_FAILURE" and
        .script.sha256==$script and .script.checksumBound==true and .cleanup.completed==true and
        .cleanup.containersRemaining==0 and .cleanup.networksRemaining==0 and
        .cleanup.volumesRemaining==0 and .productionImmutability.productionDatabaseConnections==0) |
        .script.sha256' "$PM_LATEST_ACCEPTED_FAILURE_REPORT" || return
  pm_prior_residual_report_is_safe "$PM_LATEST_ACCEPTED_FAILURE_REPORT" "$__pm_report_sha" \
    "$__pm_report_stat" "$__pm_report_script" || {
    PROBE_ERROR_CLASSIFICATION=PRIOR_RESIDUAL_REPORT_REFUSED
    return 70
  }

  pm_capture_bounded_internal __pm_production_head filesystem_metadata 30 METADATA_TIMEOUT PRODUCTION_GIT_BASELINE_MISMATCH \
    env GIT_OPTIONAL_LOCKS=0 git -C /opt/crm rev-parse HEAD || return
  pm_capture_bounded_internal __pm_production_status_line filesystem_metadata 30 METADATA_TIMEOUT PRODUCTION_GIT_BASELINE_MISMATCH \
    bash -o pipefail -c 'env GIT_OPTIONAL_LOCKS=0 git -C /opt/crm status --porcelain=v2 --untracked-files=all | sha256sum' || return
  __pm_production_status_sha=${__pm_production_status_line%% *}
  [[ $__pm_production_head == "$ACCEPTED_PRODUCTION_HEAD" && \
    $__pm_production_status_sha == "$ACCEPTED_PRODUCTION_STATUS_V2_RAW_SHA256" ]] || {
    PROBE_ERROR_CLASSIFICATION=PRODUCTION_GIT_BASELINE_MISMATCH
    return 70
  }

  pm_capture_bounded_internal __pm_residual_identity_final filesystem_metadata 30 METADATA_TIMEOUT PRIOR_RESIDUAL_METADATA_FAILED \
    stat -c '%d:%i:%u:%g:%a:%F' -- "$PM_PRIOR_RESIDUAL_PATH" || return
  [[ $__pm_residual_identity_final == "$__pm_residual_identity" ]] || {
    PROBE_ERROR_CLASSIFICATION=PRIOR_RESIDUAL_METADATA_FAILED
    return 70
  }
  pm_run_bounded prior_residual_cleanup 60 PRIOR_RESIDUAL_REMOVAL_TIMEOUT PRIOR_RESIDUAL_REMOVAL_FAILED \
    rm -rf -- "$PM_PRIOR_RESIDUAL_PATH" || return
  [[ ! -e $PM_PRIOR_RESIDUAL_PATH && ! -L $PM_PRIOR_RESIDUAL_PATH ]] || {
    PROBE_ERROR_CLASSIFICATION=PRIOR_RESIDUAL_REMOVAL_FAILED
    return 70
  }
  PRIOR_RESIDUAL_CLEANUP_COMPLETED=true
  PROBE_ERROR_CLASSIFICATION=NONE
}
