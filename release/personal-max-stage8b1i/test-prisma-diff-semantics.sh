#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPOSITORY_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd -P)
GATE="$SCRIPT_DIR/prisma-legacy-diff-gate.sh"
PARSER="$SCRIPT_DIR/prisma-diff-semantic-parser.py"
TEST_ROOT=$(mktemp -d /var/tmp/personal-max-prisma-diff-test.XXXXXX)
trap 'rm -rf -- "$TEST_ROOT"' EXIT
PASS_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'PASS %02d %s\n' "$PASS_COUNT" "$1"
}

assert_safe_facts() {
  local path=$1 expected_class=$2
  jq -e --arg expected "$expected_class" '
    .schemaVersion==1 and .finalGateClassification==$expected and
    (.rawByteCount|type)=="number" and (.nonCommentStatementCount|type)=="number" and
    (.alterTableCount|type)=="number" and (.affectedTableCount|type)=="number" and
    ([.expectedTablePresent,.submittedPhoneAddPresent,.submittedPhoneAtAddPresent,
      .unexpectedTablePresent,.unexpectedColumnPresent,.unexpectedOperationPresent,
      .defaultPresent,.constraintPresent,.indexPresent,.defaultConstraintIndexPresent,
      .rawDiffRetained,.rawSqlCaptured]|all(type=="boolean")) and
    (.parserResult|IN("ACCEPTED","REJECTED","PARSE_FAILED","EMPTY")) and
    (.normalizedSemanticSha256|test("^[0-9a-f]{64}$")) and
    .expectedSemanticMode=="LEGACY_TWO_COLUMN_DRIFT_EXPECTED" and
    .rawDiffRetained==false and .rawSqlCaptured==false' "$path" >/dev/null
}

run_sql_case() {
  local name=$1 expected_status=$2 expected_class=$3 content=$4
  local sql_path="$TEST_ROOT/$name.sql" facts_path="$TEST_ROOT/$name.json" status
  printf '%b' "$content" >"$sql_path"
  set +e
  sh "$GATE" "$sql_path" "$facts_path" >"$TEST_ROOT/$name.status"
  status=$?
  set -e
  [[ $status -eq $expected_status ]]
  assert_safe_facts "$facts_path" "$expected_class"
  pass "$name"
}

one_line='ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone" TEXT, ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\n'
reverse='ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhoneAt" TIMESTAMP(3), ADD COLUMN "submittedPhone" TEXT;\n'
two_statements='ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone" TEXT;\nALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\n'

run_sql_case exact_old_form 0 MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT "$one_line"
run_sql_case prisma_comments 0 MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT "-- This is an automatically generated migration.\n$one_line"
run_sql_case multiline_format 0 MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT 'ALTER TABLE\n  "DriverTelegram"\n  ADD COLUMN "submittedPhone" TEXT,\n  ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\n'
run_sql_case reversed_order 0 MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT "$reverse"
run_sql_case two_alter_statements 0 MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT "$two_statements"
run_sql_case tabs_repeated_whitespace 0 MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT 'ALTER\t TABLE   "DriverTelegram"\tADD   COLUMN "submittedPhone"\tTEXT,  ADD COLUMN "submittedPhoneAt" TIMESTAMP( 3 );\n'
run_sql_case crlf 0 MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT 'BEGIN;\r\nALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone" TEXT,\r\n ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\r\nCOMMIT;\r\n'
run_sql_case empty_diff 65 MIGRATION_PRISMA_DIFF_EMPTY_UNEXPECTED ''
run_sql_case comments_only 65 MIGRATION_PRISMA_DIFF_EMPTY_UNEXPECTED '-- no executable statements\n/* bounded comment */\n'
run_sql_case missing_phone 65 MIGRATION_PRISMA_DIFF_REQUIRED_COLUMN_MISSING 'ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\n'
run_sql_case missing_phone_at 65 MIGRATION_PRISMA_DIFF_REQUIRED_COLUMN_MISSING 'ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone" TEXT;\n'
run_sql_case wrong_phone_type 65 MIGRATION_PRISMA_DIFF_TYPE_MISMATCH 'ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone" VARCHAR(255), ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\n'
run_sql_case wrong_phone_at_type 65 MIGRATION_PRISMA_DIFF_TYPE_MISMATCH 'ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone" TEXT, ADD COLUMN "submittedPhoneAt" TIMESTAMP(6);\n'
run_sql_case default_added 65 MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION 'ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone" TEXT DEFAULT NULL, ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\n'
run_sql_case not_null_added 65 MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION 'ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone" TEXT NOT NULL, ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\n'
run_sql_case extra_column 65 MIGRATION_PRISMA_DIFF_UNEXPECTED_COLUMN 'ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone" TEXT, ADD COLUMN "submittedPhoneAt" TIMESTAMP(3), ADD COLUMN "extra" TEXT;\n'
run_sql_case wrong_table 65 MIGRATION_PRISMA_DIFF_UNEXPECTED_TABLE 'ALTER TABLE "Other" ADD COLUMN "submittedPhone" TEXT, ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\n'
run_sql_case second_table 65 MIGRATION_PRISMA_DIFF_UNEXPECTED_TABLE "$one_line"'ALTER TABLE "Other" ADD COLUMN "extra" TEXT;\n'
run_sql_case drop_statement 65 MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION "$one_line"'DROP TABLE "DriverTelegram";\n'
run_sql_case insert_statement 65 MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION "$one_line"'INSERT INTO "DriverTelegram" ("id") VALUES ('"'"'unsafe'"'"');\n'
run_sql_case update_statement 65 MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION "$one_line"'UPDATE "DriverTelegram" SET "submittedPhone" = NULL;\n'
run_sql_case delete_statement 65 MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION "$one_line"'DELETE FROM "DriverTelegram";\n'
run_sql_case index_creation 65 MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION "$one_line"'CREATE INDEX "forbidden" ON "DriverTelegram"("submittedPhone");\n'
run_sql_case constraint_creation 65 MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION "$one_line"'ALTER TABLE "DriverTelegram" ADD CONSTRAINT "forbidden" CHECK (true);\n'
run_sql_case duplicate_column 65 MIGRATION_PRISMA_DIFF_UNEXPECTED_COLUMN 'ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone" TEXT, ADD COLUMN "submittedPhone" TEXT, ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\n'
run_sql_case malformed_sql 65 MIGRATION_PRISMA_DIFF_PARSE_FAILED 'ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone" TEXT\n'
run_sql_case statement_after 65 MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION "$one_line"'SELECT 1;\n'
run_sql_case statement_before 65 MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION 'SELECT 1;\n'"$one_line"

