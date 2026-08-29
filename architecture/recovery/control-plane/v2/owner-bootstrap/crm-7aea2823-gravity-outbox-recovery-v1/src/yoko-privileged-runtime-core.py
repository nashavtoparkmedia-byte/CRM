#!/usr/bin/python3 -I
"""Stable finite capability runtime for the YOKO CRM project.

This program intentionally contains only access to root-protected, registered
resources. Workflow planning, source comparison and reports belong to the
unprivileged project orchestrator.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


VERSION = "2.0.0"
RESPONSE_SCHEMA = "yoko.privileged-runtime.response.v1"
AUDIT_SCHEMA = "yoko.privileged-runtime.audit.v1"
POLICY_SCHEMA = "yoko.privileged-runtime.policy.v2"
INSTALL_SCHEMA = "yoko.privileged-runtime.install-manifest.v1"
TEST_ENV = "YOKO_PRIVILEGED_RUNTIME_TEST_ROOT"
SELF = "/usr/local/sbin/yoko-privileged-runtime"
POLICY = "/usr/local/share/yoko-privileged-runtime/policy.v2.json"
INSTALL_MANIFEST = "/usr/local/share/yoko-privileged-runtime/install-manifest.v1.json"
SUDOERS = "/etc/sudoers.d/92-yoko-privileged-runtime"
STATE_ROOT = "/var/lib/yoko-privileged-runtime"
AUDIT_DIR = STATE_ROOT + "/audit"
AUDIT_LOG = AUDIT_DIR + "/primitive-ledger.jsonl"
DOCKER = "/usr/bin/docker"
VISUDO = "/usr/sbin/visudo"
CALLER = "codexbot"
CALLER_UID = 998
CALLER_GID = 998
LOGICAL_ID = re.compile(r"[a-z][a-z0-9_.-]{2,95}")
SHA256 = re.compile(r"[0-9a-f]{64}")
RELATIVE_PATH = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,239}")
_test_root: Path | None = None


class RuntimeFault(RuntimeError):
    def __init__(self, code: str, exit_code: int = 70, details: dict[str, Any] | None = None):
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code
        self.details = details or {}


@dataclass(frozen=True)
class Invocation:
    primitive: str
    resource: str | None
    relative_path: str | None = None


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def mapped(path: str) -> Path:
    if not path.startswith("/"):
        raise RuntimeFault("INTERNAL_PATH_INVALID")
    return Path(path) if _test_root is None else _test_root / path.lstrip("/")


def expected_owner() -> tuple[int, int]:
    return (0, 0) if _test_root is None else (os.geteuid(), os.getegid())


def configure_mode() -> None:
    global _test_root
    supplied = os.environ.get(TEST_ENV)
    if supplied is None:
        if os.geteuid() != 0 or os.getresuid() != (0, 0, 0):
            raise RuntimeFault("ROOT_REQUIRED", 77)
        _test_root = None
        return
    if os.geteuid() == 0:
        raise RuntimeFault("TEST_MODE_FORBIDDEN_AS_ROOT", 77)
    candidate = Path(supplied)
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise RuntimeFault("TEST_ROOT_INVALID", 77) from exc
    value = candidate.lstat()
    if not candidate.is_absolute() or resolved != candidate or not stat.S_ISDIR(value.st_mode):
        raise RuntimeFault("TEST_ROOT_INVALID", 77)
    if value.st_uid != os.geteuid() or stat.S_IMODE(value.st_mode) & 0o022:
        raise RuntimeFault("TEST_ROOT_UNSAFE", 77)
    _test_root = candidate


def command_env() -> dict[str, str]:
    return {
        "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "HOME": "/nonexistent",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
    }


def secure_ancestors(path: str) -> None:
    current = mapped("/")
    for part in Path(path).parts[1:-1]:
        current = current / part
        value = current.lstat()
        uid, gid = expected_owner()
        if current.is_symlink() or not stat.S_ISDIR(value.st_mode) or value.st_uid != uid or value.st_gid != gid:
            raise RuntimeFault("UNSAFE_ANCESTOR")
        if stat.S_IMODE(value.st_mode) & 0o022:
            raise RuntimeFault("UNSAFE_ANCESTOR")


def secure_file(path: str, mode: int, *, maximum: int = 32 * 1024 * 1024) -> os.stat_result:
    secure_ancestors(path)
    target = mapped(path)
    value = target.lstat()
    uid, gid = expected_owner()
    if target.is_symlink() or not stat.S_ISREG(value.st_mode):
        raise RuntimeFault("UNSAFE_FILE")
    if value.st_uid != uid or value.st_gid != gid or stat.S_IMODE(value.st_mode) != mode or value.st_nlink != 1:
        raise RuntimeFault("UNSAFE_FILE")
    if value.st_size < 0 or value.st_size > maximum:
        raise RuntimeFault("FILE_SIZE_INVALID")
    return value


def secure_directory(path: str, mode: int = 0o700, *, create: bool = False) -> os.stat_result:
    target = mapped(path)
    if create and not target.exists():
        target.mkdir(parents=True, mode=mode)
    secure_ancestors(path + "/x")
    value = target.lstat()
    uid, gid = expected_owner()
    if target.is_symlink() or not stat.S_ISDIR(value.st_mode):
        raise RuntimeFault("UNSAFE_DIRECTORY")
    if value.st_uid != uid or value.st_gid != gid or stat.S_IMODE(value.st_mode) != mode:
        raise RuntimeFault("UNSAFE_DIRECTORY")
    return value


def hash_file(path: Path, *, maximum: int = 32 * 1024 * 1024) -> str:
    value = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(value.st_mode) or value.st_size > maximum:
        raise RuntimeFault("UNSAFE_FILE")
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        result = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > maximum:
                raise RuntimeFault("FILE_SIZE_INVALID")
            result.update(chunk)
        return result.hexdigest()
    finally:
        os.close(fd)


def parse_json(raw: bytes, *, maximum: int) -> Any:
    if len(raw) > maximum:
        raise RuntimeFault("JSON_TOO_LARGE", 65)
    def reject_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        output: dict[str, Any] = {}
        for key, value in pairs:
            if key in output:
                raise ValueError("duplicate")
            output[key] = value
        return output
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=reject_pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("constant")))
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeFault("JSON_INVALID", 65) from exc


def load_policy() -> dict[str, Any]:
    value = secure_file(POLICY, 0o444, maximum=2 * 1024 * 1024)
    policy = parse_json(mapped(POLICY).read_bytes(), maximum=value.st_size + 1)
    if not isinstance(policy, dict) or policy.get("schema") != POLICY_SCHEMA or policy.get("runtime_version") != VERSION:
        raise RuntimeFault("POLICY_INVALID", 78)
    caller = policy.get("caller")
    limits = policy.get("limits")
    resources = policy.get("resources")
    if not isinstance(caller, dict) or caller != {"user": CALLER, "uid": CALLER_UID, "gid": CALLER_GID}:
        raise RuntimeFault("POLICY_CALLER_INVALID", 78)
    if not isinstance(limits, dict) or not isinstance(resources, dict) or not resources:
        raise RuntimeFault("POLICY_INVALID", 78)
    required_limits = {
        "command_timeout_seconds": (1, 120),
        "max_json_bytes": (1024, 8 * 1024 * 1024),
        "max_tree_entries": (1, 100_000),
        "max_tree_bytes": (1024, 1024 * 1024 * 1024),
        "minimum_free_bytes": (0, 1024 * 1024 * 1024 * 1024),
    }
    if set(limits) != set(required_limits):
        raise RuntimeFault("POLICY_LIMITS_INVALID", 78)
    for key, (minimum, maximum) in required_limits.items():
        if not isinstance(limits[key], int) or isinstance(limits[key], bool) or not minimum <= limits[key] <= maximum:
            raise RuntimeFault("POLICY_LIMITS_INVALID", 78)
    labels = policy.get("safe_labels")
    if not isinstance(labels, list) or len(labels) > 64 or not all(isinstance(label, str) and re.fullmatch(r"[a-z0-9][a-z0-9_.-]{1,127}", label) for label in labels):
        raise RuntimeFault("POLICY_LABELS_INVALID", 78)
    if len(set(labels)) != len(labels) or not isinstance(policy.get("disabled_profiles"), dict):
        raise RuntimeFault("POLICY_INVALID", 78)
    for logical, record in resources.items():
        if not isinstance(logical, str) or not LOGICAL_ID.fullmatch(logical) or not isinstance(record, dict):
            raise RuntimeFault("POLICY_RESOURCE_INVALID", 78)
        kind = record.get("kind")
        operations = record.get("operations")
        if kind not in {"directory", "container"} or not isinstance(operations, list) or not all(isinstance(item, str) for item in operations):
            raise RuntimeFault("POLICY_RESOURCE_INVALID", 78)
        if kind == "directory" and (not isinstance(record.get("path"), str) or not record["path"].startswith("/")):
            raise RuntimeFault("POLICY_RESOURCE_INVALID", 78)
        if kind == "directory":
            for key in ("secret_names", "excluded_directories", "readable_files"):
                values = record.get(key, [])
                if not isinstance(values, list) or len(values) > 2_000 or not all(isinstance(item, str) and item and ("/" not in item if key != "readable_files" else valid_relative_path(item)) for item in values):
                    raise RuntimeFault("POLICY_RESOURCE_INVALID", 78)
                if len(set(values)) != len(values):
                    raise RuntimeFault("POLICY_RESOURCE_INVALID", 78)
        if kind == "container" and (not isinstance(record.get("name"), str) or not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{1,95}", record["name"])):
            raise RuntimeFault("POLICY_RESOURCE_INVALID", 78)
    return policy


def valid_relative_path(value: str) -> bool:
    return bool(
        RELATIVE_PATH.fullmatch(value)
        and not value.startswith("/")
        and "//" not in value
        and all(part not in {"", ".", ".."} for part in value.split("/"))
    )


def policy_sha256() -> str:
    return hash_file(mapped(POLICY), maximum=2 * 1024 * 1024)


def registry_sha256(policy: dict[str, Any]) -> str:
    return hashlib.sha256(canonical(policy["resources"])).hexdigest()


def verify_caller(policy: dict[str, Any]) -> None:
    if _test_root is not None:
        return
    if (
        os.environ.get("SUDO_USER") != CALLER
        or os.environ.get("SUDO_UID") != str(CALLER_UID)
        or os.environ.get("SUDO_GID") != str(CALLER_GID)
        or socket.gethostname() != policy.get("host")
    ):
        raise RuntimeFault("CALLER_IDENTITY_INVALID", 77)


def caller_can_write(path: Path) -> bool:
    if _test_root is not None:
        return os.access(path, os.W_OK, effective_ids=True, follow_symlinks=False)
    read_fd, write_fd = os.pipe2(os.O_CLOEXEC)
    pid = os.fork()
    if pid == 0:
        try:
            os.close(read_fd)
            os.initgroups(CALLER, CALLER_GID)
            os.setresgid(CALLER_GID, CALLER_GID, CALLER_GID)
            os.setresuid(CALLER_UID, CALLER_UID, CALLER_UID)
            permitted = os.access(path, os.W_OK, effective_ids=True, follow_symlinks=False)
            os.write(write_fd, b"1" if permitted else b"0")
        finally:
            os._exit(0)
    os.close(write_fd)
    try:
        observed = os.read(read_fd, 1)
    finally:
        os.close(read_fd)
        os.waitpid(pid, 0)
    return observed == b"1"


def assert_noncaller_writable_chain(path: Path) -> None:
    if _test_root is not None:
        return
    current = Path("/")
    for part in path.parts[1:]:
        current = current / part
        value = current.lstat()
        if current.is_symlink() or caller_can_write(current):
            raise RuntimeFault("RESOURCE_CALLER_WRITABLE", 74)
        if not stat.S_ISDIR(value.st_mode) and current != path:
            raise RuntimeFault("RESOURCE_ANCESTOR_INVALID", 74)


def run_fixed(args: list[str], *, timeout: int) -> subprocess.CompletedProcess[bytes]:
    if not args or not args[0].startswith("/"):
        raise RuntimeFault("INTERNAL_EXECUTABLE_INVALID")
    executable = str(mapped(args[0]))
    try:
        return subprocess.run(
            [executable, *args[1:]],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=command_env(),
            cwd=str(_test_root or Path("/")),
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise RuntimeFault("FIXED_BINARY_UNAVAILABLE", 74) from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeFault("FIXED_COMMAND_TIMEOUT", 74) from exc


def ensure_state() -> None:
    secure_directory(STATE_ROOT, 0o700, create=True)
    secure_directory(AUDIT_DIR, 0o700, create=True)


def audit_status() -> dict[str, Any]:
    ensure_state()
    target = mapped(AUDIT_LOG)
    if not target.exists():
        return {"state": "EMPTY", "record_count": 0, "last_digest": "0" * 64}
    value = target.lstat()
    uid, gid = expected_owner()
    if target.is_symlink() or not stat.S_ISREG(value.st_mode) or value.st_uid != uid or value.st_gid != gid or stat.S_IMODE(value.st_mode) != 0o600 or value.st_nlink != 1:
        return {"state": "INVALID", "reason": "AUDIT_FILE_SECURITY"}
    if value.st_size > 32 * 1024 * 1024:
        return {"state": "INVALID", "reason": "AUDIT_TOO_LARGE"}
    previous = "0" * 64
    count = 0
    try:
        lines = target.read_bytes().splitlines()
        for line in lines:
            record = parse_json(line, maximum=16 * 1024)
            required = {
                "schema", "sequence", "timestamp", "caller_uid", "primitive", "resource",
                "request_digest", "pre_state_digest", "result", "post_state_digest",
                "previous_digest", "record_digest",
            }
            if not isinstance(record, dict) or set(record) != required or record.get("schema") != AUDIT_SCHEMA:
                return {"state": "INVALID", "reason": "AUDIT_SCHEMA"}
            body = dict(record)
            supplied = body.pop("record_digest")
            if (
                record.get("sequence") != count + 1
                or record.get("previous_digest") != previous
                or not isinstance(record.get("caller_uid"), int)
                or not isinstance(record.get("primitive"), str)
                or not isinstance(record.get("resource"), (str, type(None)))
                or not all(isinstance(record.get(key), str) and SHA256.fullmatch(record[key]) for key in ("request_digest", "pre_state_digest", "post_state_digest", "previous_digest"))
                or not isinstance(supplied, str)
                or not SHA256.fullmatch(supplied)
                or hashlib.sha256(canonical(body)).hexdigest() != supplied
            ):
                return {"state": "INVALID", "reason": "AUDIT_RECORD"}
            previous = supplied
            count += 1
    except (OSError, RuntimeFault):
        return {"state": "INVALID", "reason": "AUDIT_PARSE"}
    return {"state": "VALID", "record_count": count, "last_digest": previous}


def append_audit(invocation: Invocation, request_digest: str, pre: str, result: str, post: str) -> None:
    status = audit_status()
    if status["state"] not in {"EMPTY", "VALID"}:
        raise RuntimeFault("AUDIT_MUTATION_DISABLED", 78)
    target = mapped(AUDIT_LOG)
    fd = os.open(target, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        previous = status["last_digest"]
        body = {
            "schema": AUDIT_SCHEMA,
            "sequence": int(status["record_count"]) + 1,
            "timestamp": now(),
            "caller_uid": CALLER_UID if _test_root is None else os.geteuid(),
            "primitive": invocation.primitive,
            "resource": invocation.resource,
            "request_digest": request_digest,
            "pre_state_digest": pre,
            "result": result,
            "post_state_digest": post,
            "previous_digest": previous,
        }
        body["record_digest"] = hashlib.sha256(canonical(body)).hexdigest()
        os.write(fd, canonical(body) + b"\n")
        os.fsync(fd)
    finally:
        os.close(fd)


def parse_cli(argv: list[str]) -> Invocation:
    if len(argv) < 2:
        raise RuntimeFault("INPUT_INVALID", 64)
    command = argv[1:]
    zero = {"version", "self-check", "capabilities", "policy-status", "registry-status", "audit-status", "storage-status", "docker-provenance", "recovery-status"}
    one = {"fs-stat", "fs-tree", "snapshot-manifest", "git-index", "docker-inspect", "service-status", "service-health", "service-restart"}
    disabled = {"release-preflight", "release-activate", "config-activate", "database-status", "database-migrate", "rollback"}
    if len(command) == 1 and command[0] in zero:
        return Invocation(command[0], None)
    if len(command) == 2 and command[0] in one and LOGICAL_ID.fullmatch(command[1]):
        return Invocation(command[0], command[1])
    if len(command) == 3 and command[0] == "fs-read" and LOGICAL_ID.fullmatch(command[1]) and valid_relative_path(command[2]):
        return Invocation(command[0], command[1], command[2])
    if len(command) == 1 and command[0] in disabled:
        return Invocation(command[0], None)
    raise RuntimeFault("INPUT_INVALID", 64)


def resource(policy: dict[str, Any], invocation: Invocation, kind: str | None = None) -> dict[str, Any]:
    if invocation.resource is None or invocation.resource not in policy["resources"]:
        raise RuntimeFault("RESOURCE_UNKNOWN", 64)
    record = policy["resources"][invocation.resource]
    if kind is not None and record.get("kind") != kind:
        raise RuntimeFault("RESOURCE_KIND_INVALID", 64)
    if invocation.primitive not in record["operations"]:
        raise RuntimeFault("RESOURCE_OPERATION_DENIED", 77)
    return record


def safe_text(value: Any, limit: int = 4096) -> str:
    if not isinstance(value, str):
        return ""
    value = "".join(char for char in value if ord(char) >= 32 and char != "\x7f")
    return value[:limit]


def safe_command(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 32:
        return ["[REDACTED_INVALID]"]
    return [safe_text(item, 1024) for item in value]


def semantic_command(value: Any, container_name: str) -> list[str]:
    """Project fixed command projection with known secret positions removed."""
    command = safe_command(value)
    if container_name != "crm-redis":
        return command
    output: list[str] = []
    redact_next = False
    observed_flag = False
    for item in command:
        if redact_next:
            output.append("[SECRET_EXCLUDED]")
            redact_next = False
            continue
        if item == "--requirepass":
            output.append(item)
            redact_next = True
            observed_flag = True
            continue
        if item.startswith("--requirepass="):
            output.append("--requirepass=[SECRET_EXCLUDED]")
            observed_flag = True
            continue
        replaced, count = re.subn(
            r"(--requirepass(?:=|\s+))\S+",
            r"\1[SECRET_EXCLUDED]",
            item,
        )
        observed_flag = observed_flag or count > 0
        output.append(replaced)
    if redact_next or not observed_flag:
        raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
    return output


def semantic_environment_names(value: Any) -> list[str]:
    """Return environment names only; values never enter the projection."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 1024:
        raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
    names: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
        name, separator, _value = item.partition("=")
        if (
            not separator
            or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", name)
            or name in names
        ):
            raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
        names.append(name)
    return sorted(names)


