#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

EXPECTED_REPOSITORY='nashavtoparkmedia-byte/CRM'
EXPECTED_BRANCH='feature/personal-max-stage8b1r-release-hardening-20260727T205938Z'
TAG='stage8b1r-20260727t205938z'
GATEWAY_REPOSITORY='ghcr.io/nashavtoparkmedia-byte/crm-max-personal-gateway'
SCRAPER_REPOSITORY='ghcr.io/nashavtoparkmedia-byte/crm-max-web-scraper'
POSTGRES_IMAGE='postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'
GATEWAY_BASE='node:22.22.2-alpine3.23@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f'
SCRAPER_BASE='mcr.microsoft.com/playwright:v1.62.0-noble@sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07'
SYFT_VERSION='1.49.0'
GRYPE_VERSION='0.116.0'
TRIVY_VERSION='0.72.0'
SYFT_ARCHIVE_SHA256='7aa2f03ee92739cf643279ba3990548b9925d4e22cae13f46831ee62821147fe'
GRYPE_ARCHIVE_SHA256='40aff724297312f91ea390d003bed8d8651c74cc7f5b26732db80b3a408d2fc5'
TRIVY_ARCHIVE_SHA256='bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea'
OUT="$PWD/stage8b1r-evidence"
TOOLS="${RUNNER_TEMP:?RUNNER_TEMP is required}/stage8b1r-tools"
NETWORK='max-stage8b1r-ci-internal'
PG_VOLUME='max-stage8b1r-ci-postgres'
SPOOL_VOLUME='max-stage8b1r-ci-spool'
PG_CONTAINER='max-stage8b1r-ci-postgres'
DORMANT_CONTAINER='max-stage8b1r-ci-gateway-dormant'
ACTIVE_CONTAINER='max-stage8b1r-ci-gateway-active'
SCRAPER_PROBE_CONTAINER='max-stage8b1r-ci-scraper-probe'
SYNTHETIC_ACCOUNT='stage8b1r'
SYNTHETIC_HMAC_KEY_ID='stage8b1r-ci'
SYNTHETIC_HMAC_SECRET='stage8b1r-ci-only-secret-00000000000000000000000000000000'

require_exact_context() {
  test "${GITHUB_REPOSITORY:?}" = "$EXPECTED_REPOSITORY"
  test "${GITHUB_REF_NAME:?}" = "$EXPECTED_BRANCH"
  test "$(git rev-parse HEAD)" = "${GITHUB_SHA:?}"
  test -n "${GHCR_TOKEN:?}"
  test -z "$(git status --porcelain=v1 --untracked-files=all)"
}

cleanup() {
  docker rm -f "$DORMANT_CONTAINER" "$ACTIVE_CONTAINER" "$SCRAPER_PROBE_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker volume rm "$PG_VOLUME" "$SPOOL_VOLUME" >/dev/null 2>&1 || true
}

write_checksums() {
  if [[ -d "$OUT" ]]; then
    rm -f -- "$OUT/SHA256SUMS"
    if compgen -G "$OUT/*" >/dev/null; then
      (cd "$OUT" && sha256sum -- * > SHA256SUMS && sha256sum -c SHA256SUMS)
    fi
  fi
}

on_exit() {
  local status=$?
  trap - EXIT
  set +e
  write_checksums
  cleanup
  exit "$status"
}
trap on_exit EXIT

download_anchore_tool() {
  local name=$1 version=$2 expected_sha=$3 archive base
  archive="${name}_${version}_linux_amd64.tar.gz"
  base="https://github.com/anchore/${name}/releases/download/v${version}"
  curl --retry 3 --retry-all-errors -fsSL --proto '=https' --tlsv1.2 -o "$TOOLS/$archive" "$base/$archive"
  (cd "$TOOLS" && printf '%s  %s\n' "$expected_sha" "$archive" | sha256sum -c -)
  tar -xzf "$TOOLS/$archive" -C "$TOOLS" "$name"
}

download_trivy() {
  local archive='trivy_0.72.0_Linux-64bit.tar.gz'
  local base="https://github.com/aquasecurity/trivy/releases/download/v$TRIVY_VERSION"
  curl --retry 3 --retry-all-errors -fsSL --proto '=https' --tlsv1.2 -o "$TOOLS/$archive" "$base/$archive"
  (cd "$TOOLS" && printf '%s  %s\n' "$TRIVY_ARCHIVE_SHA256" "$archive" | sha256sum -c -)
  tar -xzf "$TOOLS/$archive" -C "$TOOLS" trivy
}

