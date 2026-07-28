#!/usr/bin/env bash
# shellcheck disable=SC2016
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd); cd "$root"
test "$(find . -maxdepth 1 -type f | wc -l)" -eq 9
bash -n test-package.sh
if command -v shellcheck >/dev/null; then shellcheck test-package.sh; fi
sha256sum -c SHA256SUMS; test "$(wc -l < SHA256SUMS)" -eq 8
jq -e '.stage=="8B2C" and .status=="SCRAPER_DEFAULT_OFF_PACKAGE_BLOCKED" and (.files|length)==9' MANIFEST.json >/dev/null
jq -e '.decision=="SCRAPER_DEFAULT_OFF_PACKAGE_BLOCKED" and .currentProduction.runtimeUidGid=="1000:1000" and .acceptedImage.runtimeUidGid=="1001:1001" and .currentProduction.browserProcessCount=="UNKNOWN_NOT_ZERO" and (.blockingMismatches|length)>=6 and .productionMutationPerformed==false' runtime-evidence.json >/dev/null
test ! -e rollout.sh; test ! -e rollback.sh
grep -Fq 'no rollout script' blockers.md; grep -Fq 'UID/GID `1000:1000`' accepted-image-compatibility.md
if rg -n '(POSTGRES_PASSWORD|DATABASE_URL=|MAX_PERSONAL_CAPTURE_HMAC_SECRET=|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|ghp_[A-Za-z0-9]{20,})' . --glob '!test-package.sh'; then exit 1; fi
printf 'PHASE_D_BLOCKER_PACKAGE_PASS\n'
