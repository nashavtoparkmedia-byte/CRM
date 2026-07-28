#!/usr/bin/env bash
# shellcheck disable=SC1091,SC2016
set -Eeuo pipefail
umask 077

readonly PACKAGE_ROOT='/home/codexbot/codex-work/crm-personal-max-stage8b2-consolidated-20260728T194422Z/release/personal-max-stage8b2a-production-migration'
readonly FAILURE_DIAGNOSTICS="$PACKAGE_ROOT/failure-diagnostics.sh"
readonly FAILURE_DIAGNOSTICS_SHA='c720b22f0cf6644c5202f3daa4ccc9ae7de3d0e2ab6e8a3ebfb4bffa0d9be322'
readonly REPORT_SUCCESS_FILTER="$PACKAGE_ROOT/report-success.jq"
readonly REPORT_SUCCESS_FILTER_SHA='74ba29e22d8a52dce7b00d53ecb4b8a692489d25928cca974f56898433d0c8b5'
readonly PRISMA_DRIFT_VALIDATOR="$PACKAGE_ROOT/validate-accepted-prisma-drift.awk"
readonly PRISMA_DRIFT_VALIDATOR_SHA='eeeee2d4cb3e46d5b89e5f8d0601c6a7d8b160a3ef8d95fc0a722447967ca4f4'
readonly DATABASE_URL_HELPER="$PACKAGE_ROOT/postgres-database-url.py"
readonly DATABASE_URL_HELPER_SHA='b0b447ac536a8d31936c6e9476de6f7cda74e791c0b6678869ac1467a17090b6'
readonly ISOLATED_REPORT='/var/tmp/personal-max-stage8b1i-isolated-release-proof.json'
readonly ACCEPTED_BACKUP_REPORT='/var/tmp/personal-max-stage8b1s-production-backup.json'
readonly ACCEPTED_BACKUP_REPORT_SHA='f9b29d5fbe69b9a87d402bab3a19a1079797640549078b17a6ba8e7280415566'
readonly PREFLIGHT_REPORT='/var/tmp/personal-max-stage8b1r-production-readonly-preflight.json'
readonly PREFLIGHT_REPORT_SHA='d6a6e4764c90a6f64af9c11b2b0c4eeb08b82c377b58990f939bd559688ac63b'
readonly GATEWAY_IMAGE='ghcr.io/nashavtoparkmedia-byte/crm-max-personal-gateway@sha256:dd718fd8e9e2ec52a0ee1c19b576d75a1035f9e251980351ebc04071dfe5d0de'
readonly POSTGRES_IMAGE_ID='sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229'
readonly PRODUCTION_HEAD='e6a0a833fbb756216b058bfe326f9f9c77c4cc6d'
readonly PRODUCTION_STATUS_V2_SHA='2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b'
readonly SUCCESS_REPORT='/var/tmp/personal-max-stage8b2a-production-migration.json'
readonly FAILURE_REPORT_PREFIX='/var/tmp/personal-max-stage8b2a-production-migration.failure'
readonly BACKUP_PARENT='/var/backups'
readonly BACKUP_PREFIX='/var/backups/personal-max-stage8b2a-pre-migration-'
readonly MINIMUM_FREE_BYTES=12500000000
readonly ROLLBACK_RESERVE_BYTES=5368709120
readonly COMMAND_TIMEOUT=60
readonly MIGRATION_TIMEOUT=900
readonly PRISMA_DIFF_TIMEOUT=600
readonly MIGRATION_LOCK_TIMEOUT_MS=5000
readonly MIGRATION_STATEMENT_TIMEOUT_MS=840000
readonly PRISMA_DIFF_STATEMENT_TIMEOUT_MS=540000
readonly PROJECT_LABEL='com.docker.compose.project=crm'
readonly POSTGRES_LABEL='com.docker.compose.service=postgres'
readonly NETWORK_PROJECT_LABEL='com.docker.compose.project=crm'
readonly NETWORK_INTERNAL_LABEL='com.docker.compose.network=internal'
readonly RUNNER_STAGE_LABEL='personal-max.stage=8b2a'
readonly RUNNER_SCRIPT_LABEL_KEY='personal-max.script-sha'
readonly RUNNER_TOKEN_LABEL_KEY='personal-max.run-token'
readonly MIGRATION_RUNNER='personal-max-stage8b2a-migration-runner'
readonly MIGRATION_RUNNER_ROLE='migration-runner'
readonly PRISMA_DIFF_RUNNER='personal-max-stage8b2a-prisma-diff-runner'
readonly PRISMA_DIFF_RUNNER_ROLE='prisma-diff-runner'
readonly ACCEPTED_LEDGER_ONLY_MIGRATION='20260717000000_add_driver_telegram_submitted_phone'
readonly ACCEPTED_PRISMA_DIFF_STATUS='ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS'
readonly ACCEPTED_ISOLATED_PROBE_SCRIPT_SHA='dbbdaf7a33e3d7bf0e81a6471e5f2461d7042b7b3efdc993f3100d6ff927b053'
readonly -a EXPECTED_MIGRATIONS=(
  20260726162043_add_max_raw_transport_journal
  20260726190658_add_max_route_registry
  20260726205437_add_max_inbound_normalization
  20260726215715_add_max_per_chat_outbound_actor
  20260726225737_add_max_dispatch_ledger
  20260727053744_add_max_provider_confirmation_matcher
  20260727141925_add_max_shadow_semantic_comparison
  20260727154647_add_max_capture_ingress
)

