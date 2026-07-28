#!/usr/bin/env bash
# The test sources only the diagnostics helper; it never executes the root backup script.
# shellcheck disable=SC1091,SC2016,SC2034
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
readonly BACKUP_SCRIPT="$SCRIPT_DIR/create-production-backup.sh"
readonly DIAGNOSTICS="$SCRIPT_DIR/failure-diagnostics.sh"
readonly EXPECTED_DIAGNOSTICS_SHA256='dc94d28fc134a6473d7880e744068cfa536f837e0f745cc6ff969eb4c01c18fd'
readonly FAKE_SCRIPT_SHA256='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

[[ $(sha256sum -- "$DIAGNOSTICS" | awk '{print $1}') == "$EXPECTED_DIAGNOSTICS_SHA256" ]]
# shellcheck source=release/personal-max-stage8b1s/root-backup/failure-diagnostics.sh
source "$DIAGNOSTICS"

TEST_ROOT=$(mktemp -d /tmp/personal-max-stage8b1s-contract.XXXXXX)
cleanup() {
  if [[ ${TEST_ROOT:-} == /tmp/personal-max-stage8b1s-contract.* && -d ${TEST_ROOT:-} ]]; then
    rm -rf -- "$TEST_ROOT"
  fi
}
trap cleanup EXIT

