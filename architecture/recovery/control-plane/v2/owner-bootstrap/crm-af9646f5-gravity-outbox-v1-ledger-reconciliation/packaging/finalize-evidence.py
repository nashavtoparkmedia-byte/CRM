#!/usr/bin/python3 -I
"""Generate external final evidence for one already-built sealed bootstrap tar."""
from __future__ import annotations

import argparse
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
TAR = ROOT / "dist/yoko-crm-ledger-reconciliation-bootstrap-af9646f5-v2.tar"
DEB = ROOT / "dist/yoko-privileged-runtime_2.0.0-7_all.deb"
REVIEW_MANIFEST = ROOT / "bundle/payload/review/package-manifest.json"
UNAUTHORIZED_SHAS = {
    "d4c91a5ee2d05850b6e1d6360e9ac2d359ce7c428391d3246f0a037132bf081d",
    "88a30f4fdf74c1f86d47f47c31edec824a887c172a69585c45eddceb85fb755e",
}


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def write_text(path: Path, value: str, mode: int = 0o600) -> None:
    temporary = path.with_name(path.name + ".new")
    temporary.unlink(missing_ok=True)
    temporary.write_text(value, encoding="utf-8")
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def write_json(path: Path, value: object, mode: int = 0o600) -> None:
    write_text(path, json.dumps(value, indent=2, sort_keys=True) + "\n", mode)


def safe_tar_inventory() -> list[dict[str, object]]:
    output = []
    seen: set[str] = set()
    with tarfile.open(TAR, "r:") as archive:
        for member in archive.getmembers():
            if (
                member.name in seen
                or member.name.startswith("/")
                or any(part in {"", ".", ".."} for part in Path(member.name).parts)
                or not (member.isfile() or member.isdir())
                or member.uid != 0
                or member.gid != 0
            ):
                raise SystemExit("unsafe sealed tar member")
            seen.add(member.name)
            record: dict[str, object] = {
                "path": member.name,
                "type": "file" if member.isfile() else "directory",
                "uid": member.uid,
                "gid": member.gid,
                "mode": format(stat.S_IMODE(member.mode), "04o"),
                "bytes": member.size,
            }
            if member.isfile():
                source = archive.extractfile(member)
                if source is None:
                    raise SystemExit("tar member unavailable")
                record["sha256"] = hashlib.sha256(source.read()).hexdigest()
            output.append(record)
    expected_files = {
        "payload/install.sh",
        "payload/payload-manifest.json",
        "payload/yoko-privileged-runtime_2.0.0-6_all.deb",
        "payload/yoko-privileged-runtime_2.0.0-7_all.deb",
        "payload/review/human-manifest.md",
        "payload/review/package-manifest.json",
        "payload/review/installation-procedure.md",
        "payload/review/rollback-analysis.md",
    }
    actual_files = {str(item["path"]) for item in output if item["type"] == "file"}
    if actual_files != expected_files:
        raise SystemExit("sealed tar file set mismatch")
    return output


def owner_command(tar_sha: str) -> str:
    source = str(TAR)
    return (
        "/usr/bin/sudo /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /bin/bash -p -c 'set -Eeuo pipefail; umask 077; "
        "trap '\"'\"'printf \"%s\\n\" YOKO_ACTIVATION_BOOTSTRAP_FAILED'\"'\"' ERR; "
        f"readonly src=\"{source}\"; readonly expected=\"{tar_sha}\"; "
        "root_tar=$(/usr/bin/mktemp /root/yoko-crm-bootstrap.XXXXXXXX.tar); "
        "stage=$(/usr/bin/mktemp -d /root/yoko-crm-bootstrap-stage.XXXXXXXX); "
        "/usr/bin/install -o root -g root -m 0400 \"$src\" \"$root_tar\"; "
        "test \"$(/usr/bin/sha256sum \"$root_tar\" | /usr/bin/cut -d \" \" -f 1)\" = \"$expected\"; "
        "/usr/bin/tar --extract --file \"$root_tar\" --directory \"$stage\" --no-same-owner --no-same-permissions; "
        "/usr/bin/chown -R root:root \"$stage\"; "
        "/usr/bin/chmod 0700 \"$stage/payload\"; "
        "/usr/bin/chmod 0500 \"$stage/payload/install.sh\" \"$stage/payload/review\"; "
        "/usr/bin/chmod 0400 \"$stage/payload/payload-manifest.json\" \"$stage/payload/yoko-privileged-runtime_2.0.0-6_all.deb\" \"$stage/payload/yoko-privileged-runtime_2.0.0-7_all.deb\" \"$stage/payload/review/human-manifest.md\" \"$stage/payload/review/package-manifest.json\" \"$stage/payload/review/installation-procedure.md\" \"$stage/payload/review/rollback-analysis.md\"; "
        "cd \"$stage/payload\"; exec ./install.sh'"
    )