MIGRATION_PHASE='bootstrap'
MIGRATION_CLASSIFICATION='UNEXPECTED_FAILURE'
MIGRATION_STARTED=false
FRESH_BACKUP_CREATED=false
FRESH_BACKUP_STATUS='NOT_CREATED'
FRESH_BACKUP_DUMP_SHA=''
FRESH_BACKUP_DUMP_BYTES=0
FRESH_BACKUP_OBJECT_COUNT=0
FRESH_BACKUP_CONFIG_SHA=''
BACKUP_DIRECTORY=''
TMP=''
POSTGRES_ID=''
NETWORK_NAME=''
pg_ids=''
network_json=''
network_inspect_json=''
POSTGRES_INSPECT_JSON=''
MIGRATION_ENV=''
PROJECT_HASH_BEFORE=''
RESTART_HASH_BEFORE=''
SCRIPT_SHA=''
FAILURE_REPORT=''
APPLIED_AFTER_FAILURE_JSON='[]'
MIGRATION_RUNNER_CLEANUP_STATE='NOT_STARTED'
PRISMA_DIFF_RUNNER_CLEANUP_STATE='NOT_STARTED'
RUNNER_CLEANUP_COMPLETE=true
PRISMA_DIFF_STATUS='NOT_RUN'
RUNNER_TOKEN=''

bootstrap_fail() { printf '%s\n' "$1" >&2; exit "$2"; }
verify_subordinate() {
  local artifact_path=$1 expected_path=$2 expected_sha=$3 canonical_path actual_sha
  canonical_path=$(realpath -- "$artifact_path") || bootstrap_fail SUBORDINATE_UNREADABLE 75
  [[ $canonical_path == "$expected_path" && -f $artifact_path && ! -L $artifact_path ]] || bootstrap_fail SUBORDINATE_PATH_INVALID 75
  actual_sha=$(sha256sum -- "$artifact_path" | awk '{print $1}')
  [[ $actual_sha == "$expected_sha" ]] || bootstrap_fail SUBORDINATE_CHECKSUM_MISMATCH 79
}
(( EUID == 0 )) || bootstrap_fail ROOT_REQUIRED 77
[[ ${1:-} =~ ^[0-9a-f]{64}$ ]] || bootstrap_fail CHECKSUM_BINDING_REQUIRED 78
[[ ${PERSONAL_MAX_ISOLATED_REPORT_SHA256:-} =~ ^[0-9a-f]{64}$ ]] || bootstrap_fail ISOLATED_REPORT_SHA_BINDING_REQUIRED 78
for binary in awk chgrp chmod chown cmp date df docker getent git grep jq mktemp mv python3 readlink realpath rm runuser sha256sum sort stat tar timeout wc; do
  command -v "$binary" >/dev/null || bootstrap_fail "MANDATORY_BINARY_MISSING:$binary" 76
done
SCRIPT_PATH=$(realpath -- "${BASH_SOURCE[0]}") || bootstrap_fail SCRIPT_UNREADABLE 75
[[ $SCRIPT_PATH == "$PACKAGE_ROOT/production-migration.sh" && -f $SCRIPT_PATH && ! -L $SCRIPT_PATH ]] || bootstrap_fail SCRIPT_PATH_INVALID 75
SCRIPT_SHA=$(sha256sum -- "$SCRIPT_PATH" | awk '{print $1}')
[[ $SCRIPT_SHA == "$1" ]] || bootstrap_fail CHECKSUM_MISMATCH 79
verify_subordinate "$FAILURE_DIAGNOSTICS" "$PACKAGE_ROOT/failure-diagnostics.sh" "$FAILURE_DIAGNOSTICS_SHA"
verify_subordinate "$REPORT_SUCCESS_FILTER" "$PACKAGE_ROOT/report-success.jq" "$REPORT_SUCCESS_FILTER_SHA"
verify_subordinate "$PRISMA_DRIFT_VALIDATOR" "$PACKAGE_ROOT/validate-accepted-prisma-drift.awk" "$PRISMA_DRIFT_VALIDATOR_SHA"
verify_subordinate "$DATABASE_URL_HELPER" "$PACKAGE_ROOT/postgres-database-url.py" "$DATABASE_URL_HELPER_SHA"
FAILURE_REPORT="$FAILURE_REPORT_PREFIX.$SCRIPT_SHA.json"
[[ ! -e $SUCCESS_REPORT && ! -L $SUCCESS_REPORT && ! -e $FAILURE_REPORT && ! -L $FAILURE_REPORT ]] || bootstrap_fail REPORT_PATH_EXISTS 80
[[ -d $BACKUP_PARENT && ! -L $BACKUP_PARENT ]] || bootstrap_fail BACKUP_PARENT_UNSAFE 80
timeout 5 getent group codexbot >/dev/null || bootstrap_fail HANDOFF_GROUP_MISSING 84
verify_subordinate "$FAILURE_DIAGNOSTICS" "$PACKAGE_ROOT/failure-diagnostics.sh" "$FAILURE_DIAGNOSTICS_SHA"
source "$FAILURE_DIAGNOSTICS"

