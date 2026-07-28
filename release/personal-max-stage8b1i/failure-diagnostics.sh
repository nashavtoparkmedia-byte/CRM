#!/usr/bin/env bash

# Sourced only after package checksum validation. This helper never records a
# failed command, arguments, SQL, stderr, environment values, or data content.

personal_max_stage8b1i_safe_phase() {
  case ${1:-} in
    bootstrap_complete | source_binding | storage_gate | production_snapshot_before | image_acquisition | \
      image_verification | post_pull_storage_gate | disposable_topology | postgresql_start | backup_restore | restore_verification | \
      migration_preflight | disposable_migration | migration_verification | gateway_negative | gateway_dormant | \
      gateway_active | scraper_default_off | e2e_outage | e2e_recovery | e2e_verification | \
      production_snapshot_after | cleanup | final_storage_gate | report_render | report_validation | report_handoff | completed) return 0 ;;
    *) return 1 ;;
  esac
}

personal_max_stage8b1i_safe_error() {
  case ${1:-} in
    NONE | UNEXPECTED_COMMAND_FAILURE | METADATA_TIMEOUT | METADATA_FAILED | GATEWAY_PULL_TIMEOUT | \
      SCRAPER_PULL_TIMEOUT | REGISTRY_AUTHENTICATION_DENIED | REGISTRY_MANIFEST_NOT_FOUND | \
      REGISTRY_DIGEST_MISMATCH | REGISTRY_ACCESS_UNAVAILABLE | DISPOSABLE_DOCKER_TIMEOUT | \
      DISPOSABLE_DOCKER_FAILED | RESTORE_LIST_TIMEOUT | RESTORE_LIST_FAILED | FULL_RESTORE_TIMEOUT | \
      FULL_RESTORE_FAILED | MIGRATION_INVENTORY_TIMEOUT | MIGRATION_SCAN_TIMEOUT | MIGRATE_DEPLOY_TIMEOUT | \
      MIGRATE_DEPLOY_FAILED | PRISMA_DIFF_TIMEOUT | PRISMA_DIFF_FAILED | GATEWAY_STARTUP_TIMEOUT | \
      GATEWAY_NEGATIVE_TIMEOUT | SYNTHETIC_HARNESS_TIMEOUT | GATEWAY_CLIENT_TIMEOUT | \
      POLLING_DEADLINE_EXCEEDED | CONTAINER_REMOVAL_TIMEOUT | NETWORK_REMOVAL_TIMEOUT | \
      VOLUME_REMOVAL_TIMEOUT | TEMP_REMOVAL_TIMEOUT | CLEANUP_GLOBAL_DEADLINE_EXCEEDED | \
      CLEANUP_INCOMPLETE | PRE_PULL_DISK_GATE_FAILED | POST_PULL_DISK_GATE_FAILED | FINAL_DISK_GATE_FAILED | \
      SUCCESS_REPORT_VALIDATION_TIMEOUT | SUCCESS_REPORT_MALFORMED | SUCCESS_REPORT_SAFETY_VIOLATION | \
      EXPECTED_FAILURE_NOT_OBSERVED | INVALID_OUT_PARAMETER | EMERGENCY_DIAGNOSTICS_USED | \
      EMERGENCY_DIAGNOSTICS_UNAVAILABLE) return 0 ;;
    *) return 1 ;;
  esac
}

personal_max_stage8b1i_safe_class() {
  case ${1:-} in
    package_validation | filesystem_metadata | docker_metadata | docker_pull | docker_disposable | \
      backup_validation | disposable_postgresql | disposable_migration | synthetic_http | synthetic_harness | \
      cleanup | report_render | report_handoff | unknown) return 0 ;;
    *) return 1 ;;
  esac
}

