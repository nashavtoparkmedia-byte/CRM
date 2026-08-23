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
PROFILE_ID = json.loads((ROOT / "src/profile.v1.json").read_text(encoding="ascii"))["profile_id"]
NEW_DEB = ROOT / "dist/yoko-privileged-runtime_2.0.0-10_all.deb"
OLD_DEB = ROOT / "inputs/yoko-privileged-runtime_2.0.0-9_all.deb"
PAYLOAD = ROOT / "bundle/payload"
REVIEW = PAYLOAD / "review"
OLD = {
    "package_version": "2.0.0-9",
    "runtime_sha256": "40f7a2fc8d8c7f308aab932e70c1f98f461bb6b1c7f4b52ba715f59f54911fd3",
    "core_sha256": "0cdeeb4ba43abe50f80fed1580ad7b0729bf83358932ece2974b3faedafed57a",
    "profile_runtime_sha256": "b87c7b2e77e6ba900bb0d092b343ce132c04e9ea58dfdb8baf4e8f834c85f7ac",
    "policy_sha256": "8727373b0c6ec79c9abf82f1aaaa58abc2bae67e96aa96a602ac419f308db0e0",
    "install_manifest_sha256": "eef2e269a00c2f6f51f8fe3844b1cb65c3c32b3ec478140059747d5d7799dd3b",
    "profile_manifest_sha256": "6bb075ed5592c7d8aeb2ec6ce5c962eb50be5d1b82ae062e0314a17811e2859b",
    "profile_sha256": "fac7a25ab76c938696b14e4d283bab107fe67654b1f74608ab96f86c8bed0167",
    "migration_sha256": "433b0d503f054ed6a8161a059e2650d5e401829dabe8c9d992a1d1763eef0016",
    "source_archive_sha256": "be616b7d528bc111717d237bcd745a8b106302897e702be4b8af1b8643cba26d",
    "sudoers_sha256": "6e6b7cb2a088cc92fa7aee747adca46c64b4b96d1224be21117be5adef488c06",
    "registry_sha256": "8ea5c3b7113e1dd2ad5a74b82a1fb0bf56643fd59774dccf37e8aa9eb67bd057",
    "rollback_deb_sha256": "0c259741b4b58992acb830806e42db79ec87730f1b568a21e2879483d739be83",
    "audit_state": "VALID",
    "audit_records": 29,
    "audit_last_digest": "dc6fcbaa5c9ebf3f9717cb91fec69b873e4eeac52357bf44e20525252e46e3c0",
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
    subprocess.run(
        ["/usr/bin/python3", "-I", str(ROOT / "packaging/verify-sealed-inputs.py"), "--phase", "payload"],
        check=True, stdout=subprocess.DEVNULL, timeout=300,
    )
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
    if metadata != ["Package: yoko-privileged-runtime", "Version: 2.0.0-10", "Architecture: all"]:
        raise SystemExit("successor package metadata mismatch")

    observed = package_files()
    profile_root = f"/usr/local/share/yoko-privileged-runtime/profiles/{PROFILE_ID}"
    specifications = {
        "/etc/sudoers.d/92-yoko-privileged-runtime": ("packaging/92-yoko-privileged-runtime", "unchanged finite sudo command allowlist", f"EXACT_SHA256:{OLD['sudoers_sha256']}"),
        "/usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py": ("src/yoko-privileged-runtime-core.py", "immutable Runtime V2 core", f"EXACT_SHA256:{OLD['core_sha256']}"),
        f"/usr/local/libexec/yoko-privileged-runtime/{PROFILE_ID}.py": ("src/crm-activation-profile.py", "finite source-only release profile implementation", "NEW_CONTENT_SPECIFIC_PROFILE"),
        "/usr/local/sbin/yoko-privileged-runtime": ("generated from src/yoko-privileged-runtime with the generated overlay-manifest SHA256", "integrity-bound Runtime V2 wrapper", "NEW_MANIFEST_BOUND_WRAPPER"),
        "/usr/local/share/yoko-privileged-runtime/install-manifest.v1.json": ("generated by packaging/build-package.sh", "Runtime installed-file identity manifest", "NEW_PACKAGE_MANIFEST"),
        "/usr/local/share/yoko-privileged-runtime/policy.v2.json": ("src/policy.v2.base.json", "deny-by-default resource and operation policy", f"EXACT_SHA256:{OLD['policy_sha256']}"),
        f"{profile_root}/manifest.v1.json": ("generated by packaging/build-package.sh", "profile artifact identity manifest", "NEW_CONTENT_SPECIFIC_MANIFEST"),
        f"{profile_root}/migration.sql": ("inputs/migration.sql", "single accepted expand-only outbox migration", f"EXACT_SHA256:{OLD['migration_sha256']}"),
        f"{profile_root}/profile.v1.json": ("src/profile.v1.json", "fixed source-only targets and identities", "NEW_CONTENT_SPECIFIC_PROFILE_DATA"),
        f"{profile_root}/source.tar.gz": ("inputs/source.tar.gz", "sealed accepted source archive", "NEW_ACCEPTED_SOURCE_ARCHIVE"),
        f"{profile_root}/gravity-image.docker.tar": ("inputs/gravity-image.docker.tar", "sealed hosted Gravity docker archive loaded offline", "NEW_HOSTED_IMAGE_ARTIFACT"),
        f"{profile_root}/sealed-inputs.v1.json": ("inputs/sealed-inputs.v1.json", "transitive release-seal input identity", "NEW_SEALED_INPUT_AUTHORITY"),
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
        "inputs/gravity-image.docker.tar",
        "inputs/sealed-inputs.v1.json",
        "inputs/migration.sql",
        "inputs/yoko-privileged-runtime_2.0.0-9_all.deb",
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
            "path": "yoko-privileged-runtime_2.0.0-10_all.deb",
            "sha256": sha(NEW_DEB),
            "bytes": NEW_DEB.stat().st_size,
            "name": "yoko-privileged-runtime",
            "version": "2.0.0-10",
            "runtime_abi": "2.0.0",
            "architecture": "all",
        },
        "previous_state": OLD,
        "build_inputs": inputs,
        "installed_artifacts": installed,
        "enabled_zero_argument_profiles": ["database-status", "release-preflight", "release-activate", "rollback"],
        "disabled_profiles": ["config-activate", "database-migrate"],
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
        "new_package": {"name": "yoko-privileged-runtime", "version": "2.0.0-10", "architecture": "all"},
        "previous_package": {"name": "yoko-privileged-runtime", "version": "2.0.0-9", "sha256": OLD["rollback_deb_sha256"]},
        "files": files,
    }
    write_json(PAYLOAD / "payload-manifest.json", payload_manifest)
    os.chmod(PAYLOAD, 0o700)
    os.chmod(REVIEW, 0o500)


if __name__ == "__main__":
    main()
