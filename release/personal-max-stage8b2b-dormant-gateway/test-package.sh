#!/usr/bin/env bash
# shellcheck disable=SC2016
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd); cd "$root"
test "$(find . -maxdepth 1 -type f | wc -l)" -eq 14
bash -n dormant-rollout.sh dormant-rollback.sh failure-diagnostics.sh test-package.sh
if command -v shellcheck >/dev/null; then shellcheck -x dormant-rollout.sh dormant-rollback.sh failure-diagnostics.sh test-package.sh; fi
sha256sum -c SHA256SUMS; test "$(wc -l < SHA256SUMS)" -eq 13
jq -e '.stage=="8B2B" and (.files|length)==14 and .status=="PREPARED_NOT_EXECUTED"' MANIFEST.json >/dev/null
grep -Fq 'pull_policy: never' dormant-gateway.compose.yml; grep -Fq 'internal: true' dormant-gateway.compose.yml
grep -Fq 'ports: []' dormant-gateway.compose.yml; grep -Fq 'volumes: []' dormant-gateway.compose.yml
grep -Fq 'user: "1000:1000"' dormant-gateway.compose.yml; grep -Fq 'read_only: true' dormant-gateway.compose.yml
for flag in MAX_RAW_JOURNAL_ENABLED MAX_INBOUND_NORMALIZER_ENABLED MAX_SHADOW_COMPARISON_ENABLED MAX_PERSONAL_LIVE_CAPTURE_ENABLED; do grep -Fq "$flag: \"\"" dormant-gateway.compose.yml; done
if rg -n '(MAX_PERSONAL_GATEWAY_DATABASE_URL|MAX_PERSONAL_CAPTURE_HMAC_KEYS_JSON|MAX_PERSONAL_GATEWAY_BROWSER_OWNER|MAX_PERSONAL_GATEWAY_CHROMIUM_PROFILE_PATH)' dormant-gateway.compose.yml; then exit 1; fi
if rg -n '(ports:[[:space:]]*$|-[[:space:]]*["'\'']?[0-9]+:|/app/user_data|crm_internal|docker (system|volume|network) prune)' dormant-gateway.compose.yml dormant-rollout.sh dormant-rollback.sh; then exit 1; fi
if grep -Eq '^[[:space:]]+image: [^@]+:[A-Za-z0-9._-]+$' dormant-gateway.compose.yml; then exit 1; fi
if rg -n '(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})' .; then exit 1; fi
printf 'PHASE_C_PACKAGE_PASS\n'
