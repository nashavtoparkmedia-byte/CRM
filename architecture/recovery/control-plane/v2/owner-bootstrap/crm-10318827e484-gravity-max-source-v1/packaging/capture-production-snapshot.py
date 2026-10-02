#!/usr/bin/python3 -I
"""Capture one fresh secret-safe production predecessor snapshot from the installed runtime."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import subprocess
import sys
from typing import Any


RUNTIME = "/usr/local/sbin/yoko-privileged-runtime"
# The snapshot describes the runtime that is installed right now, which is still
# 2.0.0-21 under its own profile. This must not follow the successor's id or the
# capture would refuse the very predecessor it exists to record.
EXPECTED_PROFILE = "crm-ba90ed4b6717-gravity-max-source-v1"
# The installed observer is the interim predecessor observation v2 (same-version 2.0.0-21
# interim package 0095ce04...). It reconstructs every predecessor from the layered stack the
# container recorded at creation; the snapshot pins that stack by role and digest.
PREDECESSOR_OBSERVER_SHA256 = "065fa50989b48ed8b49c76a4ddfc9e3df0b956e3362022c8a906f807085c8346"
OBSERVATION_SCHEMA = "yoko.crm.predecessor-recreation-observation.v2"
BASE_COMPOSE = "/opt/crm/deploy/docker-compose.production.yml"
BASE_COMPOSE_SHA256 = "84a9f46904a65a69afcf19d2e56162e026b29718da52c43160abfc5449f84cc1"
RUNTIME_OVERLAY = "/var/lib/yoko-privileged-runtime/profiles/crm-ba90ed4b6717-gravity-max-source-v1/activate.compose.yml"
DRIVER_AUTHORITY_OVERLAY = "/opt/codex-work/.release-prep/driver-authority-335cdae7/activate.driver-authority-335cdae7.compose.yml"
TELEGRAM_HOTFIX_OVERLAY = "/opt/crm/deploy/activate.telegram-hotfix-06e80099.compose.yml"
PREDECESSOR_LAYERS = [
    {
        "path": DRIVER_AUTHORITY_OVERLAY, "role": "image-only-overlay",
        "sha256": "b42611d09358ae21f75d7ec0c4f3398459dec19d6a3ef3efbf57d3577a47b84c",
        "image_pins": {
            "gravity-mvp": "yoko/crm-gravity-mvp:335cdae7391d-driver-authority-repair-v1",
            "tg-bot": "crm/tg-bot:2808af7ecbf1-telegram-bot-delivery-contract-v1",
        },
    },
    {
        "path": TELEGRAM_HOTFIX_OVERLAY, "role": "image-only-overlay",
        "sha256": "15733b79728e49535f8ed410b09b50de0aeddb22fa937ee73848bb80aa6e25ae",
        "image_pins": {
            "gravity-mvp": "yoko/crm-gravity-mvp:06e80099f1c3-telegram-contract-skew-hotfix-v1",
            "tg-bot": "crm/tg-bot:2808af7ecbf1-telegram-bot-delivery-contract-v1",
        },
    },
    {
        "path": RUNTIME_OVERLAY, "role": "runtime-profile-overlay",
        "sha256": "39648e2b8f07a2f5a42d26ca77fbec96c6c907465981c965005e8fe5b1f1d6cb",
    },
]
PREDECESSOR_STACKS = {
    "gravity-mvp": [BASE_COMPOSE, RUNTIME_OVERLAY, DRIVER_AUTHORITY_OVERLAY],
    "tg-bot": [BASE_COMPOSE, RUNTIME_OVERLAY, TELEGRAM_HOTFIX_OVERLAY],
    "max-web-scraper": [BASE_COMPOSE, RUNTIME_OVERLAY],
}
# MAX was recreated once from its own two-file stack (normalization) so that it carries
# the name .env.production gained after its previous creation; Gravity already did.
NORMALIZED_ENVIRONMENT_NAME = "CRM_TELEGRAM_CONNECTION_ID"
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


def validate_predecessor(predecessor: dict[str, Any]) -> None:
    """Accept only the v2 layered observation of exactly the pinned predecessor stack."""
    source = predecessor.get("compose_source")
    services = predecessor.get("services")
    if (
        predecessor.get("schema") != OBSERVATION_SCHEMA
        or predecessor.get("production_mutated") is not False
        or predecessor.get("secret_values_emitted") is not False
        or not isinstance(source, dict)
        or source.get("compose_file_sha256") != BASE_COMPOSE_SHA256
        or source.get("reconstruction_model") != "EFFECTIVE_LAYERED_CONTAINER_CREATION_STACK"
        or source.get("overlay_layers") != PREDECESSOR_LAYERS
        or not isinstance(services, list)
        or [item.get("compose_service") for item in services if isinstance(item, dict)] != list(PREDECESSOR_STACKS)
    ):
        raise ValueError("predecessor observation mismatch")
    for service in services:
        reconstruction = service.get("reconstruction") or {}
        environment = service.get("environment") or {}
        if (
            [layer.get("path") for layer in reconstruction.get("layers", [])] != PREDECESSOR_STACKS[service["compose_service"]]
            or reconstruction.get("model") != "EFFECTIVE_LAYERED_CONTAINER_CREATION_STACK"
            or environment.get("effective_values_match_reconstructed_compose_and_image") is not True
            or environment.get("plaintext_values_emitted") is not False
            or NORMALIZED_ENVIRONMENT_NAME not in environment.get("effective_key_set", [])
        ):
            raise ValueError(f"predecessor reconstruction mismatch: {service['compose_service']}")
    if not isinstance(predecessor.get("release_critical_identity_sha256"), str) or len(predecessor["release_critical_identity_sha256"]) != 64:
        raise ValueError("predecessor observation identity missing")


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
    if version.get("package_version") != "2.0.0-21" or version.get("activation_profile") != EXPECTED_PROFILE:
        raise ValueError("installed Runtime predecessor mismatch")
    if audit.get("state") != "VALID" or not isinstance(audit.get("record_count"), int):
        raise ValueError("audit is not valid")
    if records["self-check"]["evidence"].get("predecessor_observability_sha256") != PREDECESSOR_OBSERVER_SHA256:
        raise ValueError("installed predecessor observer is not observation v2")
    validate_predecessor(predecessor)
    expected_resources = {
        "gravity": (gravity, "crm.container.gravity_mvp", "sha256:4dbe322a88fb5a635ffa5abc2d1d22071ba941fc22ce460edde3cd185717868c"),
        "max": (maximum, "crm.container.max_scraper", "sha256:ede5efb412d462a01bb9965f97a698a2c4b4bd3fb24d4ac478b1710a9943c7c6"),
        "postgres": (postgres, "crm.container.postgres", "sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229"),
    }
    for label, (record, logical, image) in expected_resources.items():
        if record.get("logical_resource") != logical or record.get("image_id") != image or record.get("running") is not True or record.get("health") != "healthy" or record.get("restart_count") != 0:
            raise ValueError(f"{label} predecessor mismatch")
    if maximum.get("mounts") != [{"name": "crm_max_user_data", "read_write": True, "target": "/app/user_data", "type": "volume"}]:
        raise ValueError("MAX persistent volume mismatch")
    for label, record in (("gravity", gravity), ("max", maximum)):
        if NORMALIZED_ENVIRONMENT_NAME not in (record.get("semantic") or {}).get("environment_names", []):
            raise ValueError(f"{label} predecessor is not normalized")
    # The installed 2.0.0-21 profile was sealed against the same 63-row ledger this successor pins
    # (the 2.0.0-16 profile before it reported that ledger as DRIFTED from its 62-row baseline, so
    # both states stay accepted). The successor pins the ledger exactly: the count, the ledger digest
    # (re-derived read-only from the database, independently of this runtime) and the database
    # identity. Any other ledger still refuses the capture.
    if (
        database.get("profile_id") != EXPECTED_PROFILE
        or database.get("read_only") is not True
        or database.get("secret_values_emitted") is not False
        or database.get("state") not in {"EXACT", "DRIFTED"}
        or database.get("applied_migration_count") != 63
        or database.get("migration_rows_sha256") != "78de9c8e61312c0a28669eeedba76f3626d2c41e7df3ae6bf9f2c1270c51b27c"
        or database.get("database_identity_sha256") != "ed88dfeaad2a3dc2e759590d295992cd06531d4403d896ded00b21ea667be1c9"
    ):
        raise ValueError("database predecessor mismatch")
    if provenance.get("complete") is not True or provenance.get("failures") != []:
        raise ValueError("production provenance is incomplete")
    semantic_records = provenance.get("semantic", {}).get("records")
    if not isinstance(semantic_records, list):
        raise ValueError("production semantic provenance missing")
    unrelated = [row for row in semantic_records if isinstance(row, dict) and row.get("name") not in {"crm-gravity-mvp", "crm-max-scraper"}]
    # The coordinated predecessor runtime reports the canonical migration projection as a digest
    # it computed itself and does not expose the raw rows, so the snapshot carries that digest and
    # the applied count. The digest still commits to the exact ledger; it is produced one layer
    # earlier, by the privileged runtime, instead of being re-derived here from rows the same
    # runtime would have supplied anyway.
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
            "applied_migration_count": database["applied_migration_count"],
            "migration_rows_sha256": database["migration_rows_sha256"],
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
