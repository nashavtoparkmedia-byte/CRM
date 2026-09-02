"""Fail-closed authenticated transport for the exact hosted release artifact."""
from __future__ import annotations

import hashlib
import os
import stat
from pathlib import Path
from typing import Any, BinaryIO

from coordinated_release_contract import (
    APPLICATION_COMMIT,
    PROFILE,
    REPOSITORY,
    SHA40,
    SHA64,
    canonical_bytes,
    exact_directory,
    exact_object,
    fail,
    strict_json_file,
)


SCHEMA = "yoko.crm.github-artifact-chunk-transport.v1"
BRANCH = "codex/prepare-max-coordinated-release-20260901"
CHUNK_BYTES = 500 * 1024 * 1024
CHUNK_COUNT = 10
CONNECTOR_MAX_BYTES = 512 * 1024 * 1024
MINIMUM_FREE_RESERVE_BYTES = 4 * 1024 * 1024 * 1024
MANIFEST_NAME = "coordinated-artifact-transport-manifest.json"
PART_NAMES = tuple(f"coordinated-artifact.zip.part-{index:03d}" for index in range(CHUNK_COUNT))


def release_artifact_name(builder_commit: str) -> str:
    return f"coordinated-gravity-max-6e3f094bf4b4-{builder_commit}"


def transport_artifact_prefix(builder_commit: str) -> str:
    return f"coordinated-transport-6e3f094bf4b4-{builder_commit}"


def transport_artifact_names(builder_commit: str) -> tuple[str, ...]:
    prefix = transport_artifact_prefix(builder_commit)
    return tuple(f"{prefix}-part-{index:03d}" for index in range(CHUNK_COUNT)) + (f"{prefix}-manifest",)


def _validate_builder_and_run(builder_commit: str, run_id: int) -> None:
    if not SHA40.fullmatch(builder_commit):
        fail("transport builder identity format invalid")
    if type(run_id) is not int or run_id <= 0:
        fail("transport workflow run identity invalid")


def validate_hosted_artifact_identity(
    value: Any,
    builder_commit: str,
    run_id: int,
    *,
    chunk_bytes: int = CHUNK_BYTES,
    chunk_count: int = CHUNK_COUNT,
) -> dict[str, Any]:
    _validate_builder_and_run(builder_commit, run_id)
    if (
        type(chunk_bytes) is not int
        or chunk_bytes <= 0
        or type(chunk_count) is not int
        or chunk_count <= 1
        or chunk_count > len(PART_NAMES)
    ):
        fail("transport chunk authority invalid")
    if type(value) is not dict:
        fail("hosted artifact identity malformed")
    artifact_id = value.get("id")
    artifact_bytes = value.get("size_in_bytes")
    digest = value.get("digest")
    workflow_run = value.get("workflow_run")
    if (
        type(artifact_id) is not int
        or artifact_id <= 0
        or value.get("name") != release_artifact_name(builder_commit)
        or type(artifact_bytes) is not int
        or artifact_bytes <= (chunk_count - 1) * chunk_bytes
        or artifact_bytes > chunk_count * chunk_bytes
        or type(digest) is not str
        or not digest.startswith("sha256:")
        or not SHA64.fullmatch(digest.removeprefix("sha256:"))
        or value.get("expired") is not False
        or type(workflow_run) is not dict
        or workflow_run.get("id") != run_id
        or workflow_run.get("head_branch") != BRANCH
        or workflow_run.get("head_sha") != builder_commit
        or value.get("archive_download_url")
        != f"https://api.github.com/repos/{REPOSITORY}/actions/artifacts/{artifact_id}/zip"
    ):
        fail("hosted artifact identity mismatch")
    return {
        "id": artifact_id,
        "name": value["name"],
        "digest": digest,
        "bytes": artifact_bytes,
    }


def _write_once(path: Path, raw: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o444)
    try:
        remaining = memoryview(raw)
        while remaining:
            written = os.write(descriptor, remaining)
            if written <= 0:
                fail(f"unable to emit complete transport file: {path.name}")
            remaining = remaining[written:]
        os.fsync(descriptor)
        info = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != len(raw):
        fail(f"unsafe emitted transport file: {path.name}")


