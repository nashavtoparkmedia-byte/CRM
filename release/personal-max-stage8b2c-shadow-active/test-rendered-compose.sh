#!/usr/bin/env bash
set -Eeuo pipefail

[[ $# -eq 1 && -f $1 ]]
readonly rendered=$1
readonly scraper='ghcr.io/nashavtoparkmedia-byte/crm-max-web-scraper@sha256:e8a6fa389e187129664bc8b66ad883d6ec15308a2d837ee9ab1a7baec89aa43b'
readonly gateway='ghcr.io/nashavtoparkmedia-byte/crm-max-personal-gateway@sha256:669172fc4ac650e7bffa5c8095b812526f337c75c2811cde747d318d320eddd0'

jq -e --arg scraper "$scraper" --arg gateway "$gateway" '
  .services["max-web-scraper"] as $s
  | .services["max-personal-gateway"] as $g
  | $s.image == $scraper
  and $s.user == "1000:1000"
  and ([ $s.volumes[] | select(.target == "/app/user_data" and .type == "volume") ] | length) == 1
  and ([ $s.volumes[] | select(.source == "/var/lib/crm/max-personal-media" and .target == "/app/media_storage" and .type == "bind") ] | length) == 1
  and ([ $s.volumes[] | select(.source == "/var/lib/crm/max-personal-capture" and .target == "/var/lib/max-personal-capture" and .type == "bind") ] | length) == 1
  and ($s.environment.MAX_PERSONAL_ACCOUNT_ID | length) > 0
  and $s.environment.MAX_PERSONAL_LIVE_CAPTURE_ENABLED == $s.environment.MAX_PERSONAL_ACCOUNT_ID
  and ($s.environment.MAX_PERSONAL_CAPTURE_HMAC_SECRET | length) >= 32
  and $g.image == $gateway
  and $g.user == "1000:1000"
  and $g.read_only == true
  and ($g.privileged // false) == false
  and $g.pids_limit == 128
  and ($g.cap_drop == ["ALL"])
  and ($g.ports | length) == 0
  and ([ $g.networks | keys[] | select(. == "crm_internal") ] | length) == 1
  and $g.environment.MAX_RAW_JOURNAL_ENABLED == $s.environment.MAX_PERSONAL_ACCOUNT_ID
  and $g.environment.MAX_INBOUND_NORMALIZER_ENABLED == $s.environment.MAX_PERSONAL_ACCOUNT_ID
  and $g.environment.MAX_SHADOW_COMPARISON_ENABLED == $s.environment.MAX_PERSONAL_ACCOUNT_ID
  and $g.environment.MAX_PERSONAL_LIVE_CAPTURE_ENABLED == $s.environment.MAX_PERSONAL_ACCOUNT_ID
  and ($g.environment.MAX_PERSONAL_GATEWAY_DATABASE_URL | startswith("postgresql://"))
  and ($g.environment.MAX_PERSONAL_CAPTURE_HMAC_KEYS_JSON | fromjson | length) == 1
  and $g.environment.MAX_PERSONAL_GATEWAY_REQUIRED_MIGRATION == "20260727154647_add_max_capture_ingress"
  and $g.labels["personal-max.provider-actions"] == "inactive"
' "$rendered" >/dev/null

printf 'STAGE8B2C_SHADOW_ACTIVE_RENDERED_COMPOSE_PASS\n'
