#!/usr/bin/env python3
"""Parse a bounded Prisma SQL diff into privacy-safe semantic facts."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
from typing import Any

MAX_BYTES = 4096
MODE_LEGACY = "LEGACY_TWO_COLUMN_DRIFT_EXPECTED"
MODE_EMPTY = "EMPTY_DIFF_EXPECTED"
EXPECTED_SCHEMA = "public"
EXPECTED_TABLE = "DriverTelegram"
EXPECTED_COLUMNS = {
    "submittedPhone": "TEXT",
    "submittedPhoneAt": "TIMESTAMP(3)",
}
QIDENT = r'"(?:[^"]|"")+"'
BARE_IDENT = r"[A-Za-z_][A-Za-z0-9_]*"

FAILURE_CLASSIFICATIONS = {
    "INPUT_MISSING": "MIGRATION_PRISMA_DIFF_INPUT_MISSING",
    "INPUT_SYMLINK": "MIGRATION_PRISMA_DIFF_INPUT_SYMLINK",
    "INPUT_NOT_REGULAR": "MIGRATION_PRISMA_DIFF_INPUT_NOT_REGULAR",
    "INPUT_TOO_LARGE": "MIGRATION_PRISMA_DIFF_INPUT_TOO_LARGE",
    "INPUT_UTF8_INVALID": "MIGRATION_PRISMA_DIFF_INPUT_UTF8_INVALID",
    "COMMENT_UNTERMINATED": "MIGRATION_PRISMA_DIFF_COMMENT_UNTERMINATED",
    "QUOTE_UNTERMINATED": "MIGRATION_PRISMA_DIFF_QUOTE_UNTERMINATED",
    "STATEMENT_UNTERMINATED": "MIGRATION_PRISMA_DIFF_STATEMENT_UNTERMINATED",
    "TRANSACTION_WRAPPER_INVALID": "MIGRATION_PRISMA_DIFF_TRANSACTION_WRAPPER_INVALID",
    "ALTER_TABLE_SYNTAX_UNSUPPORTED": "MIGRATION_PRISMA_DIFF_ALTER_TABLE_SYNTAX_UNSUPPORTED",
    "IDENTIFIER_SYNTAX_UNSUPPORTED": "MIGRATION_PRISMA_DIFF_IDENTIFIER_SYNTAX_UNSUPPORTED",
    "CLAUSE_SYNTAX_UNSUPPORTED": "MIGRATION_PRISMA_DIFF_CLAUSE_SYNTAX_UNSUPPORTED",
    "FACTS_OUTPUT_EXISTS": "MIGRATION_PRISMA_DIFF_FACTS_OUTPUT_EXISTS",
    "FACTS_OUTPUT_WRITE_FAILED": "MIGRATION_PRISMA_DIFF_FACTS_OUTPUT_WRITE_FAILED",
    "FACTS_SCHEMA_REJECTED": "MIGRATION_PRISMA_DIFF_FACTS_SCHEMA_REJECTED",
    "PARSER_INTERNAL_FAILURE": "MIGRATION_PRISMA_DIFF_PARSER_INTERNAL_FAILURE",
}


class ParserFailure(Exception):
    """A privacy-safe parser failure with no raw SQL in its representation."""

    def __init__(self, stage: str, code: str) -> None:
        super().__init__(code)
        self.stage = stage
        self.code = code


def base_facts(mode: str, raw_byte_count: int = 0) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "rawByteCount": raw_byte_count,
        "sizeLimitBytes": MAX_BYTES,
        "utf8Valid": False,
        "commentsBalanced": False,
        "quotesBalanced": False,
        "statementTerminationValid": False,
        "transactionWrapperState": "NOT_OBSERVED",
        "schemaQualificationObserved": False,
        "identifierFormCategory": "NOT_OBSERVED",
        "factsFileCreated": False,
        "factsFileLoaded": False,
        "parserFailureStage": "NONE",
        "parserFailureCode": "NONE",
        "nonCommentStatementCount": 0,
        "alterTableCount": 0,
        "affectedTableCount": 0,
        "expectedTablePresent": False,
        "submittedPhoneAddPresent": False,
        "submittedPhoneAtAddPresent": False,
        "unexpectedTablePresent": False,
        "unexpectedColumnPresent": False,
        "unexpectedOperationPresent": False,
        "defaultPresent": False,
        "constraintPresent": False,
        "indexPresent": False,
        "defaultConstraintIndexPresent": False,
        "parserResult": "PARSE_FAILED",
        "normalizedSemanticSha256": "0" * 64,
        "expectedSemanticMode": mode,
        "finalGateClassification": "MIGRATION_PRISMA_DIFF_PARSE_FAILED",
        "rawDiffRetained": False,
        "rawSqlCaptured": False,
    }


def set_failure(facts: dict[str, Any], stage: str, code: str) -> None:
    facts["parserFailureStage"] = stage
    facts["parserFailureCode"] = code
    facts["parserResult"] = "PARSE_FAILED"
    facts["finalGateClassification"] = FAILURE_CLASSIFICATIONS[code]


def semantic_hash(facts: dict[str, Any], columns: list[str]) -> str:
    safe_model = {
        "expectedSemanticMode": facts["expectedSemanticMode"],
        "parserFailureStage": facts["parserFailureStage"],
        "parserFailureCode": facts["parserFailureCode"],
        "nonCommentStatementCount": facts["nonCommentStatementCount"],
        "alterTableCount": facts["alterTableCount"],
        "affectedTableCount": facts["affectedTableCount"],
        "expectedTablePresent": facts["expectedTablePresent"],
        "submittedPhoneAddPresent": facts["submittedPhoneAddPresent"],
        "submittedPhoneAtAddPresent": facts["submittedPhoneAtAddPresent"],
        "unexpectedTablePresent": facts["unexpectedTablePresent"],
        "unexpectedColumnPresent": facts["unexpectedColumnPresent"],
        "unexpectedOperationPresent": facts["unexpectedOperationPresent"],
        "defaultPresent": facts["defaultPresent"],
        "constraintPresent": facts["constraintPresent"],
        "indexPresent": facts["indexPresent"],
        "transactionWrapperState": facts["transactionWrapperState"],
        "schemaQualificationObserved": facts["schemaQualificationObserved"],
        "identifierFormCategory": facts["identifierFormCategory"],
        "columns": sorted(columns),
    }
    encoded = json.dumps(safe_model, separators=(",", ":"), sort_keys=True).encode()
    return hashlib.sha256(encoded).hexdigest()


def write_facts(path: str, facts: dict[str, Any]) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    output = dict(facts)
    output["factsFileCreated"] = True
    descriptor = os.open(path, flags, 0o600)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise OSError("facts output is not regular")
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            descriptor = -1
            json.dump(output, stream, separators=(",", ":"), sort_keys=True)
            stream.write("\n")
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def persist_facts(path: str, facts: dict[str, Any]) -> int:
    facts["normalizedSemanticSha256"] = semantic_hash(facts, []) if facts["normalizedSemanticSha256"] == "0" * 64 else facts["normalizedSemanticSha256"]
    try:
        write_facts(path, facts)
        return 0
    except FileExistsError:
        set_failure(facts, "FACTS_OUTPUT", "FACTS_OUTPUT_EXISTS")
        facts["normalizedSemanticSha256"] = semantic_hash(facts, [])
        try:
            write_facts(path + ".failure", facts)
            return 73
        except OSError:
            return 74
    except OSError:
        return 74


def quoted_identifier(value: str) -> str:
    if not re.fullmatch(QIDENT, value):
        raise ParserFailure("IDENTIFIER_PARSING", "IDENTIFIER_SYNTAX_UNSUPPORTED")
    return value[1:-1].replace('""', '"')


def strip_comments(sql: str, facts: dict[str, Any]) -> str:
    result: list[str] = []
    state = "normal"
    index = 0
    while index < len(sql):
        current = sql[index]
        following = sql[index + 1] if index + 1 < len(sql) else ""
        if state == "line":
            if current == "\n":
                result.append("\n")
                state = "normal"
            index += 1
            continue
        if state == "block":
            if current == "*" and following == "/":
                state = "normal"
                index += 2
            else:
                if current == "\n":
                    result.append("\n")
                index += 1
            continue
        if state in {"single", "double"}:
            result.append(current)
            quote = "'" if state == "single" else '"'
            if current == quote and following == quote:
                result.append(following)
                index += 2
            else:
                if current == quote:
                    state = "normal"
                index += 1
            continue
        if current == "-" and following == "-":
            state = "line"
            index += 2
        elif current == "/" and following == "*":
            state = "block"
            index += 2
        else:
            result.append(current)
            if current == "'":
                state = "single"
            elif current == '"':
                state = "double"
            index += 1
    if state == "block":
        raise ParserFailure("COMMENT_LEXING", "COMMENT_UNTERMINATED")
    if state in {"single", "double"}:
        raise ParserFailure("COMMENT_LEXING", "QUOTE_UNTERMINATED")
    facts["commentsBalanced"] = True
    facts["quotesBalanced"] = True
    return "".join(result)


def split_statements(sql: str, facts: dict[str, Any]) -> list[str]:
    statements: list[str] = []
    current: list[str] = []
    state = "normal"
    index = 0
    while index < len(sql):
        character = sql[index]
        following = sql[index + 1] if index + 1 < len(sql) else ""
        if state in {"single", "double"}:
            current.append(character)
            quote = "'" if state == "single" else '"'
            if character == quote and following == quote:
                current.append(following)
                index += 2
            else:
                if character == quote:
                    state = "normal"
                index += 1
            continue
        if character == "'":
            state = "single"
        elif character == '"':
            state = "double"
        if character == ";" and state == "normal":
            statement = "".join(current).strip()
            if statement:
                statements.append(statement)
            current = []
        else:
            current.append(character)
        index += 1
    if state != "normal":
        facts["quotesBalanced"] = False
        raise ParserFailure("STATEMENT_LEXING", "QUOTE_UNTERMINATED")
    if "".join(current).strip():
        raise ParserFailure("STATEMENT_LEXING", "STATEMENT_UNTERMINATED")
    facts["statementTerminationValid"] = True
    return statements


def split_clauses(body: str) -> list[str]:
    clauses: list[str] = []
    current: list[str] = []
    depth = 0
    quoted = False
    index = 0
    while index < len(body):
        character = body[index]
        following = body[index + 1] if index + 1 < len(body) else ""
        if character == '"':
            current.append(character)
            if quoted and following == '"':
                current.append(following)
                index += 2
                continue
            quoted = not quoted
            index += 1
            continue
        if not quoted and character == "(":
            depth += 1
        elif not quoted and character == ")":
            depth -= 1
        if depth < 0:
            raise ParserFailure("CLAUSE_PARSING", "CLAUSE_SYNTAX_UNSUPPORTED")
        if not quoted and depth == 0 and character == ",":
            clause = "".join(current).strip()
            if not clause:
                raise ParserFailure("CLAUSE_PARSING", "CLAUSE_SYNTAX_UNSUPPORTED")
            clauses.append(clause)
            current = []
        else:
            current.append(character)
        index += 1
    clause = "".join(current).strip()
    if quoted or depth != 0 or not clause:
        raise ParserFailure("CLAUSE_PARSING", "CLAUSE_SYNTAX_UNSUPPORTED")
    clauses.append(clause)
    return clauses


def parse_table_reference(value: str) -> tuple[str | None, str, str]:
    quoted_qualified = re.fullmatch(rf"({QIDENT})\s*\.\s*({QIDENT})", value)
    if quoted_qualified:
        return quoted_identifier(quoted_qualified.group(1)), quoted_identifier(quoted_qualified.group(2)), "QUALIFIED_QUOTED"
    mixed_qualified = re.fullmatch(rf"({BARE_IDENT})\s*\.\s*({QIDENT})", value)
    if mixed_qualified:
        return mixed_qualified.group(1), quoted_identifier(mixed_qualified.group(2)), "QUALIFIED_MIXED"
    if re.fullmatch(QIDENT, value):
        return None, quoted_identifier(value), "UNQUALIFIED_QUOTED"
    raise ParserFailure("IDENTIFIER_PARSING", "IDENTIFIER_SYNTAX_UNSUPPORTED")


def set_identifier_category(facts: dict[str, Any], category: str) -> None:
    current = facts["identifierFormCategory"]
    if current == "NOT_OBSERVED":
        facts["identifierFormCategory"] = category
    elif current != category:
        facts["identifierFormCategory"] = "MIXED"


def extract_alter(statement: str) -> tuple[str, str]:
    prefix = re.match(r"ALTER\s+TABLE\s+(?:ONLY\s+)?", statement, re.IGNORECASE)
    if not prefix:
        raise ParserFailure("ALTER_TABLE_PARSING", "ALTER_TABLE_SYNTAX_UNSUPPORTED")
    rest = statement[prefix.end():]
    reference = re.match(rf"((?:{QIDENT}|{BARE_IDENT})\s*\.\s*{QIDENT}|{QIDENT})(?=\s|$)", rest)
    if not reference:
        raise ParserFailure("IDENTIFIER_PARSING", "IDENTIFIER_SYNTAX_UNSUPPORTED")
    body = rest[reference.end():].strip()
    if not body:
        raise ParserFailure("ALTER_TABLE_PARSING", "ALTER_TABLE_SYNTAX_UNSUPPORTED")
    return reference.group(1), body


def record_generic_table(statement: str, affected_tokens: set[str], facts: dict[str, Any]) -> None:
    patterns = (
        rf"\bINSERT\s+INTO\s+((?:{QIDENT}|{BARE_IDENT})\s*\.\s*{QIDENT}|{QIDENT})",
        rf"\bUPDATE\s+((?:{QIDENT}|{BARE_IDENT})\s*\.\s*{QIDENT}|{QIDENT})",
        rf"\bDELETE\s+FROM\s+((?:{QIDENT}|{BARE_IDENT})\s*\.\s*{QIDENT}|{QIDENT})",
        rf"\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*?\bON\s+((?:{QIDENT}|{BARE_IDENT})\s*\.\s*{QIDENT}|{QIDENT})",
        rf"\bDROP\s+TABLE\s+((?:{QIDENT}|{BARE_IDENT})\s*\.\s*{QIDENT}|{QIDENT})",
    )
    for pattern in patterns:
        match = re.search(pattern, statement, flags=re.IGNORECASE)
        if not match:
            continue
        try:
            schema, table, category = parse_table_reference(match.group(1))
        except ParserFailure:
            return
        set_identifier_category(facts, category)
        facts["schemaQualificationObserved"] |= schema is not None
        expected = table == EXPECTED_TABLE and schema in {None, EXPECTED_SCHEMA}
        token = "EXPECTED" if expected else hashlib.sha256(f"{schema or ''}.{table}".encode()).hexdigest()
        affected_tokens.add(token)
        facts["expectedTablePresent"] |= expected
        facts["unexpectedTablePresent"] |= not expected
        return


def classify(facts: dict[str, Any], columns: list[dict[str, Any]]) -> bool:
    facts["defaultConstraintIndexPresent"] = facts["defaultPresent"] or facts["constraintPresent"] or facts["indexPresent"]
    facts["submittedPhoneAddPresent"] = any(entry["name"] == "submittedPhone" for entry in columns)
    facts["submittedPhoneAtAddPresent"] = any(entry["name"] == "submittedPhoneAt" for entry in columns)
    if facts["nonCommentStatementCount"] == 0:
        facts["parserResult"] = "EMPTY"
        if facts["expectedSemanticMode"] == MODE_EMPTY:
            facts["finalGateClassification"] = "MIGRATION_PRISMA_DIFF_EMPTY_ACCEPTED"
            return True
        facts["finalGateClassification"] = "MIGRATION_PRISMA_DIFF_EMPTY_UNEXPECTED"
        return False
    facts["parserResult"] = "REJECTED"
    if facts["expectedSemanticMode"] == MODE_EMPTY:
        facts["finalGateClassification"] = "MIGRATION_PRISMA_DIFF_REQUIRED_EMPTY"
    elif facts["unexpectedTablePresent"]:
        facts["finalGateClassification"] = "MIGRATION_PRISMA_DIFF_UNEXPECTED_TABLE"
    elif facts["unexpectedColumnPresent"]:
        facts["finalGateClassification"] = "MIGRATION_PRISMA_DIFF_UNEXPECTED_COLUMN"
    elif any(entry["typeMismatch"] for entry in columns):
        facts["finalGateClassification"] = "MIGRATION_PRISMA_DIFF_TYPE_MISMATCH"
    elif facts["unexpectedOperationPresent"] or facts["defaultConstraintIndexPresent"]:
        facts["finalGateClassification"] = "MIGRATION_PRISMA_DIFF_UNEXPECTED_OPERATION"
    elif not facts["submittedPhoneAddPresent"] or not facts["submittedPhoneAtAddPresent"]:
        facts["finalGateClassification"] = "MIGRATION_PRISMA_DIFF_REQUIRED_COLUMN_MISSING"
    else:
        facts["parserResult"] = "ACCEPTED"
        facts["finalGateClassification"] = "MIGRATION_PRISMA_DIFF_ALLOWED_LEGACY_DRIFT"
        return True
    return False


def parse_diff(diff_path: str, facts: dict[str, Any]) -> tuple[bool, list[str]]:
    try:
        metadata = os.lstat(diff_path)
    except FileNotFoundError as error:
        raise ParserFailure("INPUT_VALIDATION", "INPUT_MISSING") from error
    facts["rawByteCount"] = metadata.st_size
    if stat.S_ISLNK(metadata.st_mode):
        raise ParserFailure("INPUT_VALIDATION", "INPUT_SYMLINK")
    if not stat.S_ISREG(metadata.st_mode):
        raise ParserFailure("INPUT_VALIDATION", "INPUT_NOT_REGULAR")
    if metadata.st_size > MAX_BYTES:
        raise ParserFailure("INPUT_VALIDATION", "INPUT_TOO_LARGE")
    try:
        with open(diff_path, "rb") as stream:
            raw = stream.read()
        sql = raw.decode("utf-8", errors="strict").replace("\r\n", "\n").replace("\r", "\n")
        facts["utf8Valid"] = True
    except UnicodeError as error:
        raise ParserFailure("INPUT_DECODE", "INPUT_UTF8_INVALID") from error

    statements = split_statements(strip_comments(sql, facts), facts)
    facts["nonCommentStatementCount"] = len(statements)
    semantic_statements = statements
    begin_count = sum(bool(re.fullmatch(r"BEGIN(?:\s+TRANSACTION)?", item, re.IGNORECASE)) for item in statements)
    commit_count = sum(bool(re.fullmatch(r"COMMIT", item, re.IGNORECASE)) for item in statements)
    if begin_count or commit_count:
        valid_wrapper = (
            begin_count == 1
            and commit_count == 1
            and len(statements) >= 3
            and bool(re.fullmatch(r"BEGIN(?:\s+TRANSACTION)?", statements[0], re.IGNORECASE))
            and bool(re.fullmatch(r"COMMIT", statements[-1], re.IGNORECASE))
        )
        if not valid_wrapper:
            facts["transactionWrapperState"] = "INVALID"
            raise ParserFailure("TRANSACTION_WRAPPER", "TRANSACTION_WRAPPER_INVALID")
        facts["transactionWrapperState"] = "VALID"
        semantic_statements = statements[1:-1]
    else:
        facts["transactionWrapperState"] = "ABSENT"

    columns: list[dict[str, Any]] = []
    affected_tokens: set[str] = set()
    safe_columns: list[str] = []
    for statement in semantic_statements:
        if re.search(r"\bDEFAULT\b", statement, re.IGNORECASE):
            facts["defaultPresent"] = True
        if re.search(r"\b(?:CONSTRAINT|REFERENCES|UNIQUE|CHECK|PRIMARY\s+KEY|FOREIGN\s+KEY|NOT\s+NULL)\b", statement, re.IGNORECASE):
            facts["constraintPresent"] = True
        if re.search(r"\b(?:CREATE|DROP)\s+(?:UNIQUE\s+)?INDEX\b", statement, re.IGNORECASE):
            facts["indexPresent"] = True
        if not re.match(r"ALTER\s+TABLE\b", statement, re.IGNORECASE):
            record_generic_table(statement, affected_tokens, facts)
            facts["unexpectedOperationPresent"] = True
            continue

        reference, body = extract_alter(statement)
        schema, table, category = parse_table_reference(reference)
        set_identifier_category(facts, category)
        facts["schemaQualificationObserved"] |= schema is not None
        expected_table = table == EXPECTED_TABLE and schema in {None, EXPECTED_SCHEMA}
        token = "EXPECTED" if expected_table else hashlib.sha256(f"{schema or ''}.{table}".encode()).hexdigest()
        affected_tokens.add(token)
        facts["expectedTablePresent"] |= expected_table
        facts["unexpectedTablePresent"] |= not expected_table
        facts["alterTableCount"] += 1

        for clause in split_clauses(body):
            addition = re.fullmatch(rf"ADD\s+COLUMN\s+({QIDENT})\s+([\s\S]+)", clause, re.IGNORECASE)
            if not addition:
                if re.match(r"ADD\s+COLUMN\b", clause, re.IGNORECASE):
                    if re.match(rf"ADD\s+COLUMN\s+{QIDENT}(?:\s|$)", clause, re.IGNORECASE):
                        raise ParserFailure("CLAUSE_PARSING", "CLAUSE_SYNTAX_UNSUPPORTED")
                    raise ParserFailure("IDENTIFIER_PARSING", "IDENTIFIER_SYNTAX_UNSUPPORTED")
                facts["unexpectedOperationPresent"] = True
                continue
            name = quoted_identifier(addition.group(1))
            type_text = re.sub(r"\s+", " ", addition.group(2).strip())
            text_type = re.match(r"^TEXT(?=$|\s)([\s\S]*)$", type_text, re.IGNORECASE)
            timestamp_type = re.match(r"^TIMESTAMP\s*\(\s*3\s*\)(?=$|\s)([\s\S]*)$", type_text, re.IGNORECASE)
            if text_type:
                canonical_type = "TEXT"
                suffix = text_type.group(1).strip()
            elif timestamp_type:
                canonical_type = "TIMESTAMP(3)"
                suffix = timestamp_type.group(1).strip()
            else:
                canonical_type = "OTHER"
                suffix = ""
            modifiers_present = canonical_type != "OTHER" and bool(suffix) and not bool(re.fullmatch(r"NULL", suffix, re.IGNORECASE))
            expected_type = EXPECTED_COLUMNS.get(name)
            duplicate = any(entry["name"] == name for entry in columns)
            type_mismatch = expected_type is not None and canonical_type != expected_type
            columns.append({
                "name": name,
                "canonicalType": canonical_type,
                "typeMismatch": type_mismatch,
                "modifiersPresent": modifiers_present,
            })
            if expected_type is None or duplicate:
                facts["unexpectedColumnPresent"] = True
            if modifiers_present:
                facts["unexpectedOperationPresent"] = True
            safe_columns.append(
                f'{name if name in EXPECTED_COLUMNS else "OTHER"}:{canonical_type}:'
                f'{"MISMATCH" if type_mismatch else "MATCH"}:'
                f'{"MODIFIED" if modifiers_present else "NULLABLE"}'
            )

    facts["affectedTableCount"] = len(affected_tokens)
    accepted = classify(facts, columns)
    facts["normalizedSemanticSha256"] = semantic_hash(facts, safe_columns)
    return accepted, safe_columns


def main() -> int:
    if len(sys.argv) != 4 or sys.argv[3] not in {MODE_LEGACY, MODE_EMPTY}:
        return 64
    diff_path, facts_path, mode = sys.argv[1:]
    facts = base_facts(mode)
    accepted = False
    try:
        accepted, _ = parse_diff(diff_path, facts)
    except ParserFailure as error:
        set_failure(facts, error.stage, error.code)
        facts["normalizedSemanticSha256"] = semantic_hash(facts, [])
    except Exception:
        set_failure(facts, "INTERNAL", "PARSER_INTERNAL_FAILURE")
        facts["normalizedSemanticSha256"] = semantic_hash(facts, [])

    persisted = persist_facts(facts_path, facts)
    if persisted != 0:
        return persisted
    return 0 if accepted else 65


if __name__ == "__main__":
    raise SystemExit(main())