def semantic_compose_labels(labels: Any) -> dict[str, str]:
    if labels is None:
        labels = {}
    if not isinstance(labels, dict):
        raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
    allowed = (
        "com.docker.compose.project",
        "com.docker.compose.service",
        "com.docker.compose.config-hash",
    )
    return {
        key: safe_text(labels[key], 512)
        for key in allowed
        if key in labels and isinstance(labels[key], str) and safe_text(labels[key], 512)
    }


def semantic_network_names(value: Any) -> list[str]:
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
    names = sorted(value)
    if any(not isinstance(name, str) or not name or len(name) > 255 for name in names):
        raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
    return names


def semantic_published_ports(value: Any) -> dict[str, list[dict[str, str]]]:
    """Normalize host bindings and omit exposed-but-unpublished ports."""
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
    result: dict[str, list[dict[str, str]]] = {}
    for container_port in sorted(value):
        if not isinstance(container_port, str) or not container_port:
            raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
        bindings = value[container_port]
        if bindings is None:
            continue
        if not isinstance(bindings, list):
            raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
        normalized: list[dict[str, str]] = []
        for binding in bindings:
            if not isinstance(binding, dict):
                raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
            host_ip = safe_text(binding.get("HostIp"), 255)
            host_port = safe_text(binding.get("HostPort"), 16)
            if not host_ip or not host_port:
                raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
            normalized.append({"host_ip": host_ip, "host_port": host_port})
        if normalized:
            result[container_port] = sorted(normalized, key=lambda item: (item["host_ip"], item["host_port"]))
    return result