audit_lock() {
  local name=$1 directory=$2 omit_dev=$3
  local -a args=(audit --package-lock-only --json)
  if [[ "$omit_dev" == true ]]; then args+=(--omit=dev); fi
  (cd "$directory" && npm "${args[@]}") >"$OUT/$name.json"
  jq -e '.metadata.vulnerabilities | .low == 0 and .moderate == 0 and .high == 0 and .critical == 0 and .total == 0' "$OUT/$name.json" >/dev/null
}

wait_for_postgres() {
  for _ in $(seq 1 60); do
    if docker exec "$PG_CONTAINER" pg_isready -U stage8b1r -d stage8b1r >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

container_http_status() {
  local container=$1 path=$2 expected=$3
  docker exec "$container" node -e \
    "fetch('http://127.0.0.1:8080${path}',{signal:AbortSignal.timeout(10000)}).then(r=>{if(r.status!==${expected})process.exit(1);return r.json()}).then(v=>process.stdout.write(JSON.stringify(v)))"
}

start_active_gateway() {
  docker run -d --name "$ACTIVE_CONTAINER" --network "$NETWORK" \
    -e MAX_RAW_JOURNAL_ENABLED="$SYNTHETIC_ACCOUNT" \
    -e MAX_PERSONAL_LIVE_CAPTURE_ENABLED="$SYNTHETIC_ACCOUNT" \
    -e MAX_PERSONAL_GATEWAY_DATABASE_URL="$DATABASE_URL" \
    -e MAX_PERSONAL_CAPTURE_HMAC_KEYS_JSON="{\"$SYNTHETIC_HMAC_KEY_ID\":\"$SYNTHETIC_HMAC_SECRET\"}" \
    -e MAX_PERSONAL_GATEWAY_BIND_HOST=0.0.0.0 \
    -e MAX_PERSONAL_GATEWAY_PRIVATE_NETWORK=required \
    "$GATEWAY_REF" >/dev/null
}

scan_image() {
  local name=$1 ref=$2 base=$3 image_id architecture config_user provenance
  image_id=$(docker image inspect --format '{{.Id}}' "$ref")
  architecture=$(docker image inspect --format '{{.Architecture}}' "$ref")
  config_user=$(docker image inspect --format '{{.Config.User}}' "$ref")
  env -u GHCR_TOKEN SYFT_CHECK_FOR_APP_UPDATE=false "$TOOLS/syft" scan "docker:$ref" \
    -o "spdx-json=$OUT/$name.spdx.json" \
    -o "cyclonedx-json=$OUT/$name.cdx.json"
  provenance=$(jq -nc --arg sourceCommit "$GITHUB_SHA" --arg buildTimestamp "$BUILD_TIMESTAMP" --arg architecture "$architecture" --arg baseImage "$base" --arg imageId "$image_id" --arg configUser "$config_user" \
    '{sourceCommit:$sourceCommit,buildTimestamp:$buildTimestamp,architecture:$architecture,baseImage:$baseImage,imageId:$imageId,configUser:$configUser}')
  jq --argjson provenance "$provenance" '.annotations = ((.annotations // []) + [{annotationType:"OTHER",annotator:"Tool: personal-max-stage8b1r-proof",annotationDate:$provenance.buildTimestamp,comment:($provenance|tojson)}])' \
    "$OUT/$name.spdx.json" >"$OUT/$name.spdx.tmp" && mv "$OUT/$name.spdx.tmp" "$OUT/$name.spdx.json"
  jq --arg sourceCommit "$GITHUB_SHA" --arg buildTimestamp "$BUILD_TIMESTAMP" --arg architecture "$architecture" --arg baseImage "$base" --arg imageId "$image_id" --arg configUser "$config_user" \
    '.metadata.properties = ((.metadata.properties // []) + [
      {name:"personal-max:source-commit",value:$sourceCommit},
      {name:"personal-max:build-timestamp",value:$buildTimestamp},
      {name:"personal-max:architecture",value:$architecture},
      {name:"personal-max:base-image",value:$baseImage},
      {name:"personal-max:image-id",value:$imageId},
      {name:"personal-max:config-user",value:$configUser}
    ])' "$OUT/$name.cdx.json" >"$OUT/$name.cdx.tmp" && mv "$OUT/$name.cdx.tmp" "$OUT/$name.cdx.json"
  jq -e --arg base "$base" --arg commit "$GITHUB_SHA" \
    '.spdxVersion == "SPDX-2.3" and (.packages|length) > 0 and any(.annotations[]?; (.comment|contains($base)) and (.comment|contains($commit)))' \
    "$OUT/$name.spdx.json" >/dev/null
  jq -e --arg base "$base" --arg commit "$GITHUB_SHA" \
    '.bomFormat == "CycloneDX" and (.components|length) > 0 and any(.metadata.properties[]?; .name=="personal-max:base-image" and .value==$base) and any(.metadata.properties[]?; .name=="personal-max:source-commit" and .value==$commit)' \
    "$OUT/$name.cdx.json" >/dev/null
  env -u GHCR_TOKEN GRYPE_CHECK_FOR_APP_UPDATE=false GRYPE_DB_CACHE_DIR="$RUNNER_TEMP/stage8b1r-grype-db" \
    "$TOOLS/grype" "sbom:$OUT/$name.cdx.json" -o json --file "$OUT/$name.grype.json"
  env -u GHCR_TOKEN TRIVY_CACHE_DIR="$RUNNER_TEMP/stage8b1r-trivy-cache" \
    "$TOOLS/trivy" image --scanners vuln,secret --format json --output "$OUT/$name.trivy.json" "$ref"
  jq -n --arg name "$name" --arg ref "$ref" --arg base "$base" --arg imageId "$image_id" --arg architecture "$architecture" \
    --argjson spdxPackages "$(jq '.packages|length' "$OUT/$name.spdx.json")" --argjson cdxComponents "$(jq '.components|length' "$OUT/$name.cdx.json")" \
    '{image:$name,ref:$ref,baseImage:$base,imageId:$imageId,architecture:$architecture,spdxPackages:$spdxPackages,cycloneDxComponents:$cdxComponents,requiredMetadataValidated:true}' \
    >"$OUT/$name.sbom-validation.json"
}

