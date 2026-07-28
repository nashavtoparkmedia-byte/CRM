#!/usr/bin/env bash
set -Eeuo pipefail
set +x

readonly PACKAGE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly REPOSITORY_ROOT=$(cd "$PACKAGE_DIR/../.." && pwd)
readonly EXPECTED_FILES=(
  MANIFEST.json SHA256SUMS canary-safety-contract.md metadata-root-command.md observation-metrics.md provenance.json
  release-gates.md rollback-boundaries.md source-hashes.json staged-rollout-plan.md test-faults.sh test-package.sh
  uat-contact-a-b.md uat-contact-a.md
)

mapfile -t actual < <(find "$PACKAGE_DIR" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | sort)
mapfile -t expected < <(printf '%s\n' "${EXPECTED_FILES[@]}" | sort)
[[ ${#actual[@]} -eq 14 && "${actual[*]}" == "${expected[*]}" ]]

jq -e --argjson expected "$(printf '%s\n' "${expected[@]}" | jq -Rsc 'split("\n")|map(select(length>0))')" \
  '.schemaVersion==1 and .status=="PREPARED_NOT_EXECUTED" and .authorizedProductionCommands==[] and .metadataRootCommandStatus=="READY_NOT_AUTHORIZED" and (.files|sort)==$expected' \
  "$PACKAGE_DIR/MANIFEST.json" >/dev/null
jq -e '.acceptedTrustChain|length==7' "$PACKAGE_DIR/provenance.json" >/dev/null
jq -e '.newPreparation.scraperMetadataProbeSha256=="ab0a6249f58a02e827b407351df73ca05d3074feee621c16729b0bc68500538f"' "$PACKAGE_DIR/provenance.json" >/dev/null

(
  cd "$PACKAGE_DIR"
  sha256sum --check --strict SHA256SUMS
)
(
  cd "$REPOSITORY_ROOT"
  jq -r '.files|to_entries[]|"\(.value)  \(.key)"' "$PACKAGE_DIR/source-hashes.json" | sha256sum --check --strict -
)

bash -n "$PACKAGE_DIR/test-faults.sh"
[[ $(grep -Roh 'sudo /bin/bash' "$PACKAGE_DIR"/*.md | wc -l) -eq 1 ]]
! grep -ERiq '(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9]{20,}|password[[:space:]]*[:=][[:space:]]*[^ ]+)' "$PACKAGE_DIR"
! grep -ERq 'accountAllowlist[^\n]*\*|conversationAllowlist[^\n]*\*' "$PACKAGE_DIR"
! grep -ERq '(^|[^A-Za-z])(docker|psql|prisma|systemctl)[[:space:]]+(run|exec|restart|stop|migrate|deploy)' "$PACKAGE_DIR"/*.md

/bin/bash "$PACKAGE_DIR/test-faults.sh"
printf '%s\n' 'TEXT_CANARY_PREPARATION_PACKAGE_TESTS_PASSED production_execution=0'