def semantic_mounts(mounts: Any) -> list[dict[str, Any]]:
    if mounts is None:
        return []
    if not isinstance(mounts, list) or len(mounts) > 128:
        raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
    output: list[dict[str, Any]] = []
    for mount in mounts:
        if not isinstance(mount, dict):
            raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
        kind = safe_text(mount.get("Type"), 64)
        destination = safe_text(mount.get("Destination"), 4096)
        source = safe_text(mount.get("Source"), 4096)
        if not kind or not destination or (kind != "tmpfs" and not source):
            raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
        output.append({
            "destination": destination,
            "read_only": mount.get("RW") is False,
            "source_sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
            "type": kind,
        })
    return sorted(output, key=lambda item: (item["destination"], item["type"], item["source_sha256"]))


def semantic_restart_policy(value: Any) -> dict[str, Any]:
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
    name = safe_text(value.get("Name"), 64)
    count = value.get("MaximumRetryCount", 0)
    if not name or isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
    return {"maximum_retry_count": count, "name": name}


def semantic_record(raw: dict[str, Any]) -> dict[str, Any]:
    config = raw.get("Config") or {}
    host = raw.get("HostConfig") or {}
    network = raw.get("NetworkSettings") or {}
    if not isinstance(config, dict) or not isinstance(host, dict) or not isinstance(network, dict):
        raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
    name = safe_text(raw.get("Name"), 256).lstrip("/")
    image_id = safe_text(raw.get("Image"), 128)
    network_mode = safe_text(host.get("NetworkMode"), 255)
    if (
        not name
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id)
        or not network_mode
    ):
        raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
    return {
        "command": semantic_command(config.get("Cmd"), name),
        "compose_labels": semantic_compose_labels(config.get("Labels")),
        "entrypoint": safe_command(config.get("Entrypoint")),
        "environment_names": semantic_environment_names(config.get("Env")),
        "image_id": image_id,
        "mounts": semantic_mounts(raw.get("Mounts")),
        "name": name,
        "network_mode": network_mode,
        "network_names": semantic_network_names(network.get("Networks")),
        "privileged": host.get("Privileged") is True,
        "published_ports": semantic_published_ports(network.get("Ports")),
        "read_only_rootfs": host.get("ReadonlyRootfs") is True,
        "restart_policy": semantic_restart_policy(host.get("RestartPolicy")),
    }


