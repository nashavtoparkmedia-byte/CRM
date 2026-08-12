#!/usr/bin/python3 -I
"""Finite implementation of crm-af9646f5-gravity-outbox-v1.

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


PROFILE_ID = "crm-af9646f5-gravity-outbox-v1"
PROFILE_DIR = f"/usr/local/share/yoko-privileged-runtime/profiles/{PROFILE_ID}"
PROFILE_PATH = PROFILE_DIR + "/profile.v1.json"
ARCHIVE_PATH = PROFILE_DIR + "/source.tar.gz"
MIGRATION_PATH = PROFILE_DIR + "/migration.sql"
ACTIVATION_ROOT = f"/var/lib/yoko-privileged-runtime/activation/{PROFILE_ID}"
STATE_PATH = ACTIVATION_ROOT + "/state.v1.json"
LOCK_PATH = ACTIVATION_ROOT + "/transaction.lock"
RELEASE_ROOT = ACTIVATION_ROOT + "/release"
SOURCE_ROOT = RELEASE_ROOT + "/source"
ACTIVATE_OVERLAY = ACTIVATION_ROOT + "/gravity-activate.compose.yml"
ROLLBACK_OVERLAY = ACTIVATION_ROOT + "/gravity-rollback.compose.yml"
MIGRATION_ENV = ACTIVATION_ROOT + "/migration.env"
PREVIEW_POSTGRES_ENV = ACTIVATION_ROOT + "/preview-postgres.env"
BACKUP_ROOT = ACTIVATION_ROOT + "/backup"
BACKUP_PATH = BACKUP_ROOT + "/pre-migration.dump"
DOCKER = "/usr/bin/docker"
PROFILE_SCHEMA = "yoko.crm.activation-profile.v1"
STATE_SCHEMA = "yoko.crm.activation-state.v1"
TARGET_TAG = "yoko/crm-gravity-mvp:af9646f51c1274d718d83eb4c78faf92f214a184-profile-v1"
ROLLBACK_TAG = "yoko/crm-gravity-mvp:rollback-b36751e5a6d2b52e7a7676ee5babcd70"
PREVIEW_NETWORK = "yoko-crm-af9646f5-preview"
PREVIEW_CONTAINER = "yoko-crm-af9646f5-postgres-preview"
PREVIEW_MIGRATION_RUNNER = "yoko-crm-af9646f5-preview-migrate"
ROLLBACK_PROOF_RUNNER = "yoko-crm-af9646f5-rollback-proof"
PRODUCTION_MIGRATION_RUNNER = "yoko-crm-af9646f5-production-migrate"
PRODUCTION_RESOLVE_RUNNER = "yoko-crm-af9646f5-production-resolve"
BACKUP_LIST_RUNNER = "yoko-crm-af9646f5-backup-list"
MIGRATION_NAME = "20260809140000_add_domain_outbox"
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
        "accepted_source", "production", "migration", "limits",
        "enabled_zero_argument_profiles", "disabled_profiles", "negative_properties",
    }
    if (
        value.st_size <= 0
        or not isinstance(profile, dict)
        or set(profile) != required
        or profile.get("schema") != PROFILE_SCHEMA
        or profile.get("profile_id") != PROFILE_ID
        or profile.get("runtime_abi") != core.VERSION
        or profile.get("package_version") != "2.0.0-7"
        or profile.get("host") != "jvxthcorvm"
        or profile.get("enabled_zero_argument_profiles") != [
            "database-status", "release-preflight", "database-migrate", "release-activate", "rollback"
        ]
        or set(profile.get("disabled_profiles", {})) != {"config-activate"}
        or profile.get("migration", {}).get("name") != MIGRATION_NAME
        or not isinstance(profile.get("negative_properties"), dict)
        or any(profile["negative_properties"].values())
    ):
        raise core.RuntimeFault("ACTIVATION_PROFILE_INVALID", 78)
    for key in (
        "archive_sha256", "dockerfile_sha256", "package_lock_sha256", "prisma_schema_sha256"
    ):
        if not SHA256.fullmatch(str(profile["accepted_source"].get(key, ""))):
            raise core.RuntimeFault("ACTIVATION_PROFILE_INVALID", 78)
    for key in (
        "source_manifest_sha256", "compose_sha256"
    ):
        if not SHA256.fullmatch(str(profile["production"].get(key, ""))):
            raise core.RuntimeFault("ACTIVATION_PROFILE_INVALID", 78)
    accepted_ledger = profile["migration"].get("accepted_production_ledger")
    if (
        not SHA256.fullmatch(str(profile["migration"].get("sha256", "")))
        or not isinstance(accepted_ledger, dict)
        or set(accepted_ledger) != {
            "active_migration_count", "normalized_observation_sha256",
            "target_state_at_capture", "database_identity_sha256",
        }
        or accepted_ledger.get("active_migration_count") != 61
        or not SHA256.fullmatch(str(accepted_ledger.get("normalized_observation_sha256", "")))
        or accepted_ledger.get("target_state_at_capture") != "ABSENT"
        or not SHA256.fullmatch(str(accepted_ledger.get("database_identity_sha256", "")))
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
    if not migrated:
        inventory.pop(target, None)
    inventory.update(profile["migration"]["accepted_checksum_overrides"])
    inventory.update(profile["migration"]["production_only_applied"])
    return inventory


def _migration_ledger_observation(core: Any, identity: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    sql = (
        "SELECT migration_name, checksum, "
        "CASE WHEN finished_at IS NOT NULL THEN '1' ELSE '0' END, "
        "CASE WHEN rolled_back_at IS NULL THEN '1' ELSE '0' END "
        "FROM \"_prisma_migrations\" ORDER BY migration_name, started_at;"
    )
    raw = _psql(core, identity, sql, code="MIGRATION_LEDGER_QUERY_FAILED")
    output: dict[str, str] = {}
    interrupted_target = 0
    rolled_back_target = 0
    target = profile["migration"]["name"]
    target_checksum = profile["migration"]["sha256"]
    try:
        for line in raw.decode("utf-8").splitlines():
            name, checksum, finished, not_rolled_back = line.split("\t")
            if (
                not re.fullmatch(r"[0-9][A-Za-z0-9_-]{1,199}", name)
                or not SHA256.fullmatch(checksum)
                or finished not in {"0", "1"}
                or not_rolled_back not in {"0", "1"}
            ):
                raise ValueError("invalid ledger")
            if finished == "1" and not_rolled_back == "1":
                if name in output:
                    raise ValueError("duplicate active migration")
                output[name] = checksum
            elif finished == "0" and name == target and checksum == target_checksum:
                if not_rolled_back == "1":
                    interrupted_target += 1
                else:
                    rolled_back_target += 1
            else:
                raise ValueError("unexpected inactive migration")
        if interrupted_target > 1:
            raise ValueError("multiple unfinished target migrations")
    except (UnicodeError, ValueError) as exc:
        raise core.RuntimeFault("MIGRATION_LEDGER_INVALID", 74) from exc
    return {
        "active": output,
        "interrupted_target": interrupted_target,
        "rolled_back_target": rolled_back_target,
    }


def _migration_ledger(core: Any, identity: dict[str, Any], profile: dict[str, Any]) -> dict[str, str]:
    observation = _migration_ledger_observation(core, identity, profile)
    if observation["interrupted_target"]:
        raise core.RuntimeFault("MIGRATION_LEDGER_INTERRUPTED", 74)
    return observation["active"]


def _accepted_production_ledger_shape(observation: dict[str, Any], profile: dict[str, Any]) -> dict[str, bool]:
    """Bind the complete live pre-outbox ledger without authorizing its rows dynamically.

    The accepted digest was captured through the finite read-only database-status
    profile. Normalizing only the one fixed target row and its finite Prisma
    recovery counters lets the same exact baseline be proven before, during and
    after the approved expand-only migration. Any unrelated name, checksum,
    duplicate or inactive record changes the digest and fails closed.
    """
    accepted = profile["migration"]["accepted_production_ledger"]
    target = profile["migration"]["name"]
    target_sha = profile["migration"]["sha256"]
    active = dict(observation["active"])
    target_value = active.pop(target, None)
    normalized = {
        "active": active,
        "interrupted_target": 0,
        "rolled_back_target": 0,
    }
    baseline_exact = (
        len(active) == accepted["active_migration_count"]
        and _digest(normalized) == accepted["normalized_observation_sha256"]
    )
    return {
        "baseline_exact": baseline_exact,
        "target_absent": target_value is None,
        "target_active": target_value == target_sha,
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
    if identity_exact and shape["baseline_exact"] and shape["target_absent"] and observation["interrupted_target"] == 1:
        ledger_state = "APPROVED_OUTBOX_INTERRUPTED"
    elif identity_exact and shape["baseline_exact"] and shape["target_absent"] and not observation["interrupted_target"] and catalog["state"] == "ABSENT":
        ledger_state = "ONLY_APPROVED_OUTBOX_PENDING"
    elif identity_exact and shape["baseline_exact"] and shape["target_active"] and not observation["interrupted_target"] and catalog["state"] == "EXACT":
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
        "migration_ledger_sha256": _digest(observation),
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
                    or not (name == source["archive_prefix"].rstrip("/") or name.startswith(source["archive_prefix"]))
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
    return core.mapped(SOURCE_ROOT) / prefix / profile["accepted_source"]["build_context"]


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
    manifest = core.tree_manifest(policy, core.Invocation("fs-tree", "crm.repo.production"))
    if manifest["manifest_sha256"] != production["source_manifest_sha256"]:
        raise core.RuntimeFault("PRODUCTION_SOURCE_IDENTITY_DRIFT", 74)
    postgres = _postgres_identity(core, profile)
    provenance = core.docker_provenance(policy)
    if not provenance["complete"]:
        raise core.RuntimeFault("PRODUCTION_PROVENANCE_INCOMPLETE", 74)
    unrelated = [item for item in provenance["semantic"]["records"] if item["name"] != production["gravity_container"]]
    unrelated_runtime = sorted(
        (item["name"], item["container_id"], item["image_id"], item["status"], item["started_at"], item["restart_count"])
        for item in provenance["records"] if item["name"] != production["gravity_container"]
    )
    return {
        "compose_sha256": production["compose_sha256"],
        "environment_sha256": _sha_file(environment, 4 * 1024 * 1024),
        "production_source_manifest_sha256": manifest["manifest_sha256"],
        "gravity_semantic": gravity["semantic"],
        "postgres_identity_sha256": postgres["database_identity_sha256"],
        "unrelated_semantic_sha256": core.semantic_fingerprint(unrelated),
        "unrelated_runtime_sha256": _digest(unrelated_runtime),
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


def _build_candidate(core: Any, profile: dict[str, Any], context: Path) -> str:
    source = profile["accepted_source"]
    existing = _image_inspect(core, TARGET_TAG, required=False)
    if existing is not None:
        labels = (existing.get("Config") or {}).get("Labels") or {}
        if (
            labels.get("org.opencontainers.image.revision") != source["commit"]
            or labels.get("yoko.activation.profile") != PROFILE_ID
            or labels.get("yoko.source.archive.sha256") != source["archive_sha256"]
        ):
            raise core.RuntimeFault("TARGET_IMAGE_TAG_COLLISION", 74)
        return existing["Id"]
    gravity_environment = _container_environment(core, profile["production"]["gravity_container"])
    public_names = ["NEXT_PUBLIC_AVITO_LEADS_URL", "NEXT_PUBLIC_MAX_SCRAPER_PHONE", "NEXT_PUBLIC_FORCE_SHOW_ALL_CHANNELS"]
    args = [
        DOCKER, "build", "--pull=false",
        "--label", f"org.opencontainers.image.revision={source['commit']}",
        "--label", f"yoko.activation.profile={PROFILE_ID}",
        "--label", f"yoko.source.archive.sha256={source['archive_sha256']}",
        "--tag", TARGET_TAG,
        "--file", str(context / "Dockerfile"),
    ]
    for name in public_names:
        args.extend(["--build-arg", f"{name}={gravity_environment.get(name, '')}"])
    args.append(str(context))
    log, fd = _root_log(core, "candidate-build.log")
    try:
        _required_success(
            core,
            args,
            timeout=int(profile["limits"]["build_timeout_seconds"]),
            code="CANDIDATE_BUILD_FAILED",
            stdout_fd=fd,
            stderr_fd=fd,
        )
        os.fsync(fd)
    finally:
        os.close(fd)
        os.chmod(log, 0o600)
    image = _image_inspect(core, TARGET_TAG)
    assert image is not None
    labels = (image.get("Config") or {}).get("Labels") or {}
    if (
        labels.get("org.opencontainers.image.revision") != source["commit"]
        or labels.get("yoko.activation.profile") != PROFILE_ID
        or labels.get("yoko.source.archive.sha256") != source["archive_sha256"]
    ):
        raise core.RuntimeFault("CANDIDATE_IMAGE_IDENTITY_MISMATCH", 74)
    return image["Id"]


def _seal_rollback_image(core: Any, profile: dict[str, Any]) -> None:
    expected = profile["production"]["gravity_image_id"]
    old = _image_inspect(core, expected)
    assert old is not None
    current = _image_inspect(core, ROLLBACK_TAG, required=False)
    if current is not None and current["Id"] != expected:
        raise core.RuntimeFault("ROLLBACK_IMAGE_TAG_COLLISION", 74)
    if current is None:
        _required_success(core, [DOCKER, "tag", expected, ROLLBACK_TAG], timeout=30, code="ROLLBACK_IMAGE_SEAL_FAILED")
    sealed = _image_inspect(core, ROLLBACK_TAG)
    if sealed is None or sealed["Id"] != expected:
        raise core.RuntimeFault("ROLLBACK_IMAGE_IDENTITY_MISMATCH", 74)


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


def _release_preflight(core: Any, policy: dict[str, Any], profile: dict[str, Any], invocation: Any) -> dict[str, Any]:
    with _lock(core):
        state = _read_state(core)
        _reconcile_terminal_audit(core, state)
        if state.get("phase") in {"PREFLIGHT_READY", "MIGRATED", "ACTIVATED", "ROLLED_BACK"}:
            target = _image_inspect(core, TARGET_TAG)
            rollback = _image_inspect(core, ROLLBACK_TAG)
            if target is None or target["Id"] != state.get("target_image_id") or rollback is None or rollback["Id"] != profile["production"]["gravity_image_id"]:
                raise core.RuntimeFault("SEALED_RELEASE_IDENTITY_DRIFT", 74)
            return {
                "profile_id": PROFILE_ID,
                "status": "ALREADY_PREFLIGHTED",
                "target_image_id": target["Id"],
                "rollback_image_id": rollback["Id"],
                "production_mutation": False,
            }
        if state.get("phase") != "UNINITIALIZED":
            raise core.RuntimeFault("ACTIVATION_STATE_PHASE_INVALID", 78)
        if core.audit_status()["state"] not in {"EMPTY", "VALID"}:
            raise core.RuntimeFault("AUDIT_MUTATION_DISABLED", 78)
        inventory = _archive_inventory(core, profile)
        production = _production_preflight_identity(core, policy, profile)
        database, _ = _database_status(core, profile)
        if database["migration_state"] != "ONLY_APPROVED_OUTBOX_PENDING":
            raise core.RuntimeFault("DATABASE_NOT_READY_FOR_APPROVED_MIGRATION", 74)
        storage = _storage_guard(core, profile, int(profile["limits"]["preflight_working_bytes"]))
        intent = {**state, "phase": "PREFLIGHT_INTENT"}
        _audit(core, invocation, state, "intent", intent)
        try:
            context = _extract_source(core, profile)
            target_image_id = _build_candidate(core, profile, context)
            _seal_rollback_image(core, profile)
            next_state = {
                "schema": STATE_SCHEMA,
                "profile_id": PROFILE_ID,
                "phase": "PREFLIGHT_READY",
                "accepted_commit": profile["accepted_source"]["commit"],
                "accepted_archive_sha256": profile["accepted_source"]["archive_sha256"],
                "target_image_id": target_image_id,
                "target_tag": TARGET_TAG,
                "rollback_image_id": profile["production"]["gravity_image_id"],
                "rollback_tag": ROLLBACK_TAG,
                "production_identity": production,
                "database_identity_sha256": database["database_identity_sha256"],
                "migration_ledger_sha256": database["migration_ledger_sha256"],
                "preflight_completed_at": core.now(),
            }
            next_state = _write_terminal_state(core, invocation, intent, "ok", next_state)
        except Exception:
            _audit(core, invocation, intent, "failed", _read_state(core))
            raise
        return {
            "profile_id": PROFILE_ID,
            "status": "PREFLIGHT_READY",
            "archive_inventory": inventory,
            "target_image_id": next_state["target_image_id"],
            "rollback_image_id": next_state["rollback_image_id"],
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
    if not shape["baseline_exact"] or not shape["target_absent"] or observation["interrupted_target"] != 1:
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
        or not repaired_shape["target_absent"]
        or repaired["interrupted_target"] != 0
        or repaired["rolled_back_target"] < 1
    ):
        raise resolve_fault
    if not repaired_shape["baseline_exact"] or not repaired_shape["target_absent"] or repaired["interrupted_target"] != 0 or repaired["rolled_back_target"] < 1:
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
    if not shape["baseline_exact"] or not shape["target_active"] or observation["interrupted_target"] or catalog["state"] != "EXACT":
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
            if status["migration_state"] != "APPROVED_OUTBOX_APPLIED":
                raise core.RuntimeFault("MIGRATED_STATE_IDENTITY_DRIFT", 74)
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
                state.get("target_image_id") != (_image_inspect(core, TARGET_TAG) or {}).get("Id")
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
            or state.get("target_image_id") != (_image_inspect(core, TARGET_TAG) or {}).get("Id")
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
            if not preview_shape["baseline_exact"] or not preview_shape["target_absent"] or preview_observation["interrupted_target"]:
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


def _compose_overlay(image: str, *, activate: bool) -> bytes:
    if not re.fullmatch(r"[a-z0-9][a-z0-9./:_-]+", image) or ".." in image or "//" in image:
        raise RuntimeError("IMAGE_REFERENCE_INVALID")
    command = "    command: [\"npm\", \"run\", \"start\"]\n" if activate else ""
    return (
        "services:\n"
        "  gravity-mvp:\n"
        f"    image: {image}\n"
        f"{command}"
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
    _required_success(core, [*args, "config", "--quiet"], timeout=60, code="ACTIVATION_COMPOSE_CONFIG_INVALID")
    _validate_production_compose_inputs(core, profile, state)
    log, fd = _root_log(core, "compose-activation.log")
    try:
        _required_success(
            core,
            [*args, "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "--wait", "--wait-timeout", "180", production["compose_service"]],
            timeout=int(profile["limits"]["activation_timeout_seconds"]),
            code="GRAVITY_COMPOSE_ACTIVATION_FAILED",
            stdout_fd=fd,
            stderr_fd=fd,
        )
        os.fsync(fd)
    finally:
        os.close(fd)
        os.chmod(log, 0o600)


def _preserved_gravity_semantics(semantic: dict[str, Any]) -> dict[str, Any]:
    keys = {
        "entrypoint", "environment_names", "mounts", "name", "network_mode", "network_names",
        "privileged", "published_ports", "read_only_rootfs", "restart_policy",
    }
    return {key: semantic.get(key) for key in sorted(keys)}


def _application_health(core: Any, profile: dict[str, Any], *, require_outbox: bool = True) -> dict[str, Any]:
    container = profile["production"]["gravity_container"]
    script = (
        "const h=require('http');const q=h.get('http://127.0.0.1:3002/api/health',"
        "r=>{let b='';r.setEncoding('utf8');r.on('data',c=>{b+=c;if(b.length>1048576)q.destroy()});"
        "r.on('end',()=>{try{const v=JSON.parse(b);process.exit(r.statusCode===200&&v&&v.status==='ok'?0:2)}catch{process.exit(4)}})});"
        "q.setTimeout(10000,()=>q.destroy());q.on('error',()=>process.exit(3));"
    )
    completed = _run(core, [DOCKER, "exec", container, "node", "-e", script], timeout=15)
    if completed.returncode != 0:
        raise core.RuntimeFault("GRAVITY_APPLICATION_HEALTH_FAILED", 74)
    infra_script = (
        "const h=require('http');const q=h.get('http://127.0.0.1:3002/api/health/infra',"
        "r=>{r.resume();r.on('end',()=>process.exit(r.statusCode===200?0:2))});"
        "q.setTimeout(10000,()=>q.destroy());q.on('error',()=>process.exit(3));"
    )
    infra = _run(core, [DOCKER, "exec", container, "node", "-e", infra_script], timeout=15)
    if infra.returncode != 0:
        raise core.RuntimeFault("GRAVITY_INFRA_HEALTH_FAILED", 74)
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
        "outbox_publisher_startup_observed": publisher_observed,
        "response_body_emitted": False,
        "log_content_emitted": False,
    }


def _activation_postcheck(core: Any, policy: dict[str, Any], profile: dict[str, Any], state: dict[str, Any], *, expected_image: str, expected_semantic: dict[str, Any]) -> dict[str, Any]:
    gravity = core.container_projection(policy, "crm.container.gravity_mvp")
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
    database, _ = _database_status(core, profile)
    if database["migration_state"] != "APPROVED_OUTBOX_APPLIED":
        raise core.RuntimeFault("GRAVITY_ACTIVATION_DATABASE_DRIFT", 74)
    health = _application_health(core, profile)
    provenance = core.docker_provenance(policy)
    if not provenance["complete"]:
        raise core.RuntimeFault("PRODUCTION_PROVENANCE_INCOMPLETE", 74)
    unrelated = [item for item in provenance["semantic"]["records"] if item["name"] != profile["production"]["gravity_container"]]
    unrelated_runtime = sorted(
        (item["name"], item["container_id"], item["image_id"], item["status"], item["started_at"], item["restart_count"])
        for item in provenance["records"] if item["name"] != profile["production"]["gravity_container"]
    )
    if core.semantic_fingerprint(unrelated) != state["production_identity"]["unrelated_semantic_sha256"]:
        raise core.RuntimeFault("UNRELATED_CONTAINER_DRIFT", 74)
    if _digest(unrelated_runtime) != state["production_identity"]["unrelated_runtime_sha256"]:
        raise core.RuntimeFault("UNRELATED_CONTAINER_RUNTIME_DRIFT", 74)
    return {
        "gravity_container_id": gravity["container_id"],
        "gravity_image_id": gravity["image_id"],
        "running": gravity["running"],
        "healthy": gravity["health"] == "healthy",
        "semantics_preserved": True,
        "unrelated_containers_unchanged": True,
        "database": database,
        **health,
    }


def _rollback_impl(core: Any, policy: dict[str, Any], profile: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    rollback = _image_inspect(core, ROLLBACK_TAG)
    expected = profile["production"]["gravity_image_id"]
    if rollback is None or rollback["Id"] != expected:
        raise core.RuntimeFault("ROLLBACK_IMAGE_IDENTITY_MISMATCH", 74)
    _write_fixed_file(core, ROLLBACK_OVERLAY, _compose_overlay(ROLLBACK_TAG, activate=False), 0o400)
    _compose_up(core, profile, state, ROLLBACK_OVERLAY)
    gravity = core.container_projection(policy, "crm.container.gravity_mvp")
    if gravity["image_id"] != expected or not gravity["running"] or gravity["health"] != "healthy":
        raise core.RuntimeFault("ROLLBACK_POSTCHECK_FAILED", 74)
    original = state.get("production_identity", {}).get("gravity_semantic")
    if (
        not isinstance(original, dict)
        or _preserved_gravity_semantics(gravity["semantic"]) != _preserved_gravity_semantics(original)
        or gravity["semantic"].get("command") != original.get("command")
    ):
        raise core.RuntimeFault("ROLLBACK_SEMANTIC_DRIFT", 74)
    _application_health(core, profile, require_outbox=False)
    return {
        "gravity_container_id": gravity["container_id"],
        "gravity_image_id": gravity["image_id"],
        "running": gravity["running"],
        "healthy": gravity["health"] == "healthy",
        "original_runtime_semantics_restored": True,
        "database_schema_action": "NONE_KEEP_EXPAND_ONLY_OUTBOX",
    }


def _accept_existing_rollback(core: Any, profile: dict[str, Any], state: dict[str, Any], gravity: dict[str, Any]) -> dict[str, Any]:
    original = state.get("production_identity", {}).get("gravity_semantic")
    if (
        gravity.get("image_id") != profile["production"]["gravity_image_id"]
        or not gravity.get("running")
        or gravity.get("health") != "healthy"
        or not isinstance(original, dict)
        or _preserved_gravity_semantics(gravity.get("semantic", {})) != _preserved_gravity_semantics(original)
        or gravity.get("semantic", {}).get("command") != original.get("command")
    ):
        raise core.RuntimeFault("ROLLED_BACK_STATE_IDENTITY_DRIFT", 74)
    _validate_production_compose_inputs(core, profile, state)
    _application_health(core, profile, require_outbox=False)
    return {
        "gravity_container_id": gravity["container_id"],
        "gravity_image_id": gravity["image_id"],
        "running": True,
        "healthy": True,
        "original_runtime_semantics_restored": True,
        "database_schema_action": "NONE_KEEP_EXPAND_ONLY_OUTBOX",
    }


def _complete_activation_rollback(
    core: Any,
    policy: dict[str, Any],
    profile: dict[str, Any],
    invocation: Any,
    state: dict[str, Any],
    *,
    activation_recovery: bool,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if state.get("phase") == "RELEASE_ACTIVATION_ROLLBACK_INTENT":
        intent = state
    else:
        intent = {
            **state,
            "phase": "RELEASE_ACTIVATION_ROLLBACK_INTENT",
            "activation_failure": True,
            "activation_recovery": activation_recovery,
            "activation_rollback_intent_at": core.now(),
        }
        intent = _write_terminal_state(core, invocation, state, "activation_rollback_intent", intent)
    gravity = core.container_projection(policy, "crm.container.gravity_mvp")
    if gravity["image_id"] == profile["production"]["gravity_image_id"] and gravity["running"] and gravity["health"] == "healthy":
        rollback = _accept_existing_rollback(core, profile, intent, gravity)
    else:
        rollback = _rollback_impl(core, policy, profile, intent)
    rolled = {**intent, "phase": "ROLLED_BACK", "rollback_completed_at": core.now()}
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
            if current["image_id"] not in {profile["production"]["gravity_image_id"], state.get("target_image_id")}:
                raise core.RuntimeFault("ROLLBACK_SOURCE_IDENTITY_DRIFT", 74)
            try:
                rollback, rolled = _complete_activation_rollback(
                    core, policy, profile, invocation, state,
                    activation_recovery=bool(state.get("activation_recovery")),
                )
            except Exception:
                _audit(core, invocation, state, "activation_rollback_recovery_failed", _read_state(core))
                raise core.RuntimeFault("ACTIVATION_AND_AUTOMATIC_ROLLBACK_FAILED", 74)
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
        if current["image_id"] not in {profile["production"]["gravity_image_id"], state.get("target_image_id")}:
            raise core.RuntimeFault("GRAVITY_PREACTIVATION_IMAGE_DRIFT", 74)
        _validate_production_compose_inputs(core, profile, state)
        if not recovering:
            current_production = _production_preflight_identity(core, policy, profile)
            if _digest(current_production) != _digest(state["production_identity"]):
                raise core.RuntimeFault("PRODUCTION_IDENTITY_CHANGED_SINCE_PREFLIGHT", 74)
        target = _image_inspect(core, TARGET_TAG)
        if target is None or target["Id"] != state.get("target_image_id"):
            raise core.RuntimeFault("TARGET_IMAGE_IDENTITY_DRIFT", 74)
        status, _ = _database_status(core, profile)
        if status["migration_state"] != "APPROVED_OUTBOX_APPLIED":
            raise core.RuntimeFault("DATABASE_MIGRATION_POSTSTATE_REQUIRED", 74)
        if recovering:
            intent = state
            if current["image_id"] == state["target_image_id"]:
                try:
                    postcheck = _activation_postcheck(
                        core, policy, profile, state,
                        expected_image=state["target_image_id"],
                        expected_semantic=state["production_identity"]["gravity_semantic"],
                    )
                    next_state = {**state, "phase": "ACTIVATED", "activation_completed_at": core.now(), "activated_container_id": postcheck["gravity_container_id"]}
                    next_state = _write_terminal_state(core, invocation, state, "recovered_ok", next_state)
                    return {"profile_id": PROFILE_ID, "status": "ACTIVATED_RECOVERED", "postcheck": postcheck, "production_mutated": False, "automatic_rollback": False}
                except Exception:
                    try:
                        rollback, rolled = _complete_activation_rollback(
                            core, policy, profile, invocation, state, activation_recovery=True
                        )
                    except Exception:
                        _audit(core, invocation, state, "recovery_failed_rollback_failed", _read_state(core))
                        raise core.RuntimeFault("ACTIVATION_AND_AUTOMATIC_ROLLBACK_FAILED", 74)
                    raise core.RuntimeFault("ACTIVATION_FAILED_AUTOMATIC_ROLLBACK_OK", 74, {"rollback": rollback})
        else:
            intent = {**state, "phase": "RELEASE_ACTIVATION_INTENT", "activation_intent_at": core.now()}
            _audit(core, invocation, state, "intent", intent)
            _write_state(core, intent)
        _write_fixed_file(core, ACTIVATE_OVERLAY, _compose_overlay(TARGET_TAG, activate=True), 0o400)
        try:
            _compose_up(core, profile, state, ACTIVATE_OVERLAY)
            postcheck = _activation_postcheck(
                core, policy, profile, state,
                expected_image=state["target_image_id"],
                expected_semantic=state["production_identity"]["gravity_semantic"],
            )
            next_state = {**state, "phase": "ACTIVATED", "activation_completed_at": core.now(), "activated_container_id": postcheck["gravity_container_id"]}
            next_state = _write_terminal_state(core, invocation, intent, "ok", next_state)
            return {"profile_id": PROFILE_ID, "status": "ACTIVATED", "postcheck": postcheck, "production_mutated": True, "automatic_rollback": False}
        except Exception:
            try:
                rollback, rolled = _complete_activation_rollback(
                    core, policy, profile, invocation, intent, activation_recovery=False
                )
            except Exception:
                _audit(core, invocation, intent, "failed_rollback_failed", _read_state(core))
                raise core.RuntimeFault("ACTIVATION_AND_AUTOMATIC_ROLLBACK_FAILED", 74)
            raise core.RuntimeFault("ACTIVATION_FAILED_AUTOMATIC_ROLLBACK_OK", 74, {"rollback": rollback})


def _rollback(core: Any, policy: dict[str, Any], profile: dict[str, Any], invocation: Any) -> dict[str, Any]:
    with _lock(core):
        state = _read_state(core)
        _reconcile_terminal_audit(core, state)
        if state.get("phase") == "ROLLED_BACK":
            gravity = core.container_projection(policy, "crm.container.gravity_mvp")
            result = _accept_existing_rollback(core, profile, state, gravity)
            return {"profile_id": PROFILE_ID, "status": "ALREADY_ROLLED_BACK", "postcheck": result, "production_mutated": False}
        recovering = state.get("phase") == "ROLLBACK_INTENT"
        if state.get("phase") not in {"ACTIVATED", "RELEASE_ACTIVATION_INTENT", "ROLLBACK_INTENT"}:
            raise core.RuntimeFault("ROLLBACK_NOT_AVAILABLE_IN_CURRENT_PHASE", 77)
        if core.audit_status()["state"] not in {"EMPTY", "VALID"}:
            raise core.RuntimeFault("AUDIT_MUTATION_DISABLED", 78)
        gravity = core.container_projection(policy, "crm.container.gravity_mvp")
        allowed = {state.get("target_image_id"), profile["production"]["gravity_image_id"]}
        if gravity["image_id"] not in allowed:
            raise core.RuntimeFault("ROLLBACK_SOURCE_IDENTITY_DRIFT", 74)
        if recovering:
            intent = state
        else:
            intent = {**state, "phase": "ROLLBACK_INTENT", "rollback_intent_at": core.now()}
            intent = _write_terminal_state(core, invocation, state, "intent", intent)
        production_mutated = False
        try:
            if gravity["image_id"] == profile["production"]["gravity_image_id"]:
                if gravity["running"] and gravity["health"] == "healthy":
                    result = _accept_existing_rollback(core, profile, intent, gravity)
                else:
                    result = _rollback_impl(core, policy, profile, intent)
                    production_mutated = True
            else:
                result = _rollback_impl(core, policy, profile, intent)
                production_mutated = True
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
        return _database_migrate(core, profile, invocation)
    if invocation.primitive == "release-activate":
        return _release_activate(core, policy, profile, invocation)
    if invocation.primitive == "rollback":
        return _rollback(core, policy, profile, invocation)
    raise core.RuntimeFault("PROFILE_DISABLED", 77, {"profile": invocation.primitive.replace("-", "_")})
