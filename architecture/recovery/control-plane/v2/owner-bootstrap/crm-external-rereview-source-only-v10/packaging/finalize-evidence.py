#!/usr/bin/python3 -I
"""Materialize exact-SHA Owner evidence after independent bootstrap review."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TAR = ROOT / "dist/yoko-crm-source-only-runtime-2.0.0-12.tar"
DEB = ROOT / "dist/yoko-privileged-runtime_2.0.0-12_all.deb"
SEAL = ROOT / "SEALED_RELEASE.json"
SEALED_INPUT_VERIFIER = ROOT / "packaging/verify-sealed-inputs.py"
INTERNAL_REVIEW_VERIFIER = ROOT / "packaging/verify-independent-critic.py"
INTERNAL_REVIEW_VERIFICATION_TIMEOUT_SECONDS = 30 * 60
OWNER_MINIMUM_FREE_BYTES = 10 * 1024 * 1024 * 1024


def sha(path: Path) -> str:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    except OSError as exc:
        raise SystemExit(f"unsafe evidence input: {path}") from exc
    digest = hashlib.sha256()
    try:
        value = os.fstat(descriptor)
        if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
            raise SystemExit(f"unsafe evidence input: {path}")
        total = 0
        while chunk := os.read(descriptor, 1024 * 1024):
            digest.update(chunk)
            total += len(chunk)
        if total != value.st_size:
            raise SystemExit(f"evidence input changed while hashing: {path}")
    finally:
        os.close(descriptor)
    return digest.hexdigest()


def write(path: Path, value: str, mode: int = 0o600) -> None:
    temporary = path.with_name(path.name + ".new")
    temporary.unlink(missing_ok=True)
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        mode,
    )
    installed = False
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value.encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
        installed = True
    finally:
        if not installed:
            temporary.unlink(missing_ok=True)


def verify_sealed_release() -> dict[str, object]:
    completed = subprocess.run(
        ["/usr/bin/python3", "-I", str(SEALED_INPUT_VERIFIER), "--phase", "evidence"],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, timeout=300,
    )
    try:
        value = json.loads(completed.stdout)
    except (UnicodeError, ValueError) as exc:
        raise SystemExit("sealed-input verifier did not emit exact JSON") from exc
    if (
        completed.stderr
        or type(value) is not dict
        or set(value) != {
            "schema", "status", "phase", "seal_sha256", "sealed_inputs_sha256",
            "commit", "tree", "hosted_authoritative_ci_sha256",
            "acceptance_record_sha256", "production_snapshot_sha256", "artifacts",
        }
        or value.get("schema") != "yoko.crm.runtime-v10-sealed-input-verification.v1"
        or value.get("status") != "PASS"
        or value.get("phase") != "evidence"
    ):
        raise SystemExit("sealed-input verification did not authorize final evidence")
    return value


def owner_command(tar_sha: str) -> str:
    return (
        "/usr/bin/sudo /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /bin/bash -p -c '"
        "set -Eeuo pipefail; umask 077; "
        f"readonly src=\"{TAR}\"; readonly expected=\"{tar_sha}\"; "
        "readonly root_tar=\"/root/yoko-crm-bootstrap.$expected.tar\"; "
        "readonly stage=\"/root/yoko-crm-bootstrap-stage.$expected\"; "
        "cleanup() { "
        "test \"$root_tar\" = \"/root/yoko-crm-bootstrap.$expected.tar\"; "
        "test \"$stage\" = \"/root/yoko-crm-bootstrap-stage.$expected\"; "
        "if [ -e \"$root_tar\" ] || [ -L \"$root_tar\" ]; then "
        "test -f \"$root_tar\"; test ! -L \"$root_tar\"; "
        "test \"$(/usr/bin/stat -c %u:%g:%a:%h \"$root_tar\")\" = \"0:0:400:1\"; "
        "test \"$(/usr/bin/sha256sum \"$root_tar\" | /usr/bin/cut -d \" \" -f 1)\" = \"$expected\"; "
        "/usr/bin/unlink \"$root_tar\"; fi; "
        "if [ -e \"$stage\" ] || [ -L \"$stage\" ]; then "
        "test -d \"$stage\"; test ! -L \"$stage\"; "
        "test \"$(/usr/bin/stat -c %u:%g:%a \"$stage\")\" = \"0:0:700\"; "
        "! /usr/bin/mountpoint -q \"$stage\"; "
        "test -z \"$(/usr/bin/find \"$stage\" -xdev -type l -print -quit)\"; "
        "/usr/bin/find \"$stage\" -xdev -depth -delete; fi; "
        "}; "
        "on_exit() { rc=$?; trap - EXIT; cleanup || rc=1; "
        "if [ \"$rc\" -ne 0 ]; then printf \"%s\\n\" YOKO_ACTIVATION_BOOTSTRAP_FAILED; fi; exit \"$rc\"; }; "
        "trap on_exit EXIT; cleanup; "
        "available_blocks=$(/usr/bin/stat -f -c %a /); "
        "available_block_size=$(/usr/bin/stat -f -c %S /); "
        "available_bytes=$((available_blocks * available_block_size)); "
        f"test \"$available_bytes\" -ge {OWNER_MINIMUM_FREE_BYTES}; "
        "/usr/bin/install -d -o root -g root -m 0700 \"$stage\"; "
        "/usr/bin/install -o root -g root -m 0400 \"$src\" \"$root_tar\"; "
        "test \"$(/usr/bin/sha256sum \"$root_tar\" | /usr/bin/cut -d \" \" -f 1)\" = \"$expected\"; "
        "/usr/bin/tar --extract --file \"$root_tar\" --directory \"$stage\" --no-same-owner --no-same-permissions; "
        "/usr/bin/chown -R root:root \"$stage\"; /usr/bin/chmod 0700 \"$stage/payload\"; "
        "/usr/bin/chmod 0500 \"$stage/payload/install.sh\" \"$stage/payload/review\"; "
        "/usr/bin/chmod 0400 \"$stage/payload/payload-manifest.json\" \"$stage/payload/yoko-privileged-runtime_2.0.0-12_all.deb\" \"$stage/payload/yoko-privileged-runtime_2.0.0-10_all.deb\" \"$stage/payload/review/human-manifest.md\" \"$stage/payload/review/package-manifest.json\" \"$stage/payload/review/installation-procedure.md\" \"$stage/payload/review/rollback-analysis.md\"; "
        "cd \"$stage/payload\"; ./install.sh'"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bootstrap-review", "--critic", dest="bootstrap_review", choices=("PENDING", "PASS"), default="PENDING")
    parser.add_argument("--review-artifact", type=Path)
    parser.add_argument("--source-repo", type=Path)
    args = parser.parse_args()
    if args.bootstrap_review == "PASS" and (args.review_artifact is None or args.source_repo is None):
        raise SystemExit("bootstrap review PASS requires a separate review artifact and exact source checkout")
    if args.bootstrap_review == "PENDING" and (args.review_artifact is not None or args.source_repo is not None):
        raise SystemExit("review inputs are valid only with bootstrap review PASS")
    sealed_input_verification = verify_sealed_release()
    seal = json.loads(SEAL.read_text(encoding="ascii"))
    review = json.loads((ROOT / "bundle/payload/review/package-manifest.json").read_text(encoding="ascii"))
    tar_sha, deb_sha = sha(TAR), sha(DEB)
    if review["new_package"]["sha256"] != deb_sha:
        raise SystemExit("package review identity mismatch")
    review_artifact_sha256 = None
    review_verification = None
    if args.bootstrap_review == "PASS":
        assert args.review_artifact is not None and args.source_repo is not None
        completed = subprocess.run(
            [
                "/usr/bin/python3", "-I", str(INTERNAL_REVIEW_VERIFIER), "--verify-bootstrap-review",
                "--source-repo", str(args.source_repo),
                "--seal", str(SEAL),
                "--tar", str(TAR),
                "--deb", str(DEB),
                "--review-artifact", str(args.review_artifact),
            ],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=INTERNAL_REVIEW_VERIFICATION_TIMEOUT_SECONDS,
        )
        try:
            review_verification = json.loads(completed.stdout)
        except (UnicodeError, ValueError) as exc:
            raise SystemExit("bootstrap review verifier did not emit exact JSON") from exc
        expected_keys = {
            "schema", "status", "verdict", "reviewer_assertion", "reviewed_at",
            "independent_review_artifact_sha256", "sealed_release_sha256",
            "bootstrap_tar_sha256", "debian_package_sha256",
            "direct_rollback_package_sha256", "qualification", "scope",
            "predecessor_acceptance_reopened", "full_replay_executed",
        }
        if (
            completed.stderr
            or type(review_verification) is not dict
            or set(review_verification) != expected_keys
            or review_verification.get("schema") != "yoko.crm.transition-identity-strategy-independent-runtime-review-verification.v1"
            or review_verification.get("status") != "PASS"
            or review_verification.get("verdict") != "PASS"
            or review_verification.get("sealed_release_sha256") != sha(SEAL)
            or review_verification.get("bootstrap_tar_sha256") != tar_sha
            or review_verification.get("debian_package_sha256") != deb_sha
            or review_verification.get("direct_rollback_package_sha256") != "9c23ae1ad93da8db9eee1111f6b177e6d32be48e6505a96b6d66dc2633febe6a"
            or review_verification.get("predecessor_acceptance_reopened") is not False
            or review_verification.get("full_replay_executed") is not False
        ):
            raise SystemExit("bootstrap transition review verification did not authorize this release")
        review_artifact_sha256 = review_verification["independent_review_artifact_sha256"]
    # Recheck every sealed input and deterministic output immediately before
    # materializing the Owner boundary candidate or authorization.
    final_sealed_input_verification = verify_sealed_release()
    if final_sealed_input_verification != sealed_input_verification:
        raise SystemExit("sealed release changed during final evidence verification")
    command = owner_command(tar_sha)
    subprocess.run(["/bin/bash", "-n", "-c", command], check=True, timeout=30)
    write(
        ROOT / "OWNER_COMMAND.txt",
        (
            "AUTHORIZED AFTER INDEPENDENT BOOTSTRAP RUNTIME REVIEW; FINAL OWNER ACCEPTANCE REQUIRED\n"
            if args.bootstrap_review == "PASS"
            else "NOT AUTHORIZED: INDEPENDENT BOOTSTRAP RUNTIME REVIEW PENDING\nCANDIDATE ONLY; DO NOT EXECUTE\n"
        ) + command + "\n",
    )
    manifest = {
        "schema": "yoko.crm.source-only-owner-bootstrap.v1",
        "status": "ACCEPTED_WAITING_FOR_OWNER" if args.bootstrap_review == "PASS" else "SEALED_BOOTSTRAP_REVIEW_PENDING_NOT_AUTHORIZED",
        "seal": seal,
        "bootstrap_tar": {"path": str(TAR), "sha256": tar_sha, "bytes": TAR.stat().st_size},
        "package": {"path": str(DEB), "sha256": deb_sha, "version": "2.0.0-12", "runtime_abi": "2.0.0"},
        "predecessor_package": {
            "version": "2.0.0-10",
            "profile_id": "crm-ae2082d852e3-gravity-source-v1",
            "source_commit": "ae2082d852e3f9c1b9dc774993955f65f5bd097d",
            "sha256": "9c23ae1ad93da8db9eee1111f6b177e6d32be48e6505a96b6d66dc2633febe6a",
            "payload_path": "yoko-privileged-runtime_2.0.0-10_all.deb",
            "store_path": "/var/lib/yoko-privileged-runtime/activation-bootstraps/9c23ae1ad93da8db9eee1111f6b177e6d32be48e6505a96b6d66dc2633febe6a/yoko-privileged-runtime_2.0.0-10_all.deb",
        },
        "enabled_zero_argument_profiles": ["database-status", "release-preflight", "release-activate", "rollback"],
        "enabled_zero_argument_read_only_profiles": ["predecessor-observe"],
        "disabled_profiles": ["config-activate", "database-migrate"],
        "policy_byte_identical": True,
        "core_sudoers_delta": "ONE_ZERO_ARGUMENT_READ_ONLY_PREDECESSOR_OBSERVE",
        "bootstrap_production_mutation": False,
        "bootstrap_profile_invocation": False,
        "owner_minimum_free_bytes": OWNER_MINIMUM_FREE_BYTES,
        "owner_staging_cleanup": "DETERMINISTIC_EXACT_SHA_PATH_ON_ENTRY_AND_EXIT",
        "owner_command_authorized": args.bootstrap_review == "PASS",
        "owner_command": command if args.bootstrap_review == "PASS" else None,
        "bootstrap_transition_independent_review_artifact_sha256": review_artifact_sha256,
        "bootstrap_transition_independent_review_verification": review_verification,
        "self_issued_review_accepted": False,
        "external_project_rereview_satisfied": False,
        "predecessor_acceptance_reopened": False,
        "full_replay_executed": False,
        "sealed_input_verification": final_sealed_input_verification,
    }
    write(ROOT / "manifest.json", json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    write(ROOT / "dist/SHA256SUMS", f"{tar_sha}  {TAR.name}\n{deb_sha}  {DEB.name}\n")


if __name__ == "__main__":
    main()
