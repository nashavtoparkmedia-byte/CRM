#!/usr/bin/python3 -I
"""Fail-closed verifier for generated Runtime v15 package inputs."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import subprocess
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
GENERATED = ROOT / "generated"
DIST = ROOT / "dist"
PREFIX = "architecture/recovery/control-plane/v2/owner-bootstrap/crm-6e3f094bf4b4-gravity-max-source-v1"


def duplicate_safe(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key, value in pairs:
        if key in output:
            raise ValueError("duplicate JSON key")
        output[key] = value
    return output


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="ascii"), object_pairs_hook=duplicate_safe)
    if not isinstance(value, dict):
        raise ValueError("JSON root is not an object")
    return value


def sha(path: Path) -> str:
    descriptor = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(descriptor.st_mode) or descriptor.st_nlink != 1:
        raise ValueError(f"unsafe file: {path}")
    output = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            output.update(chunk)
    return output.hexdigest()


def git(*args: str) -> bytes:
    completed = subprocess.run(["git", "-C", str(ROOT), *args], check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if completed.returncode != 0:
        raise ValueError("git verification failed")
    return completed.stdout


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=("package", "package-output"), required=True)
    args = parser.parse_args()
    sealed = load(GENERATED / "sealed-inputs.v1.json")
    if sealed.get("schema") != "yoko.crm.coordinated-runtime-sealed-inputs.v1":
        raise ValueError("sealed input schema mismatch")
    builder = sealed.get("runtime_builder")
    if not isinstance(builder, dict):
        raise ValueError("runtime builder binding missing")
    head = git("rev-parse", "HEAD^{commit}").decode("ascii").strip()
    tree = git("rev-parse", "HEAD^{tree}").decode("ascii").strip()
    if head != builder.get("commit") or tree != builder.get("tree"):
        raise ValueError("runtime builder identity mismatch")
    if git("status", "--porcelain=v1", "--untracked-files=all"):
        raise ValueError("runtime builder checkout is dirty")
    inventory = builder.get("subtree_inventory")
    if not isinstance(inventory, list) or not inventory:
        raise ValueError("runtime builder inventory missing")
    for row in inventory:
        if not isinstance(row, dict) or set(row) != {"path", "mode", "blob", "sha256", "bytes"}:
            raise ValueError("runtime builder inventory row invalid")
        path = ROOT / row["path"]
        if sha(path) != row["sha256"] or path.stat().st_size != row["bytes"]:
            raise ValueError("runtime builder source bytes drifted")
        mode = "100755" if path.stat().st_mode & 0o111 else "100644"
        if mode != row["mode"]:
            raise ValueError("runtime builder source mode drifted")
    trusted = sealed.get("trusted_boundary")
    expected_trusted = {
        "core_sha256": "0f97bafbfe5b430fa7994119b1fc76fead4bdbee26766c730d9e399551ebdffa",
        "predecessor_observer_sha256": "b5ea36c50e12b0fe6c171896258ddfc00a9d2666778735cae6a9b2a8df6d4084",
        "policy_sha256": "8727373b0c6ec79c9abf82f1aaaa58abc2bae67e96aa96a602ac419f308db0e0",
        "sudoers_sha256": "3022dcfc323706da81e760255dd1ab43f9b8662ee699aa8b58fbe6e714cc69d7",
    }
    if trusted != expected_trusted:
        raise ValueError("trusted boundary binding mismatch")
    expected_generated = {
        "crm-activation-profile.py": sealed.get("generated", {}).get("profile_runtime_sha256"),
        "profile.v1.json": sealed.get("generated", {}).get("profile_sha256"),
        "artifact-admission.v1.json": sealed.get("artifact_admission", {}).get("receipt_sha256"),
    }
    for name, expected in expected_generated.items():
        if not isinstance(expected, str) or sha(GENERATED / name) != expected:
            raise ValueError(f"generated input mismatch: {name}")
    profile = load(GENERATED / "profile.v1.json")
    if (
        profile.get("profile_id") != "crm-6e3f094bf4b4-gravity-max-source-v1"
        or profile.get("package_version") != "2.0.0-15"
        or profile.get("artifact_admission", {}).get("receipt_sha256") != expected_generated["artifact-admission.v1.json"]
        or profile.get("database", {}).get("mutation_authorized") is not False
        or any(profile.get("negative_properties", {}).values())
    ):
        raise ValueError("generated profile contract mismatch")
    if args.phase == "package-output":
        package = DIST / "yoko-privileged-runtime_2.0.0-15_all.deb"
        fields = []
        for field in ("Package", "Version", "Architecture"):
            completed = subprocess.run(
                ["dpkg-deb", "-f", str(package), field],
                check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            if completed.returncode != 0:
                raise ValueError("package metadata query failed")
            fields.append(completed.stdout.strip())
        if fields != ["yoko-privileged-runtime", "2.0.0-15", "all"]:
            raise ValueError("package metadata mismatch")
    print(json.dumps({"status": "PASS", "phase": args.phase}, sort_keys=True))


if __name__ == "__main__":
    main()
