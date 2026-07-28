#!/usr/bin/env bash
# shellcheck disable=SC2016
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd); script="$root/production-migration.sh"; pass=0
check() { "$@"; pass=$((pass+1)); }
check grep -Fq 'PERSONAL_MAX_ISOLATED_REPORT_SHA256' "$script"
check grep -Fq '46|46|0' "$script"; check grep -Fq '54|54|0' "$script"
check grep -Fq '${#pg_set[@]} == 1' "$script"; check grep -Fq '${#gravity_set[@]} == 1' "$script"
check grep -Fq 'long_transactions == 0' "$script"; check grep -Fq 'free_before >= MINIMUM_FREE_BYTES' "$script"
check grep -Fq 'docker run --rm --network "$NETWORK_NAME" --env-file "$TMP/migration.env"' "$script"
check grep -Fq -- '--entrypoint sh "$GATEWAY_IMAGE"' "$script"; check grep -Fq 'mv --no-clobber' "$script"
check grep -Fq 'destructiveRollback:false' "$root/failure-diagnostics.sh"; check grep -Fq 'DEPLOY_BLOCKED=YES' "$root/failure-diagnostics.sh"
check grep -Fq 'timeout --signal=TERM' "$script"
check grep -Fq 'rolled_back_at IS NOT NULL' "$script"
check grep -Fq 'function_collision_count' "$script"
check grep -Fq -- '--from-url "$DATABASE_URL" --to-schema-datamodel' "$script"
check grep -Fq 'appliedNamesObserved' "$root/failure-diagnostics.sh"
if rg -n '(docker (compose|system prune|volume prune)|--publish|-p [0-9]|migrate resolve|DROP TABLE|DELETE FROM "_prisma_migrations")' "$script"; then exit 1; fi
if rg -n '(POSTGRES_PASSWORD=|DATABASE_URL=postgres|password[^A-Za-z])' "$root" --glob '!test-faults.sh'; then exit 1; fi
printf 'PHASE_B_FAULT_CONTRACT_PASS=%s\n' "$pass"
