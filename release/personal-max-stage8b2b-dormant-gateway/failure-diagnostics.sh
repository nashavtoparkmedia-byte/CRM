#!/usr/bin/env bash
personal_max_dormant_failure() {
  local exit_code=${1:-1} line=${2:-0} phase=${3:-unknown} classification=${4:-UNEXPECTED_FAILURE} script_sha=${5:-unknown} report=${6:-}
  local observation=${7:-NOT_ATTEMPTED} container_state=${8:-UNKNOWN} network_state=${9:-UNKNOWN}
  local runtime_config_state=${10:-UNKNOWN} state_directory_state=${11:-UNKNOWN} tmp=''
  [[ $exit_code =~ ^[1-9][0-9]*$ ]] || exit_code=1; [[ $phase =~ ^[a-z0-9_]+$ ]] || phase=unknown; [[ $classification =~ ^[A-Z0-9_]+$ ]] || classification=UNEXPECTED_FAILURE
  [[ $observation =~ ^(NOT_ATTEMPTED|DOCKER_AVAILABLE|DOCKER_UNAVAILABLE)$ ]] || observation=NOT_ATTEMPTED
  [[ $container_state =~ ^(UNKNOWN|ABSENT|PRESENT_OWNED|PRESENT_MISMATCH)$ ]] || container_state=UNKNOWN
  [[ $network_state =~ ^(UNKNOWN|ABSENT|PRESENT_OWNED|PRESENT_MISMATCH)$ ]] || network_state=UNKNOWN
  [[ $runtime_config_state =~ ^(UNKNOWN|ABSENT|PRESENT_OWNED|PRESENT_MISMATCH)$ ]] || runtime_config_state=UNKNOWN
  [[ $state_directory_state =~ ^(UNKNOWN|ABSENT|PRESENT_OWNED|PRESENT_MISMATCH)$ ]] || state_directory_state=UNKNOWN
  if [[ $report == /var/tmp/personal-max-stage8b2b-dormant-gateway.failure.*.json && ! -e $report && ! -L $report ]]; then
    tmp=$(mktemp /var/tmp/personal-max-stage8b2b-dormant-gateway.failure.tmp.XXXXXX 2>/dev/null || true)
    if [[ -n $tmp ]]; then
      jq -n --arg phase "$phase" --arg classification "$classification" --arg scriptSha "$script_sha" --arg observation "$observation" \
        --arg containerState "$container_state" --arg networkState "$network_state" --arg runtimeConfigState "$runtime_config_state" \
        --arg stateDirectoryState "$state_directory_state" --argjson exitCode "$exit_code" --argjson sourceLine "$line" '
        {schemaVersion:1,mode:"DORMANT_GATEWAY_ROLLOUT_FAILURE",phase:$phase,classification:$classification,exitCode:$exitCode,sourceLine:$sourceLine,
         scriptSha256:$scriptSha,resources:{observation:$observation,container:{name:"personal-max-dormant-gateway",state:$containerState},
          network:{name:"personal-max-stage8b2b-dormant",state:$networkState},
          runtimeConfig:{path:"/var/lib/personal-max-stage8b2b/dormant-gateway.compose.yml",state:$runtimeConfigState},
          stateDirectory:{path:"/var/lib/personal-max-stage8b2b",state:$stateDirectoryState},cleanupAutomatic:false},
         safety:{productionDatabaseChanged:false,scraperChanged:false,profileChanged:false,maxContacted:false,providerAction:false}}' >"$tmp" 2>/dev/null && chown root:codexbot "$tmp" 2>/dev/null && chmod 0640 "$tmp" 2>/dev/null && mv --no-clobber "$tmp" "$report" 2>/dev/null
      [[ -e $tmp ]] && rm -f -- "$tmp" >/dev/null 2>&1
    fi
  fi
  printf 'STAGE8B2B_FAILURE\nPHASE=%s\nCLASSIFICATION=%s\nROLLBACK_REQUIRES_SEPARATE_AUTHORIZATION=YES\n' "$phase" "$classification" >&2
}

