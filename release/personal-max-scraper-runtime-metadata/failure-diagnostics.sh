#!/usr/bin/env bash

diagnostic_emit() {
  local code=${1:-UNCLASSIFIED_FAILURE}
  local phase=${2:-unknown}
  local exit_code=${3:-1}
  [[ $code =~ ^[A-Z0-9_]+$ ]] || code=UNCLASSIFIED_FAILURE
  [[ $phase =~ ^[a-z0-9_-]+$ ]] || phase=unknown
  [[ $exit_code =~ ^[0-9]+$ ]] || exit_code=1
  jq -cn --arg code "$code" --arg phase "$phase" --argjson exitCode "$exit_code" \
    '{schemaVersion:1,status:"FAILED_CLOSED",code:$code,phase:$phase,exitCode:$exitCode,secretsPrinted:false,productionMutation:false}' >&2
}

classify_identity_count() {
  local all_count=$1
  local running_count=$2
  if [[ $all_count -eq 0 ]]; then
    printf '%s\n' SCRAPER_IDENTITY_NOT_FOUND
  elif [[ $all_count -ne 1 ]]; then
    printf '%s\n' SCRAPER_IDENTITY_AMBIGUOUS
  elif [[ $running_count -ne 1 ]]; then
    printf '%s\n' SCRAPER_NOT_RUNNING
  else
    printf '%s\n' SCRAPER_IDENTITY_EXACT
  fi
}
