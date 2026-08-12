#!/usr/bin/python3 -I
"""Materialize the sealed payload manifests from the deterministic Debian package."""
from __future__ import annotations

import hashlib
import io
import json
import os
import stat
import subprocess
import tarfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROFILE_ID = "crm-af9646f5-gravity-outbox-v1"
NEW_DEB = ROOT / "dist/yoko-privileged-runtime_2.0.0-7_all.deb"
OLD_DEB = ROOT / "inputs/yoko-privileged-runtime_2.0.0-6_all.deb"
PAYLOAD = ROOT / "bundle/payload"
REVIEW = PAYLOAD / "review"
OLD = {
    "package_version": "2.0.0-6",
    "runtime_sha256": "bb4f9ef5f35c2054ab4a9169083191849f988886ddaa2c8afa66b7727389b185",
    "core_sha256": "0cdeeb4ba43abe50f80fed1580ad7b0729bf83358932ece2974b3faedafed57a",
    "profile_runtime_sha256": "cf7ee779f14c5918789f86023c94b1364c789d625687e3c9edfb896ad3e73b86",
    "policy_sha256": "8727373b0c6ec79c9abf82f1aaaa58abc2bae67e96aa96a602ac419f308db0e0",
    "install_manifest_sha256": "a9aae93899ea9d69f895bb476208c720491d33a689bf9c91348e11acd0b955ad",
    "profile_manifest_sha256": "6bc764b127c2d1c70f94e46ce31c404c3b0fa954b63f4971020f7b2a8a35183e",
    "profile_sha256": "92acc225b8501eb5fa4ae2fed5e03b91a6adec63a700d37a4c4cf3db7150a060",
    "migration_sha256": "433b0d503f054ed6a8161a059e2650d5e401829dabe8c9d992a1d1763eef0016",
    "source_archive_sha256": "c43d6e6ea0735b7a5dad9117822df24b7ec0133685c69b8c13b50effc7c9f808",
    "sudoers_sha256": "6e6b7cb2a088cc92fa7aee747adca46c64b4b96d1224be21117be5adef488c06",
    "registry_sha256": "8ea5c3b7113e1dd2ad5a74b82a1fb0bf56643fd59774dccf37e8aa9eb67bd057",
    "rollback_deb_sha256": "597f58d813f7a0f3631b9d1778588db880c00e7df97d92a51cef385f8f4d8ba0",
    "audit_state": "EMPTY",
    "audit_records": 0,
}


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: object, mode: int = 0o400) -> None:
    temporary = path.with_name(path.name + ".new")
    temporary.unlink(missing_ok=True)
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="ascii")
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def copy_exact(source: Path, destination: Path, mode: int) -> None:
    temporary = destination.with_name(destination.name + ".new")
    temporary.unlink(missing_ok=True)
    with source.open("rb") as reader, temporary.open("xb") as writer:
        while chunk := reader.read(1024 * 1024):
            writer.write(chunk)
        writer.flush()
        os.fsync(writer.fileno())
    os.chmod(temporary, mode)
    os.replace(temporary, destination)


def package_files() -> dict[str, dict[str, object]]:
    raw = subprocess.run(
        ["/usr/bin/dpkg-deb", "--fsys-tarfile", str(NEW_DEB)],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=120,
    ).stdout
    output: dict[str, dict[str, object]] = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            source = archive.extractfile(member)
            if source is None:
                raise SystemExit("package member unavailable")
            data = source.read()
            destination = "/" + member.name.removeprefix("./")
            if destination in output:
                raise SystemExit("duplicate package destination")
            if member.uid != 0 or member.gid != 0:
                raise SystemExit("package member is not root-owned")
            output[destination] = {
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
                "uid": member.uid,
                "gid": member.gid,
                "mode": format(stat.S_IMODE(member.mode), "04o"),
            }
    return output


