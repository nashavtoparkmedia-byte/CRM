#!/usr/bin/python3 -I
"""Finite source-only release implementation rendered by seal-release.py.

All public operations have zero arguments. Targets, artifacts, SQL, container
names and rollback identity are constants in the root-owned profile. Child
processes always use argv arrays with a clean environment and shell=False.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tarfile
import time
import urllib.parse
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any, Iterator


PROFILE_ID = "@PROFILE_ID@"
PROFILE_DIR = f"/usr/local/share/yoko-privileged-runtime/profiles/{PROFILE_ID}"
PROFILE_PATH = PROFILE_DIR + "/profile.v1.json"
ARCHIVE_PATH = PROFILE_DIR + "/source.tar.gz"
GRAVITY_IMAGE_ARCHIVE_PATH = PROFILE_DIR + "/gravity-image.docker.tar"
MIGRATION_PATH = PROFILE_DIR + "/migration.sql"
ACTIVATION_ROOT = f"/var/lib/yoko-privileged-runtime/activation/{PROFILE_ID}"
STATE_PATH = ACTIVATION_ROOT + "/state.v1.json"
LOCK_PATH = ACTIVATION_ROOT + "/transaction.lock"
RELEASE_ROOT = ACTIVATION_ROOT + "/release"
# Runtime 2.0.0-8 already extracted this exact sealed source. The immutable
# content-specific root is intentionally reused only after full archive and
# extracted-tree identity validation.
SOURCE_ROOT = RELEASE_ROOT + "/source-@COMMIT_SHORT16@"
ACTIVATE_OVERLAY = ACTIVATION_ROOT + "/gravity-activate.compose.yml"
ROLLBACK_OVERLAY = ACTIVATION_ROOT + "/gravity-rollback.compose.yml"
TG_PATCH_CONTEXT = ACTIVATION_ROOT + "/tg-bot-patch-context"
MIGRATION_ENV = ACTIVATION_ROOT + "/migration.env"
PREVIEW_POSTGRES_ENV = ACTIVATION_ROOT + "/preview-postgres.env"
BACKUP_ROOT = ACTIVATION_ROOT + "/backup"
BACKUP_PATH = BACKUP_ROOT + "/pre-migration.dump"
DOCKER = "/usr/bin/docker"
PROFILE_SCHEMA = "yoko.crm.activation-profile.v1"
STATE_SCHEMA = "yoko.crm.activation-state.v1"
TARGET_TAG = "yoko/crm-gravity-mvp:@FINAL_COMMIT@-source-only-v1"
ROLLBACK_TAG = "yoko/crm-gravity-mvp:rollback-baf442f880ebca808897a0131a662c603a9119f65"
TG_TARGET_TAG = "yoko/crm-tg-bot:@FINAL_COMMIT@-public-capability-v1"
TG_ROLLBACK_TAG = "yoko/crm-tg-bot:rollback-0849c4c9912aecf3cb7c35b51abba22cdb1c85a385afa6c2746000d14b9835f6"
TG_BASE_IMAGE = "sha256:0849c4c9912aecf3cb7c35b51abba22cdb1c85a385afa6c2746000d14b9835f6"
TG_BASE_REFERENCE = "crm/tg-bot@sha256:0849c4c9912aecf3cb7c35b51abba22cdb1c85a385afa6c2746000d14b9835f6"
TG_PATCH_DESTINATION = "/app/src/public-bot-maintenance.js"
TG_PATCH_TARGET_SHA256 = "d31a95451e148423ce8ad0dad0b78d4d7a487f428d5103a05bd3fed4c454c247"
TG_PATCH_BASELINE_STATE = "ABSENT"
TG_PATCH_BASELINE_MANIFEST_FILE_SHA256 = "1bd1d5100cabeb37277262179ee1119b3dcd9154b9774947dcf218d38e4d19fe"
TG_PATCH_BASELINE_MANIFEST_SHA256 = "72397e9c7e3c728b94d1e5645da825ddd75216bfacd13212b4671fe15f206d56"
TG_DIFF_PROOF_CONTAINER = "yoko-crm-@COMMIT_SHORT16@-tg-diff-proof"
PRIOR_TARGET_TAG = "yoko/crm-gravity-mvp:7aea2823efe50e13a156540993d424594025e403-profile-v1"
TG_PREDECESSOR_REFERENCE = "crm/tg-bot:latest"
RECOVERY_SOURCE_COMMIT = "08b9145945b296d494cd0184eb2d32da886710cd"
RECOVERY_SOURCE_ARCHIVE_SHA256 = "e611c0192fd3592ce99410df002a3918ce849dfab5c9c1b4955b02f136f830b9"
RECOVERY_SOURCE_PROFILE_ID = "crm-08b9145945b2-gravity-source-v1"
RECOVERY_SOURCE_STATE_PATH = f"/var/lib/yoko-privileged-runtime/activation/{RECOVERY_SOURCE_PROFILE_ID}/state.v1.json"
RECOVERY_SOURCE_GRAVITY_TAG = f"yoko/crm-gravity-mvp:{RECOVERY_SOURCE_COMMIT}-source-only-v1"
RECOVERY_SOURCE_TG_TAG = f"yoko/crm-tg-bot:{RECOVERY_SOURCE_COMMIT}-public-capability-v1"
PREVIEW_NETWORK = "yoko-crm-af9646f5-preview"
PREVIEW_CONTAINER = "yoko-crm-af9646f5-postgres-preview"
PREVIEW_MIGRATION_RUNNER = "yoko-crm-af9646f5-preview-migrate"
ROLLBACK_PROOF_RUNNER = "yoko-crm-af9646f5-rollback-proof"
PRODUCTION_MIGRATION_RUNNER = "yoko-crm-af9646f5-production-migrate"
PRODUCTION_RESOLVE_RUNNER = "yoko-crm-af9646f5-production-resolve"
BACKUP_LIST_RUNNER = "yoko-crm-af9646f5-backup-list"
MIGRATION_NAME = "20260809140000_add_domain_outbox"
ACCEPTED_LIVE_CHRONOLOGY_SHA256 = "62aaa333a8df02cc9c255da14e8bb7ba70ed441098148846f1855c24623ac465"
EXPECTED_PROVENANCE_FAILURES: list[dict[str, str]] = [
    # Complete provenance is required; no missing resource is accepted.
]
APPLICATION_STABILIZATION_SECONDS = 90
APPLICATION_STABILIZATION_INTERVAL_SECONDS = 2
APPLICATION_STABILIZATION_REQUIRED_SUCCESSES = 2
SHA256 = re.compile(r"[0-9a-f]{64}")
DB_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_$.-]{0,62}")
_transaction_lock_fd: int | None = None


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


def _sha_file(path: Path, maximum: int = 64 * 1024 * 1024) -> str:
    value = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_size > maximum:
        raise RuntimeError("UNSAFE_FILE")
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    digest = hashlib.sha256()
    total = 0
    try:
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > maximum:
                raise RuntimeError("FILE_TOO_LARGE")
            digest.update(chunk)
    finally:
        os.close(fd)
    return digest.hexdigest()


def _load_profile(core: Any) -> dict[str, Any]:
    value = core.secure_file(PROFILE_PATH, 0o444, maximum=256 * 1024)
    try:
        profile = json.loads(core.mapped(PROFILE_PATH).read_text(encoding="ascii"))
    except (OSError, UnicodeError, ValueError) as exc:
        raise core.RuntimeFault("ACTIVATION_PROFILE_INVALID", 78) from exc
    required = {
        "schema", "profile_id", "host", "runtime_abi", "package_version",
        "accepted_source", "production", "migration", "recovery", "limits",
        "enabled_zero_argument_profiles", "disabled_profiles", "negative_properties",
    }
    if (
        value.st_size <= 0
        or not isinstance(profile, dict)
        or set(profile) != required
        or profile.get("schema") != PROFILE_SCHEMA
        or profile.get("profile_id") != PROFILE_ID
        or profile.get("runtime_abi") != core.VERSION
        or profile.get("package_version") != "2.0.0-10"
        or profile.get("host") != "jvxthcorvm"
        or profile.get("enabled_zero_argument_profiles") != [
            "database-status", "release-preflight", "release-activate", "rollback"
        ]
        or set(profile.get("disabled_profiles", {})) != {"config-activate", "database-migrate"}
        or profile.get("migration", {}).get("name") != MIGRATION_NAME
        or not isinstance(profile.get("negative_properties"), dict)
        or any(profile["negative_properties"].values())
    ):
        raise core.RuntimeFault("ACTIVATION_PROFILE_INVALID", 78)
    for key in (
        "archive_sha256", "dockerfile_sha256", "package_lock_sha256", "prisma_schema_sha256",
        "tg_bot_patch_sha256", "tg_bot_patch_recipe_sha256",
    ):
        if not SHA256.fullmatch(str(profile["accepted_source"].get(key, ""))):
            raise core.RuntimeFault("ACTIVATION_PROFILE_INVALID", 78)
    source = profile["accepted_source"]
    gravity_artifact = source.get("gravity_image_artifact")
    if (
        not isinstance(source.get("tg_bot_patch_size"), int)
        or isinstance(source.get("tg_bot_patch_size"), bool)
        or source["tg_bot_patch_size"] < 1
        or not isinstance(gravity_artifact, dict)
        or set(gravity_artifact) != {
            "zip_sha256", "zip_bytes", "machine_attestation_sha256",
            "ci_execution_proof_sha256", "ci_execution_proof_bytes",
            "docker_archive_sha256", "docker_archive_bytes", "image_id", "containerd_image_id",
            "image_reference", "platform", "materials", "github_artifact",
        }
        or not all(SHA256.fullmatch(str(gravity_artifact.get(key, ""))) for key in (
            "zip_sha256", "machine_attestation_sha256", "ci_execution_proof_sha256",
            "docker_archive_sha256",
        ))
        or not all(
            isinstance(gravity_artifact.get(key), int)
            and not isinstance(gravity_artifact.get(key), bool)
            and gravity_artifact[key] > 0
            for key in ("zip_bytes", "ci_execution_proof_bytes", "docker_archive_bytes")
        )
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(gravity_artifact.get("image_id", "")))
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(gravity_artifact.get("containerd_image_id", "")))
        or gravity_artifact.get("image_reference") != TARGET_TAG
        or gravity_artifact.get("platform") != "linux/amd64"
        or not isinstance(gravity_artifact.get("materials"), dict)
        or not isinstance(gravity_artifact.get("github_artifact"), dict)
    ):
        raise core.RuntimeFault("ACTIVATION_PROFILE_INVALID", 78)
    for key in (
        "source_manifest_sha256", "compose_sha256"
    ):
        if not SHA256.fullmatch(str(profile["production"].get(key, ""))):
            raise core.RuntimeFault("ACTIVATION_PROFILE_INVALID", 78)
    accepted_ledger = profile["migration"].get("accepted_production_ledger")
    accepted_predecessor = profile["migration"].get("accepted_predecessor_map")
    accepted_chronology = profile["migration"].get("accepted_live_chronology")
    chronology_authority = profile["migration"].get("accepted_live_chronology_authority")
    if (
        not SHA256.fullmatch(str(profile["migration"].get("sha256", "")))
        or not isinstance(accepted_ledger, dict)
        or set(accepted_ledger) != {
            "active_migration_count", "legacy_normalized_pre_outbox_sha256",
            "target_state_at_capture", "database_identity_sha256",
        }
        or accepted_ledger.get("active_migration_count") != 62
        or not SHA256.fullmatch(str(accepted_ledger.get("legacy_normalized_pre_outbox_sha256", "")))
        or accepted_ledger.get("target_state_at_capture") != "APPLIED"
        or not SHA256.fullmatch(str(accepted_ledger.get("database_identity_sha256", "")))
        or not isinstance(accepted_predecessor, dict)
        or len(accepted_predecessor) != 61
        or any(
            not re.fullmatch(r"[0-9][A-Za-z0-9_-]{1,199}", str(name))
            or not SHA256.fullmatch(str(checksum))
            for name, checksum in accepted_predecessor.items()
        )
        or profile["migration"]["name"] in accepted_predecessor
        or not isinstance(accepted_chronology, list)
        or len(accepted_chronology) != 62
        or any(
            not isinstance(row, dict)
            or set(row) != {"ordinal", "migration_name", "checksum"}
            or row.get("ordinal") != index
            or not re.fullmatch(r"[0-9][A-Za-z0-9_-]{1,199}", str(row.get("migration_name", "")))
            or not SHA256.fullmatch(str(row.get("checksum", "")))
            for index, row in enumerate(accepted_chronology, 1)
        )
        or len({row["migration_name"] for row in accepted_chronology}) != 62
        or {row["migration_name"]: row["checksum"] for row in accepted_chronology[:-1]} != accepted_predecessor
        or accepted_chronology[-1] != {
            "ordinal": 62,
            "migration_name": profile["migration"]["name"],
            "checksum": profile["migration"]["sha256"],
        }
        or not isinstance(chronology_authority, dict)
        or set(chronology_authority) != {
            "kind", "predecessor_attestation_sha256",
            "predecessor_attestation_inventory_sha256",
            "separate_non_gravity_migration", "current_target_appended",
            "sequence_sha256",
        }
        or chronology_authority.get("kind") != "PINNED_PREDECESSOR_ATTESTATION_ROW_ORDER_PLUS_CURRENT_TARGET"
        or chronology_authority.get("predecessor_attestation_sha256") != "f08319ddfb0feb53a43b45c9e9865707d91c3a827c77cece6b42b8928e1b9a16"
        or chronology_authority.get("predecessor_attestation_inventory_sha256") != "f07ca981e8acb53b48aacee882bce19473e0f33dafd07f716780ec192dd84c01"
        or chronology_authority.get("separate_non_gravity_migration") != "20260223211509_add_is_linear_to_survey"
        or chronology_authority.get("current_target_appended") != profile["migration"]["name"]
        or chronology_authority.get("sequence_sha256") != ACCEPTED_LIVE_CHRONOLOGY_SHA256
        or chronology_authority.get("sequence_sha256") != _digest(accepted_chronology)
    ):
        raise core.RuntimeFault("ACTIVATION_PROFILE_INVALID", 78)
    recovery = profile.get("recovery")
    if (
        not isinstance(recovery, dict)
        or set(recovery) != {
            "predecessor_package_version", "prior_source_commit",
            "prior_source_archive_sha256", "prior_target_tag",
            "prior_target_image_id", "prior_compose_config_hash",
            "recovered_gravity_container_id", "recovered_compose_config_hash",
            "prior_tg_bot_image_id", "prior_tg_bot_compose_config_hash",
            "recovered_tg_bot_container_id", "recovered_tg_bot_compose_config_hash",
            "database_identity_sha256",
            "migration_ledger_sha256", "backup_sha256", "backup_bytes",
            "preview_outbox_catalog_sha256",
        }
        or recovery.get("predecessor_package_version") != "2.0.0-9"
        or recovery.get("prior_source_commit") != "7aea2823efe50e13a156540993d424594025e403"
        or recovery.get("prior_target_tag") != PRIOR_TARGET_TAG
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(recovery.get("prior_target_image_id", "")))
        or recovery.get("recovered_gravity_container_id") != profile["production"].get("gravity_container_id")
        or recovery.get("recovered_compose_config_hash") != profile["production"].get("compose_config_hash")
        or recovery.get("prior_tg_bot_image_id") != TG_BASE_IMAGE
        or recovery.get("recovered_tg_bot_container_id") != profile["production"].get("tg_bot_container_id")
        or recovery.get("recovered_tg_bot_compose_config_hash") != profile["production"].get("tg_bot_compose_config_hash")
        or isinstance(recovery.get("backup_bytes"), bool)
        or not isinstance(recovery.get("backup_bytes"), int)
        or recovery["backup_bytes"] < 1024
        or any(
            not SHA256.fullmatch(str(recovery.get(key, "")))
            for key in (
                "prior_source_archive_sha256", "database_identity_sha256",
                "migration_ledger_sha256", "backup_sha256",
                "preview_outbox_catalog_sha256", "prior_compose_config_hash",
                "recovered_compose_config_hash",
                "prior_tg_bot_compose_config_hash", "recovered_tg_bot_compose_config_hash",
            )
        )
    ):
        raise core.RuntimeFault("ACTIVATION_PROFILE_INVALID", 78)
    production = profile["production"]
    if (
        source.get("tg_bot_patch_source_path") != "tg-bot/src/public-bot-maintenance.js"
        or source.get("archive_prefix") != ""
        or source.get("tg_bot_patch_destination_path") != TG_PATCH_DESTINATION
        or source.get("tg_bot_patch_sha256") != TG_PATCH_TARGET_SHA256
        or source.get("tg_bot_patch_baseline_state") != TG_PATCH_BASELINE_STATE
        or production.get("tg_bot_compose_service") != "tg-bot"
        or production.get("tg_bot_container") != "crm-tg-bot"
        or production.get("tg_bot_image_id") != TG_BASE_IMAGE
        or production.get("tg_bot_entrypoint") != ["/usr/bin/tini", "--", "/usr/local/bin/tg-bot-entrypoint"]
        or production.get("tg_bot_cmd") != ["node", "start.js"]
        or production.get("tg_bot_declared_user") != ""
        or production.get("tg_bot_working_dir") != "/app"
        or production.get("tg_bot_patch_uid") != 0
        or production.get("tg_bot_patch_gid") != 0
        or production.get("tg_bot_patch_mode") != "0644"
        or production.get("tg_bot_patch_baseline_state") != TG_PATCH_BASELINE_STATE
        or production.get("tg_bot_patch_baseline_manifest_file_sha256") != TG_PATCH_BASELINE_MANIFEST_FILE_SHA256
        or production.get("tg_bot_patch_baseline_manifest_sha256") != TG_PATCH_BASELINE_MANIFEST_SHA256
        or not SHA256.fullmatch(str(production.get("tg_bot_container_id", "")))
        or not SHA256.fullmatch(str(production.get("tg_bot_compose_config_hash", "")))
    ):
        raise core.RuntimeFault("ACTIVATION_PROFILE_INVALID", 78)
    return profile


def _ensure_directory(core: Any, path: str, mode: int) -> Path:
    target = core.mapped(path)
    if not target.exists():
        target.mkdir(parents=True, mode=mode)
        os.chmod(target, mode)
    core.secure_directory(path, mode)
    return target


def _ensure_roots(core: Any) -> None:
    core.ensure_state()
    _ensure_directory(core, "/var/lib/yoko-privileged-runtime/activation", 0o700)
    _ensure_directory(core, ACTIVATION_ROOT, 0o700)
    _ensure_directory(core, BACKUP_ROOT, 0o700)


@contextmanager
def _lock(core: Any) -> Iterator[None]:
    global _transaction_lock_fd
    _ensure_roots(core)
    target = core.mapped(LOCK_PATH)
    fd = os.open(target, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise core.RuntimeFault("ACTIVATION_TRANSACTION_BUSY", 75) from exc
        if _transaction_lock_fd is not None:
            raise core.RuntimeFault("ACTIVATION_TRANSACTION_NESTED", 78)
        _transaction_lock_fd = fd
        try:
            yield
        finally:
            _transaction_lock_fd = None
    finally:
        os.close(fd)


def _read_state(core: Any) -> dict[str, Any]:
    target = core.mapped(STATE_PATH)
    if not target.exists():
        return {"schema": STATE_SCHEMA, "profile_id": PROFILE_ID, "phase": "UNINITIALIZED"}
    core.secure_file(STATE_PATH, 0o600, maximum=2 * 1024 * 1024)
    try:
        value = json.loads(target.read_text(encoding="ascii"))
    except (OSError, UnicodeError, ValueError) as exc:
        raise core.RuntimeFault("ACTIVATION_STATE_INVALID", 78) from exc
    if not isinstance(value, dict) or value.get("schema") != STATE_SCHEMA or value.get("profile_id") != PROFILE_ID:
        raise core.RuntimeFault("ACTIVATION_STATE_INVALID", 78)
    return value


def _read_replacement_recovery_state(core: Any, profile: dict[str, Any]) -> tuple[dict[str, Any], str]:
    """Read only the exact predecessor profile state authorized for repair.

    Content-specific profiles deliberately have disjoint state roots.  The
    replacement profile may therefore adopt only the exact failed 08b91459
    transaction, and only while it is still in ROLLBACK_INTENT.  Installation
    and self-check never call this function; adoption occurs lazily inside the
    explicitly invoked rollback transaction.
    """
    target = core.mapped(RECOVERY_SOURCE_STATE_PATH)
    try:
        core.secure_file(RECOVERY_SOURCE_STATE_PATH, 0o600, maximum=2 * 1024 * 1024)
        raw = target.read_bytes()
        value = json.loads(raw.decode("ascii"))
    except (OSError, UnicodeError, ValueError) as exc:
        raise core.RuntimeFault("REPLACEMENT_RECOVERY_STATE_UNAVAILABLE", 78) from exc
    production_identity = value.get("production_identity") if isinstance(value, dict) else None
    gravity_semantic = production_identity.get("gravity_semantic") if isinstance(production_identity, dict) else None
    tg_semantic = production_identity.get("tg_bot_semantic") if isinstance(production_identity, dict) else None
    recovery = profile["recovery"]
    if (
        not isinstance(value, dict)
        or value.get("schema") != STATE_SCHEMA
        or value.get("profile_id") != RECOVERY_SOURCE_PROFILE_ID
        or value.get("phase") != "ROLLBACK_INTENT"
        or any(str(key).startswith("replacement_recovery_") for key in value)
        or value.get("accepted_commit") != RECOVERY_SOURCE_COMMIT
        or value.get("accepted_archive_sha256") != RECOVERY_SOURCE_ARCHIVE_SHA256
        or value.get("target_tag") != RECOVERY_SOURCE_GRAVITY_TAG
        or value.get("tg_target_tag") != RECOVERY_SOURCE_TG_TAG
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(value.get("target_image_id", "")))
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(value.get("tg_target_image_id", "")))
        or value.get("rollback_tag") != ROLLBACK_TAG
        or value.get("rollback_image_id") != profile["production"]["gravity_image_id"]
        or value.get("tg_rollback_tag") != TG_ROLLBACK_TAG
        or value.get("tg_rollback_image_id") != profile["production"]["tg_bot_image_id"]
        or value.get("database_identity_sha256") != recovery["database_identity_sha256"]
        or value.get("migration_ledger_sha256") != recovery["migration_ledger_sha256"]
        or not isinstance(production_identity, dict)
        or not isinstance(gravity_semantic, dict)
        or not isinstance(tg_semantic, dict)
        or gravity_semantic.get("image_id") != profile["production"]["gravity_image_id"]
        or gravity_semantic.get("command") != ["npm", "run", "start"]
        or gravity_semantic.get("compose_labels", {}).get("com.docker.compose.config-hash")
        != recovery["recovered_compose_config_hash"]
        or tg_semantic.get("image_id") != profile["production"]["tg_bot_image_id"]
        or tg_semantic.get("command") != profile["production"]["tg_bot_cmd"]
        or tg_semantic.get("compose_labels", {}).get("com.docker.compose.config-hash")
        != recovery["recovered_tg_bot_compose_config_hash"]
    ):
        raise core.RuntimeFault("REPLACEMENT_RECOVERY_STATE_IDENTITY_MISMATCH", 78)
    return value, hashlib.sha256(raw).hexdigest()


def _write_state(core: Any, value: dict[str, Any]) -> None:
    if value.get("schema") != STATE_SCHEMA or value.get("profile_id") != PROFILE_ID:
        raise core.RuntimeFault("ACTIVATION_STATE_INVALID", 78)
    target = core.mapped(STATE_PATH)
    temporary = core.mapped(STATE_PATH + ".new")
    try:
        temporary.unlink(missing_ok=True)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        try:
            raw = _canonical(value) + b"\n"
            os.write(fd, raw)
            os.fchmod(fd, 0o600)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, target)
        directory_fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def _run(
    core: Any,
    args: list[str],
    *,
    timeout: int,
    stdin_fd: int | None = None,
    stdout_fd: int | None = None,
    stderr_fd: int | None = None,
) -> subprocess.CompletedProcess[bytes]:
    if not args or not args[0].startswith("/") or any("\x00" in item for item in args):
        raise core.RuntimeFault("FIXED_COMMAND_INVALID", 78)
    executable = str(core.mapped(args[0]))
    output: int | Any = stdout_fd if stdout_fd is not None else subprocess.PIPE
    input_value: int | Any = stdin_fd if stdin_fd is not None else subprocess.DEVNULL
    error_output: int | Any = stderr_fd if stderr_fd is not None else subprocess.PIPE
    try:
        pass_fds = () if _transaction_lock_fd is None else (_transaction_lock_fd,)
        completed = subprocess.run(
            [executable, *args[1:]],
            stdin=input_value,
            stdout=output,
            stderr=error_output,
            env=core.command_env(),
            cwd=str(core._test_root or Path("/")),
            timeout=timeout,
            check=False,
            shell=False,
            pass_fds=pass_fds,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        raise core.RuntimeFault("FIXED_COMMAND_FAILED", 74) from exc
    maximum = 4 * 1024 * 1024
    if isinstance(completed.stdout, bytes) and len(completed.stdout) > maximum:
        raise core.RuntimeFault("FIXED_COMMAND_OUTPUT_EXCEEDED", 74)
    if isinstance(completed.stderr, bytes) and len(completed.stderr) > maximum:
        raise core.RuntimeFault("FIXED_COMMAND_OUTPUT_EXCEEDED", 74)
    return completed


def _required_success(core: Any, args: list[str], *, timeout: int, code: str, stdin_fd: int | None = None, stdout_fd: int | None = None, stderr_fd: int | None = None) -> subprocess.CompletedProcess[bytes]:
    completed = _run(core, args, timeout=timeout, stdin_fd=stdin_fd, stdout_fd=stdout_fd, stderr_fd=stderr_fd)
    if completed.returncode != 0:
        raise core.RuntimeFault(code, 74)
    return completed


def _docker_json(core: Any, args: list[str], *, code: str = "DOCKER_IDENTITY_FAILED") -> Any:
    completed = _required_success(core, [DOCKER, *args], timeout=30, code=code)
    try:
        return json.loads(completed.stdout)
    except (UnicodeError, ValueError) as exc:
        raise core.RuntimeFault(code, 74) from exc


def _docker_inspect_absent(core: Any, completed: subprocess.CompletedProcess[bytes], kind: str, identity: str, *, code: str) -> bool:
    if completed.returncode == 0:
        return False
    try:
        encoded_identity = identity.encode("ascii")
    except UnicodeError as exc:
        raise core.RuntimeFault(code, 74) from exc
    messages = {
        "container": {
            b"Error: No such container: " + encoded_identity + b"\n",
            b"Error response from daemon: No such container: " + encoded_identity + b"\n",
        },
        "network": {
            b"Error: No such network: " + encoded_identity + b"\n",
            b"Error response from daemon: network " + encoded_identity + b" not found\n",
        },
        "image": {
            b"Error: No such image: " + encoded_identity + b"\n",
            b"Error: No such object: " + encoded_identity + b"\n",
            b"Error response from daemon: No such image: " + encoded_identity + b"\n",
        },
    }
    if (
        kind not in messages
        or completed.returncode != 1
        or completed.stdout not in {b"", b"[]\n"}
        or completed.stderr not in messages[kind]
    ):
        raise core.RuntimeFault(code, 74)
    return True


def _raw_container(core: Any, name: str) -> dict[str, Any]:
    value = _docker_json(core, ["container", "inspect", name])
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise core.RuntimeFault("CONTAINER_IDENTITY_FAILED", 74)
    raw = value[0]
    if raw.get("Name") != "/" + name:
        raise core.RuntimeFault("CONTAINER_IDENTITY_FAILED", 74)
    return raw


def _container_environment(core: Any, name: str) -> dict[str, str]:
    raw = _raw_container(core, name)
    configured = (raw.get("Config") or {}).get("Env")
    if not isinstance(configured, list) or len(configured) > 512:
        raise core.RuntimeFault("CONTAINER_ENVIRONMENT_INVALID", 74)
    result: dict[str, str] = {}
    for item in configured:
        if not isinstance(item, str) or "=" not in item or "\x00" in item:
            raise core.RuntimeFault("CONTAINER_ENVIRONMENT_INVALID", 74)
        key, value = item.split("=", 1)
        if not re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", key) or key in result:
            raise core.RuntimeFault("CONTAINER_ENVIRONMENT_INVALID", 74)
        result[key] = value
    return result


def _postgres_identity(core: Any, profile: dict[str, Any], container: str | None = None) -> dict[str, Any]:
    production = profile["production"]
    name = container or production["postgres_container"]
    raw = _raw_container(core, name)
    state = raw.get("State") or {}
    if not state.get("Running") or (container is None and (state.get("Health") or {}).get("Status") != "healthy"):
        raise core.RuntimeFault("POSTGRES_NOT_HEALTHY", 74)
    if container is None and (
        raw.get("Id") != production["postgres_container_id"]
        or raw.get("Image") != production["postgres_image_id"]
    ):
        raise core.RuntimeFault("POSTGRES_IDENTITY_DRIFT", 74)
    environment = _container_environment(core, name)
    user = environment.get("POSTGRES_USER", "")
    database = environment.get("POSTGRES_DB", "")
    if not DB_IDENTIFIER.fullmatch(user) or not DB_IDENTIFIER.fullmatch(database):
        raise core.RuntimeFault("POSTGRES_DATABASE_IDENTITY_INVALID", 74)
    sql = "SELECT current_setting('server_version_num'), system_identifier::text, current_database() FROM pg_control_system();"
    completed = _required_success(
        core,
        [DOCKER, "exec", name, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-At", "-F", "|", "-U", user, "-d", database, "-c", sql],
        timeout=30,
        code="POSTGRES_IDENTITY_QUERY_FAILED",
    )
    try:
        line = completed.stdout.decode("utf-8").strip()
        version, system_identifier, observed_database = line.split("|", 2)
    except (UnicodeError, ValueError) as exc:
        raise core.RuntimeFault("POSTGRES_IDENTITY_QUERY_INVALID", 74) from exc
    if not version.isdigit() or not system_identifier.isdigit() or observed_database != database:
        raise core.RuntimeFault("POSTGRES_IDENTITY_QUERY_INVALID", 74)
    identity = hashlib.sha256(f"{raw.get('Id')}|{raw.get('Image')}|{version}|{system_identifier}|{user}|{database}".encode("utf-8")).hexdigest()
    return {
        "container": name,
        "container_id": raw.get("Id"),
        "image_id": raw.get("Image"),
        "server_version_num": version,
        "system_identifier_sha256": hashlib.sha256(system_identifier.encode("ascii")).hexdigest(),
        "database_name_sha256": hashlib.sha256(database.encode("utf-8")).hexdigest(),
        "database_user_sha256": hashlib.sha256(user.encode("utf-8")).hexdigest(),
        "database_identity_sha256": identity,
        "user": user,
        "database": database,
    }


def _psql(core: Any, identity: dict[str, Any], sql: str, *, code: str) -> bytes:
    return _required_success(
        core,
        [DOCKER, "exec", identity["container"], "psql", "-X", "-v", "ON_ERROR_STOP=1", "-At", "-F", "\t", "-U", identity["user"], "-d", identity["database"], "-c", sql],
        timeout=60,
        code=code,
    ).stdout


def _accepted_migration_inventory(core: Any, profile: dict[str, Any]) -> dict[str, str]:
    archive = core.mapped(ARCHIVE_PATH)
    prefix = profile["accepted_source"]["archive_prefix"] + "gravity-mvp/prisma/migrations/"
    inventory: dict[str, str] = {}
    try:
        with tarfile.open(archive, "r:gz") as handle:
            if handle.pax_headers.get("comment") != profile["accepted_source"]["commit"]:
                raise core.RuntimeFault("SOURCE_ARCHIVE_COMMIT_MISMATCH", 78)
            for member in handle:
                if not member.isfile() or not member.name.startswith(prefix) or not member.name.endswith("/migration.sql"):
                    continue
                relative = member.name[len(prefix):]
                parts = relative.split("/")
                if len(parts) != 2 or parts[1] != "migration.sql" or not re.fullmatch(r"[0-9][A-Za-z0-9_-]{1,199}", parts[0]):
                    raise core.RuntimeFault("SOURCE_MIGRATION_INVENTORY_INVALID", 78)
                source = handle.extractfile(member)
                if source is None:
                    raise core.RuntimeFault("SOURCE_MIGRATION_INVENTORY_INVALID", 78)
                raw = source.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024 or parts[0] in inventory:
                    raise core.RuntimeFault("SOURCE_MIGRATION_INVENTORY_INVALID", 78)
                inventory[parts[0]] = hashlib.sha256(raw).hexdigest()
    except (OSError, tarfile.TarError) as exc:
        raise core.RuntimeFault("SOURCE_ARCHIVE_INVALID", 78) from exc
    if len(inventory) < 1 or inventory.get(profile["migration"]["name"]) != profile["migration"]["sha256"]:
        raise core.RuntimeFault("SOURCE_MIGRATION_INVENTORY_INVALID", 78)
    return inventory


def _expected_production_ledger(core: Any, profile: dict[str, Any], *, migrated: bool) -> dict[str, str]:
    inventory = _accepted_migration_inventory(core, profile)
    target = profile["migration"]["name"]
    target_checksum = inventory.pop(target, None)
    inventory.update(profile["migration"]["accepted_checksum_overrides"])
    accepted = profile["migration"]["accepted_predecessor_map"]
    if any(accepted.get(name) != checksum for name, checksum in inventory.items()):
        raise core.RuntimeFault("SOURCE_CANONICAL_MIGRATION_MAP_DRIFT", 78)
    output = dict(accepted)
    if migrated:
        output[target] = target_checksum
    return output


def _migration_ledger_observation(core: Any, identity: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    sql = """
SELECT COALESCE(json_agg(json_build_object(
  'id', id,
  'checksum', checksum,
  'finished_at', CASE WHEN finished_at IS NULL THEN NULL ELSE to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') END,
  'migration_name', migration_name,
  'logs_present', logs IS NOT NULL,
  'logs_bytes', CASE WHEN logs IS NULL THEN NULL ELSE octet_length(logs) END,
  'logs_sha256', CASE WHEN logs IS NULL THEN NULL ELSE encode(sha256(convert_to(logs, 'UTF8')), 'hex') END,
  'rolled_back_at', CASE WHEN rolled_back_at IS NULL THEN NULL ELSE to_char(rolled_back_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') END,
  'started_at', to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'),
  'applied_steps_count', applied_steps_count
) ORDER BY started_at, migration_name, id), '[]'::json)::text
FROM public."_prisma_migrations";
"""
    raw = _psql(core, identity, sql, code="MIGRATION_LEDGER_QUERY_FAILED")
    output: dict[str, str] = {}
    rows: list[dict[str, Any]] = []
    interrupted_target = 0
    rolled_back_target = 0
    target = profile["migration"]["name"]
    target_checksum = profile["migration"]["sha256"]
    timestamp = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z")
    try:
        decoded = json.loads(raw.decode("utf-8"))
        if not isinstance(decoded, list):
            raise ValueError("ledger is not a list")
        for ordinal, row in enumerate(decoded, 1):
            if not isinstance(row, dict) or set(row) != {
                "id", "checksum", "finished_at", "migration_name",
                "logs_present", "logs_bytes", "logs_sha256",
                "rolled_back_at", "started_at", "applied_steps_count",
            }:
                raise ValueError("invalid ledger row shape")
            row_id = row["id"]
            name = row["migration_name"]
            checksum = row["checksum"]
            finished_at = row["finished_at"]
            rolled_back_at = row["rolled_back_at"]
            started_at = row["started_at"]
            logs_present = row["logs_present"]
            logs_bytes = row["logs_bytes"]
            logs_sha256 = row["logs_sha256"]
            applied_steps = row["applied_steps_count"]
            if (
                not isinstance(row_id, str)
                or not re.fullmatch(r"[A-Za-z0-9-]{1,200}", row_id)
                or not isinstance(name, str)
                or not re.fullmatch(r"[0-9][A-Za-z0-9_-]{1,199}", name)
                or not isinstance(checksum, str)
                or not SHA256.fullmatch(checksum)
                or not isinstance(started_at, str)
                or not timestamp.fullmatch(started_at)
                or (finished_at is not None and (not isinstance(finished_at, str) or not timestamp.fullmatch(finished_at)))
                or (rolled_back_at is not None and (not isinstance(rolled_back_at, str) or not timestamp.fullmatch(rolled_back_at)))
                or not isinstance(logs_present, bool)
                or (logs_present and (
                    isinstance(logs_bytes, bool)
                    or not isinstance(logs_bytes, int)
                    or logs_bytes < 0
                    or not isinstance(logs_sha256, str)
                    or not SHA256.fullmatch(logs_sha256)
                ))
                or (not logs_present and (logs_bytes is not None or logs_sha256 is not None))
                or isinstance(applied_steps, bool)
                or not isinstance(applied_steps, int)
                or applied_steps < 0
            ):
                raise ValueError("invalid ledger")
            if finished_at is not None and rolled_back_at is None:
                if name in output:
                    raise ValueError("duplicate active migration")
                output[name] = checksum
                status = "FINISHED_ACTIVE"
            elif finished_at is None and name == target and checksum == target_checksum:
                if rolled_back_at is None:
                    interrupted_target += 1
                    status = "INTERRUPTED_TARGET"
                else:
                    rolled_back_target += 1
                    status = "ROLLED_BACK_TARGET"
            else:
                raise ValueError("unexpected inactive migration")
            rows.append({
                "observed_chronological_ordinal": ordinal,
                "migration_id": row_id,
                "migration_name": name,
                "checksum": checksum,
                "status": status,
                "started_at": started_at,
                "finished_at": finished_at,
                "rolled_back_at": rolled_back_at,
                "applied_steps_count": applied_steps,
                "logs_present": logs_present,
                "logs_bytes": logs_bytes,
                "logs_sha256": logs_sha256,
            })
        if interrupted_target > 1:
            raise ValueError("multiple unfinished target migrations")
    except (UnicodeError, ValueError) as exc:
        raise core.RuntimeFault("MIGRATION_LEDGER_INVALID", 74) from exc
    return {
        "active": output,
        "rows": rows,
        "interrupted_target": interrupted_target,
        "rolled_back_target": rolled_back_target,
    }


def _migration_ledger(core: Any, identity: dict[str, Any], profile: dict[str, Any]) -> dict[str, str]:
    observation = _migration_ledger_observation(core, identity, profile)
    if observation["interrupted_target"]:
        raise core.RuntimeFault("MIGRATION_LEDGER_INTERRUPTED", 74)
    return observation["active"]


def _accepted_production_ledger_shape(observation: dict[str, Any], profile: dict[str, Any]) -> dict[str, bool]:
    """Compare both the finite active map and its source-bound semantic order."""
    target = profile["migration"]["name"]
    target_sha = profile["migration"]["sha256"]
    active = dict(observation["active"])
    target_value = active.pop(target, None)
    expected = profile["migration"]["accepted_live_chronology"]
    expected_baseline = [
        {"ordinal": index, "migration_name": row["migration_name"], "checksum": row["checksum"]}
        for index, row in enumerate(expected[:-1], 1)
    ]
    observed_active = [
        {"ordinal": index, "migration_name": row["migration_name"], "checksum": row["checksum"]}
        for index, row in enumerate(
            (row for row in observation.get("rows", []) if row.get("status") == "FINISHED_ACTIVE"),
            1,
        )
    ]
    observed_baseline = [row for row in observed_active if row["migration_name"] != target]
    baseline_exact = (
        active == profile["migration"]["accepted_predecessor_map"]
        and observed_baseline == expected_baseline
    )
    if target_value is None:
        chronology_exact = observed_active == expected_baseline
    elif target_value == target_sha:
        chronology_exact = observed_active == expected
    else:
        chronology_exact = False
    return {
        "baseline_exact": baseline_exact,
        "target_absent": target_value is None,
        "target_active": target_value == target_sha,
        "chronology_exact": chronology_exact,
    }


def _outbox_catalog(core: Any, identity: dict[str, Any]) -> dict[str, Any]:
    sql = """
SELECT json_build_object(
  'enum_labels', COALESCE((
    SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder)
    FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
    WHERE t.typname='DomainOutboxStatus'
  ), '[]'::json),
  'columns', COALESCE((
    SELECT json_agg(json_build_object(
      'name', a.attname,
      'type', format_type(a.atttypid, a.atttypmod),
      'not_null', a.attnotnull,
      'default', COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
    ) ORDER BY a.attnum)
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=to_regclass('public.domain_outbox_events')
      AND a.attnum > 0 AND NOT a.attisdropped
  ), '[]'::json),
  'constraints', COALESCE((
    SELECT json_agg(json_build_object('name', conname, 'definition', pg_get_constraintdef(oid, true)) ORDER BY conname)
    FROM pg_constraint WHERE conrelid=to_regclass('public.domain_outbox_events')
  ), '[]'::json),
  'indexes', COALESCE((
    SELECT json_agg(json_build_object('name', indexname, 'definition', indexdef) ORDER BY indexname)
    FROM pg_indexes WHERE schemaname='public' AND tablename='domain_outbox_events'
  ), '[]'::json)
)::text;
"""
    raw = _psql(core, identity, sql, code="OUTBOX_CATALOG_QUERY_FAILED")
    try:
        value = json.loads(raw.decode("utf-8").strip())
    except (UnicodeError, ValueError) as exc:
        raise core.RuntimeFault("OUTBOX_CATALOG_INVALID", 74) from exc
    if not isinstance(value, dict) or set(value) != {"enum_labels", "columns", "constraints", "indexes"}:
        raise core.RuntimeFault("OUTBOX_CATALOG_INVALID", 74)
    expected = {
        "enum_labels": ["pending", "processing", "retry_wait", "published", "dead_letter"],
        "columns": [
            {"name": "id", "type": "text", "not_null": True, "default": ""},
            {"name": "eventId", "type": "text", "not_null": True, "default": ""},
            {"name": "eventType", "type": "text", "not_null": True, "default": ""},
            {"name": "eventVersion", "type": "integer", "not_null": True, "default": ""},
            {"name": "aggregateType", "type": "text", "not_null": True, "default": ""},
            {"name": "aggregateId", "type": "text", "not_null": True, "default": ""},
            {"name": "payload", "type": "jsonb", "not_null": True, "default": ""},
            {"name": "status", "type": "\"DomainOutboxStatus\"", "not_null": True, "default": "'pending'::\"DomainOutboxStatus\""},
            {"name": "attempts", "type": "integer", "not_null": True, "default": "0"},
            {"name": "maxAttempts", "type": "integer", "not_null": True, "default": "5"},
            {"name": "availableAt", "type": "timestamp(3) without time zone", "not_null": True, "default": "CURRENT_TIMESTAMP"},
            {"name": "claimedAt", "type": "timestamp(3) without time zone", "not_null": False, "default": ""},
            {"name": "publishedAt", "type": "timestamp(3) without time zone", "not_null": False, "default": ""},
            {"name": "lastError", "type": "character varying(1000)", "not_null": False, "default": ""},
            {"name": "correlationId", "type": "text", "not_null": False, "default": ""},
            {"name": "causationId", "type": "text", "not_null": False, "default": ""},
            {"name": "createdAt", "type": "timestamp(3) without time zone", "not_null": True, "default": "CURRENT_TIMESTAMP"},
            {"name": "updatedAt", "type": "timestamp(3) without time zone", "not_null": True, "default": ""},
        ],
        "constraints": [
            {"name": "domain_outbox_events_pkey", "definition": "PRIMARY KEY (id)"},
        ],
        "indexes": [
            {"name": "domain_outbox_events_aggregateType_aggregateId_createdAt_idx", "definition": "CREATE INDEX \"domain_outbox_events_aggregateType_aggregateId_createdAt_idx\" ON public.domain_outbox_events USING btree (\"aggregateType\", \"aggregateId\", \"createdAt\")"},
            {"name": "domain_outbox_events_eventId_key", "definition": "CREATE UNIQUE INDEX \"domain_outbox_events_eventId_key\" ON public.domain_outbox_events USING btree (\"eventId\")"},
            {"name": "domain_outbox_events_pkey", "definition": "CREATE UNIQUE INDEX domain_outbox_events_pkey ON public.domain_outbox_events USING btree (id)"},
            {"name": "domain_outbox_events_status_availableAt_createdAt_idx", "definition": "CREATE INDEX \"domain_outbox_events_status_availableAt_createdAt_idx\" ON public.domain_outbox_events USING btree (status, \"availableAt\", \"createdAt\")"},
        ],
    }
    actual = {
        "enum_labels": value["enum_labels"],
        "columns": value["columns"],
        "constraints": sorted(value["constraints"], key=lambda item: str(item.get("name"))),
        "indexes": sorted(value["indexes"], key=lambda item: str(item.get("name"))),
    }
    absent = actual == {"enum_labels": [], "columns": [], "constraints": [], "indexes": []}
    exact = actual == expected
    return {"state": "ABSENT" if absent else "EXACT" if exact else "PARTIAL_OR_DRIFTED", **actual}


def _outbox_counts(core: Any, identity: dict[str, Any]) -> dict[str, int]:
    sql = """
