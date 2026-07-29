#!/usr/bin/env bash
# Privacy-safe migration preflight state machine. This helper records only
# allowlisted metadata; it never records commands, arguments, URLs, SQL, stderr,
# environment values, credentials, or database contents.

: "${MIGRATION_CHECK_ID:=NONE}"
: "${MIGRATION_SUBSTEP:=NOT_STARTED}"
: "${MIGRATION_RUNNER_ROLE:=not_observed}"
: "${MIGRATION_COMMAND_CATEGORY:=not_observed}"
: "${MIGRATION_EXECUTABLE_CATEGORY:=not_observed}"
: "${MIGRATION_COMMAND_STARTED:=false}"
: "${MIGRATION_ATTEMPT_COUNT:=0}"
: "${MIGRATION_ELAPSED_SECONDS:=0}"
: "${MIGRATION_ORIGINAL_EXIT:=not_observed}"
: "${MIGRATION_CONTAINER_STATE_CATEGORY:=not_observed}"
: "${MIGRATION_PRIMARY_CLASSIFICATION:=NONE}"
: "${MIGRATION_POSTGRES_NETWORK_FACTS_OBSERVED:=false}"
: "${MIGRATION_POSTGRES_OBSERVED_NETWORK_COUNT:=0}"
: "${MIGRATION_POSTGRES_EXPECTED_NETWORK_PRESENT:=false}"
: "${MIGRATION_POSTGRES_ALIAS_ARRAY_PRESENT:=false}"
: "${MIGRATION_POSTGRES_EXPECTED_ALIAS_PRESENT:=false}"
: "${MIGRATION_POSTGRES_UNEXPECTED_NETWORK_PRESENT:=false}"
: "${MIGRATION_POSTGRES_CONTAINER_RUNNING:=false}"
: "${MIGRATION_POSTGRES_ALIAS_URL_BINDING:=false}"
: "${MIGRATION_POSTGRES_ALIAS_VALIDATION_CLASSIFICATION:=NONE}"
: "${MIGRATION_PRISMA_DIFF_FACTS_OBSERVED:=false}"
: "${MIGRATION_PRISMA_DIFF_RAW_BYTE_COUNT:=0}"
: "${MIGRATION_PRISMA_DIFF_SIZE_LIMIT_BYTES:=4096}"
: "${MIGRATION_PRISMA_DIFF_UTF8_VALID:=false}"
: "${MIGRATION_PRISMA_DIFF_COMMENTS_BALANCED:=false}"
: "${MIGRATION_PRISMA_DIFF_QUOTES_BALANCED:=false}"
: "${MIGRATION_PRISMA_DIFF_STATEMENT_TERMINATION_VALID:=false}"
: "${MIGRATION_PRISMA_DIFF_TRANSACTION_WRAPPER_STATE:=NOT_OBSERVED}"
: "${MIGRATION_PRISMA_DIFF_SCHEMA_QUALIFICATION_OBSERVED:=false}"
: "${MIGRATION_PRISMA_DIFF_IDENTIFIER_FORM_CATEGORY:=NOT_OBSERVED}"
: "${MIGRATION_PRISMA_DIFF_FACTS_FILE_CREATED:=false}"
: "${MIGRATION_PRISMA_DIFF_FACTS_FILE_LOADED:=false}"
: "${MIGRATION_PRISMA_DIFF_PARSER_FAILURE_STAGE:=NOT_OBSERVED}"
: "${MIGRATION_PRISMA_DIFF_PARSER_FAILURE_CODE:=NOT_OBSERVED}"
: "${MIGRATION_PRISMA_DIFF_STATEMENT_COUNT:=0}"
: "${MIGRATION_PRISMA_DIFF_ALTER_TABLE_COUNT:=0}"
: "${MIGRATION_PRISMA_DIFF_AFFECTED_TABLE_COUNT:=0}"
: "${MIGRATION_PRISMA_DIFF_EXPECTED_TABLE_PRESENT:=false}"
: "${MIGRATION_PRISMA_DIFF_SUBMITTED_PHONE_PRESENT:=false}"
: "${MIGRATION_PRISMA_DIFF_SUBMITTED_PHONE_AT_PRESENT:=false}"
: "${MIGRATION_PRISMA_DIFF_UNEXPECTED_TABLE_PRESENT:=false}"
: "${MIGRATION_PRISMA_DIFF_UNEXPECTED_COLUMN_PRESENT:=false}"
: "${MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION_PRESENT:=false}"
: "${MIGRATION_PRISMA_DIFF_DEFAULT_PRESENT:=false}"
: "${MIGRATION_PRISMA_DIFF_CONSTRAINT_PRESENT:=false}"
: "${MIGRATION_PRISMA_DIFF_INDEX_PRESENT:=false}"
: "${MIGRATION_PRISMA_DIFF_DEFAULT_CONSTRAINT_INDEX_PRESENT:=false}"
: "${MIGRATION_PRISMA_DIFF_PARSER_RESULT:=NOT_OBSERVED}"
: "${MIGRATION_PRISMA_DIFF_NORMALIZED_SEMANTIC_SHA256:=not_observed}"
: "${MIGRATION_PRISMA_DIFF_EXPECTED_SEMANTIC_MODE:=LEGACY_TWO_COLUMN_DRIFT_EXPECTED}"
: "${MIGRATION_PRISMA_DIFF_FINAL_GATE_CLASSIFICATION:=NOT_OBSERVED}"

pm_migration_check_id_is_safe() {
  case ${1:-} in
    MIGRATION_DATABASE_URL_CONSTRUCTION_CHECK | MIGRATION_INVENTORY_CHECK | \
      MIGRATION_PENDING_SET_CHECK | MIGRATION_REPOSITORY_COUNT_CHECK | \
      MIGRATION_APPLIED_ONLY_CHECK | MIGRATION_RUNTIME_BINDING_CHECK | \
      MIGRATION_SQL_RUNNER_CREATE_CHECK | MIGRATION_SQL_RUNNER_IDENTITY_CHECK | \
      MIGRATION_SQL_RUNNER_START_CHECK | MIGRATION_POSTGRES_ALIAS_CHECK | \
      MIGRATION_SHADOW_DATABASE_CREATE_CHECK | MIGRATION_PRISMA_RUNNER_CREATE_CHECK | \
      MIGRATION_PRISMA_RUNNER_IDENTITY_CHECK | MIGRATION_PRISMA_EXECUTABLE_CHECK | \
      MIGRATION_PRISMA_DEPLOY_CHECK | MIGRATION_POST_LEDGER_CHECK | \
      MIGRATION_POST_SCHEMA_CHECK | MIGRATION_PRISMA_DIFF_CHECK | \
      MIGRATION_POST_FINISHED_COUNT_CHECK | MIGRATION_POST_FAILED_COUNT_CHECK | \
      MIGRATION_POST_LEDGER_COUNT_CHECK | MIGRATION_POST_LEDGER_NAMES_CHECK | \
      MIGRATION_POST_APPLIED_SET_BUILD_CHECK | MIGRATION_POST_APPLIED_SET_COMPARE_CHECK | \
      MIGRATION_DURATION_QUERY_CHECK | MIGRATION_DURATION_RESULT_CHECK | \
      MIGRATION_SCHEMA_TABLE_QUERY_CHECK | MIGRATION_SCHEMA_TABLE_CHECK | \
      MIGRATION_SCHEMA_COLUMN_QUERY_CHECK | MIGRATION_SCHEMA_COLUMN_CHECK | \
      MIGRATION_SCHEMA_INDEX_QUERY_CHECK | MIGRATION_SCHEMA_INDEX_CHECK | \
      MIGRATION_SCHEMA_UNIQUE_KEY_QUERY_CHECK | MIGRATION_SCHEMA_UNIQUE_KEY_CHECK | \
      MIGRATION_PRISMA_DIFF_EXECUTION_CHECK | MIGRATION_PRISMA_DIFF_GATE_CHECK) return 0 ;;
    *) return 1 ;;
  esac
}

