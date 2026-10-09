#!/usr/bin/python3
"""Stream-audit one dpkg data tar without extracting it."""
from __future__ import annotations

import hashlib
import json
import stat
import sys
import tarfile
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: audit-data-tar.py EXPECTED.json")
    expected = json.loads(Path(sys.argv[1]).read_text(encoding="ascii"))
    observed: dict[str, dict[str, str]] = {}
    with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as archive:
        for member in archive:
            if member.issym() or member.islnk() or member.isdev():
                raise SystemExit("unsafe package member type")
            if member.uid != 0 or member.gid != 0:
                raise SystemExit("package member is not root-owned")
            if not member.isfile():
                continue
            stream = archive.extractfile(member)
            if stream is None:
                raise SystemExit("package member unreadable")
            digest = hashlib.sha256()
            while chunk := stream.read(8 * 1024 * 1024):
                digest.update(chunk)
            observed[member.name] = {
                "sha256": digest.hexdigest(),
                "mode": format(stat.S_IMODE(member.mode), "04o"),
            }
    if observed != expected:
        raise SystemExit("package data inventory or identity mismatch")


if __name__ == "__main__":
    main()
