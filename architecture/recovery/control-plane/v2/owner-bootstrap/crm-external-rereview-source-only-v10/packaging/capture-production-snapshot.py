#!/usr/bin/python3
"""Capture the exact installed Runtime v10 control-plane predecessor through read-only verbs only."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Callable


RUNTIME = "/usr/local/sbin/yoko-privileged-runtime"
SUDO = "/usr/bin/sudo"
HOST = "jvxthcorvm"
RUNTIME_VERSION = "2.0.0"
PACKAGE_VERSION = "2.0.0-10"
PROFILE_ID = "crm-9514cd7ac10f-gravity-source-v1"
PREDECESSOR_COMMIT = "7aea2823efe50e13a156540993d424594025e403"
PREDECESSOR_IMAGE = "sha256:baf442f880ebca808897a0131a662c603a9119f652cbbc3e47937286dec49179"
TG_BOT_IMAGE = "sha256:0849c4c9912aecf3cb7c35b51abba22cdb1c85a385afa6c2746000d14b9835f6"
POSTGRES_IMAGE = "sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229"
AUDIT_RECORDS = 23
AUDIT_DIGEST = "724044340213b8f07035969c0cc127cd49108fa5c4b62701dc55baa8d6e562db"
DATABASE_IDENTITY = "ed88dfeaad2a3dc2e759590d295992cd06531d4403d896ded00b21ea667be1c9"
MIGRATION_LEDGER = "a50f1a8988f79c85059354d6b2d45e9e8ed07284fc27c78d98face6680f25dfc"
CANONICAL_ACTIVE_INVENTORY = "a05eb3a3a6a0c78df2e68b150421a00f971b6e39b9346bb25f76733ed799d197"
CANONICAL_LIVE_CHRONOLOGY = "62aaa333a8df02cc9c255da14e8bb7ba70ed441098148846f1855c24623ac465"
CANONICAL_TARGET_NAME = "20260809140000_add_domain_outbox"
CANONICAL_TARGET_CHECKSUM = "433b0d503f054ed6a8161a059e2650d5e401829dabe8c9d992a1d1763eef0016"
SOURCE_MANIFEST = "ecfb0a8b6dc24121fb5c9efb58af28eb1f1626711ef1a6d977b0db29d05bdda3"
COMPOSE_SHA = "84a9f46904a65a69afcf19d2e56162e026b29718da52c43160abfc5449f84cc1"
GRAVITY_COMPOSE = "772ba8f19dc89133ea55ce65aa2d68550594ab61060eac0e373ae7936161b9f8"
TG_COMPOSE = "00952518d668126c08950de087a7c46fa368cd8879590ad9c1584bb7c39b42e2"
OUTBOX_CATALOG = "ef0bce36bca8283b491a966ff3886644a8887f4bded3deebbec7ce559ac2defe"
TG_PATCH_BASELINE_STATE = "ABSENT"
TG_BASELINE_MANIFEST_FILE_SHA = "1bd1d5100cabeb37277262179ee1119b3dcd9154b9774947dcf218d38e4d19fe"
TG_BASELINE_MANIFEST_SHA = "72397e9c7e3c728b94d1e5645da825ddd75216bfacd13212b4671fe15f206d56"
SHA64 = re.compile(r"[0-9a-f]{64}")
UTC = dt.timezone.utc
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_CAPTURE_SECONDS = 120
MAX_SNAPSHOT_AGE_SECONDS = 900
MAX_FUTURE_SKEW_SECONDS = 5

COMMANDS: tuple[tuple[str, str | None], ...] = (
    ("version", None),
    ("self-check", None),
    ("audit-status", None),
    ("docker-inspect", "crm.container.gravity_mvp"),
    ("docker-inspect", "crm.container.telegram_bot"),
    ("docker-inspect", "crm.container.postgres"),
    ("snapshot-manifest", "crm.repo.production"),
    ("database-status", None),
)

TOP_RESPONSE_KEYS = {
    "errors", "evidence", "ok", "primitive", "resource", "runtime_version",
    "schema", "timestamp", "warnings",
}
VERSION_KEYS = {"activation_profile", "package_version", "response_schema", "runtime_version"}
SELF_CHECK_KEYS = {
    "activation_profile_id", "activation_profile_identity",
    "activation_profile_manifest_sha256", "arbitrary_paths", "audit",
    "docker_socket_delegated", "generic_command_execution", "installed_identity",
    "package_version", "policy_sha256", "profile_argument_shape", "registry_sha256",
    "runtime_version",
}
DOCKER_KEYS = {
    "cmd", "compose_labels", "config_image", "container_id", "created",
    "declared_user", "entrypoint", "health", "image_created", "image_id",
    "image_metadata_status", "logical_resource", "mounts", "name", "oci_labels",
    "platform", "repo_digests", "restart_count", "running", "semantic",
    "started_at", "status", "working_dir",
}
DOCKER_SEMANTIC_KEYS = {
    "command", "compose_labels", "entrypoint", "environment_names", "image_id", "mounts", "name",
    "network_mode", "network_names", "privileged", "published_ports",
    "read_only_rootfs", "restart_policy",
}
SNAPSHOT_MANIFEST_KEYS = {
    "content_manifest", "destination", "estimated_snapshot_bytes", "logical_resource",
    "profile", "secrets_copied", "storage_preflight",
}
CONTENT_MANIFEST_KEYS = {
    "bytes", "entries", "entry_count", "excluded", "logical_resource", "manifest_sha256",
}
DATABASE_KEYS = {
    "applied_migration_count", "canonical_active_inventory_sha256", "canonical_active_map_exact",
    "canonical_live_chronology_exact", "canonical_live_rows", "canonical_live_rows_sha256",
    "canonical_predecessor_entry_count", "canonical_target_checksum", "canonical_target_name",
    "database_identity_sha256", "database_name_sha256",
    "database_user_sha256", "interrupted_target_migrations", "migration_ledger_sha256",
    "migration_state", "outbox_catalog_state", "outbox_counts", "postgres_container_id",
    "postgres_image_id", "profile_id", "read_only", "rolled_back_target_migrations",
    "secret_values_emitted", "server_version_num", "system_identifier_sha256",
    "expected_canonical_active_inventory_sha256", "expected_live_chronology_sha256",
}
DATABASE_ROW_KEYS = {
    "applied_steps_count", "checksum", "finished_at", "logs_bytes", "logs_present",
    "logs_sha256", "migration_id", "migration_name", "observed_chronological_ordinal",
    "rolled_back_at", "started_at", "status",
}
OUTBOX_COUNT_KEYS = {
    "dead_letter", "over_attempt_limit", "pending", "processing", "published",
    "retry_wait", "stale_claimed", "total",
}
SNAPSHOT_KEYS = {"schema", "status", "captured_at", "host", "observed", "sealed_predecessor_authority", "capture", "capture_transcript_sha256"}
OBSERVED_KEYS = {
    "runtime_package_version", "runtime_abi", "profile_id", "audit_state", "audit_records",
    "audit_last_digest", "source_manifest_sha256", "compose_sha256", "compose_config_hash",
    "gravity_container_id", "gravity_image_id", "gravity_oci_revision", "gravity_running",
    "gravity_health", "gravity_restart_count", "tg_bot_container_id", "tg_bot_image_id",
    "tg_bot_compose_config_hash", "tg_bot_running", "tg_bot_health", "tg_bot_restart_count",
    "tg_bot_entrypoint", "tg_bot_cmd", "tg_bot_declared_user", "tg_bot_working_dir",
    "postgres_container_id", "postgres_image_id", "database_identity_sha256",
    "migration_ledger_sha256", "outbox_catalog_state", "outbox_counts",
    "secret_values_emitted", "production_mutated",
}
AUTHORITY_KEYS = {
    "schema", "source", "tg_bot_patch_path", "tg_bot_patch_baseline_state",
    "tg_bot_patch_baseline_manifest_file_sha256", "tg_bot_patch_baseline_manifest_sha256",
    "outbox_catalog_sha256",
}
CAPTURE_KEYS = {
    "schema", "started_at", "completed_at", "duration_seconds", "commands",
    "commands_sha256", "cross_consistency", "cross_consistency_sha256",
    "secret_values_emitted", "production_mutated",
}
COMMAND_RECORD_KEYS = {
    "sequence", "command_id", "argv", "argv_sha256", "response_bytes",
    "response_sha256", "response_json", "response_timestamp", "response_projection",
    "response_projection_sha256",
}
CROSS_CHECKS = [
    "runtime-identity", "profile-identity", "audit-chain", "gravity-runtime",
    "telegram-runtime", "postgres-runtime", "database-container", "database-ledger",
    "repository-manifest", "outbox-state", "read-only-no-secrets",
]


class CaptureError(ValueError):
    pass


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise CaptureError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def parse_json_bytes(raw: bytes, label: str) -> object:
    if not raw or len(raw) > MAX_RESPONSE_BYTES or not raw.endswith(b"\n") or raw.endswith(b"\n\n"):
        raise CaptureError(f"{label} is not one bounded newline-terminated response")
    try:
        text = raw.decode("ascii")
        value = json.loads(text, object_pairs_hook=reject_duplicate_keys)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise CaptureError(f"{label} is not duplicate-safe ASCII JSON") from exc
    if raw != canonical(value):
        raise CaptureError(f"{label} is not canonical JSON")
    return value


def exact_dict(value: object, keys: set[str], label: str) -> dict[str, object]:
    if type(value) is not dict or set(value) != keys:
        raise CaptureError(f"invalid exact-key {label}")
    return value


def parse_utc(value: object, label: str) -> dt.datetime:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", value):
        raise CaptureError(f"invalid UTC timestamp: {label}")
    try:
        return dt.datetime.fromisoformat(value[:-1] + "+00:00").astimezone(UTC)
    except ValueError as exc:
        raise CaptureError(f"invalid UTC timestamp: {label}") from exc


def utc_text(value: dt.datetime) -> str:
    if value.tzinfo is None:
        raise CaptureError("capture clock must be timezone-aware")
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def command_argv(primitive: str, resource: str | None) -> list[str]:
    return [SUDO, "-n", RUNTIME, primitive] + ([] if resource is None else [resource])


def validate_sha_map(value: object, label: str) -> None:
    if type(value) is not dict or not value:
        raise CaptureError(f"invalid {label}")
    for path, identity in value.items():
        if not isinstance(path, str) or not path.startswith("/") or not isinstance(identity, str) or not SHA64.fullmatch(identity):
            raise CaptureError(f"invalid {label}")


def validate_docker_evidence(evidence: dict[str, object], resource: str) -> None:
    semantic = exact_dict(evidence["semantic"], DOCKER_SEMANTIC_KEYS, "docker semantic evidence")
    specifications: dict[str, dict[str, object]] = {
        "crm.container.gravity_mvp": {
            "name": "crm-gravity-mvp", "service": "gravity-mvp", "image": PREDECESSOR_IMAGE,
            "config_image": "yoko/crm-gravity-mvp:7aea2823efe50e13a156540993d424594025e403-profile-v1",
            "entrypoint": ["/usr/bin/tini", "--"], "cmd": ["npm", "run", "start"],
            "user": "app", "workdir": "/app", "compose": GRAVITY_COMPOSE,
        },
        "crm.container.telegram_bot": {
            "name": "crm-tg-bot", "service": "tg-bot", "image": TG_BOT_IMAGE,
            "config_image": "crm/tg-bot:latest",
            "entrypoint": ["/usr/bin/tini", "--", "/usr/local/bin/tg-bot-entrypoint"],
            "cmd": ["node", "start.js"], "user": "", "workdir": "/app", "compose": TG_COMPOSE,
        },
        "crm.container.postgres": {
            "name": "crm-postgres", "service": "postgres", "image": POSTGRES_IMAGE,
            "config_image": "postgres:16-alpine", "entrypoint": ["docker-entrypoint.sh"],
            "cmd": ["postgres"], "user": "", "workdir": "/", "compose": "b2d41ef4b67d60fa321dfbf67c251b4ef21e754537646e29cd3e4de2617d75ae",
        },
    }
    specification = specifications.get(resource)
    if specification is None:
        raise CaptureError("unexpected docker capture resource")
    environment_names = semantic["environment_names"]
    if (
        type(environment_names) is not list or len(environment_names) != len(set(environment_names))
        or any(not isinstance(name, str) or len(name) > 128 or not re.fullmatch(r"[A-Z][A-Z0-9_]*", name) for name in environment_names)
    ):
        raise CaptureError("docker response exposed non-name environment data")
    compose_labels = evidence["compose_labels"]
    semantic_labels = semantic["compose_labels"]
    if type(compose_labels) is not dict or type(semantic_labels) is not dict:
        raise CaptureError("invalid docker compose labels")
    expected_semantic_labels = {
        "com.docker.compose.config-hash": specification["compose"],
        "com.docker.compose.project": "crm",
        "com.docker.compose.service": specification["service"],
    }
    allowed_compose_labels = set(expected_semantic_labels) | {"com.docker.compose.image", "com.docker.compose.version"}
    if resource == "crm.container.gravity_mvp":
        allowed_compose_labels.add("org.opencontainers.image.revision")
    if (
        set(compose_labels) != allowed_compose_labels
        or any(not isinstance(key, str) or not isinstance(value, str) for key, value in compose_labels.items())
        or semantic_labels != expected_semantic_labels
    ):
        raise CaptureError("docker compose label identity mismatch")
    expected_oci = (
        {"org.opencontainers.image.revision": PREDECESSOR_COMMIT}
        if resource == "crm.container.gravity_mvp"
        else ({key: compose_labels[key] for key in ("com.docker.compose.project", "com.docker.compose.service", "com.docker.compose.version")} if resource == "crm.container.telegram_bot" else {})
    )
    if evidence["oci_labels"] != expected_oci:
        raise CaptureError("docker OCI labels mismatch")
    mounts = evidence["mounts"]
    semantic_mounts = semantic["mounts"]
    if type(mounts) is not list or type(semantic_mounts) is not list:
        raise CaptureError("invalid docker mounts")
    for mount in mounts:
        if type(mount) is not dict or set(mount) not in ({"name", "read_write", "target", "type"}, {"read_write", "source", "target", "type"}):
            raise CaptureError("invalid docker mount shape")
        if mount["type"] not in {"bind", "volume"} or type(mount["read_write"]) is not bool:
            raise CaptureError("invalid docker mount values")
        if any(not isinstance(mount[key], str) or not mount[key].startswith("/") for key in ("target",) + (("source",) if "source" in mount else ())):
            raise CaptureError("invalid docker mount path")
        if "name" in mount and (not isinstance(mount["name"], str) or not re.fullmatch(r"crm_[a-z0-9_]+", mount["name"])):
            raise CaptureError("invalid docker volume name")
    for mount in semantic_mounts:
        if type(mount) is not dict or set(mount) != {"destination", "read_only", "source_sha256", "type"}:
            raise CaptureError("invalid semantic mount shape")
        if (
            not isinstance(mount["destination"], str) or not mount["destination"].startswith("/")
            or type(mount["read_only"]) is not bool or mount["type"] not in {"bind", "volume"}
            or not isinstance(mount["source_sha256"], str) or not SHA64.fullmatch(mount["source_sha256"])
        ):
            raise CaptureError("invalid semantic mount value")
    for timestamp_key in ("created", "image_created", "started_at"):
        if not isinstance(evidence[timestamp_key], str) or len(evidence[timestamp_key]) > 40 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z", evidence[timestamp_key]):
            raise CaptureError("invalid docker timestamp")
    if (
        evidence["logical_resource"] != resource or evidence["name"] != specification["name"]
        or evidence["image_id"] != specification["image"] or evidence["config_image"] != specification["config_image"]
        or evidence["entrypoint"] != specification["entrypoint"] or evidence["cmd"] != specification["cmd"]
        or evidence["declared_user"] != specification["user"] or evidence["working_dir"] != specification["workdir"]
        or evidence["platform"] != "linux/amd64" or evidence["running"] is not True
        or evidence["status"] != "running" or evidence["health"] != "healthy"
        or type(evidence["restart_count"]) is not int or evidence["restart_count"] != 0
        or evidence["image_metadata_status"] != "available"
        or type(evidence["container_id"]) is not str or not SHA64.fullmatch(evidence["container_id"])
        or evidence["repo_digests"] != [f"{specification['config_image'].split(':', 1)[0]}@{specification['image']}"]
        or semantic["name"] != specification["name"] or semantic["image_id"] != specification["image"]
        or semantic["command"] != specification["cmd"] or semantic["entrypoint"] != specification["entrypoint"]
        or semantic["network_mode"] != "crm_internal" or semantic["network_names"] != ["crm_internal"]
        or semantic["privileged"] is not False or semantic["published_ports"] != {}
        or semantic["read_only_rootfs"] is not False
        or semantic["restart_policy"] != {"maximum_retry_count": 0, "name": "unless-stopped"}
    ):
        raise CaptureError("docker semantic cross-consistency mismatch")


def validate_repository_manifest(value: object) -> dict[str, object]:
    evidence = exact_dict(value, SNAPSHOT_MANIFEST_KEYS, "repository snapshot manifest")
    content = exact_dict(evidence["content_manifest"], CONTENT_MANIFEST_KEYS, "repository content manifest")
    entries = content["entries"]
    if type(entries) is not list or content["entry_count"] != len(entries) or len(entries) != 1606:
        raise CaptureError("repository content manifest count mismatch")
    seen: set[str] = set()
    for entry in entries:
        entry = exact_dict(entry, {"mode", "path", "sha256", "size"}, "repository manifest entry")
        path = entry["path"]
        if (
            not isinstance(path, str) or not path or path.startswith("/") or ".." in path.split("/")
            or path in seen or not isinstance(entry["mode"], str) or not re.fullmatch(r"0[0-7]{3}", entry["mode"])
            or not isinstance(entry["sha256"], str) or not SHA64.fullmatch(entry["sha256"])
            or type(entry["size"]) is not int or entry["size"] < 0
        ):
            raise CaptureError("unsafe repository content manifest entry")
        seen.add(path)
    by_path = {entry["path"]: entry for entry in entries}
    if (
        evidence["logical_resource"] != "crm.repo.production"
        or evidence["destination"] != "NONE: manifest-only bootstrap profile"
        or evidence["profile"] != "bounded-evidence-manifest-v1"
        or evidence["secrets_copied"] is not False
        or type(evidence["estimated_snapshot_bytes"]) is not int
        or evidence["estimated_snapshot_bytes"] < content["bytes"]
        or content["logical_resource"] != "crm.repo.production"
        or content["manifest_sha256"] != SOURCE_MANIFEST
        or content["manifest_sha256"] != digest(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode("ascii"))
        or entries != sorted(entries, key=lambda entry: entry["path"])
        or type(content["bytes"]) is not int or content["bytes"] != sum(entry["size"] for entry in entries)
        or type(content["excluded"]) is not dict
        or any(type(item) is not int for item in content["excluded"].values())
        or content["excluded"] != {"directories": 1, "oversized": 0, "secret_names": 7, "special": 0}
        or by_path.get("deploy/docker-compose.production.yml") != {
            "mode": "0644", "path": "deploy/docker-compose.production.yml",
            "sha256": COMPOSE_SHA, "size": 26817,
        }
    ):
        raise CaptureError("repository content manifest identity mismatch")
    storage = exact_dict(evidence["storage_preflight"], {"admissible", "available_bytes", "minimum_free_bytes"}, "snapshot storage preflight")
    if storage["admissible"] is not True or storage["minimum_free_bytes"] != 8589934592 or type(storage["available_bytes"]) is not int or storage["available_bytes"] < storage["minimum_free_bytes"]:
        raise CaptureError("repository snapshot storage preflight mismatch")
    return evidence


def validate_response(value: object, primitive: str, resource: str | None) -> dict[str, object]:
    response = exact_dict(value, TOP_RESPONSE_KEYS, f"{primitive} response")
    if response != {**response, "ok": True}:  # strict bool check below also rejects integer 1
        raise CaptureError(f"{primitive} response failed")
    if (
        response["ok"] is not True or response["errors"] != [] or response["warnings"] != []
        or response["schema"] != "yoko.privileged-runtime.response.v1"
        or response["runtime_version"] != RUNTIME_VERSION
        or response["primitive"] != primitive or response["resource"] != resource
    ):
        raise CaptureError(f"{primitive} response identity or success mismatch")
    parse_utc(response["timestamp"], f"{primitive} response")
    evidence = response["evidence"]
    if primitive == "version":
        evidence = exact_dict(evidence, VERSION_KEYS, "version evidence")
        if evidence != {
            "activation_profile": PROFILE_ID,
            "package_version": PACKAGE_VERSION,
            "response_schema": "yoko.privileged-runtime.response.v1",
            "runtime_version": RUNTIME_VERSION,
        }:
            raise CaptureError("version evidence mismatch")
    elif primitive == "self-check":
        evidence = exact_dict(evidence, SELF_CHECK_KEYS, "self-check evidence")
        audit = exact_dict(evidence["audit"], {"last_digest", "record_count", "state"}, "self-check audit")
        validate_sha_map(evidence["activation_profile_identity"], "activation profile identity")
        validate_sha_map(evidence["installed_identity"], "installed identity")
        if (
            evidence["activation_profile_id"] != PROFILE_ID
            or evidence["package_version"] != PACKAGE_VERSION
            or evidence["runtime_version"] != RUNTIME_VERSION
            or evidence["arbitrary_paths"] is not False
            or evidence["docker_socket_delegated"] is not False
            or evidence["generic_command_execution"] is not False
            or evidence["profile_argument_shape"] != "ZERO_ARGUMENT_ONLY"
            or not isinstance(evidence["activation_profile_manifest_sha256"], str)
            or not SHA64.fullmatch(evidence["activation_profile_manifest_sha256"])
            or not isinstance(evidence["policy_sha256"], str) or not SHA64.fullmatch(evidence["policy_sha256"])
            or not isinstance(evidence["registry_sha256"], str) or not SHA64.fullmatch(evidence["registry_sha256"])
            or audit != {"last_digest": AUDIT_DIGEST, "record_count": AUDIT_RECORDS, "state": "VALID"}
        ):
            raise CaptureError("self-check evidence mismatch")
    elif primitive == "audit-status":
        evidence = exact_dict(evidence, {"last_digest", "record_count", "state"}, "audit evidence")
        if evidence != {"last_digest": AUDIT_DIGEST, "record_count": AUDIT_RECORDS, "state": "VALID"}:
            raise CaptureError("audit evidence mismatch")
    elif primitive == "docker-inspect":
        evidence = exact_dict(evidence, DOCKER_KEYS, "docker evidence")
        if resource is None:
            raise CaptureError("docker capture resource missing")
        validate_docker_evidence(evidence, resource)
    elif primitive == "snapshot-manifest":
        if resource != "crm.repo.production":
            raise CaptureError("repository snapshot resource mismatch")
        validate_repository_manifest(evidence)
    elif primitive == "database-status":
        evidence = exact_dict(evidence, DATABASE_KEYS, "database evidence")
        counts = exact_dict(evidence["outbox_counts"], OUTBOX_COUNT_KEYS, "outbox counts")
        rows = evidence["canonical_live_rows"]
        if (
            evidence["profile_id"] != PROFILE_ID or evidence["read_only"] is not True
            or evidence["secret_values_emitted"] is not False
            or evidence["database_identity_sha256"] != DATABASE_IDENTITY
            or evidence["migration_ledger_sha256"] != MIGRATION_LEDGER
            or evidence["migration_state"] != "APPROVED_OUTBOX_APPLIED"
            or evidence["outbox_catalog_state"] != "EXACT"
            or evidence["applied_migration_count"] != 62
            or evidence["canonical_active_inventory_sha256"] != CANONICAL_ACTIVE_INVENTORY
            or evidence["expected_canonical_active_inventory_sha256"] != CANONICAL_ACTIVE_INVENTORY
            or evidence["canonical_active_map_exact"] is not True
            or evidence["canonical_live_chronology_exact"] is not True
            or evidence["expected_live_chronology_sha256"] != CANONICAL_LIVE_CHRONOLOGY
            or evidence["canonical_predecessor_entry_count"] != 61
            or evidence["canonical_target_name"] != CANONICAL_TARGET_NAME
            or evidence["canonical_target_checksum"] != CANONICAL_TARGET_CHECKSUM
            or type(rows) is not list
            or len(rows) != 62
            or evidence["canonical_live_rows_sha256"] != hashlib.sha256(
                json.dumps(rows, sort_keys=True, separators=(",", ":")).encode("ascii")
            ).hexdigest()
            or any(
                type(row) is not dict
                or set(row) != DATABASE_ROW_KEYS
                or row["observed_chronological_ordinal"] != index
                or not isinstance(row["migration_name"], str)
                or not re.fullmatch(r"[0-9][A-Za-z0-9_-]{1,199}", row["migration_name"])
                or not isinstance(row["checksum"], str)
                or not SHA64.fullmatch(row["checksum"])
                or not isinstance(row["migration_id"], str)
                or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", row["migration_id"])
                or row["status"] != "FINISHED_ACTIVE"
                or row["rolled_back_at"] is not None
                or not isinstance(row["started_at"], str)
                or not isinstance(row["finished_at"], str)
                or type(row["applied_steps_count"]) is not int
                or row["applied_steps_count"] < 0
                or type(row["logs_present"]) is not bool
                or (
                    row["logs_present"]
                    and (
                        type(row["logs_bytes"]) is not int
                        or row["logs_bytes"] < 0
                        or not isinstance(row["logs_sha256"], str)
                        or not SHA64.fullmatch(row["logs_sha256"])
                    )
                )
                or (
                    not row["logs_present"]
                    and (row["logs_bytes"] is not None or row["logs_sha256"] is not None)
                )
                for index, row in enumerate(rows, 1)
            )
            or len({row["migration_name"] for row in rows}) != 62
            or len({row["migration_id"] for row in rows}) != 62
            or rows[-1]["migration_name"] != CANONICAL_TARGET_NAME
            or rows[-1]["checksum"] != CANONICAL_TARGET_CHECKSUM
            or evidence["interrupted_target_migrations"] != 0
            or evidence["rolled_back_target_migrations"] != 0
            or evidence["server_version_num"] != "160014"
            or any(type(count) is not int for count in counts.values())
            or counts["total"] < 1
            or counts["published"] != counts["total"]
            or any(counts[key] != 0 for key in (
                "dead_letter", "over_attempt_limit", "pending", "processing",
                "retry_wait", "stale_claimed",
            ))
        ):
            raise CaptureError("database read-only evidence mismatch")
        for row in rows:
            started_at = parse_utc(row["started_at"], "migration row start")
            finished_at = parse_utc(row["finished_at"], "migration row finish")
            if finished_at < started_at:
                raise CaptureError("database migration row chronology mismatch")
        for key in ("database_name_sha256", "database_user_sha256", "system_identifier_sha256"):
            if not isinstance(evidence[key], str) or not SHA64.fullmatch(evidence[key]):
                raise CaptureError(f"invalid database identity component: {key}")
    else:
        raise CaptureError("non-read-only primitive is outside the finite capture plan")
    return response


def project_response(response: dict[str, object], primitive: str, resource: str | None) -> dict[str, object]:
    evidence = response["evidence"]
    if primitive in {"version", "audit-status", "database-status"}:
        return evidence  # already a small exact allowlist
    if primitive == "self-check":
        return {
            key: evidence[key]
            for key in (
                "activation_profile_id", "activation_profile_manifest_sha256", "arbitrary_paths",
                "audit", "docker_socket_delegated", "generic_command_execution", "package_version",
                "policy_sha256", "profile_argument_shape", "registry_sha256", "runtime_version",
            )
        }
    if primitive == "docker-inspect":
        compose = evidence["compose_labels"]
        semantic = evidence["semantic"]
        return {
            key: evidence[key]
            for key in (
                "cmd", "container_id", "declared_user", "entrypoint", "health", "image_id",
                "logical_resource", "name", "restart_count", "running", "status", "working_dir",
            )
        } | {
            "compose_config_hash": compose["com.docker.compose.config-hash"],
            "compose_project": compose["com.docker.compose.project"],
            "compose_service": compose["com.docker.compose.service"],
            "oci_revision": evidence["oci_labels"].get("org.opencontainers.image.revision"),
            "environment_names_sha256": digest(canonical(semantic["environment_names"])),
            "mounts_sha256": digest(canonical(evidence["mounts"])),
            "semantic_sha256": digest(canonical(semantic)),
        }
    if primitive == "snapshot-manifest":
        content = evidence["content_manifest"]
        entries = {entry["path"]: entry for entry in content["entries"]}
        return {
            "logical_resource": evidence["logical_resource"],
            "profile": evidence["profile"],
            "secrets_copied": evidence["secrets_copied"],
            "content_manifest": {
                key: content[key]
                for key in ("bytes", "entry_count", "excluded", "logical_resource", "manifest_sha256")
            },
            "compose_entry": entries["deploy/docker-compose.production.yml"],
        }
    raise CaptureError("non-read-only primitive is outside the finite capture plan")


def validate_projection(value: object, primitive: str, resource: str | None) -> dict[str, object]:
    if primitive == "version":
        projection = exact_dict(value, VERSION_KEYS, "version projection")
        if projection != {
            "activation_profile": PROFILE_ID, "package_version": PACKAGE_VERSION,
            "response_schema": "yoko.privileged-runtime.response.v1", "runtime_version": RUNTIME_VERSION,
        }:
            raise CaptureError("version projection mismatch")
        return projection
    if primitive == "self-check":
        keys = {
            "activation_profile_id", "activation_profile_manifest_sha256", "arbitrary_paths", "audit",
            "docker_socket_delegated", "generic_command_execution", "package_version", "policy_sha256",
            "profile_argument_shape", "registry_sha256", "runtime_version",
        }
        projection = exact_dict(value, keys, "self-check projection")
        audit = exact_dict(projection["audit"], {"last_digest", "record_count", "state"}, "self-check audit projection")
        if (
            projection["activation_profile_id"] != PROFILE_ID or projection["package_version"] != PACKAGE_VERSION
            or projection["runtime_version"] != RUNTIME_VERSION or projection["arbitrary_paths"] is not False
            or projection["docker_socket_delegated"] is not False or projection["generic_command_execution"] is not False
            or projection["profile_argument_shape"] != "ZERO_ARGUMENT_ONLY"
            or audit != {"last_digest": AUDIT_DIGEST, "record_count": AUDIT_RECORDS, "state": "VALID"}
        ):
            raise CaptureError("self-check projection mismatch")
        for key in ("activation_profile_manifest_sha256", "policy_sha256", "registry_sha256"):
            if not isinstance(projection[key], str) or not SHA64.fullmatch(projection[key]):
                raise CaptureError("self-check projection digest mismatch")
        return projection
    if primitive == "audit-status":
        projection = exact_dict(value, {"last_digest", "record_count", "state"}, "audit projection")
        if projection != {"last_digest": AUDIT_DIGEST, "record_count": AUDIT_RECORDS, "state": "VALID"}:
            raise CaptureError("audit projection mismatch")
        return projection
    if primitive == "docker-inspect":
        keys = {
            "cmd", "compose_config_hash", "compose_project", "compose_service", "container_id",
            "declared_user", "entrypoint", "environment_names_sha256", "health", "image_id",
            "logical_resource", "mounts_sha256", "name", "oci_revision", "restart_count", "running",
            "semantic_sha256", "status", "working_dir",
        }
        projection = exact_dict(value, keys, "docker projection")
        specifications = {
            "crm.container.gravity_mvp": ("crm-gravity-mvp", "gravity-mvp", PREDECESSOR_IMAGE, GRAVITY_COMPOSE, ["/usr/bin/tini", "--"], ["npm", "run", "start"], "app", "/app", PREDECESSOR_COMMIT),
            "crm.container.telegram_bot": ("crm-tg-bot", "tg-bot", TG_BOT_IMAGE, TG_COMPOSE, ["/usr/bin/tini", "--", "/usr/local/bin/tg-bot-entrypoint"], ["node", "start.js"], "", "/app", None),
            "crm.container.postgres": ("crm-postgres", "postgres", POSTGRES_IMAGE, "b2d41ef4b67d60fa321dfbf67c251b4ef21e754537646e29cd3e4de2617d75ae", ["docker-entrypoint.sh"], ["postgres"], "", "/", None),
        }
        expected = specifications.get(resource)
        if expected is None:
            raise CaptureError("unexpected docker projection resource")
        name, service, image, compose_hash, entrypoint, command, user, workdir, revision = expected
        if type(projection["restart_count"]) is not int or canonical(projection) != canonical({
            **projection,
            "cmd": command, "compose_config_hash": compose_hash, "compose_project": "crm",
            "compose_service": service, "declared_user": user, "entrypoint": entrypoint,
            "health": "healthy", "image_id": image, "logical_resource": resource, "name": name,
            "oci_revision": revision, "restart_count": 0, "running": True, "status": "running",
            "working_dir": workdir,
        }):
            raise CaptureError("docker projection predecessor mismatch")
        if not isinstance(projection["container_id"], str) or not SHA64.fullmatch(projection["container_id"]):
            raise CaptureError("docker projection container identity mismatch")
        for key in ("environment_names_sha256", "mounts_sha256", "semantic_sha256"):
            if not isinstance(projection[key], str) or not SHA64.fullmatch(projection[key]):
                raise CaptureError("docker projection digest mismatch")
        return projection
    if primitive == "snapshot-manifest":
        projection = exact_dict(value, {"logical_resource", "profile", "secrets_copied", "content_manifest", "compose_entry"}, "repository manifest projection")
        content = exact_dict(projection["content_manifest"], {"bytes", "entry_count", "excluded", "logical_resource", "manifest_sha256"}, "content manifest projection")
        compose_entry = exact_dict(projection["compose_entry"], {"mode", "path", "sha256", "size"}, "compose entry projection")
        if (
            projection["logical_resource"] != "crm.repo.production" or projection["profile"] != "bounded-evidence-manifest-v1"
            or projection["secrets_copied"] is not False or content != {
                "bytes": 37905109, "entry_count": 1606,
                "excluded": {"directories": 1, "oversized": 0, "secret_names": 7, "special": 0},
                "logical_resource": "crm.repo.production", "manifest_sha256": SOURCE_MANIFEST,
            }
            or compose_entry != {"mode": "0644", "path": "deploy/docker-compose.production.yml", "sha256": COMPOSE_SHA, "size": 26817}
        ):
            raise CaptureError("repository manifest projection mismatch")
        return projection
    if primitive == "database-status":
        projection = exact_dict(value, DATABASE_KEYS, "database projection")
        synthetic = {
            "errors": [], "evidence": projection, "ok": True, "primitive": primitive, "resource": None,
            "runtime_version": RUNTIME_VERSION, "schema": "yoko.privileged-runtime.response.v1",
            "timestamp": "2000-01-01T00:00:00Z", "warnings": [],
        }
        validate_response(synthetic, primitive, None)
        return projection
    raise CaptureError("non-read-only primitive is outside the finite capture plan")


def response_evidence(responses: dict[tuple[str, str | None], dict[str, object]], primitive: str, resource: str | None = None) -> dict[str, object]:
    return responses[(primitive, resource)]["evidence"]  # type: ignore[return-value]


def validate_command_record(record: object, index: int, primitive: str, resource: str | None) -> dict[str, object]:
    record = exact_dict(record, COMMAND_RECORD_KEYS, f"command record {index}")
    expected_argv = command_argv(primitive, resource)
    if (
        type(record["sequence"]) is not int or record["sequence"] != index
        or record["command_id"] != f"{index:02d}:{primitive}:{resource or '-'}"
        or record["argv"] != expected_argv or record["argv_sha256"] != digest(canonical(expected_argv))
        or type(record["response_bytes"]) is not int or record["response_bytes"] < 2
        or not isinstance(record["response_sha256"], str) or not SHA64.fullmatch(record["response_sha256"])
        or not isinstance(record["response_json"], str)
        or record["response_projection_sha256"] != digest(canonical(record["response_projection"]))
    ):
        raise CaptureError("capture transcript command identity mismatch")
    raw = (record["response_json"] + "\n").encode("ascii")
    if len(raw) != record["response_bytes"] or digest(raw) != record["response_sha256"]:
        raise CaptureError("capture transcript response hash mismatch")
    response = validate_response(parse_json_bytes(raw, f"command {index}"), primitive, resource)
    if response["timestamp"] != record["response_timestamp"]:
        raise CaptureError("capture transcript response timestamp mismatch")
    derived_projection = project_response(response, primitive, resource)
    if canonical(derived_projection) != canonical(record["response_projection"]):
        raise CaptureError("capture transcript projection is not response-derived")
    projection = validate_projection(derived_projection, primitive, resource)
    return {"timestamp": record["response_timestamp"], "evidence": projection}


def build_snapshot(records: list[dict[str, object]], started: dt.datetime, completed: dt.datetime) -> dict[str, object]:
    if len(records) != len(COMMANDS):
        raise CaptureError("capture transcript command count mismatch")
    responses: dict[tuple[str, str | None], dict[str, object]] = {}
    for index, ((primitive, resource), record) in enumerate(zip(COMMANDS, records), 1):
        responses[(primitive, resource)] = validate_command_record(record, index, primitive, resource)

    started_at = parse_utc(utc_text(started), "capture start")
    completed_at = parse_utc(utc_text(completed), "capture end")
    duration = int((completed_at - started_at).total_seconds())
    if duration < 0 or duration > MAX_CAPTURE_SECONDS:
        raise CaptureError("capture duration is outside the finite bound")
    for response in responses.values():
        observed = parse_utc(response["timestamp"], "runtime response")
        if observed < started_at - dt.timedelta(seconds=1) or observed > completed_at + dt.timedelta(seconds=1):
            raise CaptureError("runtime response timestamp is outside capture interval")

    version = response_evidence(responses, "version")
    self_check = response_evidence(responses, "self-check")
    audit = response_evidence(responses, "audit-status")
    gravity = response_evidence(responses, "docker-inspect", "crm.container.gravity_mvp")
    telegram = response_evidence(responses, "docker-inspect", "crm.container.telegram_bot")
    postgres = response_evidence(responses, "docker-inspect", "crm.container.postgres")
    repository = response_evidence(responses, "snapshot-manifest", "crm.repo.production")
    database = response_evidence(responses, "database-status")
    if self_check["audit"] != audit:
        raise CaptureError("self-check and audit-status are inconsistent")
    expected_docker = (
        (gravity, "crm-gravity-mvp", PREDECESSOR_IMAGE, "gravity-mvp"),
        (telegram, "crm-tg-bot", TG_BOT_IMAGE, "tg-bot"),
        (postgres, "crm-postgres", POSTGRES_IMAGE, "postgres"),
    )
    for evidence, name, image, service in expected_docker:
        if (
            evidence["name"] != name or evidence["image_id"] != image
            or evidence["compose_project"] != "crm"
            or evidence["compose_service"] != service
        ):
            raise CaptureError("captured container is not the exact predecessor resource")
    if (
        gravity["compose_config_hash"] != GRAVITY_COMPOSE
        or gravity["oci_revision"] != PREDECESSOR_COMMIT
        or telegram["compose_config_hash"] != TG_COMPOSE
        or database["postgres_container_id"] != postgres["container_id"]
        or database["postgres_image_id"] != postgres["image_id"]
    ):
        raise CaptureError("container, revision, compose, or database identity drift")

    cross_consistency = {"status": "PASS", "checks": CROSS_CHECKS}
    capture: dict[str, object] = {
        "schema": "yoko.crm.read-only-production-capture-transcript.v2",
        "started_at": utc_text(started),
        "completed_at": utc_text(completed),
        "duration_seconds": duration,
        "commands": records,
        "commands_sha256": digest(canonical(records)),
        "cross_consistency": cross_consistency,
        "cross_consistency_sha256": digest(canonical(cross_consistency)),
        "secret_values_emitted": False,
        "production_mutated": False,
    }
    repository_content = repository["content_manifest"]
    observed: dict[str, object] = {
        "runtime_package_version": version["package_version"],
        "runtime_abi": version["runtime_version"],
        "profile_id": version["activation_profile"],
        "audit_state": audit["state"],
        "audit_records": audit["record_count"],
        "audit_last_digest": audit["last_digest"],
        "source_manifest_sha256": repository_content["manifest_sha256"],
        "compose_sha256": repository["compose_entry"]["sha256"],
        "compose_config_hash": gravity["compose_config_hash"],
        "gravity_container_id": gravity["container_id"],
        "gravity_image_id": gravity["image_id"],
        "gravity_oci_revision": gravity["oci_revision"],
        "gravity_running": gravity["running"],
        "gravity_health": gravity["health"],
        "gravity_restart_count": gravity["restart_count"],
        "tg_bot_container_id": telegram["container_id"],
        "tg_bot_image_id": telegram["image_id"],
        "tg_bot_compose_config_hash": telegram["compose_config_hash"],
        "tg_bot_running": telegram["running"],
        "tg_bot_health": telegram["health"],
        "tg_bot_restart_count": telegram["restart_count"],
        "tg_bot_entrypoint": telegram["entrypoint"],
        "tg_bot_cmd": telegram["cmd"],
        "tg_bot_declared_user": telegram["declared_user"],
        "tg_bot_working_dir": telegram["working_dir"],
        "postgres_container_id": postgres["container_id"],
        "postgres_image_id": postgres["image_id"],
        "database_identity_sha256": database["database_identity_sha256"],
        "migration_ledger_sha256": database["migration_ledger_sha256"],
        "outbox_catalog_state": database["outbox_catalog_state"],
        "outbox_counts": database["outbox_counts"],
        "secret_values_emitted": False,
        "production_mutated": False,
    }
    sealed_predecessor_authority: dict[str, object] = {
        "schema": "yoko.crm.sealed-predecessor-authority.v2",
        "source": "exact-container-sanitized-runtime-content-manifest",
        "tg_bot_patch_path": "/app/src/public-bot-maintenance.js",
        "tg_bot_patch_baseline_state": TG_PATCH_BASELINE_STATE,
        "tg_bot_patch_baseline_manifest_file_sha256": TG_BASELINE_MANIFEST_FILE_SHA,
        "tg_bot_patch_baseline_manifest_sha256": TG_BASELINE_MANIFEST_SHA,
        "outbox_catalog_sha256": OUTBOX_CATALOG,
    }
    snapshot: dict[str, object] = {
        "schema": "yoko.crm.source-only-production-snapshot.v3",
        "status": "ACCEPTED_READ_ONLY_CAPTURE",
        "captured_at": utc_text(completed),
        "host": HOST,
        "observed": observed,
        "sealed_predecessor_authority": sealed_predecessor_authority,
        "capture": capture,
        "capture_transcript_sha256": digest(canonical(capture)),
    }
    return snapshot


def capture_snapshot(
    runner: Callable[[list[str]], bytes] | None = None,
    clock: Callable[[], dt.datetime] | None = None,
) -> dict[str, object]:
    runner = runner or run_read_only
    clock = clock or (lambda: dt.datetime.now(UTC))
    if os.uname().nodename != HOST:
        raise CaptureError("capture host is not the exact production host")
    started = clock()
    records: list[dict[str, object]] = []
    for index, (primitive, resource) in enumerate(COMMANDS, 1):
        argv = command_argv(primitive, resource)
        raw = runner(argv)
        response = validate_response(parse_json_bytes(raw, f"{primitive} response"), primitive, resource)
        projection = project_response(response, primitive, resource)
        records.append({
            "sequence": index,
            "command_id": f"{index:02d}:{primitive}:{resource or '-'}",
            "argv": argv,
            "argv_sha256": digest(canonical(argv)),
            "response_bytes": len(raw),
            "response_sha256": digest(raw),
            "response_json": raw[:-1].decode("ascii"),
            "response_timestamp": response["timestamp"],
            "response_projection": projection,
            "response_projection_sha256": digest(canonical(projection)),
        })
    completed = clock()
    return build_snapshot(records, started, completed)


def run_read_only(argv: list[str]) -> bytes:
    expected = [command_argv(primitive, resource) for primitive, resource in COMMANDS]
    if argv not in expected:
        raise CaptureError("attempted command is outside the finite read-only capture plan")
    result = subprocess.run(
        argv, check=False, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=30, env={},
    )
    if result.returncode != 0 or result.stderr:
        raise CaptureError("read-only Runtime capture command failed or wrote stderr")
    return result.stdout


def validate_snapshot_document(value: object, now: dt.datetime | None = None) -> dict[str, object]:
    snapshot = exact_dict(value, SNAPSHOT_KEYS, "production snapshot")
    exact_dict(snapshot["observed"], OBSERVED_KEYS, "observed production state")
    exact_dict(snapshot["sealed_predecessor_authority"], AUTHORITY_KEYS, "sealed predecessor authority")
    capture = exact_dict(snapshot["capture"], CAPTURE_KEYS, "production capture transcript")
    if snapshot["capture_transcript_sha256"] != digest(canonical(capture)):
        raise CaptureError("production capture transcript digest mismatch")
    records = capture["commands"]
    if type(records) is not list or capture["commands_sha256"] != digest(canonical(records)):
        raise CaptureError("production capture command transcript digest mismatch")
    cross = exact_dict(capture["cross_consistency"], {"status", "checks"}, "capture cross-consistency")
    if (
        cross != {"status": "PASS", "checks": CROSS_CHECKS}
        or capture["cross_consistency_sha256"] != digest(canonical(cross))
        or capture["secret_values_emitted"] is not False
        or capture["production_mutated"] is not False
    ):
        raise CaptureError("production capture cross-consistency proof mismatch")
    started = parse_utc(capture["started_at"], "capture start")
    completed = parse_utc(capture["completed_at"], "capture end")
    duration = int((completed - started).total_seconds())
    if (
        duration < 0 or duration > MAX_CAPTURE_SECONDS
        or type(capture["duration_seconds"]) is not int or capture["duration_seconds"] != duration
        or snapshot["captured_at"] != capture["completed_at"]
    ):
        raise CaptureError("production capture interval mismatch")
    current = (now or dt.datetime.now(UTC)).astimezone(UTC)
    age = (current - completed).total_seconds()
    if age < -MAX_FUTURE_SKEW_SECONDS or age > MAX_SNAPSHOT_AGE_SECONDS:
        raise CaptureError("production snapshot is stale or from the future")
    rebuilt = build_snapshot(records, started, completed)
    if canonical(snapshot) != canonical(rebuilt):
        raise CaptureError("production snapshot fields are not transcript-derived")
    return snapshot


def sealing_values(snapshot: dict[str, object]) -> dict[str, object]:
    """Return compatibility values while preserving live-vs-authority provenance in the file."""
    observed = exact_dict(snapshot["observed"], OBSERVED_KEYS, "observed production state")
    authority = exact_dict(snapshot["sealed_predecessor_authority"], AUTHORITY_KEYS, "sealed predecessor authority")
    overlap = set(observed) & set(authority)
    if overlap:
        raise CaptureError("observed and sealed-authority fields overlap")
    return {**observed, **{key: value for key, value in authority.items() if key not in {"schema", "source"}}}


def load_snapshot(path: Path, now: dt.datetime | None = None) -> dict[str, object]:
    raw = path.read_bytes()
    if len(raw) > 8 * 1024 * 1024:
        raise CaptureError("production snapshot exceeds bounded size")
    try:
        value = json.loads(raw.decode("ascii"), object_pairs_hook=reject_duplicate_keys)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise CaptureError("production snapshot is not duplicate-safe ASCII JSON") from exc
    return validate_snapshot_document(value, now=now)


def main() -> None:
    if len(sys.argv) != 1:
        raise SystemExit("capture-production-snapshot.py accepts no arguments and writes one JSON document to stdout")
    try:
        value = capture_snapshot()
    except (CaptureError, OSError, subprocess.SubprocessError) as exc:
        raise SystemExit(f"read-only production capture failed: {exc}") from exc
    sys.stdout.buffer.write((json.dumps(value, indent=2, sort_keys=True) + "\n").encode("ascii"))


if __name__ == "__main__":
    main()
