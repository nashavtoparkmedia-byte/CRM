#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
GATE="$SCRIPT_DIR/prisma-legacy-diff-gate.sh"
PARSER="$SCRIPT_DIR/prisma-diff-semantic-parser.py"
PREFLIGHT="$SCRIPT_DIR/migration-preflight.sh"
DIAGNOSTICS="$SCRIPT_DIR/failure-diagnostics.sh"
SCHEMA="$SCRIPT_DIR/report-schema.json"
TEST_ROOT=$(mktemp -d /var/tmp/personal-max-prisma-parser-failure-test.XXXXXX)
trap 'chmod -R u+rwX -- "$TEST_ROOT" 2>/dev/null || true; rm -rf -- "$TEST_ROOT"' EXIT
PASS_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'PASS %02d %s\n' "$PASS_COUNT" "$1"
}

assert_fact() {
  local path=$1 classification=$2 code=$3
  jq -e --arg classification "$classification" --arg code "$code" '
    .schemaVersion==1 and .sizeLimitBytes==4096 and
    .finalGateClassification==$classification and .parserFailureCode==$code and
    (.parserFailureStage|type)=="string" and (.rawByteCount|type)=="number" and
    ([.utf8Valid,.commentsBalanced,.quotesBalanced,.statementTerminationValid,
      .schemaQualificationObserved,.factsFileCreated,.factsFileLoaded,
      .expectedTablePresent,.submittedPhoneAddPresent,.submittedPhoneAtAddPresent,
      .unexpectedTablePresent,.unexpectedColumnPresent,.unexpectedOperationPresent,
      .defaultPresent,.constraintPresent,.indexPresent,.defaultConstraintIndexPresent,
      .rawDiffRetained,.rawSqlCaptured]|all(type=="boolean")) and
    .factsFileCreated==true and .factsFileLoaded==false and
    .rawDiffRetained==false and .rawSqlCaptured==false and
    (.normalizedSemanticSha256|test("^[0-9a-f]{64}$"))' "$path" >/dev/null
}

run_sql() {
  local name=$1 expected_status=$2 expected_class=$3 expected_code=$4 content=$5
  local input="$TEST_ROOT/$name.sql" facts="$TEST_ROOT/$name.json" status
  printf '%b' "$content" >"$input"
  set +e
  sh "$GATE" "$input" "$facts" >"$TEST_ROOT/$name.status"
  status=$?
  set -e
  [[ $status -eq $expected_status ]]
  assert_fact "$facts" "$expected_class" "$expected_code"
}

accepted='ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone" TEXT, ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\n'
quoted_public='ALTER TABLE "public"."DriverTelegram" ADD COLUMN "submittedPhone" TEXT, ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\n'
mixed_public='ALTER TABLE public."DriverTelegram" ADD COLUMN "submittedPhone" TEXT, ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\n'

run_sql prisma_comment_block 0 MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT NONE '-- AlterTable\n-- Prisma generated change\nALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone" TEXT, ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\n'
pass prisma_comment_block_one_alter

run_sql quoted_public 0 MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT NONE "$quoted_public"
jq -e '.schemaQualificationObserved==true and .identifierFormCategory=="QUALIFIED_QUOTED"' "$TEST_ROOT/quoted_public.json" >/dev/null
pass quoted_public_identifier

run_sql mixed_public 0 MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT NONE "$mixed_public"
jq -e '.schemaQualificationObserved==true and .identifierFormCategory=="QUALIFIED_MIXED"' "$TEST_ROOT/mixed_public.json" >/dev/null
pass mixed_public_identifier

run_sql multiline_prisma 0 MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT NONE 'ALTER TABLE "public"."DriverTelegram"\n  ADD COLUMN "submittedPhone" TEXT,\n  ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\n'
pass multiline_prisma_commas

run_sql two_alters 0 MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT NONE 'ALTER TABLE ONLY "public"."DriverTelegram" ADD COLUMN "submittedPhone" TEXT;\nALTER TABLE ONLY "public"."DriverTelegram" ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\n'
jq -e '.alterTableCount==2' "$TEST_ROOT/two_alters.json" >/dev/null
pass two_alter_statements

run_sql reverse_order 0 MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT NONE 'ALTER TABLE "public"."DriverTelegram" ADD COLUMN "submittedPhoneAt" TIMESTAMP(3), ADD COLUMN "submittedPhone" TEXT;\n'
pass reverse_column_order