personal_max_stage8b1i_render_failure() {
  local original_exit=${1:-1} source_line=${2:-0} cleanup_ok=${3:-false}
  local safe_phase safe_class safe_error cleanup_error generated temporary identity final_identity permissions report_sha
  local post_pull_required post_pull_observed post_pull_deficit final_observed final_deficit cleanup_containers cleanup_networks cleanup_volumes cleanup_temp
  local cleanup_containers_json cleanup_networks_json cleanup_volumes_json cleanup_temp_json
  [[ $original_exit =~ ^[1-9][0-9]*$ && $original_exit -le 255 ]] || original_exit=1
  [[ $source_line =~ ^[0-9]+$ ]] || source_line=0
  safe_phase=${PROBE_PHASE:-bootstrap_complete}
  personal_max_stage8b1i_safe_phase "$safe_phase" || safe_phase=bootstrap_complete
  safe_class=${PROBE_SAFE_COMMAND_CLASS:-unknown}
  personal_max_stage8b1i_safe_class "$safe_class" || safe_class=unknown
  safe_error=${PROBE_ERROR_CLASSIFICATION:-UNEXPECTED_COMMAND_FAILURE}
  personal_max_stage8b1i_safe_error "$safe_error" || safe_error=UNEXPECTED_COMMAND_FAILURE
  cleanup_error=${CLEANUP_ERROR_CLASSIFICATION:-NONE}
  personal_max_stage8b1i_safe_error "$cleanup_error" || cleanup_error=CLEANUP_INCOMPLETE
  [[ $cleanup_ok == true ]] || cleanup_ok=false
  pm_capture_bounded generated filesystem_metadata 30 METADATA_TIMEOUT METADATA_FAILED date -u +'%Y-%m-%dT%H:%M:%SZ' || generated='1970-01-01T00:00:00Z'
  post_pull_required=$((REQUIRED_FREE_BYTES + PROBE_BUDGET_BYTES))
  post_pull_observed=${FREE_BYTES_AFTER_PULL:-0}
  pm_safe_uint "$post_pull_observed" || post_pull_observed=0
  if (( post_pull_observed == 0 )); then
    post_pull_observed=${FREE_BYTES_AFTER_SCRAPER_PULL:-0}
    pm_safe_uint "$post_pull_observed" || post_pull_observed=0
  fi
  if (( post_pull_observed == 0 )); then
    post_pull_observed=${FREE_BYTES_AFTER_GATEWAY_PULL:-0}
    pm_safe_uint "$post_pull_observed" || post_pull_observed=0
  fi
  post_pull_deficit=$((post_pull_required > post_pull_observed ? post_pull_required - post_pull_observed : 0))
  final_observed=${FREE_BYTES_AFTER_CLEANUP:-0}
  pm_safe_uint "$final_observed" || final_observed=0
  final_deficit=$((REQUIRED_FREE_BYTES > final_observed ? REQUIRED_FREE_BYTES - final_observed : 0))
  cleanup_containers=${CLEANUP_CONTAINERS_REMAINING:-unknown}
  cleanup_networks=${CLEANUP_NETWORKS_REMAINING:-unknown}
  cleanup_volumes=${CLEANUP_VOLUMES_REMAINING:-unknown}
  cleanup_temp=${CLEANUP_TEMP_FILES_REMAINING:-unknown}
  if [[ $cleanup_containers =~ ^[0-9]+$ ]]; then cleanup_containers_json=$cleanup_containers; else cleanup_containers_json='"unknown"'; fi
  if [[ $cleanup_networks =~ ^[0-9]+$ ]]; then cleanup_networks_json=$cleanup_networks; else cleanup_networks_json='"unknown"'; fi
  if [[ $cleanup_volumes =~ ^[0-9]+$ ]]; then cleanup_volumes_json=$cleanup_volumes; else cleanup_volumes_json='"unknown"'; fi
  if [[ $cleanup_temp =~ ^[0-9]+$ ]]; then cleanup_temp_json=$cleanup_temp; else cleanup_temp_json='"unknown"'; fi

  if [[ -e $PM_FAILURE_PATH || -L $PM_FAILURE_PATH ]]; then
    printf 'ISOLATED_PROBE_FAILED\nPHASE=%s\nEXIT_CODE=%s\nFAILURE_REPORT_PATH_UNSAFE\n' "$safe_phase" "$original_exit" >&2
    return 74
  fi
  pm_capture_bounded temporary filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
    mktemp /var/tmp/personal-max-stage8b1i-isolated-release-proof.failure.tmp.XXXXXX || return 74
  pm_run_bounded report_handoff 60 METADATA_TIMEOUT METADATA_FAILED chmod 0600 "$temporary" || return 74
  pm_write_bounded "$temporary" report_render 60 METADATA_TIMEOUT METADATA_FAILED jq -n \
    --arg generatedAt "$generated" --arg scriptSha256 "$PM_SCRIPT_SHA256" \
    --arg phase "$safe_phase" --arg safeCommandClass "$safe_class" --arg classification "$safe_error" \
    --arg cleanupErrorClassification "$cleanup_error" \
    --argjson exitCode "$original_exit" --argjson sourceLine "$source_line" \
    --argjson cleanupCompleted "$cleanup_ok" \
    --argjson cleanupContainers "$cleanup_containers_json" --argjson cleanupNetworks "$cleanup_networks_json" \
    --argjson cleanupVolumes "$cleanup_volumes_json" --argjson cleanupTemp "$cleanup_temp_json" \
    --argjson gatewayPreexisting "${GATEWAY_PREEXISTING_BEFORE_PULL:-false}" \
    --arg gatewayImageIdBefore "${GATEWAY_IMAGE_ID_BEFORE:-not_observed}" \
    --argjson gatewayAcquired "${GATEWAY_ACQUIRED_DURING_PROBE:-false}" \
    --argjson scraperPreexisting "${SCRAPER_PREEXISTING_BEFORE_PULL:-false}" \
    --arg scraperImageIdBefore "${SCRAPER_IMAGE_ID_BEFORE:-not_observed}" \
    --argjson scraperAcquired "${SCRAPER_ACQUIRED_DURING_PROBE:-false}" \
    --argjson freeBeforePull "${FREE_BYTES_BEFORE_PULL:-0}" --argjson freeAfterGatewayPull "${FREE_BYTES_AFTER_GATEWAY_PULL:-0}" \
    --argjson freeAfterScraperPull "${FREE_BYTES_AFTER_SCRAPER_PULL:-0}" --argjson freeAfterPull "$post_pull_observed" \
    --argjson freeAfterCleanup "$final_observed" --argjson postPullRequired "$post_pull_required" \
    --argjson postPullDeficit "$post_pull_deficit" --argjson finalRequired "$REQUIRED_FREE_BYTES" --argjson finalDeficit "$final_deficit" \
    '{schemaVersion:1,mode:"ISOLATED_RELEASE_PROOF_FAILURE",generatedAt:$generatedAt,
      script:{sha256:$scriptSha256,checksumBound:true},phase:$phase,safeCommandClass:$safeCommandClass,
      classification:$classification,exitCode:$exitCode,sourceLine:$sourceLine,
      cleanup:{completed:$cleanupCompleted,errorClassification:$cleanupErrorClassification,
        containersRemaining:$cleanupContainers,networksRemaining:$cleanupNetworks,
        volumesRemaining:$cleanupVolumes,tempFilesRemaining:$cleanupTemp,labelScoped:true,globalPrune:false},
      images:{gateway:{preexistingBeforePull:$gatewayPreexisting,imageIdBeforePull:$gatewayImageIdBefore,
          acquiredDuringProbe:$gatewayAcquired,retained:true},
        scraper:{preexistingBeforePull:$scraperPreexisting,imageIdBeforePull:$scraperImageIdBefore,
          acquiredDuringProbe:$scraperAcquired,retained:true},acceptedImagesRetained:true,genericImageRemoval:false},
      storage:{freeBytesBeforePull:$freeBeforePull,freeBytesAfterGatewayPull:$freeAfterGatewayPull,
        freeBytesAfterScraperPull:$freeAfterScraperPull,freeBytesAfterPull:$freeAfterPull,
        freeBytesAfterCleanup:$freeAfterCleanup,postPullRequiredBytes:$postPullRequired,
        postPullDeficitBytes:$postPullDeficit,finalRequiredBytes:$finalRequired,finalDeficitBytes:$finalDeficit},
      productionImmutability:{productionDatabaseConnections:0,
        productionMigrationLedgerSource:"accepted_preflight_attestation",productionMutationAuthorized:false},
      diagnostics:{rawCommandCaptured:false,rawSqlCaptured:false,rawStderrCaptured:false,
        environmentValuesCaptured:false,credentialsCaptured:false,messageDataCaptured:false,providerPayloadCaptured:false},
      safety:{productionDDL:false,productionDML:false,productionMigration:false,restart:false,deploy:false,
        browserLaunched:false,maxContacted:false,providerAction:false,productionNetworkAttached:false,
        productionVolumeMounted:false,profileMounted:false},
      recommendedNextAction:"CODEX_REVIEW_ISOLATED_FAILURE_REPORT"}' || return 74
  pm_run_bounded report_handoff 60 METADATA_TIMEOUT METADATA_FAILED chgrp codexbot "$temporary" || return 74
  pm_run_bounded report_handoff 60 METADATA_TIMEOUT METADATA_FAILED chmod 0640 "$temporary" || return 74
  pm_capture_bounded permissions report_handoff 60 METADATA_TIMEOUT METADATA_FAILED stat -Lc '%U:%G:%a' "$temporary" || return 74
  [[ -f $temporary && ! -L $temporary && $permissions == root:codexbot:640 ]]
  pm_capture_bounded identity report_handoff 60 METADATA_TIMEOUT METADATA_FAILED stat -Lc '%d:%i' "$temporary" || return 74
  pm_run_bounded report_handoff 60 METADATA_TIMEOUT METADATA_FAILED \
    mv --no-clobber --no-target-directory -- "$temporary" "$PM_FAILURE_PATH" || return 74
  pm_capture_bounded final_identity report_handoff 60 METADATA_TIMEOUT METADATA_FAILED stat -Lc '%d:%i' "$PM_FAILURE_PATH" || return 74
  [[ $identity == "$final_identity" ]]
  sha_of report_sha "$PM_FAILURE_PATH" || return 74
  printf 'ISOLATED_PROBE_FAILED\nPHASE=%s\nSAFE_COMMAND_CLASS=%s\nCLASSIFICATION=%s\nEXIT_CODE=%s\nFAILURE_REPORT_PATH=%s\nFAILURE_REPORT_SHA256=%s\nREPORT_OWNER=root\nREPORT_GROUP=codexbot\nREPORT_MODE=0640\n' \
    "$safe_phase" "$safe_class" "$safe_error" "$original_exit" "$PM_FAILURE_PATH" "$report_sha"
  return 0
}

