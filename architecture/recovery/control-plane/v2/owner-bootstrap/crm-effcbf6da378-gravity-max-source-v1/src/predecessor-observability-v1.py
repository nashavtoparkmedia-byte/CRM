#!/usr/bin/python3 -I
"""Finite, secret-safe, read-only predecessor recreation observation (v2).

This module is loaded only by the integrity-pinned Runtime wrapper.  Every
Docker object and host path is derived from fixed project policy, the fixed
rollback-target containers, and the Compose files those containers record as
their own creation stack.  The caller supplies no arguments.

Version 2 replaces the base-only model.  A predecessor created through a
sealed Runtime profile overlay (and optionally an image-only production
overlay) is reconstructed from exactly the layers its container was created
from, and every release-critical semantic is compared with that
reconstruction.  The installed slot keeps the v1 file name because the pinned
Runtime core fixes the install-manifest file set; the control version is the
observation schema below and this file's digest.
"""
from __future__ import annotations

import hashlib
import os
import re
import stat
from pathlib import Path
from typing import Any


SCHEMA = "yoko.crm.predecessor-recreation-observation.v2"
COMPOSE_PATH = "/opt/crm/deploy/docker-compose.production.yml"
ENVIRONMENT_PATH = "/opt/crm/.env.production"
PROJECT_DIRECTORY = "/opt/crm/deploy"
COMPOSE_PROJECT = "crm"
MAX_COMPOSE_JSON = 4 * 1024 * 1024
MAX_LAYERS = 4
MAX_OVERLAY_BYTES = 64 * 1024
SHA64 = re.compile(r"[0-9a-f]{64}")
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}")
SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,1023}")
SECRET_ASSIGNMENT = re.compile(
    r"(?i)(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]"
)
# A layer written by a sealed Runtime activation profile into the root-only
# Runtime store.  Its content is bound by digest in the observation.
RUNTIME_PROFILE_OVERLAY = re.compile(
    r"/var/lib/yoko-privileged-runtime/profiles/crm-[0-9a-f]{12}-gravity-max-source-v1/(?:activate|rollback)\.compose\.yml"
)
# Any other recorded layer is untrusted input: it is read once, never handed
# to Compose, and admitted only when it pins service images and nothing else.
OVERLAY_PATH = re.compile(r"(?:/[A-Za-z0-9._-]{1,128}){1,16}\.compose\.yml")
OVERLAY_SERVICE = re.compile(r"  ([a-z0-9][a-z0-9_-]{0,63}):")
OVERLAY_IMAGE = re.compile(r"    image: ([!-~]{1,512})")
OVERLAY_COMMENT = re.compile(r" *#[^\x00-\x1f\x7f-\x9f\u2028\u2029]*")
IMAGE_REFERENCE = re.compile(
    r"[a-z0-9][a-z0-9._/-]{0,254}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?"
)
# A pin must name a tag or a digest, so no YAML null/bool/number can pass as one.
IMAGE_PIN = re.compile(
    r"[a-z0-9][a-z0-9._/-]{0,254}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}(?:@sha256:[0-9a-f]{64})?|@sha256:[0-9a-f]{64})"
)
LAYER_LABEL = "com.docker.compose.project.config_files"
WORKING_DIRECTORY_LABEL = "com.docker.compose.project.working_dir"
ENVIRONMENT_FILE_LABEL = "com.docker.compose.project.environment_file"

TARGETS = (
    {
        "logical_resource": "crm.container.gravity_mvp",
        "container_name": "crm-gravity-mvp",
        "compose_service": "gravity-mvp",
        "allowed_entrypoints": (("/usr/bin/tini", "--"),),
        "allowed_commands": (
            ("sh", "-c", "npx prisma migrate deploy && npm run start"),
            ("npm", "run", "start"),
        ),
    },
    {
        "logical_resource": "crm.container.telegram_bot",
        "container_name": "crm-tg-bot",
        "compose_service": "tg-bot",
        "allowed_entrypoints": (("/usr/bin/tini", "--", "/usr/local/bin/tg-bot-entrypoint"),),
        "allowed_commands": (("node", "start.js"),),
    },
    {
        "logical_resource": "crm.container.max_scraper",
        "container_name": "crm-max-scraper",
        "compose_service": "max-web-scraper",
        "allowed_entrypoints": (("/usr/bin/tini", "--"),),
        "allowed_commands": (("node", "index.js"),),
    },
)

HOST_SCALAR_FIELDS = (
    "AutoRemove", "BlkioWeight", "CgroupnsMode", "CpuPeriod", "CpuQuota",
    "CpuRealtimePeriod", "CpuRealtimeRuntime", "CpuShares", "Init", "IpcMode",
    "Isolation", "Memory", "MemoryReservation", "MemorySwap", "MemorySwappiness",
    "NanoCpus", "NetworkMode", "OomKillDisable", "OomScoreAdj", "PidMode",
    "PidsLimit", "Privileged", "ReadonlyRootfs", "Runtime", "ShmSize", "UTSMode",
    "UsernsMode",
)


def _fault(core: Any, code: str, details: dict[str, Any] | None = None) -> None:
    raise core.RuntimeFault(code, 74, details or {})


def _canonical_sha(core: Any, value: Any) -> str:
    return hashlib.sha256(core.canonical(value)).hexdigest()


def _text(core: Any, value: Any, code: str, maximum: int = 4096) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum or "\x00" in value:
        _fault(core, code)
    return value


def _optional_text(core: Any, value: Any, code: str, maximum: int = 4096) -> str:
    if value in (None, ""):
        return ""
    return _text(core, value, code, maximum)


def _safe_string(core: Any, value: Any, code: str, maximum: int = 4096) -> str:
    output = _text(core, value, code, maximum)
    if SECRET_ASSIGNMENT.search(output):
        _fault(core, "SECRET_BEARING_CONFIGURATION_REJECTED")
    return output


def _argv(core: Any, value: Any, allowed: tuple[tuple[str, ...], ...], code: str) -> list[str]:
    if value is None:
        candidate: tuple[str, ...] = ()
    elif isinstance(value, list) and len(value) <= 32 and all(isinstance(item, str) for item in value):
        candidate = tuple(value)
    else:
        _fault(core, code)
    if candidate not in allowed:
        _fault(core, code)
    for item in candidate:
        _safe_string(core, item, code, 4096)
    return list(candidate)


def _string_list(core: Any, value: Any, code: str, maximum_items: int = 256) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > maximum_items:
        _fault(core, code)
    output = [_safe_string(core, item, code, 4096) for item in value]
    return sorted(output)


def _string_map(core: Any, value: Any, code: str, *, allow_empty: bool = True) -> dict[str, str]:
    if value is None and allow_empty:
        return {}
    if not isinstance(value, dict) or len(value) > 256:
        _fault(core, code)
    output: dict[str, str] = {}
    for key, item in value.items():
        safe_key = _safe_string(core, key, code, 512)
        if re.search(r"(?i)(password|passwd|secret|token|key)", safe_key):
            _fault(core, "SECRET_BEARING_OPTION_REJECTED")
        output[safe_key] = _safe_string(core, item, code, 4096)
    return dict(sorted(output.items()))