write_vulnerability_forensic() {
  local name=$1 direct_packages
  if [[ "$name" == gateway ]]; then
    direct_packages=$(jq -c '.dependencies|keys' max-personal-gateway/package.json)
  else
    direct_packages=$(jq -c '.dependencies|keys' max-web-scraper/package.json)
  fi
  jq --argjson directPackages "$direct_packages" '[.matches[] | select(.vulnerability.severity|IN("Low","Medium","Moderate","High","Critical")) | {
      scanner:"grype",package:.artifact.name,installedVersion:.artifact.version,advisoryId:.vulnerability.id,
      severity:(if .vulnerability.severity=="Medium" then "MODERATE" else (.vulnerability.severity|ascii_upcase) end),
      cvss:(.vulnerability.cvss//[]),directOrTransitive:(.artifact.name as $package | if .artifact.type=="npm" then (if $directPackages|index($package) then "direct" else "transitive" end) else "base-image-runtime-package" end),
      dependencyPath:(if .artifact.type=="npm" then (([.artifact.locations[]?.path]|unique)|join(",")) else "base image OS/runtime package" end),
      productionOrDevOnly:"production-runtime-image",presentInFinalRuntimeImage:true,
      stage8B2CodePathReachability:"runtime-present; advisory-specific reachability requires review for any remaining HIGH",
      exploitPrerequisites:(.vulnerability.description//"see advisory data source"),fixedVersion:(.vulnerability.fix.versions//[]),
      fixAvailable:((.vulnerability.fix.state//"unknown")=="fixed"),breakingChangeRisk:(if (.vulnerability.fix.state//"")=="fixed" then "compatibility review required" else "no supported fix reported" end),
      recommendedAction:(if .vulnerability.severity=="Critical" then "BLOCK_RELEASE" elif .vulnerability.severity=="High" and (.vulnerability.fix.state//"")=="fixed" then "REMEDIATE_BEFORE_RELEASE" elif .vulnerability.severity=="High" then "SECURITY_ACCEPTANCE_REQUIRED" else "TRACK_AND_REVIEW" end),
      dataSource:(.vulnerability.dataSource//null)
    }]' "$OUT/$name.grype.json" >"$OUT/$name.grype-findings.json"
  jq '[.Results[]? as $result | $result.Vulnerabilities[]? | select(.Severity|IN("LOW","MEDIUM","HIGH","CRITICAL")) | {
      scanner:"trivy",package:.PkgName,installedVersion:.InstalledVersion,advisoryId:.VulnerabilityID,
      severity:(if .Severity=="MEDIUM" then "MODERATE" else .Severity end),cvss:(.CVSS//{}),
      directOrTransitive:(if (.PkgPath//"")|contains("node_modules") then "resolved from exact npm lock evidence" else "base-image-runtime-package" end),
      dependencyPath:($result.Target+":"+(.PkgPath//.PkgName)),productionOrDevOnly:"production-runtime-image",presentInFinalRuntimeImage:true,
      stage8B2CodePathReachability:"runtime-present; advisory-specific reachability requires review for any remaining HIGH",
      exploitPrerequisites:(.Description//"see advisory data source"),fixedVersion:(if (.FixedVersion//"")=="" then [] else [.FixedVersion] end),
      fixAvailable:((.FixedVersion//"")!=""),breakingChangeRisk:(if (.FixedVersion//"")!="" then "compatibility review required" else "no supported fix reported" end),
      recommendedAction:(if .Severity=="CRITICAL" then "BLOCK_RELEASE" elif .Severity=="HIGH" and (.FixedVersion//"")!="" then "REMEDIATE_BEFORE_RELEASE" elif .Severity=="HIGH" then "SECURITY_ACCEPTANCE_REQUIRED" else "TRACK_AND_REVIEW" end),
      dataSource:(.PrimaryURL//null)
    }]' "$OUT/$name.trivy.json" >"$OUT/$name.trivy-findings.json"
  jq -s --arg image "$name" '{schemaVersion:1,image:$image,findings:(.[0]+.[1])}' "$OUT/$name.grype-findings.json" "$OUT/$name.trivy-findings.json" >"$OUT/$name.vulnerability-forensic.json"
}

security_counts() {
  local name=$1
  jq -n \
    --argjson grypeCritical "$(jq '[.matches[]|select(.vulnerability.severity=="Critical")]|length' "$OUT/$name.grype.json")" \
    --argjson grypeFixableHigh "$(jq '[.matches[]|select(.vulnerability.severity=="High" and .vulnerability.fix.state=="fixed")]|length' "$OUT/$name.grype.json")" \
    --argjson grypeUnfixedHigh "$(jq '[.matches[]|select(.vulnerability.severity=="High" and .vulnerability.fix.state!="fixed")]|length' "$OUT/$name.grype.json")" \
    --argjson trivyCritical "$(jq '[.Results[]?.Vulnerabilities[]?|select(.Severity=="CRITICAL")]|length' "$OUT/$name.trivy.json")" \
    --argjson trivyFixableHigh "$(jq '[.Results[]?.Vulnerabilities[]?|select(.Severity=="HIGH" and (.FixedVersion//"")!="")]|length' "$OUT/$name.trivy.json")" \
    --argjson trivyUnfixedHigh "$(jq '[.Results[]?.Vulnerabilities[]?|select(.Severity=="HIGH" and (.FixedVersion//"")=="")]|length' "$OUT/$name.trivy.json")" \
    --argjson secrets "$(jq '[.Results[]?.Secrets[]?]|length' "$OUT/$name.trivy.json")" \
    '{grypeCritical:$grypeCritical,grypeFixableHigh:$grypeFixableHigh,grypeUnfixedHigh:$grypeUnfixedHigh,trivyCritical:$trivyCritical,trivyFixableHigh:$trivyFixableHigh,trivyUnfixedHigh:$trivyUnfixedHigh,secrets:$secrets}'
}

require_exact_context
rm -rf -- "$OUT" "$TOOLS"
mkdir -p "$OUT" "$TOOLS"
cleanup

audit_lock gateway-source-audit max-personal-gateway false
audit_lock gateway-runtime-audit max-personal-gateway true
audit_lock scraper-source-audit max-web-scraper false
audit_lock scraper-runtime-audit max-web-scraper true

BUILD_TIMESTAMP=$(git show -s --format=%cI "$GITHUB_SHA")
GATEWAY_REF="$GATEWAY_REPOSITORY:$TAG"
SCRAPER_REF="$SCRAPER_REPOSITORY:$TAG"

docker build --pull \
  --build-arg "SOURCE_COMMIT=$GITHUB_SHA" --build-arg "BUILD_TIMESTAMP=$BUILD_TIMESTAMP" \
  -f max-personal-gateway/Dockerfile -t "$GATEWAY_REF" .
docker build --pull \
  --build-arg "SOURCE_COMMIT=$GITHUB_SHA" --build-arg "BUILD_TIMESTAMP=$BUILD_TIMESTAMP" \
  -f max-web-scraper/Dockerfile -t "$SCRAPER_REF" max-web-scraper

GATEWAY_LOCAL_ID=$(docker image inspect --format '{{.Id}}' "$GATEWAY_REF")
SCRAPER_LOCAL_ID=$(docker image inspect --format '{{.Id}}' "$SCRAPER_REF")
GATEWAY_CONFIG_USER=$(docker image inspect --format '{{.Config.User}}' "$GATEWAY_REF")
SCRAPER_CONFIG_USER=$(docker image inspect --format '{{.Config.User}}' "$SCRAPER_REF")
GATEWAY_RUNTIME_ID=$(docker run --rm --network none --entrypoint node "$GATEWAY_REF" -e 'process.stdout.write(`${process.getuid()}:${process.getgid()}`)')
SCRAPER_RUNTIME_ID=$(docker run --rm --network none --entrypoint node "$SCRAPER_REF" -e 'process.stdout.write(`${process.getuid()}:${process.getgid()}`)')
test "$GATEWAY_RUNTIME_ID" = '1000:1000'
test "$SCRAPER_RUNTIME_ID" = '1001:1001'

docker run -d --name "$DORMANT_CONTAINER" --network none "$GATEWAY_REF" >/dev/null
sleep 2
container_http_status "$DORMANT_CONTAINER" /health 200 >"$OUT/gateway-dormant-health.json"
container_http_status "$DORMANT_CONTAINER" /ready 200 >"$OUT/gateway-dormant-ready.json"
docker rm -f "$DORMANT_CONTAINER" >/dev/null

if timeout 20 docker run --rm --network none \
  -e MAX_RAW_JOURNAL_ENABLED="$SYNTHETIC_ACCOUNT" "$GATEWAY_REF" >"$OUT/gateway-invalid-config.log" 2>&1; then
  echo 'invalid gateway configuration unexpectedly started' >&2
  exit 1
elif test "$?" -eq 124; then
  echo 'invalid gateway configuration did not fail closed within timeout' >&2
  exit 1
fi

docker network create --internal "$NETWORK" >/dev/null
docker network inspect "$NETWORK" | jq -e '.[0].Internal == true' >"$OUT/internal-network-proof.json"
docker volume create "$PG_VOLUME" >/dev/null
docker volume create "$SPOOL_VOLUME" >/dev/null
docker run -d --name "$PG_CONTAINER" --network "$NETWORK" \
  -e POSTGRES_USER=stage8b1r -e POSTGRES_PASSWORD=stage8b1r-synthetic-only -e POSTGRES_DB=stage8b1r \
  -v "$PG_VOLUME:/var/lib/postgresql/data" "$POSTGRES_IMAGE" >/dev/null
wait_for_postgres

DATABASE_URL='postgresql://stage8b1r:stage8b1r-synthetic-only@max-stage8b1r-ci-postgres:5432/stage8b1r?schema=public'
docker run --rm --network "$NETWORK" -e DATABASE_URL="$DATABASE_URL" --entrypoint sh "$GATEWAY_REF" \
  -c 'exec npx prisma migrate deploy --schema /app/prisma/schema.prisma' >"$OUT/migration.log"

start_active_gateway
sleep 2
docker inspect "$ACTIVE_CONTAINER" | jq -e '.[0].HostConfig.PortBindings == null or (.[0].HostConfig.PortBindings|length)==0' >"$OUT/no-public-port-proof.json"
container_http_status "$ACTIVE_CONTAINER" /health 200 >"$OUT/gateway-active-health-before-capture.json"
container_http_status "$ACTIVE_CONTAINER" /ready 503 >"$OUT/gateway-active-ready-before-capture.json"

docker run --rm --network none --entrypoint node "$GATEWAY_REF" -e \
  "for(const p of ['playwright','puppeteer']){try{require.resolve(p);process.exit(1)}catch{}}"
docker run --rm --user 0:0 --network none -v "$SPOOL_VOLUME:/spool" --entrypoint sh "$SCRAPER_REF" \
  -c 'chown 1001:1001 /spool && chmod 0700 /spool'
docker run -d --name "$SCRAPER_PROBE_CONTAINER" --network "$NETWORK" \
  -e MAX_PERSONAL_ACCOUNT_ID="$SYNTHETIC_ACCOUNT" \
  -e MAX_PERSONAL_LIVE_CAPTURE_ENABLED="$SYNTHETIC_ACCOUNT" \
  -e MAX_PERSONAL_CAPTURE_SPOOL_PATH=/spool \
  -e MAX_PERSONAL_CAPTURE_INGRESS_URL=http://max-stage8b1r-ci-gateway-active:8080/v1/capture \
  -e MAX_PERSONAL_CAPTURE_HMAC_KEY_ID="$SYNTHETIC_HMAC_KEY_ID" \
  -e MAX_PERSONAL_CAPTURE_HMAC_SECRET="$SYNTHETIC_HMAC_SECRET" \
  -e STAGE8B1R_HOLD_MS=5000 \
  -v "$SPOOL_VOLUME:/spool" \
  -v "$PWD/release/personal-max-stage8b1r/executable/synthetic-scraper-harness.js:/tmp/synthetic-scraper-harness.js:ro" \
  --entrypoint node "$SCRAPER_REF" /tmp/synthetic-scraper-harness.js >/dev/null
sleep 1
docker inspect "$SCRAPER_PROBE_CONTAINER" | jq -e '.[0].HostConfig.PortBindings == null or (.[0].HostConfig.PortBindings|length)==0' >/dev/null
docker top "$SCRAPER_PROBE_CONTAINER" -eo comm >"$OUT/scraper-processes.txt"
if grep -Eiq '(^|/)(chromium|chrome|chrome_crashpad|headless_shell)( |$)' "$OUT/scraper-processes.txt"; then
  echo 'browser process observed in synthetic scraper proof' >&2
  exit 1
fi
test "$(docker wait "$SCRAPER_PROBE_CONTAINER")" -eq 0
docker logs "$SCRAPER_PROBE_CONTAINER" >"$OUT/scraper-synthetic.json"
docker rm "$SCRAPER_PROBE_CONTAINER" >/dev/null
container_http_status "$ACTIVE_CONTAINER" /ready 200 >"$OUT/gateway-active-ready-after-capture.json"

docker rm -f "$ACTIVE_CONTAINER" >/dev/null
docker run --rm --network "$NETWORK" \
  -e MAX_PERSONAL_ACCOUNT_ID="$SYNTHETIC_ACCOUNT" \
  -e MAX_PERSONAL_LIVE_CAPTURE_ENABLED="$SYNTHETIC_ACCOUNT" \
  -e MAX_PERSONAL_CAPTURE_SPOOL_PATH=/spool \
  -e MAX_PERSONAL_CAPTURE_INGRESS_URL=http://max-stage8b1r-ci-gateway-active:8080/v1/capture \
  -e MAX_PERSONAL_CAPTURE_HMAC_KEY_ID="$SYNTHETIC_HMAC_KEY_ID" \
  -e MAX_PERSONAL_CAPTURE_HMAC_SECRET="$SYNTHETIC_HMAC_SECRET" \
  -e STAGE8B1R_CAPTURE_ONLY=1 \
  -v "$SPOOL_VOLUME:/spool" \
  -v "$PWD/release/personal-max-stage8b1r/executable/synthetic-scraper-harness.js:/tmp/synthetic-scraper-harness.js:ro" \
  --entrypoint node "$SCRAPER_REF" /tmp/synthetic-scraper-harness.js >"$OUT/scraper-outage-capture.json"
start_active_gateway
sleep 2
docker run --rm --network "$NETWORK" \
  -e MAX_PERSONAL_ACCOUNT_ID="$SYNTHETIC_ACCOUNT" \
  -e MAX_PERSONAL_LIVE_CAPTURE_ENABLED="$SYNTHETIC_ACCOUNT" \
  -e MAX_PERSONAL_CAPTURE_SPOOL_PATH=/spool \
  -e MAX_PERSONAL_CAPTURE_INGRESS_URL=http://max-stage8b1r-ci-gateway-active:8080/v1/capture \
  -e MAX_PERSONAL_CAPTURE_HMAC_KEY_ID="$SYNTHETIC_HMAC_KEY_ID" \
  -e MAX_PERSONAL_CAPTURE_HMAC_SECRET="$SYNTHETIC_HMAC_SECRET" \
  -e STAGE8B1R_DRAIN_ONLY=1 \
  -v "$SPOOL_VOLUME:/spool" \
  -v "$PWD/release/personal-max-stage8b1r/executable/synthetic-scraper-harness.js:/tmp/synthetic-scraper-harness.js:ro" \
  --entrypoint node "$SCRAPER_REF" /tmp/synthetic-scraper-harness.js >"$OUT/scraper-recovery-drain.json"
container_http_status "$ACTIVE_CONTAINER" /ready 200 >"$OUT/gateway-active-ready-after-restart.json"

download_anchore_tool syft "$SYFT_VERSION" "$SYFT_ARCHIVE_SHA256"
download_anchore_tool grype "$GRYPE_VERSION" "$GRYPE_ARCHIVE_SHA256"
download_trivy
chmod 700 "$TOOLS/syft" "$TOOLS/grype" "$TOOLS/trivy"
env -u GHCR_TOKEN "$TOOLS/syft" version >"$OUT/syft-version.txt"
env -u GHCR_TOKEN "$TOOLS/grype" version >"$OUT/grype-version.txt"
env -u GHCR_TOKEN "$TOOLS/trivy" --version >"$OUT/trivy-version.txt"
scan_image gateway "$GATEWAY_REF" "$GATEWAY_BASE"
scan_image scraper "$SCRAPER_REF" "$SCRAPER_BASE"
write_vulnerability_forensic gateway
write_vulnerability_forensic scraper
GATEWAY_SECURITY=$(security_counts gateway)
SCRAPER_SECURITY=$(security_counts scraper)
printf '%s\n' "$GATEWAY_SECURITY" >"$OUT/gateway-security-counts.json"
printf '%s\n' "$SCRAPER_SECURITY" >"$OUT/scraper-security-counts.json"

SECURITY_POLICY=$(jq -n --argjson gateway "$GATEWAY_SECURITY" --argjson scraper "$SCRAPER_SECURITY" \
  '{gateway:$gateway,scraper:$scraper,totals:{critical:($gateway.grypeCritical+$gateway.trivyCritical+$scraper.grypeCritical+$scraper.trivyCritical),fixableHigh:($gateway.grypeFixableHigh+$gateway.trivyFixableHigh+$scraper.grypeFixableHigh+$scraper.trivyFixableHigh),unfixedHigh:($gateway.grypeUnfixedHigh+$gateway.trivyUnfixedHigh+$scraper.grypeUnfixedHigh+$scraper.trivyUnfixedHigh),secrets:($gateway.secrets+$scraper.secrets)}}')
printf '%s\n' "$SECURITY_POLICY" >"$OUT/security-policy.json"
if [[ $(jq -r '.totals.critical' <<<"$SECURITY_POLICY") -ne 0 || $(jq -r '.totals.fixableHigh' <<<"$SECURITY_POLICY") -ne 0 || $(jq -r '.totals.secrets' <<<"$SECURITY_POLICY") -ne 0 ]]; then
  echo 'RELEASE_SECURITY_POLICY_FAILED: runtime Critical, fixable High, or image secret remains' >&2
  exit 41
fi
if [[ $(jq -r '.totals.unfixedHigh' <<<"$SECURITY_POLICY") -ne 0 ]]; then
  jq -s '{status:"SECURITY_ACCEPTANCE_REQUIRED",reason:"One or more runtime HIGH findings have no scanner-reported fix; Codex does not accept this risk",findings:([.[].findings[]|select(.severity=="HIGH" and .fixAvailable==false)])}' \
    "$OUT/gateway.vulnerability-forensic.json" "$OUT/scraper.vulnerability-forensic.json" >"$OUT/SECURITY_ACCEPTANCE_REQUIRED.json"
  echo 'SECURITY_ACCEPTANCE_REQUIRED' >&2
  exit 42
fi

printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin >/dev/null
push_or_reuse_exact_tag() {
  local ref=$1 local_id=$2 remote_manifest remote_config
  if remote_manifest=$(docker manifest inspect "$ref" 2>/dev/null); then
    remote_config=$(jq -er '.config.digest' <<<"$remote_manifest")
    if [[ "$remote_config" != "$local_id" ]]; then
      echo "refusing mismatched existing immutable tag: $ref" >&2
      return 1
    fi
    printf 'reused exact existing tag %s config %s\n' "$ref" "$remote_config"
  else
    docker push "$ref"
  fi
}
push_or_reuse_exact_tag "$GATEWAY_REF" "$GATEWAY_LOCAL_ID" >"$OUT/gateway-publish.log"
push_or_reuse_exact_tag "$SCRAPER_REF" "$SCRAPER_LOCAL_ID" >"$OUT/scraper-publish.log"

docker rm -f "$ACTIVE_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1 || true
docker pull "$GATEWAY_REF" >/dev/null
docker pull "$SCRAPER_REF" >/dev/null
GATEWAY_TAG_PULLED_ID=$(docker image inspect --format '{{.Id}}' "$GATEWAY_REF")
SCRAPER_TAG_PULLED_ID=$(docker image inspect --format '{{.Id}}' "$SCRAPER_REF")
test "$GATEWAY_TAG_PULLED_ID" = "$GATEWAY_LOCAL_ID"
test "$SCRAPER_TAG_PULLED_ID" = "$SCRAPER_LOCAL_ID"
GATEWAY_DIGEST=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$GATEWAY_REF" | awk -v prefix="$GATEWAY_REPOSITORY@" 'index($0,prefix)==1{sub(prefix,"");print;exit}')
SCRAPER_DIGEST=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$SCRAPER_REF" | awk -v prefix="$SCRAPER_REPOSITORY@" 'index($0,prefix)==1{sub(prefix,"");print;exit}')
[[ "$GATEWAY_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "$SCRAPER_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]
docker image rm "$GATEWAY_REF" "$SCRAPER_REF" >/dev/null
docker pull "$GATEWAY_REPOSITORY@$GATEWAY_DIGEST" >/dev/null
docker pull "$SCRAPER_REPOSITORY@$SCRAPER_DIGEST" >/dev/null
GATEWAY_PULLED_ID=$(docker image inspect --format '{{.Id}}' "$GATEWAY_REPOSITORY@$GATEWAY_DIGEST")
SCRAPER_PULLED_ID=$(docker image inspect --format '{{.Id}}' "$SCRAPER_REPOSITORY@$SCRAPER_DIGEST")
test "$GATEWAY_PULLED_ID" = "$GATEWAY_LOCAL_ID"
test "$SCRAPER_PULLED_ID" = "$SCRAPER_LOCAL_ID"

jq -n \
  --arg sourceCommit "$GITHUB_SHA" --arg buildTimestamp "$BUILD_TIMESTAMP" \
  --arg gatewayRef "$GATEWAY_REPOSITORY@$GATEWAY_DIGEST" --arg gatewayTag "$GATEWAY_REF" \
  --arg gatewayImageId "$GATEWAY_LOCAL_ID" --arg gatewayConfigUser "$GATEWAY_CONFIG_USER" --arg gatewayRuntimeId "$GATEWAY_RUNTIME_ID" \
  --arg scraperRef "$SCRAPER_REPOSITORY@$SCRAPER_DIGEST" --arg scraperTag "$SCRAPER_REF" \
  --arg scraperImageId "$SCRAPER_LOCAL_ID" --arg scraperConfigUser "$SCRAPER_CONFIG_USER" --arg scraperRuntimeId "$SCRAPER_RUNTIME_ID" \
  --argjson gatewaySecurity "$GATEWAY_SECURITY" --argjson scraperSecurity "$SCRAPER_SECURITY" \
  '{schemaVersion:1,sourceCommit:$sourceCommit,buildTimestamp:$buildTimestamp,architecture:"linux/amd64",distribution:"GHCR_BY_DIGEST",gateway:{tag:$gatewayTag,ref:$gatewayRef,imageId:$gatewayImageId,configUser:$gatewayConfigUser,runtimeUidGid:$gatewayRuntimeId,security:$gatewaySecurity},scraper:{tag:$scraperTag,ref:$scraperRef,imageId:$scraperImageId,configUser:$scraperConfigUser,runtimeUidGid:$scraperRuntimeId,security:$scraperSecurity},executableProof:{dormant:true,invalidConfigFailsClosed:true,activeSynthetic:true,actualHook:true,internalNetworkOnly:true,publicPorts:0,browserProcessList:"scraper-processes.txt",browserLaunched:false,providerContact:false,pullByDigest:true}}' \
  >"$OUT/final-image-manifest.json"

printf "sudo /opt/codex-work/crm-personal-max-stage8b1r-release-hardening-20260727T205938Z/release/personal-max-stage8b1r/root-preflight/probe-isolated-images.sh '%s@%s' '%s@%s'\n" \
  "$GATEWAY_REPOSITORY" "$GATEWAY_DIGEST" "$SCRAPER_REPOSITORY" "$SCRAPER_DIGEST" \
  >"$OUT/owner-isolated-probe-command.txt"

write_checksums
printf 'STAGE8B1R_EVIDENCE %s\n' "$(jq -c . "$OUT/final-image-manifest.json")"
printf 'STAGE8B1R_CHECKSUMS %s\n' "$(sha256sum "$OUT/SHA256SUMS" | awk '{print $1}')"
