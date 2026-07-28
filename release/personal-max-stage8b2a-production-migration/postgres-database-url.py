#!/usr/bin/env python3
"""Build a root-only Prisma DATABASE_URL from one Docker inspect document."""

from __future__ import annotations

import json
import os
import re
import stat
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote


ENV_KEYS = ("POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB")
SAFE_PARENT = re.compile(r"^/var/tmp/personal-max-stage8b2a\.[A-Za-z0-9]{8}$")


class BindingError(Exception):
    """A fail-closed, deliberately silent credential-binding error."""


def extract_credentials(document: Any) -> dict[str, str]:
    if not isinstance(document, list) or len(document) != 1:
        raise BindingError("inspect cardinality")
    container = document[0]
    if not isinstance(container, dict):
        raise BindingError("inspect object")
    config = container.get("Config")
    if not isinstance(config, dict):
        raise BindingError("inspect config")
    environment = config.get("Env")
    if not isinstance(environment, list):
        raise BindingError("inspect environment")

    found: dict[str, list[str]] = {key: [] for key in ENV_KEYS}
    for entry in environment:
        if not isinstance(entry, str):
            raise BindingError("environment entry type")
        if "\x00" in entry or "\n" in entry or "\r" in entry:
            raise BindingError("environment control character")
        name, separator, value = entry.partition("=")
        if separator and name in found:
            found[name].append(value)

    result: dict[str, str] = {}
    for key in ENV_KEYS:
        values = found[key]
        if len(values) != 1 or values[0] == "":
            raise BindingError("missing, duplicate, or empty environment key")
        result[key] = values[0]
    return result


def database_url_line(document: Any) -> bytes:
    credentials = extract_credentials(document)
    user = quote(credentials["POSTGRES_USER"], safe="")
    password = quote(credentials["POSTGRES_PASSWORD"], safe="")
    database = quote(credentials["POSTGRES_DB"], safe="")
    return (
        f"DATABASE_URL=postgresql://{user}:{password}"
        f"@postgres:5432/{database}?schema=public\n"
    ).encode("utf-8")


def write_env_file(
    document: Any,
    output_path: Path,
    owner_uid: int,
    owner_gid: int,
) -> None:
    payload = database_url_line(document)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor: int | None = None
    created = False
    try:
        descriptor = os.open(output_path, flags, 0o600)
        created = True
        os.fchmod(descriptor, 0o600)
        os.fchown(descriptor, owner_uid, owner_gid)
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise BindingError("short write")
            view = view[written:]
        os.fsync(descriptor)
    except Exception:
        if descriptor is not None:
            os.close(descriptor)
            descriptor = None
        if created:
            try:
                output_path.unlink()
            except FileNotFoundError:
                pass
        raise
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _require_regular_root_file(path: Path, mode: int) -> None:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise BindingError("unsafe inspect type")
    if metadata.st_uid != 0 or metadata.st_gid != 0:
        raise BindingError("unsafe inspect ownership")
    if stat.S_IMODE(metadata.st_mode) != mode:
        raise BindingError("unsafe inspect mode")


def _require_output_path(path: Path) -> None:
    if path.name != "migration.env" or not path.is_absolute():
        raise BindingError("unsafe output name")
    parent = path.parent
    if not SAFE_PARENT.fullmatch(str(parent)):
        raise BindingError("unsafe output parent")
    parent_metadata = parent.lstat()
    if not stat.S_ISDIR(parent_metadata.st_mode) or stat.S_ISLNK(parent_metadata.st_mode):
        raise BindingError("unsafe output parent type")
    if parent_metadata.st_uid != 0 or parent_metadata.st_gid != 0:
        raise BindingError("unsafe output parent ownership")
    if stat.S_IMODE(parent_metadata.st_mode) != 0o700:
        raise BindingError("unsafe output parent mode")
    if os.path.lexists(path):
        raise BindingError("output exists")


def main(argv: list[str]) -> int:
    if len(argv) != 3 or os.geteuid() != 0:
        return 77
    inspect_path = Path(argv[1])
    output_path = Path(argv[2])
    try:
        if not inspect_path.is_absolute():
            raise BindingError("inspect path")
        _require_regular_root_file(inspect_path, 0o600)
        _require_output_path(output_path)
        with inspect_path.open("r", encoding="utf-8") as stream:
            document = json.load(stream)
        write_env_file(document, output_path, 0, 0)
        _require_regular_root_file(output_path, 0o600)
    except Exception:
        return 70
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
