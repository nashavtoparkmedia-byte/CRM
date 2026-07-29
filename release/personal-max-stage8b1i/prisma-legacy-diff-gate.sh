#!/bin/sh
set -eu

# The runtime architecture proves one mode only: the restored ledger contains
# the accepted applied-only migration while the repository migration closure
# omits it. Do not make this caller-selectable.
readonly_expected_mode='LEGACY_TWO_COLUMN_DRIFT_EXPECTED'
diff_path=${1:?Prisma diff path required}
facts_path=${2:?Sanitized facts path required}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
parser_path="$script_dir/prisma-diff-semantic-parser.py"

[ -f "$parser_path" ]
[ ! -L "$parser_path" ]
command -v python3 >/dev/null 2>&1

set +e
python3 "$parser_path" "$diff_path" "$facts_path" "$readonly_expected_mode"
status=$?
set -e

if [ -f "$facts_path" ] && [ ! -L "$facts_path" ]; then
  classification=$(python3 -c '
import json, re, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    value = json.load(stream)
classification = value.get("finalGateClassification", "")
if not re.fullmatch(r"MIGRATION_PRISMA_DIFF_[A-Z0-9_]+", classification):
    raise SystemExit(1)
sys.stdout.write(classification)
' "$facts_path") || exit 74
  printf 'PRISMA_DIFF_STATUS=%s\n' "$classification"
fi

exit "$status"
