#!/usr/bin/python3 -I
"""Capture one fresh secret-safe v14 production predecessor snapshot."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import subprocess
import sys
from typing import Any


RUNTIME = "/usr/local/sbin/yoko-privileged-runtime"
EXPECTED_PROFILE = "crm-41f69fe8fe3f-gravity-source-v1"
COMMANDS: tuple[tuple[str, str | None], ...] = (
    ("version", None),
    ("self-check", None),
    ("audit-status", None),
    ("storage-status", None),
    ("predecessor-observe", None),
    ("docker-inspect", "crm.container.gravity_mvp"),
    ("docker-inspect", "crm.container.max_scraper"),
    ("docker-inspect", "crm.container.postgres"),
    ("database-status", None),
    ("docker-provenance", None),
)


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def duplicate_safe(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key, value in pairs:
        if key in output:
            raise ValueError("duplicate JSON key")
        output[key] = value
    return output


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run(primitive: str, resource: str | None) -> dict[str, Any]:
    argv = ["/usr/bin/sudo", "-n", RUNTIME, primitive]
    if resource is not None:
        argv.append(resource)
    completed = subprocess.run(
        argv,
        check=False,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=180,
        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C", "TZ": "UTC"},
    )
    if completed.returncode != 0 or completed.stderr:
        raise ValueError(f"read-only Runtime command failed: {primitive}")
    try:
        value = json.loads(completed.stdout.decode("ascii"), object_pairs_hook=duplicate_safe)
    except (UnicodeError, ValueError) as exc:
        raise ValueError(f"invalid Runtime response: {primitive}") from exc
    if (
        not isinstance(value, dict)
        or value.get("schema") != "yoko.privileged-runtime.response.v1"
        or value.get("runtime_version") != "2.0.0"
        or value.get("primitive") != primitive
        or value.get("resource") != resource
        or value.get("ok") is not True
        or value.get("errors") != []
        or not isinstance(value.get("evidence"), dict)
    ):
        raise ValueError(f"Runtime response contract failed: {primitive}")
    return value


def project_migration_rows(database: dict[str, Any]) -> list[dict[str, Any]]:
    rows = database.get("canonical_live_rows")
    if not isinstance(rows, list) or len(rows) != 62:
        raise ValueError("unexpected migration row count")
    output = []
    for row in rows:
        if not isinstance(row, dict) or row.get("status") != "FINISHED_ACTIVE":
            raise ValueError("migration row is not active")
        output.append({
            "ordinal": row.get("observed_chronological_ordinal"),
            "id": row.get("migration_id"),
            "checksum": row.get("checksum"),
            "migration_name": row.get("migration_name"),
            "finished_at": row.get("finished_at"),
            "rolled_back_at": row.get("rolled_back_at"),
            "started_at": row.get("started_at"),
            "applied_steps_count": row.get("applied_steps_count"),
        })
    if [row["ordinal"] for row in output] != list(range(1, 63)):
        raise ValueError("migration chronology is invalid")
    return output


def main() -> None:
    if len(sys.argv) != 1:
        raise SystemExit("capture accepts no arguments")
    started = now()
    records: dict[str, dict[str, Any]] = {}
    for primitive, resource in COMMANDS:
        key = primitive if resource is None else f"{primitive}:{resource}"
        records[key] = run(primitive, resource)
    completed = now()
    version = records["version"]["evidence"]
    audit = records["audit-status"]["evidence"]
    predecessor = records["predecessor-observe"]["evidence"]
    gravity = records["docker-inspect:crm.container.gravity_mvp"]["evidence"]
    maximum = records["docker-inspect:crm.container.max_scraper"]["evidence"]
    postgres = records["docker-inspect:crm.container.postgres"]["evidence"]
    database = records["database-status"]["evidence"]
    provenance = records["docker-provenance"]["evidence"]
    if version.get("package_version") != "2.0.0-14" or version.get("activation_profile") != EXPECTED_PROFILE:
        raise ValueError("installed Runtime predecessor mismatch")
    if audit.get("state") != "VALID" or not isinstance(audit.get("record_count"), int):
        raise ValueError("audit is not valid")
    if (
        predecessor.get("schema") != "yoko.crm.predecessor-recreation-observation.v1"
        or predecessor.get("production_mutated") is not False
        or predecessor.get("secret_values_emitted") is not False
        or predecessor.get("compose_source", {}).get("compose_file_sha256") != "84a9f46904a65a69afcf19d2e56162e026b29718da52c43160abfc5449f84cc1"
    ):
        raise ValueError("predecessor observation mismatch")
    expected_resources = {
        "gravity": (gravity, "crm.container.gravity_mvp", "sha256:5531c67e99b572356f897246b8c845ab4f9b232d9dc029fa311397e46a4d715c"),
        "max": (maximum, "crm.container.max_scraper", "sha256:87835969ed6335a99d50e1cc2eaf70aa33fdbaf937f4cef658a926f55b26f365"),
        "postgres": (postgres, "crm.container.postgres", "sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229"),
    }
    for label, (record, logical, image) in expected_resources.items():
        if record.get("logical_resource") != logical or record.get("image_id") != image or record.get("running") is not True or record.get("health") != "healthy" or record.get("restart_count") != 0:
            raise ValueError(f"{label} predecessor mismatch")
    if maximum.get("mounts") != [{"name": "crm_max_user_data", "read_write": True, "target": "/app/user_data", "type": "volume"}]:
        raise ValueError("MAX persistent volume mismatch")
    if (
        database.get("profile_id") != EXPECTED_PROFILE
        or database.get("read_only") is not True
        or database.get("secret_values_emitted") is not False
        or database.get("migration_state") != "APPROVED_OUTBOX_APPLIED"
        or database.get("applied_migration_count") != 62
        or database.get("database_identity_sha256") != "ed88dfeaad2a3dc2e759590d295992cd06531d4403d896ded00b21ea667be1c9"
    ):
        raise ValueError("database predecessor mismatch")
    if provenance.get("complete") is not True or provenance.get("failures") != []:
        raise ValueError("production provenance is incomplete")
    semantic_records = provenance.get("semantic", {}).get("records")
    if not isinstance(semantic_records, list):
        raise ValueError("production semantic provenance missing")
    unrelated = [row for row in semantic_records if isinstance(row, dict) and row.get("name") not in {"crm-gravity-mvp", "crm-max-scraper"}]
    migration_rows = project_migration_rows(database)
    snapshot = {
        "schema": "yoko.crm.coordinated-runtime-production-snapshot.v1",
        "started_at": started,
        "completed_at": completed,
        "production_mutated": False,
        "secret_values_emitted": False,
        "commands": records,
        "sealing": {
            "runtime_package_version": version["package_version"],
            "runtime_profile_id": version["activation_profile"],
            "audit_record_count": audit["record_count"],
            "audit_last_digest": audit["last_digest"],
            "predecessor_release_critical_identity_sha256": predecessor["release_critical_identity_sha256"],
            "gravity_container_id": gravity["container_id"],
            "gravity_image_id": gravity["image_id"],
            "gravity_compose_config_hash": gravity["compose_labels"]["com.docker.compose.config-hash"],
            "max_container_id": maximum["container_id"],
            "max_image_id": maximum["image_id"],
            "max_compose_config_hash": maximum["compose_labels"]["com.docker.compose.config-hash"],
            "max_volume_source_sha256": maximum["semantic"]["mounts"][0]["source_sha256"],
            "postgres_container_id": postgres["container_id"],
            "postgres_image_id": postgres["image_id"],
            "database_identity_sha256": database["database_identity_sha256"],
            "migration_rows": migration_rows,
            "migration_rows_sha256": digest(migration_rows),
            "unrelated_semantic_fingerprint_sha256": digest(unrelated),
        },
    }
    sys.stdout.buffer.write(canonical(snapshot) + b"\n")


if __name__ == "__main__":
    try:
        main()
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        sys.stderr.write(f"production snapshot failed: {exc}\n")
        raise SystemExit(1)