def main() -> None:
    for path in (NEW_DEB, OLD_DEB, PAYLOAD / "install.sh", REVIEW / "human-manifest.md", REVIEW / "installation-procedure.md", REVIEW / "rollback-analysis.md"):
        value = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
            raise SystemExit(f"unsafe input: {path}")
    if sha(OLD_DEB) != OLD["rollback_deb_sha256"]:
        raise SystemExit("predecessor package identity mismatch")
    os.chmod(PAYLOAD, 0o700)
    os.chmod(REVIEW, 0o700)
    metadata = subprocess.run(
        ["/usr/bin/dpkg-deb", "-f", str(NEW_DEB), "Package", "Version", "Architecture"],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=30,
    ).stdout.splitlines()
    if metadata != ["Package: yoko-privileged-runtime", "Version: 2.0.0-7", "Architecture: all"]:
        raise SystemExit("successor package metadata mismatch")

    observed = package_files()
    profile_root = f"/usr/local/share/yoko-privileged-runtime/profiles/{PROFILE_ID}"
    specifications = {
        "/etc/sudoers.d/92-yoko-privileged-runtime": ("packaging/92-yoko-privileged-runtime", "unchanged finite sudo command allowlist", f"EXACT_SHA256:{OLD['sudoers_sha256']}"),
        "/usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py": ("src/yoko-privileged-runtime-core.py", "immutable Runtime V2 core", f"EXACT_SHA256:{OLD['core_sha256']}"),
        f"/usr/local/libexec/yoko-privileged-runtime/{PROFILE_ID}.py": ("src/crm-activation-profile.py", "finite activation profile implementation", f"EXACT_SHA256:{OLD['profile_runtime_sha256']}"),
        "/usr/local/sbin/yoko-privileged-runtime": ("generated from src/yoko-privileged-runtime with the generated overlay-manifest SHA256", "integrity-bound Runtime V2 wrapper", f"EXACT_SHA256:{OLD['runtime_sha256']}"),
        "/usr/local/share/yoko-privileged-runtime/install-manifest.v1.json": ("generated by packaging/build-package.sh", "Runtime installed-file identity manifest", f"EXACT_SHA256:{OLD['install_manifest_sha256']}"),
        "/usr/local/share/yoko-privileged-runtime/policy.v2.json": ("src/policy.v2.base.json", "deny-by-default resource and operation policy", f"EXACT_SHA256:{OLD['policy_sha256']}"),
        f"{profile_root}/manifest.v1.json": ("generated by packaging/build-package.sh", "profile artifact identity manifest", f"EXACT_SHA256:{OLD['profile_manifest_sha256']}"),
        f"{profile_root}/migration.sql": ("inputs/migration.sql", "single accepted expand-only outbox migration", f"EXACT_SHA256:{OLD['migration_sha256']}"),
        f"{profile_root}/profile.v1.json": ("src/profile.v1.json", "fixed activation targets and identities", f"EXACT_SHA256:{OLD['profile_sha256']}"),
        f"{profile_root}/source.tar.gz": ("inputs/source.tar.gz", "sealed accepted source archive", f"EXACT_SHA256:{OLD['source_archive_sha256']}"),
    }
    if set(observed) != set(specifications):
        raise SystemExit("unlisted or missing installed package file")
    installed = []
    for destination in sorted(specifications):
        source_path, role, previous = specifications[destination]
        installed.append({
            "source_path": source_path,
            "package_member": "." + destination,
            "destination_path": destination,
            **observed[destination],
            "role": role,
            "previous_state_expectation": previous,
        })
    if len({item["destination_path"] for item in installed}) != len(installed):
        raise SystemExit("duplicate destination")

    inputs = {}
    for relative in (
        "src/yoko-privileged-runtime",
        "src/yoko-privileged-runtime-core.py",
        "src/crm-activation-profile.py",
        "src/policy.v2.base.json",
        "src/profile.v1.json",
        "inputs/source.tar.gz",
        "inputs/migration.sql",
        "inputs/yoko-privileged-runtime_2.0.0-6_all.deb",
        "packaging/92-yoko-privileged-runtime",
        "packaging/control",
        "packaging/postinst",
        "packaging/build-package.sh",
    ):
        inputs[relative] = sha(ROOT / relative)

    review_manifest = {
        "schema": "yoko.crm.owner-bootstrap-review-manifest.v2",
        "profile_id": PROFILE_ID,
        "new_package": {
            "path": "yoko-privileged-runtime_2.0.0-7_all.deb",
            "sha256": sha(NEW_DEB),
            "bytes": NEW_DEB.stat().st_size,
            "name": "yoko-privileged-runtime",
            "version": "2.0.0-7",
            "runtime_abi": "2.0.0",
            "architecture": "all",
        },
        "previous_state": OLD,
        "build_inputs": inputs,
        "installed_artifacts": installed,
        "enabled_zero_argument_profiles": ["database-status", "release-preflight", "database-migrate", "release-activate", "rollback"],
        "disabled_profiles": ["config-activate"],
        "sudoers_widening": False,
        "bootstrap_production_mutation": False,
        "bootstrap_database_mutation": False,
        "success_marker": "YOKO_ACTIVATION_BOOTSTRAP_OK",
        "failure_marker": "YOKO_ACTIVATION_BOOTSTRAP_FAILED",
    }
    copy_exact(NEW_DEB, PAYLOAD / NEW_DEB.name, 0o400)
    copy_exact(OLD_DEB, PAYLOAD / OLD_DEB.name, 0o400)
    write_json(REVIEW / "package-manifest.json", review_manifest)

    files: dict[str, dict[str, str]] = {}
    expected_modes = {
        "install.sh": 0o500,
        OLD_DEB.name: 0o400,
        NEW_DEB.name: 0o400,
        "review/human-manifest.md": 0o400,
        "review/package-manifest.json": 0o400,
        "review/installation-procedure.md": 0o400,
        "review/rollback-analysis.md": 0o400,
    }
    for relative, mode in sorted(expected_modes.items()):
        path = PAYLOAD / relative
        os.chmod(path, mode)
        files[relative] = {"sha256": sha(path), "mode": format(mode, "04o")}
    payload_manifest = {
        "schema": "yoko.crm.owner-bootstrap-payload.v1",
        "profile_id": PROFILE_ID,
        "new_package": {"name": "yoko-privileged-runtime", "version": "2.0.0-7", "architecture": "all"},
        "previous_package": {"name": "yoko-privileged-runtime", "version": "2.0.0-6", "sha256": OLD["rollback_deb_sha256"]},
        "files": files,
    }
    write_json(PAYLOAD / "payload-manifest.json", payload_manifest)
    os.chmod(PAYLOAD, 0o700)
    os.chmod(REVIEW, 0o500)


if __name__ == "__main__":
    main()