size_sql="$TEST_ROOT/size_limit.sql"
size_facts="$TEST_ROOT/size_limit.json"
head -c 4097 /dev/zero | tr '\0' x >"$size_sql"
set +e
sh "$GATE" "$size_sql" "$size_facts" >"$TEST_ROOT/size_limit.status"
size_status=$?
set -e
[[ $size_status -eq 65 ]]
assert_safe_facts "$size_facts" MIGRATION_PRISMA_DIFF_PARSE_FAILED
pass size_limit

printf '%b' "$one_line" >"$TEST_ROOT/symlink-target.sql"
ln -s "$TEST_ROOT/symlink-target.sql" "$TEST_ROOT/symlink.sql"
set +e
sh "$GATE" "$TEST_ROOT/symlink.sql" "$TEST_ROOT/symlink.json" >"$TEST_ROOT/symlink.status"
symlink_status=$?
set -e
[[ $symlink_status -eq 65 ]]
assert_safe_facts "$TEST_ROOT/symlink.json" MIGRATION_PRISMA_DIFF_PARSE_FAILED
pass symlink_refusal

[[ $(find "$REPOSITORY_ROOT/gravity-mvp/prisma/migrations" -mindepth 2 -maxdepth 2 -type f -name migration.sql | wc -l) -eq 53 ]]
! rg -q 'submittedPhone|submittedPhoneAt' "$REPOSITORY_ROOT/gravity-mvp/prisma/schema.prisma"
! rg -q 'submittedPhone|submittedPhoneAt' "$REPOSITORY_ROOT/gravity-mvp/prisma/migrations" --glob migration.sql
[[ ! -e "$REPOSITORY_ROOT/gravity-mvp/prisma/migrations/20260717000000_add_driver_telegram_submitted_phone" ]]
pass repository_migration_closure_audit

rg -q "readonly_expected_mode='LEGACY_TWO_COLUMN_DRIFT_EXPECTED'" "$GATE"
! rg -q 'EMPTY_DIFF_EXPECTED' "$GATE"
pass expected_semantic_mode_exact

jq -e 'keys==(["affectedTableCount","alterTableCount","constraintPresent","defaultConstraintIndexPresent","defaultPresent","expectedSemanticMode","expectedTablePresent","finalGateClassification","indexPresent","nonCommentStatementCount","normalizedSemanticSha256","parserResult","rawByteCount","rawDiffRetained","rawSqlCaptured","schemaVersion","submittedPhoneAddPresent","submittedPhoneAtAddPresent","unexpectedColumnPresent","unexpectedOperationPresent","unexpectedTablePresent"]|sort)' \
  "$TEST_ROOT/exact_old_form.json" >/dev/null
pass sanitized_semantic_facts

! rg -q 'ALTER TABLE|ADD COLUMN|submittedPhone.*TEXT|TIMESTAMP\(3\)' "$TEST_ROOT/exact_old_form.json"
pass raw_sql_absent_from_facts

[[ $(<"$TEST_ROOT/exact_old_form.status") == PRISMA_DIFF_STATUS=MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT ]]
pass success_maps_to_accepted_status

PROBE_SAFE_COMMAND_CLASS=disposable_migration
PROBE_ERROR_CLASSIFICATION=NONE
# shellcheck source=release/personal-max-stage8b1i/bounded-operations.sh
source "$SCRIPT_DIR/bounded-operations.sh"
# shellcheck source=release/personal-max-stage8b1i/migration-preflight.sh
source "$SCRIPT_DIR/migration-preflight.sh"
set +e
pm_migration_run_prisma_diff_gate "$TEST_ROOT/wrong_phone_type.sql" \
  "$TEST_ROOT/integration-rejection.json" "$GATE"
integration_status=$?
set -e
[[ $integration_status -eq 65 && $MIGRATION_CHECK_ID == MIGRATION_PRISMA_DIFF_GATE_CHECK && \
  $MIGRATION_PRIMARY_CLASSIFICATION == MIGRATION_PRISMA_DIFF_TYPE_MISMATCH && \
  $MIGRATION_ORIGINAL_EXIT -eq 65 && $MIGRATION_PRISMA_DIFF_FACTS_OBSERVED == true && \
  $MIGRATION_PRISMA_DIFF_FINAL_GATE_CLASSIFICATION == MIGRATION_PRISMA_DIFF_TYPE_MISMATCH ]]
pass rejection_maps_to_precise_classification

[[ $PASS_COUNT -eq 36 ]]
printf 'PRISMA_DIFF_SEMANTIC_TEST_COUNT=%d\n' "$PASS_COUNT"
