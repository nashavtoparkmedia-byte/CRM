#!/usr/bin/env bash
# shellcheck disable=SC2016
set -Eeuo pipefail

package_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$package_root"

test "$(find . -maxdepth 1 -type f | wc -l)" -eq 14
test "$(find . -mindepth 1 -maxdepth 1 | wc -l)" -eq 14
test "$(find . -mindepth 1 -maxdepth 1 \( -type d -o -type l \) | wc -l)" -eq 0
test "$(jq -r '.files[]' MANIFEST.json | LC_ALL=C sort | sha256sum | awk '{print $1}')" = "$(find . -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort | sha256sum | awk '{print $1}')"

bash -n observe-readonly.sh test-package.sh
python3 -c 'import ast,pathlib; [ast.parse(pathlib.Path(path).read_text()) for path in ("evaluate.py","test-evaluator.py")]'
if command -v shellcheck >/dev/null; then
  shellcheck observe-readonly.sh test-package.sh
else
  printf 'PHASE_E_SHELLCHECK_SKIPPED=UNAVAILABLE\n'
fi

sha256sum -c SHA256SUMS
test "$(wc -l < SHA256SUMS)" -eq 13
test "$(jq -r '.files[] | select(. != "SHA256SUMS")' MANIFEST.json | LC_ALL=C sort | sha256sum | awk '{print $1}')" = "$(awk '{name=$2; sub(/^\*/, "", name); print name}' SHA256SUMS | LC_ALL=C sort | sha256sum | awk '{print $1}')"
jq -e '.stage=="8B2_OBSERVATION" and .status=="PREPARED_NOT_EXECUTED" and .reportSchemaVersion==2 and (.files|length)==14 and .databaseQueriesExecutedDuringPreparation==false and .rootObserverExecutedDuringPreparation==false and .dockerCommandsExecutedDuringPreparation==false' MANIFEST.json >/dev/null
jq -e '.properties.schemaVersion.const==2 and (.required|length)==19 and .properties.privacy.additionalProperties==false and .additionalProperties==false' report-schema.json >/dev/null
jq -e '."$defs".gateway.additionalProperties==false and (."$defs".gateway.required|index("securityConfig"))!=null and (."$defs".gateway.required|index("startedAtEpoch"))!=null and (."$defs".database.required|index("schemaState"))!=null and (."$defs".scraper.required|index("startedAtEpoch"))!=null' report-schema.json >/dev/null
jq -e '.containsMessageData==false and .containsPayload==false and .containsPhone==false and .containsRawAccountIds==false and .containsCredentials==false' sample-fixtures.json >/dev/null

evaluator_output=$(PYTHONDONTWRITEBYTECODE=1 python3 test-evaluator.py)
printf '%s\n' "$evaluator_output"
[[ $evaluator_output =~ ^PHASE_E_EVALUATOR_PASS=([0-9]+)$ ]]
evaluator_count=${BASH_REMATCH[1]}
(( evaluator_count >= 102 ))

