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
EXPECTED_TABLE = "DriverTelegram"
EXPECTED_COLUMNS = {
    "submittedPhone": "TEXT",
    "submittedPhoneAt": "TIMESTAMP(3)",
}


def base_facts(mode: str, raw_byte_count: int = 0) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "rawByteCount": raw_byte_count,
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


def semantic_hash(facts: dict[str, Any], columns: list[str]) -> str:
    safe_model = {
        "expectedSemanticMode": facts["expectedSemanticMode"],
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
        "columns": sorted(columns),
    }
    encoded = json.dumps(safe_model, separators=(",", ":"), sort_keys=True).encode()
    return hashlib.sha256(encoded).hexdigest()


def write_facts(path: str, facts: dict[str, Any]) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(facts, stream, separators=(",", ":"), sort_keys=True)
        stream.write("\n")


def strip_comments(sql: str) -> str:
    result: list[str] = []
    state = "normal"
    index = 0
    while index < len(sql):
        current = sql[index]
        next_character = sql[index + 1] if index + 1 < len(sql) else ""
        if state == "line":
            if current == "\n":
                result.append("\n")
                state = "normal"
            index += 1
            continue
        if state == "block":
            if current == "*" and next_character == "/":
                state = "normal"
                index += 2
            else:
                if current == "\n":
                    result.append("\n")
                index += 1
            continue
        if state == "single":
            result.append(current)
            if current == "'" and next_character == "'":
                result.append(next_character)
                index += 2
            else:
                if current == "'":
                    state = "normal"
                index += 1
            continue
        if state == "double":
            result.append(current)
            if current == '"' and next_character == '"':
                result.append(next_character)
                index += 2
            else:
                if current == '"':
                    state = "normal"
                index += 1
            continue
        if current == "-" and next_character == "-":
            state = "line"
            index += 2
        elif current == "/" and next_character == "*":
            state = "block"
            index += 2
        else:
            result.append(current)
            if current == "'":
                state = "single"
            elif current == '"':
                state = "double"
            index += 1
    if state in {"block", "single", "double"}:
        raise ValueError("unterminated token")
    return "".join(result)


def split_statements(sql: str) -> list[str]:
    statements: list[str] = []
    current: list[str] = []
    state = "normal"
    index = 0
    while index < len(sql):
        character = sql[index]
        next_character = sql[index + 1] if index + 1 < len(sql) else ""
        if state == "single":
            current.append(character)
            if character == "'" and next_character == "'":
                current.append(next_character)
                index += 2
            else:
                if character == "'":
                    state = "normal"
                index += 1
            continue
        if state == "double":
            current.append(character)
            if character == '"' and next_character == '"':
                current.append(next_character)
                index += 2
            else:
                if character == '"':
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
        raise ValueError("unterminated quote")
    if "".join(current).strip():
        raise ValueError("unterminated statement")
    return statements


def split_clauses(body: str) -> list[str]:
    clauses: list[str] = []
    current: list[str] = []
    depth = 0
    quoted = False
    index = 0
    while index < len(body):
        character = body[index]
        next_character = body[index + 1] if index + 1 < len(body) else ""
        if character == '"':
            current.append(character)
            if quoted and next_character == '"':
                current.append(next_character)
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
            raise ValueError("unbalanced parentheses")
        if not quoted and depth == 0 and character == ",":
            clause = "".join(current).strip()
            if not clause:
                raise ValueError("empty clause")
            clauses.append(clause)
            current = []
        else:
            current.append(character)
        index += 1
    clause = "".join(current).strip()
    if quoted or depth != 0 or not clause:
        raise ValueError("malformed clause")
    clauses.append(clause)
    return clauses


def quoted_identifier(value: str) -> str:
    if not re.fullmatch(r'"(?:[^"]|"")+"', value):
        raise ValueError("invalid identifier")
    return value[1:-1].replace('""', '"')


def record_referenced_table(statement: str, affected_tables: set[str]) -> None:
    patterns = (
        r'\bALTER\s+TABLE\s+("(?:[^"]|"")+")',
        r'\bINSERT\s+INTO\s+("(?:[^"]|"")+")',
        r'\bUPDATE\s+("(?:[^"]|"")+")',
        r'\bDELETE\s+FROM\s+("(?:[^"]|"")+")',
        r'\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*?\bON\s+("(?:[^"]|"")+")',
        r'\bDROP\s+TABLE\s+("(?:[^"]|"")+")',
    )
    for pattern in patterns:
        match = re.search(pattern, statement, flags=re.IGNORECASE)
        if match:
            affected_tables.add(quoted_identifier(match.group(1)))
            return


def classify(facts: dict[str, Any], columns: list[dict[str, Any]], parse_failed: bool) -> bool:
    facts["defaultConstraintIndexPresent"] = (
        facts["defaultPresent"] or facts["constraintPresent"] or facts["indexPresent"]
    )
    facts["submittedPhoneAddPresent"] = any(entry["name"] == "submittedPhone" for entry in columns)
    facts["submittedPhoneAtAddPresent"] = any(entry["name"] == "submittedPhoneAt" for entry in columns)
    if parse_failed:
        facts["parserResult"] = "PARSE_FAILED"
        facts["finalGateClassification"] = "MIGRATION_PRISMA_DIFF_PARSE_FAILED"
        return False
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