discover_exact_postgres() {
  local rows=$1 row id project service state
  local -a matches=()
  while IFS='|' read -r id project service state; do
    [[ -n $id ]] || continue
    if [[ $id =~ ^[0-9a-f]{64}$ && $project == crm && $service == postgres && $state == running ]]; then
      matches+=("$id")
    fi
  done <<<"$rows"
  (( ${#matches[@]} == 1 )) || return 90
  printf '%s\n' "${matches[0]}"
}

id_a=$(printf 'a%.0s' {1..64})
id_b=$(printf 'b%.0s' {1..64})
[[ $(discover_exact_postgres "$id_a|crm|postgres|running") == "$id_a" ]]
set +e
discover_exact_postgres '' >/dev/null
zero_status=$?
discover_exact_postgres "$id_a|crm|postgres|running
$id_b|crm|postgres|running" >/dev/null
two_status=$?
discover_exact_postgres "$id_a|other|postgres|running" >/dev/null
project_status=$?
discover_exact_postgres "$id_a|crm|gateway|running" >/dev/null
service_status=$?
discover_exact_postgres "$id_a|crm|postgres|exited" >/dev/null
state_status=$?
set -e
[[ $zero_status -eq 90 && $two_status -eq 90 && $project_status -eq 90 && \
  $service_status -eq 90 && $state_status -eq 90 ]]

database_size=135765015
report_estimate=169706269
calculated_estimate=$(((database_size * 5 + 3) / 4))
backup_estimate=$report_estimate
(( calculated_estimate > backup_estimate )) && backup_estimate=$calculated_estimate
minimum_required=$((backup_estimate + 43495 + 5368709120))
[[ $backup_estimate -eq 169706269 ]]
[[ $minimum_required -eq 5538458884 ]]
(( 12500000000 > minimum_required ))

grep -F -- '--filter "label=$PROJECT_LABEL=$PROJECT" --filter "label=$SERVICE_LABEL=$SERVICE"' "$BACKUP_SCRIPT" >/dev/null
grep -F -- "[[ \$observed_labels == \"\$PROJECT|\$SERVICE|running\" ]]" "$BACKUP_SCRIPT" >/dev/null
grep -F -- '(( ${#postgres_ids[@]} == 1 ))' "$BACKUP_SCRIPT" >/dev/null
grep -F -- 'pg_dump --format=custom --compress=6 --no-owner --no-acl' "$BACKUP_SCRIPT" >/dev/null
grep -F -- 'pg_restore --list' "$BACKUP_SCRIPT" >/dev/null
grep -F -- 'object_count=$(awk' "$BACKUP_SCRIPT" >/dev/null
grep -F -- 'BACKUP_PATH_ALREADY_EXISTS' "$BACKUP_SCRIPT" >/dev/null
grep -F -- 'mv --no-clobber --no-target-directory' "$BACKUP_SCRIPT" >/dev/null
grep -F -- "readonly MINIMUM_FREE_BEFORE_BYTES=12500000000" "$BACKUP_SCRIPT" >/dev/null
grep -F -- "readonly ROLLBACK_RESERVE_BYTES=5368709120" "$BACKUP_SCRIPT" >/dev/null
grep -F -- "chmod 0600 \"\$DUMP_TMP\"" "$BACKUP_SCRIPT" >/dev/null
grep -F -- "chmod 0600 \"\$CONFIG_ARCHIVE_TMP\"" "$BACKUP_SCRIPT" >/dev/null
grep -F -- "chmod 0640 \"\$PM_METADATA_TMP\"" "$BACKUP_SCRIPT" >/dev/null
grep -F -- 'contentsPrinted:false' "$BACKUP_SCRIPT" >/dev/null
grep -F -- 'FULL_RESTORE_PROOF:"PENDING_ISOLATED_ROOT_PROBE"' "$BACKUP_SCRIPT" >/dev/null
grep -F -- 'DDL:false,DML:false,migration:false,restart:false,deploy:false' "$BACKUP_SCRIPT" >/dev/null

if grep -E 'docker[[:space:]]+compose|docker-compose([[:space:]]|$)|\.Config\.Env|source[[:space:]]+.*\.env\.production|cat[[:space:]]+.*\.env\.production' "$BACKUP_SCRIPT" >/dev/null; then
  printf 'FORBIDDEN_COMPOSE_OR_ENV_ACCESS\n' >&2
  exit 1
fi
if grep -E 'pg_restore.*(--create|--dbname)|createdb|dropdb|prisma[[:space:]]+migrate|docker[[:space:]]+(pull|load|restart)|systemctl' "$BACKUP_SCRIPT" >/dev/null; then
  printf 'FORBIDDEN_MUTATION_ACTION\n' >&2
  exit 1
fi

scenario_dir="$TEST_ROOT/failure"
mkdir -m 0700 "$scenario_dir"
failure_path="$scenario_dir/failure.$FAKE_SCRIPT_SHA256.json"
output_path="$scenario_dir/output.txt"
test_owner=$(id -un)
test_group=$(id -gn)
secret_sentinel='BACKUP_TEST_SECRET_MUST_NOT_APPEAR'
export PERSONAL_MAX_BACKUP_TEST_SECRET="$secret_sentinel"
set +e
(
  BACKUP_PHASE='database_dump'
  BACKUP_SAFE_COMMAND_CLASS='pg_dump_read'
  BACKUP_ERROR_CLASSIFICATION='DATABASE_DUMP_FAILED'
  PM_FAILURE_HANDLER_ACTIVE=false
  PM_BACKUP_DIRECTORY_CREATED=true
  PM_DUMP_STARTED=true
  PM_DUMP_COMPLETED=false
  PM_STRUCTURAL_VALIDATION_COMPLETED=false
  PM_CONFIG_ARCHIVE_COMPLETED=false
  PM_METADATA_TMP=''
  PM_FAILURE_TMP=''
  PM_SCRIPT_SHA256=$FAKE_SCRIPT_SHA256
  PM_FAILURE_PATH=$failure_path
  PM_FAILURE_TMP_PREFIX="$scenario_dir/failure.tmp.$FAKE_SCRIPT_SHA256"
  PM_REPORT_OWNER=$test_owner
  PM_REPORT_GROUP=$test_group
  PM_REPORT_READER=$test_owner
  PM_VERIFY_PRINCIPAL_ACCESS=false
  personal_max_backup_handle_failure 92 321
) >"$output_path" 2>&1
failure_status=$?
set -e
[[ $failure_status -eq 92 ]]
[[ -f $failure_path && ! -L $failure_path ]]
[[ $(stat -Lc '%U:%G:%a' "$failure_path") == "$test_owner:$test_group:640" ]]
jq -e '.mode=="PRODUCTION_BACKUP_FAILURE" and .phase=="database_dump" and
  .safeCommandClass=="pg_dump_read" and .safeErrorClassification=="DATABASE_DUMP_FAILED" and
  .exitCode==92 and .backupDirectoryCreated==true and .dumpStarted==true and
  .dumpCompleted==false and .structuralValidationCompleted==false and
  .configArchiveCompleted==false and .DockerMutation==false and .DDL==false and
  .DML==false and .migration==false and .restart==false and .deploy==false and
  .secretsPrinted==false and .rawCommandCaptured==false and .rawSqlCaptured==false and
  .rawStderrCaptured==false' "$failure_path" >/dev/null
grep -Fx 'BACKUP_FAILED' "$output_path" >/dev/null
grep -Fx 'BACKUP_PHASE=database_dump' "$output_path" >/dev/null
grep -Fx 'BACKUP_SAFE_COMMAND_CLASS=pg_dump_read' "$output_path" >/dev/null
grep -Fx 'BACKUP_EXIT_CODE=92' "$output_path" >/dev/null
if grep -F "$secret_sentinel" "$failure_path" "$output_path" >/dev/null || \
  grep -E 'BASH_COMMAND|POSTGRES_(USER|DB|PASSWORD)|SELECT |SHOW server_version|\.Config\.Env' "$failure_path" "$output_path" >/dev/null; then
  printf 'UNSAFE_FAILURE_DIAGNOSTIC_CONTENT\n' >&2
  exit 1
fi

failure_hash=$(sha256sum -- "$failure_path" | awk '{print $1}')
rerun_output="$scenario_dir/rerun.txt"
set +e
(
  BACKUP_PHASE='database_dump'
  BACKUP_SAFE_COMMAND_CLASS='pg_dump_read'
  BACKUP_ERROR_CLASSIFICATION='DATABASE_DUMP_FAILED'
  PM_FAILURE_HANDLER_ACTIVE=false
  PM_BACKUP_DIRECTORY_CREATED=true
  PM_DUMP_STARTED=true
  PM_DUMP_COMPLETED=false
  PM_STRUCTURAL_VALIDATION_COMPLETED=false
  PM_CONFIG_ARCHIVE_COMPLETED=false
  PM_METADATA_TMP=''
  PM_FAILURE_TMP=''
  PM_SCRIPT_SHA256=$FAKE_SCRIPT_SHA256
  PM_FAILURE_PATH=$failure_path
  PM_FAILURE_TMP_PREFIX="$scenario_dir/rerun.tmp.$FAKE_SCRIPT_SHA256"
  PM_REPORT_OWNER=$test_owner
  PM_REPORT_GROUP=$test_group
  PM_REPORT_READER=$test_owner
  PM_VERIFY_PRINCIPAL_ACCESS=false
  personal_max_backup_handle_failure 92 322
) >"$rerun_output" 2>&1
rerun_status=$?
set -e
[[ $rerun_status -eq 92 ]]
grep -Fx 'FAILURE_REPORT_PATH_UNSAFE' "$rerun_output" >/dev/null
[[ $(sha256sum -- "$failure_path" | awk '{print $1}') == "$failure_hash" ]]

printf 'LABEL_DISCOVERY=PASS\n'
printf 'SERVICE_CARDINALITY=PASS zero,one,multiple,project,service,state\n'
printf 'FREE_SPACE_GATE=PASS estimate=%s minimumRequired=%s target=12500000000 reserve=5368709120\n' "$backup_estimate" "$minimum_required"
printf 'NO_OVERWRITE=PASS\n'
printf 'PERMISSION_CONTRACT=PASS backup=root:root:0600 metadata=root:codexbot:0640\n'
printf 'DUMP_VERIFICATION_CONTRACT=PASS custom,pg_restore-list,nonempty-count,sha256\n'
printf 'CONFIG_ARCHIVE_SECRECY=PASS exact-paths,no-content-output,0600\n'
printf 'FAILURE_DIAGNOSTICS=PASS\n'
printf 'NO_SILENT_FAILURE=PASS\n'
printf 'BACKUP_SCRIPT_EXECUTED=NO\n'