personal_max_stage8b1i_write_emergency_json() {
  local __pm_path=${1:?path required} __pm_exit=${2:-1} __pm_phase=${3:-bootstrap_complete}
  local __pm_classification=${4:-UNEXPECTED_COMMAND_FAILURE} __pm_script_sha=${PM_SCRIPT_SHA256:-}
  [[ $__pm_exit =~ ^[1-9][0-9]*$ && $__pm_exit -le 255 ]] || __pm_exit=1
  personal_max_stage8b1i_safe_phase "$__pm_phase" || __pm_phase=bootstrap_complete
  personal_max_stage8b1i_safe_error "$__pm_classification" || __pm_classification=UNEXPECTED_COMMAND_FAILURE
  [[ $__pm_script_sha =~ ^[0-9a-f]{64}$ ]] || __pm_script_sha=0000000000000000000000000000000000000000000000000000000000000000
  (set -o noclobber; : >"$__pm_path") 2>/dev/null || return 74
  printf '{"schemaVersion":1,"mode":"ISOLATED_RELEASE_PROOF_EMERGENCY_FAILURE","script":{"sha256":"%s","checksumBound":true},"phase":"%s","classification":"%s","exitCode":%s,"diagnostics":{"rawCommandCaptured":false,"rawSqlCaptured":false,"rawStderrCaptured":false,"environmentValuesCaptured":false,"credentialsCaptured":false,"messageDataCaptured":false,"providerPayloadCaptured":false},"safety":{"productionDDL":false,"productionDML":false,"productionMigration":false,"restart":false,"deploy":false,"browserLaunched":false,"maxContacted":false,"providerAction":false}}\n' \
    "$__pm_script_sha" "$__pm_phase" "$__pm_classification" "$__pm_exit" >"$__pm_path" || return 74
}