def semantic_fingerprint(records: list[dict[str, Any]]) -> str:
    payload = {
        "records": sorted(records, key=lambda item: str(item["name"])),
        "schema": "yoko.ai-calls.production-semantic-identity.v1",
    }
    return hashlib.sha256(canonical(payload)).hexdigest()


def docker_error(completed: subprocess.CompletedProcess[bytes]) -> RuntimeFault:
    text = completed.stderr.lower()
    if b"no such container" in text or b"no such object" in text:
        return RuntimeFault("CONTAINER_NOT_FOUND", 74)
    if b"permission denied" in text:
        return RuntimeFault("DOCKER_PERMISSION_FAILED", 74)
    if b"cannot connect to the docker daemon" in text or b"connection refused" in text or b"is the docker daemon running" in text:
        return RuntimeFault("DOCKER_DAEMON_UNAVAILABLE", 74)
    return RuntimeFault("DOCKER_INSPECT_NONZERO", 74)


def docker_json(args: list[str], policy: dict[str, Any]) -> dict[str, Any]:
    try:
        completed = run_fixed([DOCKER, *args], timeout=int(policy["limits"]["command_timeout_seconds"]))
    except RuntimeFault as exc:
        if exc.code == "FIXED_BINARY_UNAVAILABLE":
            raise RuntimeFault("DOCKER_BINARY_UNAVAILABLE", 74) from exc
        if exc.code == "FIXED_COMMAND_TIMEOUT":
            raise RuntimeFault("DOCKER_INSPECT_TIMEOUT", 74) from exc
        raise
    if completed.returncode != 0:
        raise docker_error(completed)
    if len(completed.stdout) > int(policy["limits"]["max_json_bytes"]):
        raise RuntimeFault("DOCKER_JSON_TOO_LARGE", 74)
    value = parse_json(completed.stdout, maximum=int(policy["limits"]["max_json_bytes"]))
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise RuntimeFault("DOCKER_INSPECT_JSON_INVALID", 74)
    return value[0]