observations_bound_sha=$(sed -n "s/^readonly OBSERVATIONS_SQL_SHA='\([0-9a-f]\{64\}\)'$/\1/p" observe-readonly.sh)
evaluator_bound_sha=$(sed -n "s/^readonly EVALUATOR_SHA='\([0-9a-f]\{64\}\)'$/\1/p" observe-readonly.sh)
migration_script_bound_sha=$(sed -n "s/^readonly ACCEPTED_MIGRATION_SCRIPT_SHA='\([0-9a-f]\{64\}\)'$/\1/p" observe-readonly.sh)
dormant_script_bound_sha=$(sed -n "s/^readonly ACCEPTED_DORMANT_SCRIPT_SHA='\([0-9a-f]\{64\}\)'$/\1/p" observe-readonly.sh)
dormant_rollback_bound_sha=$(sed -n "s/^readonly ACCEPTED_DORMANT_ROLLBACK_SHA='\([0-9a-f]\{64\}\)'$/\1/p" observe-readonly.sh)
dormant_compose_bound_sha=$(sed -n "s/^readonly ACCEPTED_DORMANT_COMPOSE_SHA='\([0-9a-f]\{64\}\)'$/\1/p" observe-readonly.sh)
test "$observations_bound_sha" = "$(sha256sum observations.sql | awk '{print $1}')"
test "$evaluator_bound_sha" = "$(sha256sum evaluate.py | awk '{print $1}')"
test "$migration_script_bound_sha" = "$(sha256sum ../personal-max-stage8b2a-production-migration/production-migration.sh | awk '{print $1}')"
test "$dormant_script_bound_sha" = "$(sha256sum ../personal-max-stage8b2b-dormant-gateway/dormant-rollout.sh | awk '{print $1}')"
test "$dormant_rollback_bound_sha" = "$(sha256sum ../personal-max-stage8b2b-dormant-gateway/dormant-rollback.sh | awk '{print $1}')"
test "$dormant_compose_bound_sha" = "$(sha256sum ../personal-max-stage8b2b-dormant-gateway/dormant-gateway.compose.yml | awk '{print $1}')"
test "$migration_script_bound_sha" = "$(jq -r '.productionMigrationScriptSha256' ../personal-max-stage8b2a-production-migration/MANIFEST.json)"
test "$dormant_script_bound_sha" = "$(jq -r '.rolloutScriptSha256' ../personal-max-stage8b2b-dormant-gateway/MANIFEST.json)"
test "$migration_script_bound_sha" = "$(jq -r '.acceptedMigrationBinding.productionMigrationScriptSha256' ../personal-max-stage8b2b-dormant-gateway/MANIFEST.json)"
test "$dormant_rollback_bound_sha" = "$(jq -r '.hardBoundRuntimeArtifacts["dormant-rollback.sh"]' ../personal-max-stage8b2b-dormant-gateway/MANIFEST.json)"
test "$dormant_compose_bound_sha" = "$(jq -r '.hardBoundRuntimeArtifacts["dormant-gateway.compose.yml"]' ../personal-max-stage8b2b-dormant-gateway/MANIFEST.json)"
test "$migration_script_bound_sha" = "$(PYTHONDONTWRITEBYTECODE=1 python3 -c 'import evaluate; print(evaluate.EXPECTED_MIGRATION_SCRIPT_SHA)')"
test "$dormant_script_bound_sha" = "$(PYTHONDONTWRITEBYTECODE=1 python3 -c 'import evaluate; print(evaluate.EXPECTED_DORMANT_SCRIPT_SHA)')"
test "$dormant_rollback_bound_sha" = "$(PYTHONDONTWRITEBYTECODE=1 python3 -c 'import evaluate; print(evaluate.EXPECTED_DORMANT_ROLLBACK_SHA)')"
test "$dormant_compose_bound_sha" = "$(PYTHONDONTWRITEBYTECODE=1 python3 -c 'import evaluate; print(evaluate.EXPECTED_DORMANT_COMPOSE_SHA)')"
test "$(jq -r '.hardBoundPackageArtifacts["observations.sql"]' MANIFEST.json)" = "$observations_bound_sha"
test "$(jq -r '.hardBoundPackageArtifacts["evaluate.py"]' MANIFEST.json)" = "$evaluator_bound_sha"
test "$(jq -r '.observerScriptSha256' MANIFEST.json)" = "$(sha256sum observe-readonly.sh | awk '{print $1}')"
test "$(jq -r '.acceptedDatabaseBinding' MANIFEST.json)" = POSTGRES_IDENTITY_FENCED
test "$(jq -r '.acceptedEvidenceScripts.productionMigration' MANIFEST.json)" = "$migration_script_bound_sha"
test "$(jq -r '.acceptedEvidenceScripts.dormantRollout' MANIFEST.json)" = "$dormant_script_bound_sha"
test "$(jq -r '.acceptedEvidenceScripts.dormantRollback' MANIFEST.json)" = "$dormant_rollback_bound_sha"
test "$(jq -r '.acceptedEvidenceCompose.dormantGateway' MANIFEST.json)" = "$dormant_compose_bound_sha"
test "$(jq -r '.adversarialEvaluatorCases' MANIFEST.json)" -eq "$evaluator_count"

grep -Fq 'BEGIN TRANSACTION READ ONLY' observations.sql
grep -Fq "statement_timeout = '5000ms'" observations.sql
grep -Fq "lock_timeout = '1000ms'" observations.sql
grep -Fq 'e."accountId" = a.account_id' observations.sql
grep -Fq 'raw_journal_rows_per_second' observations.sql
grep -Fq 'count(r."observationId")::bigint AS raw_journal_rows' observations.sql
grep -Fq 'count(c.conflict_marker)::bigint AS open_route_conflicts' observations.sql
grep -Fq 'clock_timestamp() - (min(r."observedAt") FILTER (WHERE n."status" IS NULL))' observations.sql
grep -Fq 'count(*) FILTER (WHERE r."observationId" IS NOT NULL AND n."status" IS NULL)' observations.sql
if rg -n 'count\(r\.\*\)|count\(c\.\*\)' observations.sql; then exit 1; fi
if rg -ni '\b(insert|update|delete|alter|drop|truncate|create)\b' observations.sql; then exit 1; fi
if rg -n '(sanitizedPayload|normalizedPayload|commandPayload|safeMetadata|messageText|caption|phone|displayName|providerPayload|correlationMetadata|redactionMetadata)' observations.sql; then exit 1; fi
if rg -n '(physical_frames|physicalFrames)' observations.sql; then exit 1; fi

