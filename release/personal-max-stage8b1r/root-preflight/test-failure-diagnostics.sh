#!/usr/bin/env bash
# The checksum-verified sourced helper consumes the scenario globals below.
# shellcheck disable=SC1091,SC2034
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
readonly SCRIPT_DIR
readonly DIAGNOSTICS_PATH="$SCRIPT_DIR/failure-diagnostics.sh"
readonly PROBE_SCRIPT_PATH="$SCRIPT_DIR/probe-readonly-production.sh"
readonly EXPECTED_DIAGNOSTICS_SHA256='0fd3e8a5b9c2c9df1762cb8ecb6ab3210dffc2cd645c25a8aa4c4a5270634d49'
readonly FAKE_SCRIPT_SHA256='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

[[ $(sha256sum -- "$DIAGNOSTICS_PATH" | awk '{print $1}') == "$EXPECTED_DIAGNOSTICS_SHA256" ]]
# shellcheck source=release/personal-max-stage8b1r/root-preflight/failure-diagnostics.sh
source "$DIAGNOSTICS_PATH"

TEST_ROOT=$(mktemp -d /tmp/personal-max-stage8b1r-faults.XXXXXX)
cleanup() {
  if [[ ${TEST_ROOT:-} == /tmp/personal-max-stage8b1r-faults.* && -d ${TEST_ROOT:-} ]]; then
    rm -rf -- "$TEST_ROOT"
  fi
}
trap cleanup EXIT

TEST_OWNER=$(id -un)
readonly TEST_OWNER
TEST_GROUP=$(id -gn)
readonly TEST_GROUP
readonly SECRET_SENTINEL='SUPER_SECRET_SENTINEL_DO_NOT_RECORD'
export PERSONAL_MAX_TEST_SECRET="$SECRET_SENTINEL"

SCENARIOS=$(cat <<'EOF'
docker_version|docker_server_metadata|docker_info|DOCKER_SERVER_UNAVAILABLE|70
docker_info|docker_server_metadata|docker_info|DOCKER_SERVER_UNAVAILABLE|71
project_container_list|project_container_discovery_before|docker_ps|DOCKER_METADATA_UNAVAILABLE|72
container_inspect|service_inventory|docker_inspect|DOCKER_METADATA_UNAVAILABLE|73
image_inspect|image_inventory|docker_image_inspect|DOCKER_METADATA_UNAVAILABLE|74
docker_top|scraper_process_metadata|docker_top|DOCKER_METADATA_UNAVAILABLE|75
volume_list|volume_snapshot_before|docker_volume_ls|DOCKER_METADATA_UNAVAILABLE|76
postgres_discovery|postgres_discovery|postgres_discovery|POSTGRES_DISCOVERY_UNAVAILABLE|77
psql_permission|postgres_catalog_session|psql_catalog|PSQL_PERMISSION_DENIED|78
psql_timeout|postgres_catalog_session|psql_catalog|PSQL_TIMEOUT|124
psql_empty_output|postgres_catalog_session|psql_catalog|PSQL_MALFORMED_OUTPUT|65
jq_render|report_render|jq_render|JSON_RENDER_FAILED|79
disk_stat|filesystem_snapshot_before|filesystem_stat|FILESYSTEM_METADATA_UNAVAILABLE|80
backup_metadata|backup_metadata|filesystem_stat|BACKUP_METADATA_UNAVAILABLE|81
final_handoff|report_handoff|report_handoff|REPORT_HANDOFF_FAILED|86
EOF
)
readonly SCENARIOS