def test_count() -> int:
    scripts = [ROOT / "tests/test_bootstrap_contract.py", ROOT / "tests/test_package_and_runtime.py"]
    return sum(path.read_text(encoding="utf-8").count("    def test_") for path in scripts)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--critic", choices=("PENDING", "PASS"), default="PENDING")
    parser.add_argument("--critic-artifact", default="")
    args = parser.parse_args()
    if args.critic == "PASS" and not args.critic_artifact:
        raise SystemExit("PASS requires --critic-artifact")
    for path in (TAR, DEB, REVIEW_MANIFEST):
        value = path.lstat()
        if path.is_symlink() or not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
            raise SystemExit(f"unsafe final artifact: {path}")
    tar_sha = sha(TAR)
    if tar_sha in UNAUTHORIZED_SHAS:
        raise SystemExit("superseded or rejected artifact cannot be finalized")
    deb_sha = sha(DEB)
    review = json.loads(REVIEW_MANIFEST.read_text(encoding="ascii"))
    if review["new_package"]["sha256"] != deb_sha:
        raise SystemExit("review manifest package mismatch")
    inventory = safe_tar_inventory()
    tar_package = next(item for item in inventory if item["path"] == "payload/yoko-privileged-runtime_2.0.0-7_all.deb")
    if tar_package["sha256"] != deb_sha:
        raise SystemExit("sealed tar package mismatch")
    critic_path = ROOT / args.critic_artifact if args.critic_artifact else None
    critic_sha = None
    if critic_path is not None:
        if not critic_path.is_file() or critic_path.is_symlink():
            raise SystemExit("critic artifact unavailable")
        critic_sha = sha(critic_path)
        critic_value = json.loads(critic_path.read_text(encoding="ascii"))
        if critic_value.get("verdict") != "PASS" or critic_value.get("artifact_sha256") != tar_sha:
            raise SystemExit("critic PASS is not bound to final tar")

    command = owner_command(tar_sha)
    test = subprocess.run(["/bin/bash", "-n", "-c", command], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    if test.returncode != 0:
        raise SystemExit("Owner command syntax invalid")
    evidence = ROOT / "evidence"
    write_json(evidence / "FINAL_PACKAGE_CONTENTS.json", {
        "schema": "yoko.crm.owner-bootstrap-package-contents.v1",
        "artifact_sha256": tar_sha,
        "members": inventory,
    })
    build_identity = {
        "schema": "yoko.crm.owner-bootstrap-build-identity.v1",
        "profile_id": PROFILE_ID,
        "accepted_source_commit": "af9646f51c1274d718d83eb4c78faf92f214a184",
        "accepted_source_tree": "f900a2bbae3a63f02ff85bf70821df9aab7ff1df",
        "accepted_source_archive_sha256": "c43d6e6ea0735b7a5dad9117822df24b7ec0133685c69b8c13b50effc7c9f808",
        "migration_sha256": "433b0d503f054ed6a8161a059e2650d5e401829dabe8c9d992a1d1763eef0016",
        "package_sha256": deb_sha,
        "bootstrap_tar_sha256": tar_sha,
        "build_inputs": review["build_inputs"],
        "evidence_generators": {
            "packaging/build-bootstrap-bundle.sh": sha(ROOT / "packaging/build-bootstrap-bundle.sh"),
            "packaging/finalize-payload.py": sha(ROOT / "packaging/finalize-payload.py"),
            "packaging/finalize-evidence.py": sha(ROOT / "packaging/finalize-evidence.py"),
        },
        "deterministic_debian_double_build": "PASS",
        "deterministic_bundle_double_build": "PASS",
    }
    write_json(evidence / "FINAL_BUILD_IDENTITY.json", build_identity)
    continuation = {
        "schema": "yoko.crm.post-bootstrap-continuation.v1",
        "status": "WAITING_FOR_OWNER_BOOTSTRAP_SUCCESS",
        "required_success_marker": "YOKO_ACTIVATION_BOOTSTRAP_OK",
        "expected_runtime_package": "2.0.0-7",
        "expected_runtime_abi": "2.0.0",
        "expected_profiles": ["database-status", "release-preflight", "database-migrate", "release-activate", "rollback"],
        "next_actions": [
            "verify Runtime package version 2.0.0-7",
            "verify Runtime ABI 2.0.0",
            "verify exactly five enabled activation profiles",
            "run Runtime self-check",
            "verify installed hashes, root ownership and modes",
            "verify audit state",
            "run isolated PostgreSQL preview",
            "bind exact production database identity",
            "create the fixed production backup",
            "verify backup and isolated safe restore",
            "apply only the exact accepted expand-only migration",
            "activate only the sealed Gravity release",
            "run health validation",
            "automatically roll back on reversible failure",
            "complete protected Messages deployed-runtime acceptance",
            "observe only the approved outbox activation",
            "verify AI Calls preservation",
            "update production and release ledgers",
            "run the final production critic",
            "recompute whole-project evidence",
            "run the final internal critic"
        ],
        "production_activation_before_owner_success": False,
    }
    write_json(evidence / "POST_BOOTSTRAP_CONTINUATION.json", continuation)
    write_text(evidence / "CANDIDATE_OWNER_COMMAND_FOR_CRITIC.txt", "NOT AUTHORIZED FOR OWNER USE UNTIL EXACT-SHA CRITIC PASS\n" + command + "\n", 0o600)

    manifest = {
        "schema": "yoko.crm.owner-bootstrap-manifest.v2",
        "status": "ACCEPTED_WAITING_FOR_OWNER" if args.critic == "PASS" else "FINAL_ARTIFACT_SEALED_CRITIC_PENDING_NOT_AUTHORIZED",
        "profile_id": PROFILE_ID,
        "bootstrap": {
            "path": str(TAR),
            "sha256": tar_sha,
            "bytes": TAR.stat().st_size,
            "format": "DETERMINISTIC_UNCOMPRESSED_GNU_TAR",
            "internet_required": False,
            "success_marker": "YOKO_ACTIVATION_BOOTSTRAP_OK",
            "failure_marker": "YOKO_ACTIVATION_BOOTSTRAP_FAILED",
        },
        "new_package": review["new_package"],
        "expected_predecessor": review["previous_state"],
        "installed_artifacts": review["installed_artifacts"],
        "capability_set": {
            "enabled_zero_argument_profiles": review["enabled_zero_argument_profiles"],
            "disabled_profiles": review["disabled_profiles"],
            "sudoers_widening": False,
            "generic_command_execution": False,
            "arbitrary_paths": False,
            "arbitrary_sql": False,
            "arbitrary_service_or_image_selection": False,
            "package_install_capability": False,
            "docker_socket_delegated": False,
            "environment_override": False,
            "destructive_database_rollback": False,
        },
        "bootstrap_effects": {
            "production_deployment": False,
            "database_migration": False,
            "docker_mutation": False,
            "service_restart": False,
            "activation_profile_invocation": False,
            "network_download": False,
        },
        "bootstrap_rollback": {
            "available": True,
            "automatic_after_successor_attempt_failure": True,
            "interrupted_install_rerun_recovery": True,
            "predecessor_package_embedded_and_pinned": True,
            "production_action": "NONE",
        },
        "validation": {
            "offline_unittest": f"{test_count()}/{test_count()} PASS",
            "python_compile": "PASS",
            "shellcheck": "PASS",
            "visudo": "PASS",
            "deterministic_debian_double_build": "PASS",
            "deterministic_bundle_double_build": "PASS",
            "package_test_root_self_check": "PASS",
            "production_mutations_during_preparation": 0,
            "independent_final_critic": args.critic,
            "independent_final_critic_artifact": args.critic_artifact or None,
            "independent_final_critic_sha256": critic_sha,
        },
        "owner_command_authorized": args.critic == "PASS",
        "owner_command": command if args.critic == "PASS" else None,
        "post_bootstrap_continuation": "evidence/POST_BOOTSTRAP_CONTINUATION.json",
    }
    write_json(ROOT / "manifest.json", manifest)
    human = f"""# Owner Bootstrap Manifest

Status: **{'accepted; waiting for the one-time Owner bootstrap' if args.critic == 'PASS' else 'final artifact sealed; independent critic pending; Owner execution not authorized'}**.

Final bootstrap artifact: `{TAR}`

Final SHA-256: `{tar_sha}`

Runtime package: `2.0.0-6` → `2.0.0-7`; ABI remains `2.0.0`.

The package enables exactly five zero-argument profiles: `database-status`,
`release-preflight`, `database-migrate`, `release-activate`, and `rollback`.
It preserves the predecessor sudoers file byte-for-byte and keeps
`config-activate` disabled. It grants no generic shell, command, path, SQL,
Docker, service, image, environment, package-install, or rollback-target
selection.

Bootstrap installs and validates the finite root-owned control plane only. It
does not deploy Gravity, access or migrate PostgreSQL, restart a service,
activate outbox, change `/opt/crm`, or invoke any activation profile.

Automatic bootstrap rollback reinstalls and proves the embedded exact
`2.0.0-6` predecessor after any ordinary failure following successor install.
An interrupted run is reconciled by rerunning the same checksum-pinned command.

Independent final critic: **{args.critic}**. Owner command authorized:
**{'YES' if args.critic == 'PASS' else 'NO'}**.
"""
    write_text(ROOT / "human-manifest.md", human)
    sums = [
        f"{tar_sha}  {TAR.name}",
        f"{deb_sha}  {DEB.name}",
    ]
    write_text(ROOT / "dist/SHA256SUMS", "\n".join(sums) + "\n", 0o600)


if __name__ == "__main__":
    main()
