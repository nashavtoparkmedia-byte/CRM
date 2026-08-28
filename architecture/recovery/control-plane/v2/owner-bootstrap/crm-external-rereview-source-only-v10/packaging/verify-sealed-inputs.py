#!/usr/bin/python3 -I
"""Fail closed when any Runtime v10 build or bootstrap input changed after sealing."""
from __future__ import annotations

import argparse
import hashlib
import json
import stat
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SEALED_INPUTS_PATH = ROOT / "inputs/sealed-inputs.v1.json"
INPUT_PATHS = (
    "README.md",
    "human-manifest.md",
    "acceptance-record.template.json",
    "production-snapshot.template.json",
    "templates/yoko-privileged-runtime.in",
    "templates/crm-activation-profile.py.in",
    "templates/profile.v1.json.in",
    "templates/postinst.in",
    "templates/install.sh.in",
    "src/yoko-privileged-runtime",
    "src/yoko-privileged-runtime-core.py",
    "src/predecessor-observability-v1.py",
    "src/crm-activation-profile.py",
    "src/policy.v2.base.json",
    "src/profile.v1.json",
    "inputs/source.tar.gz",
    "inputs/gravity-image.docker.tar",
    "inputs/yoko-privileged-runtime_2.0.0-10_all.deb",
    "inputs/immediate-runtime-rollback-seal.json",
    "inputs/migration.sql",
    "packaging/92-yoko-privileged-runtime",
    "packaging/control",
    "packaging/postinst",
    "packaging/seal-release.py",
    "packaging/build-package.sh",
    "packaging/build-bootstrap-bundle.sh",
    "packaging/finalize-payload.py",
    "packaging/finalize-evidence.py",
    "packaging/verify-sealed-inputs.py",
    "packaging/verify-independent-critic.py",
    "bundle/payload/install.sh",
    "bundle/payload/review/human-manifest.md",
    "bundle/payload/review/installation-procedure.md",
    "bundle/payload/review/rollback-analysis.md",
)
PHASES = {"package", "package-output", "payload", "bootstrap-output", "evidence"}


def sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def file_identity(path: Path) -> dict[str, object]:
    value = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
        raise SystemExit(f"unsafe sealed input: {path}")
    return {
        "sha256": sha_file(path),
        "bytes": value.st_size,
        "mode": format(stat.S_IMODE(value.st_mode), "04o"),
    }


def collect_inputs() -> dict[str, dict[str, object]]:
    return {relative: file_identity(ROOT / relative) for relative in INPUT_PATHS}


def artifact_identity(path: Path) -> dict[str, object]:
    identity = file_identity(path)
    return {"path": str(path.relative_to(ROOT)), **identity}


def verify(phase: str) -> dict[str, object]:
    seal_path = ROOT / "SEALED_RELEASE.json"
    seal = json.loads(seal_path.read_text(encoding="ascii"))
    if (
        not isinstance(seal, dict)
        or seal.get("schema") != "yoko.crm.source-only-release-seal.v2"
        or seal.get("status") not in {"SEALING_BUILD_OUTPUTS", "SEALED"}
        or not isinstance(seal.get("sealed_inputs"), dict)
        or set(seal["sealed_inputs"]) != set(INPUT_PATHS)
    ):
        raise SystemExit("release seal input inventory is invalid")
    observed = collect_inputs()
    if observed != seal["sealed_inputs"]:
        raise SystemExit("post-seal Runtime build input mutation detected")
    digest = hashlib.sha256(canonical(observed)).hexdigest()
    if seal.get("sealed_inputs_sha256") != digest:
        raise SystemExit("sealed Runtime build input digest mismatch")
    expected_document = {
        "schema": "yoko.crm.runtime-v10-sealed-inputs.v1",
        "profile_id": seal.get("profile_id"),
        "commit": seal.get("commit"),
        "tree": seal.get("tree"),
        "sealed_inputs_sha256": digest,
        "files": observed,
    }
    if SEALED_INPUTS_PATH.read_bytes() != canonical(expected_document):
        raise SystemExit("installed sealed-input document drift")

    built = seal.get("built_artifacts")
    if not isinstance(built, dict) or set(built) != {"deb", "bootstrap_tar"}:
        raise SystemExit("sealed built-artifact map invalid")
    output: dict[str, object] = {}
    deb = ROOT / "dist/yoko-privileged-runtime_2.0.0-12_all.deb"
    tar = ROOT / "dist/yoko-crm-source-only-runtime-2.0.0-12.tar"
    if phase in {"package-output", "payload", "bootstrap-output", "evidence"}:
        output["deb"] = artifact_identity(deb)
        if seal["status"] == "SEALED" and output["deb"] != built["deb"]:
            raise SystemExit("Debian package identity differs from release seal")
    if phase in {"bootstrap-output", "evidence"}:
        output["bootstrap_tar"] = artifact_identity(tar)
        if seal["status"] == "SEALED" and output["bootstrap_tar"] != built["bootstrap_tar"]:
            raise SystemExit("bootstrap tar identity differs from release seal")
    if phase == "evidence" and seal["status"] != "SEALED":
        raise SystemExit("evidence cannot be finalized from a provisional seal")
    return {
        "schema": "yoko.crm.runtime-v10-sealed-input-verification.v1",
        "status": "PASS",
        "phase": phase,
        "seal_sha256": sha_file(seal_path),
        "sealed_inputs_sha256": digest,
        "commit": seal["commit"],
        "tree": seal["tree"],
        "hosted_authoritative_ci_sha256": hashlib.sha256(canonical(seal["hosted_authoritative_ci"])).hexdigest(),
        "acceptance_record_sha256": seal["acceptance_record_sha256"],
        "production_snapshot_sha256": seal["production_snapshot_sha256"],
        "artifacts": output,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", required=True, choices=sorted(PHASES))
    args = parser.parse_args()
    print(json.dumps(verify(args.phase), sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