personal_max_stage8b1i_emergency_diagnostics() {
  local __pm_original_exit=${1:-1} __pm_phase=${PROBE_PHASE:-bootstrap_complete}
  local __pm_classification=${PROBE_ERROR_CLASSIFICATION:-UNEXPECTED_COMMAND_FAILURE}
  local __pm_target=${PM_FAILURE_PATH:-} __pm_temporary
  [[ $__pm_original_exit =~ ^[1-9][0-9]*$ && $__pm_original_exit -le 255 ]] || __pm_original_exit=1
  personal_max_stage8b1i_safe_phase "$__pm_phase" || __pm_phase=bootstrap_complete
  personal_max_stage8b1i_safe_error "$__pm_classification" || __pm_classification=UNEXPECTED_COMMAND_FAILURE
  if [[ ! $__pm_target =~ ^/var/tmp/personal-max-stage8b1i-isolated-release-proof\.failure\.[0-9a-f]{64}\.json$ || -e $__pm_target || -L $__pm_target ]]; then
    printf 'ISOLATED_PROBE_FAILED\nPHASE=%s\nCLASSIFICATION=%s\nEXIT_CODE=%s\nFAILURE_REPORT_UNAVAILABLE\n' \
      "$__pm_phase" "$__pm_classification" "$__pm_original_exit" >&2
    return "$__pm_original_exit"
  fi
  __pm_temporary="${__pm_target}.emergency.$$.${RANDOM}.tmp"
  if ! personal_max_stage8b1i_write_emergency_json "$__pm_temporary" "$__pm_original_exit" "$__pm_phase" "$__pm_classification" || \
    ! timeout 10 chmod 0600 "$__pm_temporary" 2>/dev/null || \
    ! timeout 10 chgrp codexbot "$__pm_temporary" 2>/dev/null || \
    ! timeout 10 chmod 0640 "$__pm_temporary" 2>/dev/null || \
    ! timeout 10 mv --no-clobber --no-target-directory -- "$__pm_temporary" "$__pm_target" 2>/dev/null; then
    timeout 10 rm -f -- "$__pm_temporary" >/dev/null 2>&1 || true
    printf 'ISOLATED_PROBE_FAILED\nPHASE=%s\nCLASSIFICATION=%s\nEXIT_CODE=%s\nFAILURE_REPORT_UNAVAILABLE\n' \
      "$__pm_phase" "$__pm_classification" "$__pm_original_exit" >&2
    return "$__pm_original_exit"
  fi
  printf 'ISOLATED_PROBE_FAILED\nPHASE=%s\nCLASSIFICATION=%s\nEXIT_CODE=%s\nFAILURE_REPORT_PATH=%s\nEMERGENCY_DIAGNOSTICS=YES\n' \
    "$__pm_phase" "$__pm_classification" "$__pm_original_exit" "$__pm_target"
  return "$__pm_original_exit"
}
