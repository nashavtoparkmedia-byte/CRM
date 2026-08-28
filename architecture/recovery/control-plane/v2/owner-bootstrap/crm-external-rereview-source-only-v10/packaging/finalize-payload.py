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
NEW_DEB = ROOT / "dist/yoko-privileged-runtime_2.0.0-12_all.deb"
ROLLBACK_DEB_NAME = "yoko-privileged-runtime_2.0.0-10_all.deb"
ROLLBACK_DEB = ROOT / "inputs" / ROLLBACK_DEB_NAME
ROLLBACK_PROVENANCE = ROOT / "inputs/immediate-runtime-rollback-seal.json"
PAYLOAD = ROOT / "bundle/payload"
REVIEW = PAYLOAD / "review"
OLD = {
    "package_version": "2.0.0-10",
    "profile_id": "crm-ae2082d852e3-gravity-source-v1",
    "source_commit": "ae2082d852e3f9c1b9dc774993955f65f5bd097d",
    "source_tree": "0053965a53e434f5d0c56e80abfec2ab2c9b15c0",
    "runtime_sha256": "44a49a00e98e1ca7315bab70e20e436432f38a3b2f4934259fa419c35138f5ba",
    "core_sha256": "0f97bafbfe5b430fa7994119b1fc76fead4bdbee26766c730d9e399551ebdffa",
    "observer_sha256": "b5ea36c50e12b0fe6c171896258ddfc00a9d2666778735cae6a9b2a8df6d4084",
    "profile_runtime_sha256": "ae69315dd38cd8d39ae9ea7947529aed7685d961de4524822a21fb6bb9ac114e",
    "policy_sha256": "8727373b0c6ec79c9abf82f1aaaa58abc2bae67e96aa96a602ac419f308db0e0",
    "install_manifest_sha256": "9ee1e7970b25d1944c58b5c6dff74e3ef8368bb389a29857e64750753aa8042a",
    "profile_manifest_sha256": "67615b6b20209c8bdcc96a4fbe4a02c6f78b58f5c96ac147e1311c7c6155c572",
    "profile_sha256": "f958936b7ac352ac9bee96fe602b8158caa7cdbcad92b0a9277605233aab2076",
    "migration_sha256": "433b0d503f054ed6a8161a059e2650d5e401829dabe8c9d992a1d1763eef0016",
    "source_archive_sha256": "f40e331dbb84609e6550ea060a1dd03041809c6418da5f4b9df39e6c630d9826",
    "sudoers_sha256": "3022dcfc323706da81e760255dd1ab43f9b8662ee699aa8b58fbe6e714cc69d7",
    "registry_sha256": "8ea5c3b7113e1dd2ad5a74b82a1fb0bf56643fd59774dccf37e8aa9eb67bd057",
    "rollback_deb_sha256": "9c23ae1ad93da8db9eee1111f6b177e6d32be48e6505a96b6d66dc2633febe6a",
    "rollback_deb_payload_path": ROLLBACK_DEB_NAME,
    "rollback_deb_store_path": "/var/lib/yoko-privileged-runtime/activation-bootstraps/9c23ae1ad93da8db9eee1111f6b177e6d32be48e6505a96b6d66dc2633febe6a/yoko-privileged-runtime_2.0.0-10_all.deb",
    "rollback_provenance_sha256": "3c9aaa7f9faaf445db691b7db034d3a2c4ac316b80c773a6679bd8020303e0be",
    "audit_state": "VALID",
    "audit_records": 36,
    "audit_last_digest": "7f7e4d739c9396c0d9757f0f2a60d57a50457048ce49cfd152ca46365306e344",
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
    for path in (NEW_DEB, ROLLBACK_DEB, ROLLBACK_PROVENANCE, PAYLOAD / "install.sh", REVIEW / "human-manifest.md", REVIEW / "installation-procedure.md", REVIEW / "rollback-analysis.md"):
        value = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
            raise SystemExit(f"unsafe input: {path}")
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
    if metadata != ["Package: yoko-privileged-runtime", "Version: 2.0.0-12", "Architecture: all"]:
        raise SystemExit("successor package metadata mismatch")
    rollback_metadata = subprocess.run(
        ["/usr/bin/dpkg-deb", "-f", str(ROLLBACK_DEB), "Package", "Version", "Architecture"],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, timeout=30,
    ).stdout.splitlines()
    if rollback_metadata != ["Package: yoko-privileged-runtime", "Version: 2.0.0-10", "Architecture: all"] or sha(ROLLBACK_DEB) != OLD["rollback_deb_sha256"]:
        raise SystemExit("direct rollback package identity mismatch")
    if sha(ROLLBACK_PROVENANCE) != OLD["rollback_provenance_sha256"]:
        raise SystemExit("direct rollback provenance identity mismatch")
    provenance = json.loads(ROLLBACK_PROVENANCE.read_text(encoding="ascii"))
    if (
        provenance.get("schema") != "yoko.crm.source-only-release-seal.v2"
        or provenance.get("status") != "SEALED"
        or provenance.get("commit") != OLD["source_commit"]
        or provenance.get("tree") != OLD["source_tree"]
        or provenance.get("profile_id") != OLD["profile_id"]
        or provenance.get("package_version") != OLD["package_version"]
        or provenance.get("runtime_abi") != "2.0.0"
        or provenance.get("built_artifacts", {}).get("deb", {}).get("sha256") != OLD["rollback_deb_sha256"]
    ):
        raise SystemExit("direct rollback source/package provenance mismatch")

    observed = package_files()
    profile_root = f"/usr/local/share/yoko-privileged-runtime/profiles/{PROFILE_ID}"
    specifications = {
        "/etc/sudoers.d/92-yoko-privileged-runtime": ("packaging/92-yoko-privileged-runtime", "finite allowlist plus one zero-argument read-only predecessor observation", "NARROW_READ_ONLY_PREDECESSOR_OBSERVE"),
        "/usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py": ("src/yoko-privileged-runtime-core.py", "Runtime V2 core with one zero-argument parser entry and expanded installed-file identity", "NARROW_READ_ONLY_PREDECESSOR_OBSERVE"),
        "/usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py": ("src/predecessor-observability-v1.py", "finite secret-safe read-only predecessor recreation observation", "NEW_INTEGRITY_PINNED_READ_ONLY_MODULE"),
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
        "src/predecessor-observability-v1.py",
        "src/crm-activation-profile.py",
        "src/policy.v2.base.json",
        "src/profile.v1.json",
        "inputs/source.tar.gz",
        "inputs/gravity-image.docker.tar",
        "inputs/sealed-inputs.v1.json",
        "inputs/migration.sql",
        "packaging/92-yoko-privileged-runtime",
        "packaging/control",
        "packaging/postinst",
        "packaging/build-package.sh",
        f"inputs/{ROLLBACK_DEB_NAME}",
        "inputs/immediate-runtime-rollback-seal.json",
    ):
        inputs[relative] = sha(ROOT / relative)

    review_manifest = {
        "schema": "yoko.crm.owner-bootstrap-review-manifest.v3",
        "profile_id": PROFILE_ID,
        "new_package": {
            "path": "yoko-privileged-runtime_2.0.0-12_all.deb",
            "sha256": sha(NEW_DEB),
            "bytes": NEW_DEB.stat().st_size,
            "name": "yoko-privileged-runtime",
            "version": "2.0.0-12",
            "runtime_abi": "2.0.0",
            "architecture": "all",
        },
        "previous_state": OLD,
        "build_inputs": inputs,
        "installed_artifacts": installed,
        "enabled_zero_argument_profiles": ["database-status", "release-preflight", "release-activate", "rollback"],
        "enabled_zero_argument_read_only_profiles": ["predecessor-observe"],
        "disabled_profiles": ["config-activate", "database-migrate"],
        "sudoers_widening": "ONE_ZERO_ARGUMENT_READ_ONLY_PREDECESSOR_OBSERVE",
        "bootstrap_production_mutation": False,
        "bootstrap_database_mutation": False,
        "success_marker": "YOKO_ACTIVATION_BOOTSTRAP_OK",
        "failure_marker": "YOKO_ACTIVATION_BOOTSTRAP_FAILED",
    }
    copy_exact(NEW_DEB, PAYLOAD / NEW_DEB.name, 0o400)
    copy_exact(ROLLBACK_DEB, PAYLOAD / ROLLBACK_DEB.name, 0o400)
    write_json(REVIEW / "package-manifest.json", review_manifest)

    files: dict[str, dict[str, str]] = {}
    expected_modes = {
        "install.sh": 0o500,
        NEW_DEB.name: 0o400,
        ROLLBACK_DEB.name: 0o400,
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
        "new_package": {"name": "yoko-privileged-runtime", "version": "2.0.0-12", "architecture": "all"},
        "previous_package": {
            "name": "yoko-privileged-runtime",
            "version": "2.0.0-10",
            "profile_id": OLD["profile_id"],
            "source_commit": OLD["source_commit"],
            "sha256": OLD["rollback_deb_sha256"],
            "payload_path": OLD["rollback_deb_payload_path"],
            "store_path": OLD["rollback_deb_store_path"],
        },
        "files": files,
    }
    write_json(PAYLOAD / "payload-manifest.json", payload_manifest)
    os.chmod(PAYLOAD, 0o700)
    os.chmod(REVIEW, 0o500)


if __name__ == "__main__":
    main()
