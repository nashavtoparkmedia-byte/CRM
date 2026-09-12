"""Emit deterministic attestations for two already-built Docker archives."""
from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from coordinated_release_contract import (  # noqa: E402
    GRAVITY_ARCHIVE,
    GRAVITY_ATTESTATION,
    MANIFEST,
    MAX_ARCHIVE,
    MAX_ATTESTATION,
    SOURCE_PROOF,
    builder_identity,
    canonical_bytes,
    component_attestation,
    coordinated_manifest,
    docker_archive_identity,
    exact_directory,
    expected_image_reference,
    gravity_materials,
    gravity_rootfs_contract,
    max_materials,
    max_rootfs_contract,
    strict_json_file,
    validate_application_source,
    validate_max_probe,
    validate_max_runtime_config,
    validate_source_authority,
)


def write_once(path: Path, raw: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o444)
    try:
        remaining = memoryview(raw)
        while remaining:
            written = os.write(descriptor, remaining)
            if written <= 0:
                raise RuntimeError(f"unable to emit complete file: {path.name}")
            remaining = remaining[written:]
        os.fsync(descriptor)
        info = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != len(raw):
        raise RuntimeError(f"unsafe emitted file: {path.name}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--application-source", required=True, type=Path)
    parser.add_argument("--builder-source", required=True, type=Path)
    parser.add_argument("--artifact-directory", required=True, type=Path)
    parser.add_argument("--source-authority-evidence", required=True, type=Path)
    parser.add_argument("--max-runtime-probe", required=True, type=Path)
    parser.add_argument("--builder-commit", required=True)
    parser.add_argument("--builder-tree", required=True)
    args = parser.parse_args()

    exact_directory(args.artifact_directory, (GRAVITY_ARCHIVE, MAX_ARCHIVE), "pre-attestation artifact")
    validate_application_source(args.application_source)
    builder = builder_identity(args.builder_source, args.builder_commit, args.builder_tree)
    source_authority, proof_bytes = validate_source_authority(args.source_authority_evidence)
    probe_value, _ = strict_json_file(args.max_runtime_probe, "MAX runtime probe")
    probe = validate_max_probe(probe_value)
    gravity_files, gravity_directories, gravity_forbidden, gravity_base = gravity_rootfs_contract(args.application_source)
    max_files, max_directories, max_forbidden, max_base = max_rootfs_contract(args.application_source, probe)

    gravity_archive = docker_archive_identity(
        args.artifact_directory / GRAVITY_ARCHIVE,
        expected_image_reference("gravity", args.builder_commit),
        required_files=gravity_files,
        required_directories=gravity_directories,
        required_diff_id_prefix=gravity_base,
        forbidden_paths=gravity_forbidden,
    )
    maximum_archive = docker_archive_identity(
        args.artifact_directory / MAX_ARCHIVE,
        expected_image_reference("max-scraper", args.builder_commit),
        required_files=max_files,
        required_directories=max_directories,
        required_diff_id_prefix=max_base,
        forbidden_paths=max_forbidden,
    )
    validate_max_runtime_config(maximum_archive["runtime"])

    gravity = component_attestation(
        "gravity", builder, GRAVITY_ARCHIVE, gravity_archive,
        gravity_materials(args.application_source),
    )
    maximum = component_attestation(
        "max-scraper", builder, MAX_ARCHIVE, maximum_archive,
        max_materials(args.application_source, args.builder_source, probe),
    )
    gravity_bytes = canonical_bytes(gravity)
    maximum_bytes = canonical_bytes(maximum)
    manifest = coordinated_manifest(
        builder, source_authority, gravity, gravity_bytes, maximum, maximum_bytes,
    )

    write_once(args.artifact_directory / SOURCE_PROOF, proof_bytes)
    write_once(args.artifact_directory / GRAVITY_ATTESTATION, gravity_bytes)
    write_once(args.artifact_directory / MAX_ATTESTATION, maximum_bytes)
    write_once(args.artifact_directory / MANIFEST, canonical_bytes(manifest))
    sys.stdout.write(json.dumps({
        "status": "EMITTED",
        "application_commit": manifest["application"]["commit"],
        "builder_commit": manifest["builder"]["commit"],
        "members": manifest["artifact_members"],
    }, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
