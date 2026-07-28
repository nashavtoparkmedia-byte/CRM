#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd); cd "$root"
test "$(find . -maxdepth 1 -type f | wc -l)" -eq 14
bash -n production-migration.sh failure-diagnostics.sh test-package.sh test-faults.sh
if command -v shellcheck >/dev/null; then shellcheck -x production-migration.sh failure-diagnostics.sh test-package.sh test-faults.sh; fi
sha256sum -c SHA256SUMS
jq -e '.schemaVersion==1 and .stage=="8B2A" and (.files|length)==14' MANIFEST.json >/dev/null
jq -e '.type=="object" and (.required|length)>=8' report-schema.json >/dev/null
test "$(wc -l < SHA256SUMS)" -eq 13
./test-faults.sh
if rg -n '(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})' .; then exit 1; fi
if rg -n '(/opt/crm/.+>|git -C /opt/crm (checkout|reset|clean)|docker (restart|stop|compose)|systemctl)' production-migration.sh failure-diagnostics.sh; then exit 1; fi
printf 'PHASE_B_PACKAGE_PASS\n'