SELECT json_build_object(
  'total', count(*),
  'pending', count(*) FILTER (WHERE status='pending'),
  'processing', count(*) FILTER (WHERE status='processing'),
  'retry_wait', count(*) FILTER (WHERE status='retry_wait'),
  'published', count(*) FILTER (WHERE status='published'),
  'dead_letter', count(*) FILTER (WHERE status='dead_letter'),
  'stale_claimed', count(*) FILTER (WHERE status='processing' AND "claimedAt" < NOW() - INTERVAL '10 minutes'),
  'over_attempt_limit', count(*) FILTER (WHERE attempts > "maxAttempts")
)::text FROM domain_outbox_events;
"""
    raw = _psql(core, identity, sql, code="OUTBOX_STATUS_QUERY_FAILED")
    try:
        value = json.loads(raw.decode("utf-8").strip())
    except (UnicodeError, ValueError) as exc:
        raise core.RuntimeFault("OUTBOX_STATUS_INVALID", 74) from exc
    expected = {"total", "pending", "processing", "retry_wait", "published", "dead_letter", "stale_claimed", "over_attempt_limit"}
    if not isinstance(value, dict) or set(value) != expected or not all(isinstance(item, int) and item >= 0 for item in value.values()):
        raise core.RuntimeFault("OUTBOX_STATUS_INVALID", 74)
    return value


def _database_status(core: Any, profile: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    identity = _postgres_identity(core, profile)
    observation = _migration_ledger_observation(core, identity, profile)
    ledger = observation["active"]
    shape = _accepted_production_ledger_shape(observation, profile)
    catalog = _outbox_catalog(core, identity)
    accepted_identity = profile["migration"]["accepted_production_ledger"]["database_identity_sha256"]
    identity_exact = identity["database_identity_sha256"] == accepted_identity
    if identity_exact and shape["baseline_exact"] and shape["target_active"] and shape["chronology_exact"] and not observation["interrupted_target"] and not observation["rolled_back_target"] and catalog["state"] == "EXACT":
        ledger_state = "APPROVED_OUTBOX_APPLIED"
    else:
        ledger_state = "DRIFTED"
    evidence = {
        "profile_id": PROFILE_ID,
        "read_only": True,
        "database_identity_sha256": identity["database_identity_sha256"],
        "database_name_sha256": identity["database_name_sha256"],
        "database_user_sha256": identity["database_user_sha256"],
        "system_identifier_sha256": identity["system_identifier_sha256"],
        "server_version_num": identity["server_version_num"],
        "postgres_container_id": identity["container_id"],
        "postgres_image_id": identity["image_id"],
        "migration_state": ledger_state,
        "applied_migration_count": len(ledger),
        "migration_ledger_sha256": _digest({
            "active": observation["active"],
            "interrupted_target": observation["interrupted_target"],
            "rolled_back_target": observation["rolled_back_target"],
        }),
        "canonical_live_rows": observation["rows"],
        "canonical_live_rows_sha256": _digest(observation["rows"]),
        "canonical_active_inventory_sha256": _digest({"active": dict(sorted(ledger.items()))}),
        "expected_canonical_active_inventory_sha256": _digest({"active": dict(sorted(_expected_production_ledger(core, profile, migrated=True).items()))}),
        "canonical_predecessor_entry_count": len(profile["migration"]["accepted_predecessor_map"]),
        "canonical_target_name": profile["migration"]["name"],
        "canonical_target_checksum": profile["migration"]["sha256"],
        "canonical_active_map_exact": (
            dict(ledger) == _expected_production_ledger(core, profile, migrated=True)
            and not observation["interrupted_target"]
            and not observation["rolled_back_target"]
        ),
        "canonical_live_chronology_exact": shape["chronology_exact"],
        "expected_live_chronology_sha256": profile["migration"]["accepted_live_chronology_authority"]["sequence_sha256"],
        "interrupted_target_migrations": observation["interrupted_target"],
        "rolled_back_target_migrations": observation["rolled_back_target"],
        "outbox_catalog_state": catalog["state"],
        "outbox_counts": _outbox_counts(core, identity) if catalog["state"] == "EXACT" else None,
        "secret_values_emitted": False,
    }
    return evidence, identity


def _database_status_profile(core: Any, profile: dict[str, Any]) -> dict[str, Any]:
    with _lock(core):
        state = _read_state(core)
        _reconcile_terminal_audit(core, state)
        if state.get("phase") == "DATABASE_RUNNER_RETIRE_INTENT":
            raise core.RuntimeFault("PRODUCTION_RUNNER_TERMINAL_CLEANUP_REQUIRED", 77)
        identities = state.get("production_runner_identities")
        if identities is not None:
            if not isinstance(identities, dict):
                raise core.RuntimeFault("PRODUCTION_RUNNER_STATE_INVALID", 74)
            if state.get("phase") in {"MIGRATED", "ACTIVATED", "ROLLED_BACK"}:
                raise core.RuntimeFault("PRODUCTION_RUNNER_TERMINAL_CLEANUP_REQUIRED", 77)
            else:
                _quiesce_production_runners(core, identities)
        evidence, _ = _database_status(core, profile)
        return evidence


def _secure_host_file(core: Any, path: str, mode: int, maximum: int) -> Path:
    target = core.mapped(path)
    value = target.lstat()
    if (
        target.is_symlink()
        or not stat.S_ISREG(value.st_mode)
        or value.st_uid != core.expected_owner()[0]
        or value.st_gid != core.expected_owner()[1]
        or stat.S_IMODE(value.st_mode) != mode
        or value.st_nlink != 1
        or value.st_size < 1
        or value.st_size > maximum
    ):
        raise core.RuntimeFault("PRODUCTION_FILE_UNSAFE", 74)
    core.assert_noncaller_writable_chain(target.parent)
    if core.caller_can_write(target):
        raise core.RuntimeFault("PRODUCTION_FILE_CALLER_WRITABLE", 74)
    return target


def _archive_member_allowed(source: dict[str, Any], name: str) -> bool:
    return (
        source.get("archive_prefix") == ""
        and (
            name == "gravity-mvp"
            or name.startswith("gravity-mvp/")
            or name in {"tg-bot", "tg-bot/src", source.get("tg_bot_patch_source_path")}
        )
    )


def _archive_inventory(core: Any, profile: dict[str, Any]) -> dict[str, int]:
    source = profile["accepted_source"]
    archive = core.mapped(ARCHIVE_PATH)
    if _sha_file(archive) != source["archive_sha256"]:
        raise core.RuntimeFault("SOURCE_ARCHIVE_IDENTITY_MISMATCH", 78)
    seen: set[str] = set()
    files = 0
    directories = 0
    total = 0
    try:
        with tarfile.open(archive, "r:gz") as handle:
            if handle.pax_headers.get("comment") != source["commit"]:
                raise core.RuntimeFault("SOURCE_ARCHIVE_COMMIT_MISMATCH", 78)
            members = handle.getmembers()
            for member in members:
                name = member.name
                pure = PurePosixPath(name)
                if (
                    name in seen
                    or name.startswith("/")
                    or "\x00" in name
                    or any(part in {"", ".", ".."} for part in pure.parts)
                    or not _archive_member_allowed(source, name)
                ):
                    raise core.RuntimeFault("SOURCE_ARCHIVE_PATH_INVALID", 78)
                seen.add(name)
                if member.isfile():
                    files += 1
                    total += member.size
                    if member.size < 0 or total > source["archive_uncompressed_bytes"]:
                        raise core.RuntimeFault("SOURCE_ARCHIVE_BUDGET_EXCEEDED", 78)
                elif member.isdir():
                    directories += 1
                else:
                    raise core.RuntimeFault("SOURCE_ARCHIVE_SPECIAL_ENTRY", 78)
            if (
                len(members) != source["archive_entries"]
                or files != source["archive_regular_files"]
                or directories != source["archive_directories"]
                or total > source["archive_uncompressed_bytes"]
            ):
                raise core.RuntimeFault("SOURCE_ARCHIVE_INVENTORY_MISMATCH", 78)
    except (OSError, tarfile.TarError) as exc:
        raise core.RuntimeFault("SOURCE_ARCHIVE_INVALID", 78) from exc
    return {"entries": len(seen), "regular_files": files, "directories": directories, "uncompressed_bytes": total}


def _source_context(core: Any, profile: dict[str, Any]) -> Path:
    prefix = profile["accepted_source"]["archive_prefix"].rstrip("/")
    root = core.mapped(SOURCE_ROOT)
    return (root / prefix if prefix else root) / profile["accepted_source"]["build_context"]


def _tg_patch_source(core: Any, profile: dict[str, Any]) -> Path:
    prefix = profile["accepted_source"]["archive_prefix"].rstrip("/")
    root = core.mapped(SOURCE_ROOT)
    return (root / prefix if prefix else root) / profile["accepted_source"]["tg_bot_patch_source_path"]


def _validate_extracted_source(core: Any, profile: dict[str, Any]) -> Path:
    context = _source_context(core, profile)
    checks = {
        "Dockerfile": profile["accepted_source"]["dockerfile_sha256"],
        "package-lock.json": profile["accepted_source"]["package_lock_sha256"],
        "prisma/schema.prisma": profile["accepted_source"]["prisma_schema_sha256"],
        f"prisma/migrations/{profile['migration']['name']}/migration.sql": profile["migration"]["sha256"],
    }
    source_root = core.mapped(SOURCE_ROOT)
    root_value = source_root.lstat()
    if source_root.is_symlink() or not stat.S_ISDIR(root_value.st_mode) or stat.S_IMODE(root_value.st_mode) != 0o555:
        raise core.RuntimeFault("EXTRACTED_SOURCE_UNSAFE", 78)
    for relative, digest in checks.items():
        target = context / relative
        value = target.lstat()
        if target.is_symlink() or not stat.S_ISREG(value.st_mode) or stat.S_IMODE(value.st_mode) not in {0o444, 0o555} or value.st_nlink != 1:
            raise core.RuntimeFault("EXTRACTED_SOURCE_UNSAFE", 78)
        if _sha_file(target, 16 * 1024 * 1024) != digest:
            raise core.RuntimeFault("EXTRACTED_SOURCE_IDENTITY_MISMATCH", 78)
    tg_patch = _tg_patch_source(core, profile)
    tg_value = tg_patch.lstat()
    if (
        tg_patch.is_symlink()
        or not stat.S_ISREG(tg_value.st_mode)
        or stat.S_IMODE(tg_value.st_mode) not in {0o444, 0o555}
        or tg_value.st_nlink != 1
        or _sha_file(tg_patch, 1024 * 1024) != profile["accepted_source"]["tg_bot_patch_sha256"]
    ):
        raise core.RuntimeFault("TG_PATCH_SOURCE_IDENTITY_MISMATCH", 78)
    return context


def _extract_source(core: Any, profile: dict[str, Any]) -> Path:
    source_root = core.mapped(SOURCE_ROOT)
    if source_root.exists():
        return _validate_extracted_source(core, profile)
    _ensure_directory(core, RELEASE_ROOT, 0o700)
    temporary = core.mapped(SOURCE_ROOT + ".new")
    if temporary.exists():
        value = temporary.lstat()
        if temporary.is_symlink() or not stat.S_ISDIR(value.st_mode) or value.st_uid != core.expected_owner()[0]:
            raise core.RuntimeFault("EXTRACTED_SOURCE_TEMP_UNSAFE", 78)
        shutil.rmtree(temporary)
    temporary.mkdir(mode=0o700)
    try:
        archive = core.mapped(ARCHIVE_PATH)
        with tarfile.open(archive, "r:gz") as handle:
            members = handle.getmembers()
            for member in members:
                target = temporary.joinpath(*PurePosixPath(member.name).parts)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=False)
                    os.chmod(target, 0o700)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    source = handle.extractfile(member)
                    if source is None:
                        raise core.RuntimeFault("SOURCE_ARCHIVE_INVALID", 78)
                    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o400)
                    try:
                        remaining = member.size
                        while remaining:
                            chunk = source.read(min(1024 * 1024, remaining))
                            if not chunk:
                                raise core.RuntimeFault("SOURCE_ARCHIVE_TRUNCATED", 78)
                            os.write(fd, chunk)
                            remaining -= len(chunk)
                        if source.read(1):
                            raise core.RuntimeFault("SOURCE_ARCHIVE_SIZE_MISMATCH", 78)
                        os.fchmod(fd, 0o555 if member.mode & 0o111 else 0o444)
                    finally:
                        os.close(fd)
        for current, directories, files in os.walk(temporary, topdown=False, followlinks=False):
            for name in files:
                target = Path(current) / name
                value = target.lstat()
                if target.is_symlink() or not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
                    raise core.RuntimeFault("EXTRACTED_SOURCE_UNSAFE", 78)
            for name in directories:
                os.chmod(Path(current) / name, 0o555)
        os.chmod(temporary, 0o555)
        os.replace(temporary, source_root)
    except Exception:
        if temporary.exists() and not temporary.is_symlink():
            shutil.rmtree(temporary)
        raise
    return _validate_extracted_source(core, profile)


def _image_inspect(core: Any, reference: str, *, required: bool = True) -> dict[str, Any] | None:
    completed = _run(core, [DOCKER, "image", "inspect", reference], timeout=30)
    if completed.returncode != 0:
        absent = _docker_inspect_absent(core, completed, "image", reference, code="IMAGE_IDENTITY_UNAVAILABLE")
        if absent and not required:
            return None
        raise core.RuntimeFault("IMAGE_IDENTITY_UNAVAILABLE", 74)
    try:
        value = json.loads(completed.stdout)
    except (UnicodeError, ValueError) as exc:
        raise core.RuntimeFault("IMAGE_IDENTITY_INVALID", 74) from exc
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise core.RuntimeFault("IMAGE_IDENTITY_INVALID", 74)
    image_id = value[0].get("Id")
    if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise core.RuntimeFault("IMAGE_IDENTITY_INVALID", 74)
    return value[0]


def _tg_patch_probe_script() -> str:
    return (
        "const f=require('fs'),c=require('crypto'),p='/app/src/public-bot-maintenance.js';"
        "let s;try{s=f.lstatSync(p)}catch(e){if(e&&e.code==='ENOENT'){process.stdout.write(JSON.stringify({state:'ABSENT'}));process.exit(0)}process.exit(3)};"
        "if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)process.exit(2);"
        "process.stdout.write(JSON.stringify({state:'PRESENT',sha256:c.createHash('sha256').update(f.readFileSync(p)).digest('hex'),"
        "uid:s.uid,gid:s.gid,mode:(s.mode&4095).toString(8).padStart(4,'0'),size:s.size}));"
    )


def _tg_patch_file_probe(core: Any, container: str) -> dict[str, Any]:
    completed = _run(core, [DOCKER, "exec", container, "node", "-e", _tg_patch_probe_script()], timeout=20)
    if completed.returncode != 0:
        raise core.RuntimeFault("TG_PATCH_FILE_PROBE_FAILED", 74)
    try:
        value = json.loads(completed.stdout)
    except (UnicodeError, ValueError) as exc:
        raise core.RuntimeFault("TG_PATCH_FILE_PROBE_INVALID", 74) from exc
    if value == {"state": TG_PATCH_BASELINE_STATE}:
        return value
    if (
        not isinstance(value, dict)
        or set(value) != {"state", "sha256", "uid", "gid", "mode", "size"}
        or value.get("state") != "PRESENT"
        or not SHA256.fullmatch(str(value.get("sha256", "")))
        or isinstance(value.get("uid"), bool)
        or not isinstance(value.get("uid"), int)
        or isinstance(value.get("gid"), bool)
        or not isinstance(value.get("gid"), int)
        or not re.fullmatch(r"0[0-7]{3}", str(value.get("mode", "")))
        or isinstance(value.get("size"), bool)
        or not isinstance(value.get("size"), int)
        or value["size"] < 1
    ):
        raise core.RuntimeFault("TG_PATCH_FILE_PROBE_INVALID", 74)
    return value


def _expected_tg_patch_metadata(profile: dict[str, Any], sha256: str) -> dict[str, Any]:
    production = profile["production"]
    return {
        "state": "PRESENT",
        "sha256": sha256,
        "uid": production["tg_bot_patch_uid"],
        "gid": production["tg_bot_patch_gid"],
        "mode": production["tg_bot_patch_mode"],
        "size": profile["accepted_source"]["tg_bot_patch_size"],
    }


def _validate_tg_patch_absent(core: Any, value: Any, code: str) -> dict[str, Any]:
    if value != {"state": TG_PATCH_BASELINE_STATE}:
        raise core.RuntimeFault(code, 74)
    return value


def _validate_tg_patch_probe(core: Any, profile: dict[str, Any], value: Any, expected_sha256: str, code: str) -> dict[str, Any]:
    if value != _expected_tg_patch_metadata(profile, expected_sha256):
        raise core.RuntimeFault(code, 74)
    return value


def _pinned_provenance(core: Any, policy: dict[str, Any]) -> dict[str, Any]:
    provenance = core.docker_provenance(policy)
    if (
        not isinstance(provenance, dict)
        or provenance.get("complete") is not True
        or provenance.get("failures") != EXPECTED_PROVENANCE_FAILURES
        or not isinstance(provenance.get("records"), list)
        or not isinstance(provenance.get("semantic"), dict)
        or provenance["semantic"].get("schema") != "yoko.ai-calls.production-semantic-identity.v1"
        or not isinstance(provenance["semantic"].get("records"), list)
        or not isinstance(provenance["semantic"].get("fingerprint_sha256"), str)
        or not SHA256.fullmatch(provenance["semantic"]["fingerprint_sha256"])
    ):
        raise core.RuntimeFault("PRODUCTION_PROVENANCE_FAILURE_SET_DRIFT", 74)
    records = provenance["records"]
    semantic_records = provenance["semantic"]["records"]
    if (
        any(
            not isinstance(record, dict)
            or not isinstance(record.get("name"), str)
            or not isinstance(record.get("semantic"), dict)
            or record["semantic"].get("name") != record["name"]
            or record["semantic"].get("image_id") != record.get("image_id")
            for record in records
        )
        or len({record["name"] for record in records}) != len(records)
        or semantic_records != sorted((record["semantic"] for record in records), key=lambda item: item["name"])
        or provenance["semantic"]["fingerprint_sha256"] != core.semantic_fingerprint(semantic_records)
    ):
        raise core.RuntimeFault("PRODUCTION_PROVENANCE_RECORD_SET_DRIFT", 74)
    return provenance


def _unrelated_runtime_identity(core: Any, policy: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    provenance = _pinned_provenance(core, policy)
    target_names = {profile["production"]["gravity_container"], profile["production"]["tg_bot_container"]}
    unrelated = [item for item in provenance["semantic"]["records"] if item["name"] not in target_names]
    unrelated_runtime = sorted(
        (item["name"], item["container_id"], item["image_id"], item["status"], item["started_at"], item["restart_count"])
        for item in provenance["records"] if item["name"] not in target_names
    )
    return {
        "unrelated_semantic_sha256": core.semantic_fingerprint(unrelated),
        "unrelated_runtime_sha256": _digest(unrelated_runtime),
        "provenance_failures_sha256": _digest(EXPECTED_PROVENANCE_FAILURES),
    }


def _assert_unrelated_runtime_unchanged(core: Any, policy: dict[str, Any], profile: dict[str, Any], state: dict[str, Any]) -> None:
    current = _unrelated_runtime_identity(core, policy, profile)
    original = state.get("production_identity")
    if not isinstance(original, dict) or any(original.get(key) != value for key, value in current.items()):
        raise core.RuntimeFault("UNRELATED_CONTAINER_OR_PROVENANCE_DRIFT", 74)


def _production_preflight_identity(core: Any, policy: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    production = profile["production"]
    compose = _secure_host_file(core, production["compose_path"], 0o644, 4 * 1024 * 1024)
    environment = _secure_host_file(core, production["environment_path"], 0o600, 4 * 1024 * 1024)
    if _sha_file(compose, 4 * 1024 * 1024) != production["compose_sha256"]:
        raise core.RuntimeFault("PRODUCTION_COMPOSE_IDENTITY_DRIFT", 74)
    gravity = core.container_projection(policy, "crm.container.gravity_mvp")
    if (
        gravity["container_id"] != production["gravity_container_id"]
        or gravity["image_id"] != production["gravity_image_id"]
        or not gravity["running"]
        or gravity["health"] != "healthy"
        or gravity["restart_count"] != 0
        or gravity["compose_labels"].get("com.docker.compose.config-hash") != production["compose_config_hash"]
    ):
        raise core.RuntimeFault("PRODUCTION_GRAVITY_IDENTITY_DRIFT", 74)
    tg_bot = core.container_projection(policy, "crm.container.telegram_bot")
    if (
        tg_bot["container_id"] != production["tg_bot_container_id"]
        or tg_bot["image_id"] != production["tg_bot_image_id"]
        or not tg_bot["running"]
        or tg_bot["health"] != "healthy"
        or tg_bot["restart_count"] != 0
        or tg_bot["compose_labels"].get("com.docker.compose.config-hash") != production["tg_bot_compose_config_hash"]
        or tg_bot["entrypoint"] != production["tg_bot_entrypoint"]
        or tg_bot["cmd"] != production["tg_bot_cmd"]
        or tg_bot["declared_user"] != production["tg_bot_declared_user"]
        or tg_bot["working_dir"] != production["tg_bot_working_dir"]
    ):
        raise core.RuntimeFault("PRODUCTION_TG_BOT_IDENTITY_DRIFT", 74)
    tg_patch = _tg_patch_file_probe(core, production["tg_bot_container"])
    _validate_tg_patch_absent(core, tg_patch, "PRODUCTION_TG_PATCH_BASELINE_DRIFT")
    manifest = core.tree_manifest(policy, core.Invocation("fs-tree", "crm.repo.production"))
    if manifest["manifest_sha256"] != production["source_manifest_sha256"]:
        raise core.RuntimeFault("PRODUCTION_SOURCE_IDENTITY_DRIFT", 74)
    postgres = _postgres_identity(core, profile)
    unrelated_identity = _unrelated_runtime_identity(core, policy, profile)
    return {
        "compose_sha256": production["compose_sha256"],
        "environment_sha256": _sha_file(environment, 4 * 1024 * 1024),
        "production_source_manifest_sha256": manifest["manifest_sha256"],
        "gravity_semantic": gravity["semantic"],
        "tg_bot_semantic": tg_bot["semantic"],
        "tg_bot_patch_baseline": tg_patch,
        "postgres_identity_sha256": postgres["database_identity_sha256"],
        **unrelated_identity,
    }


def _storage_guard(core: Any, profile: dict[str, Any], required_working: int) -> dict[str, int]:
    filesystem = os.statvfs(core.mapped(ACTIVATION_ROOT))
    available = filesystem.f_bavail * filesystem.f_frsize
    minimum = int(profile["limits"]["minimum_free_bytes"])
    if available < minimum + required_working:
        raise core.RuntimeFault("ACTIVATION_STORAGE_GUARD_FAILED", 74, {
            "available_bytes": available,
            "minimum_reserve_bytes": minimum,
            "required_working_bytes": required_working,
        })
    return {"available_bytes": available, "minimum_reserve_bytes": minimum, "required_working_bytes": required_working}


def _root_log(core: Any, name: str) -> tuple[Path, int]:
    path = core.mapped(ACTIVATION_ROOT + "/" + name)
    path.unlink(missing_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    return path, fd


def _gravity_candidate_image_ids(profile: dict[str, Any]) -> set[str]:
    artifact = profile["accepted_source"]["gravity_image_artifact"]
    return {artifact["image_id"], artifact["containerd_image_id"]}


def _verify_gravity_candidate_image(core: Any, profile: dict[str, Any]) -> dict[str, Any]:
    source = profile["accepted_source"]
    image = _image_inspect(core, TARGET_TAG)
    accepted_ids = _gravity_candidate_image_ids(profile)
    if image is None or image.get("Id") not in accepted_ids:
        raise core.RuntimeFault("GRAVITY_CANDIDATE_IMAGE_IDENTITY_MISMATCH", 74, {
            "expected_image_ids": sorted(accepted_ids),
            "observed_image_id": None if image is None else image.get("Id"),
        })
    labels = (image.get("Config") or {}).get("Labels") or {}
    if (
        labels.get("org.opencontainers.image.revision") != source["commit"]
        or labels.get("yoko.activation.profile") != PROFILE_ID
    ):
        raise core.RuntimeFault("GRAVITY_CANDIDATE_IMAGE_PROVENANCE_MISMATCH", 74, {
            "expected_revision": source["commit"],
            "expected_profile_id": PROFILE_ID,
            "observed_revision": labels.get("org.opencontainers.image.revision"),
            "observed_profile_id": labels.get("yoko.activation.profile"),
        })
    return image


def _remove_just_loaded_gravity_candidate(core: Any) -> None:
    if _image_inspect(core, TARGET_TAG, required=False) is None:
        return
    _required_success(
        core, [DOCKER, "image", "rm", TARGET_TAG], timeout=60,
        code="GRAVITY_CANDIDATE_FAILED_LOAD_CLEANUP_FAILED",
    )
    if _image_inspect(core, TARGET_TAG, required=False) is not None:
        raise core.RuntimeFault("GRAVITY_CANDIDATE_FAILED_LOAD_CLEANUP_FAILED", 74)


def _build_candidate(core: Any, profile: dict[str, Any], context: Path) -> str:
    del context  # Runtime never builds Gravity; source remains audit evidence.
    existing = _image_inspect(core, TARGET_TAG, required=False)
    if existing is not None:
        try:
            return _verify_gravity_candidate_image(core, profile)["Id"]
        except core.RuntimeFault as exc:
            raise core.RuntimeFault("TARGET_IMAGE_TAG_COLLISION", 74, {
                "observed_image_id": existing.get("Id"),
                "verification_failure_code": exc.code,
            }) from exc
    artifact = profile["accepted_source"]["gravity_image_artifact"]
    archive = _secure_host_file(
        core, GRAVITY_IMAGE_ARCHIVE_PATH, 0o444,
        int(artifact["docker_archive_bytes"]),
    )
    value = archive.lstat()
    if (
        value.st_size != artifact["docker_archive_bytes"]
        or _sha_file(archive, int(artifact["docker_archive_bytes"]))
        != artifact["docker_archive_sha256"]
    ):
        raise core.RuntimeFault("GRAVITY_IMAGE_ARCHIVE_IDENTITY_MISMATCH", 74)
    try:
        completed = _required_success(
            core,
            [DOCKER, "image", "load", "--input", GRAVITY_IMAGE_ARCHIVE_PATH],
            timeout=int(profile["limits"]["build_timeout_seconds"]),
            code="GRAVITY_IMAGE_OFFLINE_LOAD_FAILED",
        )
        expected_line = f"Loaded image: {TARGET_TAG}\n".encode("ascii")
        if (completed.stdout, completed.stderr) not in {
            (expected_line, b""), (b"", expected_line),
        }:
            raise core.RuntimeFault("GRAVITY_IMAGE_OFFLINE_LOAD_OUTPUT_INVALID", 74)
        return _verify_gravity_candidate_image(core, profile)["Id"]
    except Exception as verification_failure:
        try:
            _remove_just_loaded_gravity_candidate(core)
        except Exception as cleanup_failure:
            failure_code = (
                verification_failure.code
                if isinstance(verification_failure, core.RuntimeFault)
                else "INTERNAL_CANDIDATE_VERIFICATION_FAILURE"
            )
            raise core.RuntimeFault("GRAVITY_CANDIDATE_FAILED_LOAD_CLEANUP_FAILED", 74, {
                "verification_failure_code": failure_code,
            }) from cleanup_failure
        raise


def _tg_patch_labels(profile: dict[str, Any]) -> dict[str, str]:
    source = profile["accepted_source"]
    return {
        "org.opencontainers.image.revision": source["commit"],
        "yoko.activation.profile": PROFILE_ID,
        "yoko.source.archive.sha256": source["archive_sha256"],
        "yoko.tg-bot.base-image": TG_BASE_IMAGE,
        "yoko.tg-bot.patch.path": TG_PATCH_DESTINATION,
        "yoko.tg-bot.patch.sha256": TG_PATCH_TARGET_SHA256,
    }


def _tg_patch_recipe(profile: dict[str, Any]) -> bytes:
    labels = _tg_patch_labels(profile)
    return (
        f"FROM {TG_BASE_REFERENCE}\n"
        f"LABEL org.opencontainers.image.revision=\"{labels['org.opencontainers.image.revision']}\"\n"
        f"LABEL yoko.activation.profile=\"{labels['yoko.activation.profile']}\"\n"
        f"LABEL yoko.source.archive.sha256=\"{labels['yoko.source.archive.sha256']}\"\n"
        f"LABEL yoko.tg-bot.base-image=\"{labels['yoko.tg-bot.base-image']}\"\n"
        f"LABEL yoko.tg-bot.patch.path=\"{labels['yoko.tg-bot.patch.path']}\"\n"
        f"LABEL yoko.tg-bot.patch.sha256=\"{labels['yoko.tg-bot.patch.sha256']}\"\n"
        "COPY --chown=0:0 --chmod=0644 public-bot-maintenance.js /app/src/public-bot-maintenance.js\n"
    ).encode("ascii")


def _prepare_tg_patch_context(core: Any, profile: dict[str, Any]) -> Path:
    recipe = _tg_patch_recipe(profile)
    if hashlib.sha256(recipe).hexdigest() != profile["accepted_source"]["tg_bot_patch_recipe_sha256"]:
        raise core.RuntimeFault("TG_PATCH_RECIPE_IDENTITY_MISMATCH", 78)
    source = _tg_patch_source(core, profile)
    if _sha_file(source, 1024 * 1024) != TG_PATCH_TARGET_SHA256:
        raise core.RuntimeFault("TG_PATCH_SOURCE_IDENTITY_MISMATCH", 78)
    target = core.mapped(TG_PATCH_CONTEXT)
    temporary = core.mapped(TG_PATCH_CONTEXT + ".new")
    for candidate in (temporary, target):
        if candidate.exists():
            value = candidate.lstat()
            if candidate.is_symlink() or not stat.S_ISDIR(value.st_mode) or value.st_uid != core.expected_owner()[0]:
                raise core.RuntimeFault("TG_PATCH_CONTEXT_UNSAFE", 78)
            shutil.rmtree(candidate)
    temporary.mkdir(mode=0o700)
    try:
        _write_fixed_file(core, TG_PATCH_CONTEXT + ".new/Dockerfile", recipe, 0o400)
        raw = source.read_bytes()
        _write_fixed_file(core, TG_PATCH_CONTEXT + ".new/public-bot-maintenance.js", raw, 0o644)
        entries = sorted(item.name for item in temporary.iterdir())
        if entries != ["Dockerfile", "public-bot-maintenance.js"]:
            raise core.RuntimeFault("TG_PATCH_CONTEXT_INVENTORY_MISMATCH", 78)
        for name, mode, digest in (
            ("Dockerfile", 0o400, profile["accepted_source"]["tg_bot_patch_recipe_sha256"]),
            ("public-bot-maintenance.js", 0o644, TG_PATCH_TARGET_SHA256),
        ):
            item = temporary / name
            value = item.lstat()
            if item.is_symlink() or not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or stat.S_IMODE(value.st_mode) != mode or _sha_file(item, 1024 * 1024) != digest:
                raise core.RuntimeFault("TG_PATCH_CONTEXT_INVENTORY_MISMATCH", 78)
        os.chmod(temporary, 0o500)
        os.replace(temporary, target)
    except Exception:
        if temporary.exists() and not temporary.is_symlink():
            shutil.rmtree(temporary)
        raise
    return target


def _remove_tg_diff_proof(core: Any, *, required: bool) -> None:
    completed = _run(core, [DOCKER, "container", "inspect", TG_DIFF_PROOF_CONTAINER], timeout=30)
    if completed.returncode != 0:
        if _docker_inspect_absent(core, completed, "container", TG_DIFF_PROOF_CONTAINER, code="TG_DIFF_PROOF_IDENTITY_FAILED"):
            if required:
                raise core.RuntimeFault("TG_DIFF_PROOF_CONTAINER_MISSING", 74)
            return
    try:
        value = json.loads(completed.stdout)
    except (UnicodeError, ValueError) as exc:
        raise core.RuntimeFault("TG_DIFF_PROOF_IDENTITY_FAILED", 74) from exc
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise core.RuntimeFault("TG_DIFF_PROOF_IDENTITY_FAILED", 74)
    raw = value[0]
    labels = (raw.get("Config") or {}).get("Labels") or {}
    if raw.get("Image") != TG_BASE_IMAGE or labels.get("yoko.activation.profile") != PROFILE_ID or (raw.get("State") or {}).get("Running") is True:
        raise core.RuntimeFault("TG_DIFF_PROOF_IDENTITY_FAILED", 74)
    _required_success(core, [DOCKER, "rm", TG_DIFF_PROOF_CONTAINER], timeout=60, code="TG_DIFF_PROOF_CLEANUP_FAILED")


def _prove_tg_one_file_diff(core: Any, context: Path) -> None:
    _remove_tg_diff_proof(core, required=False)
    created = False
    try:
        _required_success(
            core,
            [DOCKER, "create", "--name", TG_DIFF_PROOF_CONTAINER, "--label", f"yoko.activation.profile={PROFILE_ID}", "--entrypoint", "/bin/true", TG_BASE_IMAGE],
            timeout=60,
            code="TG_DIFF_PROOF_CREATE_FAILED",
        )
        created = True
        _required_success(
            core,
            [DOCKER, "cp", str(context / "public-bot-maintenance.js"), f"{TG_DIFF_PROOF_CONTAINER}:{TG_PATCH_DESTINATION}"],
            timeout=60,
            code="TG_DIFF_PROOF_COPY_FAILED",
        )
        diff = _required_success(core, [DOCKER, "diff", TG_DIFF_PROOF_CONTAINER], timeout=30, code="TG_DIFF_PROOF_READ_FAILED")
        try:
            lines = [line for line in diff.stdout.decode("ascii").splitlines() if line]
        except UnicodeError as exc:
            raise core.RuntimeFault("TG_DIFF_PROOF_INVALID", 74) from exc
        _validate_tg_diff_lines(core, lines)
    finally:
        if created:
            _remove_tg_diff_proof(core, required=True)


def _validate_tg_diff_lines(core: Any, lines: Any) -> None:
    if lines != ["C /app", "C /app/src", f"A {TG_PATCH_DESTINATION}"]:
        raise core.RuntimeFault("TG_DIFF_PROOF_INVALID", 74)


def _verify_tg_candidate_image(core: Any, profile: dict[str, Any], image: dict[str, Any]) -> None:
    base = _image_inspect(core, TG_BASE_IMAGE)
    assert base is not None
    base_config = dict(base.get("Config") or {})
    target_config = dict(image.get("Config") or {})
    base_labels = dict(base_config.pop("Labels", None) or {})
    target_labels = dict(target_config.pop("Labels", None) or {})
    expected_labels = {**base_labels, **_tg_patch_labels(profile)}
    base_layers = (base.get("RootFS") or {}).get("Layers")
    target_layers = (image.get("RootFS") or {}).get("Layers")
    if (
        base.get("Id") != TG_BASE_IMAGE
        or target_config != base_config
        or target_labels != expected_labels
        or not isinstance(base_layers, list)
        or not isinstance(target_layers, list)
        or target_layers[:-1] != base_layers
        or len(target_layers) != len(base_layers) + 1
        or image.get("Os") != base.get("Os")
        or image.get("Architecture") != base.get("Architecture")
    ):
        raise core.RuntimeFault("TG_CANDIDATE_IMAGE_IDENTITY_MISMATCH", 74)


def _tg_image_file_probe(core: Any, profile: dict[str, Any], reference: str) -> dict[str, Any]:
    completed = _run(core, [DOCKER, "run", "--rm", "--network", "none", "--entrypoint", "node", reference, "-e", _tg_patch_probe_script()], timeout=60)
    if completed.returncode != 0:
        raise core.RuntimeFault("TG_CANDIDATE_FILE_PROBE_FAILED", 74)
    try:
        value = json.loads(completed.stdout)
    except (UnicodeError, ValueError) as exc:
        raise core.RuntimeFault("TG_CANDIDATE_FILE_PROBE_INVALID", 74) from exc
    return _validate_tg_patch_probe(core, profile, value, TG_PATCH_TARGET_SHA256, "TG_CANDIDATE_FILE_IDENTITY_MISMATCH")


def _build_tg_candidate(core: Any, profile: dict[str, Any]) -> str:
    context = _prepare_tg_patch_context(core, profile)
    _prove_tg_one_file_diff(core, context)
    existing = _image_inspect(core, TG_TARGET_TAG, required=False)
    if existing is None:
        log, fd = _root_log(core, "tg-candidate-build.log")
        try:
            _required_success(
                core,
                [DOCKER, "build", "--pull=false", "--network", "none", "--no-cache", "--tag", TG_TARGET_TAG, "--file", str(context / "Dockerfile"), str(context)],
                timeout=int(profile["limits"]["build_timeout_seconds"]),
                code="TG_CANDIDATE_BUILD_FAILED",
                stdout_fd=fd,
                stderr_fd=fd,
            )
            os.fsync(fd)
        finally:
            os.close(fd)
            os.chmod(log, 0o600)
        existing = _image_inspect(core, TG_TARGET_TAG)
    assert existing is not None
    _verify_tg_candidate_image(core, profile, existing)
    _tg_image_file_probe(core, profile, TG_TARGET_TAG)
    return existing["Id"]


def _seal_rollback_tag(core: Any, expected: str, rollback_tag: str, *, prefix: str) -> None:
    old = _image_inspect(core, expected)
    assert old is not None
    current = _image_inspect(core, rollback_tag, required=False)
    if current is not None and current["Id"] != expected:
        raise core.RuntimeFault(f"{prefix}_ROLLBACK_IMAGE_TAG_COLLISION", 74)
    if current is None:
        _required_success(core, [DOCKER, "tag", expected, rollback_tag], timeout=30, code=f"{prefix}_ROLLBACK_IMAGE_SEAL_FAILED")
    sealed = _image_inspect(core, rollback_tag)
    if sealed is None or sealed["Id"] != expected:
        raise core.RuntimeFault(f"{prefix}_ROLLBACK_IMAGE_IDENTITY_MISMATCH", 74)


def _seal_rollback_images(core: Any, profile: dict[str, Any]) -> None:
    _seal_rollback_tag(core, profile["production"]["gravity_image_id"], ROLLBACK_TAG, prefix="GRAVITY")
    _seal_rollback_tag(core, profile["production"]["tg_bot_image_id"], TG_ROLLBACK_TAG, prefix="TG_BOT")


def _audit(core: Any, invocation: Any, state: dict[str, Any], result: str, post: dict[str, Any]) -> None:
    core.append_audit(
        invocation,
        core.request_digest(invocation),
        _digest(state),
        result,
        _digest(post),
    )


def _terminal_audit_matches(core: Any, state: dict[str, Any], receipt: dict[str, Any]) -> int:
    status = core.audit_status()
    if status["state"] not in {"EMPTY", "VALID"}:
        raise core.RuntimeFault("AUDIT_MUTATION_DISABLED", 78)
    target = core.mapped(core.AUDIT_LOG)
    if not target.exists():
        return 0
    core.secure_file(core.AUDIT_LOG, 0o600, maximum=32 * 1024 * 1024)
    expected = {
        "primitive": receipt["primitive"],
        "resource": receipt["resource"],
        "request_digest": receipt["request_digest"],
        "pre_state_digest": receipt["pre_state_digest"],
        "result": receipt["result"],
        "post_state_digest": receipt["post_state_digest"],
    }
    matches = 0
    try:
        for line in target.read_bytes().splitlines():
            record = json.loads(line)
            if isinstance(record, dict) and all(record.get(key) == value for key, value in expected.items()):
                matches += 1
    except (OSError, UnicodeError, ValueError) as exc:
        raise core.RuntimeFault("AUDIT_MUTATION_DISABLED", 78) from exc
    return matches


def _reconcile_terminal_audit(core: Any, state: dict[str, Any]) -> None:
    receipt = state.get("terminal_audit_receipt")
    if receipt is None:
        return
    if (
        not isinstance(receipt, dict)
        or set(receipt) != {"primitive", "resource", "request_digest", "pre_state_digest", "result", "post_state_digest"}
        or not isinstance(receipt.get("primitive"), str)
        or receipt.get("resource") is not None
        or not SHA256.fullmatch(str(receipt.get("request_digest", "")))
        or not SHA256.fullmatch(str(receipt.get("pre_state_digest", "")))
        or not SHA256.fullmatch(str(receipt.get("post_state_digest", "")))
        or not isinstance(receipt.get("result"), str)
        or not receipt["result"]
    ):
        raise core.RuntimeFault("TERMINAL_AUDIT_RECEIPT_INVALID", 78)
    post = {key: value for key, value in state.items() if key != "terminal_audit_receipt"}
    if _digest(post) != receipt["post_state_digest"]:
        raise core.RuntimeFault("TERMINAL_AUDIT_RECEIPT_STATE_DRIFT", 78)
    matches = _terminal_audit_matches(core, state, receipt)
    if matches > 1:
        raise core.RuntimeFault("TERMINAL_AUDIT_DUPLICATED", 78)
    if matches == 0:
        stored_invocation = core.Invocation(receipt["primitive"], receipt["resource"])
        if core.request_digest(stored_invocation) != receipt["request_digest"]:
            raise core.RuntimeFault("TERMINAL_AUDIT_RECEIPT_INVALID", 78)
        core.append_audit(
            stored_invocation,
            receipt["request_digest"],
            receipt["pre_state_digest"],
            receipt["result"],
            receipt["post_state_digest"],
        )
        if _terminal_audit_matches(core, state, receipt) != 1:
            raise core.RuntimeFault("TERMINAL_AUDIT_RECONCILIATION_FAILED", 78)
    _write_state(core, post)
    state.clear()
    state.update(post)


def _write_terminal_state(core: Any, invocation: Any, pre: dict[str, Any], result: str, post: dict[str, Any]) -> dict[str, Any]:
    if "terminal_audit_receipt" in post:
        raise core.RuntimeFault("TERMINAL_AUDIT_RECEIPT_INVALID", 78)
    terminal = {
        **post,
        "terminal_audit_receipt": {
            "primitive": invocation.primitive,
            "resource": invocation.resource,
            "request_digest": core.request_digest(invocation),
            "pre_state_digest": _digest(pre),
            "result": result,
            "post_state_digest": _digest(post),
        },
    }
    _write_state(core, terminal)
    _reconcile_terminal_audit(core, terminal)
    return terminal


def _release_retry_preflight(
    core: Any,
    policy: dict[str, Any],
    profile: dict[str, Any],
    invocation: Any,
    state: dict[str, Any],
) -> dict[str, Any]:
    recovery = profile["recovery"]
    preview = state.get("preview_proof")
    prior_target = _image_inspect(core, PRIOR_TARGET_TAG)
    rollback = _image_inspect(core, ROLLBACK_TAG)
    if (
        state.get("phase") != "ROLLED_BACK"
        or state.get("accepted_commit") != recovery["prior_source_commit"]
        or state.get("accepted_archive_sha256") != recovery["prior_source_archive_sha256"]
        or state.get("target_tag") != PRIOR_TARGET_TAG
        or state.get("target_image_id") != recovery["prior_target_image_id"]
        or prior_target is None
        or prior_target["Id"] != recovery["prior_target_image_id"]
        or state.get("rollback_tag") != ROLLBACK_TAG
        or state.get("rollback_image_id") != profile["production"]["gravity_image_id"]
        or rollback is None
        or rollback["Id"] != profile["production"]["gravity_image_id"]
        or state.get("database_identity_sha256") != recovery["database_identity_sha256"]
        or state.get("migration_ledger_sha256") != recovery["migration_ledger_sha256"]
        or state.get("backup_sha256") != recovery["backup_sha256"]
        or state.get("backup_bytes") != recovery["backup_bytes"]
        or state.get("restore_verified") is not True
        or state.get("rollback_image_schema_compatible") is not True
        or not isinstance(state.get("migration_completed_at"), str)
        or not state["migration_completed_at"]
        or not isinstance(state.get("rollback_completed_at"), str)
        or not state["rollback_completed_at"]
        or state.get("activation_failure") is not True
        or not isinstance(preview, dict)
        or set(preview) != {"migration_ledger_sha256", "outbox_catalog_sha256"}
        or preview.get("migration_ledger_sha256") != recovery["migration_ledger_sha256"]
        or preview.get("outbox_catalog_sha256") != recovery["preview_outbox_catalog_sha256"]
    ):
        raise core.RuntimeFault("ROLLED_BACK_RETRY_STATE_INVALID", 78)
    verified_backup = _verify_recovery_backup(core, profile, state)
    if (
        verified_backup["sha256"] != recovery["backup_sha256"]
        or verified_backup["bytes"] != recovery["backup_bytes"]
    ):
        raise core.RuntimeFault("ROLLED_BACK_RETRY_BACKUP_DRIFT", 74)
    database, _ = _database_status(core, profile)
    if (
        database["migration_state"] != "APPROVED_OUTBOX_APPLIED"
        or database["database_identity_sha256"] != recovery["database_identity_sha256"]
        or database["migration_ledger_sha256"] != recovery["migration_ledger_sha256"]
    ):
        raise core.RuntimeFault("ROLLED_BACK_RETRY_DATABASE_DRIFT", 74)
    inventory = _archive_inventory(core, profile)
    production = _production_preflight_identity(core, policy, profile)
    storage = _storage_guard(core, profile, int(profile["limits"]["preflight_working_bytes"]))
    prior_state_digest = _digest(state)
    intent = {
        **state,
        "phase": "RETRY_PREFLIGHT_INTENT",
        "retry_source_state_digest": prior_state_digest,
    }
    _audit(core, invocation, state, "retry_intent", intent)
    try:
        context = _extract_source(core, profile)
        target_image_id = _build_candidate(core, profile, context)
        tg_target_image_id = _build_tg_candidate(core, profile)
        _seal_rollback_images(core, profile)
        next_state = {
            "schema": STATE_SCHEMA,
            "profile_id": PROFILE_ID,
            "phase": "MIGRATED",
            "accepted_commit": profile["accepted_source"]["commit"],
            "accepted_archive_sha256": profile["accepted_source"]["archive_sha256"],
            "target_image_id": target_image_id,
            "target_tag": TARGET_TAG,
            "rollback_image_id": profile["production"]["gravity_image_id"],
            "rollback_tag": ROLLBACK_TAG,
            "tg_target_image_id": tg_target_image_id,
            "tg_target_tag": TG_TARGET_TAG,
            "tg_rollback_image_id": profile["production"]["tg_bot_image_id"],
            "tg_rollback_tag": TG_ROLLBACK_TAG,
            "production_identity": production,
            "database_identity_sha256": database["database_identity_sha256"],
            "migration_ledger_sha256": database["migration_ledger_sha256"],
            "preflight_completed_at": core.now(),
            "backup_sha256": recovery["backup_sha256"],
            "backup_bytes": recovery["backup_bytes"],
            "restore_verified": True,
            "preview_proof": dict(preview),
            "rollback_image_schema_compatible": True,
            "migration_completed_at": state["migration_completed_at"],
            "retry_from_package_version": recovery["predecessor_package_version"],
            "retry_source_state_digest": prior_state_digest,
            "retry_storage_guard": storage,
        }
        next_state = _write_terminal_state(core, invocation, intent, "retry_ok", next_state)
    except Exception:
        _audit(core, invocation, intent, "retry_failed", _read_state(core))
        raise
    return {
        "profile_id": PROFILE_ID,
        "status": "PREFLIGHT_READY_DATABASE_ALREADY_MIGRATED",
        "archive_inventory": inventory,
        "target_image_id": next_state["target_image_id"],
        "rollback_image_id": next_state["rollback_image_id"],
        "tg_target_image_id": next_state["tg_target_image_id"],
        "tg_rollback_image_id": next_state["tg_rollback_image_id"],
        "database_identity_sha256": next_state["database_identity_sha256"],
        "database_migration_state": database["migration_state"],
        "backup": verified_backup,
        "storage": storage,
        "production_mutation": False,
        "production_database_mutation": False,
    }


def _release_preflight(core: Any, policy: dict[str, Any], profile: dict[str, Any], invocation: Any) -> dict[str, Any]:
    with _lock(core):
        state = _read_state(core)
        _reconcile_terminal_audit(core, state)
        if state.get("phase") in {"PREFLIGHT_READY", "MIGRATED", "ACTIVATED"}:
            target = _verify_gravity_candidate_image(core, profile)
            rollback = _image_inspect(core, ROLLBACK_TAG)
            tg_target = _image_inspect(core, TG_TARGET_TAG)
            tg_rollback = _image_inspect(core, TG_ROLLBACK_TAG)
            if target is None or target["Id"] != state.get("target_image_id") or rollback is None or rollback["Id"] != profile["production"]["gravity_image_id"] or tg_target is None or tg_target["Id"] != state.get("tg_target_image_id") or tg_rollback is None or tg_rollback["Id"] != profile["production"]["tg_bot_image_id"]:
                raise core.RuntimeFault("SEALED_RELEASE_IDENTITY_DRIFT", 74)
            return {
                "profile_id": PROFILE_ID,
                "status": "ALREADY_PREFLIGHTED",
                "target_image_id": target["Id"],
                "rollback_image_id": rollback["Id"],
                "tg_target_image_id": tg_target["Id"],
                "tg_rollback_image_id": tg_rollback["Id"],
                "production_mutation": False,
            }
        if state.get("phase") == "ROLLED_BACK":
            raise core.RuntimeFault("ROLLED_BACK_RELEASE_TERMINAL", 77)
        if state.get("phase") != "UNINITIALIZED":
            raise core.RuntimeFault("ACTIVATION_STATE_PHASE_INVALID", 78)
        if core.audit_status()["state"] not in {"EMPTY", "VALID"}:
            raise core.RuntimeFault("AUDIT_MUTATION_DISABLED", 78)
        inventory = _archive_inventory(core, profile)
        production = _production_preflight_identity(core, policy, profile)
        database, _ = _database_status(core, profile)
        if database["migration_state"] != "APPROVED_OUTBOX_APPLIED":
            raise core.RuntimeFault("SOURCE_ONLY_DATABASE_BASELINE_DRIFT", 74)
        storage = _storage_guard(core, profile, int(profile["limits"]["preflight_working_bytes"]))
        intent = {**state, "phase": "PREFLIGHT_INTENT"}
        _audit(core, invocation, state, "intent", intent)
        try:
            context = _extract_source(core, profile)
            target_image_id = _build_candidate(core, profile, context)
            tg_target_image_id = _build_tg_candidate(core, profile)
            _seal_rollback_images(core, profile)
            next_state = {
                "schema": STATE_SCHEMA,
                "profile_id": PROFILE_ID,
                "phase": "MIGRATED",
                "accepted_commit": profile["accepted_source"]["commit"],
                "accepted_archive_sha256": profile["accepted_source"]["archive_sha256"],
                "target_image_id": target_image_id,
                "target_tag": TARGET_TAG,
                "rollback_image_id": profile["production"]["gravity_image_id"],
                "rollback_tag": ROLLBACK_TAG,
                "tg_target_image_id": tg_target_image_id,
                "tg_target_tag": TG_TARGET_TAG,
                "tg_rollback_image_id": profile["production"]["tg_bot_image_id"],
                "tg_rollback_tag": TG_ROLLBACK_TAG,
                "production_identity": production,
                "database_identity_sha256": database["database_identity_sha256"],
                "migration_ledger_sha256": database["migration_ledger_sha256"],
                "migration_completed_at": "SOURCE_ONLY_NO_DATABASE_MUTATION",
                "preflight_completed_at": core.now(),
            }
            next_state = _write_terminal_state(core, invocation, intent, "ok", next_state)
        except Exception:
            _audit(core, invocation, intent, "failed", _read_state(core))
            raise
        return {
            "profile_id": PROFILE_ID,
            "status": "PREFLIGHT_READY_DATABASE_UNCHANGED",
            "archive_inventory": inventory,
            "target_image_id": next_state["target_image_id"],
            "rollback_image_id": next_state["rollback_image_id"],
            "tg_target_image_id": next_state["tg_target_image_id"],
            "tg_rollback_image_id": next_state["tg_rollback_image_id"],
            "database_identity_sha256": next_state["database_identity_sha256"],
            "storage": storage,
            "production_mutation": False,
        }


def _database_size(core: Any, identity: dict[str, Any]) -> int:
    raw = _psql(core, identity, "SELECT pg_database_size(current_database())::text;", code="DATABASE_SIZE_QUERY_FAILED")
    try:
        size = int(raw.decode("ascii").strip())
    except (UnicodeError, ValueError) as exc:
        raise core.RuntimeFault("DATABASE_SIZE_QUERY_INVALID", 74) from exc
    if size < 1:
        raise core.RuntimeFault("DATABASE_SIZE_QUERY_INVALID", 74)
    return size


def _create_backup(core: Any, profile: dict[str, Any], identity: dict[str, Any]) -> dict[str, Any]:
    target = core.mapped(BACKUP_PATH)
    if target.exists():
        core.secure_file(BACKUP_PATH, 0o400, maximum=int(profile["limits"]["maximum_backup_bytes"]))
        target.unlink()
    try:
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o400)
        try:
            _required_success(
                core,
                [DOCKER, "exec", identity["container"], "pg_dump", "--format=custom", "--no-owner", "--no-privileges", "--compress=6", "--username", identity["user"], "--dbname", identity["database"]],
                timeout=int(profile["limits"]["database_timeout_seconds"]),
                code="DATABASE_BACKUP_FAILED",
                stdout_fd=fd,
            )
            os.fsync(fd)
        finally:
            os.close(fd)
        os.chmod(target, 0o400)
        size = target.stat().st_size
        if size < 1024 or size > int(profile["limits"]["maximum_backup_bytes"]):
            raise core.RuntimeFault("DATABASE_BACKUP_SIZE_INVALID", 74)
        _cleanup_runner(core, BACKUP_LIST_RUNNER)
        read_fd = os.open(target, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            try:
                completed = _required_success(
                    core,
                    [DOCKER, "run", "--name", BACKUP_LIST_RUNNER, "--label", f"yoko.activation.profile={PROFILE_ID}", "--label", f"yoko.activation.runner={BACKUP_LIST_RUNNER}", "--network", "none", "-i", profile["production"]["postgres_image_id"], "pg_restore", "--list"],
                    timeout=120,
                    code="BACKUP_LIST_VERIFY_FAILED",
                    stdin_fd=read_fd,
                )
            finally:
                _cleanup_runner(core, BACKUP_LIST_RUNNER)
        finally:
            os.close(read_fd)
        if len(completed.stdout) < 64:
            raise core.RuntimeFault("BACKUP_LIST_VERIFY_FAILED", 74)
        return {"sha256": _sha_file(target, int(profile["limits"]["maximum_backup_bytes"])), "bytes": size, "status": "CREATED_AND_LIST_VERIFIED"}
    except Exception:
        target.unlink(missing_ok=True)
        raise


def _verify_recovery_backup(core: Any, profile: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    maximum = int(profile["limits"]["maximum_backup_bytes"])
    expected_hash = state.get("backup_sha256")
    expected_bytes = state.get("backup_bytes")
    if (
        not SHA256.fullmatch(str(expected_hash or ""))
        or isinstance(expected_bytes, bool)
        or not isinstance(expected_bytes, int)
        or expected_bytes < 1024
        or expected_bytes > maximum
    ):
        raise core.RuntimeFault("DATABASE_RECOVERY_BACKUP_STATE_INVALID", 74)
    try:
        value = core.secure_file(BACKUP_PATH, 0o400, maximum=maximum)
        target = core.mapped(BACKUP_PATH)
        if value.st_size != expected_bytes or _sha_file(target, maximum) != expected_hash:
            raise core.RuntimeFault("DATABASE_RECOVERY_BACKUP_IDENTITY_DRIFT", 74)
    except core.RuntimeFault:
        raise
    except (OSError, RuntimeError) as exc:
        raise core.RuntimeFault("DATABASE_RECOVERY_BACKUP_UNAVAILABLE", 74) from exc
    return {"sha256": expected_hash, "bytes": expected_bytes, "status": "REHASHED_AND_VERIFIED"}


def _cleanup_preview(core: Any) -> None:
    container = _run(core, [DOCKER, "container", "inspect", PREVIEW_CONTAINER], timeout=30)
    if container.returncode == 0:
        try:
            values = json.loads(container.stdout)
            raw = values[0] if isinstance(values, list) and len(values) == 1 else None
            labels = ((raw or {}).get("Config") or {}).get("Labels") or {}
        except (UnicodeError, ValueError):
            raw = None
            labels = {}
        if not isinstance(raw, dict) or labels.get("yoko.activation.profile") != PROFILE_ID:
            raise core.RuntimeFault("PREVIEW_CONTAINER_NAME_COLLISION", 74)
        _required_success(core, [DOCKER, "rm", "-f", PREVIEW_CONTAINER], timeout=60, code="PREVIEW_CONTAINER_CLEANUP_FAILED")
    else:
        _docker_inspect_absent(core, container, "container", PREVIEW_CONTAINER, code="PREVIEW_CONTAINER_INSPECT_FAILED")
    network = _run(core, [DOCKER, "network", "inspect", PREVIEW_NETWORK], timeout=30)
    if network.returncode == 0:
        try:
            values = json.loads(network.stdout)
            raw_network = values[0] if isinstance(values, list) and len(values) == 1 else None
            labels = (raw_network or {}).get("Labels") or {}
        except (UnicodeError, ValueError):
            raw_network = None
            labels = {}
        if not isinstance(raw_network, dict) or labels.get("yoko.activation.profile") != PROFILE_ID:
            raise core.RuntimeFault("PREVIEW_NETWORK_NAME_COLLISION", 74)
        _required_success(core, [DOCKER, "network", "rm", PREVIEW_NETWORK], timeout=60, code="PREVIEW_NETWORK_CLEANUP_FAILED")
    else:
        _docker_inspect_absent(core, network, "network", PREVIEW_NETWORK, code="PREVIEW_NETWORK_INSPECT_FAILED")


def _start_preview(core: Any, profile: dict[str, Any]) -> dict[str, Any]:
    _cleanup_preview(core)
    _required_success(core, [DOCKER, "network", "create", "--internal", "--label", f"yoko.activation.profile={PROFILE_ID}", PREVIEW_NETWORK], timeout=60, code="PREVIEW_NETWORK_CREATE_FAILED")
    password = hashlib.sha256(os.urandom(64)).hexdigest()
    database = "yoko_preview"
    user = "yoko_preview"
    _write_fixed_file(core, PREVIEW_POSTGRES_ENV, f"POSTGRES_USER={user}\nPOSTGRES_PASSWORD={password}\nPOSTGRES_DB={database}\n".encode("ascii"), 0o400)
    try:
        _required_success(
            core,
            [DOCKER, "run", "-d", "--name", PREVIEW_CONTAINER, "--network", PREVIEW_NETWORK, "--label", f"yoko.activation.profile={PROFILE_ID}", "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,nodev,size=8589934592", "--env-file", PREVIEW_POSTGRES_ENV, profile["production"]["postgres_image_id"]],
            timeout=120,
            code="PREVIEW_POSTGRES_START_FAILED",
        )
    finally:
        core.mapped(PREVIEW_POSTGRES_ENV).unlink(missing_ok=True)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        completed = _run(core, [DOCKER, "exec", PREVIEW_CONTAINER, "pg_isready", "-U", user, "-d", database], timeout=10)
        if completed.returncode == 0:
            break
        time.sleep(2)
    else:
        raise core.RuntimeFault("PREVIEW_POSTGRES_NOT_READY", 74)
    raw = _raw_container(core, PREVIEW_CONTAINER)
    if raw.get("Image") != profile["production"]["postgres_image_id"]:
        raise core.RuntimeFault("PREVIEW_POSTGRES_IMAGE_MISMATCH", 74)
    ports = (raw.get("NetworkSettings") or {}).get("Ports") or {}
    if any(value for value in ports.values()):
        raise core.RuntimeFault("PREVIEW_POSTGRES_PORT_EXPOSED", 74)
    return {"container": PREVIEW_CONTAINER, "user": user, "database": database, "password": password}


def _restore_preview(core: Any, profile: dict[str, Any], preview: dict[str, Any]) -> None:
    target = core.mapped(BACKUP_PATH)
    read_fd = os.open(target, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        _required_success(
            core,
            [DOCKER, "exec", "-i", PREVIEW_CONTAINER, "pg_restore", "--exit-on-error", "--no-owner", "--no-privileges", "--clean", "--if-exists", "--username", preview["user"], "--dbname", preview["database"]],
            timeout=int(profile["limits"]["database_timeout_seconds"]),
            code="PREVIEW_RESTORE_FAILED",
            stdin_fd=read_fd,
        )
    finally:
        os.close(read_fd)


def _database_url(user: str, password: str, host: str, database: str) -> str:
    return "postgresql://" + urllib.parse.quote(user, safe="") + ":" + urllib.parse.quote(password, safe="") + "@" + host + ":5432/" + urllib.parse.quote(database, safe="")


def _production_database_url(core: Any, profile: dict[str, Any], identity: dict[str, Any]) -> str:
    value = _container_environment(core, profile["production"]["gravity_container"]).get("DATABASE_URL", "")
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError as exc:
        raise core.RuntimeFault("PRODUCTION_DATABASE_URL_INVALID", 74) from exc
    if (
        parsed.scheme not in {"postgres", "postgresql"}
        or parsed.hostname != "postgres"
        or parsed.port != 5432
        or not parsed.username
        or parsed.password is None
        or parsed.path != "/" + urllib.parse.quote(identity["database"], safe="")
        or urllib.parse.unquote(parsed.username) != identity["user"]
        or parsed.query
        or parsed.fragment
    ):
        raise core.RuntimeFault("PRODUCTION_DATABASE_URL_INVALID", 74)
    return value


def _cleanup_runner(core: Any, name: str) -> None:
    completed = _run(core, [DOCKER, "container", "inspect", name], timeout=30)
    if completed.returncode != 0:
        _docker_inspect_absent(core, completed, "container", name, code="MIGRATION_RUNNER_INSPECT_FAILED")
        return
    try:
        values = json.loads(completed.stdout)
        raw = values[0] if isinstance(values, list) and len(values) == 1 else None
        labels = ((raw or {}).get("Config") or {}).get("Labels") or {}
        running = bool(((raw or {}).get("State") or {}).get("Running"))
    except (UnicodeError, ValueError):
        raw = None
        labels = {}
        running = False
    if not isinstance(raw, dict) or labels.get("yoko.activation.profile") != PROFILE_ID or labels.get("yoko.activation.runner") != name:
        raise core.RuntimeFault("MIGRATION_RUNNER_NAME_COLLISION", 74)
    if running:
        _required_success(core, [DOCKER, "kill", name], timeout=60, code="MIGRATION_RUNNER_KILL_FAILED")
    _required_success(core, [DOCKER, "rm", name], timeout=60, code="MIGRATION_RUNNER_CLEANUP_FAILED")


def _production_runner_command(runner: str) -> list[str]:
    if runner == PRODUCTION_MIGRATION_RUNNER:
        return ["migrate", "deploy"]
    if runner == PRODUCTION_RESOLVE_RUNNER:
        return ["migrate", "resolve", "--rolled-back", MIGRATION_NAME]
    raise ValueError("PRODUCTION_RUNNER_INVALID")


def _production_runner_observation(core: Any, runner: str) -> tuple[dict[str, Any], str]:
    if runner not in {PRODUCTION_MIGRATION_RUNNER, PRODUCTION_RESOLVE_RUNNER}:
        raise core.RuntimeFault("PRODUCTION_RUNNER_INVALID", 78)
    completed = _run(core, [DOCKER, "container", "inspect", runner], timeout=30)
    if completed.returncode != 0:
        _docker_inspect_absent(core, completed, "container", runner, code="PRODUCTION_RUNNER_INSPECT_FAILED")
        raise core.RuntimeFault("PRODUCTION_RUNNER_MISSING", 74)
    try:
        values = json.loads(completed.stdout)
        raw = values[0] if isinstance(values, list) and len(values) == 1 else None
        config = (raw or {}).get("Config") or {}
        host_config = (raw or {}).get("HostConfig") or {}
        labels = config.get("Labels") or {}
        environment = config.get("Env") or []
        database_urls = [item.split("=", 1)[1] for item in environment if isinstance(item, str) and item.startswith("DATABASE_URL=")]
        identity = {
            "container_id": (raw or {}).get("Id"),
            "created": (raw or {}).get("Created"),
            "name": (raw or {}).get("Name"),
            "image_id": (raw or {}).get("Image"),
            "configured_image": config.get("Image"),
            "entrypoint": config.get("Entrypoint"),
            "command": config.get("Cmd"),
            "network_mode": host_config.get("NetworkMode"),
            "labels": labels,
            "database_url_sha256": hashlib.sha256(database_urls[0].encode("utf-8")).hexdigest() if len(database_urls) == 1 else None,
            "environment_sha256": _digest(sorted(environment)) if all(isinstance(item, str) for item in environment) else None,
            "privileged": host_config.get("Privileged"),
            "binds": host_config.get("Binds"),
            "cap_add": host_config.get("CapAdd"),
            "devices": host_config.get("Devices"),
            "pid_mode": host_config.get("PidMode"),
            "readonly_rootfs": host_config.get("ReadonlyRootfs"),
            "security_opt": host_config.get("SecurityOpt"),
        }
    except (AttributeError, UnicodeError, ValueError) as exc:
        raise core.RuntimeFault("PRODUCTION_RUNNER_IDENTITY_INVALID", 74) from exc
    if (
        not isinstance(raw, dict)
        or not isinstance(identity["container_id"], str)
        or not re.fullmatch(r"[0-9a-f]{64}", identity["container_id"])
        or not isinstance(identity["created"], str)
        or not identity["created"]
        or identity["name"] != "/" + runner
        or labels.get("yoko.activation.profile") != PROFILE_ID
        or labels.get("yoko.activation.runner") != runner
        or len(database_urls) != 1
        or not isinstance(identity["image_id"], str)
        or not isinstance(identity["configured_image"], str)
        or identity["entrypoint"] != ["/app/node_modules/.bin/prisma"]
        or identity["command"] != _production_runner_command(runner)
        or not isinstance(identity["network_mode"], str)
        or identity["environment_sha256"] is None
        or identity["privileged"] is not False
        or identity["binds"] not in (None, [])
        or identity["cap_add"] not in (None, [])
        or identity["devices"] not in (None, [])
        or identity["pid_mode"] not in (None, "")
        or identity["readonly_rootfs"] is not False
        or identity["security_opt"] not in (None, [])
    ):
        raise core.RuntimeFault("PRODUCTION_RUNNER_IDENTITY_INVALID", 74)
    return raw, _digest(identity)


def _prepare_production_runners(core: Any, profile: dict[str, Any], image_id: str, database_url: str) -> dict[str, str]:
    runners = (PRODUCTION_MIGRATION_RUNNER, PRODUCTION_RESOLVE_RUNNER)
    for runner in runners:
        _cleanup_runner(core, runner)
    _write_fixed_file(core, MIGRATION_ENV, f"DATABASE_URL={database_url}\n".encode("utf-8"), 0o400)
    try:
        identities: dict[str, str] = {}
        for runner in runners:
            _required_success(
                core,
                [
                    DOCKER, "create", "--name", runner,
                    "--label", f"yoko.activation.profile={PROFILE_ID}",
                    "--label", f"yoko.activation.runner={runner}",
                    "--network", profile["production"]["network"],
                    "--entrypoint", "/app/node_modules/.bin/prisma",
                    "--env-file", MIGRATION_ENV,
                    image_id, *_production_runner_command(runner),
                ],
                timeout=60,
                code="PRODUCTION_RUNNER_PREPARE_FAILED",
            )
            raw, identity = _production_runner_observation(core, runner)
            config = raw["Config"]
            host_config = raw["HostConfig"]
            database_urls = [
                item.split("=", 1)[1]
                for item in config.get("Env") or []
                if isinstance(item, str) and item.startswith("DATABASE_URL=")
            ]
            if (
                raw.get("Image") != image_id
                or config.get("Image") != image_id
                or host_config.get("NetworkMode") != profile["production"]["network"]
                or database_urls != [database_url]
            ):
                raise core.RuntimeFault("PRODUCTION_RUNNER_IDENTITY_INVALID", 74)
            identities[runner] = identity
        return identities
    except Exception:
        for runner in runners:
            _cleanup_runner(core, runner)
        raise
    finally:
        core.mapped(MIGRATION_ENV).unlink(missing_ok=True)


def _quiesce_production_runners(core: Any, identities: dict[str, str]) -> None:
    if set(identities) != {PRODUCTION_MIGRATION_RUNNER, PRODUCTION_RESOLVE_RUNNER} or any(
        not SHA256.fullmatch(str(value)) for value in identities.values()
    ):
        raise core.RuntimeFault("PRODUCTION_RUNNER_STATE_INVALID", 74)
    for runner in (PRODUCTION_MIGRATION_RUNNER, PRODUCTION_RESOLVE_RUNNER):
        raw, identity = _production_runner_observation(core, runner)
        if identity != identities[runner]:
            raise core.RuntimeFault("PRODUCTION_RUNNER_IDENTITY_DRIFT", 74)
        if bool((raw.get("State") or {}).get("Running")):
            _required_success(core, [DOCKER, "kill", runner], timeout=60, code="PRODUCTION_RUNNER_KILL_FAILED")
        stopped, stopped_identity = _production_runner_observation(core, runner)
        if stopped_identity != identities[runner] or bool((stopped.get("State") or {}).get("Running")):
            raise core.RuntimeFault("PRODUCTION_RUNNER_QUIESCE_FAILED", 74)


def _start_prepared_production_runner(core: Any, profile: dict[str, Any], runner: str, identity: str, *, code: str) -> None:
    raw, observed = _production_runner_observation(core, runner)
    if observed != identity or bool((raw.get("State") or {}).get("Running")):
        raise core.RuntimeFault("PRODUCTION_RUNNER_IDENTITY_DRIFT", 74)
    log, fd = _root_log(core, code.lower() + ".log")
    try:
        _required_success(
            core,
            [DOCKER, "start", "--attach", runner],
            timeout=int(profile["limits"]["database_timeout_seconds"]),
            code=code,
            stdout_fd=fd,
            stderr_fd=fd,
        )
        os.fsync(fd)
    finally:
        os.close(fd)
        os.chmod(log, 0o600)
    finished, finished_identity = _production_runner_observation(core, runner)
    state = finished.get("State") or {}
    if finished_identity != identity or bool(state.get("Running")) or state.get("ExitCode") != 0:
        raise core.RuntimeFault(code, 74)


def _retire_production_runners(core: Any, identities: dict[str, str]) -> None:
    if set(identities) != {PRODUCTION_MIGRATION_RUNNER, PRODUCTION_RESOLVE_RUNNER} or any(
        not SHA256.fullmatch(str(value)) for value in identities.values()
    ):
        raise core.RuntimeFault("PRODUCTION_RUNNER_STATE_INVALID", 74)
    for runner in (PRODUCTION_MIGRATION_RUNNER, PRODUCTION_RESOLVE_RUNNER):
        completed = _run(core, [DOCKER, "container", "inspect", runner], timeout=30)
        if completed.returncode != 0:
            _docker_inspect_absent(core, completed, "container", runner, code="PRODUCTION_RUNNER_INSPECT_FAILED")
            continue
        raw, identity = _production_runner_observation(core, runner)
        if identity != identities.get(runner) or bool((raw.get("State") or {}).get("Running")):
            raise core.RuntimeFault("PRODUCTION_RUNNER_IDENTITY_DRIFT", 74)
        _required_success(core, [DOCKER, "rm", runner], timeout=60, code="PRODUCTION_RUNNER_RETIRE_FAILED")


def _run_candidate_migration(core: Any, profile: dict[str, Any], image_id: str, database_url: str, network: str, runner: str, *, code: str) -> None:
    if runner not in {PREVIEW_MIGRATION_RUNNER, ROLLBACK_PROOF_RUNNER}:
        raise core.RuntimeFault("MIGRATION_RUNNER_INVALID", 78)
    _cleanup_runner(core, runner)
    _write_fixed_file(core, MIGRATION_ENV, f"DATABASE_URL={database_url}\n".encode("utf-8"), 0o400)
    log, fd = _root_log(core, code.lower() + ".log")
    try:
        _required_success(
            core,
            [DOCKER, "run", "--name", runner, "--label", f"yoko.activation.profile={PROFILE_ID}", "--label", f"yoko.activation.runner={runner}", "--network", network, "--entrypoint", "/app/node_modules/.bin/prisma", "--env-file", MIGRATION_ENV, image_id, "migrate", "deploy"],
            timeout=int(profile["limits"]["database_timeout_seconds"]),
            code=code,
            stdout_fd=fd,
            stderr_fd=fd,
        )
        os.fsync(fd)
    finally:
        os.close(fd)
        os.chmod(log, 0o600)
        core.mapped(MIGRATION_ENV).unlink(missing_ok=True)
        _cleanup_runner(core, runner)


def _resolve_interrupted_target(core: Any, profile: dict[str, Any], identities: dict[str, str]) -> None:
    _start_prepared_production_runner(
        core,
        profile,
        PRODUCTION_RESOLVE_RUNNER,
        identities[PRODUCTION_RESOLVE_RUNNER],
        code="PRODUCTION_MIGRATION_RESOLVE_FAILED",
    )


def _repair_interrupted_outbox_migration(core: Any, profile: dict[str, Any], identity: dict[str, Any], runner_identities: dict[str, str]) -> dict[str, Any]:
    observation = _migration_ledger_observation(core, identity, profile)
    shape = _accepted_production_ledger_shape(observation, profile)
    catalog = _outbox_catalog(core, identity)
    if not shape["baseline_exact"] or not shape["chronology_exact"] or not shape["target_absent"] or observation["interrupted_target"] != 1:
        raise core.RuntimeFault("PRODUCTION_MIGRATION_REPAIR_NOT_ADMISSIBLE", 74)
    if catalog["columns"]:
        raw_count = _psql(
            core,
            identity,
            "SELECT count(*)::text FROM public.domain_outbox_events;",
            code="PRODUCTION_MIGRATION_REPAIR_COUNT_FAILED",
        )
        try:
            row_count = int(raw_count.decode("ascii").strip())
        except (UnicodeError, ValueError) as exc:
            raise core.RuntimeFault("PRODUCTION_MIGRATION_REPAIR_COUNT_FAILED", 74) from exc
        if row_count != 0:
            raise core.RuntimeFault("PRODUCTION_MIGRATION_REPAIR_DATA_PRESENT", 74)
    # The pre-migration gate proved both objects absent. These fixed names are
    # the complete additive footprint of the one accepted migration. DROP has
    # no CASCADE: unexpected dependencies fail closed instead of widening.
    _psql(
        core,
        identity,
        'DROP TABLE IF EXISTS public.domain_outbox_events; DROP TYPE IF EXISTS public."DomainOutboxStatus";',
        code="PRODUCTION_MIGRATION_PARTIAL_CLEANUP_FAILED",
    )
    if _outbox_catalog(core, identity)["state"] != "ABSENT":
        raise core.RuntimeFault("PRODUCTION_MIGRATION_PARTIAL_CLEANUP_FAILED", 74)
    resolve_fault: Exception | None = None
    try:
        _resolve_interrupted_target(core, profile, runner_identities)
    except Exception as exc:
        resolve_fault = exc
    _quiesce_production_runners(core, runner_identities)
    repaired = _migration_ledger_observation(core, identity, profile)
    repaired_shape = _accepted_production_ledger_shape(repaired, profile)
    if resolve_fault is not None and (
        not repaired_shape["baseline_exact"]
        or not repaired_shape["chronology_exact"]
        or not repaired_shape["target_absent"]
        or repaired["interrupted_target"] != 0
        or repaired["rolled_back_target"] < 1
    ):
        raise resolve_fault
    if not repaired_shape["baseline_exact"] or not repaired_shape["chronology_exact"] or not repaired_shape["target_absent"] or repaired["interrupted_target"] != 0 or repaired["rolled_back_target"] < 1:
        raise core.RuntimeFault("PRODUCTION_MIGRATION_RESOLVE_POSTCHECK_FAILED", 74)
    return {
        "partial_objects_removed": True,
        "failed_target_marked_rolled_back": True,
        "rolled_back_target_migrations": repaired["rolled_back_target"],
    }


def _verify_preview_after_migration(core: Any, profile: dict[str, Any], preview: dict[str, Any]) -> dict[str, Any]:
    identity = _postgres_identity(core, profile, PREVIEW_CONTAINER)
    observation = _migration_ledger_observation(core, identity, profile)
    shape = _accepted_production_ledger_shape(observation, profile)
    catalog = _outbox_catalog(core, identity)
    if not shape["baseline_exact"] or not shape["target_active"] or not shape["chronology_exact"] or observation["interrupted_target"] or catalog["state"] != "EXACT":
        raise core.RuntimeFault("PREVIEW_MIGRATION_POSTCHECK_FAILED", 74)
    return {"migration_ledger_sha256": _digest(observation), "outbox_catalog_sha256": _digest(catalog)}


def _prove_old_image_compatibility(core: Any, profile: dict[str, Any], preview: dict[str, Any]) -> None:
    url = _database_url(preview["user"], preview["password"], PREVIEW_CONTAINER, preview["database"])
    _run_candidate_migration(
        core, profile, profile["production"]["gravity_image_id"], url,
        PREVIEW_NETWORK, ROLLBACK_PROOF_RUNNER,
        code="ROLLBACK_IMAGE_SCHEMA_COMPATIBILITY_FAILED",
    )


def _database_migrate(core: Any, profile: dict[str, Any], invocation: Any) -> dict[str, Any]:
    with _lock(core):
        state = _read_state(core)
        _reconcile_terminal_audit(core, state)
        if state.get("phase") == "DATABASE_RUNNER_RETIRE_INTENT":
            identities = state.get("production_runner_identities")
            final_state = state.get("runner_retire_final_state")
            retained = {
                key: value
                for key, value in state.items()
                if key not in {
                    "phase", "production_runner_identities", "runner_retire_final_state",
                    "migration_ledger_sha256",
                }
            }
            expected_final_keys = set(retained) | {"phase", "migration_ledger_sha256"}
            if final_state.get("phase") == "MIGRATED":
                expected_final_keys.add("migration_completed_at")
            if (
                not isinstance(identities, dict)
                or not isinstance(final_state, dict)
                or final_state.get("phase") not in {"MIGRATED", "ACTIVATED", "ROLLED_BACK"}
                or final_state.get("schema") != STATE_SCHEMA
                or final_state.get("profile_id") != PROFILE_ID
                or set(final_state) != expected_final_keys
                or any(final_state.get(key) != value for key, value in retained.items())
                or not SHA256.fullmatch(str(final_state.get("migration_ledger_sha256", "")))
                or (
                    final_state.get("phase") == "MIGRATED"
                    and (
                        not isinstance(final_state.get("migration_completed_at"), str)
                        or not final_state["migration_completed_at"]
                    )
                )
                or "production_runner_identities" in final_state
                or "runner_retire_final_state" in final_state
            ):
                raise core.RuntimeFault("PRODUCTION_RUNNER_RETIRE_STATE_INVALID", 78)
            _retire_production_runners(core, identities)
            retire_status, _ = _database_status(core, profile)
            if (
                retire_status["migration_state"] != "APPROVED_OUTBOX_APPLIED"
                or retire_status["migration_ledger_sha256"] != final_state["migration_ledger_sha256"]
            ):
                raise core.RuntimeFault("PRODUCTION_RUNNER_RETIRE_POSTCHECK_FAILED", 74)
            state = _write_terminal_state(core, invocation, state, "runner_retire_recovered_ok", final_state)
        if state.get("phase") in {"MIGRATED", "ACTIVATED", "ROLLED_BACK"}:
            if state.get("production_runner_identities") is not None:
                cleaned = {key: value for key, value in state.items() if key != "production_runner_identities"}
                cleanup_intent = {
                    **state,
                    "phase": "DATABASE_RUNNER_RETIRE_INTENT",
                    "runner_retire_final_state": cleaned,
                }
                cleanup_intent = _write_terminal_state(core, invocation, state, "runner_cleanup_intent", cleanup_intent)
                _retire_production_runners(core, state["production_runner_identities"])
                cleanup_status, _ = _database_status(core, profile)
                if (
                    cleanup_status["migration_state"] != "APPROVED_OUTBOX_APPLIED"
                    or cleanup_status["migration_ledger_sha256"] != cleaned["migration_ledger_sha256"]
                ):
                    raise core.RuntimeFault("PRODUCTION_RUNNER_RETIRE_POSTCHECK_FAILED", 74)
                state = _write_terminal_state(core, invocation, cleanup_intent, "runner_cleanup_ok", cleaned)
            status, recovery_identity = _database_status(core, profile)
            if (
                status["migration_state"] != "APPROVED_OUTBOX_APPLIED"
                or status["database_identity_sha256"] != state.get("database_identity_sha256")
                or status["migration_ledger_sha256"] != state.get("migration_ledger_sha256")
            ):
                raise core.RuntimeFault("MIGRATED_STATE_IDENTITY_DRIFT", 74)
            if state.get("backup_sha256") is not None:
                _verify_recovery_backup(core, profile, state)
            return {"profile_id": PROFILE_ID, "status": "ALREADY_MIGRATED", "database": status, "production_database_mutated": False}
        if state.get("phase") == "DATABASE_PRODUCTION_INTENT":
            if core.audit_status()["state"] not in {"EMPTY", "VALID"}:
                raise core.RuntimeFault("AUDIT_MUTATION_DISABLED", 78)
            runner_identities = state.get("production_runner_identities")
            if not isinstance(runner_identities, dict):
                raise core.RuntimeFault("PRODUCTION_RUNNER_STATE_INVALID", 74)
            # Both fixed containers were created and identity-sealed before the
            # durable intent. Recovery only stops/restarts those same objects;
            # it never opens an inspect-to-create race before reconciliation.
            _quiesce_production_runners(core, runner_identities)
            verified_backup = _verify_recovery_backup(core, profile, state)
            if (
                state.get("target_image_id") != _verify_gravity_candidate_image(core, profile).get("Id")
                or not state.get("restore_verified")
                or not state.get("rollback_image_schema_compatible")
            ):
                raise core.RuntimeFault("DATABASE_RECOVERY_PRECONDITION_DRIFT", 74)
            status, recovery_identity = _database_status(core, profile)
            if status["database_identity_sha256"] != state.get("database_identity_sha256"):
                raise core.RuntimeFault("DATABASE_RECOVERY_PRECONDITION_DRIFT", 74)
            production_mutated = False
            interruption_repair = None
            if status["migration_state"] == "APPROVED_OUTBOX_INTERRUPTED":
                recovery_intent = {**state, "phase": "DATABASE_PRODUCTION_RECOVERY_INTENT"}
                _audit(core, invocation, state, "repair_intent", recovery_intent)
                try:
                    interruption_repair = _repair_interrupted_outbox_migration(
                        core, profile, recovery_identity, runner_identities
                    )
                except Exception:
                    _audit(core, invocation, recovery_intent, "repair_failed", _read_state(core))
                    raise
                production_mutated = True
                status, recovery_identity = _database_status(core, profile)
                if status["migration_state"] != "ONLY_APPROVED_OUTBOX_PENDING":
                    _audit(core, invocation, recovery_intent, "repair_failed", _read_state(core))
                    raise core.RuntimeFault("DATABASE_RECOVERY_REPAIR_POSTCHECK_FAILED", 74)
                _audit(core, invocation, recovery_intent, "repair_ok", {**state, "interruption_repair": interruption_repair})
            if status["migration_state"] == "ONLY_APPROVED_OUTBOX_PENDING":
                recovery_intent = {**state, "phase": "DATABASE_PRODUCTION_RECOVERY_INTENT"}
                _audit(core, invocation, state, "intent", recovery_intent)
                migration_fault: Exception | None = None
                try:
                    _start_prepared_production_runner(
                        core,
                        profile,
                        PRODUCTION_MIGRATION_RUNNER,
                        runner_identities[PRODUCTION_MIGRATION_RUNNER],
                        code="PRODUCTION_MIGRATION_FAILED",
                    )
                    production_mutated = True
                except Exception as exc:
                    migration_fault = exc
                _quiesce_production_runners(core, runner_identities)
                status, _ = _database_status(core, profile)
                if status["migration_state"] != "APPROVED_OUTBOX_APPLIED" and migration_fault is not None:
                    _audit(core, invocation, recovery_intent, "failed", _read_state(core))
                    raise migration_fault
            if status["migration_state"] != "APPROVED_OUTBOX_APPLIED":
                raise core.RuntimeFault("DATABASE_RECOVERY_POSTCHECK_FAILED", 74)
            next_state = {**state, "phase": "MIGRATED", "migration_ledger_sha256": status["migration_ledger_sha256"], "migration_completed_at": core.now()}
            next_state.pop("production_runner_identities", None)
            retire_intent = {
                **state,
                "phase": "DATABASE_RUNNER_RETIRE_INTENT",
                "runner_retire_final_state": next_state,
            }
            retire_intent = _write_terminal_state(core, invocation, state, "runner_retire_intent", retire_intent)
            _retire_production_runners(core, runner_identities)
            next_state = _write_terminal_state(core, invocation, retire_intent, "recovered_ok", next_state)
            return {
                "profile_id": PROFILE_ID,
                "status": "MIGRATED_RECOVERED",
                "backup": verified_backup,
                "restore_verified": True,
                "preview": state["preview_proof"],
                "rollback_image_schema_compatible": True,
                "database": status,
                "storage": state["storage_guard"],
                "interruption_repair": interruption_repair,
                "production_database_mutated": production_mutated,
                "schema_rollback_policy": "KEEP_EXPAND_ONLY_OBJECTS",
            }
        if state.get("phase") != "PREFLIGHT_READY":
            raise core.RuntimeFault("PREFLIGHT_REQUIRED", 77)
        if core.audit_status()["state"] not in {"EMPTY", "VALID"}:
            raise core.RuntimeFault("AUDIT_MUTATION_DISABLED", 78)
        status, identity = _database_status(core, profile)
        if (
            status["migration_state"] != "ONLY_APPROVED_OUTBOX_PENDING"
            or status["database_identity_sha256"] != state.get("database_identity_sha256")
            or state.get("target_image_id") != _verify_gravity_candidate_image(core, profile).get("Id")
        ):
            raise core.RuntimeFault("DATABASE_PRECONDITION_DRIFT", 74)
        database_bytes = _database_size(core, identity)
        limits = profile["limits"]
        if database_bytes > int(limits["maximum_database_bytes"]):
            raise core.RuntimeFault("DATABASE_SIZE_LIMIT_EXCEEDED", 74)
        required = database_bytes * int(limits["database_working_multiplier"]) + int(limits["database_working_overhead_bytes"])
        storage = _storage_guard(core, profile, required)
        intent = {**state, "phase": "DATABASE_MIGRATION_INTENT"}
        _audit(core, invocation, state, "intent", intent)
        preview: dict[str, Any] | None = None
        production_mutation_started = False
        try:
            backup = _create_backup(core, profile, identity)
            preview = _start_preview(core, profile)
            _restore_preview(core, profile, preview)
            preview_before = _postgres_identity(core, profile, PREVIEW_CONTAINER)
            preview_observation = _migration_ledger_observation(core, preview_before, profile)
            preview_shape = _accepted_production_ledger_shape(preview_observation, profile)
            if not preview_shape["baseline_exact"] or not preview_shape["chronology_exact"] or not preview_shape["target_absent"] or preview_observation["interrupted_target"]:
                raise core.RuntimeFault("PREVIEW_LEDGER_MISMATCH", 74)
            if _outbox_catalog(core, preview_before)["state"] != "ABSENT":
                raise core.RuntimeFault("PREVIEW_OUTBOX_PARTIAL", 74)
            preview_url = _database_url(preview["user"], preview["password"], PREVIEW_CONTAINER, preview["database"])
            preview_fault: Exception | None = None
            try:
                _run_candidate_migration(core, profile, state["target_image_id"], preview_url, PREVIEW_NETWORK, PREVIEW_MIGRATION_RUNNER, code="PREVIEW_MIGRATION_FAILED")
            except Exception as exc:
                preview_fault = exc
            preview_proof = _verify_preview_after_migration(core, profile, preview)
            if preview_fault is not None:
                preview_proof["runner_exit_reconciled_by_exact_poststate"] = True
            _prove_old_image_compatibility(core, profile, preview)
            _cleanup_preview(core)
            preview = None
            repeat_status, _ = _database_status(core, profile)
            if repeat_status["migration_state"] != "ONLY_APPROVED_OUTBOX_PENDING" or repeat_status["database_identity_sha256"] != state["database_identity_sha256"]:
                raise core.RuntimeFault("PRODUCTION_DATABASE_CHANGED_DURING_PREVIEW", 74)
            production_database_url = _production_database_url(core, profile, identity)
            production_runner_identities = _prepare_production_runners(
                core,
                profile,
                state["target_image_id"],
                production_database_url,
            )
            prepared_state = {
                **state,
                "phase": "DATABASE_PRODUCTION_INTENT",
                "backup_sha256": backup["sha256"],
                "backup_bytes": backup["bytes"],
                "restore_verified": True,
                "preview_proof": preview_proof,
                "rollback_image_schema_compatible": True,
                "storage_guard": storage,
                "production_runner_identities": production_runner_identities,
            }
            _write_state(core, prepared_state)
            production_mutation_started = True
            production_fault: Exception | None = None
            try:
                _start_prepared_production_runner(
                    core,
                    profile,
                    PRODUCTION_MIGRATION_RUNNER,
                    production_runner_identities[PRODUCTION_MIGRATION_RUNNER],
                    code="PRODUCTION_MIGRATION_FAILED",
                )
            except Exception as exc:
                production_fault = exc
            _quiesce_production_runners(core, production_runner_identities)
            after, _ = _database_status(core, profile)
            if after["migration_state"] != "APPROVED_OUTBOX_APPLIED":
                if production_fault is not None:
                    raise production_fault
                raise core.RuntimeFault("PRODUCTION_MIGRATION_POSTCHECK_FAILED", 74)
            next_state = {
                **prepared_state,
                "phase": "MIGRATED",
                "backup_sha256": backup["sha256"],
                "backup_bytes": backup["bytes"],
                "restore_verified": True,
                "preview_proof": preview_proof,
                "rollback_image_schema_compatible": True,
                "migration_ledger_sha256": after["migration_ledger_sha256"],
                "migration_completed_at": core.now(),
            }
            next_state.pop("production_runner_identities", None)
            retire_intent = {
                **prepared_state,
                "phase": "DATABASE_RUNNER_RETIRE_INTENT",
                "runner_retire_final_state": next_state,
            }
            retire_intent = _write_terminal_state(core, invocation, prepared_state, "runner_retire_intent", retire_intent)
            _retire_production_runners(core, production_runner_identities)
            next_state = _write_terminal_state(core, invocation, retire_intent, "ok", next_state)
        except Exception:
            if preview is not None:
                _cleanup_preview(core)
            failure = {**_read_state(core), "production_mutation_started": production_mutation_started}
            _audit(core, invocation, intent, "failed", failure)
            raise
        return {
            "profile_id": PROFILE_ID,
            "status": "MIGRATED",
            "backup": backup,
            "restore_verified": True,
            "preview": preview_proof,
            "rollback_image_schema_compatible": True,
            "database": after,
            "storage": storage,
            "production_database_mutated": True,
            "schema_rollback_policy": "KEEP_EXPAND_ONLY_OBJECTS",
        }


def _write_fixed_file(core: Any, path: str, raw: bytes, mode: int) -> None:
    target = core.mapped(path)
    temporary = core.mapped(path + ".new")
    temporary.unlink(missing_ok=True)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, mode)
    try:
        os.write(fd, raw)
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, target)


def _compose_overlay(gravity_image: str, tg_image: str, *, activate: bool) -> bytes:
    if any(not re.fullmatch(r"[a-z0-9][a-z0-9./:_-]+", image) or ".." in image or "//" in image for image in (gravity_image, tg_image)):
        raise RuntimeError("IMAGE_REFERENCE_INVALID")
    return (
        "services:\n"
        "  gravity-mvp:\n"
        f"    image: {gravity_image}\n"
        "    command: [\"npm\", \"run\", \"start\"]\n"
        "  tg-bot:\n"
        f"    image: {tg_image}\n"
    ).encode("ascii")


def _validate_production_compose_inputs(core: Any, profile: dict[str, Any], state: dict[str, Any]) -> None:
    production = profile["production"]
    compose = _secure_host_file(core, production["compose_path"], 0o644, 4 * 1024 * 1024)
    environment = _secure_host_file(core, production["environment_path"], 0o600, 4 * 1024 * 1024)
    production_identity = state.get("production_identity")
    if (
        _sha_file(compose, 4 * 1024 * 1024) != production["compose_sha256"]
        or not isinstance(production_identity, dict)
        or not SHA256.fullmatch(str(production_identity.get("environment_sha256", "")))
        or _sha_file(environment, 4 * 1024 * 1024) != production_identity["environment_sha256"]
    ):
        raise core.RuntimeFault("PRODUCTION_COMPOSE_INPUT_IDENTITY_DRIFT", 74)


def _compose_up(core: Any, profile: dict[str, Any], state: dict[str, Any], overlay: str) -> None:
    _validate_production_compose_inputs(core, profile, state)
    production = profile["production"]
    args = [
        DOCKER, "compose",
        "--project-directory", "/opt/crm/deploy",
        "--env-file", production["environment_path"],
        "-f", production["compose_path"],
        "-f", overlay,
    ]
    _validate_dual_compose_projection(core, profile, args, overlay == ACTIVATE_OVERLAY)
    _validate_production_compose_inputs(core, profile, state)
    log, fd = _root_log(core, "compose-activation.log")
    try:
        _required_success(
            core,
            [*args, "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "--wait", "--wait-timeout", "180", production["compose_service"], production["tg_bot_compose_service"]],
            timeout=int(profile["limits"]["activation_timeout_seconds"]),
            code="DUAL_SERVICE_COMPOSE_ACTIVATION_FAILED",
            stdout_fd=fd,
            stderr_fd=fd,
        )
        os.fsync(fd)
    finally:
        os.close(fd)
        os.chmod(log, 0o600)


def _compose_config_json(core: Any, args: list[str]) -> dict[str, Any]:
    completed = _required_success(core, [*args, "config", "--format", "json"], timeout=60, code="ACTIVATION_COMPOSE_CONFIG_INVALID")
    try:
        value = json.loads(completed.stdout)
    except (UnicodeError, ValueError) as exc:
        raise core.RuntimeFault("ACTIVATION_COMPOSE_CONFIG_INVALID", 74) from exc
    if not isinstance(value, dict) or not isinstance(value.get("services"), dict):
        raise core.RuntimeFault("ACTIVATION_COMPOSE_CONFIG_INVALID", 74)
    return value


def _validate_dual_compose_projection(core: Any, profile: dict[str, Any], overlay_args: list[str], activate: bool) -> None:
    production = profile["production"]
    base_args = overlay_args[:-2]
    base = _compose_config_json(core, base_args)
    candidate = _compose_config_json(core, overlay_args)
    gravity_name = production["compose_service"]
    tg_name = production["tg_bot_compose_service"]
    if gravity_name != "gravity-mvp" or tg_name != "tg-bot" or set(base["services"]) != set(candidate["services"]):
        raise core.RuntimeFault("DUAL_SERVICE_COMPOSE_PROJECTION_DRIFT", 74)
    base_other = {key: value for key, value in base["services"].items() if key not in {gravity_name, tg_name}}
    candidate_other = {key: value for key, value in candidate["services"].items() if key not in {gravity_name, tg_name}}
    if _canonical(base_other) != _canonical(candidate_other):
        raise core.RuntimeFault("UNRELATED_COMPOSE_SERVICE_DRIFT", 74)
    expected_images = {
        gravity_name: TARGET_TAG if activate else PRIOR_TARGET_TAG,
        tg_name: TG_TARGET_TAG if activate else TG_PREDECESSOR_REFERENCE,
    }
    for name in (gravity_name, tg_name):
        original = dict(base["services"][name])
        actual = dict(candidate["services"][name])
        if actual.get("image") != expected_images[name]:
            raise core.RuntimeFault("DUAL_SERVICE_COMPOSE_IMAGE_DRIFT", 74)
        actual["image"] = original.get("image")
        if name == gravity_name:
            if actual.get("command") != ["npm", "run", "start"]:
                raise core.RuntimeFault("DUAL_SERVICE_COMPOSE_COMMAND_DRIFT", 74)
            if "command" in original:
                actual["command"] = original["command"]
            else:
                actual.pop("command", None)
        if _canonical(actual) != _canonical(original):
            raise core.RuntimeFault("DUAL_SERVICE_COMPOSE_PROJECTION_DRIFT", 74)


def _verify_predecessor_compose_references(core: Any, profile: dict[str, Any]) -> None:
    gravity = _image_inspect(core, PRIOR_TARGET_TAG)
    tg_bot = _image_inspect(core, TG_PREDECESSOR_REFERENCE)
    if gravity is None or gravity.get("Id") != profile["production"]["gravity_image_id"]:
        raise core.RuntimeFault("GRAVITY_PREDECESSOR_REFERENCE_IDENTITY_DRIFT", 74)
    if tg_bot is None or tg_bot.get("Id") != profile["production"]["tg_bot_image_id"]:
        raise core.RuntimeFault("TG_BOT_PREDECESSOR_REFERENCE_IDENTITY_DRIFT", 74)


def _preserved_service_semantics(semantic: dict[str, Any]) -> dict[str, Any]:
    keys = {
        "entrypoint", "environment_names", "mounts", "name", "network_mode", "network_names",
        "privileged", "published_ports", "read_only_rootfs", "restart_policy",
    }
    return {key: semantic.get(key) for key in sorted(keys)}


def _preserved_gravity_semantics(semantic: dict[str, Any]) -> dict[str, Any]:
    return _preserved_service_semantics(semantic)


def _rollback_semantics_compatibility(
    profile: dict[str, Any],
    state: dict[str, Any],
    gravity: dict[str, Any],
) -> str | None:
    """Accept only the exact predecessor runtime semantics captured by v8."""
    original = state.get("production_identity", {}).get("gravity_semantic")
    current = gravity.get("semantic")
    if (
        not isinstance(original, dict)
        or not isinstance(current, dict)
        or _preserved_gravity_semantics(current) != _preserved_gravity_semantics(original)
        or current.get("command") != original.get("command")
        or original.get("image_id") != profile["production"]["gravity_image_id"]
        or current.get("image_id") != profile["production"]["gravity_image_id"]
    ):
        return None

    production = profile["production"]
    recovery = profile["recovery"]
    recovered_labels = {
        "com.docker.compose.config-hash": recovery["recovered_compose_config_hash"],
        "com.docker.compose.project": production["compose_project"],
        "com.docker.compose.service": production["compose_service"],
    }
    original_labels = original.get("compose_labels")
    current_labels = current.get("compose_labels")
    if original_labels == recovered_labels and current_labels == recovered_labels:
        return "EXACT"
    return None


def _rollback_tg_semantics_compatibility(
    profile: dict[str, Any],
    state: dict[str, Any],
    tg_bot: dict[str, Any],
) -> str | None:
    original = state.get("production_identity", {}).get("tg_bot_semantic")
    current = tg_bot.get("semantic")
    if (
        not isinstance(original, dict)
        or not isinstance(current, dict)
        or _preserved_service_semantics(current) != _preserved_service_semantics(original)
        or current.get("command") != original.get("command")
        or original.get("image_id") != profile["production"]["tg_bot_image_id"]
        or current.get("image_id") != profile["production"]["tg_bot_image_id"]
        or tg_bot.get("entrypoint") != profile["production"]["tg_bot_entrypoint"]
        or tg_bot.get("cmd") != profile["production"]["tg_bot_cmd"]
        or tg_bot.get("declared_user") != profile["production"]["tg_bot_declared_user"]
        or tg_bot.get("working_dir") != profile["production"]["tg_bot_working_dir"]
    ):
        return None
    production = profile["production"]
    recovered_labels = {
        "com.docker.compose.config-hash": profile["recovery"]["recovered_tg_bot_compose_config_hash"],
        "com.docker.compose.project": production["compose_project"],
        "com.docker.compose.service": production["tg_bot_compose_service"],
    }
    if original.get("compose_labels") == recovered_labels and current.get("compose_labels") == recovered_labels:
        return "EXACT"
    return None


def _transport_health_probe_script(origin: str = "http://127.0.0.1:3002") -> str:
    """Return a bounded, body-silent proof of the sealed 1-WA/1-TG inventory."""
    return (
        "const h=require('http');const o=" + json.dumps(origin) + ";let done=false;"
        "const end=c=>{if(done)return;done=true;process.exit(c)};"
        "const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===k;"
        "const iso=v=>typeof v==='string'&&!Number.isNaN(Date.parse(v))&&new Date(v).toISOString()===v;"
        "const q=h.get(o+'/api/transport/health',r=>{let b='',n=0;r.setEncoding('utf8');"
        "r.on('data',c=>{n+=Buffer.byteLength(c);if(n>1048576){r.destroy();end(7);return}b+=c});"
        "r.on('end',()=>{if(done)return;if(r.statusCode!==200){end(2);return}"
        "if(!String(r.headers['content-type']||'').toLowerCase().startsWith('application/json')){end(5);return}"
        "try{const v=JSON.parse(b);if(!exact(v,'telegram,timestamp,whatsapp')||!iso(v.timestamp)){end(5);return}"
        "const expected={whatsapp:1,telegram:1},ids=new Set();"
        "for(const channel of ['whatsapp','telegram']){const bucket=v[channel];"
        "if(!exact(bucket,'connections')||!Array.isArray(bucket.connections)||bucket.connections.length!==expected[channel]){end(5);return}"
        "for(const e of bucket.connections){"
        "if(!exact(e,'channel,id,instanceId,lastError,lastSeen,reconnectInFlight,retryAttempt,state,uptimeMs')"
        "||typeof e.id!=='string'||e.id.length<1||e.id.length>200||ids.has(e.id)||e.channel!==channel"
        "||typeof e.instanceId!=='string'||!/^[0-9a-f]{8}$/.test(e.instanceId)||!iso(e.lastSeen)"
        "||!Number.isInteger(e.uptimeMs)||e.uptimeMs<0){end(5);return}"
        "ids.add(e.id);if(e.state!=='ready'||e.lastError!==null||e.retryAttempt!==0||e.reconnectInFlight!==false){end(6);return}"
        "}}end(0)}catch{end(4)}})});"
        "q.setTimeout(10000,()=>{q.destroy();end(3)});q.on('error',()=>end(3));"
    )


def _messages_route_contract_probe_script(origin: str = "http://127.0.0.1:3002") -> str:
    """Return a bounded read-only probe for the protected missing-chatId route."""
    return (
        "const h=require('http');const o=" + json.dumps(origin) + ";let done=false;"
        "const end=c=>{if(done)return;done=true;process.exit(c)};"
        "const q=h.get(o+'/api/messages',r=>{let b='',n=0;r.setEncoding('utf8');"
        "r.on('data',c=>{n+=Buffer.byteLength(c);if(n>1048576){r.destroy();end(7);return}b+=c});"
        "r.on('end',()=>{if(done)return;if(r.statusCode!==400){end(2);return}"
        "if(!String(r.headers['content-type']||'').toLowerCase().startsWith('application/json')){end(5);return}"
        "try{const v=JSON.parse(b);end(v&&typeof v==='object'&&!Array.isArray(v)"
        "&&Object.keys(v).length===1&&v.error==='chatId is required'?0:5)}catch{end(4)}})});"
        "q.setTimeout(10000,()=>{q.destroy();end(3)});q.on('error',()=>end(3));"
    )


def _protected_messages_health_probe_script(origin: str = "http://127.0.0.1:3002") -> str:
    """Return a bounded proof that protected delivery/retry/integrity state is clean."""
    return (
        "const h=require('http');const o=" + json.dumps(origin) + ";let done=false;"
        "const end=c=>{if(done)return;done=true;process.exit(c)};"
        "const own=(v,k)=>Object.prototype.hasOwnProperty.call(v,k);"
        "const q=h.get(o+'/api/health',"
        "r=>{let b='',n=0;r.setEncoding('utf8');r.on('data',c=>{n+=Buffer.byteLength(c);"
        "if(n>1048576){r.destroy();end(7);return}b+=c});"
        "r.on('end',()=>{if(done)return;if(r.statusCode!==200){end(2);return}"
        "if(!String(r.headers['content-type']||'').toLowerCase().startsWith('application/json')){end(5);return}"
        "try{const v=JSON.parse(b);if(!v||v.status!=='ok'){end(2);return}"
        "const t=v.transport,p=v.pipeline,re=v.retry,rc=v.recovery,i=v.integrity,w=v.watchdog;"
        "const clean=!own(v,'degradedReasons')&&t&&t.degradedConnections===0"
        "&&t.whatsapp&&t.whatsapp.readyCount===1&&t.whatsapp.totalCount===1"
        "&&Array.isArray(t.whatsapp.connections)&&t.whatsapp.connections.length===1"
        "&&t.telegram&&t.telegram.readyCount===1&&t.telegram.totalCount===1"
        "&&Array.isArray(t.telegram.connections)&&t.telegram.connections.length===1"
        "&&p&&p.failedLast24h===0&&p.stuckCount===0"
        "&&re&&re.pendingRetryable===0&&re.lastError===null"
        "&&rc&&rc.lastError===null&&i&&Array.isArray(i.issues)&&i.issues.length===0"
        "&&w&&w.unhealthyCount===0;end(clean?0:5)}catch{end(4)}})});"
        "q.setTimeout(10000,()=>{q.destroy();end(3)});q.on('error',()=>end(3));"
    )


def _application_health_once(core: Any, profile: dict[str, Any], *, require_outbox: bool) -> dict[str, Any]:
    container = profile["production"]["gravity_container"]
    script = _protected_messages_health_probe_script()
    completed = _run(core, [DOCKER, "exec", container, "node", "-e", script], timeout=15)
    if completed.returncode != 0:
        code = {
            2: "GRAVITY_APPLICATION_STATUS_NOT_OK",
            3: "GRAVITY_APPLICATION_HEALTH_UNREACHABLE",
            4: "GRAVITY_APPLICATION_HEALTH_INVALID_JSON",
            5: "PROTECTED_MESSAGES_PIPELINE_NOT_CLEAN",
            7: "GRAVITY_APPLICATION_HEALTH_RESPONSE_TOO_LARGE",
        }.get(completed.returncode, "GRAVITY_APPLICATION_HEALTH_FAILED")
        raise core.RuntimeFault(code, 74)
    infra_script = (
        "const h=require('http');const q=h.get('http://127.0.0.1:3002/api/health/infra',"
        "r=>{r.resume();r.on('end',()=>process.exit(r.statusCode===200?0:2))});"
        "q.setTimeout(10000,()=>q.destroy());q.on('error',()=>process.exit(3));"
    )
    infra = _run(core, [DOCKER, "exec", container, "node", "-e", infra_script], timeout=15)
    if infra.returncode != 0:
        code = {
            2: "GRAVITY_INFRA_STATUS_NOT_OK",
            3: "GRAVITY_INFRA_HEALTH_UNREACHABLE",
        }.get(infra.returncode, "GRAVITY_INFRA_HEALTH_FAILED")
        raise core.RuntimeFault(code, 74)
    transport = _run(
        core,
        [DOCKER, "exec", container, "node", "-e", _transport_health_probe_script()],
        timeout=15,
    )
    if transport.returncode != 0:
        code = {
            2: "PROTECTED_MESSAGES_TRANSPORT_STATUS_NOT_OK",
            3: "PROTECTED_MESSAGES_TRANSPORT_UNREACHABLE",
            4: "PROTECTED_MESSAGES_TRANSPORT_INVALID_JSON",
            5: "PROTECTED_MESSAGES_TRANSPORT_INVENTORY_MISMATCH",
            6: "PROTECTED_MESSAGES_TRANSPORT_NOT_READY",
            7: "PROTECTED_MESSAGES_TRANSPORT_RESPONSE_TOO_LARGE",
        }.get(transport.returncode, "PROTECTED_MESSAGES_TRANSPORT_PROBE_FAILED")
        raise core.RuntimeFault(code, 74)
    messages = _run(
        core,
        [DOCKER, "exec", container, "node", "-e", _messages_route_contract_probe_script()],
        timeout=15,
    )
    if messages.returncode != 0:
        code = {
            2: "PROTECTED_MESSAGES_ROUTE_STATUS_REGRESSION",
            3: "PROTECTED_MESSAGES_ROUTE_UNREACHABLE",
            4: "PROTECTED_MESSAGES_ROUTE_INVALID_JSON",
            5: "PROTECTED_MESSAGES_ROUTE_CONTRACT_REGRESSION",
            7: "PROTECTED_MESSAGES_ROUTE_RESPONSE_TOO_LARGE",
        }.get(messages.returncode, "PROTECTED_MESSAGES_ROUTE_PROBE_FAILED")
        raise core.RuntimeFault(code, 74)
    publisher_observed = False
    if require_outbox:
        logs = _required_success(core, [DOCKER, "logs", "--since", "10m", container], timeout=30, code="GRAVITY_STARTUP_LOG_UNAVAILABLE")
        combined = logs.stdout + b"\n" + logs.stderr
        if b"domain_outbox_publisher_started" not in combined or b"domain_outbox_publisher_start_failed" in combined:
            raise core.RuntimeFault("OUTBOX_PUBLISHER_STARTUP_NOT_PROVEN", 74)
        publisher_observed = True
    return {
        "application_health_reachable": True,
        "infrastructure_health_ok": True,
        "protected_messages_transport_inventory_exact": True,
        "protected_messages_transport_ready": True,
        "protected_messages_delivery_failures_absent": True,
        "protected_messages_retry_failures_absent": True,
        "protected_messages_integrity_issues_absent": True,
        "protected_messages_route_contract_exact": True,
        "outbox_publisher_startup_observed": publisher_observed,
        "response_body_emitted": False,
        "log_content_emitted": False,
    }


def _application_health(core: Any, profile: dict[str, Any], *, require_outbox: bool = True) -> dict[str, Any]:
    """Require strict health after a bounded startup stabilization window.

    Messaging transports legitimately need tens of seconds to restore their
    persisted sessions after a container recreate.  A single immediate probe
    confuses that expected startup transition with a release regression.  The
    gate remains strict: it accepts only two consecutive full successes, each
    requiring application status ``ok``, infrastructure HTTP 200, the exact
    one-WhatsApp/one-Telegram ready inventory, zero protected Messages
    delivery/retry/integrity failures, the safe missing-chatId route contract,
    and the outbox startup marker with no startup-failed marker.
    """
    started = time.monotonic()
    deadline = started + APPLICATION_STABILIZATION_SECONDS
    attempts = 0
    consecutive_successes = 0
    last_failure_code = "GRAVITY_APPLICATION_STABILIZATION_NOT_STARTED"

    def timeout_fault() -> Any:
        return core.RuntimeFault("GRAVITY_APPLICATION_STABILIZATION_FAILED", 74, {
            "attempts": attempts,
            "consecutive_successes": consecutive_successes,
            "last_failure_code": last_failure_code,
            "required_consecutive_successes": APPLICATION_STABILIZATION_REQUIRED_SUCCESSES,
            "timeout_seconds": APPLICATION_STABILIZATION_SECONDS,
        })

    while True:
        if attempts and time.monotonic() >= deadline:
            raise timeout_fault()
        attempts += 1
        try:
            evidence = _application_health_once(core, profile, require_outbox=require_outbox)
            observed_at = time.monotonic()
            if observed_at > deadline:
                last_failure_code = "GRAVITY_APPLICATION_STABILIZATION_DEADLINE_EXCEEDED"
            else:
                consecutive_successes += 1
                if consecutive_successes >= APPLICATION_STABILIZATION_REQUIRED_SUCCESSES:
                    return {
                        **evidence,
                        "stabilization_attempts": attempts,
                        "stabilization_consecutive_successes": consecutive_successes,
                        "stabilization_elapsed_ms": int((observed_at - started) * 1000),
                        "stabilization_timeout_seconds": APPLICATION_STABILIZATION_SECONDS,
                    }
                last_failure_code = "GRAVITY_APPLICATION_STABILIZATION_INCOMPLETE"
        except core.RuntimeFault as exc:
            last_failure_code = exc.code
            consecutive_successes = 0
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise timeout_fault()
        time.sleep(min(APPLICATION_STABILIZATION_INTERVAL_SECONDS, remaining))


def _rollback_application_health_once(core: Any, profile: dict[str, Any]) -> dict[str, Any]:
    """Prove the sealed predecessor is serving without applying target-only gates.

    The predecessor predates authenticated Redis infra health and the corrected
    stuck-message predicate. It may therefore truthfully report ``degraded``
    while still serving. Rollback acceptance still requires HTTP 200, valid
    JSON, and an explicit ``ok`` or ``degraded`` application status; ``down``,
    malformed responses and transport failures remain hard failures. Container,
    image, process semantics and the exact migrated database are checked by the
    surrounding rollback path.
    """
    container = profile["production"]["gravity_container"]
    script = (
        "const h=require('http');const q=h.get('http://127.0.0.1:3002/api/health',"
        "r=>{let b='';r.setEncoding('utf8');r.on('data',c=>{b+=c;if(b.length>1048576)q.destroy()});"
        "r.on('end',()=>{try{const v=JSON.parse(b);const s=v&&v.status;"
        "process.exit(r.statusCode===200&&(s==='ok'||s==='degraded')?0:2)}catch{process.exit(4)}})});"
        "q.setTimeout(10000,()=>q.destroy());q.on('error',()=>process.exit(3));"
    )
    completed = _run(core, [DOCKER, "exec", container, "node", "-e", script], timeout=15)
    if completed.returncode != 0:
        raise core.RuntimeFault("GRAVITY_ROLLBACK_APPLICATION_HEALTH_FAILED", 74)
    return {
        "rollback_application_health_compatible": True,
        "response_body_emitted": False,
        "target_only_infrastructure_gate_applied": False,
        "target_only_outbox_gate_applied": False,
    }


def _rollback_application_health(core: Any, profile: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    deadline = started + APPLICATION_STABILIZATION_SECONDS
    attempts = 0
    consecutive_successes = 0
    last_failure_code = "GRAVITY_ROLLBACK_STABILIZATION_NOT_STARTED"
    while True:
        if attempts and time.monotonic() >= deadline:
            raise core.RuntimeFault("GRAVITY_ROLLBACK_APPLICATION_STABILIZATION_FAILED", 74, {
                "attempts": attempts,
                "consecutive_successes": consecutive_successes,
                "last_failure_code": last_failure_code,
                "required_consecutive_successes": APPLICATION_STABILIZATION_REQUIRED_SUCCESSES,
                "timeout_seconds": APPLICATION_STABILIZATION_SECONDS,
            })
        attempts += 1
        try:
            evidence = _rollback_application_health_once(core, profile)
            observed_at = time.monotonic()
            if observed_at <= deadline:
                consecutive_successes += 1
                if consecutive_successes >= APPLICATION_STABILIZATION_REQUIRED_SUCCESSES:
                    return {
                        **evidence,
                        "rollback_stabilization_attempts": attempts,
                        "rollback_stabilization_consecutive_successes": consecutive_successes,
                        "rollback_stabilization_elapsed_ms": int((observed_at - started) * 1000),
                        "rollback_stabilization_timeout_seconds": APPLICATION_STABILIZATION_SECONDS,
                    }
                last_failure_code = "GRAVITY_ROLLBACK_STABILIZATION_INCOMPLETE"
            else:
                last_failure_code = "GRAVITY_ROLLBACK_STABILIZATION_DEADLINE_EXCEEDED"
        except core.RuntimeFault as exc:
            last_failure_code = exc.code
            consecutive_successes = 0
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            continue
        time.sleep(min(APPLICATION_STABILIZATION_INTERVAL_SECONDS, remaining))


def _tg_bot_health(core: Any, profile: dict[str, Any], expected_sha256: str | None) -> dict[str, Any]:
    container = profile["production"]["tg_bot_container"]
    script = (
        "const n=require('net');const s=n.connect(3001,'127.0.0.1');"
        "s.setTimeout(10000);s.on('connect',()=>{s.destroy();process.exit(0)});"
        "s.on('timeout',()=>{s.destroy();process.exit(2)});s.on('error',()=>process.exit(3));"
    )
    completed = _run(core, [DOCKER, "exec", container, "node", "-e", script], timeout=15)
    if completed.returncode != 0:
        raise core.RuntimeFault("TG_BOT_INTERNAL_API_HEALTH_FAILED", 74)
    patch = _tg_patch_file_probe(core, container)
    if expected_sha256 is None:
        _validate_tg_patch_absent(core, patch, "TG_BOT_PATCH_RUNTIME_IDENTITY_FAILED")
    else:
        _validate_tg_patch_probe(core, profile, patch, expected_sha256, "TG_BOT_PATCH_RUNTIME_IDENTITY_FAILED")
    return {
        "tg_bot_internal_api_reachable": True,
        "tg_bot_patch_state": patch["state"],
        "tg_bot_patch_sha256": patch.get("sha256"),
        "tg_bot_patch_metadata_exact": True,
        "response_body_emitted": False,
    }


def _activation_postcheck(core: Any, policy: dict[str, Any], profile: dict[str, Any], state: dict[str, Any], *, expected_image: str, expected_semantic: dict[str, Any]) -> dict[str, Any]:
    gravity = core.container_projection(policy, "crm.container.gravity_mvp")
    tg_bot = core.container_projection(policy, "crm.container.telegram_bot")
    if gravity["image_id"] != expected_image or not gravity["running"] or gravity["health"] != "healthy":
        raise core.RuntimeFault("GRAVITY_ACTIVATION_IDENTITY_OR_HEALTH_FAILED", 74)
    if _preserved_gravity_semantics(gravity["semantic"]) != _preserved_gravity_semantics(expected_semantic):
        raise core.RuntimeFault("GRAVITY_ACTIVATION_SEMANTIC_DRIFT", 74)
    if (
        gravity["cmd"] != ["npm", "run", "start"]
        or gravity["declared_user"] != "app"
        or gravity["working_dir"] != "/app"
        or gravity["entrypoint"] != ["/usr/bin/tini", "--"]
    ):
        raise core.RuntimeFault("GRAVITY_ACTIVATION_PROCESS_CONTRACT_FAILED", 74)
    if (
        tg_bot["image_id"] != state.get("tg_target_image_id")
        or not tg_bot["running"]
        or tg_bot["health"] != "healthy"
        or tg_bot["restart_count"] != 0
        or _preserved_service_semantics(tg_bot["semantic"])
        != _preserved_service_semantics(state["production_identity"]["tg_bot_semantic"])
        or tg_bot["cmd"] != profile["production"]["tg_bot_cmd"]
        or tg_bot["entrypoint"] != profile["production"]["tg_bot_entrypoint"]
        or tg_bot["declared_user"] != profile["production"]["tg_bot_declared_user"]
        or tg_bot["working_dir"] != profile["production"]["tg_bot_working_dir"]
    ):
        raise core.RuntimeFault("TG_BOT_ACTIVATION_IDENTITY_OR_SEMANTIC_FAILED", 74)
    database, _ = _database_status(core, profile)
    if (
        database["migration_state"] != "APPROVED_OUTBOX_APPLIED"
        or database["database_identity_sha256"] != state.get("database_identity_sha256")
        or database["migration_ledger_sha256"] != state.get("migration_ledger_sha256")
    ):
        raise core.RuntimeFault("GRAVITY_ACTIVATION_DATABASE_DRIFT", 74)
    health = _application_health(core, profile)
    tg_health = _tg_bot_health(core, profile, TG_PATCH_TARGET_SHA256)
    _assert_unrelated_runtime_unchanged(core, policy, profile, state)
    return {
        "gravity_container_id": gravity["container_id"],
        "gravity_image_id": gravity["image_id"],
        "tg_bot_container_id": tg_bot["container_id"],
        "tg_bot_image_id": tg_bot["image_id"],
        "running": gravity["running"],
        "healthy": gravity["health"] == "healthy",
        "semantics_preserved": True,
        "unrelated_containers_unchanged": True,
        "database": database,
        **health,
        **tg_health,
    }


def _rollback_database_postcheck(core: Any, profile: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    database, _ = _database_status(core, profile)
    recovery = profile["recovery"]
    if (
        database["migration_state"] != "APPROVED_OUTBOX_APPLIED"
        or database["database_identity_sha256"] != recovery["database_identity_sha256"]
        or database["migration_ledger_sha256"] != recovery["migration_ledger_sha256"]
        or state.get("database_identity_sha256") != recovery["database_identity_sha256"]
        or state.get("migration_ledger_sha256") != recovery["migration_ledger_sha256"]
    ):
        raise core.RuntimeFault("ROLLBACK_DATABASE_IDENTITY_DRIFT", 74)
    return database


def _rollback_impl(core: Any, policy: dict[str, Any], profile: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    rollback = _image_inspect(core, ROLLBACK_TAG)
    tg_rollback = _image_inspect(core, TG_ROLLBACK_TAG)
    expected = profile["production"]["gravity_image_id"]
    tg_expected = profile["production"]["tg_bot_image_id"]
    if rollback is None or rollback["Id"] != expected or tg_rollback is None or tg_rollback["Id"] != tg_expected:
        raise core.RuntimeFault("ROLLBACK_IMAGE_IDENTITY_MISMATCH", 74)
    _verify_predecessor_compose_references(core, profile)
    _write_fixed_file(
        core,
        ROLLBACK_OVERLAY,
        _compose_overlay(PRIOR_TARGET_TAG, TG_PREDECESSOR_REFERENCE, activate=False),
        0o400,
    )
    _compose_up(core, profile, state, ROLLBACK_OVERLAY)
    gravity = core.container_projection(policy, "crm.container.gravity_mvp")
    tg_bot = core.container_projection(policy, "crm.container.telegram_bot")
    if gravity["image_id"] != expected or not gravity["running"] or gravity["health"] != "healthy" or tg_bot["image_id"] != tg_expected or not tg_bot["running"] or tg_bot["health"] != "healthy":
        raise core.RuntimeFault("ROLLBACK_POSTCHECK_FAILED", 74)
    compatibility = _rollback_semantics_compatibility(profile, state, gravity)
    tg_compatibility = _rollback_tg_semantics_compatibility(profile, state, tg_bot)
    if compatibility is None or tg_compatibility is None:
        raise core.RuntimeFault("ROLLBACK_SEMANTIC_DRIFT", 74)
    database = _rollback_database_postcheck(core, profile, state)
    rollback_health = _rollback_application_health(core, profile)
    tg_health = _tg_bot_health(core, profile, None)
    _assert_unrelated_runtime_unchanged(core, policy, profile, state)
    return {
        "gravity_container_id": gravity["container_id"],
        "gravity_image_id": gravity["image_id"],
        "tg_bot_container_id": tg_bot["container_id"],
        "tg_bot_image_id": tg_bot["image_id"],
        "running": gravity["running"],
        "healthy": gravity["health"] == "healthy",
        "original_runtime_semantics_restored": True,
        "runtime_semantics_compatibility": compatibility,
        "tg_runtime_semantics_compatibility": tg_compatibility,
        "database_schema_action": "NONE_KEEP_EXPAND_ONLY_OUTBOX",
        "database": database,
        **rollback_health,
        **tg_health,
    }


def _rollback_state_is_exact(
    profile: dict[str, Any],
    gravity: dict[str, Any],
    tg_bot: dict[str, Any],
    state: dict[str, Any],
) -> bool:
    return (
        gravity.get("image_id") == profile["production"]["gravity_image_id"]
        and gravity.get("running") is True
        and gravity.get("health") == "healthy"
        and tg_bot.get("image_id") == profile["production"]["tg_bot_image_id"]
        and tg_bot.get("running") is True
        and tg_bot.get("health") == "healthy"
        and _rollback_semantics_compatibility(profile, state, gravity) == "EXACT"
        and _rollback_tg_semantics_compatibility(profile, state, tg_bot) == "EXACT"
    )


def _restore_or_accept_rollback(
    core: Any,
    policy: dict[str, Any],
    profile: dict[str, Any],
    state: dict[str, Any],
    gravity: dict[str, Any],
    tg_bot: dict[str, Any],
) -> tuple[dict[str, Any], bool]:
    """Accept an exact predecessor or deterministically reconstruct it."""
    if _rollback_state_is_exact(profile, gravity, tg_bot, state):
        return _accept_existing_rollback(core, policy, profile, state, gravity, tg_bot), False
    return _rollback_impl(core, policy, profile, state), True


def _accept_existing_rollback(core: Any, policy: dict[str, Any], profile: dict[str, Any], state: dict[str, Any], gravity: dict[str, Any], tg_bot: dict[str, Any]) -> dict[str, Any]:
    if (
        gravity.get("image_id") != profile["production"]["gravity_image_id"]
        or not gravity.get("running")
        or gravity.get("health") != "healthy"
        or tg_bot.get("image_id") != profile["production"]["tg_bot_image_id"]
        or not tg_bot.get("running")
        or tg_bot.get("health") != "healthy"
    ):
        raise core.RuntimeFault("ROLLED_BACK_STATE_IDENTITY_DRIFT", 74)
    compatibility = _rollback_semantics_compatibility(profile, state, gravity)
    tg_compatibility = _rollback_tg_semantics_compatibility(profile, state, tg_bot)
    if compatibility is None or tg_compatibility is None:
        raise core.RuntimeFault("ROLLED_BACK_STATE_IDENTITY_DRIFT", 74)
    _validate_production_compose_inputs(core, profile, state)
    database = _rollback_database_postcheck(core, profile, state)
    rollback_health = _rollback_application_health(core, profile)
    tg_health = _tg_bot_health(core, profile, None)
    _assert_unrelated_runtime_unchanged(core, policy, profile, state)
    return {
        "gravity_container_id": gravity["container_id"],
        "gravity_image_id": gravity["image_id"],
        "tg_bot_container_id": tg_bot["container_id"],
        "tg_bot_image_id": tg_bot["image_id"],
        "running": True,
        "healthy": True,
        "original_runtime_semantics_restored": True,
        "runtime_semantics_compatibility": compatibility,
        "tg_runtime_semantics_compatibility": tg_compatibility,
        "database_schema_action": "NONE_KEEP_EXPAND_ONLY_OUTBOX",
        "database": database,
        **rollback_health,
        **tg_health,
    }


def _dual_service_image_state(
    core: Any,
    profile: dict[str, Any],
    state: dict[str, Any],
    gravity: dict[str, Any],
    tg_bot: dict[str, Any],
) -> tuple[str, str]:
    def classify(actual: Any, old: Any, target: Any) -> str:
        if actual == old:
            return "old"
        if actual == target and isinstance(target, str):
            return "target"
        return "unknown"

    vector = (
        classify(gravity.get("image_id"), profile["production"]["gravity_image_id"], state.get("target_image_id")),
        classify(tg_bot.get("image_id"), profile["production"]["tg_bot_image_id"], state.get("tg_target_image_id")),
    )
    if "unknown" in vector:
        raise core.RuntimeFault("DUAL_SERVICE_SOURCE_IDENTITY_DRIFT", 74)
    return vector


def _failure_identity(core: Any, failure: BaseException, fallback_code: str) -> dict[str, Any]:
    if isinstance(failure, core.RuntimeFault):
        details = failure.details if isinstance(failure.details, dict) else {}
        return {"code": failure.code, "details": details}
    return {"code": fallback_code, "details": {}}


def _combined_activation_rollback_fault(
    core: Any,
    invocation: Any,
    state: dict[str, Any],
    activation_failure: dict[str, Any] | None,
    rollback_failure: BaseException,
    result: str,
) -> Any:
    activation = activation_failure or state.get("activation_failure_identity")
    if not isinstance(activation, dict) or not isinstance(activation.get("code"), str):
        activation = {"code": "LEGACY_ACTIVATION_FAILURE_UNAVAILABLE", "details": {}}
    rollback = _failure_identity(core, rollback_failure, "INTERNAL_AUTOMATIC_ROLLBACK_FAILURE")
    failed = {
        **state,
        "activation_failure": True,
        "activation_failure_identity": activation,
        "automatic_rollback_failure_identity": rollback,
        "terminal_failure_status": "ACTIVATION_AND_AUTOMATIC_ROLLBACK_FAILED",
        "automatic_rollback_failed_at": core.now(),
    }
    _write_terminal_state(core, invocation, state, result, failed)
    return core.RuntimeFault("ACTIVATION_AND_AUTOMATIC_ROLLBACK_FAILED", 74, {
        "activation_failure": activation,
        "automatic_rollback_failure": rollback,
        "terminal_status": "ACTIVATION_AND_AUTOMATIC_ROLLBACK_FAILED",
    })


def _complete_activation_rollback(
    core: Any,
    policy: dict[str, Any],
    profile: dict[str, Any],
    invocation: Any,
    state: dict[str, Any],
    *,
    activation_recovery: bool,
    activation_failure: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if state.get("phase") == "RELEASE_ACTIVATION_ROLLBACK_INTENT":
        intent = state
    else:
        intent = {
            **state,
            "phase": "RELEASE_ACTIVATION_ROLLBACK_INTENT",
            "activation_failure": True,
            "activation_failure_identity": activation_failure or {
                "code": "LEGACY_ACTIVATION_FAILURE_UNAVAILABLE",
                "details": {},
            },
            "activation_recovery": activation_recovery,
            "activation_rollback_intent_at": core.now(),
        }
        intent = _write_terminal_state(core, invocation, state, "activation_rollback_intent", intent)
    gravity = core.container_projection(policy, "crm.container.gravity_mvp")
    tg_bot = core.container_projection(policy, "crm.container.telegram_bot")
    _dual_service_image_state(core, profile, intent, gravity, tg_bot)
    rollback, _ = _restore_or_accept_rollback(core, policy, profile, intent, gravity, tg_bot)
    rolled = {
        **intent,
        "phase": "ROLLED_BACK",
        "rollback_completed_at": core.now(),
        "rollback_runtime_semantics_compatibility": rollback["runtime_semantics_compatibility"],
        "rollback_tg_runtime_semantics_compatibility": rollback["tg_runtime_semantics_compatibility"],
    }
    result = "recovery_failed_rolled_back" if activation_recovery else "failed_rolled_back"
    rolled = _write_terminal_state(core, invocation, intent, result, rolled)
    return rollback, rolled


def _release_activate(core: Any, policy: dict[str, Any], profile: dict[str, Any], invocation: Any) -> dict[str, Any]:
    with _lock(core):
        state = _read_state(core)
        _reconcile_terminal_audit(core, state)
        if state.get("phase") == "ACTIVATED":
            _validate_production_compose_inputs(core, profile, state)
            postcheck = _activation_postcheck(
                core, policy, profile, state,
                expected_image=state["target_image_id"],
                expected_semantic=state["production_identity"]["gravity_semantic"],
            )
            return {"profile_id": PROFILE_ID, "status": "ALREADY_ACTIVATED", "postcheck": postcheck, "production_mutated": False}
        if state.get("phase") == "RELEASE_ACTIVATION_ROLLBACK_INTENT":
            if core.audit_status()["state"] not in {"EMPTY", "VALID"}:
                raise core.RuntimeFault("AUDIT_MUTATION_DISABLED", 78)
            current = core.container_projection(policy, "crm.container.gravity_mvp")
            current_tg = core.container_projection(policy, "crm.container.telegram_bot")
            _dual_service_image_state(core, profile, state, current, current_tg)
            try:
                rollback, rolled = _complete_activation_rollback(
                    core, policy, profile, invocation, state,
                    activation_recovery=bool(state.get("activation_recovery")),
                )
            except Exception as rollback_failure:
                current = _read_state(core)
                raise _combined_activation_rollback_fault(
                    core, invocation, current, current.get("activation_failure_identity"),
                    rollback_failure, "activation_rollback_recovery_failed",
                )
            return {
                "profile_id": PROFILE_ID,
                "status": "ROLLED_BACK_RECOVERED",
                "rollback": rollback,
                "state_phase": rolled["phase"],
                "production_mutated": True,
                "automatic_rollback": True,
            }
        recovering = state.get("phase") == "RELEASE_ACTIVATION_INTENT"
        if state.get("phase") not in {"MIGRATED", "RELEASE_ACTIVATION_INTENT"}:
            raise core.RuntimeFault("DATABASE_MIGRATION_REQUIRED", 77)
        if core.audit_status()["state"] not in {"EMPTY", "VALID"}:
            raise core.RuntimeFault("AUDIT_MUTATION_DISABLED", 78)
        current = core.container_projection(policy, "crm.container.gravity_mvp")
        current_tg = core.container_projection(policy, "crm.container.telegram_bot")
        vector = _dual_service_image_state(core, profile, state, current, current_tg)
        if not recovering and vector != ("old", "old"):
            raise core.RuntimeFault("DUAL_SERVICE_PREACTIVATION_IMAGE_DRIFT", 74)
        _validate_production_compose_inputs(core, profile, state)
        if not recovering:
            current_production = _production_preflight_identity(core, policy, profile)
            if _digest(current_production) != _digest(state["production_identity"]):
                raise core.RuntimeFault("PRODUCTION_IDENTITY_CHANGED_SINCE_PREFLIGHT", 74)
        target = _verify_gravity_candidate_image(core, profile)
        tg_target = _image_inspect(core, TG_TARGET_TAG)
        rollback_image = _image_inspect(core, ROLLBACK_TAG)
        tg_rollback_image = _image_inspect(core, TG_ROLLBACK_TAG)
        if target is None or target["Id"] != state.get("target_image_id") or tg_target is None or tg_target["Id"] != state.get("tg_target_image_id"):
            raise core.RuntimeFault("TARGET_IMAGE_IDENTITY_DRIFT", 74)
        if rollback_image is None or rollback_image["Id"] != profile["production"]["gravity_image_id"] or tg_rollback_image is None or tg_rollback_image["Id"] != profile["production"]["tg_bot_image_id"]:
            raise core.RuntimeFault("ROLLBACK_IMAGE_IDENTITY_DRIFT", 74)
        _verify_tg_candidate_image(core, profile, tg_target)
        _tg_image_file_probe(core, profile, TG_TARGET_TAG)
        status, _ = _database_status(core, profile)
        if status["migration_state"] != "APPROVED_OUTBOX_APPLIED" or status["database_identity_sha256"] != state.get("database_identity_sha256") or status["migration_ledger_sha256"] != state.get("migration_ledger_sha256"):
            raise core.RuntimeFault("DATABASE_MIGRATION_POSTSTATE_REQUIRED", 74)
        if recovering:
            intent = state
            if vector == ("target", "target"):
                try:
                    postcheck = _activation_postcheck(
                        core, policy, profile, state,
                        expected_image=state["target_image_id"],
                        expected_semantic=state["production_identity"]["gravity_semantic"],
                    )
                    next_state = {**state, "phase": "ACTIVATED", "activation_completed_at": core.now(), "activated_container_id": postcheck["gravity_container_id"], "activated_tg_bot_container_id": postcheck["tg_bot_container_id"]}
                    next_state = _write_terminal_state(core, invocation, state, "recovered_ok", next_state)
                    return {"profile_id": PROFILE_ID, "status": "ACTIVATED_RECOVERED", "postcheck": postcheck, "production_mutated": False, "automatic_rollback": False}
                except Exception as activation_failure:
                    activation_identity = _failure_identity(core, activation_failure, "INTERNAL_ACTIVATION_FAILURE")
                    try:
                        rollback, rolled = _complete_activation_rollback(
                            core, policy, profile, invocation, state, activation_recovery=True,
                            activation_failure=activation_identity,
                        )
                    except Exception as rollback_failure:
                        if (
                            isinstance(rollback_failure, core.RuntimeFault)
                            and rollback_failure.code == "ACTIVATION_AND_AUTOMATIC_ROLLBACK_FAILED"
                        ):
                            raise
                        raise _combined_activation_rollback_fault(
                            core, invocation, _read_state(core), activation_identity,
                            rollback_failure, "recovery_failed_rollback_failed",
                        )
                    raise core.RuntimeFault("ACTIVATION_FAILED_AUTOMATIC_ROLLBACK_OK", 74, {
                        "activation_failure_code": activation_identity["code"],
                        "activation_failure": activation_identity,
                        "rollback": rollback,
                    })
            if vector in {("target", "old"), ("old", "target")}:
                try:
                    rollback, rolled = _complete_activation_rollback(
                        core, policy, profile, invocation, state, activation_recovery=True
                    )
                except Exception as rollback_failure:
                    raise _combined_activation_rollback_fault(
                        core, invocation, _read_state(core), state.get("activation_failure_identity"),
                        rollback_failure, "mixed_recovery_rollback_failed",
                    )
                return {
                    "profile_id": PROFILE_ID,
                    "status": "MIXED_STATE_ROLLED_BACK_RECOVERED",
                    "rollback": rollback,
                    "state_phase": rolled["phase"],
                    "production_mutated": True,
                    "automatic_rollback": True,
                }
        else:
            intent = {**state, "phase": "RELEASE_ACTIVATION_INTENT", "activation_intent_at": core.now()}
            _audit(core, invocation, state, "intent", intent)
            _write_state(core, intent)
        _write_fixed_file(core, ACTIVATE_OVERLAY, _compose_overlay(TARGET_TAG, TG_TARGET_TAG, activate=True), 0o400)
        try:
            _compose_up(core, profile, state, ACTIVATE_OVERLAY)
            postcheck = _activation_postcheck(
                core, policy, profile, state,
                expected_image=state["target_image_id"],
                expected_semantic=state["production_identity"]["gravity_semantic"],
            )
            next_state = {**state, "phase": "ACTIVATED", "activation_completed_at": core.now(), "activated_container_id": postcheck["gravity_container_id"], "activated_tg_bot_container_id": postcheck["tg_bot_container_id"]}
            next_state = _write_terminal_state(core, invocation, intent, "ok", next_state)
            return {"profile_id": PROFILE_ID, "status": "ACTIVATED", "postcheck": postcheck, "production_mutated": True, "automatic_rollback": False}
        except Exception as activation_failure:
            activation_identity = _failure_identity(core, activation_failure, "INTERNAL_ACTIVATION_FAILURE")
            try:
                rollback, rolled = _complete_activation_rollback(
                    core, policy, profile, invocation, intent, activation_recovery=False,
                    activation_failure=activation_identity,
                )
            except Exception as rollback_failure:
                if (
                    isinstance(rollback_failure, core.RuntimeFault)
                    and rollback_failure.code == "ACTIVATION_AND_AUTOMATIC_ROLLBACK_FAILED"
                ):
                    raise
                raise _combined_activation_rollback_fault(
                    core, invocation, _read_state(core), activation_identity,
                    rollback_failure, "failed_rollback_failed",
                )
            raise core.RuntimeFault("ACTIVATION_FAILED_AUTOMATIC_ROLLBACK_OK", 74, {
                "activation_failure_code": activation_identity["code"],
                "activation_failure": activation_identity,
                "rollback": rollback,
            })


def _rollback(core: Any, policy: dict[str, Any], profile: dict[str, Any], invocation: Any) -> dict[str, Any]:
    with _lock(core):
        state = _read_state(core)
        _reconcile_terminal_audit(core, state)
        if state.get("phase") == "UNINITIALIZED":
            if core.audit_status()["state"] not in {"EMPTY", "VALID"}:
                raise core.RuntimeFault("AUDIT_MUTATION_DISABLED", 78)
            source_state, source_sha256 = _read_replacement_recovery_state(core, profile)
            source_state.pop("terminal_audit_receipt", None)
            imported = {
                **source_state,
                "profile_id": PROFILE_ID,
                "replacement_recovery_source_profile_id": RECOVERY_SOURCE_PROFILE_ID,
                "replacement_recovery_source_commit": RECOVERY_SOURCE_COMMIT,
                "replacement_recovery_source_state_sha256": source_sha256,
                "replacement_recovery_imported_at": core.now(),
            }
            state = _write_terminal_state(
                core, invocation, state, "replacement_recovery_state_imported", imported,
            )
        if state.get("phase") == "ROLLED_BACK":
            gravity = core.container_projection(policy, "crm.container.gravity_mvp")
            tg_bot = core.container_projection(policy, "crm.container.telegram_bot")
            _dual_service_image_state(core, profile, state, gravity, tg_bot)
            result = _accept_existing_rollback(core, policy, profile, state, gravity, tg_bot)
            return {"profile_id": PROFILE_ID, "status": "ALREADY_ROLLED_BACK", "postcheck": result, "production_mutated": False}
        recovering = state.get("phase") == "ROLLBACK_INTENT"
        if state.get("phase") not in {"ACTIVATED", "RELEASE_ACTIVATION_INTENT", "RELEASE_ACTIVATION_ROLLBACK_INTENT", "ROLLBACK_INTENT"}:
            raise core.RuntimeFault("ROLLBACK_NOT_AVAILABLE_IN_CURRENT_PHASE", 77)
        if core.audit_status()["state"] not in {"EMPTY", "VALID"}:
            raise core.RuntimeFault("AUDIT_MUTATION_DISABLED", 78)
        gravity = core.container_projection(policy, "crm.container.gravity_mvp")
        tg_bot = core.container_projection(policy, "crm.container.telegram_bot")
        _dual_service_image_state(core, profile, state, gravity, tg_bot)
        if recovering:
            intent = state
        else:
            intent = {**state, "phase": "ROLLBACK_INTENT", "rollback_intent_at": core.now()}
            intent = _write_terminal_state(core, invocation, state, "intent", intent)
        production_mutated = False
        try:
            result, production_mutated = _restore_or_accept_rollback(
                core, policy, profile, intent, gravity, tg_bot,
            )
            next_state = {**intent, "phase": "ROLLED_BACK", "rollback_completed_at": core.now(), "rollback_reason": "EXPLICIT_PROFILE_CALL"}
            next_state = _write_terminal_state(core, invocation, intent, "ok", next_state)
            return {"profile_id": PROFILE_ID, "status": "ROLLED_BACK", "postcheck": result, "production_mutated": production_mutated}
        except Exception:
            _audit(core, invocation, intent, "failed", _read_state(core))
            raise


def dispatch(core: Any, policy: dict[str, Any], invocation: Any) -> dict[str, Any]:
    profile = _load_profile(core)
    if invocation.resource is not None or invocation.relative_path is not None:
        raise core.RuntimeFault("PROFILE_ARGUMENTS_FORBIDDEN", 64)
    if invocation.primitive == "database-status":
        return _database_status_profile(core, profile)
    if invocation.primitive == "release-preflight":
        return _release_preflight(core, policy, profile, invocation)
    if invocation.primitive == "database-migrate":
        raise core.RuntimeFault("PROFILE_DISABLED", 77, {"profile": "database_migrate"})
    if invocation.primitive == "release-activate":
        return _release_activate(core, policy, profile, invocation)
    if invocation.primitive == "rollback":
        return _rollback(core, policy, profile, invocation)
    raise core.RuntimeFault("PROFILE_DISABLED", 77, {"profile": invocation.primitive.replace("-", "_")})