def safe_labels(labels: Any, policy: dict[str, Any]) -> dict[str, str]:
    if not isinstance(labels, dict):
        return {}
    return {
        key: safe_text(labels[key], 1024)
        for key in policy["safe_labels"]
        if key in labels and isinstance(labels[key], str)
    }


def safe_mounts(mounts: Any) -> list[dict[str, Any]]:
    if not isinstance(mounts, list):
        raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
    output = []
    for mount in mounts:
        if not isinstance(mount, dict):
            raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
        kind = safe_text(mount.get("Type"), 32)
        if kind not in {"bind", "volume", "tmpfs"}:
            continue
        item = {
            "type": kind,
            "target": safe_text(mount.get("Destination"), 1024),
            "read_write": bool(mount.get("RW")),
        }
        if kind == "bind":
            source = safe_text(mount.get("Source"), 1024)
            item["source"] = source if source == "/opt/crm" or source.startswith("/opt/crm/") else "[REDACTED_BIND_SOURCE]"
        if kind == "volume":
            item["name"] = safe_text(mount.get("Name"), 256)
        output.append(item)
    return sorted(output, key=lambda item: (item["target"], item["type"]))


def container_projection(policy: dict[str, Any], logical: str) -> dict[str, Any]:
    record = resource(policy, Invocation("docker-inspect", logical), "container")
    raw = docker_json(["container", "inspect", record["name"]], policy)
    actual_name = safe_text(raw.get("Name"), 256).lstrip("/")
    if actual_name != record["name"]:
        raise RuntimeFault("CONTAINER_IDENTITY_MISMATCH", 74)
    container_id = safe_text(raw.get("Id"), 128)
    image_id = safe_text(raw.get("Image"), 128)
    if not re.fullmatch(r"[0-9a-f]{64}", container_id) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
    config = raw.get("Config")
    state = raw.get("State")
    if not isinstance(config, dict) or not isinstance(state, dict):
        raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
    image: dict[str, Any] | None = None
    image_config: dict[str, Any] = {}
    image_metadata_status = "available"
    try:
        candidate = docker_json(["image", "inspect", image_id], policy)
        if safe_text(candidate.get("Id"), 128) != image_id or not isinstance(candidate.get("Config"), dict):
            raise RuntimeFault("DOCKER_SAFE_PROJECTION_FAILED", 74)
        image = candidate
        image_config = candidate["Config"]
    except RuntimeFault as exc:
        if exc.code not in {"CONTAINER_NOT_FOUND", "DOCKER_INSPECT_NONZERO"}:
            raise
        # A running container remains content-addressed by raw.Image even if
        # Docker's removable local image metadata object has been pruned.
        image_metadata_status = "unavailable"
    return {
        "logical_resource": logical,
        "container_id": container_id,
        "name": actual_name,
        "image_id": image_id,
        "config_image": safe_text(config.get("Image"), 1024),
        "repo_digests": sorted(safe_text(item, 2048) for item in (image or {}).get("RepoDigests", []) if isinstance(item, str)),
        "image_created": safe_text((image or {}).get("Created"), 128),
        "image_metadata_status": image_metadata_status,
        "platform": (safe_text((image or {}).get("Os"), 32) + "/" + safe_text((image or {}).get("Architecture"), 32)).strip("/"),
        "created": safe_text(raw.get("Created"), 128),
        "started_at": safe_text(state.get("StartedAt"), 128),
        "status": safe_text(state.get("Status"), 64),
        "running": bool(state.get("Running")),
        "restart_count": int(raw.get("RestartCount") or 0),
        "health": safe_text((state.get("Health") or {}).get("Status"), 64),
        "working_dir": safe_text(config.get("WorkingDir"), 1024),
        "declared_user": safe_text(config.get("User"), 256),
        "entrypoint": safe_command(config.get("Entrypoint")),
        "cmd": semantic_command(config.get("Cmd"), actual_name),
        "mounts": safe_mounts(raw.get("Mounts")),
        "compose_labels": safe_labels(config.get("Labels"), policy),
        "oci_labels": safe_labels(image_config.get("Labels"), policy),
        "semantic": semantic_record(raw),
    }