def _safe_structure(core: Any, value: Any, code: str, depth: int = 0) -> Any:
    if depth > 8:
        _fault(core, code)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _safe_string(core, value, code, 4096)
    if isinstance(value, list):
        if len(value) > 512:
            _fault(core, code)
        return [_safe_structure(core, item, code, depth + 1) for item in value]
    if isinstance(value, dict):
        if len(value) > 512:
            _fault(core, code)
        output: dict[str, Any] = {}
        for key in sorted(value):
            if not isinstance(key, str) or not key or len(key) > 512:
                _fault(core, code)
            if re.search(r"(?i)(password|passwd|secret_value|token_value|private_key)", key):
                _fault(core, "SECRET_BEARING_CONFIGURATION_REJECTED")
            output[key] = _safe_structure(core, value[key], code, depth + 1)
        return output
    _fault(core, code)


def _environment_map(core: Any, value: Any, source: str) -> dict[str, str]:
    output: dict[str, str] = {}
    if value is None:
        return output
    if isinstance(value, dict):
        items = value.items()
    elif isinstance(value, list):
        parsed: list[tuple[str, Any]] = []
        for entry in value:
            if not isinstance(entry, str) or "=" not in entry:
                _fault(core, "ENVIRONMENT_SHAPE_INVALID", {"source": source})
            parsed.append(tuple(entry.split("=", 1)))
        items = parsed
    else:
        _fault(core, "ENVIRONMENT_SHAPE_INVALID", {"source": source})
    for key, item in items:
        if (
            not isinstance(key, str)
            or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", key)
            or key in output
            or not isinstance(item, str)
            or len(item) > 1024 * 1024
            or "\x00" in item
        ):
            _fault(core, "ENVIRONMENT_SHAPE_INVALID", {"source": source})
        output[key] = item
    return output


def _compose_command(files: tuple[str, ...]) -> list[str]:
    command = [
        "compose",
        "--project-directory", PROJECT_DIRECTORY,
        "--env-file", ENVIRONMENT_PATH,
    ]
    for path in files:
        command.extend(["-f", path])
    return command


def _fixed_production_file(core: Any, path: str, mode: int, maximum: int) -> os.stat_result:
    """Bind a fixed root-owned file below the non-caller-writable project tree.

    `/opt/crm` is intentionally owned by the production `crm` account rather
    than root.  The existing Runtime repository boundary therefore proves the
    full chain is not writable by its unprivileged `codexbot` caller, while the
    two fixed configuration leaves themselves remain root-owned, non-linked,
    exact-mode regular files.  Requiring every ancestor to be root-owned would
    reject the real deployment without improving the frozen caller threat
    model.
    """
    target = core.mapped(path)
    core.assert_noncaller_writable_chain(target)
    try:
        value = target.lstat()
    except OSError:
        _fault(core, "PRODUCTION_CONFIGURATION_FILE_UNSAFE", {"path": path})
    uid, gid = core.expected_owner()
    if (
        target.is_symlink()
        or not stat.S_ISREG(value.st_mode)
        or (value.st_uid, value.st_gid) != (uid, gid)
        or stat.S_IMODE(value.st_mode) != mode
        or value.st_nlink != 1
        or value.st_size < 0
        or value.st_size > maximum
    ):
        _fault(core, "PRODUCTION_CONFIGURATION_FILE_UNSAFE", {"path": path})
    return value


def _runtime_overlay(core: Any, path: str) -> str:
    """Bind one root-only overlay written by a sealed Runtime activation profile."""
    try:
        core.secure_file(path, 0o400, maximum=MAX_OVERLAY_BYTES)
    except core.RuntimeFault:
        _fault(core, "PREDECESSOR_LAYER_UNTRUSTED", {"path": path})
    except OSError:
        _fault(core, "PREDECESSOR_LAYER_MISSING", {"path": path})
    return core.hash_file(core.mapped(path), maximum=MAX_OVERLAY_BYTES)