def _available_bytes(path: Path) -> int:
    value = os.statvfs(path)
    return value.f_bavail * value.f_frsize


def ensure_transport_capacity(parent: Path, source_bytes: int) -> int:
    if not parent.is_dir() or parent.is_symlink():
        fail("transport parent is not a safe directory")
    available = _available_bytes(parent)
    required = source_bytes + MINIMUM_FREE_RESERVE_BYTES
    if available < required:
        fail(
            "insufficient free space for hosted artifact transport: "
            f"available={available} required={required}"
        )
    return available


def _manifest(
    source: dict[str, Any],
    builder_commit: str,
    run_id: int,
    chunk_bytes: int,
    chunks: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "repository": REPOSITORY,
        "application_commit": APPLICATION_COMMIT,
        "coordinated_profile": PROFILE,
        "builder_commit": builder_commit,
        "workflow_run": {
            "id": run_id,
            "head_branch": BRANCH,
            "head_sha": builder_commit,
        },
        "source_artifact": source,
        "chunking": {
            "chunk_bytes": chunk_bytes,
            "chunk_count": len(chunks),
            "chunks": chunks,
        },
    }


def emit_transport(
    stream: BinaryIO,
    identity: Any,
    output_directory: Path,
    builder_commit: str,
    run_id: int,
    *,
    chunk_bytes: int = CHUNK_BYTES,
    chunk_count: int = CHUNK_COUNT,
) -> dict[str, Any]:
    source = validate_hosted_artifact_identity(
        identity, builder_commit, run_id,
        chunk_bytes=chunk_bytes, chunk_count=chunk_count,
    )
    ensure_transport_capacity(output_directory.parent, source["bytes"])
    try:
        output_directory.mkdir(mode=0o700)
    except OSError as exc:
        raise RuntimeError("unable to create exact transport directory") from exc

    combined = hashlib.sha256()
    chunks: list[dict[str, Any]] = []
    remaining_total = source["bytes"]
    for index, name in enumerate(PART_NAMES[:chunk_count]):
        expected = min(chunk_bytes, remaining_total)
        if expected <= 0:
            fail("transport source does not require the exact chunk inventory")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(output_directory / name, flags, 0o444)
        digest = hashlib.sha256()
        written_total = 0
        try:
            while written_total < expected:
                raw = stream.read(min(8 * 1024 * 1024, expected - written_total))
                if not raw:
                    fail("hosted artifact transport stream ended early")
                if type(raw) is not bytes or len(raw) > expected - written_total:
                    fail("hosted artifact transport stream is malformed")
                view = memoryview(raw)
                while view:
                    written = os.write(descriptor, view)
                    if written <= 0:
                        fail("unable to emit complete transport chunk")
                    view = view[written:]
                written_total += len(raw)
                remaining_total -= len(raw)
                digest.update(raw)
                combined.update(raw)
            os.fsync(descriptor)
            info = os.fstat(descriptor)
        finally:
            os.close(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != expected:
            fail("unsafe emitted transport chunk")
        chunks.append({
            "index": index,
            "name": name,
            "bytes": expected,
            "sha256": digest.hexdigest(),
        })
    if remaining_total != 0 or stream.read(1) != b"":
        fail("hosted artifact transport stream size mismatch")
    if len(chunks) != chunk_count or combined.hexdigest() != source["digest"].removeprefix("sha256:"):
        fail("hosted artifact transport stream digest mismatch")
    manifest = _manifest(source, builder_commit, run_id, chunk_bytes, chunks)
    _write_once(output_directory / MANIFEST_NAME, canonical_bytes(manifest))
    exact_directory(output_directory, tuple(chunk["name"] for chunk in chunks) + (MANIFEST_NAME,), "transport")
    return manifest


def _hash_chunk(path: Path, maximum: int, combined: Any) -> tuple[str, int]:
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    digest = hashlib.sha256()
    total = 0
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            fail(f"unsafe transport chunk: {path.name}")
        while raw := os.read(descriptor, min(8 * 1024 * 1024, maximum - total + 1)):
            total += len(raw)
            if total > maximum:
                fail(f"transport chunk exceeds bounded size: {path.name}")
            digest.update(raw)
            combined.update(raw)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    stable = ("st_dev", "st_ino", "st_mode", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
    if total != before.st_size or any(getattr(before, key) != getattr(after, key) for key in stable):
        fail(f"transport chunk changed while verifying: {path.name}")
    return digest.hexdigest(), total


def verify_transport(
    identity: Any,
    transport_directory: Path,
    builder_commit: str,
    run_id: int,
    *,
    chunk_bytes: int = CHUNK_BYTES,
    chunk_count: int = CHUNK_COUNT,
) -> dict[str, Any]:
    source = validate_hosted_artifact_identity(
        identity, builder_commit, run_id,
        chunk_bytes=chunk_bytes, chunk_count=chunk_count,
    )
    names = PART_NAMES[:chunk_count]
    exact_directory(transport_directory, names + (MANIFEST_NAME,), "transport")
    value, raw = strict_json_file(transport_directory / MANIFEST_NAME, "transport manifest")
    if raw != canonical_bytes(value):
        fail("transport manifest is not canonical")

    combined = hashlib.sha256()
    chunks: list[dict[str, Any]] = []
    remaining_total = source["bytes"]
    for index, name in enumerate(names):
        expected = min(chunk_bytes, remaining_total)
        digest, actual = _hash_chunk(transport_directory / name, chunk_bytes, combined)
        if expected <= 0 or actual != expected:
            fail("transport chunk size mismatch")
        remaining_total -= actual
        chunks.append({"index": index, "name": name, "bytes": actual, "sha256": digest})
    expected_manifest = _manifest(source, builder_commit, run_id, chunk_bytes, chunks)
    if remaining_total != 0 or value != expected_manifest:
        fail("transport manifest binding mismatch")
    if combined.hexdigest() != source["digest"].removeprefix("sha256:"):
        fail("reconstructed hosted artifact digest mismatch")
    return expected_manifest


def validate_hosted_transport_registry(
    value: Any,
    source_identity: Any,
    builder_commit: str,
    run_id: int,
) -> list[dict[str, Any]]:
    source = validate_hosted_artifact_identity(source_identity, builder_commit, run_id)
    listing = exact_object(value, {"total_count", "artifacts"}, "hosted transport artifact registry")
    artifacts = listing["artifacts"]
    expected_names = (release_artifact_name(builder_commit),) + transport_artifact_names(builder_commit)
    if listing["total_count"] != len(expected_names) or type(artifacts) is not list or len(artifacts) != len(expected_names):
        fail("hosted transport artifact inventory mismatch")
    by_name = {artifact.get("name"): artifact for artifact in artifacts if type(artifact) is dict}
    if set(by_name) != set(expected_names) or len(by_name) != len(artifacts):
        fail("hosted transport artifact names mismatch")

    result: list[dict[str, Any]] = []
    for name in expected_names:
        artifact = by_name[name]
        workflow_run = artifact.get("workflow_run")
        digest = artifact.get("digest")
        size = artifact.get("size_in_bytes")
        if (
            type(artifact.get("id")) is not int
            or artifact["id"] <= 0
            or type(digest) is not str
            or not digest.startswith("sha256:")
            or not SHA64.fullmatch(digest.removeprefix("sha256:"))
            or type(size) is not int
            or size <= 0
            or artifact.get("expired") is not False
            or type(workflow_run) is not dict
            or workflow_run.get("id") != run_id
            or workflow_run.get("head_sha") != builder_commit
            or workflow_run.get("head_branch") != BRANCH
        ):
            fail("hosted transport artifact external identity mismatch")
        if name == source["name"]:
            if artifact["id"] != source["id"] or digest != source["digest"] or size != source["bytes"]:
                fail("hosted release artifact changed during transport upload")
        elif size > CONNECTOR_MAX_BYTES:
            fail("hosted transport artifact exceeds authenticated connector limit")
        result.append({"name": name, "id": artifact["id"], "digest": digest, "bytes": size})
    return result