pm_migration_classification_is_safe() {
  case ${1:-} in
    NONE | MIGRATION_COMMAND_NOT_STARTED | MIGRATION_DOCKER_CLI_FAILED | \
      MIGRATION_INVENTORY_TIMEOUT | MIGRATION_SCAN_TIMEOUT | MIGRATE_DEPLOY_TIMEOUT | \
      PRISMA_DIFF_TIMEOUT | PRISMA_DIFF_FAILED | \
      MIGRATION_RUNNER_CREATE_FAILED | MIGRATION_RUNNER_START_FAILED | MIGRATION_RUNNER_EXITED | \
      MIGRATION_DOCKER_EXEC_FAILED | MIGRATION_CONTAINER_UNAVAILABLE | \
      MIGRATION_NETWORK_ALIAS_MISMATCH | MIGRATION_DATABASE_URL_CONSTRUCTION_FAILED | \
      MIGRATION_POSTGRES_INSPECT_FAILED | MIGRATION_POSTGRES_NETWORK_MISSING | \
      MIGRATION_POSTGRES_UNEXPECTED_NETWORK | MIGRATION_POSTGRES_ALIAS_ARRAY_MISSING | \
      MIGRATION_POSTGRES_ALIAS_MISSING | MIGRATION_POSTGRES_ALIAS_MISMATCH | \
      MIGRATION_POSTGRES_NETWORK_FACTS_MALFORMED | \
      MIGRATION_PRISMA_EXECUTABLE_MISSING | MIGRATION_PRISMA_COMMAND_REJECTED | \
      MIGRATION_PRISMA_EXIT_1 | MIGRATION_PRISMA_EXIT_2 | MIGRATION_PRISMA_TIMEOUT | \
      MIGRATION_SQL_BINDING_MISMATCH | MIGRATION_SQL_GATE_EXIT_2 | \
      MIGRATION_DIRECTORY_MISSING | MIGRATION_DEPLOY_FAILED | \
      MIGRATION_POST_VERIFICATION_FAILED | MIGRATION_INTERNAL_VALIDATOR_FAILED | \
      MIGRATION_RUNTIME_FILE_UNREADABLE | MIGRATION_RUNNER_IDENTITY_MISMATCH | \
      MIGRATION_RUNNER_NETWORK_MISMATCH | MIGRATION_INVENTORY_FAILED | \
      MIGRATION_SHADOW_DATABASE_CREATE_FAILED | \
      MIGRATION_POST_FINISHED_COUNT_QUERY_FAILED | MIGRATION_POST_FAILED_COUNT_QUERY_FAILED | \
      MIGRATION_POST_LEDGER_COUNT_MISMATCH | MIGRATION_POST_LEDGER_NAMES_QUERY_FAILED | \
      MIGRATION_POST_APPLIED_SET_FAILED | MIGRATION_POST_APPLIED_SET_MISMATCH | \
      MIGRATION_DURATION_QUERY_FAILED | MIGRATION_DURATION_RESULT_MALFORMED | \
      MIGRATION_SCHEMA_TABLE_QUERY_FAILED | MIGRATION_SCHEMA_TABLE_MISSING | \
      MIGRATION_SCHEMA_COLUMN_QUERY_FAILED | MIGRATION_SCHEMA_COLUMN_MISSING | \
      MIGRATION_SCHEMA_INDEX_QUERY_FAILED | MIGRATION_SCHEMA_INDEX_MISSING | \
      MIGRATION_SCHEMA_UNIQUE_KEY_QUERY_FAILED | MIGRATION_SCHEMA_UNIQUE_KEY_MISSING | \
      MIGRATION_PRISMA_DIFF_EXECUTION_FAILED | MIGRATION_PRISMA_DIFF_REJECTED | \
      MIGRATION_PRISMA_DIFF_EMPTY_UNEXPECTED | MIGRATION_PRISMA_DIFF_REQUIRED_EMPTY | \
      MIGRATION_PRISMA_DIFF_PARSE_FAILED | MIGRATION_PRISMA_DIFF_UNEXPECTED_TABLE | \
      MIGRATION_PRISMA_DIFF_UNEXPECTED_COLUMN | MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION | \
      MIGRATION_PRISMA_DIFF_TYPE_MISMATCH | MIGRATION_PRISMA_DIFF_REQUIRED_COLUMN_MISSING | \
      MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT | MIGRATION_PRISMA_DIFF_EMPTY_ACCEPTED | \
      MIGRATION_PRISMA_DIFF_INPUT_MISSING | MIGRATION_PRISMA_DIFF_INPUT_SYMLINK | \
      MIGRATION_PRISMA_DIFF_INPUT_NOT_REGULAR | MIGRATION_PRISMA_DIFF_INPUT_TOO_LARGE | \
      MIGRATION_PRISMA_DIFF_INPUT_UTF8_INVALID | MIGRATION_PRISMA_DIFF_COMMENT_UNTERMINATED | \
      MIGRATION_PRISMA_DIFF_QUOTE_UNTERMINATED | MIGRATION_PRISMA_DIFF_STATEMENT_UNTERMINATED | \
      MIGRATION_PRISMA_DIFF_TRANSACTION_WRAPPER_INVALID | \
      MIGRATION_PRISMA_DIFF_ALTER_TABLE_SYNTAX_UNSUPPORTED | \
      MIGRATION_PRISMA_DIFF_IDENTIFIER_SYNTAX_UNSUPPORTED | \
      MIGRATION_PRISMA_DIFF_CLAUSE_SYNTAX_UNSUPPORTED | \
      MIGRATION_PRISMA_DIFF_FACTS_OUTPUT_EXISTS | MIGRATION_PRISMA_DIFF_FACTS_OUTPUT_WRITE_FAILED | \
      MIGRATION_PRISMA_DIFF_FACTS_SCHEMA_REJECTED | MIGRATION_PRISMA_DIFF_PARSER_INTERNAL_FAILURE | \
      MIGRATION_PRISMA_DIFF_PARSER_LAUNCH_FAILED) return 0 ;;
    *) return 1 ;;
  esac
}

pm_migration_substep_is_safe() {
  case ${1:-} in
    NOT_STARTED | database_url_construction | repository_inventory | pending_set_validation | \
      repository_count_validation | applied_only_validation | runtime_file_binding | \
      sql_runner_create | sql_runner_identity | sql_runner_start | postgres_alias_validation | \
      shadow_database_create | prisma_runner_create | prisma_runner_identity | \
      prisma_executable_validation | prisma_deploy | post_ledger_verification | \
      post_schema_verification | prisma_diff | post_finished_count | post_failed_count | \
      post_ledger_count | post_ledger_names | post_applied_set_build | post_applied_set_compare | \
      duration_query | duration_result_validation | schema_table_query | schema_table_validation | \
      schema_column_query | schema_column_validation | schema_index_query | schema_index_validation | \
      schema_unique_key_query | schema_unique_key_validation | prisma_diff_execution | prisma_diff_gate) return 0 ;;
    *) return 1 ;;
  esac
}

