#!/usr/bin/env bash
personal_max_dormant_failure() {
  local exit_code=${1:-1} line=${2:-0} phase=${3:-unknown} classification=${4:-UNEXPECTED_FAILURE} script_sha=${5:-unknown} report=${6:-}
  local container_created=${7:-false} network_created=${8:-false} tmp=''
  [[ $exit_code =~ ^[1-9][0-9]*$ ]] || exit_code=1; [[ $phase =~ ^[a-z0-9_]+$ ]] || phase=unknown; [[ $classification =~ ^[A-Z0-9_]+$ ]] || classification=UNEXPECTED_FAILURE
  if [[ $report == /var/tmp/personal-max-stage8b2b-dormant-gateway.failure.*.json && ! -e $report && ! -L $report ]]; then
    tmp=$(mktemp /var/tmp/personal-max-stage8b2b-dormant-gateway.failure.tmp.XXXXXX 2>/dev/null || true)
    if [[ -n $tmp ]]; then
      jq -n --arg phase "$phase" --arg classification "$classification" --arg scriptSha "$script_sha" --argjson exitCode "$exit_code" --argjson sourceLine "$line" --argjson containerCreated "$container_created" --argjson networkCreated "$network_created" '
        {schemaVersion:1,mode:"DORMANT_GATEWAY_ROLLOUT_FAILURE",phase:$phase,classification:$classification,exitCode:$exitCode,sourceLine:$sourceLine,scriptSha256:$scriptSha,resources:{containerCreated:$containerCreated,networkCreated:$networkCreated,cleanupAutomatic:false},safety:{productionDatabaseChanged:false,scraperChanged:false,profileChanged:false,maxContacted:false,providerAction:false}}' >"$tmp" 2>/dev/null && chown root:codexbot "$tmp" 2>/dev/null && chmod 0640 "$tmp" 2>/dev/null && mv --no-clobber "$tmp" "$report" 2>/dev/null
      [[ -e $tmp ]] && rm -f -- "$tmp" >/dev/null 2>&1
    fi
  fi
  printf 'STAGE8B2B_FAILURE\nPHASE=%s\nCLASSIFICATION=%s\nROLLBACK_REQUIRES_SEPARATE_AUTHORIZATION=YES\n' "$phase" "$classification" >&2
}