def docker_provenance(policy: dict[str, Any]) -> dict[str, Any]:
    records = []
    failures = []
    for logical, record in sorted(policy["resources"].items()):
        if record["kind"] != "container" or "docker-inspect" not in record["operations"]:
            continue
        try:
            records.append(container_projection(policy, logical))
        except RuntimeFault as exc:
            failures.append({"logical_resource": logical, "code": exc.code})
    semantic_records = sorted(
        [record["semantic"] for record in records],
        key=lambda item: str(item["name"]),
    )
    semantic = {
        "schema": "yoko.ai-calls.production-semantic-identity.v1",
        "records": semantic_records,
        "fingerprint_sha256": semantic_fingerprint(semantic_records) if not failures else None,
    }
    return {
        "records": records,
        "failures": failures,
        "complete": not failures,
        "semantic": semantic,
    }


def directory_record(policy: dict[str, Any], invocation: Invocation) -> tuple[dict[str, Any], Path]:
    record = resource(policy, invocation, "directory")
    path = mapped(record["path"])
    value = path.lstat()
    if path.is_symlink() or not stat.S_ISDIR(value.st_mode) or stat.S_IMODE(value.st_mode) & 0o022:
        raise RuntimeFault("RESOURCE_DIRECTORY_UNSAFE", 74)
    assert_noncaller_writable_chain(path)
    return record, path


def registered_relative_file(policy: dict[str, Any], logical: str, relative: str) -> tuple[dict[str, Any], Path]:
    invocation = Invocation("fs-read", logical)
    record, root = directory_record(policy, invocation)
    if not valid_relative_path(relative) or relative not in record.get("readable_files", []):
        raise RuntimeFault("FILE_READ_DENIED", 77)
    candidate = root / relative
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise RuntimeFault("FILE_READ_DENIED", 77) from exc
    current = root
    for part in relative.split("/")[:-1]:
        current = current / part
        value = current.lstat()
        if current.is_symlink() or not stat.S_ISDIR(value.st_mode) or caller_can_write(current):
            raise RuntimeFault("FILE_READ_UNSAFE", 74)
    value = candidate.lstat()
    if candidate.is_symlink() or not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
        raise RuntimeFault("FILE_READ_UNSAFE", 74)
    return record, candidate