pm_migration_role_is_safe() {
  case ${1:-} in not_observed | host_validator | migration_inventory | sql_gate | postgres | prisma_deploy | prisma_diff) return 0 ;; *) return 1 ;; esac
}

pm_migration_command_category_is_safe() {
  case ${1:-} in not_observed | internal_validator | filesystem_binding | docker_create | docker_start | docker_inspect | docker_exec | prisma | sql_gate) return 0 ;; *) return 1 ;; esac
}

pm_migration_executable_category_is_safe() {
  case ${1:-} in not_observed | shell_builtin | coreutils | docker_cli | posix_shell | prisma_cli | postgres_client) return 0 ;; *) return 1 ;; esac
}

pm_migration_state_is_safe() {
  case ${1:-} in not_observed | command_not_started | created | running | exited | unavailable) return 0 ;; *) return 1 ;; esac
}

pm_migration_enter_check() {
  local __pm_check=${1:-} __pm_substep=${2:-} __pm_role=${3:-}
  local __pm_command_category=${4:-} __pm_executable_category=${5:-}
  pm_migration_check_id_is_safe "$__pm_check" && pm_migration_substep_is_safe "$__pm_substep" && \
    pm_migration_role_is_safe "$__pm_role" && pm_migration_command_category_is_safe "$__pm_command_category" && \
    pm_migration_executable_category_is_safe "$__pm_executable_category" || {
      PROBE_ERROR_CLASSIFICATION=MIGRATION_INTERNAL_VALIDATOR_FAILED
      return 64
    }
  MIGRATION_CHECK_ID=$__pm_check
  MIGRATION_SUBSTEP=$__pm_substep
  MIGRATION_RUNNER_ROLE=$__pm_role
  MIGRATION_COMMAND_CATEGORY=$__pm_command_category
  MIGRATION_EXECUTABLE_CATEGORY=$__pm_executable_category
  MIGRATION_COMMAND_STARTED=false
  MIGRATION_ATTEMPT_COUNT=0
  MIGRATION_ELAPSED_SECONDS=0
  MIGRATION_ORIGINAL_EXIT=not_observed
  MIGRATION_CONTAINER_STATE_CATEGORY=command_not_started
  MIGRATION_PRIMARY_CLASSIFICATION=NONE
  PROBE_ERROR_CLASSIFICATION=NONE
}

pm_migration_record_failure() {
  local __pm_classification=${1:-} __pm_exit=${2:-1} __pm_state=${3:-not_observed}
  pm_migration_classification_is_safe "$__pm_classification" || __pm_classification=MIGRATION_INTERNAL_VALIDATOR_FAILED
  [[ $__pm_exit =~ ^[1-9][0-9]*$ && $__pm_exit -le 255 ]] || __pm_exit=1
  pm_migration_state_is_safe "$__pm_state" || __pm_state=not_observed
  if [[ $MIGRATION_PRIMARY_CLASSIFICATION == NONE ]]; then
    MIGRATION_PRIMARY_CLASSIFICATION=$__pm_classification
    MIGRATION_ORIGINAL_EXIT=$__pm_exit
    MIGRATION_CONTAINER_STATE_CATEGORY=$__pm_state
  fi
  PROBE_ERROR_CLASSIFICATION=$MIGRATION_PRIMARY_CLASSIFICATION
  return "$MIGRATION_ORIGINAL_EXIT"
}

pm_migration_reject_before_command() {
  local __pm_check=${1:-} __pm_substep=${2:-} __pm_role=${3:-} __pm_category=${4:-}
  local __pm_executable=${5:-} __pm_classification=${6:-MIGRATION_COMMAND_NOT_STARTED} __pm_exit=${7:-64}
  pm_migration_enter_check "$__pm_check" "$__pm_substep" "$__pm_role" "$__pm_category" "$__pm_executable" || return
  pm_migration_record_failure "$__pm_classification" "$__pm_exit" command_not_started
}

pm_migration_mark_started() {
  MIGRATION_COMMAND_STARTED=true
  MIGRATION_ATTEMPT_COUNT=$((MIGRATION_ATTEMPT_COUNT + 1))
  MIGRATION_CONTAINER_STATE_CATEGORY=not_observed
}

pm_migration_finish_success() {
  MIGRATION_ORIGINAL_EXIT=0
  MIGRATION_PRIMARY_CLASSIFICATION=NONE
  PROBE_ERROR_CLASSIFICATION=NONE
}

pm_migration_run_bounded() {
  local __pm_check=$1 __pm_substep=$2 __pm_role=$3 __pm_category=$4 __pm_executable=$5
  local __pm_seconds=$6 __pm_timeout_class=$7 __pm_failure_class=$8
  local __pm_started __pm_status
  shift 8
  pm_migration_enter_check "$__pm_check" "$__pm_substep" "$__pm_role" "$__pm_category" "$__pm_executable" || return
  pm_migration_mark_started
  __pm_started=$SECONDS
  if pm_run_bounded disposable_migration "$__pm_seconds" "$__pm_timeout_class" "$__pm_failure_class" "$@"; then
    __pm_status=0
  else
    __pm_status=$?
  fi
  MIGRATION_ELAPSED_SECONDS=$((SECONDS - __pm_started))
  if (( __pm_status == 0 )); then pm_migration_finish_success; return 0; fi
  pm_migration_record_failure "${PROBE_ERROR_CLASSIFICATION:-$__pm_failure_class}" "$__pm_status" not_observed
}