def _read_overlay_once(core: Any, path: str) -> bytes:
    """Read an untrusted recorded layer exactly once, as a bounded regular file."""
    try:
        fd = os.open(core.mapped(path), os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        _fault(core, "PREDECESSOR_LAYER_MISSING", {"path": path})
    try:
        value = os.fstat(fd)
        if not stat.S_ISREG(value.st_mode) or value.st_size > MAX_OVERLAY_BYTES:
            _fault(core, "PREDECESSOR_LAYER_UNTRUSTED", {"path": path})
        chunks = []
        total = 0
        while True:
            chunk = os.read(fd, 16 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_OVERLAY_BYTES:
                _fault(core, "PREDECESSOR_LAYER_UNTRUSTED", {"path": path})
            chunks.append(chunk)
    finally:
        os.close(fd)
    return b"".join(chunks)


def _image_only_overlay(core: Any, path: str, raw: bytes) -> dict[str, str]:
    """Parse the strict image-pin grammar; anything else is not admitted.

    services:
      <service>:
        image: <reference>

    plus comment and blank lines.  The grammar is a strict subset of YAML with
    one meaning, so the parsed pins are exactly what Compose merged.
    """
    try:
        # Comments may carry UTF-8 prose; every non-comment line is matched
        # against ASCII-only patterns below.
        text = raw.decode("utf-8")
    except UnicodeError:
        _fault(core, "PREDECESSOR_OVERLAY_NOT_IMAGE_ONLY", {"path": path})
    if "\t" in text or "\r" in text:
        _fault(core, "PREDECESSOR_OVERLAY_NOT_IMAGE_ONLY", {"path": path})
    images: dict[str, str] = {}
    in_services = False
    current: str | None = None
    for line in text.split("\n"):
        # Compose's YAML parser also breaks lines at NEL, LS, PS, VT and FF; a
        # "comment" carrying one would hide a real key from this parser.
        if line and line.splitlines() != [line]:
            _fault(core, "PREDECESSOR_OVERLAY_NOT_IMAGE_ONLY", {"path": path})
        if not line.strip(" ") or OVERLAY_COMMENT.fullmatch(line):
            continue
        if line == "services:" and not in_services:
            in_services = True
            continue
        service = OVERLAY_SERVICE.fullmatch(line)
        if service and in_services and service.group(1) not in images and (current is None or current in images):
            current = service.group(1)
            continue
        image = OVERLAY_IMAGE.fullmatch(line)
        if image and current is not None and current not in images and IMAGE_PIN.fullmatch(image.group(1)):
            images[current] = image.group(1)
            continue
        _fault(core, "PREDECESSOR_OVERLAY_NOT_IMAGE_ONLY", {"path": path})
    if not images or current not in images:
        _fault(core, "PREDECESSOR_OVERLAY_NOT_IMAGE_ONLY", {"path": path})
    return dict(sorted(images.items()))


def _path_reference(path: str) -> dict[str, Any]:
    return {"path_sha256": hashlib.sha256(path.encode("utf-8", "surrogateescape")).hexdigest(), "path_bytes": len(path)}


def _layer_chain_trusted(core: Any, path: str) -> bool:
    """True only if the caller can neither write nor re-permission any component.

    Ownership decides, not the current permission bits: a caller-owned
    directory chmod-ed read-only is still the caller's.
    """
    caller = getattr(core, "CALLER_UID", None)
    current = core.mapped("/")
    try:
        components = [current]
        for part in Path(path).parts[1:]:
            current = current / part
            components.append(current)
        for component in components:
            value = component.lstat()
            if stat.S_ISLNK(value.st_mode) or value.st_uid == caller or stat.S_IMODE(value.st_mode) & 0o022:
                return False
    except OSError:
        _fault(core, "PREDECESSOR_LAYER_MISSING", {"path": path})
    try:
        core.assert_noncaller_writable_chain(core.mapped(path))
    except core.RuntimeFault:
        return False
    return True


def _layer_stack(core: Any, labels: Any) -> tuple[tuple[str, ...], dict[str, str], list[dict[str, Any]]]:
    """Return the Compose files to resolve, the image pins, and the bound layer records.

    The stack is the one the container itself recorded at creation.  Nothing
    else can enter it: no candidate overlay, no file chosen by the caller.
    """
    if not isinstance(labels, dict):
        _fault(core, "COMPOSE_LABELS_INVALID")
    if labels.get(WORKING_DIRECTORY_LABEL) != PROJECT_DIRECTORY or labels.get(ENVIRONMENT_FILE_LABEL) != ENVIRONMENT_PATH:
        _fault(core, "PREDECESSOR_PROJECT_SOURCE_MISMATCH")
    recorded = labels.get(LAYER_LABEL)
    if not isinstance(recorded, str) or not recorded:
        _fault(core, "PREDECESSOR_LAYER_STACK_MISSING")
    paths = recorded.split(",")
    if len(paths) > MAX_LAYERS or len(set(paths)) != len(paths) or paths[0] != COMPOSE_PATH:
        _fault(core, "PREDECESSOR_LAYER_STACK_UNSUPPORTED")
    compose_files = [COMPOSE_PATH]
    images: dict[str, str] = {}
    records: list[dict[str, Any]] = []
    for path in paths[1:]:
        if RUNTIME_PROFILE_OVERLAY.fullmatch(path):
            if len(compose_files) != 1 or images:
                # One Runtime overlay, before every image pin: the order in
                # which Compose merged them is then fixed and reproducible.
                _fault(core, "PREDECESSOR_LAYER_STACK_UNSUPPORTED")
            records.append({"path": path, "role": "runtime-profile-overlay", "sha256": _runtime_overlay(core, path)})
            compose_files.append(path)
            continue
        if not OVERLAY_PATH.fullmatch(path) or any(part in {".", ".."} for part in path.split("/")[1:]):
            _fault(core, "PREDECESSOR_LAYER_UNTRUSTED", _path_reference(path))
        raw = _read_overlay_once(core, path)
        pins = _image_only_overlay(core, path, raw)
        caller_writable = not _layer_chain_trusted(core, path)
        records.append({
            "path": path,
            "role": "image-only-overlay",
            "sha256": hashlib.sha256(raw).hexdigest(),
            "image_pins": pins,
            # Only the image pins are consumed, and each is re-proven against the
            # running container; the digest of a caller-writable layer is evidence,
            # not authority.
            "caller_writable_chain": caller_writable,
        })
        images.update(pins)
    return tuple(compose_files), images, records


def _resolve_stack(core: Any, policy: dict[str, Any], files: tuple[str, ...]) -> dict[str, Any]:
    completed = core.run_fixed([
        core.DOCKER, *_compose_command(files), "config", "--format", "json",
    ], timeout=int(policy["limits"]["command_timeout_seconds"]))
    if completed.returncode != 0:
        _fault(core, "PREDECESSOR_COMPOSE_CONFIG_FAILED")
    if len(completed.stdout) > MAX_COMPOSE_JSON:
        _fault(core, "PREDECESSOR_COMPOSE_CONFIG_TOO_LARGE")
    value = core.parse_json(completed.stdout, maximum=MAX_COMPOSE_JSON)
    if not isinstance(value, dict) or not isinstance(value.get("services"), dict):
        _fault(core, "PREDECESSOR_COMPOSE_CONFIG_INVALID")
    if value.get("name") not in (None, COMPOSE_PROJECT):
        _fault(core, "PREDECESSOR_COMPOSE_PROJECT_MISMATCH")
    return value


def _service_projection(core: Any, service: dict[str, Any], environment_keys: list[str]) -> dict[str, Any]:
    # Values are deliberately excluded.  Fully resolved values are bound by
    # Compose's aggregate service config hash and compared internally where a
    # secret-safe exact comparison is possible (notably the environment).
    if any(not isinstance(key, str) or not key for key in service):
        _fault(core, "RESOLVED_SERVICE_PROJECTION_INVALID")
    return {
        "declared_field_set": sorted(service),
        "environment_keys": environment_keys,
        "plaintext_values_emitted": False,
    }


def _volume_projection(core: Any, policy: dict[str, Any], name: str) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,255}", name):
        _fault(core, "VOLUME_IDENTITY_INVALID")
    raw = core.docker_json(["volume", "inspect", name], policy)
    if raw.get("Name") != name:
        _fault(core, "VOLUME_IDENTITY_MISMATCH")
    driver = _text(core, raw.get("Driver"), "VOLUME_DRIVER_INVALID", 128)
    options = _string_map(core, raw.get("Options"), "VOLUME_OPTIONS_INVALID")
    labels = raw.get("Labels") or {}
    if not isinstance(labels, dict):
        _fault(core, "VOLUME_LABELS_INVALID")
    safe_labels = {
        key: _safe_string(core, labels[key], "VOLUME_LABELS_INVALID", 1024)
        for key in (
            "com.docker.compose.project", "com.docker.compose.volume",
        )
        if key in labels
    }
    return {
        "name": name,
        "driver": driver,
        "options": options,
        "scope": _optional_text(core, raw.get("Scope"), "VOLUME_SCOPE_INVALID", 64),
        "compose_labels": dict(sorted(safe_labels.items())),
    }


def _mounts(core: Any, policy: dict[str, Any], raw: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not isinstance(raw, list) or len(raw) > 128:
        _fault(core, "MOUNT_CONFIGURATION_INVALID")
    mounts: list[dict[str, Any]] = []
    volumes: dict[str, dict[str, Any]] = {}
    for mount in raw:
        if not isinstance(mount, dict):
            _fault(core, "MOUNT_CONFIGURATION_INVALID")
        kind = _text(core, mount.get("Type"), "MOUNT_CONFIGURATION_INVALID", 32)
        target = _text(core, mount.get("Destination"), "MOUNT_CONFIGURATION_INVALID", 1024)
        if not target.startswith("/") or type(mount.get("RW")) is not bool:
            _fault(core, "MOUNT_CONFIGURATION_INVALID")
        item: dict[str, Any] = {
            "type": kind,
            "target": target,
            "read_write": mount["RW"],
            "propagation": _optional_text(core, mount.get("Propagation"), "MOUNT_CONFIGURATION_INVALID", 64),
        }
        if kind == "volume":
            name = _text(core, mount.get("Name"), "MOUNT_CONFIGURATION_INVALID", 256)
            item["name"] = name
            volumes.setdefault(name, _volume_projection(core, policy, name))
        elif kind == "bind":
            source = _text(core, mount.get("Source"), "MOUNT_CONFIGURATION_INVALID", 1024)
            if source != "/opt/crm" and not source.startswith("/opt/crm/"):
                _fault(core, "BIND_SOURCE_OUTSIDE_PROJECT")
            item["source"] = source
        elif kind != "tmpfs":
            _fault(core, "MOUNT_TYPE_UNSUPPORTED")
        mounts.append(item)
    mounts.sort(key=lambda item: (item["target"], item["type"], item.get("name", item.get("source", ""))))
    return mounts, [volumes[key] for key in sorted(volumes)]


def _ipam_projection(core: Any, value: Any) -> dict[str, Any]:
    if value is None:
        return {"driver": "", "options": {}, "config": []}
    if not isinstance(value, dict):
        _fault(core, "NETWORK_IPAM_INVALID")
    configs = value.get("Config") or []
    if not isinstance(configs, list) or len(configs) > 32:
        _fault(core, "NETWORK_IPAM_INVALID")
    allowed = {"Subnet", "IPRange", "Gateway", "AuxiliaryAddresses"}
    projected = []
    for config in configs:
        if not isinstance(config, dict) or not set(config).issubset(allowed):
            _fault(core, "NETWORK_IPAM_INVALID")
        projected.append(_safe_structure(core, config, "NETWORK_IPAM_INVALID"))
    return {
        "driver": _optional_text(core, value.get("Driver"), "NETWORK_IPAM_INVALID", 128),
        "options": _string_map(core, value.get("Options"), "NETWORK_IPAM_INVALID"),
        "config": projected,
    }


def _network_projection(core: Any, policy: dict[str, Any], name: str) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,255}", name):
        _fault(core, "NETWORK_IDENTITY_INVALID")
    raw = core.docker_json(["network", "inspect", name], policy)
    network_id = raw.get("Id")
    if raw.get("Name") != name or not isinstance(network_id, str) or not SHA64.fullmatch(network_id):
        _fault(core, "NETWORK_IDENTITY_MISMATCH")
    labels = raw.get("Labels") or {}
    if not isinstance(labels, dict):
        _fault(core, "NETWORK_LABELS_INVALID")
    safe_labels = {
        key: _safe_string(core, labels[key], "NETWORK_LABELS_INVALID", 1024)
        for key in (
            "com.docker.compose.project", "com.docker.compose.network",
        )
        if key in labels
    }
    return {
        "id": network_id,
        "name": name,
        "driver": _text(core, raw.get("Driver"), "NETWORK_DRIVER_INVALID", 128),
        "scope": _optional_text(core, raw.get("Scope"), "NETWORK_SCOPE_INVALID", 64),
        "internal": raw.get("Internal") is True,
        "attachable": raw.get("Attachable") is True,
        "ingress": raw.get("Ingress") is True,
        "enable_ipv6": raw.get("EnableIPv6") is True,
        "ipam": _ipam_projection(core, raw.get("IPAM")),
        "options": _string_map(core, raw.get("Options"), "NETWORK_OPTIONS_INVALID"),
        "compose_labels": dict(sorted(safe_labels.items())),
    }


def _endpoint(core: Any, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fault(core, "NETWORK_ENDPOINT_INVALID")
    network_id = value.get("NetworkID")
    endpoint_id = value.get("EndpointID")
    if not isinstance(network_id, str) or not SHA64.fullmatch(network_id):
        _fault(core, "NETWORK_ENDPOINT_INVALID")
    if endpoint_id not in (None, "") and (not isinstance(endpoint_id, str) or not SHA64.fullmatch(endpoint_id)):
        _fault(core, "NETWORK_ENDPOINT_INVALID")
    aliases = _string_list(core, value.get("Aliases"), "NETWORK_ENDPOINT_INVALID")
    dns_names = _string_list(core, value.get("DNSNames"), "NETWORK_ENDPOINT_INVALID")
    driver_options = _string_map(core, value.get("DriverOpts"), "NETWORK_ENDPOINT_INVALID")
    return {
        "network_id": network_id,
        "aliases": aliases,
        "dns_names": dns_names,
        "driver_options": driver_options,
        "observational_endpoint": {
            "endpoint_id": endpoint_id or "",
            "mac_address": _optional_text(core, value.get("MacAddress"), "NETWORK_ENDPOINT_INVALID", 64),
            "gateway": _optional_text(core, value.get("Gateway"), "NETWORK_ENDPOINT_INVALID", 128),
            "ip_address": _optional_text(core, value.get("IPAddress"), "NETWORK_ENDPOINT_INVALID", 128),
            "ip_prefix_len": value.get("IPPrefixLen") if isinstance(value.get("IPPrefixLen"), int) else 0,
            "ipv6_gateway": _optional_text(core, value.get("IPv6Gateway"), "NETWORK_ENDPOINT_INVALID", 128),
            "global_ipv6_address": _optional_text(core, value.get("GlobalIPv6Address"), "NETWORK_ENDPOINT_INVALID", 128),
            "global_ipv6_prefix_len": value.get("GlobalIPv6PrefixLen") if isinstance(value.get("GlobalIPv6PrefixLen"), int) else 0,
        },
    }


def _networks(core: Any, policy: dict[str, Any], value: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not isinstance(value, dict) or not value or len(value) > 32:
        _fault(core, "NETWORK_CONFIGURATION_INVALID")
    attachments = []
    networks = []
    for name in sorted(value):
        attachment = {"name": name, **_endpoint(core, value[name])}
        network = _network_projection(core, policy, name)
        if attachment["network_id"] != network["id"]:
            _fault(core, "NETWORK_ENDPOINT_IDENTITY_MISMATCH")
        attachments.append(attachment)
        networks.append(network)
    return attachments, networks


def _devices(core: Any, value: Any) -> list[dict[str, str]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 128:
        _fault(core, "DEVICE_CONFIGURATION_INVALID")
    output = []
    for item in value:
        if not isinstance(item, dict):
            _fault(core, "DEVICE_CONFIGURATION_INVALID")
        output.append({
            "path_on_host": _text(core, item.get("PathOnHost"), "DEVICE_CONFIGURATION_INVALID", 1024),
            "path_in_container": _text(core, item.get("PathInContainer"), "DEVICE_CONFIGURATION_INVALID", 1024),
            "cgroup_permissions": _text(core, item.get("CgroupPermissions"), "DEVICE_CONFIGURATION_INVALID", 16),
        })
    return sorted(output, key=lambda item: (item["path_in_container"], item["path_on_host"]))


def _device_requests(core: Any, value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 64:
        _fault(core, "DEVICE_REQUEST_CONFIGURATION_INVALID")
    output = []
    for item in value:
        if not isinstance(item, dict):
            _fault(core, "DEVICE_REQUEST_CONFIGURATION_INVALID")
        capabilities = item.get("Capabilities") or []
        if not isinstance(capabilities, list) or any(not isinstance(row, list) for row in capabilities):
            _fault(core, "DEVICE_REQUEST_CONFIGURATION_INVALID")
        output.append({
            "driver": _optional_text(core, item.get("Driver"), "DEVICE_REQUEST_CONFIGURATION_INVALID", 128),
            "count": item.get("Count") if isinstance(item.get("Count"), int) else 0,
            "device_ids": _string_list(core, item.get("DeviceIDs"), "DEVICE_REQUEST_CONFIGURATION_INVALID"),
            "capabilities": sorted(_string_list(core, row, "DEVICE_REQUEST_CONFIGURATION_INVALID") for row in capabilities),
            "options": _string_map(core, item.get("Options"), "DEVICE_REQUEST_CONFIGURATION_INVALID"),
        })
    return output


def _ulimits(core: Any, value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 128:
        _fault(core, "ULIMIT_CONFIGURATION_INVALID")
    output = []
    for item in value:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("Soft"), int)
            or not isinstance(item.get("Hard"), int)
        ):
            _fault(core, "ULIMIT_CONFIGURATION_INVALID")
        output.append({
            "name": _text(core, item.get("Name"), "ULIMIT_CONFIGURATION_INVALID", 128),
            "soft": item["Soft"],
            "hard": item["Hard"],
        })
    return sorted(output, key=lambda item: item["name"])


def _host_config(core: Any, host: Any) -> dict[str, Any]:
    if not isinstance(host, dict):
        _fault(core, "HOST_CONFIGURATION_INVALID")
    scalars = {key: host.get(key) for key in HOST_SCALAR_FIELDS}
    if any(value is not None and not isinstance(value, (str, bool, int)) for value in scalars.values()):
        _fault(core, "HOST_CONFIGURATION_INVALID")
    restart = host.get("RestartPolicy") or {}
    if not isinstance(restart, dict):
        _fault(core, "HOST_CONFIGURATION_INVALID")
    restart_projection = {
        "name": _optional_text(core, restart.get("Name"), "HOST_CONFIGURATION_INVALID", 64),
        "maximum_retry_count": restart.get("MaximumRetryCount") if isinstance(restart.get("MaximumRetryCount"), int) else 0,
    }
    return {
        "scalars": scalars,
        "cap_add": _string_list(core, host.get("CapAdd"), "HOST_CONFIGURATION_INVALID"),
        "cap_drop": _string_list(core, host.get("CapDrop"), "HOST_CONFIGURATION_INVALID"),
        "security_options": _string_list(core, host.get("SecurityOpt"), "HOST_CONFIGURATION_INVALID"),
        "devices": _devices(core, host.get("Devices")),
        "device_requests": _device_requests(core, host.get("DeviceRequests")),
        "extra_hosts": _string_list(core, host.get("ExtraHosts"), "HOST_CONFIGURATION_INVALID"),
        "dns": _string_list(core, host.get("Dns"), "HOST_CONFIGURATION_INVALID"),
        "dns_options": _string_list(core, host.get("DnsOptions"), "HOST_CONFIGURATION_INVALID"),
        "dns_search": _string_list(core, host.get("DnsSearch"), "HOST_CONFIGURATION_INVALID"),
        "ulimits": _ulimits(core, host.get("Ulimits")),
        "restart_policy": restart_projection,
        "sysctls": _string_map(core, host.get("Sysctls"), "HOST_CONFIGURATION_INVALID"),
        "tmpfs": _string_map(core, host.get("Tmpfs"), "HOST_CONFIGURATION_INVALID"),
    }


def _healthcheck(core: Any, value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        _fault(core, "HEALTHCHECK_CONFIGURATION_INVALID")
    test = value.get("Test")
    if not isinstance(test, list) or not test or len(test) > 32 or not all(isinstance(item, str) for item in test):
        _fault(core, "HEALTHCHECK_CONFIGURATION_INVALID")
    if test[0] not in {"NONE", "CMD", "CMD-SHELL"}:
        _fault(core, "HEALTHCHECK_CONFIGURATION_INVALID")
    # Compose interpolation can place secrets in healthcheck arguments.  Bind
    # their exact values only through the verified aggregate config hash.
    output = {
        "test_form": test[0],
        "test_argument_count": len(test) - 1,
        "test_plaintext_emitted": False,
    }
    for source, target in (
        ("Interval", "interval_nanoseconds"),
        ("Timeout", "timeout_nanoseconds"),
        ("StartPeriod", "start_period_nanoseconds"),
        ("StartInterval", "start_interval_nanoseconds"),
        ("Retries", "retries"),
    ):
        raw = value.get(source, 0)
        if not isinstance(raw, int) or isinstance(raw, bool) or raw < 0:
            _fault(core, "HEALTHCHECK_CONFIGURATION_INVALID")
        output[target] = raw
    return output


def _compose_labels(core: Any, labels: Any, service: str) -> dict[str, str]:
    if not isinstance(labels, dict):
        _fault(core, "COMPOSE_LABELS_INVALID")
    required = {
        "com.docker.compose.project": COMPOSE_PROJECT,
        "com.docker.compose.service": service,
    }
    output: dict[str, str] = {}
    for key in (
        "com.docker.compose.project", "com.docker.compose.service",
        "com.docker.compose.config-hash", "com.docker.compose.image",
        "com.docker.compose.version",
    ):
        if key in labels:
            output[key] = _safe_string(core, labels[key], "COMPOSE_LABELS_INVALID", 1024)
    if any(output.get(key) != value for key, value in required.items()):
        _fault(core, "COMPOSE_LABELS_INVALID")
    if not SHA64.fullmatch(output.get("com.docker.compose.config-hash", "")):
        _fault(core, "COMPOSE_CONFIG_HASH_INVALID")
    return output


SUPPORTED_SERVICE_FIELDS = frozenset({
    # ordering/build only: no effect on the recreated container
    "build", "depends_on",
    # compared below
    "container_name", "image", "entrypoint", "command", "environment", "restart",
    "volumes", "networks", "extra_hosts", "logging", "healthcheck", "user",
    "working_dir", "privileged", "read_only", "cap_add", "cap_drop",
    "security_opt", "init", "stop_signal", "stop_grace_period",
})
GO_DURATION = re.compile(r"(?:[0-9]+(?:\.[0-9]+)?(?:h|m|s|ms|us|ns))+")
GO_DURATION_PART = re.compile(r"([0-9]+(?:\.[0-9]+)?)(ms|us|ns|h|m|s)")
DURATION_UNITS = {"h": 3600 * 10**9, "m": 60 * 10**9, "s": 10**9, "ms": 10**6, "us": 10**3, "ns": 1}


def _duration(core: Any, value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    if not isinstance(value, str) or not GO_DURATION.fullmatch(value):
        _fault(core, "RESOLVED_DURATION_INVALID")
    return int(sum(float(amount) * DURATION_UNITS[unit] for amount, unit in GO_DURATION_PART.findall(value)))


def _host_pairs(core: Any, value: Any, separator: str) -> list[tuple[str, str]]:
    if value is None:
        return []
    if isinstance(value, dict):
        pairs = []
        for host, addresses in value.items():
            for address in addresses if isinstance(addresses, list) else [addresses]:
                pairs.append((host, address))
        return sorted(pairs)
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        _fault(core, "EXTRA_HOSTS_CONFIGURATION_INVALID")
    pairs = []
    for item in value:
        mark = separator if separator in item else ":"
        host, _, address = item.partition(mark)
        if not host or not address:
            _fault(core, "EXTRA_HOSTS_CONFIGURATION_INVALID")
        pairs.append((host, address))
    return sorted(pairs)


def _healthcheck_projection(core: Any, value: Any) -> Any:
    if value is None:
        return None
    if not isinstance(value, dict):
        _fault(core, "HEALTHCHECK_CONFIGURATION_INVALID")
    return {key: value.get(key) or (0 if key != "Test" else None) for key in ("Test", "Interval", "Timeout", "StartPeriod", "StartInterval", "Retries")}


def _resolved_healthcheck(core: Any, value: Any, image_default: Any) -> Any:
    if value is None:
        return _healthcheck_projection(core, image_default)
    if not isinstance(value, dict):
        _fault(core, "RESOLVED_HEALTHCHECK_INVALID")
    if value.get("disable") is True:
        return _healthcheck_projection(core, {"Test": ["NONE"]})
    test = value.get("test")
    if isinstance(test, str):
        test = ["CMD-SHELL", test]
    retries = value.get("retries")
    return _healthcheck_projection(core, {
        "Test": test,
        "Interval": _duration(core, value.get("interval")),
        "Timeout": _duration(core, value.get("timeout")),
        "StartPeriod": _duration(core, value.get("start_period")),
        "StartInterval": _duration(core, value.get("start_interval")),
        "Retries": retries if isinstance(retries, int) else 0,
    })


def _compare_host_semantics(
    core: Any, target: dict[str, Any], service: dict[str, Any], image_config: dict[str, Any],
    config: dict[str, Any], host: dict[str, Any],
) -> None:
    """Every resolved field must be one this observer reproduces, and must equal live."""
    name = target["compose_service"]
    unsupported = sorted(set(service) - SUPPORTED_SERVICE_FIELDS)
    if unsupported:
        _fault(core, "RESOLVED_SERVICE_FIELD_UNSUPPORTED", {"service": name, "fields": unsupported})

    def drift(field: str) -> None:
        _fault(core, "HOST_SEMANTIC_RECONSTRUCTION_DRIFT", {"service": name, "field": field})

    if service.get("container_name") != target["container_name"]:
        drift("container_name")
    if _host_pairs(core, service.get("extra_hosts"), "=") != _host_pairs(core, host.get("ExtraHosts"), ":"):
        drift("extra_hosts")
    logging = service.get("logging")
    live_logging = host.get("LogConfig")
    if (
        not isinstance(logging, dict) or not isinstance(live_logging, dict)
        or (logging.get("driver") or "json-file") != live_logging.get("Type")
        or (logging.get("options") or {}) != (live_logging.get("Config") or {})
    ):
        drift("logging")
    if _resolved_healthcheck(core, service.get("healthcheck"), image_config.get("Healthcheck")) != _healthcheck_projection(core, config.get("Healthcheck")):
        drift("healthcheck")
    if (service.get("user") or image_config.get("User") or "") != (config.get("User") or ""):
        drift("user")
    if (service.get("working_dir") or image_config.get("WorkingDir") or "") != (config.get("WorkingDir") or ""):
        drift("working_dir")
    if bool(service.get("privileged")) != (host.get("Privileged") is True):
        drift("privileged")
    if bool(service.get("read_only")) != (host.get("ReadonlyRootfs") is True):
        drift("read_only")
    for field, live in (("cap_add", "CapAdd"), ("cap_drop", "CapDrop"), ("security_opt", "SecurityOpt")):
        if sorted(service.get(field) or []) != sorted(host.get(live) or []):
            drift(field)
    if bool(service.get("init")) != (host.get("Init") is True):
        drift("init")
    if (service.get("stop_signal") or image_config.get("StopSignal") or "") != (config.get("StopSignal") or ""):
        drift("stop_signal")
    grace = service.get("stop_grace_period")
    expected_timeout = None if grace is None else _duration(core, grace) // 10**9
    if config.get("StopTimeout") != expected_timeout:
        drift("stop_grace_period")
    if host.get("PortBindings") or host.get("Tmpfs"):
        drift("ports_or_tmpfs")


def _resolved_argv(core: Any, value: Any, default: Any, code: str) -> list[str]:
    """The argv Docker applies: the resolved service value, else the image default."""
    chosen = default if value is None else value
    if chosen is None:
        return []
    if isinstance(chosen, str):
        # Compose normalises string forms to lists; a bare string here is not
        # a shape this observer can compare exactly.
        _fault(core, code)
    if not isinstance(chosen, list) or len(chosen) > 32 or not all(isinstance(item, str) for item in chosen):
        _fault(core, code)
    return list(chosen)


MOUNT_FIELDS = frozenset({"type", "source", "target", "read_only", "volume", "bind"})


def _expected_mounts(core: Any, compose: dict[str, Any], service: dict[str, Any]) -> list[tuple[str, str, str, bool]]:
    declared = service.get("volumes") or []
    top_level = compose.get("volumes") or {}
    if not isinstance(declared, list) or not isinstance(top_level, dict) or len(declared) > 128:
        _fault(core, "RESOLVED_MOUNT_CONFIGURATION_INVALID")
    output = []
    for item in declared:
        if not isinstance(item, dict) or not isinstance(item.get("target"), str):
            _fault(core, "RESOLVED_MOUNT_CONFIGURATION_INVALID")
        # Closed-world below the top level too: only the reproduced mount shape.
        if (
            not set(item) <= MOUNT_FIELDS
            or item.get("volume") not in (None, {})
            or item.get("bind") not in (None, {}, {"create_host_path": True})
            or not isinstance(item.get("read_only", False), bool)
        ):
            _fault(core, "RESOLVED_SERVICE_FIELD_UNSUPPORTED", {"service": service.get("container_name"), "fields": ["volumes"]})
        kind = item.get("type")
        read_write = item.get("read_only") is not True
        if kind == "volume":
            definition = top_level.get(item.get("source"))
            if not isinstance(definition, dict) or not isinstance(definition.get("name"), str):
                _fault(core, "RESOLVED_MOUNT_CONFIGURATION_INVALID")
            output.append(("volume", definition["name"], item["target"], read_write))
        elif kind == "bind":
            if not isinstance(item.get("source"), str):
                _fault(core, "RESOLVED_MOUNT_CONFIGURATION_INVALID")
            output.append(("bind", item["source"], item["target"], read_write))
        elif kind == "tmpfs":
            output.append(("tmpfs", "", item["target"], True))
        else:
            _fault(core, "RESOLVED_MOUNT_CONFIGURATION_INVALID")
    return sorted(output)


def _expected_networks(core: Any, compose: dict[str, Any], service: dict[str, Any]) -> list[str]:
    if service.get("network_mode") is not None:
        _fault(core, "RESOLVED_NETWORK_MODE_UNSUPPORTED")
    declared = service.get("networks") or {}
    top_level = compose.get("networks") or {}
    if not isinstance(declared, dict) or not isinstance(top_level, dict) or not declared:
        _fault(core, "RESOLVED_NETWORK_CONFIGURATION_INVALID")
    names = []
    for key in declared:
        if declared[key] not in (None, {}):
            # Per-network aliases, addresses or priorities are not reproduced here.
            _fault(core, "RESOLVED_SERVICE_FIELD_UNSUPPORTED", {"service": service.get("container_name"), "fields": ["networks"]})
        definition = top_level.get(key)
        if not isinstance(definition, dict) or not isinstance(definition.get("name"), str):
            _fault(core, "RESOLVED_NETWORK_CONFIGURATION_INVALID")
        names.append(definition["name"])
    return sorted(names)


def _observe_target(
    core: Any,
    policy: dict[str, Any],
    target: dict[str, Any],
    resolutions: dict[tuple[str, ...], dict[str, Any]],
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    logical = target["logical_resource"]
    record = policy.get("resources", {}).get(logical)
    if (
        not isinstance(record, dict)
        or record.get("kind") != "container"
        or record.get("name") != target["container_name"]
        or "docker-inspect" not in record.get("operations", [])
    ):
        _fault(core, "OBSERVATION_POLICY_BINDING_INVALID")
    raw = core.docker_json(["container", "inspect", target["container_name"]], policy)
    if raw.get("Name") != "/" + target["container_name"]:
        _fault(core, "TARGET_CONTAINER_IDENTITY_MISMATCH")
    container_id = raw.get("Id")
    image_id = raw.get("Image")
    created = raw.get("Created")
    if not isinstance(container_id, str) or not SHA64.fullmatch(container_id):
        _fault(core, "TARGET_CONTAINER_IDENTITY_INVALID")
    if not isinstance(image_id, str) or not IMAGE_ID.fullmatch(image_id):
        _fault(core, "TARGET_IMAGE_IDENTITY_INVALID")
    created = _text(core, created, "TARGET_CONTAINER_CREATED_INVALID", 128)
    config = raw.get("Config")
    host = raw.get("HostConfig")
    network_settings = raw.get("NetworkSettings")
    if not isinstance(config, dict) or not isinstance(host, dict) or not isinstance(network_settings, dict):
        _fault(core, "TARGET_CONTAINER_CONFIGURATION_INVALID")
    labels = _compose_labels(core, config.get("Labels"), target["compose_service"])

    # Reconstruct the effective service from the container's own creation stack.
    files, image_pins, layers = _layer_stack(core, config.get("Labels"))
    if files not in resolutions:
        resolutions[files] = _resolve_stack(core, policy, files)
    compose = resolutions[files]
    compose_service = compose["services"].get(target["compose_service"])
    if not isinstance(compose_service, dict):
        _fault(core, "RESOLVED_COMPOSE_SERVICE_MISSING", {"service": target["compose_service"]})
    compose_service = dict(compose_service)
    if target["compose_service"] in image_pins:
        compose_service["image"] = image_pins[target["compose_service"]]

    # Image: the reconstructed reference must be the one the container was
    # created from and must still name exactly the running image.
    configured_image = _text(core, config.get("Image"), "CONFIGURED_IMAGE_REFERENCE_INVALID", 1024)
    reconstructed_image = _text(core, compose_service.get("image"), "RESOLVED_IMAGE_REFERENCE_INVALID", 1024)
    if not IMAGE_REFERENCE.fullmatch(reconstructed_image) or configured_image != reconstructed_image:
        _fault(core, "TARGET_IMAGE_RECONSTRUCTION_DRIFT", {"service": target["compose_service"]})
    image = core.docker_json(["image", "inspect", reconstructed_image], policy)
    if image.get("Id") != image_id or not isinstance(image.get("Config"), dict):
        _fault(core, "TARGET_IMAGE_RECONSTRUCTION_DRIFT", {"service": target["compose_service"]})

    entrypoint = _argv(core, config.get("Entrypoint"), target["allowed_entrypoints"], "ENTRYPOINT_CONFIGURATION_INVALID")
    expected_entrypoint = _resolved_argv(core, compose_service.get("entrypoint"), image["Config"].get("Entrypoint"), "ENTRYPOINT_CONFIGURATION_INVALID")
    if entrypoint != expected_entrypoint:
        _fault(core, "ENTRYPOINT_RECONSTRUCTION_DRIFT", {"service": target["compose_service"]})
    command = _argv(core, config.get("Cmd"), target["allowed_commands"], "COMMAND_CONFIGURATION_INVALID")
    expected_command = _resolved_argv(core, compose_service.get("command"), image["Config"].get("Cmd"), "COMMAND_CONFIGURATION_INVALID")
    if command != expected_command:
        _fault(core, "COMMAND_RECONSTRUCTION_DRIFT", {"service": target["compose_service"]})

    _compare_host_semantics(core, target, compose_service, image["Config"], config, host)
    host_projection = _host_config(core, host)
    expected_restart = compose_service.get("restart") or "no"
    if (host_projection["restart_policy"]["name"] or "no") != expected_restart:
        _fault(core, "RESTART_POLICY_RECONSTRUCTION_DRIFT", {"service": target["compose_service"]})

    mounts, volumes = _mounts(core, policy, raw.get("Mounts"))
    actual_mounts = sorted(
        (item["type"], item.get("name", item.get("source", "")), item["target"], item["read_write"])
        for item in mounts
    )
    if actual_mounts != _expected_mounts(core, compose, compose_service):
        _fault(core, "MOUNT_RECONSTRUCTION_DRIFT", {"service": target["compose_service"]})
    if target["compose_service"] == "tg-bot":
        required_volume = [item for item in mounts if item.get("name") == "crm_tg_bot_data"]
        if required_volume != [{
            "type": "volume", "target": "/app/data", "read_write": True,
            "propagation": "", "name": "crm_tg_bot_data",
        }]:
            _fault(core, "TELEGRAM_PERSISTENT_VOLUME_CONTRACT_INVALID")
    if target["compose_service"] == "max-web-scraper":
        required_volume = [item for item in mounts if item.get("name") == "crm_max_user_data"]
        if len(required_volume) != 1 or required_volume[0]["target"] != "/app/user_data" or required_volume[0]["read_write"] is not True:
            _fault(core, "MAX_PERSISTENT_VOLUME_CONTRACT_INVALID")

    attachments, networks = _networks(core, policy, network_settings.get("Networks"))
    if sorted(item["name"] for item in attachments) != _expected_networks(core, compose, compose_service):
        _fault(core, "NETWORK_RECONSTRUCTION_DRIFT", {"service": target["compose_service"]})

    # Environment last: every other semantic has already been reconstructed
    # when a known name-set condition is reported.
    actual_environment = _environment_map(core, config.get("Env"), "container")
    image_environment = _environment_map(core, image["Config"].get("Env"), "image")
    compose_environment = _environment_map(core, compose_service.get("environment"), "compose")
    expected_environment = {**image_environment, **compose_environment}
    injected_keys: list[str] = []
    for key in sorted(set(actual_environment) - set(expected_environment)):
        if key == "HOSTNAME" and actual_environment[key] == config.get("Hostname"):
            injected_keys.append(key)
            continue
        _fault(core, "EFFECTIVE_ENVIRONMENT_KEY_DRIFT", {"service": target["compose_service"], "unexpected_key": key})
    comparable_actual = {key: value for key, value in actual_environment.items() if key not in injected_keys}
    if set(comparable_actual) != set(expected_environment):
        _fault(core, "EFFECTIVE_ENVIRONMENT_KEY_DRIFT", {
            "service": target["compose_service"],
            "missing_keys": sorted(set(expected_environment) - set(comparable_actual)),
        })
    if comparable_actual != expected_environment:
        _fault(core, "EFFECTIVE_ENVIRONMENT_VALUE_DRIFT", {"service": target["compose_service"]})

    service_environment_keys = sorted(compose_environment)
    service_projection = _service_projection(core, compose_service, service_environment_keys)
    repo_digests = _string_list(core, image.get("RepoDigests"), "IMAGE_REPOSITORY_DIGEST_INVALID")
    for digest in repo_digests:
        if "@sha256:" not in digest:
            _fault(core, "IMAGE_REPOSITORY_DIGEST_INVALID")

    lifecycle = {
        "healthcheck": _healthcheck(core, config.get("Healthcheck")),
        "stop_signal": _optional_text(core, config.get("StopSignal"), "STOP_SIGNAL_INVALID", 64),
        "stop_timeout_seconds": config.get("StopTimeout") if isinstance(config.get("StopTimeout"), int) else 0,
        "init": host.get("Init") if isinstance(host.get("Init"), bool) else None,
    }
    return ({
        "logical_resource": logical,
        "compose_service": target["compose_service"],
        "container": {
            "id": container_id,
            "name": target["container_name"],
            "created": created,
        },
        "image": {
            "id": image_id,
            "configured_reference": configured_image,
            "reconstructed_reference": reconstructed_image,
            "reconstructed_reference_matches_container": True,
            "repository_digests": repo_digests,
            "created": _optional_text(core, image.get("Created"), "IMAGE_CREATED_INVALID", 128),
            "platform": {
                "os": _optional_text(core, image.get("Os"), "IMAGE_PLATFORM_INVALID", 64),
                "architecture": _optional_text(core, image.get("Architecture"), "IMAGE_PLATFORM_INVALID", 64),
            },
        },
        "execution": {
            "entrypoint": entrypoint,
            "command": command,
            "working_directory": _optional_text(core, config.get("WorkingDir"), "WORKING_DIRECTORY_INVALID", 1024),
            "user": _optional_text(core, config.get("User"), "DECLARED_USER_INVALID", 256),
        },
        "environment": {
            "effective_key_set": sorted(actual_environment),
            "compose_key_set": service_environment_keys,
            "image_default_key_set": sorted(image_environment),
            "docker_injected_key_set": injected_keys,
            "effective_values_match_reconstructed_compose_and_image": True,
            "binding_method": "ROOT_INTERNAL_EXACT_EQUALITY_NO_VALUE_DIGEST",
            "plaintext_values_emitted": False,
            "value_digests_emitted": False,
        },
        "mounts": mounts,
        "network_attachments": attachments,
        "published_ports": core.semantic_published_ports(network_settings.get("Ports")),
        "host_config": host_projection,
        "lifecycle": lifecycle,
        "compose": {
            "project": labels["com.docker.compose.project"],
            "service": labels["com.docker.compose.service"],
            "container_creation_config_hash": labels["com.docker.compose.config-hash"],
            "config_hash_binding_method": "RECORDED_NOT_RECOMPUTED",
            "labels": labels,
            "secret_free_resolved_service_shape": service_projection,
        },
        "reconstruction": {
            "model": "EFFECTIVE_LAYERED_CONTAINER_CREATION_STACK",
            "layers": [{"path": COMPOSE_PATH, "role": "base-compose"}, *layers],
            "compose_files_resolved": list(files),
            "verified": [
                "image", "entrypoint", "command", "container_name", "extra_hosts",
                "logging", "healthcheck", "user", "working_dir", "privileged",
                "read_only", "capabilities", "security_options", "init",
                "stop_signal", "stop_grace_period", "ports_and_tmpfs",
                "restart_policy", "mounts", "networks", "environment_names",
                "environment_values",
            ],
            "unsupported_resolved_fields_refused": True,
        },
    }, volumes, networks, layers)


def _release_critical_service(service: dict[str, Any]) -> dict[str, Any]:
    """Exclude Category C facts that recreation intentionally changes."""
    output = {
        key: value
        for key, value in service.items()
        if key not in {"container", "network_attachments"}
    }
    output["container_name"] = service["container"]["name"]
    output["network_attachments"] = [
        {
            key: value
            for key, value in attachment.items()
            if key != "observational_endpoint"
        }
        for attachment in service["network_attachments"]
    ]
    image = dict(output["image"])
    image.pop("created", None)
    output["image"] = image
    return output


def observe(core: Any, policy: dict[str, Any]) -> dict[str, Any]:
    """Return one bounded observation without writing host or Docker state."""
    compose_value = _fixed_production_file(core, COMPOSE_PATH, 0o644, 4 * 1024 * 1024)
    _fixed_production_file(core, ENVIRONMENT_PATH, 0o600, 4 * 1024 * 1024)
    compose_sha = core.hash_file(core.mapped(COMPOSE_PATH), maximum=compose_value.st_size + 1)
    resolutions: dict[tuple[str, ...], dict[str, Any]] = {}
    observations = []
    volumes: dict[str, dict[str, Any]] = {}
    networks: dict[str, dict[str, Any]] = {}
    layers: dict[str, dict[str, Any]] = {}
    for target in TARGETS:
        observation, target_volumes, target_networks, target_layers = _observe_target(
            core, policy, target, resolutions,
        )
        observations.append(observation)
        for volume in target_volumes:
            existing = volumes.setdefault(volume["name"], volume)
            if existing != volume:
                _fault(core, "VOLUME_OBSERVATION_INCONSISTENT")
        for network in target_networks:
            existing = networks.setdefault(network["name"], network)
            if existing != network:
                _fault(core, "NETWORK_OBSERVATION_INCONSISTENT")
        for layer in target_layers:
            existing = layers.setdefault(layer["path"], layer)
            if existing != layer:
                _fault(core, "PREDECESSOR_LAYER_OBSERVATION_INCONSISTENT")
    output = {
        "schema": SCHEMA,
        "state_partition": {
            "release_critical_recreation_configuration": "BOUND",
            "mutable_application_runtime_state": "PRESERVED_NOT_CONTENT_HASHED",
            "observational_ephemeral_metadata": "RECORDED_SEPARATELY",
        },
        "compose_source": {
            "project": COMPOSE_PROJECT,
            "project_directory": PROJECT_DIRECTORY,
            "compose_file": COMPOSE_PATH,
            "compose_file_sha256": compose_sha,
            "environment_file": ENVIRONMENT_PATH,
            "environment_file_plaintext_emitted": False,
            "environment_file_digest_emitted": False,
            "environment_binding": "ROOT_INTERNAL_EXACT_EQUALITY_TO_RECONSTRUCTED_SERVICES",
            "reconstruction_model": "EFFECTIVE_LAYERED_CONTAINER_CREATION_STACK",
            "overlay_layers": [layers[key] for key in sorted(layers)],
        },
        "services": observations,
        "volumes": [volumes[key] for key in sorted(volumes)],
        "networks": [networks[key] for key in sorted(networks)],
        "secret_values_emitted": False,
        "production_mutated": False,
        "read_only_primitives": [
            "docker compose config",
            "docker container inspect",
            "docker image inspect", "docker network inspect", "docker volume inspect",
        ],
    }
    output["release_critical_identity_sha256"] = _canonical_sha(core, {
        "schema": SCHEMA,
        "compose_source": output["compose_source"],
        "services": [_release_critical_service(service) for service in observations],
        "volumes": output["volumes"],
        "networks": output["networks"],
    })
    return output