run_sql transaction 0 MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT NONE 'BEGIN;\nALTER TABLE "public"."DriverTelegram" ADD COLUMN "submittedPhone" TEXT, ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\nCOMMIT;\n'
jq -e '.transactionWrapperState=="VALID"' "$TEST_ROOT/transaction.json" >/dev/null
pass transaction_wrapper

run_sql crlf 0 MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT NONE 'ALTER TABLE public."DriverTelegram" ADD COLUMN "submittedPhone" TEXT,\r\n  ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\r\n'
pass crlf_normalization

boundary="$TEST_ROOT/boundary.sql"
printf '%b' "$accepted" >"$boundary"
boundary_base=$(wc -c <"$boundary")
padding=$((4096 - boundary_base - 3))
printf '%s' '--' >>"$boundary"
head -c "$padding" /dev/zero | tr '\0' x >>"$boundary"
printf '\n' >>"$boundary"
[[ $(wc -c <"$boundary") -eq 4096 ]]
set +e
sh "$GATE" "$boundary" "$TEST_ROOT/boundary.json" >"$TEST_ROOT/boundary.status"
boundary_status=$?
set -e
[[ $boundary_status -eq 0 ]]
assert_fact "$TEST_ROOT/boundary.json" MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT NONE
pass exact_4096_boundary

head -c 4097 /dev/zero | tr '\0' x >"$TEST_ROOT/oversized.sql"
set +e
sh "$GATE" "$TEST_ROOT/oversized.sql" "$TEST_ROOT/oversized.json" >"$TEST_ROOT/oversized.status"
oversized_status=$?
set -e
[[ $oversized_status -eq 65 ]]
assert_fact "$TEST_ROOT/oversized.json" MIGRATION_PRISMA_DIFF_INPUT_TOO_LARGE INPUT_TOO_LARGE
jq -e '.rawByteCount==4097 and .sizeLimitBytes==4096' "$TEST_ROOT/oversized.json" >/dev/null
pass oversized_4097_safe_facts

printf '\377' >"$TEST_ROOT/invalid-utf8.sql"
set +e
sh "$GATE" "$TEST_ROOT/invalid-utf8.sql" "$TEST_ROOT/invalid-utf8.json" >"$TEST_ROOT/invalid-utf8.status"
invalid_utf8_status=$?
set -e
[[ $invalid_utf8_status -eq 65 ]]
assert_fact "$TEST_ROOT/invalid-utf8.json" MIGRATION_PRISMA_DIFF_INPUT_UTF8_INVALID INPUT_UTF8_INVALID
jq -e '.utf8Valid==false' "$TEST_ROOT/invalid-utf8.json" >/dev/null
pass invalid_utf8

run_sql unterminated_comment 65 MIGRATION_PRISMA_DIFF_COMMENT_UNTERMINATED COMMENT_UNTERMINATED '/* Prisma comment\n'
jq -e '.commentsBalanced==false' "$TEST_ROOT/unterminated_comment.json" >/dev/null
pass unterminated_block_comment

run_sql unterminated_quote 65 MIGRATION_PRISMA_DIFF_QUOTE_UNTERMINATED QUOTE_UNTERMINATED 'ALTER TABLE "DriverTelegram ADD COLUMN "submittedPhone" TEXT;\n'
jq -e '.quotesBalanced==false' "$TEST_ROOT/unterminated_quote.json" >/dev/null
pass unterminated_quote

run_sql missing_semicolon 65 MIGRATION_PRISMA_DIFF_STATEMENT_UNTERMINATED STATEMENT_UNTERMINATED 'ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone" TEXT\n'
jq -e '.statementTerminationValid==false' "$TEST_ROOT/missing_semicolon.json" >/dev/null
pass missing_semicolon

run_sql wrong_schema 65 MIGRATION_PRISMA_DIFF_UNEXPECTED_TABLE NONE 'ALTER TABLE "private"."DriverTelegram" ADD COLUMN "submittedPhone" TEXT, ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);\n'
jq -e '.schemaQualificationObserved==true and .unexpectedTablePresent==true' "$TEST_ROOT/wrong_schema.json" >/dev/null
pass wrong_schema_rejected

run_sql forbidden_alter 65 MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION NONE "$quoted_public"'ALTER TABLE "public"."DriverTelegram" ALTER COLUMN "submittedPhone" TYPE TEXT;\n'
pass forbidden_additional_alter