cleanup() {
  local original=${1:-0}
  trap - ERR EXIT
  set +e
  if [[ -n ${TMP:-} && $TMP =~ ^/var/tmp/personal-max-stage8b2a\.[A-Za-z0-9]{8}$ &&
        -d ${TMP:-} && ! -L ${TMP:-} &&
        $(stat -Lc '%u:%g:%a' "$TMP" 2>/dev/null) == 0:0:700 ]]; then
    timeout --signal=TERM --kill-after=5s 30s rm -rf --one-file-system -- "$TMP" >/dev/null 2>&1
  fi
  return "$original"
}
runner_cleanup() {
  local runner_name=$1 runner_role=$2 state_variable=$3 label_value=''
  if ! run 15 docker container inspect "$runner_name" >/dev/null 2>&1; then
    printf -v "$state_variable" '%s' 'ABSENT'
    return 0
  fi
  if ! capture label_value 15 docker inspect --format '{{index .Config.Labels "personal-max.stage"}}|{{index .Config.Labels "personal-max.role"}}|{{index .Config.Labels "personal-max.script-sha"}}|{{index .Config.Labels "personal-max.run-token"}}' "$runner_name"; then
    printf -v "$state_variable" '%s' 'INSPECTION_FAILED'
    return 1
  fi
  if [[ -z $RUNNER_TOKEN || $label_value != "8b2a|$runner_role|$SCRIPT_SHA|$RUNNER_TOKEN" ]]; then
    printf -v "$state_variable" '%s' 'REFUSED_LABEL_MISMATCH'
    return 1
  fi
  if ! run 30 docker rm -f "$runner_name" >/dev/null 2>&1; then
    printf -v "$state_variable" '%s' 'REMOVAL_FAILED'
    return 1
  fi
  if run 15 docker container inspect "$runner_name" >/dev/null 2>&1; then
    printf -v "$state_variable" '%s' 'STILL_PRESENT'
    return 1
  fi
  printf -v "$state_variable" '%s' 'REMOVED'
}
cleanup_runners() {
  local cleanup_failed=0
  case $MIGRATION_RUNNER_CLEANUP_STATE in
    NOT_STARTED|ABSENT|ABSENT_AFTER_SUCCESS|REMOVED) ;;
    *) runner_cleanup "$MIGRATION_RUNNER" "$MIGRATION_RUNNER_ROLE" MIGRATION_RUNNER_CLEANUP_STATE || cleanup_failed=1 ;;
  esac
  case $PRISMA_DIFF_RUNNER_CLEANUP_STATE in
    NOT_STARTED|ABSENT|ABSENT_AFTER_SUCCESS|REMOVED) ;;
    *) runner_cleanup "$PRISMA_DIFF_RUNNER" "$PRISMA_DIFF_RUNNER_ROLE" PRISMA_DIFF_RUNNER_CLEANUP_STATE || cleanup_failed=1 ;;
  esac
  if (( cleanup_failed == 0 )); then RUNNER_CLEANUP_COMPLETE=true; else RUNNER_CLEANUP_COMPLETE=false; fi
}
on_error() {
  local original=${1:-1} line=${2:-0}
  trap - ERR; set +e
  cleanup_runners
  if [[ ${MIGRATION_STARTED:-false} == true && -n ${POSTGRES_ID:-} ]]; then
    failure_names=$(psql_read 'SELECT migration_name FROM "_prisma_migrations" WHERE migration_name LIKE '\''20260726%'\'' OR migration_name LIKE '\''20260727%'\'' ORDER BY migration_name' 2>/dev/null || true)
    if [[ -n $failure_names ]]; then
      APPLIED_AFTER_FAILURE_JSON=$(printf '%s\n' "$failure_names" | jq -Rsc 'split("\n")[:-1]' 2>/dev/null || printf '[]')
    fi
  fi
  personal_max_migration_failure "$original" "$line" "$MIGRATION_PHASE" "$MIGRATION_CLASSIFICATION" \
    "$MIGRATION_STARTED" "$FRESH_BACKUP_CREATED" "$BACKUP_DIRECTORY" "$SCRIPT_SHA" "$FAILURE_REPORT" "$APPLIED_AFTER_FAILURE_JSON" \
    "$FRESH_BACKUP_STATUS" "$FRESH_BACKUP_DUMP_SHA" "$FRESH_BACKUP_DUMP_BYTES" "$FRESH_BACKUP_OBJECT_COUNT" "$FRESH_BACKUP_CONFIG_SHA" \
    "$MIGRATION_RUNNER" "$MIGRATION_RUNNER_CLEANUP_STATE" "$PRISMA_DIFF_RUNNER" "$PRISMA_DIFF_RUNNER_CLEANUP_STATE" "$RUNNER_CLEANUP_COMPLETE"
  cleanup "$original"; exit "$original"
}
trap 'on_error "$?" "$LINENO"' ERR
trap 'cleanup "$?"' EXIT

phase() { MIGRATION_PHASE=$1; MIGRATION_CLASSIFICATION=$2; printf 'STAGE8B2A_PHASE=%s\n' "$MIGRATION_PHASE"; }
run() { local seconds=$1; shift; timeout --signal=TERM --kill-after=10 "$seconds" "$@"; }
capture() { local -n __out=$1; local seconds=$2; shift 2; __out=$(run "$seconds" "$@"); }
sha_file() { sha256sum -- "$1" | awk '{print $1}'; }
hash_sorted() { LC_ALL=C sort | sha256sum | awk '{print $1}'; }
capture_to_new_root_file() {
  local destination=$1 seconds=$2
  shift 2
  [[ $destination == "$TMP/"* && ! -e $destination && ! -L $destination ]]
  (umask 077; set -o noclobber; run "$seconds" "$@" >"$destination")
  chmod 0600 "$destination"
  chown root:root "$destination"
  [[ -f $destination && ! -L $destination && $(stat -Lc '%u:%g:%a' "$destination") == 0:0:600 ]]
}
assert_postgres_identity() {
  local candidates='' state='' image='' id=''
  local -a candidate_set=()
  if ! capture candidates "$COMMAND_TIMEOUT" docker ps -aq --no-trunc \
      --filter "label=$PROJECT_LABEL" --filter "label=$POSTGRES_LABEL"; then
    MIGRATION_CLASSIFICATION='POSTGRES_CONTAINER_IDENTITY_CHANGED'
    return 1
  fi
  mapfile -t candidate_set < <(printf '%s\n' "$candidates" | awk 'NF' | sort -u)
  if (( ${#candidate_set[@]} != 1 )); then
    MIGRATION_CLASSIFICATION='POSTGRES_CONTAINER_IDENTITY_CHANGED'
    return 1
  fi
  id=${candidate_set[0]}
  if [[ $id != "$POSTGRES_ID" ]]; then
    MIGRATION_CLASSIFICATION='POSTGRES_CONTAINER_IDENTITY_CHANGED'
    return 1
  fi
  if ! capture state "$COMMAND_TIMEOUT" docker inspect --format '{{.State.Status}}' "$id"; then
    MIGRATION_CLASSIFICATION='POSTGRES_CONTAINER_IDENTITY_CHANGED'
    return 1
  fi
  if ! capture image "$COMMAND_TIMEOUT" docker inspect --format '{{.Image}}' "$id"; then
    MIGRATION_CLASSIFICATION='POSTGRES_CONTAINER_IDENTITY_CHANGED'
    return 1
  fi
  if [[ $state != running || $image != "$POSTGRES_IMAGE_ID" ]]; then
    MIGRATION_CLASSIFICATION='POSTGRES_CONTAINER_IDENTITY_CHANGED'
    return 1
  fi
}
psql_read() {
  run "$COMMAND_TIMEOUT" docker exec "$POSTGRES_ID" sh -ceu \
    'export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000"; exec psql --no-psqlrc -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh "$1"
}
project_hash() {
  run "$COMMAND_TIMEOUT" docker ps -aq --no-trunc --filter "label=$PROJECT_LABEL" | awk 'NF' | sort -u | while IFS= read -r id; do
    run "$COMMAND_TIMEOUT" docker inspect --format '{{.Id}}|{{.State.Status}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.service"}}' "$id"
  done | hash_sorted
}
restart_hash() {
  run "$COMMAND_TIMEOUT" docker ps -aq --no-trunc --filter "label=$PROJECT_LABEL" | awk 'NF' | sort -u | while IFS= read -r id; do
    run "$COMMAND_TIMEOUT" docker inspect --format '{{.Id}}|{{.RestartCount}}' "$id"
  done | hash_sorted
}

phase package_validation PACKAGE_INVALID
(cd "$PACKAGE_ROOT" && sha256sum -c SHA256SUMS >/dev/null)

phase isolated_proof_binding ISOLATED_PROOF_INVALID
[[ -f $ISOLATED_REPORT && ! -L $ISOLATED_REPORT && $(stat -Lc '%U:%G:%a' "$ISOLATED_REPORT") == root:codexbot:640 ]]
[[ $(sha_file "$ISOLATED_REPORT") == "$PERSONAL_MAX_ISOLATED_REPORT_SHA256" ]]
run 5 runuser -u codexbot -- test -r "$ISOLATED_REPORT"
if run 5 runuser -u codexbot -- test -w "$ISOLATED_REPORT"; then false; fi
jq -e --arg expectedProbeScriptSha "$ACCEPTED_ISOLATED_PROBE_SCRIPT_SHA" \
  --argjson expected "$(printf '%s\n' "${EXPECTED_MIGRATIONS[@]}" | jq -Rsc 'split("\n")[:-1]')" '
  .schemaVersion==1 and .mode=="ISOLATED_RELEASE_PROOF" and
  .script=={sha256:$expectedProbeScriptSha,checksumBound:true} and
  .restore.FULL_RESTORE_PROOF=="PASS" and .migration.DISPOSABLE_MIGRATION_PROOF=="PASS" and
  (.migration.appliedNames|sort)==($expected|sort) and .migration.beforeFinished==46 and
  .migration.afterFinished==54 and .migration.failed==0 and .migration.prismaDiffEmpty==false and
  .migration.prismaDiffStatus=="ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS" and
  .migration.acceptedLedgerOnlyMigrations==["20260717000000_add_driver_telegram_submitted_phone"] and
  .e2e.captureLoss==0 and .e2e.accidentalDuplicateRawRows==0 and .e2e.wrongAccount==0 and
  .e2e.criticalSemanticRegressions==0 and .cleanup.containersRemaining==0 and
  .cleanup.networksRemaining==0 and .cleanup.volumesRemaining==0 and .cleanup.tempFilesRemaining==0 and
  .productionImmutability.unchanged==true and .productionImmutability.productionDatabaseConnections==0 and
  .safety.productionDDL==false and .safety.productionDML==false and .safety.productionMigration==false and
  .safety.restart==false and .safety.deploy==false and .safety.browserLaunched==false and
  .safety.maxContacted==false and .safety.providerAction==false' "$ISOLATED_REPORT" >/dev/null

phase accepted_evidence_binding ACCEPTED_EVIDENCE_INVALID
[[ $(sha_file "$ACCEPTED_BACKUP_REPORT") == "$ACCEPTED_BACKUP_REPORT_SHA" ]]
[[ $(sha_file "$PREFLIGHT_REPORT") == "$PREFLIGHT_REPORT_SHA" ]]
jq -e '.mode=="PRODUCTION_BACKUP_METADATA" and .dump.structuralValidation=="PASS" and .migrationLedger.total==46 and .migrationLedger.finished==46 and .migrationLedger.failed==0' "$ACCEPTED_BACKUP_REPORT" >/dev/null

phase production_git_gate PRODUCTION_DRIFT
[[ $(git -C /opt/crm rev-parse HEAD) == "$PRODUCTION_HEAD" ]]
status_sha=$(git -C /opt/crm status --porcelain=v2 --untracked-files=all | sha256sum | awk '{print $1}')
[[ $status_sha == "$PRODUCTION_STATUS_V2_SHA" ]]

phase storage_gate STORAGE_REFUSAL
free_before=$(df -B1 --output=avail "$BACKUP_PARENT" | awk 'NR==2{print $1}')
[[ $free_before =~ ^[0-9]+$ ]] && (( free_before >= MINIMUM_FREE_BYTES ))

phase credential_workspace CREDENTIAL_WORKSPACE_FAILED
TMP=$(mktemp -d /var/tmp/personal-max-stage8b2a.XXXXXXXX)
chmod 0700 "$TMP"
chown root:root "$TMP"
[[ -d $TMP && ! -L $TMP && $(stat -Lc '%u:%g:%a' "$TMP") == 0:0:700 ]]
RUNNER_TOKEN=${TMP##*.}
[[ $RUNNER_TOKEN =~ ^[A-Za-z0-9]{8}$ ]]
POSTGRES_INSPECT_JSON="$TMP/postgres-inspect.json"
MIGRATION_ENV="$TMP/migration.env"

phase runtime_discovery POSTGRES_CONTAINER_DISCOVERY_FAILED
capture pg_ids "$COMMAND_TIMEOUT" docker ps -aq --no-trunc --filter "label=$PROJECT_LABEL" --filter "label=$POSTGRES_LABEL"
mapfile -t pg_set < <(printf '%s\n' "$pg_ids" | awk 'NF' | sort -u)
if (( ${#pg_set[@]} == 0 )); then MIGRATION_CLASSIFICATION='POSTGRES_CONTAINER_MISSING'; false; fi
if (( ${#pg_set[@]} != 1 )); then MIGRATION_CLASSIFICATION='POSTGRES_CONTAINER_MULTIPLE'; false; fi
POSTGRES_ID=${pg_set[0]}
postgres_state=$(run "$COMMAND_TIMEOUT" docker inspect --format '{{.State.Status}}' "$POSTGRES_ID")
if [[ $postgres_state != running ]]; then MIGRATION_CLASSIFICATION='POSTGRES_CONTAINER_NOT_RUNNING'; false; fi
postgres_image=$(run "$COMMAND_TIMEOUT" docker inspect --format '{{.Image}}' "$POSTGRES_ID")
if [[ $postgres_image != "$POSTGRES_IMAGE_ID" ]]; then MIGRATION_CLASSIFICATION='POSTGRES_CONTAINER_IMAGE_MISMATCH'; false; fi
assert_postgres_identity

phase postgres_inspect POSTGRES_INSPECT_FAILED
capture_to_new_root_file "$POSTGRES_INSPECT_JSON" "$COMMAND_TIMEOUT" docker inspect "$POSTGRES_ID"
assert_postgres_identity
jq -e --arg id "$POSTGRES_ID" --arg image "$POSTGRES_IMAGE_ID" '
  length==1 and .[0].Id==$id and .[0].State.Status=="running" and .[0].Image==$image and
  (.[0].Config.Env|type=="array") and (.[0].NetworkSettings.Networks|type=="object")
' "$POSTGRES_INSPECT_JSON" >/dev/null
network_json=$(jq -c '.[0].NetworkSettings.Networks' "$POSTGRES_INSPECT_JSON")
mapfile -t networks < <(jq -r 'keys[]' <<<"$network_json")
if (( ${#networks[@]} != 1 )); then MIGRATION_CLASSIFICATION='POSTGRES_NETWORK_IDENTITY_MISMATCH'; false; fi
NETWORK_NAME=${networks[0]}
capture network_inspect_json "$COMMAND_TIMEOUT" docker network inspect "$NETWORK_NAME"
jq -e '
  length==1 and
  .[0].Labels["com.docker.compose.project"]=="crm" and
  .[0].Labels["com.docker.compose.network"]=="internal"
' <<<"$network_inspect_json" >/dev/null || {
  MIGRATION_CLASSIFICATION='POSTGRES_NETWORK_IDENTITY_MISMATCH'
  false
}
jq -e --arg network "$NETWORK_NAME" '
  .[0].NetworkSettings.Networks[$network].Aliases as $aliases |
  ($aliases|type=="array") and (($aliases|index("postgres")) != null)
' "$POSTGRES_INSPECT_JSON" >/dev/null || {
  MIGRATION_CLASSIFICATION='POSTGRES_NETWORK_ALIAS_MISSING'
  false
}

phase secret_binding POSTGRES_CREDENTIAL_BINDING_FAILED
verify_subordinate "$DATABASE_URL_HELPER" "$PACKAGE_ROOT/postgres-database-url.py" "$DATABASE_URL_HELPER_SHA"
run "$COMMAND_TIMEOUT" python3 "$DATABASE_URL_HELPER" "$POSTGRES_INSPECT_JSON" "$MIGRATION_ENV"
[[ -f $MIGRATION_ENV && ! -L $MIGRATION_ENV && $(stat -Lc '%u:%g:%a' "$MIGRATION_ENV") == 0:0:600 ]]
[[ $(grep -c '^DATABASE_URL=' "$MIGRATION_ENV") == 1 ]]
assert_postgres_identity

PROJECT_HASH_BEFORE=$(project_hash); RESTART_HASH_BEFORE=$(restart_hash)
pg_version=$(psql_read 'SHOW server_version' | awk 'NF{gsub(/^[[:space:]]+|[[:space:]]+$/,""); print; exit}')
[[ $pg_version == 16.14 ]]

phase database_preflight DATABASE_PREFLIGHT_REFUSAL
ledger_state=$(psql_read "SELECT count(*)::text||'|'||count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::text||'|'||count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)::text FROM \"_prisma_migrations\"")
[[ $ledger_state == '46|46|0' ]]
long_transactions=$(psql_read "SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND xact_start IS NOT NULL AND now()-xact_start>interval '5 minutes'")
active_sessions=$(psql_read "SELECT count(*) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state<>'idle'")
[[ $long_transactions == 0 && $active_sessions == 0 ]]
[[ $(psql_read "SELECT to_regclass('public.\"MaxRawTransportEvent\"') IS NULL") == t ]]
collision_count=$(psql_read "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(ARRAY['MaxRawTransportEvent','MaxRawTransportProcessing','MaxRawTransportCursor','MaxInboundNormalizationResult','MaxInboundNormalizedEvent','MaxRouteConversation','MaxOutboundCommand','MaxOutboundConversationActor','MaxOutboundCommandReservation','MaxOutboundDispatch','MaxOutboundDispatchLane','MaxOutboundDispatchAttempt','MaxOutboundDispatchTransition','MaxOutboundReconciliationTask','MaxProviderConfirmationEvidence','MaxProviderConfirmationResolution','MaxProviderConfirmationDecision','MaxProviderConfirmationCursor','MaxShadowComparisonRun','MaxShadowComparisonResult','MaxShadowSemanticDiff','MaxShadowComparisonCursor','MaxRouteIdentityBinding','MaxRouteObservation','MaxRouteConflict'])")
function_collision_count=$(psql_read "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname ~ '^max_(raw_transport|route|outbound|provider_confirmation|shadow_)'")
[[ $collision_count == 0 && $function_collision_count == 0 ]]
ledger_before=$(psql_read 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name')

phase accepted_image_gate IMAGE_GATE_FAILED
[[ $(run "$COMMAND_TIMEOUT" docker image inspect --format '{{join .RepoDigests "\n"}}' "$GATEWAY_IMAGE" | grep -Fx "$GATEWAY_IMAGE") == "$GATEWAY_IMAGE" ]]
[[ $(run "$COMMAND_TIMEOUT" docker image inspect --format '{{.Architecture}}|{{.Os}}|{{.Config.User}}' "$GATEWAY_IMAGE") == 'amd64|linux|1000:1000' ]]
run "$COMMAND_TIMEOUT" docker run --rm --network none --entrypoint sh "$GATEWAY_IMAGE" -ceu '
  for d in /app/prisma/migrations/*; do test -d "$d" && basename "$d"; done | sort' >"$TMP/repository-migrations"
comm -23 "$TMP/repository-migrations" <(printf '%s\n' "$ledger_before") >"$TMP/pending"
comm -13 "$TMP/repository-migrations" <(printf '%s\n' "$ledger_before") >"$TMP/ledger-only"
printf '%s\n' "${EXPECTED_MIGRATIONS[@]}" | sort >"$TMP/expected"
printf '%s\n' "$ACCEPTED_LEDGER_ONLY_MIGRATION" >"$TMP/expected-ledger-only"
cmp "$TMP/expected" "$TMP/pending"
cmp "$TMP/expected-ledger-only" "$TMP/ledger-only"
[[ $(wc -l <"$TMP/repository-migrations") == 53 ]]

phase runner_collision_gate RUNNER_NAME_COLLISION
if run 15 docker container inspect "$MIGRATION_RUNNER" >/dev/null 2>&1; then false; fi
if run 15 docker container inspect "$PRISMA_DIFF_RUNNER" >/dev/null 2>&1; then false; fi
MIGRATION_RUNNER_CLEANUP_STATE='READY'
PRISMA_DIFF_RUNNER_CLEANUP_STATE='READY'

phase fresh_backup FRESH_BACKUP_FAILED
assert_postgres_identity
timestamp=$(date -u +'%Y%m%dT%H%M%SZ'); BACKUP_DIRECTORY="$BACKUP_PREFIX$timestamp"
[[ ! -e $BACKUP_DIRECTORY && ! -L $BACKUP_DIRECTORY ]]
mkdir -m 0700 -- "$BACKUP_DIRECTORY"; chown root:root "$BACKUP_DIRECTORY"; FRESH_BACKUP_CREATED=true
FRESH_BACKUP_STATUS='CREATED_UNVALIDATED'
dump_tmp="$BACKUP_DIRECTORY/database.dump.partial"; dump_path="$BACKUP_DIRECTORY/database.dump"
run 1800 docker exec "$POSTGRES_ID" sh -ceu 'exec pg_dump --format=custom --compress=6 --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >"$dump_tmp"
chmod 0600 "$dump_tmp"; chown root:root "$dump_tmp"; [[ -s $dump_tmp && ! -L $dump_tmp ]]
run "$COMMAND_TIMEOUT" docker exec -i "$POSTGRES_ID" pg_restore --list <"$dump_tmp" >"$BACKUP_DIRECTORY/database.list.partial"
object_count=$(awk 'NF && substr($0,1,1)!=";"{n++} END{print n+0}' "$BACKUP_DIRECTORY/database.list.partial"); (( object_count > 0 ))
chmod 0600 "$BACKUP_DIRECTORY/database.list.partial"; chown root:root "$BACKUP_DIRECTORY/database.list.partial"
tar --create --gzip --absolute-names --file="$BACKUP_DIRECTORY/production-config.tar.gz.partial" -- /opt/crm/deploy/docker-compose.production.yml
chmod 0600 "$BACKUP_DIRECTORY/production-config.tar.gz.partial"; chown root:root "$BACKUP_DIRECTORY/production-config.tar.gz.partial"
tar --list --gzip --file="$BACKUP_DIRECTORY/production-config.tar.gz.partial" >/dev/null
mv --no-clobber "$dump_tmp" "$dump_path"; mv --no-clobber "$BACKUP_DIRECTORY/database.list.partial" "$BACKUP_DIRECTORY/database.list"
mv --no-clobber "$BACKUP_DIRECTORY/production-config.tar.gz.partial" "$BACKUP_DIRECTORY/production-config.tar.gz"
FRESH_BACKUP_DUMP_SHA=$(sha_file "$dump_path")
FRESH_BACKUP_DUMP_BYTES=$(stat -Lc '%s' "$dump_path")
FRESH_BACKUP_OBJECT_COUNT=$object_count
FRESH_BACKUP_CONFIG_SHA=$(sha_file "$BACKUP_DIRECTORY/production-config.tar.gz")
[[ $FRESH_BACKUP_DUMP_SHA =~ ^[0-9a-f]{64}$ && $FRESH_BACKUP_CONFIG_SHA =~ ^[0-9a-f]{64}$ ]]
[[ $FRESH_BACKUP_DUMP_BYTES =~ ^[1-9][0-9]*$ && $FRESH_BACKUP_OBJECT_COUNT =~ ^[1-9][0-9]*$ ]]
FRESH_BACKUP_STATUS='VALIDATED'

phase migration_apply MIGRATION_PARTIAL_FAILURE
assert_postgres_identity
MIGRATION_STARTED=true
MIGRATION_RUNNER_CLEANUP_STATE='STARTING'
run "$MIGRATION_TIMEOUT" docker run --rm --name "$MIGRATION_RUNNER" --label "$RUNNER_STAGE_LABEL" \
  --label "personal-max.role=$MIGRATION_RUNNER_ROLE" --label "$RUNNER_SCRIPT_LABEL_KEY=$SCRIPT_SHA" \
  --label "$RUNNER_TOKEN_LABEL_KEY=$RUNNER_TOKEN" --network "$NETWORK_NAME" --env-file "$MIGRATION_ENV" \
  --env "PGOPTIONS=-c lock_timeout=$MIGRATION_LOCK_TIMEOUT_MS -c statement_timeout=$MIGRATION_STATEMENT_TIMEOUT_MS" \
  --entrypoint sh "$GATEWAY_IMAGE" -ceu \
  'exec /app/node_modules/.bin/prisma migrate deploy --schema /app/prisma/schema.prisma' >"$TMP/migration.log" 2>&1
if run 15 docker container inspect "$MIGRATION_RUNNER" >/dev/null 2>&1; then false; fi
MIGRATION_RUNNER_CLEANUP_STATE='ABSENT_AFTER_SUCCESS'
assert_postgres_identity

phase migration_verification MIGRATION_VERIFICATION_FAILED
ledger_after_state=$(psql_read "SELECT count(*)::text||'|'||count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::text||'|'||count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)::text FROM \"_prisma_migrations\"")
[[ $ledger_after_state == '54|54|0' ]]
ledger_after=$(psql_read 'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name')
comm -13 <(printf '%s\n' "$ledger_before") <(printf '%s\n' "$ledger_after") >"$TMP/applied-now"; cmp "$TMP/expected" "$TMP/applied-now"
[[ $(psql_read "SELECT to_regclass('public.\"MaxRawTransportEvent\"') IS NOT NULL") == t ]]
[[ $(psql_read "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='MaxRawTransportEvent' AND column_name='captureEnvelopeId')") == t ]]
[[ $(psql_read "SELECT to_regclass('public.\"MaxRawTransportEvent_accountId_captureEnvelopeId_idx\"') IS NOT NULL") == t ]]
[[ $(psql_read "SELECT to_regclass('public.\"MaxRawTransportEvent_accountId_captureEnvelopeId_key\"') IS NOT NULL") == t ]]
raw_constraint_count=$(psql_read "SELECT count(*) FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' AND r.relname='MaxRawTransportEvent' AND c.contype='c' AND c.convalidated AND c.conname=ANY(ARRAY['MaxRawTransportEvent_replayAvailability_check','MaxRawTransportEvent_quarantineConsistency_check','MaxRawTransportEvent_payloadSizeBytes_check'])")
[[ $raw_constraint_count == 3 ]]
append_only_trigger_count=$(psql_read "SELECT count(*) FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname='public' AND r.relname='MaxRawTransportEvent' AND t.tgname='MaxRawTransportEvent_append_only' AND t.tgenabled='O' AND NOT t.tgisinternal AND p.proname='max_raw_transport_event_append_only_guard'")
[[ $append_only_trigger_count == 1 ]]
append_only_function_count=$(psql_read "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='max_raw_transport_event_append_only_guard' AND p.pronargs=0 AND p.prorettype='trigger'::regtype")
[[ $append_only_function_count == 1 ]]
[[ $(psql_read 'SELECT count(*) FROM "MaxRawTransportEvent"') == 0 ]]
PRISMA_DIFF_RUNNER_CLEANUP_STATE='STARTING'
if run "$PRISMA_DIFF_TIMEOUT" docker run --rm --name "$PRISMA_DIFF_RUNNER" --label "$RUNNER_STAGE_LABEL" \
  --label "personal-max.role=$PRISMA_DIFF_RUNNER_ROLE" --label "$RUNNER_SCRIPT_LABEL_KEY=$SCRIPT_SHA" \
  --label "$RUNNER_TOKEN_LABEL_KEY=$RUNNER_TOKEN" --network "$NETWORK_NAME" --env-file "$MIGRATION_ENV" \
  --env "PGOPTIONS=-c lock_timeout=$MIGRATION_LOCK_TIMEOUT_MS -c statement_timeout=$PRISMA_DIFF_STATEMENT_TIMEOUT_MS" \
  --entrypoint sh "$GATEWAY_IMAGE" -ceu \
  'exec /app/node_modules/.bin/prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel /app/prisma/schema.prisma --script --exit-code' \
  >"$TMP/prisma-diff.sql" 2>"$TMP/prisma-diff.stderr"; then
  prisma_diff_exit=0
else
  prisma_diff_exit=$?
fi
if run 15 docker container inspect "$PRISMA_DIFF_RUNNER" >/dev/null 2>&1; then false; fi
PRISMA_DIFF_RUNNER_CLEANUP_STATE='ABSENT_AFTER_RUN'
[[ $prisma_diff_exit == 2 ]]
verify_subordinate "$PRISMA_DRIFT_VALIDATOR" "$PACKAGE_ROOT/validate-accepted-prisma-drift.awk" "$PRISMA_DRIFT_VALIDATOR_SHA"
PRISMA_DIFF_STATUS=$(awk -f "$PRISMA_DRIFT_VALIDATOR" "$TMP/prisma-diff.sql")
[[ $PRISMA_DIFF_STATUS == "$ACCEPTED_PRISMA_DIFF_STATUS" ]]
PRISMA_DIFF_RUNNER_CLEANUP_STATE='ABSENT_AFTER_SUCCESS'
assert_postgres_identity

phase production_immutability PRODUCTION_DRIFT
PROJECT_HASH_AFTER=$(project_hash); RESTART_HASH_AFTER=$(restart_hash)
[[ $PROJECT_HASH_AFTER == "$PROJECT_HASH_BEFORE" && $RESTART_HASH_AFTER == "$RESTART_HASH_BEFORE" ]]
[[ $(git -C /opt/crm rev-parse HEAD) == "$PRODUCTION_HEAD" ]]
status_after=$(git -C /opt/crm status --porcelain=v2 --untracked-files=all | sha256sum | awk '{print $1}')
[[ $status_after == "$PRODUCTION_STATUS_V2_SHA" ]]
free_after=$(df -B1 --output=avail "$BACKUP_PARENT" | awk 'NR==2{print $1}'); (( free_after >= ROLLBACK_RESERVE_BYTES ))

phase report_handoff REPORT_HANDOFF_FAILED
assert_postgres_identity
report_tmp=$(mktemp "/var/tmp/personal-max-stage8b2a-production-migration.$SCRIPT_SHA.XXXXXX")
jq -n --arg scriptSha "$SCRIPT_SHA" --arg isolatedSha "$PERSONAL_MAX_ISOLATED_REPORT_SHA256" --arg image "$GATEWAY_IMAGE" \
  --arg network "$NETWORK_NAME" \
  --arg backupDirectory "$BACKUP_DIRECTORY" --arg dumpSha "$FRESH_BACKUP_DUMP_SHA" --arg configSha "$FRESH_BACKUP_CONFIG_SHA" \
  --arg beforeHash "$PROJECT_HASH_BEFORE" --arg afterHash "$PROJECT_HASH_AFTER" --arg diffStatus "$PRISMA_DIFF_STATUS" \
  --arg migrationRunnerState "$MIGRATION_RUNNER_CLEANUP_STATE" --arg diffRunnerState "$PRISMA_DIFF_RUNNER_CLEANUP_STATE" \
  --argjson dumpBytes "$FRESH_BACKUP_DUMP_BYTES" --argjson objectCount "$FRESH_BACKUP_OBJECT_COUNT" \
  --argjson freeBefore "$free_before" --argjson freeAfter "$free_after" \
  --argjson applied "$(jq -Rsc 'split("\n")[:-1]' "$TMP/applied-now")" '
  {schemaVersion:1,mode:"PRODUCTION_MIGRATION_EVIDENCE",script:{sha256:$scriptSha,checksumBound:true},
   bindings:{isolatedReportSha256:$isolatedSha,acceptedBackupReportSha256:"f9b29d5fbe69b9a87d402bab3a19a1079797640549078b17a6ba8e7280415566"},
   databaseBinding:{source:"postgres-container-env",projectLabel:"crm",serviceLabel:"postgres",
    envKeys:["POSTGRES_USER","POSTGRES_PASSWORD","POSTGRES_DB"],urlHost:"postgres",urlPort:5432,urlSchema:"public",
    inspectMode:"0600",envMode:"0600",networkName:$network,networkProjectLabel:"crm",networkComposeLabel:"internal",
    alias:"postgres",runnerNetworkCount:1,containerIdentityStable:true,credentialsPrinted:false,credentialsInArguments:false},
   image:{ref:$image,digestBound:true},freshBackup:{directory:$backupDirectory,dumpSha256:$dumpSha,dumpBytes:$dumpBytes,objectCount:$objectCount,configArchiveSha256:$configSha,status:"VALIDATED",structuralValidation:"PASS"},
   migration:{before:{total:46,finished:46,failed:0},after:{total:54,finished:54,failed:0},appliedNames:$applied,
    acceptedLedgerOnlyMigrations:["20260717000000_add_driver_telegram_submitted_phone"],rawRows:0,prismaDiffEmpty:false,
    prismaDiffStatus:$diffStatus,prismaDiffRawSqlIncluded:false},
   schema:{rawJournalConstraints:["MaxRawTransportEvent_payloadSizeBytes_check","MaxRawTransportEvent_quarantineConsistency_check","MaxRawTransportEvent_replayAvailability_check"],
    appendOnlyTrigger:"MaxRawTransportEvent_append_only",appendOnlyFunction:"max_raw_transport_event_append_only_guard"},
   runners:{migration:{name:"personal-max-stage8b2a-migration-runner",cleanupState:$migrationRunnerState},prismaDiff:{name:"personal-max-stage8b2a-prisma-diff-runner",cleanupState:$diffRunnerState},allOwnedRunnersAbsent:true},
   production:{containerHashBefore:$beforeHash,containerHashAfter:$afterHash,restartCountsUnchanged:true,gitUnchanged:true},
   storage:{freeBytesBefore:$freeBefore,freeBytesAfter:$freeAfter,rollbackReserveBytes:5368709120},
   safety:{deploy:false,restart:false,captureEnabled:false,gatewayStarted:false,scraperChanged:false,destructiveRollback:false,secretsPrinted:false,providerAction:false,maxContacted:false}}' >"$report_tmp"
verify_subordinate "$REPORT_SUCCESS_FILTER" "$PACKAGE_ROOT/report-success.jq" "$REPORT_SUCCESS_FILTER_SHA"
jq -e --arg expectedScriptSha "$SCRIPT_SHA" --arg expectedImage "$GATEWAY_IMAGE" -f "$REPORT_SUCCESS_FILTER" "$report_tmp" >/dev/null
chown root:codexbot "$report_tmp"; chmod 0640 "$report_tmp"; mv --no-clobber "$report_tmp" "$SUCCESS_REPORT"
run 5 runuser -u codexbot -- test -r "$SUCCESS_REPORT"; if run 5 runuser -u codexbot -- test -w "$SUCCESS_REPORT"; then false; fi
report_sha=$(sha_file "$SUCCESS_REPORT")
trap - ERR EXIT; cleanup 0
printf 'STAGE8B2A_MIGRATION_COMPLETED\nSANITIZED_RESULT_PATH=%s\nSANITIZED_RESULT_SHA256=%s\nFRESH_BACKUP_DIRECTORY=%s\nDEPLOY=NO\nRESTART=NO\nCAPTURE_ENABLED=NO\n' "$SUCCESS_REPORT" "$report_sha" "$BACKUP_DIRECTORY"