def bounded_file_read(policy: dict[str, Any], invocation: Invocation) -> dict[str, Any]:
    if invocation.resource is None or invocation.relative_path is None:
        raise RuntimeFault("INPUT_INVALID", 64)
    _, candidate = registered_relative_file(policy, invocation.resource, invocation.relative_path)
    limit = min(int(policy["limits"]["max_json_bytes"]), 256 * 1024)
    value = candidate.lstat()
    if value.st_size > limit:
        raise RuntimeFault("FILE_READ_TOO_LARGE", 74)
    fd = os.open(candidate, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        raw = os.read(fd, limit + 1)
    finally:
        os.close(fd)
    if len(raw) > limit:
        raise RuntimeFault("FILE_READ_TOO_LARGE", 74)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RuntimeFault("FILE_READ_NOT_UTF8", 74) from exc
    return {
        "logical_resource": invocation.resource,
        "relative_path": invocation.relative_path,
        "metadata": stat_projection(candidate),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "utf8": text,
    }


def stat_projection(path: Path) -> dict[str, Any]:
    value = path.lstat()
    return {
        "type": "directory" if stat.S_ISDIR(value.st_mode) else "file" if stat.S_ISREG(value.st_mode) else "other",
        "mode": format(stat.S_IMODE(value.st_mode), "04o"),
        "uid": value.st_uid,
        "gid": value.st_gid,
        "inode": value.st_ino,
        "device": value.st_dev,
        "size": value.st_size,
        "hardlinks": value.st_nlink,
        "mtime_ns": value.st_mtime_ns,
    }


def secret_name(name: str, configured: set[str]) -> bool:
    lowered = name.lower()
    return (
        name in configured
        or lowered == ".env"
        or lowered.startswith(".env.")
        or lowered.endswith((".key", ".pem", ".p12", ".pfx"))
        or "secret" in lowered
        or lowered in {"id_rsa", "id_ed25519", "authorized_keys"}
    )


def tree_manifest(policy: dict[str, Any], invocation: Invocation) -> dict[str, Any]:
    record, root = directory_record(policy, invocation)
    excluded_dirs = set(record.get("excluded_directories", []))
    secret_names = set(record.get("secret_names", []))
    entries: list[dict[str, Any]] = []
    excluded = {"directories": 0, "secret_names": 0, "special": 0, "oversized": 0}
    total_bytes = 0
    maximum_entries = int(policy["limits"]["max_tree_entries"])
    maximum_bytes = int(policy["limits"]["max_tree_bytes"])
    for current, names, files in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        names.sort()
        files.sort()
        next_names = []
        for name in names:
            if name in excluded_dirs:
                excluded["directories"] += 1
                continue
            if secret_name(name, secret_names):
                excluded["secret_names"] += 1
                continue
            child = current_path / name
            child_value = child.lstat()
            if child.is_symlink() or not stat.S_ISDIR(child_value.st_mode):
                excluded["special"] += 1
                continue
            next_names.append(name)
        names[:] = next_names
        for name in files:
            if secret_name(name, secret_names):
                excluded["secret_names"] += 1
                continue
            child = current_path / name
            child_value = child.lstat()
            if child.is_symlink() or not stat.S_ISREG(child_value.st_mode) or child_value.st_nlink != 1:
                excluded["special"] += 1
                continue
            if child_value.st_size > maximum_bytes:
                excluded["oversized"] += 1
                continue
            total_bytes += child_value.st_size
            if total_bytes > maximum_bytes or len(entries) >= maximum_entries:
                raise RuntimeFault("TREE_BUDGET_EXCEEDED", 74)
            relative = str(child.relative_to(root))
            entries.append({
                "path": relative,
                "sha256": hash_file(child, maximum=maximum_bytes),
                "size": child_value.st_size,
                "mode": format(stat.S_IMODE(child_value.st_mode), "04o"),
            })
    entries.sort(key=lambda item: item["path"])
    return {
        "logical_resource": invocation.resource,
        "entry_count": len(entries),
        "bytes": total_bytes,
        "excluded": excluded,
        "manifest_sha256": hashlib.sha256(canonical(entries)).hexdigest(),
        "entries": entries,
    }


def snapshot_manifest(policy: dict[str, Any], invocation: Invocation) -> dict[str, Any]:
    """Return a bounded content-snapshot plan without copying caller data as root."""
    manifest = tree_manifest(policy, invocation)
    storage = storage_status(policy)
    estimate = manifest["bytes"] + min(4 * 1024 * 1024, manifest["entry_count"] * 256)
    return {
        "profile": "bounded-evidence-manifest-v1",
        "logical_resource": invocation.resource,
        "content_manifest": manifest,
        "estimated_snapshot_bytes": estimate,
        "storage_preflight": {
            "available_bytes": storage["available_bytes"],
            "minimum_free_bytes": storage["minimum_free_bytes"],
            "admissible": storage["admissible"] and storage["available_bytes"] - estimate >= storage["minimum_free_bytes"],
        },
        "destination": "NONE: manifest-only bootstrap profile",
        "secrets_copied": False,
    }


def git_index(policy: dict[str, Any], invocation: Invocation) -> dict[str, Any]:
    _, root = directory_record(policy, invocation)
    index = root / ".git" / "index"
    assert_noncaller_writable_chain(index.parent)
    value = index.lstat()
    uid, gid = expected_owner()
    if index.is_symlink() or not stat.S_ISREG(value.st_mode) or value.st_uid != uid or value.st_gid != gid or stat.S_IMODE(value.st_mode) != 0o600 or value.st_nlink != 1:
        raise RuntimeFault("GIT_INDEX_UNSAFE", 74)
    return {
        "logical_resource": invocation.resource,
        "metadata": stat_projection(index),
        "sha256": hash_file(index, maximum=256 * 1024 * 1024),
    }


def storage_status(policy: dict[str, Any]) -> dict[str, Any]:
    ensure_state()
    filesystem = os.statvfs(mapped(STATE_ROOT))
    available = filesystem.f_bavail * filesystem.f_frsize
    return {
        "state_root": STATE_ROOT,
        "available_bytes": available,
        "minimum_free_bytes": int(policy["limits"]["minimum_free_bytes"]),
        "admissible": available >= int(policy["limits"]["minimum_free_bytes"]),
    }


def installed_identity() -> dict[str, Any]:
    manifest_value = secure_file(INSTALL_MANIFEST, 0o444, maximum=256 * 1024)
    manifest = parse_json(mapped(INSTALL_MANIFEST).read_bytes(), maximum=manifest_value.st_size + 1)
    if not isinstance(manifest, dict) or manifest.get("schema") != INSTALL_SCHEMA or manifest.get("runtime_version") != VERSION:
        raise RuntimeFault("INSTALL_MANIFEST_INVALID", 78)
    files = manifest.get("files")
    required = {SELF: 0o755, POLICY: 0o444, SUDOERS: 0o440}
    if not isinstance(files, dict) or set(files) != set(required):
        raise RuntimeFault("INSTALL_MANIFEST_INVALID", 78)
    output = {}
    for path, mode in required.items():
        record = files[path]
        if not isinstance(record, dict) or set(record) != {"sha256", "mode"} or record["mode"] != format(mode, "04o") or not isinstance(record["sha256"], str) or not SHA256.fullmatch(record["sha256"]):
            raise RuntimeFault("INSTALL_MANIFEST_INVALID", 78)
        secure_file(path, mode)
        actual = hash_file(mapped(path))
        if actual != record["sha256"]:
            raise RuntimeFault("INSTALL_IDENTITY_MISMATCH", 78)
        output[path] = actual
    return output


def self_check(policy: dict[str, Any]) -> dict[str, Any]:
    identities = installed_identity()
    completed = run_fixed([VISUDO, "-cf", SUDOERS], timeout=15)
    if completed.returncode != 0:
        raise RuntimeFault("SUDOERS_INVALID", 78)
    return {
        "runtime_version": VERSION,
        "installed_identity": identities,
        "policy_sha256": policy_sha256(),
        "registry_sha256": registry_sha256(policy),
        "audit": audit_status(),
        "generic_command_execution": False,
        "arbitrary_paths": False,
        "docker_socket_delegated": False,
    }


def request_digest(invocation: Invocation) -> str:
    return hashlib.sha256(canonical({"primitive": invocation.primitive, "resource": invocation.resource, "relative_path": invocation.relative_path})).hexdigest()


def dispatch(policy: dict[str, Any], invocation: Invocation) -> dict[str, Any]:
    if invocation.primitive == "version":
        return {"runtime_version": VERSION, "response_schema": RESPONSE_SCHEMA}
    if invocation.primitive == "policy-status":
        return {"runtime_version": VERSION, "policy_sha256": policy_sha256(), "policy_schema": policy["schema"]}
    if invocation.primitive == "registry-status":
        return {"resource_count": len(policy["resources"]), "registry_sha256": registry_sha256(policy)}
    if invocation.primitive == "audit-status":
        return audit_status()
    if invocation.primitive == "storage-status":
        return storage_status(policy)
    if invocation.primitive == "capabilities":
        return {
            "runtime_version": VERSION,
            "resources": {key: {"kind": item["kind"], "operations": item["operations"]} for key, item in sorted(policy["resources"].items())},
            "disabled_profiles": policy["disabled_profiles"],
            "generic_command_execution": False,
            "arbitrary_paths": False,
            "arbitrary_package_install": False,
        }
    if invocation.primitive == "self-check":
        return self_check(policy)
    if invocation.primitive == "recovery-status":
        return {
            "runtime_version": VERSION,
            "identity": installed_identity(),
            "audit": audit_status(),
            "policy_sha256": policy_sha256(),
            "recovery_scope": ["runtime identity", "audit diagnosis", "policy and registry identity"],
            "runtime_self_update": False,
        }
    if invocation.primitive == "docker-provenance":
        return docker_provenance(policy)
    if invocation.primitive == "docker-inspect":
        return container_projection(policy, invocation.resource or "")
    if invocation.primitive == "service-status":
        result = container_projection(policy, invocation.resource or "")
        return {key: result[key] for key in ("logical_resource", "container_id", "image_id", "status", "running", "health", "restart_count", "started_at")}
    if invocation.primitive == "service-health":
        result = container_projection(policy, invocation.resource or "")
        return {"logical_resource": result["logical_resource"], "running": result["running"], "health": result["health"], "healthy": result["running"] and result["health"] in {"", "healthy"}}
    if invocation.primitive == "fs-stat":
        _, path = directory_record(policy, invocation)
        return {"logical_resource": invocation.resource, "metadata": stat_projection(path)}
    if invocation.primitive == "fs-read":
        return bounded_file_read(policy, invocation)
    if invocation.primitive == "fs-tree":
        return tree_manifest(policy, invocation)
    if invocation.primitive == "snapshot-manifest":
        return snapshot_manifest(policy, invocation)
    if invocation.primitive == "git-index":
        return git_index(policy, invocation)
    if invocation.primitive == "service-restart":
        status = audit_status()
        if status["state"] not in {"EMPTY", "VALID"}:
            raise RuntimeFault("AUDIT_MUTATION_DISABLED", 78)
        record = resource(policy, invocation, "container")
        before = container_projection(policy, invocation.resource or "")
        completed = run_fixed([DOCKER, "restart", record["name"]], timeout=60)
        if completed.returncode != 0:
            raise RuntimeFault("SERVICE_RESTART_FAILED", 74)
        after = container_projection(policy, invocation.resource or "")
        if before["container_id"] != after["container_id"] or before["image_id"] != after["image_id"] or not after["running"] or after["health"] not in {"", "healthy"}:
            raise RuntimeFault("SERVICE_RESTART_POSTCHECK_FAILED", 74)
        append_audit(invocation, request_digest(invocation), hashlib.sha256(canonical(before)).hexdigest(), "ok", hashlib.sha256(canonical(after)).hexdigest())
        return {"restarted": invocation.resource, "post_state": {key: after[key] for key in ("container_id", "image_id", "running", "health", "restart_count")}}
    if invocation.primitive in {"release-preflight", "release-activate", "config-activate", "database-status", "database-migrate", "rollback"}:
        profile = invocation.primitive.replace("-", "_")
        raise RuntimeFault("PROFILE_DISABLED", 77, {"profile": profile})
    raise RuntimeFault("PRIMITIVE_UNKNOWN", 64)


def response(invocation: Invocation, *, evidence: dict[str, Any] | None = None, fault: RuntimeFault | None = None, warnings: list[str] | None = None) -> dict[str, Any]:
    output: dict[str, Any] = {
        "schema": RESPONSE_SCHEMA,
        "runtime_version": VERSION,
        "primitive": invocation.primitive,
        "resource": invocation.resource,
        "timestamp": now(),
        "ok": fault is None,
        "warnings": warnings or [],
    }
    if fault is None:
        output["evidence"] = evidence or {}
        output["errors"] = []
    else:
        output["evidence"] = {}
        output["errors"] = [{"code": fault.code, "details": fault.details}]
    return output


def main(argv: list[str]) -> int:
    invocation = Invocation("invalid", None)
    try:
        configure_mode()
        policy = load_policy()
        verify_caller(policy)
        invocation = parse_cli(argv)
        evidence = dispatch(policy, invocation)
        warnings = []
        if audit_status()["state"] == "INVALID":
            warnings.append("AUDIT_DEGRADED_READONLY")
        print(json.dumps(response(invocation, evidence=evidence, warnings=warnings), sort_keys=True, separators=(",", ":"), ensure_ascii=True))
        return 0
    except RuntimeFault as exc:
        print(json.dumps(response(invocation, fault=exc), sort_keys=True, separators=(",", ":"), ensure_ascii=True))
        return exc.exit_code
    except Exception:
        fault = RuntimeFault("INTERNAL_ERROR", 70)
        print(json.dumps(response(invocation, fault=fault), sort_keys=True, separators=(",", ":"), ensure_ascii=True))
        return fault.exit_code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
