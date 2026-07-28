#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd); cd "$root"
test "$(find . -maxdepth 1 -type f | wc -l)" -eq 17
bash -n production-migration.sh failure-diagnostics.sh test-package.sh test-faults.sh
python3 -c 'from pathlib import Path; [compile(path.read_text(encoding="utf-8"), str(path), "exec") for path in map(Path, ("postgres-database-url.py", "test-postgres-binding.py"))]'
if command -v shellcheck >/dev/null; then shellcheck -x production-migration.sh failure-diagnostics.sh test-package.sh test-faults.sh; fi
sha256sum -c SHA256SUMS
cmp <(jq -r '.files[]|select(.!="SHA256SUMS")' MANIFEST.json | LC_ALL=C sort) <(awk '{print $2}' SHA256SUMS | LC_ALL=C sort)
jq -e '.schemaVersion==1 and .stage=="8B2A" and (.files|length)==17 and .productionStatusHashMode=="RAW_PORCELAIN_V2_STREAM" and (.acceptedIsolatedProbeScriptSha256|test("^[0-9a-f]{64}$")) and .acceptedLedgerOnlyMigrations==["20260717000000_add_driver_telegram_submitted_phone"] and .acceptedPrismaDiff.status=="ACCEPTED_LEGACY_DRIVER_TELEGRAM_COLUMNS"' MANIFEST.json >/dev/null
script_sha=$(sha256sum production-migration.sh | awk '{print $1}')
jq -e --arg sha "$script_sha" '.productionMigrationScriptSha256==$sha' MANIFEST.json >/dev/null
for artifact in failure-diagnostics.sh report-success.jq validate-accepted-prisma-drift.awk postgres-database-url.py; do
  artifact_sha=$(sha256sum "$artifact" | awk '{print $1}')
  jq -e --arg artifact "$artifact" --arg sha "$artifact_sha" '.hardBoundRuntimeArtifacts[$artifact]==$sha' MANIFEST.json >/dev/null
done
grep -Fq "$script_sha" owner-instructions.md
jq -e '.type=="object" and (.oneOf|length)==2 and all(.oneOf[]; .additionalProperties==false) and
  ([.oneOf[].properties.mode.const]|sort)==["PRODUCTION_MIGRATION_EVIDENCE","PRODUCTION_MIGRATION_FAILURE"]' report-schema.json >/dev/null
test "$(wc -l < SHA256SUMS)" -eq 16
./test-faults.sh
if rg -n '(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})' .; then exit 1; fi
if rg -n '(/opt/crm/.+>|git -C /opt/crm (checkout|reset|clean)|docker (restart|stop|compose)|systemctl)' production-migration.sh failure-diagnostics.sh; then exit 1; fi
printf 'PHASE_B_PACKAGE_PASS\n'