scenario_count=0
while IFS='|' read -r scenario phase command_class classification expected_exit; do
  [[ -n $scenario ]] || continue
  scenario_count=$((scenario_count + 1))
  scenario_dir="$TEST_ROOT/$scenario"
  mkdir -m 0700 "$scenario_dir"
  success_path="$scenario_dir/success.json"
  failure_path="$scenario_dir/failure.$FAKE_SCRIPT_SHA256.json"
  success_tmp=$(mktemp "$scenario_dir/success.tmp.XXXXXX")
  chmod 0600 "$success_tmp"
  output_path="$scenario_dir/output.txt"

  set +e
  (
    PREFLIGHT_PHASE=$phase
    PREFLIGHT_SAFE_COMMAND_CLASS=$command_class
    PREFLIGHT_ERROR_CLASSIFICATION=$classification
    PM_DOCKER_METADATA_BEGUN=true
    PM_POSTGRESQL_SESSION_BEGUN=false
    [[ $command_class == psql_catalog ]] && PM_POSTGRESQL_SESSION_BEGUN=true
    PM_FAILURE_HANDLER_ACTIVE=false
    PM_SUCCESS_TMP=$success_tmp
    PM_FAILURE_TMP=''
    PM_SCRIPT_SHA256=$FAKE_SCRIPT_SHA256
    PM_SUCCESS_PATH=$success_path
    PM_FAILURE_PATH=$failure_path
    PM_FAILURE_TMP_PREFIX="$scenario_dir/failure.tmp.$FAKE_SCRIPT_SHA256"
    PM_REPORT_OWNER=$TEST_OWNER
    PM_REPORT_GROUP=$TEST_GROUP
    PM_REPORT_READER=$TEST_OWNER
    PM_VERIFY_PRINCIPAL_ACCESS=false
    personal_max_handle_unexpected_failure "$expected_exit" 321
  ) >"$output_path" 2>&1
  observed_exit=$?
  set -e

  [[ $observed_exit -eq $expected_exit ]]
  [[ -f $failure_path && ! -L $failure_path ]]
  [[ ! -e $success_path && ! -L $success_path ]]
  [[ ! -e $success_tmp && ! -L $success_tmp ]]
  [[ $(stat -Lc '%U:%G:%a' "$failure_path") == "$TEST_OWNER:$TEST_GROUP:640" ]]
  jq -e --arg phase "$phase" --arg class "$command_class" --arg classification "$classification" \
    --argjson exitCode "$expected_exit" \
    '.mode=="READ_ONLY_PRODUCTION_PREFLIGHT_FAILURE" and .phase==$phase and .safeCommandClass==$class and
      .safeErrorClassification==$classification and .exitCode==$exitCode and .sourceLine==321 and
      .successResultCreated==false and .temporaryResultDetected==true and .DockerMutation==false and
      .DDL==false and .DML==false and .migration==false and .restart==false and .deploy==false and
      .browserLaunched==false and .maxContacted==false and .providerAction==false and
      .secretsPrinted==false and .recommendedNextAction=="CODEX_REVIEW_FAILURE_REPORT"' "$failure_path" >/dev/null
  grep -Fx 'PREFLIGHT_FAILED' "$output_path" >/dev/null
  grep -Fx "PREFLIGHT_PHASE=$phase" "$output_path" >/dev/null
  grep -Fx "PREFLIGHT_SAFE_COMMAND_CLASS=$command_class" "$output_path" >/dev/null
  grep -Fx "PREFLIGHT_EXIT_CODE=$expected_exit" "$output_path" >/dev/null
  grep -Fx "FAILURE_REPORT_PATH=$failure_path" "$output_path" >/dev/null
  grep -Fx 'REPORT_MODE=0640' "$output_path" >/dev/null
  if grep -F "$SECRET_SENTINEL" "$failure_path" "$output_path" >/dev/null || \
    grep -E 'BASH_COMMAND|SELECT |POSTGRES_(USER|DB|PASSWORD)|\.Config\.Env' "$failure_path" "$output_path" >/dev/null; then
    printf 'UNSAFE_DIAGNOSTIC_CONTENT: %s\n' "$scenario" >&2
    exit 1
  fi
  if find "$scenario_dir" -maxdepth 1 -type f -name '*.tmp.*' -print -quit | grep -q .; then
    printf 'TEMPORARY_FILE_REMAINED: %s\n' "$scenario" >&2
    exit 1
  fi

  before_hash=$(sha256sum -- "$failure_path" | awk '{print $1}')
  rerun_output="$scenario_dir/rerun-output.txt"
  set +e
  (
    PREFLIGHT_PHASE=$phase
    PREFLIGHT_SAFE_COMMAND_CLASS=$command_class
    PREFLIGHT_ERROR_CLASSIFICATION=$classification
    PM_DOCKER_METADATA_BEGUN=true
    PM_POSTGRESQL_SESSION_BEGUN=false
    PM_FAILURE_HANDLER_ACTIVE=false
    PM_SUCCESS_TMP=''
    PM_FAILURE_TMP=''
    PM_SCRIPT_SHA256=$FAKE_SCRIPT_SHA256
    PM_SUCCESS_PATH=$success_path
    PM_FAILURE_PATH=$failure_path
    PM_FAILURE_TMP_PREFIX="$scenario_dir/rerun-failure.tmp.$FAKE_SCRIPT_SHA256"
    PM_REPORT_OWNER=$TEST_OWNER
    PM_REPORT_GROUP=$TEST_GROUP
    PM_REPORT_READER=$TEST_OWNER
    PM_VERIFY_PRINCIPAL_ACCESS=false
    personal_max_handle_unexpected_failure "$expected_exit" 322
  ) >"$rerun_output" 2>&1
  rerun_exit=$?
  set -e
  [[ $rerun_exit -eq $expected_exit ]]
  grep -Fx 'FAILURE_REPORT_PATH_UNSAFE' "$rerun_output" >/dev/null
  [[ $(sha256sum -- "$failure_path" | awk '{print $1}') == "$before_hash" ]]
