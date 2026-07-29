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

if [ ! -f "$parser_path" ] || [ -L "$parser_path" ] || ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' 'PRISMA_DIFF_STATUS=MIGRATION_PRISMA_DIFF_PARSER_LAUNCH_FAILED'
  exit 69
fi

set +e
python3 "$parser_path" "$diff_path" "$facts_path" "$readonly_expected_mode"
status=$?
set -e

facts_candidate=''
if [ "$status" -eq 73 ] && [ -f "$facts_path.failure" ] && [ ! -L "$facts_path.failure" ]; then
  facts_candidate="$facts_path.failure"
elif [ -f "$facts_path" ] && [ ! -L "$facts_path" ]; then
  facts_candidate=$facts_path
fi

if [ -n "$facts_candidate" ]; then
  classification=$(python3 -c '
import json, re, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    value = json.load(stream)
classification = value.get("finalGateClassification", "")
stage = value.get("parserFailureStage", "")
code = value.get("parserFailureCode", "")
if (not re.fullmatch(r"MIGRATION_PRISMA_DIFF_[A-Z0-9_]+", classification)
        or not re.fullmatch(r"[A-Z0-9_]+", stage)
        or not re.fullmatch(r"[A-Z0-9_]+", code)):
    raise SystemExit(1)
sys.stdout.write(classification)
' "$facts_candidate") || {
    printf '%s\n' 'PRISMA_DIFF_STATUS=MIGRATION_PRISMA_DIFF_FACTS_SCHEMA_REJECTED'
    exit 76
  }
  printf 'PRISMA_DIFF_STATUS=%s\n' "$classification"
elif [ "$status" -eq 74 ]; then
  printf '%s\n' 'PRISMA_DIFF_STATUS=MIGRATION_PRISMA_DIFF_FACTS_OUTPUT_WRITE_FAILED'
elif [ "$status" -eq 69 ] || [ "$status" -eq 126 ] || [ "$status" -eq 127 ]; then
  printf '%s\n' 'PRISMA_DIFF_STATUS=MIGRATION_PRISMA_DIFF_PARSER_LAUNCH_FAILED'
  status=69
else
  printf '%s\n' 'PRISMA_DIFF_STATUS=MIGRATION_PRISMA_DIFF_PARSER_INTERNAL_FAILURE'
  status=70
fi

exit "$status"