printf '%s\n' 'DO_NOT_OVERWRITE' >"$TEST_ROOT/preexisting.json"
preexisting_sha=$(sha256sum "$TEST_ROOT/preexisting.json" | awk '{print $1}')
printf '%b' "$accepted" >"$TEST_ROOT/preexisting.sql"
set +e
sh "$GATE" "$TEST_ROOT/preexisting.sql" "$TEST_ROOT/preexisting.json" >"$TEST_ROOT/preexisting.status"
preexisting_status=$?
set -e
[[ $preexisting_status -eq 73 && $(sha256sum "$TEST_ROOT/preexisting.json" | awk '{print $1}') == "$preexisting_sha" ]]
assert_fact "$TEST_ROOT/preexisting.json.failure" MIGRATION_PRISMA_DIFF_FACTS_OUTPUT_EXISTS FACTS_OUTPUT_EXISTS
pass facts_output_preexists

printf '%s\n' 'SYMLINK_TARGET_UNTOUCHED' >"$TEST_ROOT/facts-target"
ln -s "$TEST_ROOT/facts-target" "$TEST_ROOT/facts-symlink.json"
printf '%b' "$accepted" >"$TEST_ROOT/facts-symlink.sql"
set +e
sh "$GATE" "$TEST_ROOT/facts-symlink.sql" "$TEST_ROOT/facts-symlink.json" >"$TEST_ROOT/facts-symlink.status"
facts_symlink_status=$?
set -e
[[ $facts_symlink_status -eq 73 && $(<"$TEST_ROOT/facts-target") == SYMLINK_TARGET_UNTOUCHED ]]
assert_fact "$TEST_ROOT/facts-symlink.json.failure" MIGRATION_PRISMA_DIFF_FACTS_OUTPUT_EXISTS FACTS_OUTPUT_EXISTS
pass facts_output_symlink

mkdir "$TEST_ROOT/readonly"
chmod 0500 "$TEST_ROOT/readonly"
printf '%b' "$accepted" >"$TEST_ROOT/write-failure.sql"
set +e
write_failure_output=$(sh "$GATE" "$TEST_ROOT/write-failure.sql" "$TEST_ROOT/readonly/facts.json")
write_failure_status=$?
set -e
[[ $write_failure_status -eq 74 && $write_failure_output == PRISMA_DIFF_STATUS=MIGRATION_PRISMA_DIFF_FACTS_OUTPUT_WRITE_FAILED ]]
chmod 0700 "$TEST_ROOT/readonly"
pass facts_output_write_permission_failure

PROBE_SAFE_COMMAND_CLASS=disposable_migration
PROBE_ERROR_CLASSIFICATION=NONE
# shellcheck source=release/personal-max-stage8b1i/bounded-operations.sh
source "$SCRIPT_DIR/bounded-operations.sh"
# shellcheck source=release/personal-max-stage8b1i/migration-preflight.sh
source "$PREFLIGHT"
pm_migration_load_prisma_diff_facts "$TEST_ROOT/oversized.json"
[[ $MIGRATION_PRISMA_DIFF_RAW_BYTE_COUNT -eq 4097 && $MIGRATION_PRISMA_DIFF_FACTS_FILE_LOADED == true && \
  $MIGRATION_PRISMA_DIFF_PARSER_FAILURE_CODE == INPUT_TOO_LARGE ]]
pass loader_accepts_oversized_rejected_facts

printf '%s\n' '{"schemaVersion":1,"rawByteCount":4097}' >"$TEST_ROOT/malformed-facts.json"
set +e
pm_migration_load_prisma_diff_facts "$TEST_ROOT/malformed-facts.json"
malformed_loader_status=$?
set -e
[[ $malformed_loader_status -eq 76 ]]
pass loader_rejects_malformed_schema

