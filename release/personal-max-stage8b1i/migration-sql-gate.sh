#!/bin/sh
set -eu

migration_root=${1:?migration root required}
bindings_path=${2:?bindings path required}

[ -d "$migration_root" ]
[ -f "$bindings_path" ]
[ ! -L "$bindings_path" ]
[ "$(wc -l <"$bindings_path" | tr -d ' ')" = 8 ]

seen='|'
count=0
while IFS='  ' read -r expected_sha migration_name extra; do
  [ -n "$expected_sha" ]
  [ -n "$migration_name" ]
  [ -z "${extra:-}" ]
  case $expected_sha in
    *[!0-9a-f]*|'') exit 64 ;;
  esac
  [ "${#expected_sha}" = 64 ]
  case $migration_name in
    20260726162043_add_max_raw_transport_journal | \
    20260726190658_add_max_route_registry | \
    20260726205437_add_max_inbound_normalization | \
    20260726215715_add_max_per_chat_outbound_actor | \
    20260726225737_add_max_dispatch_ledger | \
    20260727053744_add_max_provider_confirmation_matcher | \
    20260727141925_add_max_shadow_semantic_comparison | \
    20260727154647_add_max_capture_ingress) ;;
    *) exit 64 ;;
  esac
  case $seen in
    *"|$migration_name|"*) exit 64 ;;
  esac
  seen="${seen}${migration_name}|"
  migration_file="$migration_root/$migration_name/migration.sql"
  [ -f "$migration_file" ]
  [ ! -L "$migration_file" ]
  checksum_line=$(sha256sum -- "$migration_file")
  actual_sha=${checksum_line%% *}
  [ "$actual_sha" = "$expected_sha" ]

  if grep -Eiq '^[[:space:]]*(DROP[[:space:]]+(TABLE|SCHEMA|DATABASE|INDEX|TYPE|VIEW|MATERIALIZED)|TRUNCATE([[:space:]]|$)|DELETE[[:space:]]+FROM|UPDATE[[:space:]].*[[:space:]]SET([[:space:]]|$)|INSERT[[:space:]]+INTO)|^[[:space:]]*ALTER[[:space:]]+TABLE.*[[:space:]]DROP[[:space:]]+(COLUMN|CONSTRAINT)' "$migration_file"; then
    exit 67
  fi
  drop_constraints=$(sed -nE 's/^[[:space:]]*(DROP[[:space:]]+CONSTRAINT[[:space:]]+[^;]+;)[[:space:]]*$/\1/p' "$migration_file")
  if [ "$migration_name" = 20260726225737_add_max_dispatch_ledger ]; then
    [ "$drop_constraints" = 'DROP CONSTRAINT "MaxOutboundCommandReservation_transition_fields_check";' ]
  else
    [ -z "$drop_constraints" ]
  fi
  count=$((count + 1))
done <"$bindings_path"

[ "$count" = 8 ]
printf 'MIGRATION_SQL_GATE=PASS\n'