grep -Fq '{{.Config.Image}}' observe-readonly.sh
grep -Fq '{{.Image}}' observe-readonly.sh
grep -Fq '{{json .RepoDigests}}' observe-readonly.sh
grep -Fq 'org.opencontainers.image.revision' observe-readonly.sh
grep -Fq 'UNKNOWN_NO_WINDOW_ALIGNED_PHYSICAL_FRAME_SOURCE' observe-readonly.sh
grep -Fq 'SOURCE_BOUND_CONTRACT' observe-readonly.sh
grep -Fq 'else print "null"' observe-readonly.sh
grep -Fq 'verify_package_artifact "$PACKAGE_ROOT/observations.sql"' observe-readonly.sh
grep -Fq 'verify_package_artifact "$PACKAGE_ROOT/evaluate.py"' observe-readonly.sh
grep -Fq 'cat "$TMP/observations.sql"' observe-readonly.sh
grep -Fq 'python3 "$TMP/evaluate.py" "$TMP/report-base.json"' observe-readonly.sh
grep -Fq 'python3 "$TMP/evaluate.py" --validate-final "$TMP/report.json" "$target"' observe-readonly.sh
grep -Fq 'SCRIPT_SNAPSHOT_OWNERSHIP_INVALID' observe-readonly.sh
grep -Fq 'gateway_security_config_mismatch' evaluate.py
grep -Fq 'current_schema_contract_mismatch' evaluate.py
grep -Fq 'valid_database_binding' evaluate.py
grep -Fq 'POSTGRES_IDENTITY_FENCED' observe-readonly.sh
grep -Fq 'active_external_evidence_binding_missing' evaluate.py
grep -Fq 'default_off_external_evidence_binding_missing' evaluate.py
grep -Fq 'expectedConstraintDefinitionsExact' observations.sql
grep -Fq 'appendOnlyContractExact' observations.sql
grep -Fq 't.tgqual IS NULL' observations.sql
grep -Fq 't.tgnargs = 0' observations.sql
grep -Fq 'docker exec "$gateway_id"' observe-readonly.sh
if rg -n 'docker exec "\$GATEWAY_CONTAINER"' observe-readonly.sh; then exit 1; fi
grep -Fq -- '--slurpfile migrationEvidence "$TMP/migration-report.json"' observe-readonly.sh
grep -Fq -- '--slurpfile dormantEvidence "$TMP/dormant-report.json"' observe-readonly.sh
if awk '/^PHASE=.report_assembly./,/^PHASE=.report_handoff./' observe-readonly.sh | rg -n '\$(MIGRATION_REPORT|DORMANT_REPORT)'; then exit 1; fi
grep -Fq 'startedAtEpoch' observe-readonly.sh
grep -Fq 'securityConfig' observe-readonly.sh
grep -Fq 'true|false|0|1|all) false' observe-readonly.sh
grep -Fq '$TMP == /var/tmp/personal-max-shadow-observer.*' observe-readonly.sh
grep -Fq "trap 'on_error" observe-readonly.sh
grep -Fq 'chown root:codexbot "$TMP/report.json"' observe-readonly.sh
grep -Fq 'chmod 0640 "$TMP/report.json"' observe-readonly.sh
if rg -n 'if\s*\(!?found\)\s*print\s+0|listenerOwnersObserved:1|browserOwnersObserved:1|projectionDisabled:true' observe-readonly.sh; then exit 1; fi
if rg -n 'sha256sum -c SHA256SUMS' observe-readonly.sh; then exit 1; fi
if rg -n '\.Config\.Env|docker[[:space:]]+(compose|restart|stop|rm|start|run|create|pull|build)|systemctl|/opt/crm' observe-readonly.sh; then exit 1; fi
if rg -n '(POSTGRES_PASSWORD=[^$"{]|DATABASE_URL=postgresql://[A-Za-z0-9]|MAX_PERSONAL_CAPTURE_HMAC_SECRET=[^$"{]|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)' . --glob '!SHA256SUMS' --glob '!test-package.sh'; then exit 1; fi

set +e
observer_output=$(/bin/bash observe-readonly.sh "$(printf '0%.0s' {1..64})" dormant 5m 2>&1)
observer_status=$?
set -e
test "$observer_status" -eq 77
grep -Fq 'SHADOW_OBSERVER_FAILED:ROOT_REQUIRED' <<<"$observer_output"

printf 'PHASE_E_PACKAGE_PASS\n'