personal_max_dormant_rollback_failure() {
  local exit_code=${1:-1} line=${2:-0} phase=${3:-unknown} classification=${4:-UNEXPECTED_FAILURE} script_sha=${5:-unknown} report=${6:-}
  local observation=${7:-NOT_ATTEMPTED} container_state=${8:-UNKNOWN} network_state=${9:-UNKNOWN}
  local runtime_config_state=${10:-UNKNOWN} state_directory_state=${11:-UNKNOWN} tmp=''
  [[ $exit_code =~ ^[1-9][0-9]*$ ]] || exit_code=1; [[ $phase =~ ^[a-z0-9_]+$ ]] || phase=unknown; [[ $classification =~ ^[A-Z0-9_]+$ ]] || classification=UNEXPECTED_FAILURE
  [[ $script_sha =~ ^[0-9a-f]{64}$ ]] || script_sha=unknown
  [[ $observation =~ ^(NOT_ATTEMPTED|DOCKER_AVAILABLE|DOCKER_UNAVAILABLE)$ ]] || observation=NOT_ATTEMPTED
  [[ $container_state =~ ^(UNKNOWN|ABSENT|PRESENT_OWNED|PRESENT_MISMATCH)$ ]] || container_state=UNKNOWN
  [[ $network_state =~ ^(UNKNOWN|ABSENT|PRESENT_OWNED|PRESENT_MISMATCH)$ ]] || network_state=UNKNOWN
  [[ $runtime_config_state =~ ^(UNKNOWN|ABSENT|PRESENT_OWNED|PRESENT_MISMATCH)$ ]] || runtime_config_state=UNKNOWN
  [[ $state_directory_state =~ ^(UNKNOWN|ABSENT|PRESENT_OWNED|PRESENT_MISMATCH)$ ]] || state_directory_state=UNKNOWN
  if [[ $report == /var/tmp/personal-max-stage8b2b-dormant-rollback.failure.*.json && ! -e $report && ! -L $report ]]; then
    tmp=$(mktemp /var/tmp/personal-max-stage8b2b-dormant-rollback.failure.tmp.XXXXXX 2>/dev/null || true)
    if [[ -n $tmp ]]; then
      jq -n --arg phase "$phase" --arg classification "$classification" --arg scriptSha "$script_sha" --arg observation "$observation" \
        --arg containerState "$container_state" --arg networkState "$network_state" --arg runtimeConfigState "$runtime_config_state" \
        --arg stateDirectoryState "$state_directory_state" --argjson exitCode "$exit_code" --argjson sourceLine "$line" '
        {schemaVersion:1,mode:"DORMANT_GATEWAY_ROLLBACK_FAILURE",phase:$phase,classification:$classification,exitCode:$exitCode,sourceLine:$sourceLine,
         scriptSha256:$scriptSha,resources:{observation:$observation,container:{name:"personal-max-dormant-gateway",state:$containerState},
          network:{name:"personal-max-stage8b2b-dormant",state:$networkState},
          runtimeConfig:{path:"/var/lib/personal-max-stage8b2b/dormant-gateway.compose.yml",state:$runtimeConfigState},
          stateDirectory:{path:"/var/lib/personal-max-stage8b2b",state:$stateDirectoryState},cleanupAutomatic:false},
         scope:{databaseMutationAttempted:false,scraperMutationAttempted:false,profileMutationAttempted:false,globalPruneAttempted:false,automaticRetry:false}}' >"$tmp" 2>/dev/null && chown root:codexbot "$tmp" 2>/dev/null && chmod 0640 "$tmp" 2>/dev/null && mv --no-clobber "$tmp" "$report" 2>/dev/null
      [[ -e $tmp ]] && rm -f -- "$tmp" >/dev/null 2>&1
    fi
  fi
  printf 'STAGE8B2B_ROLLBACK_FAILURE\nPHASE=%s\nCLASSIFICATION=%s\nORIGINAL_EXIT=%s\nAUTOMATIC_RETRY=NO\n' "$phase" "$classification" "$exit_code" >&2
}