pm_migration_load_prisma_diff_facts() {
  local __pm_path=${1:-} __pm_summary=''
  [[ -f $__pm_path && ! -L $__pm_path ]] || return 74
  if ! __pm_summary=$(jq -cer '
      if (.schemaVersion==1 and
      (.rawByteCount|type)=="number" and .rawByteCount>=0 and .rawByteCount==(.rawByteCount|floor) and
      .sizeLimitBytes==4096 and
      (.nonCommentStatementCount|type)=="number" and .nonCommentStatementCount>=0 and
      (.alterTableCount|type)=="number" and .alterTableCount>=0 and
      (.affectedTableCount|type)=="number" and .affectedTableCount>=0 and
      ([.expectedTablePresent,.submittedPhoneAddPresent,.submittedPhoneAtAddPresent,
        .unexpectedTablePresent,.unexpectedColumnPresent,.unexpectedOperationPresent,
        .defaultPresent,.constraintPresent,.indexPresent,.defaultConstraintIndexPresent,
        .utf8Valid,.commentsBalanced,.quotesBalanced,.statementTerminationValid,
        .schemaQualificationObserved,.factsFileCreated,.factsFileLoaded,
        .rawDiffRetained,.rawSqlCaptured]|all(type=="boolean")) and
      .factsFileCreated==true and .factsFileLoaded==false and
      (.transactionWrapperState|IN("NOT_OBSERVED","ABSENT","VALID","INVALID")) and
      (.identifierFormCategory|IN("NOT_OBSERVED","UNQUALIFIED_QUOTED","QUALIFIED_QUOTED",
        "QUALIFIED_MIXED","MIXED")) and
      (.parserFailureStage|IN("NONE","INPUT_VALIDATION","INPUT_DECODE","COMMENT_LEXING",
        "STATEMENT_LEXING","TRANSACTION_WRAPPER","ALTER_TABLE_PARSING","IDENTIFIER_PARSING",
        "CLAUSE_PARSING","FACTS_OUTPUT","FACTS_SCHEMA","PARSER_LAUNCH","INTERNAL")) and
      (.parserFailureCode|IN("NONE","INPUT_MISSING","INPUT_SYMLINK","INPUT_NOT_REGULAR",
        "INPUT_TOO_LARGE","INPUT_UTF8_INVALID","COMMENT_UNTERMINATED","QUOTE_UNTERMINATED",
        "STATEMENT_UNTERMINATED","TRANSACTION_WRAPPER_INVALID","ALTER_TABLE_SYNTAX_UNSUPPORTED",
        "IDENTIFIER_SYNTAX_UNSUPPORTED","CLAUSE_SYNTAX_UNSUPPORTED","FACTS_OUTPUT_EXISTS",
        "FACTS_OUTPUT_WRITE_FAILED","FACTS_SCHEMA_REJECTED","PARSER_LAUNCH_FAILED",
        "PARSER_INTERNAL_FAILURE")) and
      (.parserResult|IN("ACCEPTED","REJECTED","PARSE_FAILED","EMPTY")) and
      (.normalizedSemanticSha256|test("^[0-9a-f]{64}$")) and
      .expectedSemanticMode=="LEGACY_TWO_COLUMN_DRIFT_EXPECTED" and
      (.finalGateClassification|IN(
        "MIGRATION_PRISMA_DIFF_EMPTY_UNEXPECTED","MIGRATION_PRISMA_DIFF_REQUIRED_EMPTY",
        "MIGRATION_PRISMA_DIFF_PARSE_FAILED","MIGRATION_PRISMA_DIFF_UNEXPECTED_TABLE",
        "MIGRATION_PRISMA_DIFF_UNEXPECTED_COLUMN","MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION",
        "MIGRATION_PRISMA_DIFF_TYPE_MISMATCH","MIGRATION_PRISMA_DIFF_REQUIRED_COLUMN_MISSING",
        "MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT","MIGRATION_PRISMA_DIFF_EMPTY_ACCEPTED",
        "MIGRATION_PRISMA_DIFF_INPUT_MISSING","MIGRATION_PRISMA_DIFF_INPUT_SYMLINK",
        "MIGRATION_PRISMA_DIFF_INPUT_NOT_REGULAR","MIGRATION_PRISMA_DIFF_INPUT_TOO_LARGE",
        "MIGRATION_PRISMA_DIFF_INPUT_UTF8_INVALID","MIGRATION_PRISMA_DIFF_COMMENT_UNTERMINATED",
        "MIGRATION_PRISMA_DIFF_QUOTE_UNTERMINATED","MIGRATION_PRISMA_DIFF_STATEMENT_UNTERMINATED",
        "MIGRATION_PRISMA_DIFF_TRANSACTION_WRAPPER_INVALID",
        "MIGRATION_PRISMA_DIFF_ALTER_TABLE_SYNTAX_UNSUPPORTED",
        "MIGRATION_PRISMA_DIFF_IDENTIFIER_SYNTAX_UNSUPPORTED",
        "MIGRATION_PRISMA_DIFF_CLAUSE_SYNTAX_UNSUPPORTED",
        "MIGRATION_PRISMA_DIFF_FACTS_OUTPUT_EXISTS","MIGRATION_PRISMA_DIFF_FACTS_OUTPUT_WRITE_FAILED",
        "MIGRATION_PRISMA_DIFF_FACTS_SCHEMA_REJECTED","MIGRATION_PRISMA_DIFF_PARSER_INTERNAL_FAILURE")) and
      .rawDiffRetained==false and .rawSqlCaptured==false) then {
          rawByteCount:.rawByteCount,sizeLimitBytes:.sizeLimitBytes,utf8Valid:.utf8Valid,
          commentsBalanced:.commentsBalanced,quotesBalanced:.quotesBalanced,
          statementTerminationValid:.statementTerminationValid,
          transactionWrapperState:.transactionWrapperState,
          schemaQualificationObserved:.schemaQualificationObserved,
          identifierFormCategory:.identifierFormCategory,factsFileCreated:.factsFileCreated,
          factsFileLoaded:true,parserFailureStage:.parserFailureStage,
          parserFailureCode:.parserFailureCode,statementCount:.nonCommentStatementCount,
          alterTableCount:.alterTableCount,affectedTableCount:.affectedTableCount,
          expectedTablePresent:.expectedTablePresent,submittedPhoneAddPresent:.submittedPhoneAddPresent,
          submittedPhoneAtAddPresent:.submittedPhoneAtAddPresent,
          unexpectedTablePresent:.unexpectedTablePresent,unexpectedColumnPresent:.unexpectedColumnPresent,
          unexpectedOperationPresent:.unexpectedOperationPresent,defaultPresent:.defaultPresent,
          constraintPresent:.constraintPresent,indexPresent:.indexPresent,
          defaultConstraintIndexPresent:.defaultConstraintIndexPresent,parserResult:.parserResult,
          normalizedSemanticSha256:.normalizedSemanticSha256,expectedSemanticMode:.expectedSemanticMode,
          finalGateClassification:.finalGateClassification
        } else error("unsafe facts") end' "$__pm_path" 2>/dev/null); then
    return 76
  fi
  MIGRATION_PRISMA_DIFF_RAW_BYTE_COUNT=$(jq -r '.rawByteCount' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_SIZE_LIMIT_BYTES=$(jq -r '.sizeLimitBytes' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_UTF8_VALID=$(jq -r '.utf8Valid' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_COMMENTS_BALANCED=$(jq -r '.commentsBalanced' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_QUOTES_BALANCED=$(jq -r '.quotesBalanced' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_STATEMENT_TERMINATION_VALID=$(jq -r '.statementTerminationValid' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_TRANSACTION_WRAPPER_STATE=$(jq -r '.transactionWrapperState' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_SCHEMA_QUALIFICATION_OBSERVED=$(jq -r '.schemaQualificationObserved' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_IDENTIFIER_FORM_CATEGORY=$(jq -r '.identifierFormCategory' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_FACTS_FILE_CREATED=$(jq -r '.factsFileCreated' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_FACTS_FILE_LOADED=$(jq -r '.factsFileLoaded' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_PARSER_FAILURE_STAGE=$(jq -r '.parserFailureStage' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_PARSER_FAILURE_CODE=$(jq -r '.parserFailureCode' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_STATEMENT_COUNT=$(jq -r '.statementCount' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_ALTER_TABLE_COUNT=$(jq -r '.alterTableCount' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_AFFECTED_TABLE_COUNT=$(jq -r '.affectedTableCount' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_EXPECTED_TABLE_PRESENT=$(jq -r '.expectedTablePresent' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_SUBMITTED_PHONE_PRESENT=$(jq -r '.submittedPhoneAddPresent' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_SUBMITTED_PHONE_AT_PRESENT=$(jq -r '.submittedPhoneAtAddPresent' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_UNEXPECTED_TABLE_PRESENT=$(jq -r '.unexpectedTablePresent' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_UNEXPECTED_COLUMN_PRESENT=$(jq -r '.unexpectedColumnPresent' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION_PRESENT=$(jq -r '.unexpectedOperationPresent' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_DEFAULT_PRESENT=$(jq -r '.defaultPresent' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_CONSTRAINT_PRESENT=$(jq -r '.constraintPresent' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_INDEX_PRESENT=$(jq -r '.indexPresent' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_DEFAULT_CONSTRAINT_INDEX_PRESENT=$(jq -r '.defaultConstraintIndexPresent' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_PARSER_RESULT=$(jq -r '.parserResult' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_NORMALIZED_SEMANTIC_SHA256=$(jq -r '.normalizedSemanticSha256' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_EXPECTED_SEMANTIC_MODE=$(jq -r '.expectedSemanticMode' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_FINAL_GATE_CLASSIFICATION=$(jq -r '.finalGateClassification' <<<"$__pm_summary")
  MIGRATION_PRISMA_DIFF_FACTS_OBSERVED=true
}

pm_migration_set_prisma_diff_transport_failure() {
  local __pm_status=${1:-70} __pm_diff=${2:-} __pm_size=0
  if [[ -f $__pm_diff && ! -L $__pm_diff ]]; then
    __pm_size=$(stat -c %s -- "$__pm_diff" 2>/dev/null || printf 0)
    [[ $__pm_size =~ ^[0-9]+$ ]] || __pm_size=0
  fi
  MIGRATION_PRISMA_DIFF_RAW_BYTE_COUNT=$__pm_size
  MIGRATION_PRISMA_DIFF_SIZE_LIMIT_BYTES=4096
  MIGRATION_PRISMA_DIFF_FACTS_FILE_CREATED=false
  MIGRATION_PRISMA_DIFF_FACTS_FILE_LOADED=false
  case $__pm_status in
    69)
      MIGRATION_PRISMA_DIFF_PARSER_FAILURE_STAGE=PARSER_LAUNCH
      MIGRATION_PRISMA_DIFF_PARSER_FAILURE_CODE=PARSER_LAUNCH_FAILED
      MIGRATION_PRISMA_DIFF_FINAL_GATE_CLASSIFICATION=MIGRATION_PRISMA_DIFF_PARSER_LAUNCH_FAILED ;;
    74)
      MIGRATION_PRISMA_DIFF_PARSER_FAILURE_STAGE=FACTS_OUTPUT
      MIGRATION_PRISMA_DIFF_PARSER_FAILURE_CODE=FACTS_OUTPUT_WRITE_FAILED
      MIGRATION_PRISMA_DIFF_FINAL_GATE_CLASSIFICATION=MIGRATION_PRISMA_DIFF_FACTS_OUTPUT_WRITE_FAILED ;;
    76)
      MIGRATION_PRISMA_DIFF_PARSER_FAILURE_STAGE=FACTS_SCHEMA
      MIGRATION_PRISMA_DIFF_PARSER_FAILURE_CODE=FACTS_SCHEMA_REJECTED
      MIGRATION_PRISMA_DIFF_FINAL_GATE_CLASSIFICATION=MIGRATION_PRISMA_DIFF_FACTS_SCHEMA_REJECTED ;;
    *)
      MIGRATION_PRISMA_DIFF_PARSER_FAILURE_STAGE=INTERNAL
      MIGRATION_PRISMA_DIFF_PARSER_FAILURE_CODE=PARSER_INTERNAL_FAILURE
      MIGRATION_PRISMA_DIFF_FINAL_GATE_CLASSIFICATION=MIGRATION_PRISMA_DIFF_PARSER_INTERNAL_FAILURE ;;
  esac
  MIGRATION_PRISMA_DIFF_PARSER_RESULT=PARSE_FAILED
}

pm_migration_run_prisma_diff_gate() {
  local __pm_diff=${1:-} __pm_facts=${2:-} __pm_gate=${3:-}
  local __pm_started __pm_status __pm_classification=MIGRATION_PRISMA_DIFF_PARSE_FAILED
  local __pm_facts_candidate=$__pm_facts
  pm_migration_enter_check MIGRATION_PRISMA_DIFF_GATE_CHECK prisma_diff_gate \
    prisma_diff internal_validator posix_shell || return
  pm_migration_mark_started
  __pm_started=$SECONDS
  if pm_run_bounded disposable_migration 60 PRISMA_DIFF_TIMEOUT MIGRATION_PRISMA_DIFF_PARSE_FAILED \
      sh "$__pm_gate" "$__pm_diff" "$__pm_facts" >/dev/null; then
    __pm_status=0
  else
    __pm_status=$?
  fi
  MIGRATION_ELAPSED_SECONDS=$((SECONDS - __pm_started))
  if (( __pm_status == 124 )); then
    pm_migration_record_failure PRISMA_DIFF_TIMEOUT 124 not_observed
    return
  fi
  if (( __pm_status == 73 )) && [[ -f $__pm_facts.failure && ! -L $__pm_facts.failure ]]; then
    __pm_facts_candidate=$__pm_facts.failure
  fi
  if pm_migration_load_prisma_diff_facts "$__pm_facts_candidate"; then
    __pm_classification=$MIGRATION_PRISMA_DIFF_FINAL_GATE_CLASSIFICATION
  else
    if (( __pm_status == 0 || __pm_status == 65 || __pm_status == 73 )); then __pm_status=76; fi
    pm_migration_set_prisma_diff_transport_failure "$__pm_status" "$__pm_diff"
    __pm_classification=$MIGRATION_PRISMA_DIFF_FINAL_GATE_CLASSIFICATION
  fi
  if (( __pm_status == 0 )) && [[ $__pm_classification == MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT ]]; then
    pm_migration_finish_success
    return 0
  fi
  (( __pm_status != 0 )) || __pm_status=74
  pm_migration_record_failure "$__pm_classification" "$__pm_status" not_observed
}

pm_migration_capture_bounded() {
  local __pm_target=$1 __pm_check=$2 __pm_substep=$3 __pm_role=$4 __pm_category=$5 __pm_executable=$6
  local __pm_seconds=$7 __pm_timeout_class=$8 __pm_failure_class=$9
  local __pm_started __pm_status
  shift 9
  pm_migration_enter_check "$__pm_check" "$__pm_substep" "$__pm_role" "$__pm_category" "$__pm_executable" || return
  pm_migration_mark_started
  __pm_started=$SECONDS
  if pm_capture_bounded "$__pm_target" disposable_migration "$__pm_seconds" "$__pm_timeout_class" "$__pm_failure_class" "$@"; then
    __pm_status=0
  else
    __pm_status=$?
  fi
  MIGRATION_ELAPSED_SECONDS=$((SECONDS - __pm_started))
  if (( __pm_status == 0 )); then pm_migration_finish_success; return 0; fi
  if (( __pm_status == 125 )); then __pm_failure_class=MIGRATION_DOCKER_CLI_FAILED; fi
  pm_migration_record_failure "$__pm_failure_class" "$__pm_status" command_not_started
}

pm_migration_write_bounded() {
  local __pm_target=$1 __pm_check=$2 __pm_substep=$3 __pm_role=$4 __pm_category=$5 __pm_executable=$6
  local __pm_seconds=$7 __pm_timeout_class=$8 __pm_failure_class=$9
  local __pm_started __pm_status
  shift 9
  pm_migration_enter_check "$__pm_check" "$__pm_substep" "$__pm_role" "$__pm_category" "$__pm_executable" || return
  pm_migration_mark_started
  __pm_started=$SECONDS
  if pm_write_bounded "$__pm_target" disposable_migration "$__pm_seconds" "$__pm_timeout_class" "$__pm_failure_class" "$@"; then
    __pm_status=0
  else
    __pm_status=$?
  fi
  MIGRATION_ELAPSED_SECONDS=$((SECONDS - __pm_started))
  if (( __pm_status == 0 )); then pm_migration_finish_success; return 0; fi
  if (( __pm_status == 125 )); then __pm_failure_class=MIGRATION_DOCKER_CLI_FAILED; fi
  pm_migration_record_failure "$__pm_failure_class" "$__pm_status" not_observed
}

pm_migration_mode_allows_read() {
  local __pm_file_uid=${1:-} __pm_file_gid=${2:-} __pm_mode=${3:-}
  local __pm_runtime_uid=${4:-} __pm_runtime_gid=${5:-} __pm_digit
  [[ $__pm_file_uid =~ ^[0-9]+$ && $__pm_file_gid =~ ^[0-9]+$ && $__pm_mode =~ ^[0-7]{3,4}$ && \
    $__pm_runtime_uid =~ ^[0-9]+$ && $__pm_runtime_gid =~ ^[0-9]+$ ]] || return 64
  __pm_mode=${__pm_mode: -3}
  if [[ $__pm_file_uid == "$__pm_runtime_uid" ]]; then __pm_digit=${__pm_mode:0:1}
  elif [[ $__pm_file_gid == "$__pm_runtime_gid" ]]; then __pm_digit=${__pm_mode:1:1}
  else __pm_digit=${__pm_mode:2:1}
  fi
  (( (10#$__pm_digit & 4) == 4 ))
}

pm_migration_prepare_runtime_file() {
  local __pm_source=${1:-} __pm_target=${2:-} __pm_expected_sha=${3:-}
  local __pm_runtime_uid=${4:-} __pm_runtime_gid=${5:-} __pm_observed_sha='' __pm_stat=''
  pm_migration_enter_check MIGRATION_RUNTIME_BINDING_CHECK runtime_file_binding sql_gate filesystem_binding coreutils || return
  if [[ ! -f $__pm_source || -L $__pm_source || -e $__pm_target || -L $__pm_target || ! $__pm_expected_sha =~ ^[0-9a-f]{64}$ ]]; then
    pm_migration_record_failure MIGRATION_COMMAND_NOT_STARTED 64 command_not_started
    return
  fi
  pm_migration_mark_started
  if ! pm_capture_bounded_internal __pm_observed_sha filesystem_metadata 30 METADATA_TIMEOUT METADATA_FAILED \
      sha256sum -- "$__pm_source"; then
    pm_migration_record_failure MIGRATION_SQL_BINDING_MISMATCH 66 command_not_started
    return
  fi
  __pm_observed_sha=${__pm_observed_sha%% *}
  if [[ $__pm_observed_sha != "$__pm_expected_sha" ]]; then
    pm_migration_record_failure MIGRATION_SQL_BINDING_MISMATCH 66 command_not_started
    return
  fi
  if ! pm_run_bounded filesystem_metadata 30 METADATA_TIMEOUT METADATA_FAILED cp -- "$__pm_source" "$__pm_target" || \
      ! pm_run_bounded filesystem_metadata 30 METADATA_TIMEOUT METADATA_FAILED chmod 0444 "$__pm_target" || \
      ! pm_capture_bounded_internal __pm_stat filesystem_metadata 30 METADATA_TIMEOUT METADATA_FAILED stat -Lc '%u:%g:%a' "$__pm_target"; then
    pm_migration_record_failure MIGRATION_RUNTIME_FILE_UNREADABLE 74 command_not_started
    return
  fi
  local __pm_uid __pm_rest __pm_gid __pm_mode
  __pm_uid=${__pm_stat%%:*}
  __pm_rest=${__pm_stat#*:}
  __pm_gid=${__pm_rest%%:*}
  __pm_mode=${__pm_rest##*:}
  if ! pm_migration_mode_allows_read "$__pm_uid" "$__pm_gid" "$__pm_mode" "$__pm_runtime_uid" "$__pm_runtime_gid"; then
    pm_migration_record_failure MIGRATION_RUNTIME_FILE_UNREADABLE 77 command_not_started
    return
  fi
  pm_migration_finish_success
}

pm_migration_build_database_url() {
  local __pm_target=${1:-} __pm_user=${2:-} __pm_password=${3:-} __pm_host=${4:-} __pm_database=${5:-}
  pm_migration_enter_check MIGRATION_DATABASE_URL_CONSTRUCTION_CHECK database_url_construction host_validator internal_validator shell_builtin || return
  if ! pm_validate_out_name "$__pm_target" || [[ ! $__pm_user =~ ^[a-z0-9_]+$ || ! $__pm_password =~ ^[0-9a-f]{64}$ || \
      ! $__pm_host =~ ^[a-z0-9-]+$ || ! $__pm_database =~ ^[a-z0-9_]+$ ]]; then
    pm_migration_record_failure MIGRATION_DATABASE_URL_CONSTRUCTION_FAILED 64 command_not_started
    return
  fi
  pm_assign_out "$__pm_target" "postgresql://$__pm_user:$__pm_password@$__pm_host:5432/$__pm_database?schema=public" || {
    pm_migration_record_failure MIGRATION_DATABASE_URL_CONSTRUCTION_FAILED 64 command_not_started
    return
  }
  pm_migration_finish_success
}

pm_migration_validate_alias_facts() {
  local __pm_facts=${1-} __pm_network=${2:-} __pm_alias=${3:-}
  local __pm_summary='' __pm_alias_state __pm_alias_count
  pm_migration_enter_check MIGRATION_POSTGRES_ALIAS_CHECK postgres_alias_validation postgres internal_validator docker_cli || return
  pm_migration_mark_started
  MIGRATION_POSTGRES_NETWORK_FACTS_OBSERVED=false
  MIGRATION_POSTGRES_OBSERVED_NETWORK_COUNT=0
  MIGRATION_POSTGRES_EXPECTED_NETWORK_PRESENT=false
  MIGRATION_POSTGRES_ALIAS_ARRAY_PRESENT=false
  MIGRATION_POSTGRES_EXPECTED_ALIAS_PRESENT=false
  MIGRATION_POSTGRES_UNEXPECTED_NETWORK_PRESENT=false
  MIGRATION_POSTGRES_CONTAINER_RUNNING=false
  MIGRATION_POSTGRES_ALIAS_VALIDATION_CLASSIFICATION=NONE
  if [[ ! $__pm_network =~ ^personal-max-stage8b1i-[0-9a-f]{12}-internal$ || \
      ! $__pm_alias =~ ^personal-max-stage8b1i-[0-9a-f]{12}-postgres-dns$ ]]; then
    MIGRATION_POSTGRES_ALIAS_VALIDATION_CLASSIFICATION=MIGRATION_POSTGRES_NETWORK_FACTS_MALFORMED
    pm_migration_record_failure MIGRATION_POSTGRES_NETWORK_FACTS_MALFORMED 65 command_not_started
    return
  fi
  if ! __pm_summary=$(jq -cer --arg expectedNetwork "$__pm_network" --arg expectedAlias "$__pm_alias" '
      if type!="object" or (.running|type)!="boolean" or (.networks|type)!="object" or
          any(.networks|to_entries[]; (.value|type)!="object") then error("malformed") else
        (.networks|keys) as $names |
        (.networks|has($expectedNetwork)) as $expectedNetworkPresent |
        (if $expectedNetworkPresent then .networks[$expectedNetwork] else {} end) as $endpoint |
        (if $expectedNetworkPresent and ($endpoint|has("Aliases")) then
           if $endpoint.Aliases==null then "null"
           elif ($endpoint.Aliases|type)=="array" and all($endpoint.Aliases[]; type=="string") then "array"
           else error("malformed") end
         else "missing" end) as $aliasState |
        {running:.running,observedNetworkCount:($names|length),
         expectedNetworkPresent:$expectedNetworkPresent,
         unexpectedNetworkPresent:any($names[]; .!=$expectedNetwork),aliasState:$aliasState,
         aliasCount:(if $aliasState=="array" then ($endpoint.Aliases|length) else 0 end),
         expectedAliasPresent:(if $aliasState=="array" then any($endpoint.Aliases[]; .==$expectedAlias) else false end)}
      end' <<<"$__pm_facts" 2>/dev/null) || [[ -z $__pm_summary ]]; then
    MIGRATION_POSTGRES_ALIAS_VALIDATION_CLASSIFICATION=MIGRATION_POSTGRES_NETWORK_FACTS_MALFORMED
    pm_migration_record_failure MIGRATION_POSTGRES_NETWORK_FACTS_MALFORMED 65 not_observed
    return
  fi
  MIGRATION_POSTGRES_NETWORK_FACTS_OBSERVED=true
  MIGRATION_POSTGRES_OBSERVED_NETWORK_COUNT=$(jq -r '.observedNetworkCount' <<<"$__pm_summary")
  MIGRATION_POSTGRES_EXPECTED_NETWORK_PRESENT=$(jq -r '.expectedNetworkPresent' <<<"$__pm_summary")
  MIGRATION_POSTGRES_UNEXPECTED_NETWORK_PRESENT=$(jq -r '.unexpectedNetworkPresent' <<<"$__pm_summary")
  MIGRATION_POSTGRES_CONTAINER_RUNNING=$(jq -r '.running' <<<"$__pm_summary")
  __pm_alias_state=$(jq -r '.aliasState' <<<"$__pm_summary")
  __pm_alias_count=$(jq -r '.aliasCount' <<<"$__pm_summary")
  MIGRATION_POSTGRES_ALIAS_ARRAY_PRESENT=false
  [[ $__pm_alias_state == array ]] && MIGRATION_POSTGRES_ALIAS_ARRAY_PRESENT=true
  MIGRATION_POSTGRES_EXPECTED_ALIAS_PRESENT=$(jq -r '.expectedAliasPresent' <<<"$__pm_summary")
  MIGRATION_CONTAINER_STATE_CATEGORY=running
  if [[ $MIGRATION_POSTGRES_CONTAINER_RUNNING != true ]]; then
    MIGRATION_POSTGRES_ALIAS_VALIDATION_CLASSIFICATION=MIGRATION_CONTAINER_UNAVAILABLE
    pm_migration_record_failure MIGRATION_CONTAINER_UNAVAILABLE 69 unavailable
    return
  fi
  if (( MIGRATION_POSTGRES_OBSERVED_NETWORK_COUNT == 0 )); then
    MIGRATION_POSTGRES_ALIAS_VALIDATION_CLASSIFICATION=MIGRATION_POSTGRES_NETWORK_MISSING
    pm_migration_record_failure MIGRATION_POSTGRES_NETWORK_MISSING 65 running
    return
  fi
  if [[ $MIGRATION_POSTGRES_UNEXPECTED_NETWORK_PRESENT == true ]] || (( MIGRATION_POSTGRES_OBSERVED_NETWORK_COUNT != 1 )); then
    MIGRATION_POSTGRES_ALIAS_VALIDATION_CLASSIFICATION=MIGRATION_POSTGRES_UNEXPECTED_NETWORK
    pm_migration_record_failure MIGRATION_POSTGRES_UNEXPECTED_NETWORK 65 running
    return
  fi
  if [[ $MIGRATION_POSTGRES_EXPECTED_NETWORK_PRESENT != true ]]; then
    MIGRATION_POSTGRES_ALIAS_VALIDATION_CLASSIFICATION=MIGRATION_POSTGRES_NETWORK_MISSING
    pm_migration_record_failure MIGRATION_POSTGRES_NETWORK_MISSING 65 running
    return
  fi
  if [[ $__pm_alias_state == missing || $__pm_alias_state == null ]]; then
    MIGRATION_POSTGRES_ALIAS_VALIDATION_CLASSIFICATION=MIGRATION_POSTGRES_ALIAS_ARRAY_MISSING
    pm_migration_record_failure MIGRATION_POSTGRES_ALIAS_ARRAY_MISSING 65 running
    return
  fi
  if (( __pm_alias_count == 0 )); then
    MIGRATION_POSTGRES_ALIAS_VALIDATION_CLASSIFICATION=MIGRATION_POSTGRES_ALIAS_MISSING
    pm_migration_record_failure MIGRATION_POSTGRES_ALIAS_MISSING 65 running
    return
  fi
  if [[ $MIGRATION_POSTGRES_EXPECTED_ALIAS_PRESENT != true ]]; then
    MIGRATION_POSTGRES_ALIAS_VALIDATION_CLASSIFICATION=MIGRATION_POSTGRES_ALIAS_MISMATCH
    pm_migration_record_failure MIGRATION_POSTGRES_ALIAS_MISMATCH 65 running
    return
  fi
  MIGRATION_POSTGRES_ALIAS_VALIDATION_CLASSIFICATION=NONE
  pm_migration_finish_success
}

pm_migration_validate_runner_identity() {
  local __pm_facts=${1-} __pm_expected_image=${2:-} __pm_expected_user=${3:-} __pm_expected_network=${4:-}
  local __pm_role=${5:-sql_gate} __pm_check __pm_substep
  case $__pm_role in
    sql_gate) __pm_check=MIGRATION_SQL_RUNNER_IDENTITY_CHECK; __pm_substep=sql_runner_identity ;;
    prisma_deploy) __pm_check=MIGRATION_PRISMA_RUNNER_IDENTITY_CHECK; __pm_substep=prisma_runner_identity ;;
    *) return 64 ;;
  esac
  pm_migration_enter_check "$__pm_check" "$__pm_substep" "$__pm_role" internal_validator docker_cli || return
  if [[ $__pm_facts != "$__pm_expected_image|$__pm_expected_user|$__pm_expected_network" ]]; then
    if [[ ${__pm_facts##*|} != "$__pm_expected_network" ]]; then
      pm_migration_record_failure MIGRATION_RUNNER_NETWORK_MISMATCH 65 created
    else
      pm_migration_record_failure MIGRATION_RUNNER_IDENTITY_MISMATCH 65 created
    fi
    return
  fi
  MIGRATION_CONTAINER_STATE_CATEGORY=created
  pm_migration_finish_success
}

pm_migration_create_runner() {
  local __pm_target=$1 __pm_check=$2 __pm_substep=$3 __pm_role=$4
  local __pm_status
  shift 4
  if pm_migration_capture_bounded "$__pm_target" "$__pm_check" "$__pm_substep" "$__pm_role" docker_create docker_cli \
      120 MIGRATION_RUNNER_CREATE_FAILED MIGRATION_RUNNER_CREATE_FAILED "$@"; then
    MIGRATION_CONTAINER_STATE_CATEGORY=created
    return 0
  else
    __pm_status=$?
    return "$__pm_status"
  fi
}

pm_migration_psql_value() {
  local __pm_target=${1:-} __pm_check=${2:-} __pm_substep=${3:-} __pm_query=${4-}
  local __pm_failure_class=${5:-MIGRATION_POST_VERIFICATION_FAILED}
  local __pm_started __pm_status __pm_had_errexit=false
  case $__pm_check:$__pm_substep in
    MIGRATION_POST_LEDGER_CHECK:post_ledger_verification | MIGRATION_POST_SCHEMA_CHECK:post_schema_verification | \
    MIGRATION_POST_FINISHED_COUNT_CHECK:post_finished_count | MIGRATION_POST_FAILED_COUNT_CHECK:post_failed_count | \
    MIGRATION_POST_LEDGER_NAMES_CHECK:post_ledger_names | MIGRATION_DURATION_QUERY_CHECK:duration_query | \
    MIGRATION_SCHEMA_TABLE_QUERY_CHECK:schema_table_query | MIGRATION_SCHEMA_COLUMN_QUERY_CHECK:schema_column_query | \
    MIGRATION_SCHEMA_INDEX_QUERY_CHECK:schema_index_query | MIGRATION_SCHEMA_UNIQUE_KEY_QUERY_CHECK:schema_unique_key_query) ;;
    *) return 64 ;;
  esac
  pm_migration_classification_is_safe "$__pm_failure_class" || return 64
  pm_migration_enter_check "$__pm_check" "$__pm_substep" postgres docker_exec postgres_client || return
  pm_migration_mark_started
  __pm_started=$SECONDS
  [[ $- == *e* ]] && __pm_had_errexit=true
  set +e
  psql_value "$__pm_target" "$__pm_query"
  __pm_status=$?
  pm_restore_errexit "$__pm_had_errexit"
  MIGRATION_ELAPSED_SECONDS=$((SECONDS - __pm_started))
  if (( __pm_status == 0 )); then pm_migration_finish_success; return 0; fi
  pm_migration_record_failure "$__pm_failure_class" "$__pm_status" running
}

pm_migration_runner_exit_classification() {
  local __pm_role=${1:-} __pm_exit=${2:-1}
  case "$__pm_role:$__pm_exit" in
    sql_gate:1 | sql_gate:64 | sql_gate:67) printf '%s' MIGRATION_SQL_BINDING_MISMATCH ;;
    sql_gate:2) printf '%s' MIGRATION_SQL_GATE_EXIT_2 ;;
    sql_gate:66) printf '%s' MIGRATION_DIRECTORY_MISSING ;;
    prisma_deploy:127) printf '%s' MIGRATION_PRISMA_EXECUTABLE_MISSING ;;
    prisma_deploy:126) printf '%s' MIGRATION_PRISMA_COMMAND_REJECTED ;;
    prisma_deploy:1) printf '%s' MIGRATION_PRISMA_EXIT_1 ;;
    prisma_deploy:2) printf '%s' MIGRATION_PRISMA_EXIT_2 ;;
    prisma_deploy:*) printf '%s' MIGRATION_DEPLOY_FAILED ;;
    *) printf '%s' MIGRATION_RUNNER_EXITED ;;
  esac
}

pm_migration_start_runner() {
  local __pm_container=${1:-} __pm_role=${2:-} __pm_output_path=${3:-/dev/null}
  local __pm_check __pm_substep __pm_timeout_class __pm_seconds __pm_started __pm_status __pm_observed='' __pm_state __pm_exit __pm_extra __pm_classification
  local __pm_had_errexit=false
  case $__pm_role in
    sql_gate) __pm_check=MIGRATION_SQL_RUNNER_START_CHECK; __pm_substep=sql_runner_start; __pm_timeout_class=MIGRATION_RUNNER_START_FAILED; __pm_seconds=120 ;;
    prisma_deploy) __pm_check=MIGRATION_PRISMA_DEPLOY_CHECK; __pm_substep=prisma_deploy; __pm_timeout_class=MIGRATION_PRISMA_TIMEOUT; __pm_seconds=900 ;;
    *) return 64 ;;
  esac
  pm_migration_enter_check "$__pm_check" "$__pm_substep" "$__pm_role" docker_start docker_cli || return
  pm_migration_mark_started
  __pm_started=$SECONDS
  [[ $- == *e* ]] && __pm_had_errexit=true
  set +e
  "$PM_TIMEOUT_BIN" --signal=TERM --kill-after=10s "${__pm_seconds}s" docker start -a "$__pm_container" >"$__pm_output_path" 2>/dev/null
  __pm_status=$?
  pm_restore_errexit "$__pm_had_errexit"
  MIGRATION_ELAPSED_SECONDS=$((SECONDS - __pm_started))
  if (( __pm_status == 124 )); then
    pm_migration_record_failure "$__pm_timeout_class" 124 not_observed
    return
  fi
  if ! pm_capture_bounded_internal __pm_observed docker_metadata 30 METADATA_TIMEOUT METADATA_FAILED \
      docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}' "$__pm_container"; then
    if (( __pm_status == 125 )); then __pm_classification=MIGRATION_DOCKER_CLI_FAILED; else __pm_classification=MIGRATION_CONTAINER_UNAVAILABLE; fi
    pm_migration_record_failure "$__pm_classification" "$((__pm_status == 0 ? 69 : __pm_status))" unavailable
    return
  fi
  IFS='|' read -r __pm_state __pm_exit __pm_extra <<<"$__pm_observed"
  case $__pm_state in created | running | exited) ;; *) __pm_state=unavailable ;; esac
  MIGRATION_CONTAINER_STATE_CATEGORY=$__pm_state
  if (( __pm_status == 0 )) && [[ $__pm_state == exited && $__pm_exit == 0 && -z ${__pm_extra:-} ]]; then
    pm_migration_finish_success
    return 0
  fi
  if [[ $__pm_state == exited && $__pm_exit =~ ^[1-9][0-9]*$ && $__pm_exit -le 255 ]]; then
    __pm_classification=$(pm_migration_runner_exit_classification "$__pm_role" "$__pm_exit")
    pm_migration_record_failure "$__pm_classification" "$__pm_exit" exited
    return
  fi
  pm_migration_record_failure MIGRATION_RUNNER_START_FAILED "$((__pm_status == 0 ? 69 : __pm_status))" "$__pm_state"
}
