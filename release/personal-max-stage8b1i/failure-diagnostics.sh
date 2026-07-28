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
  pm_error_classification_is_safe "${1:-}"
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
  cleanup_containers=${CLEANUP_CONTAINERS_REMAINING:-0}; pm_safe_uint "$cleanup_containers" || cleanup_containers=1
  cleanup_networks=${CLEANUP_NETWORKS_REMAINING:-0}; pm_safe_uint "$cleanup_networks" || cleanup_networks=1
  cleanup_volumes=${CLEANUP_VOLUMES_REMAINING:-0}; pm_safe_uint "$cleanup_volumes" || cleanup_volumes=1
  cleanup_temp=${CLEANUP_TEMP_FILES_REMAINING:-0}; pm_safe_uint "$cleanup_temp" || cleanup_temp=1

  if [[ -e $PM_FAILURE_PATH || -L $PM_FAILURE_PATH ]]; then
    printf 'ISOLATED_PROBE_FAILED\nPHASE=%s\nEXIT_CODE=%s\nFAILURE_REPORT_PATH_UNSAFE\n' "$safe_phase" "$original_exit" >&2
    return "$original_exit"
  fi
  pm_capture_bounded temporary filesystem_metadata 60 METADATA_TIMEOUT METADATA_FAILED \
    mktemp /var/tmp/personal-max-stage8b1i-isolated-release-proof.failure.tmp.XXXXXX || return "$original_exit"
  pm_run_bounded report_handoff 60 METADATA_TIMEOUT METADATA_FAILED chmod 0600 "$temporary" || return "$original_exit"
  pm_write_bounded "$temporary" report_render 60 METADATA_TIMEOUT METADATA_FAILED jq -n \
    --arg generatedAt "$generated" --arg scriptSha256 "$PM_SCRIPT_SHA256" \
    --arg phase "$safe_phase" --arg safeCommandClass "$safe_class" --arg classification "$safe_error" \
    --arg cleanupErrorClassification "$cleanup_error" \
    --argjson exitCode "$original_exit" --argjson sourceLine "$source_line" \
    --argjson cleanupCompleted "$cleanup_ok" \
    --argjson cleanupContainers "$cleanup_containers" --argjson cleanupNetworks "$cleanup_networks" \
    --argjson cleanupVolumes "$cleanup_volumes" --argjson cleanupTemp "$cleanup_temp" \
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
      recommendedNextAction:"CODEX_REVIEW_ISOLATED_FAILURE_REPORT"}' || return "$original_exit"
  pm_run_bounded report_handoff 60 METADATA_TIMEOUT METADATA_FAILED chgrp codexbot "$temporary" || return "$original_exit"
  pm_run_bounded report_handoff 60 METADATA_TIMEOUT METADATA_FAILED chmod 0640 "$temporary" || return "$original_exit"
  pm_capture_bounded permissions report_handoff 60 METADATA_TIMEOUT METADATA_FAILED stat -Lc '%U:%G:%a' "$temporary" || return "$original_exit"
  [[ -f $temporary && ! -L $temporary && $permissions == root:codexbot:640 ]]
  pm_capture_bounded identity report_handoff 60 METADATA_TIMEOUT METADATA_FAILED stat -Lc '%d:%i' "$temporary" || return "$original_exit"
  pm_run_bounded report_handoff 60 METADATA_TIMEOUT METADATA_FAILED \
    mv --no-clobber --no-target-directory -- "$temporary" "$PM_FAILURE_PATH" || return "$original_exit"
  pm_capture_bounded final_identity report_handoff 60 METADATA_TIMEOUT METADATA_FAILED stat -Lc '%d:%i' "$PM_FAILURE_PATH" || return "$original_exit"
  [[ $identity == "$final_identity" ]]
  sha_of report_sha "$PM_FAILURE_PATH" || return "$original_exit"
  printf 'ISOLATED_PROBE_FAILED\nPHASE=%s\nSAFE_COMMAND_CLASS=%s\nCLASSIFICATION=%s\nEXIT_CODE=%s\nFAILURE_REPORT_PATH=%s\nFAILURE_REPORT_SHA256=%s\nREPORT_OWNER=root\nREPORT_GROUP=codexbot\nREPORT_MODE=0640\n' \
    "$safe_phase" "$safe_class" "$safe_error" "$original_exit" "$PM_FAILURE_PATH" "$report_sha"
  return "$original_exit"
}
