#!/usr/bin/env bash
personal_max_migration_failure() {
  local exit_code=${1:-1} source_line=${2:-0} phase=${3:-unknown} classification=${4:-UNEXPECTED_FAILURE}
  local migration_started=${5:-false} backup_created=${6:-false} backup_directory=${7:-} script_sha=${8:-unknown} report=${9:-} applied_json=${10:-[]} tmp=''
  local backup_status=${11:-NOT_CREATED} dump_sha=${12:-} dump_bytes=${13:-0} object_count=${14:-0} config_sha=${15:-}
  local migration_runner=${16:-unknown} migration_runner_cleanup=${17:-UNKNOWN} diff_runner=${18:-unknown} diff_runner_cleanup=${19:-UNKNOWN}
  local runner_cleanup_complete=${20:-false}
  [[ $exit_code =~ ^[1-9][0-9]*$ ]] || exit_code=1
  [[ $phase =~ ^[a-z0-9_]+$ ]] || phase=unknown
  [[ $classification =~ ^[A-Z0-9_]+$ ]] || classification=UNEXPECTED_FAILURE
  [[ $script_sha =~ ^[0-9a-f]{64}$ ]] || script_sha=unknown
  [[ $backup_status =~ ^(NOT_CREATED|CREATED_UNVALIDATED|VALIDATED)$ ]] || backup_status=UNKNOWN
  [[ $dump_sha =~ ^[0-9a-f]{64}$ ]] || dump_sha=''
  [[ $config_sha =~ ^[0-9a-f]{64}$ ]] || config_sha=''
  [[ $dump_bytes =~ ^[0-9]+$ ]] || dump_bytes=0
  [[ $object_count =~ ^[0-9]+$ ]] || object_count=0
  [[ $migration_runner =~ ^[a-z0-9-]+$ ]] || migration_runner=unknown
  [[ $diff_runner =~ ^[a-z0-9-]+$ ]] || diff_runner=unknown
  [[ $migration_runner_cleanup =~ ^[A-Z_]+$ ]] || migration_runner_cleanup=UNKNOWN
  [[ $diff_runner_cleanup =~ ^[A-Z_]+$ ]] || diff_runner_cleanup=UNKNOWN
  [[ $runner_cleanup_complete == true || $runner_cleanup_complete == false ]] || runner_cleanup_complete=false
  jq -e 'type=="array" and all(.[]; type=="string")' <<<"$applied_json" >/dev/null 2>&1 || applied_json='[]'
  if [[ $report == /var/tmp/personal-max-stage8b2a-production-migration.failure.*.json && ! -e $report && ! -L $report ]]; then
    tmp=$(mktemp /var/tmp/personal-max-stage8b2a-production-migration.failure.tmp.XXXXXX 2>/dev/null || true)
    if [[ -n $tmp ]]; then
      jq -n --arg phase "$phase" --arg classification "$classification" --arg scriptSha "$script_sha" --arg backupDirectory "$backup_directory" \
        --arg backupStatus "$backup_status" --arg dumpSha "$dump_sha" --arg configSha "$config_sha" \
        --arg migrationRunner "$migration_runner" --arg migrationRunnerCleanup "$migration_runner_cleanup" \
        --arg diffRunner "$diff_runner" --arg diffRunnerCleanup "$diff_runner_cleanup" \
        --argjson exitCode "$exit_code" --argjson sourceLine "$source_line" --argjson migrationStarted "$migration_started" \
        --argjson backupCreated "$backup_created" --argjson dumpBytes "$dump_bytes" --argjson objectCount "$object_count" \
        --argjson appliedNames "$applied_json" --argjson runnerCleanupComplete "$runner_cleanup_complete" '
        {schemaVersion:1,mode:"PRODUCTION_MIGRATION_FAILURE",phase:$phase,classification:$classification,exitCode:$exitCode,sourceLine:$sourceLine,
         script:{sha256:$scriptSha},freshBackup:{created:$backupCreated,directory:$backupDirectory,status:$backupStatus,dumpSha256:$dumpSha,
          dumpBytes:$dumpBytes,objectCount:$objectCount,configArchiveSha256:$configSha,validated:($backupStatus=="VALIDATED"),preserve:true},
         migration:{started:$migrationStarted,appliedNamesObserved:$appliedNames,destructiveRollback:false,deployBlocked:true},
         runners:{migration:{name:$migrationRunner,cleanupState:$migrationRunnerCleanup},prismaDiff:{name:$diffRunner,cleanupState:$diffRunnerCleanup},
          cleanupComplete:$runnerCleanupComplete},
         diagnostics:{commandCaptured:false,sqlCaptured:false,stderrCaptured:false,environmentCaptured:false,credentialsCaptured:false}}' >"$tmp" 2>/dev/null &&
        chown root:codexbot "$tmp" 2>/dev/null && chmod 0640 "$tmp" 2>/dev/null && mv --no-clobber "$tmp" "$report" 2>/dev/null
      [[ -e $tmp ]] && rm -f -- "$tmp" >/dev/null 2>&1
    fi
  fi
  printf 'STAGE8B2A_FAILURE\nPHASE=%s\nCLASSIFICATION=%s\nEXIT_CODE=%s\nFAILURE_REPORT=%s\nDEPLOY_BLOCKED=YES\nDESTRUCTIVE_ROLLBACK=NO\n' \
    "$phase" "$classification" "$exit_code" "${report:-FAILURE_REPORT_UNAVAILABLE}" >&2
  return 0
}