mkdir "$TEST_ROOT/no-python-bin"
ln -s "$(command -v dirname)" "$TEST_ROOT/no-python-bin/dirname"
set +e
sh "$GATE" "$TEST_ROOT/missing-input.sql" "$TEST_ROOT/missing-input.json" >"$TEST_ROOT/missing-input.status"
missing_input_status=$?
sh "$GATE" "$TEST_ROOT" "$TEST_ROOT/nonregular.json" >"$TEST_ROOT/nonregular.status"
nonregular_status=$?
set -e
[[ $missing_input_status -eq 65 && $nonregular_status -eq 65 ]]
assert_fact "$TEST_ROOT/missing-input.json" MIGRATION_PRISMA_DIFF_INPUT_MISSING INPUT_MISSING
assert_fact "$TEST_ROOT/nonregular.json" MIGRATION_PRISMA_DIFF_INPUT_NOT_REGULAR INPUT_NOT_REGULAR
run_sql invalid_wrapper 65 MIGRATION_PRISMA_DIFF_TRANSACTION_WRAPPER_INVALID TRANSACTION_WRAPPER_INVALID 'BEGIN;\n'"$accepted"
run_sql invalid_identifier 65 MIGRATION_PRISMA_DIFF_IDENTIFIER_SYNTAX_UNSUPPORTED IDENTIFIER_SYNTAX_UNSUPPORTED 'ALTER TABLE DriverTelegram ADD COLUMN "submittedPhone" TEXT;\n'
run_sql invalid_clause 65 MIGRATION_PRISMA_DIFF_CLAUSE_SYNTAX_UNSUPPORTED CLAUSE_SYNTAX_UNSUPPORTED 'ALTER TABLE "DriverTelegram" ADD COLUMN "submittedPhone";\n'
set +e
launch_output=$(PATH="$TEST_ROOT/no-python-bin" /bin/sh "$GATE" "$TEST_ROOT/quoted_public.sql" "$TEST_ROOT/launch.json")
launch_status=$?
set -e
[[ $launch_status -eq 69 && $launch_output == PRISMA_DIFF_STATUS=MIGRATION_PRISMA_DIFF_PARSER_LAUNCH_FAILED ]]
for pair in \
  'oversized.json:MIGRATION_PRISMA_DIFF_INPUT_TOO_LARGE:INPUT_TOO_LARGE' \
  'invalid-utf8.json:MIGRATION_PRISMA_DIFF_INPUT_UTF8_INVALID:INPUT_UTF8_INVALID' \
  'unterminated_comment.json:MIGRATION_PRISMA_DIFF_COMMENT_UNTERMINATED:COMMENT_UNTERMINATED' \
  'unterminated_quote.json:MIGRATION_PRISMA_DIFF_QUOTE_UNTERMINATED:QUOTE_UNTERMINATED' \
  'missing_semicolon.json:MIGRATION_PRISMA_DIFF_STATEMENT_UNTERMINATED:STATEMENT_UNTERMINATED'; do
  IFS=: read -r file classification code <<<"$pair"
  assert_fact "$TEST_ROOT/$file" "$classification" "$code"
done
pass every_rejection_precisely_classified

for field in parserFailureStage parserFailureCode rawByteCount sizeLimitBytes utf8Valid commentsBalanced \
  quotesBalanced statementTerminationValid transactionWrapperState schemaQualificationObserved \
  identifierFormCategory factsFileCreated factsFileLoaded; do
  rg -q "$field" "$DIAGNOSTICS"
  jq -e --arg field "$field" '(.allOf[1].then.properties.prismaDiffEvidence.required|index($field)) != null' "$SCHEMA" >/dev/null
done
pass failure_report_renders_safe_fields

! rg -q 'ALTER TABLE|ADD COLUMN|private|Prisma generated|SYMLINK_TARGET' "$TEST_ROOT/quoted_public.json" "$TEST_ROOT/wrong_schema.json" "$TEST_ROOT/oversized.json"
jq -e '.rawDiffRetained==false and .rawSqlCaptured==false' "$TEST_ROOT/wrong_schema.json" >/dev/null
pass raw_sql_and_unknown_identifiers_absent

run_sql exact_contract_extra_column 65 MIGRATION_PRISMA_DIFF_UNEXPECTED_COLUMN NONE 'ALTER TABLE "public"."DriverTelegram" ADD COLUMN "submittedPhone" TEXT, ADD COLUMN "submittedPhoneAt" TIMESTAMP(3), ADD COLUMN "other" TEXT;\n'
jq -e '.unexpectedColumnPresent==true and .parserResult=="REJECTED"' "$TEST_ROOT/exact_contract_extra_column.json" >/dev/null
pass exact_two_column_semantics_preserved

[[ $PASS_COUNT -eq 25 ]]
printf 'PRISMA_PARSER_FAILURE_TEST_COUNT=%d\n' "$PASS_COUNT"