def main() -> int:
    if len(sys.argv) != 4 or sys.argv[3] not in {MODE_LEGACY, MODE_EMPTY}:
        return 64
    diff_path, facts_path, mode = sys.argv[1:]
    facts = base_facts(mode)
    columns: list[dict[str, Any]] = []
    accepted = False
    try:
        metadata = os.lstat(diff_path)
        facts["rawByteCount"] = metadata.st_size
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_BYTES:
            facts["normalizedSemanticSha256"] = semantic_hash(facts, [])
            write_facts(facts_path, facts)
            return 65
        with open(diff_path, "rb") as stream:
            sql = stream.read().decode("utf-8", errors="strict").replace("\r\n", "\n").replace("\r", "\n")
        statements = split_statements(strip_comments(sql))
        facts["nonCommentStatementCount"] = len(statements)
        semantic_statements = statements
        parse_failed = False
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
            if valid_wrapper:
                semantic_statements = statements[1:-1]
            else:
                parse_failed = True
        affected_tables: set[str] = set()
        for statement in semantic_statements:
            record_referenced_table(statement, affected_tables)
            if re.search(r"\bDEFAULT\b", statement, re.IGNORECASE):
                facts["defaultPresent"] = True
            if re.search(
                r"\b(?:CONSTRAINT|REFERENCES|UNIQUE|CHECK|PRIMARY\s+KEY|FOREIGN\s+KEY|NOT\s+NULL)\b",
                statement,
                re.IGNORECASE,
            ):
                facts["constraintPresent"] = True
            if re.search(r"\b(?:CREATE|DROP)\s+(?:UNIQUE\s+)?INDEX\b", statement, re.IGNORECASE):
                facts["indexPresent"] = True
            alter = re.fullmatch(
                r'ALTER\s+TABLE\s+("(?:[^"]|"")+")\s+([\s\S]+)',
                statement,
                re.IGNORECASE,
            )
            if not alter:
                facts["unexpectedOperationPresent"] = True
                if re.match(r"ALTER\s+TABLE\b", statement, re.IGNORECASE):
                    parse_failed = True
                continue
            facts["alterTableCount"] += 1
            table = quoted_identifier(alter.group(1))
            affected_tables.add(table)
            if table != EXPECTED_TABLE:
                facts["unexpectedTablePresent"] = True
            try:
                clauses = split_clauses(alter.group(2))
            except ValueError:
                parse_failed = True
                continue
            for clause in clauses:
                addition = re.fullmatch(
                    r'ADD\s+COLUMN\s+("(?:[^"]|"")+")\s+([\s\S]+)',
                    clause,
                    re.IGNORECASE,
                )
                if not addition:
                    facts["unexpectedOperationPresent"] = True
                    continue
                name = quoted_identifier(addition.group(1))
                type_text = re.sub(r"\s+", " ", addition.group(2).strip())
                text_type = re.match(r"^TEXT(?=$|\s)([\s\S]*)$", type_text, re.IGNORECASE)
                timestamp_type = re.match(
                    r"^TIMESTAMP\s*\(\s*3\s*\)(?=$|\s)([\s\S]*)$", type_text, re.IGNORECASE
                )
                if text_type:
                    canonical_type = "TEXT"
                    suffix = text_type.group(1).strip()
                elif timestamp_type:
                    canonical_type = "TIMESTAMP(3)"
                    suffix = timestamp_type.group(1).strip()
                else:
                    canonical_type = "OTHER"
                    suffix = ""
                modifiers_present = canonical_type != "OTHER" and bool(suffix) and not bool(
                    re.fullmatch(r"NULL", suffix, re.IGNORECASE)
                )
                expected_type = EXPECTED_COLUMNS.get(name)
                duplicate = any(entry["name"] == name for entry in columns)
                type_mismatch = expected_type is not None and canonical_type != expected_type
                columns.append(
                    {
                        "name": name,
                        "canonicalType": canonical_type,
                        "typeMismatch": type_mismatch,
                        "modifiersPresent": modifiers_present,
                    }
                )
                if expected_type is None or duplicate:
                    facts["unexpectedColumnPresent"] = True
                if modifiers_present:
                    facts["unexpectedOperationPresent"] = True
        facts["affectedTableCount"] = len(affected_tables)
        facts["expectedTablePresent"] = EXPECTED_TABLE in affected_tables
        facts["unexpectedTablePresent"] = facts["unexpectedTablePresent"] or any(
            table != EXPECTED_TABLE for table in affected_tables
        )
        accepted = classify(facts, columns, parse_failed)
        safe_columns = [
            f'{entry["name"]}:{entry["canonicalType"]}:'
            f'{"MISMATCH" if entry["typeMismatch"] else "MATCH"}:'
            f'{"MODIFIED" if entry["modifiersPresent"] else "NULLABLE"}'
            for entry in columns
        ]
        facts["normalizedSemanticSha256"] = semantic_hash(facts, safe_columns)
    except (OSError, UnicodeError, ValueError):
        facts = base_facts(mode, facts["rawByteCount"])
        facts["normalizedSemanticSha256"] = semantic_hash(facts, [])
    try:
        write_facts(facts_path, facts)
    except OSError:
        return 74
    return 0 if accepted else 65


if __name__ == "__main__":
    raise SystemExit(main())