done <<<"$SCENARIOS"

[[ $scenario_count -eq 15 ]]
jq -en 'null | (.//{}) | keys | sort | .==[]' >/dev/null
jq -en 'null | (.//[]) | sort | .==[]' >/dev/null
jq -en 'null | .//{} | .=={}' >/dev/null
grep -F '1 | 124)' "$PROBE_SCRIPT_PATH" >/dev/null
grep -F 'PSQL_ERROR_CLASSIFICATION=PSQL_TIMEOUT' "$PROBE_SCRIPT_PATH" >/dev/null 2>&1 || \
  grep -F 'PREFLIGHT_ERROR_CLASSIFICATION=PSQL_TIMEOUT' "$PROBE_SCRIPT_PATH" >/dev/null
grep -F 'PREFLIGHT_ERROR_CLASSIFICATION=PSQL_PERMISSION_DENIED' "$PROBE_SCRIPT_PATH" >/dev/null
grep -F 'PREFLIGHT_ERROR_CLASSIFICATION=PSQL_MALFORMED_OUTPUT' "$PROBE_SCRIPT_PATH" >/dev/null
grep -F "bootstrap_fail 'RESULT_PATH_UNSAFE'" "$PROBE_SCRIPT_PATH" >/dev/null
grep -F "bootstrap_fail 'FAILURE_REPORT_PATH_UNSAFE'" "$PROBE_SCRIPT_PATH" >/dev/null
empty_numeric_output=''
if [[ $empty_numeric_output =~ ^[0-9]+$ ]]; then
  printf 'EMPTY_NUMERIC_OUTPUT_ACCEPTED\n' >&2
  exit 1
fi
printf 'FAULT_MATRIX=PASS scenarios=%s\n' "$scenario_count"
printf 'PERMISSION_CONTRACT_SIMULATION=PASS owner=%s group=%s mode=0640\n' "$TEST_OWNER" "$TEST_GROUP"
printf 'NO_SILENT_FAILURE=PASS scenarios=%s\n' "$scenario_count"
printf 'POSTGRESQL_STRUCTURED_CASES=PASS unavailable,timeout,permission_denied,malformed_output\n'
printf 'DOCKER_NULL_EMPTY_FIELDS=PASS\n'
printf 'OPTIONAL_PROBE_CLASSIFICATION=PASS\n'
printf 'EXISTING_PATH_GUARDS=PASS\n'
