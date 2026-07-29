#!/usr/bin/env bash
set -Eeuo pipefail
set +x

readonly PACKAGE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly EXPECTED_FILES=(
  MANIFEST.json
  SHA256SUMS
  browser-ownership-contract.md
  failure-diagnostics.sh
  listener-ownership-contract.md
  owner-instructions.md
  privacy-contract.md
  profile-ownership-contract.md
  recreation-evidence-contract.md
  report-schema.json
  scraper-runtime-metadata.sh
  test-faults.sh
  test-package.sh
)

mapfile -t actual_files < <(find "$PACKAGE_DIR" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | sort)
mapfile -t expected_files < <(printf '%s\n' "${EXPECTED_FILES[@]}" | sort)
[[ ${#actual_files[@]} -eq 13 ]]
[[ "${actual_files[*]}" == "${expected_files[*]}" ]]

jq -e --argjson expected "$(printf '%s\n' "${expected_files[@]}" | jq -Rsc 'split("\n") | map(select(length>0))')" \
  '.schemaVersion==1 and .status=="AUTHORIZED_FOR_FINAL_DELIVERY" and .execution.performed==false and .execution.productionMutationAuthorized==false and (.files|sort)==$expected' \
  "$PACKAGE_DIR/MANIFEST.json" >/dev/null
jq -e '.type=="object" and .additionalProperties==false and (.required|index("immutability"))!=null and (.required|index("safety"))!=null' "$PACKAGE_DIR/report-schema.json" >/dev/null

(
  cd "$PACKAGE_DIR"
  sha256sum --check --strict SHA256SUMS
)

bash -n "$PACKAGE_DIR/scraper-runtime-metadata.sh"
bash -n "$PACKAGE_DIR/failure-diagnostics.sh"
bash -n "$PACKAGE_DIR/test-faults.sh"

grep -Fq "com.docker.compose.project=crm" "$PACKAGE_DIR/scraper-runtime-metadata.sh"
grep -Fq "com.docker.compose.service=max-web-scraper" "$PACKAGE_DIR/scraper-runtime-metadata.sh"
grep -Fq "environment variable names only" "$PACKAGE_DIR/privacy-contract.md"
grep -Fq "AUTHORIZED_FOR_FINAL_DELIVERY" "$PACKAGE_DIR/owner-instructions.md"
grep -Fq 'env GIT_OPTIONAL_LOCKS=0 git -C /opt/crm status --porcelain=v2 --untracked-files=all' "$PACKAGE_DIR/scraper-runtime-metadata.sh"
! grep -ERiq '(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9]{20,})' "$PACKAGE_DIR"
! grep -Eq 'docker[[:space:]]+(restart|stop|kill|run|create|rm|update|pull|build|load|push)[[:space:]]' "$PACKAGE_DIR/scraper-runtime-metadata.sh"

/bin/bash "$PACKAGE_DIR/test-faults.sh"
printf '%s\n' 'SCRAPER_RUNTIME_METADATA_PACKAGE_TESTS_PASSED docker_execution=0'
