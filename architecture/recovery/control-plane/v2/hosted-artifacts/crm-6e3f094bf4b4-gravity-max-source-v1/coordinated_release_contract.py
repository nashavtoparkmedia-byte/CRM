"""Fail-closed contract for the fixed Stage A Gravity + MAX hosted artifact."""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
import tarfile
from pathlib import Path
from typing import Any


REPOSITORY = "nashavtoparkmedia-byte/CRM"
APPLICATION_COMMIT = "6e3f094bf4b42c1400c705843ab107dacd6d1cf8"
APPLICATION_TREE = "8d3e507cda69a2862db946b2e34c5ea329c425ac"
APPLICATION_PARENT = "27878fe5512e1c40a5828dedf81002e217b7a7ba"
GRAVITY_SUBTREE = "abbe37034aa88c478eb8e44b6be5b047e9bcd574"
MAX_SUBTREE = "e9c3c0ce56c744de1843547276e70d8f2d970197"
PROFILE = "crm-6e3f094bf4b4-gravity-max-source-v1"
PLATFORM = "linux/amd64"
WORKFLOW_PATH = ".github/workflows/coordinated-gravity-max-6e3f094b.yml"

SOURCE_WORKFLOW_PATH = ".github/workflows/architecture-enforcement.yml"
SOURCE_WORKFLOW_SHA256 = "ebedb2a0847b63e70a1ef55d33a59a866db955754def221f5fb17ccaea136833"
SOURCE_RUNNER_PATH = "tools/architecture/run-authoritative-ci.mjs"
SOURCE_RUNNER_SHA256 = "0ebef71d9b36ca58e2281f7a06bafbe7b1d00318a0246b5cd586fe072d9f094b"
SOURCE_RUN_ID = 33461902086
SOURCE_RUN_ATTEMPT = 1
SOURCE_WORKFLOW_ID = 334421867
SOURCE_ARCHITECTURE_JOB_ID = 99713608210
SOURCE_PROOF_ARTIFACT_ID = 9786032152
SOURCE_PROOF_ARTIFACT_NAME = f"authoritative-ci-proof-{APPLICATION_COMMIT}"
SOURCE_PROOF_ARTIFACT_SHA256 = "2cf3354a705d5ccca0d89608ea571d3b61c5f0b2e21cafe7d4c98873b586dc4b"
SOURCE_PROOF_ARTIFACT_BYTES = 5630
SOURCE_CONTROL_ID_SHA256 = "7268cb0b049390bee10aebf53277c1f771b04670ed5c59ae022db0e9ff317680"
SOURCE_CONTROL_SEMANTIC_SHA256 = "24ad32ba5a97e617e34bd19a3bcb2109807bf946636737d02b12fd7607185483"

DOCKERFILE_FRONTEND = "docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e"
GRAVITY_NODE_BASE = "node:20-bookworm-slim@sha256:3d0f05455dea2c82e2f76e7e2543964c30f6b7d673fc1a83286736d44fe4c41c"
GRAVITY_NODE_CONFIG_DIGEST = "sha256:9da6b4e352d0d5c94963eba1832408f5b7b08839cd8be9b6610c05de5118c704"
GRAVITY_NODE_DIFF_IDS = (
    "sha256:0da811fd3ed46c38cea69079fa395a3d715dbdbdd5c8177107c450bf6332bbfa",
    "sha256:4337a9b79b842bfe58037ff8e3040c28e8e3366009befe7bc70694869e6ad9a1",
    "sha256:631e9f799a80c48d29ea547226d4c97b5c4e4698baadbae796fbcb67b1cbdcba",
    "sha256:f991bccee0f1f8f692280d0e1f83f48001576c08d33c53d6a1463d5062a6ff18",
    "sha256:d592f6b23cfaeb0a7d534376e0d4a3a32255df78a9feda01e3a6a015bada66d5",
)
DEBIAN_SNAPSHOT = "20260801T000000Z"
PLAYWRIGHT_SOURCE_TAG = "mcr.microsoft.com/playwright:v1.58.2-jammy"
PLAYWRIGHT_INDEX_DIGEST = "sha256:4698a73749c5848d3f5fcd42a2174d172fcad2b2283e087843b115424303a565"
PLAYWRIGHT_AMD64_MANIFEST = "sha256:02627380acd41aa17ec78d3fb554be2fffd1f3c603d659aadafbdd6fb34289b0"
PLAYWRIGHT_CONFIG_DIGEST = "sha256:303ea68e088c4f9ca529764ddeef3ba1e5364f6df6a63d54c3795307a9c513bc"
PLAYWRIGHT_DIFF_IDS = (
    "sha256:fbb9bbbaf4d2b027acd15252897d5043386eea7121e0e0433e697714bb14beac",
    "sha256:68dcfc6f9aecd5ef88ad3a7fd9d2a5b7155085a039685af5d5a332003b1d69ab",
    "sha256:a1c0186bb06d3ea4c5f46932f0fd5a9bdd6a9bf2f919ee74a255cd61755f1fdb",
    "sha256:341449a2b174ae199c16a1025400d00146ee52f173c6dd4f3f7f0b79a70cc292",
)
TINI_URL = "https://snapshot.ubuntu.com/ubuntu/20260801T000000Z/pool/universe/t/tini/tini_0.19.0-1_amd64.deb"
TINI_SHA256 = "91119fce795e668bb4db2c94d1416127688242e1856f2fcf8cf2112dde8da57d"
TINI_BYTES = 275728
TINI_BINARY_SHA256 = "274f2bed211788a4fcb52d14f93ab6e7c44528493b56af5812a1cfe8ae1d2064"
TINI_BINARY_BYTES = 27872
BUILDX_VERSION = "v0.30.1"
BUILDKIT_IMAGE = "moby/buildkit:v0.25.2@sha256:72bda77240181301a0d5ee57d39fa58e4aabd7eff26f81bbf108088caf810f05"

GRAVITY_DOCKERFILE_SHA256 = "ed00cec7e761d63209a7da67fcbea5b7c8c0fb165c0f2243c650ee35f1f97336"
GRAVITY_LOCK_SHA256 = "43f78c98d0780e0bcba4cba369a69f2027a30553bc247fecba1b0c1f1c6fe432"
MAX_ACCEPTED_DOCKERFILE_SHA256 = "f7da6c4d2edc4f2660aa056ae2c6ffdc497c625392e9035466fae22141650329"
MAX_LOCK_SHA256 = "a60a1a43b1b6e6517aef5987cc7e451e683ca3752e8847a97caa3bfec27100ad"
MAX_PACKAGE_SHA256 = "69617ad655529f4f5ab77bfc2bb5682b939e9b1a8877b98d86ed950d2198fabd"
MAX_DOCKERIGNORE_SHA256 = "1e87d093a6399ace1c45ba96bc7278fbc288be2a405baf5d634d377adcc918d1"
MAX_INDEX_SHA256 = "476fd7a1fd8fc5f83ae8dd577901bcb74d2611407e33a4343c333d2d7641bb63"

GRAVITY_ARCHIVE = "gravity-image.docker.tar"
GRAVITY_ATTESTATION = "gravity-image-attestation.json"
MAX_ARCHIVE = "max-scraper-image.docker.tar"
MAX_ATTESTATION = "max-scraper-image-attestation.json"
MANIFEST = "coordinated-release-manifest.json"
SOURCE_PROOF = "authoritative-ci-execution.json"
ARTIFACT_MEMBERS = (
    GRAVITY_ARCHIVE,
    GRAVITY_ATTESTATION,
    MAX_ARCHIVE,
    MAX_ATTESTATION,
    MANIFEST,
    SOURCE_PROOF,
)
SOURCE_EVIDENCE_MEMBERS = ("run.json", "jobs.json", "artifact.json", SOURCE_PROOF)

CONTROL_IDS = (
    "authoritative-ci-inventory",
    "whole-repository-credential-inventory",
    "fresh-credential-verification",
    "whole-repository-write-scan",
    "fresh-write-verification",
    "fresh-migration-write-site-authorizations",
    "original-dod-canonical-mapping",
    "original-dod-canonical-mapping-negatives",
    "manifest-policy",
    "manifest-negatives",
    "executable-path-ownership-negatives",
    "final-dependency-artifact",
    "module-scaffold-negatives",
    "production-migration-authority",
    "production-migration-authority-negatives",
    "production-migration-default-clean-checkout",
    "production-migration-runtime-semantics",
    "source-only-runtime-v10-contract",
    "production-migration-committed-runtime-inventory",
    "production-migration-canonical-replay",
    "production-migration-predecessor-recovery-replay",
    "architecture-policy",
    "architecture-negatives",
    "write-analyzer-negatives",
    "write-runner-negatives",
    "write-gate-negatives",
    "surface-lifecycle-negatives",
    "ambiguity-reconciliation",
    "scoped-ownership-negatives",
    "maintenance-capability-negatives",
    "credential-field-registry",
    "credential-analyzer-negatives",
    "credential-inventory-negatives",
    "credential-boundary-negatives",
    "credential-gate-negatives",
    "credential-migration-boundary",
    "contract-registry-policy",
    "contract-registry-negatives",
    "contract-policy",
    "contract-behavior",
    "outbox-policy",
    "outbox-behavior-negatives",
    "static-sql-policy",
    "typescript-baseline-negatives",
    "typescript-baseline",
    "blast-radius-negatives",
    "blast-radius",
    "boundary-control-lifecycle-negatives",
    "all-current-boundaries",
    "independent-source-critic",
    "gravity-security",
    "tg-bot-security",
)

SHA40 = re.compile(r"[0-9a-f]{40}")
SHA64 = re.compile(r"[0-9a-f]{64}")


class ContractError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise ContractError(message)


def exact_object(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if type(value) is not dict or set(value) != keys:
        fail(f"{label} fields are not exact")
    return value


def strict_json_bytes(raw: bytes, label: str) -> Any:
    def no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate key: {key}")
            result[key] = value
        return result

    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=no_duplicates)
    except (UnicodeError, ValueError) as exc:
        raise ContractError(f"invalid {label}") from exc


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def sha_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def file_identity(path: Path, maximum: int = 6 * 1024 * 1024 * 1024) -> tuple[str, int]:
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    digest = hashlib.sha256()
    total = 0
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            fail(f"unsafe regular-file input: {path.name}")
        while chunk := os.read(descriptor, 1024 * 1024):
            total += len(chunk)
            if total > maximum:
                fail(f"file exceeds bounded size: {path.name}")
            digest.update(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    stable = ("st_dev", "st_ino", "st_mode", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
    if total != before.st_size or any(getattr(before, key) != getattr(after, key) for key in stable):
        fail(f"file changed while hashing: {path.name}")
    return digest.hexdigest(), total


def read_regular_bytes(path: Path, maximum: int) -> bytes:
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    chunks: list[bytes] = []
    total = 0
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            fail(f"unsafe regular-file input: {path.name}")
        while chunk := os.read(descriptor, min(1024 * 1024, maximum - total + 1)):
            total += len(chunk)
            if total > maximum:
                fail(f"file exceeds bounded size: {path.name}")
            chunks.append(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    stable = ("st_dev", "st_ino", "st_mode", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
    if total != before.st_size or any(getattr(before, key) != getattr(after, key) for key in stable):
        fail(f"file changed while reading: {path.name}")
    return b"".join(chunks)


def strict_json_file(path: Path, label: str, maximum: int = 2 * 1024 * 1024) -> tuple[Any, bytes]:
    raw = read_regular_bytes(path, maximum)
    return strict_json_bytes(raw, label), raw


def exact_directory(path: Path, names: tuple[str, ...], label: str) -> None:
    if not path.is_dir() or path.is_symlink():
        fail(f"{label} is not a safe directory")
    actual = sorted(entry.name for entry in path.iterdir())
    if actual != sorted(names):
        fail(f"{label} member allowlist mismatch")
    for name in names:
        descriptor = path / name
        info = descriptor.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            fail(f"{label} contains a non-regular member")


def git(repository: Path, expression: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repository), "rev-parse", expression],
        check=False, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        fail(f"unable to resolve git identity: {expression}")
    return result.stdout.strip()


def assert_clean(repository: Path, label: str) -> None:
    result = subprocess.run(
        ["git", "-C", str(repository), "status", "--porcelain=v1", "--untracked-files=all"],
        check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode != 0 or result.stdout != b"":
        fail(f"{label} checkout is not clean")


def validate_application_source(repository: Path) -> None:
    if (
        git(repository, "HEAD^{commit}") != APPLICATION_COMMIT
        or git(repository, "HEAD^{tree}") != APPLICATION_TREE
        or git(repository, "HEAD:gravity-mvp") != GRAVITY_SUBTREE
        or git(repository, "HEAD:max-web-scraper") != MAX_SUBTREE
    ):
        fail("application source identity mismatch")
    assert_clean(repository, "application source")
    expected_hashes = {
        "gravity-mvp/Dockerfile": GRAVITY_DOCKERFILE_SHA256,
        "gravity-mvp/package-lock.json": GRAVITY_LOCK_SHA256,
        "max-web-scraper/Dockerfile": MAX_ACCEPTED_DOCKERFILE_SHA256,
        "max-web-scraper/package-lock.json": MAX_LOCK_SHA256,
        "max-web-scraper/package.json": MAX_PACKAGE_SHA256,
        "max-web-scraper/.dockerignore": MAX_DOCKERIGNORE_SHA256,
        "max-web-scraper/index.js": MAX_INDEX_SHA256,
        SOURCE_WORKFLOW_PATH: SOURCE_WORKFLOW_SHA256,
        SOURCE_RUNNER_PATH: SOURCE_RUNNER_SHA256,
    }
    for relative, expected in expected_hashes.items():
        actual, _ = file_identity(repository / relative, 64 * 1024 * 1024)
        if actual != expected:
            fail(f"accepted application material mismatch: {relative}")


def builder_identity(repository: Path, expected_commit: str, expected_tree: str) -> dict[str, Any]:
    if not SHA40.fullmatch(expected_commit) or not SHA40.fullmatch(expected_tree):
        fail("builder identity format invalid")
    if git(repository, "HEAD^{commit}") != expected_commit or git(repository, "HEAD^{tree}") != expected_tree:
        fail("release builder identity mismatch")
    assert_clean(repository, "release builder")
    workflow_sha256, _ = file_identity(repository / WORKFLOW_PATH)
    return {
        "commit": expected_commit,
        "tree": expected_tree,
        "workflow": {"path": WORKFLOW_PATH, "sha256": workflow_sha256},
    }


def validate_execution_proof(value: Any) -> None:
    proof = exact_object(value, {"schema", "outcome", "source", "workflow", "runner", "runtime", "controls"}, "source execution proof")
    if proof["schema"] != "yoko.crm.authoritative-ci-execution-proof.v1" or proof["outcome"] != "PASS":
        fail("source execution proof did not pass")
    if exact_object(proof["source"], {"commit", "tree"}, "source proof source") != {
        "commit": APPLICATION_COMMIT, "tree": APPLICATION_TREE,
    }:
        fail("source execution proof source mismatch")
    if exact_object(proof["workflow"], {"path", "sha256"}, "source proof workflow") != {
        "path": SOURCE_WORKFLOW_PATH, "sha256": SOURCE_WORKFLOW_SHA256,
    }:
        fail("source execution proof workflow mismatch")
    if exact_object(proof["runner"], {"path", "sha256"}, "source proof runner") != {
        "path": SOURCE_RUNNER_PATH, "sha256": SOURCE_RUNNER_SHA256,
    }:
        fail("source execution proof runner mismatch")
    if exact_object(proof["runtime"], {"node", "blast_base", "blast_base_commit"}, "source proof runtime") != {
        "node": "20.20.2", "blast_base": "HEAD^", "blast_base_commit": APPLICATION_PARENT,
    }:
        fail("source execution proof runtime mismatch")
    controls = exact_object(proof["controls"], {"count", "catalog_sha256", "semantic_catalog_sha256", "executions"}, "source proof controls")
    expected_executions = [{"id": control, "status": "PASS"} for control in CONTROL_IDS]
    if controls != {
        "count": 52,
        "catalog_sha256": SOURCE_CONTROL_ID_SHA256,
        "semantic_catalog_sha256": SOURCE_CONTROL_SEMANTIC_SHA256,
        "executions": expected_executions,
    }:
        fail("source execution proof control catalog mismatch")


def validate_source_authority(evidence: Path) -> tuple[dict[str, Any], bytes]:
    exact_directory(evidence, SOURCE_EVIDENCE_MEMBERS, "source authority evidence")
    run, _ = strict_json_file(evidence / "run.json", "GitHub source run")
    jobs, _ = strict_json_file(evidence / "jobs.json", "GitHub source jobs", 16 * 1024 * 1024)
    artifact, _ = strict_json_file(evidence / "artifact.json", "GitHub source proof artifact")
    proof, proof_bytes = strict_json_file(evidence / SOURCE_PROOF, "source execution proof")
    if (
        type(run) is not dict
        or run.get("id") != SOURCE_RUN_ID
        or run.get("workflow_id") != SOURCE_WORKFLOW_ID
        or run.get("head_sha") != APPLICATION_COMMIT
        or run.get("run_attempt") != SOURCE_RUN_ATTEMPT
        or run.get("event") != "push"
        or run.get("status") != "completed"
        or run.get("conclusion") != "success"
        or run.get("path") != SOURCE_WORKFLOW_PATH
    ):
        fail("live GitHub source run identity mismatch")
    live_jobs = jobs.get("jobs") if type(jobs) is dict else None
    if type(live_jobs) is not list:
        fail("live GitHub source jobs response malformed")
    architecture_jobs = [job for job in live_jobs if type(job) is dict and job.get("id") == SOURCE_ARCHITECTURE_JOB_ID]
    if len(architecture_jobs) != 1:
        fail("exact source architecture job missing")
    architecture_job = architecture_jobs[0]
    if (
        architecture_job.get("name") != "architecture"
        or architecture_job.get("run_id") != SOURCE_RUN_ID
        or architecture_job.get("head_sha") != APPLICATION_COMMIT
        or architecture_job.get("status") != "completed"
        or architecture_job.get("conclusion") != "success"
    ):
        fail("source architecture job did not pass exactly")
    workflow_run = artifact.get("workflow_run") if type(artifact) is dict else None
    if (
        type(artifact) is not dict
        or artifact.get("id") != SOURCE_PROOF_ARTIFACT_ID
        or artifact.get("name") != SOURCE_PROOF_ARTIFACT_NAME
        or artifact.get("size_in_bytes") != SOURCE_PROOF_ARTIFACT_BYTES
        or artifact.get("digest") != f"sha256:{SOURCE_PROOF_ARTIFACT_SHA256}"
        or artifact.get("expired") is not False
        or type(workflow_run) is not dict
        or workflow_run.get("id") != SOURCE_RUN_ID
        or workflow_run.get("head_sha") != APPLICATION_COMMIT
    ):
        fail("source proof artifact identity mismatch")
    validate_execution_proof(proof)
    return {
        "run": {"id": SOURCE_RUN_ID, "attempt": SOURCE_RUN_ATTEMPT, "workflow_id": SOURCE_WORKFLOW_ID, "conclusion": "success"},
        "workflow": {"path": SOURCE_WORKFLOW_PATH, "sha256": SOURCE_WORKFLOW_SHA256},
        "runner": {"path": SOURCE_RUNNER_PATH, "sha256": SOURCE_RUNNER_SHA256},
        "architecture_job": {"id": SOURCE_ARCHITECTURE_JOB_ID, "name": "architecture", "conclusion": "success"},
        "proof_artifact": {
            "id": SOURCE_PROOF_ARTIFACT_ID,
            "name": SOURCE_PROOF_ARTIFACT_NAME,
            "digest": f"sha256:{SOURCE_PROOF_ARTIFACT_SHA256}",
            "bytes": SOURCE_PROOF_ARTIFACT_BYTES,
        },
        "execution_proof": {"path": SOURCE_PROOF, "sha256": sha_bytes(proof_bytes), "bytes": len(proof_bytes)},
    }, proof_bytes


def safe_tar_name(name: Any, label: str) -> str:
    if type(name) is not str or not name or name.startswith("/") or "\\" in name:
        fail(f"{label} contains an unsafe member path")
    parts = [part for part in name.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        fail(f"{label} contains an unsafe member path")
    return "/".join(parts)


def tar_member_bytes(archive: tarfile.TarFile, member: tarfile.TarInfo, maximum: int, label: str) -> bytes:
    if not member.isfile() or member.size < 0 or member.size > maximum:
        fail(f"{label} inventory invalid")
    handle = archive.extractfile(member)
    if handle is None:
        fail(f"{label} unreadable")
    raw = handle.read(maximum + 1)
    if len(raw) != member.size or len(raw) > maximum:
        fail(f"{label} size mismatch")
    return raw


class DigestReader:
    def __init__(self, source: Any) -> None:
        self.source = source
        self.digest = hashlib.sha256()
        self.total = 0

    def read(self, size: int = -1) -> bytes:
        raw = self.source.read(size)
        self.digest.update(raw)
        self.total += len(raw)
        return raw


def path_matches(path: str, watched: set[str]) -> bool:
    return any(path == candidate or path.startswith(f"{candidate}/") for candidate in watched)


def remove_overlay_path(filesystem: dict[str, tuple[str, str | None]], target: str) -> None:
    for existing in [value for value in filesystem if value == target or value.startswith(f"{target}/")]:
        del filesystem[existing]


def inspect_docker_layer(
    archive: tarfile.TarFile,
    member: tarfile.TarInfo,
    expected_diff_id: str,
    watched: set[str],
    expected_hashes: dict[str, str | None],
    filesystem: dict[str, tuple[str, str | None]],
) -> None:
    handle = archive.extractfile(member)
    if handle is None:
        fail("Docker archive layer unreadable")
    reader = DigestReader(handle)
    seen: set[str] = set()
    try:
        with tarfile.open(fileobj=reader, mode="r|") as layer:
            for entry in layer:
                relative = safe_tar_name(entry.name, "Docker layer")
                if relative in seen:
                    fail("Docker layer contains duplicate members")
                seen.add(relative)
                parent, _, basename = relative.rpartition("/")
                parent_path = f"/{parent}" if parent else ""
                if basename == ".wh..wh..opq":
                    for existing in [value for value in filesystem if value.startswith(f"{parent_path}/")]:
                        del filesystem[existing]
                    continue
                if basename.startswith(".wh."):
                    target_name = basename.removeprefix(".wh.")
                    if not target_name:
                        fail("Docker layer contains malformed whiteout")
                    remove_overlay_path(filesystem, f"{parent_path}/{target_name}")
                    continue
                absolute = f"/{relative}"
                if not path_matches(absolute, watched):
                    continue
                if not entry.isdir():
                    remove_overlay_path(filesystem, absolute)
                if entry.isfile():
                    content_sha256 = None
                    if absolute in expected_hashes and expected_hashes[absolute] is not None:
                        if entry.size > 64 * 1024 * 1024:
                            fail(f"required image file exceeds bounded size: {absolute}")
                        content = layer.extractfile(entry)
                        if content is None:
                            fail(f"required image file unreadable: {absolute}")
                        raw = content.read(64 * 1024 * 1024 + 1)
                        if len(raw) != entry.size or len(raw) > 64 * 1024 * 1024:
                            fail(f"required image file size mismatch: {absolute}")
                        content_sha256 = sha_bytes(raw)
                    filesystem[absolute] = ("file", content_sha256)
                elif entry.isdir():
                    filesystem[absolute] = ("directory", None)
                elif entry.issym():
                    filesystem[absolute] = ("symlink", None)
                elif entry.islnk():
                    filesystem[absolute] = ("hardlink", None)
                else:
                    filesystem[absolute] = ("special", None)
        while reader.read(1024 * 1024):
            pass
    except tarfile.TarError as exc:
        raise ContractError("invalid Docker image layer") from exc
    if reader.digest.hexdigest() != expected_diff_id.removeprefix("sha256:"):
        fail("Docker archive layer diff ID mismatch")


def docker_archive_identity(
    path: Path,
    expected_reference: str,
    *,
    required_files: dict[str, str | None],
    required_directories: set[str],
    required_diff_id_prefix: tuple[str, ...],
    forbidden_paths: set[str] | None = None,
) -> dict[str, Any]:
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    digest = hashlib.sha256()
    archive_bytes = 0
    forbidden = forbidden_paths or set()
    watched = set(required_files) | required_directories | forbidden
    filesystem: dict[str, tuple[str, str | None]] = {}
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            fail(f"unsafe regular-file input: {path.name}")
        while chunk := os.read(descriptor, 1024 * 1024):
            archive_bytes += len(chunk)
            if archive_bytes > 6 * 1024 * 1024 * 1024:
                fail(f"file exceeds bounded size: {path.name}")
            digest.update(chunk)
        os.lseek(descriptor, 0, os.SEEK_SET)
        with os.fdopen(os.dup(descriptor), "rb") as archive_file, tarfile.open(fileobj=archive_file, mode="r:") as archive:
            members = archive.getmembers()
            normalized = [safe_tar_name(member.name, "Docker archive") for member in members]
            if len(normalized) != len(set(normalized)):
                fail("Docker archive contains duplicate members")
            if any(not member.isfile() and not member.isdir() for member in members):
                fail("Docker archive contains a non-regular member")
            member_by_name = dict(zip(normalized, members, strict=True))
            manifest_member = member_by_name.get("manifest.json")
            if manifest_member is None:
                fail("Docker archive manifest inventory invalid")
            manifest = strict_json_bytes(
                tar_member_bytes(archive, manifest_member, 1024 * 1024, "Docker archive manifest"),
                "Docker archive manifest",
            )
            if type(manifest) is not list or len(manifest) != 1:
                fail("Docker archive must contain exactly one image")
            image = exact_object(manifest[0], {"Config", "RepoTags", "Layers"}, "Docker archive image manifest")
            layers = image["Layers"]
            if image["RepoTags"] != [expected_reference] or type(layers) is not list or not layers:
                fail("Docker archive image reference or layers mismatch")
            layer_names = [safe_tar_name(value, "Docker archive layer inventory") for value in layers]
            if len(layer_names) != len(set(layer_names)):
                fail("Docker archive contains duplicate layer references")
            config_name = image["Config"]
            if type(config_name) is not str or not re.fullmatch(r"[0-9a-f]{64}\.json", config_name):
                fail("Docker archive config path invalid")
            config_member = member_by_name.get(config_name)
            if config_member is None:
                fail("Docker archive config inventory invalid")
            config_bytes = tar_member_bytes(archive, config_member, 16 * 1024 * 1024, "Docker archive config")
            if sha_bytes(config_bytes) != config_name.removesuffix(".json"):
                fail("Docker archive immutable image ID mismatch")
            config = strict_json_bytes(config_bytes, "Docker image config")
            rootfs = exact_object(config.get("rootfs") if type(config) is dict else None, {"type", "diff_ids"}, "Docker rootfs")
            diff_ids = rootfs["diff_ids"]
            if (
                rootfs["type"] != "layers"
                or type(diff_ids) is not list
                or len(diff_ids) != len(layer_names)
                or any(type(value) is not str or not re.fullmatch(r"sha256:[0-9a-f]{64}", value) for value in diff_ids)
            ):
                fail("Docker rootfs layer graph mismatch")
            if tuple(diff_ids[:len(required_diff_id_prefix)]) != required_diff_id_prefix:
                fail("Docker rootfs base layer authority mismatch")

            required_outer = {"manifest.json", config_name, *layer_names}
            optional_outer = {"repositories"}
            for layer_name in layer_names:
                if layer_name.endswith("/layer.tar"):
                    parent = layer_name.rsplit("/", 1)[0]
                    optional_outer.update({f"{parent}/VERSION", f"{parent}/json"})
            allowed_outer = required_outer | optional_outer
            actual_regular = {name for name, member in member_by_name.items() if member.isfile()}
            if not required_outer <= actual_regular or actual_regular - allowed_outer:
                fail("Docker archive inner member allowlist mismatch")
            allowed_directories = {
                "/".join(name.split("/")[:index])
                for name in allowed_outer
                for index in range(1, len(name.split("/")))
            }
            actual_directories = {name for name, member in member_by_name.items() if member.isdir()}
            if actual_directories - allowed_directories:
                fail("Docker archive directory allowlist mismatch")
            for name in actual_regular & optional_outer:
                raw = tar_member_bytes(archive, member_by_name[name], 16 * 1024 * 1024, f"Docker archive metadata {name}")
                if name.endswith("/VERSION"):
                    if raw.strip() != b"1.0":
                        fail("Docker archive layer VERSION mismatch")
                else:
                    strict_json_bytes(raw, f"Docker archive metadata {name}")

            for layer_name, diff_id in zip(layer_names, diff_ids, strict=True):
                layer_member = member_by_name.get(layer_name)
                if layer_member is None or not layer_member.isfile():
                    fail("Docker archive referenced layer missing")
                inspect_docker_layer(
                    archive, layer_member, diff_id, watched, required_files, filesystem,
                )
        after = os.fstat(descriptor)
    except (OSError, tarfile.TarError) as exc:
        raise ContractError("invalid Docker archive") from exc
    finally:
        os.close(descriptor)
    stable = ("st_dev", "st_ino", "st_mode", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
    if archive_bytes != before.st_size or any(getattr(before, key) != getattr(after, key) for key in stable):
        fail(f"file changed while verifying: {path.name}")
    for required, expected_sha256 in required_files.items():
        actual = filesystem.get(required)
        if actual is None or actual[0] != "file" or (expected_sha256 is not None and actual[1] != expected_sha256):
            fail(f"Docker image required file mismatch: {required}")
    for required in required_directories:
        actual = filesystem.get(required)
        if actual != ("directory", None) and not any(value.startswith(f"{required}/") for value in filesystem):
            fail(f"Docker image required directory missing: {required}")
    for prohibited in forbidden:
        if prohibited in filesystem or any(value.startswith(f"{prohibited}/") for value in filesystem):
            fail(f"Docker image contains forbidden runtime path: {prohibited}")
    archive_sha256 = digest.hexdigest()
    if type(config) is not dict or config.get("architecture") != "amd64" or config.get("os") != "linux":
        fail("Docker image platform mismatch")
    runtime = config.get("config")
    if type(runtime) is not dict:
        fail("Docker runtime config missing")
    labels = runtime.get("Labels")
    if type(labels) is not dict:
        fail("Docker image labels missing")
    if labels.get("org.opencontainers.image.revision") != APPLICATION_COMMIT or labels.get("yoko.activation.profile") != PROFILE:
        fail("Docker image coordinated labels mismatch")
    return {
        "archive_sha256": archive_sha256,
        "archive_bytes": archive_bytes,
        "image_id": f"sha256:{sha_bytes(config_bytes)}",
        "labels": {
            "org.opencontainers.image.revision": APPLICATION_COMMIT,
            "yoko.activation.profile": PROFILE,
        },
        "runtime": runtime,
    }


def validate_max_runtime_config(runtime: dict[str, Any]) -> None:
    if (
        runtime.get("User") != "pwuser"
        or runtime.get("WorkingDir") != "/app"
        or runtime.get("Entrypoint") != ["/usr/bin/tini", "--"]
        or runtime.get("Cmd") != ["node", "index.js"]
        or runtime.get("Volumes") not in (None, {})
    ):
        fail("MAX image process/user/workdir/volume contract mismatch")
    environment: dict[str, str] = {}
    raw_environment = runtime.get("Env")
    if type(raw_environment) is not list:
        fail("MAX image environment contract missing")
    for item in raw_environment:
        if type(item) is not str or "=" not in item:
            fail("MAX image environment entry malformed")
        name, value = item.split("=", 1)
        if name in environment:
            fail("MAX image environment contains duplicate keys")
        environment[name] = value
    if {key: environment.get(key) for key in ("NODE_ENV", "PLAYWRIGHT_BROWSERS_PATH", "TZ")} != {
        "NODE_ENV": "production", "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright", "TZ": "Europe/Moscow",
    }:
        fail("MAX image environment values mismatch")
    health = exact_object(runtime.get("Healthcheck"), {"Test", "Interval", "Timeout", "StartPeriod", "Retries"}, "MAX healthcheck")
    if health != {
        "Test": ["CMD-SHELL", "pgrep -f \"node.*index\" >/dev/null || exit 1"],
        "Interval": 60_000_000_000,
        "Timeout": 10_000_000_000,
        "StartPeriod": 60_000_000_000,
        "Retries": 3,
    }:
        fail("MAX image healthcheck mismatch")


def validate_max_probe(value: Any) -> dict[str, Any]:
    probe = exact_object(value, {
        "schema", "uid", "gid", "cwd", "index_sha256", "package_lock_sha256",
        "tini_version", "browser_executable", "browser_version", "playwright_module",
        "browser_launch", "user_data", "forbidden_paths_present", "environment",
    }, "MAX runtime probe")
    environment = exact_object(probe["environment"], {"NODE_ENV", "PLAYWRIGHT_BROWSERS_PATH", "TZ"}, "MAX probe environment")
    user_data = exact_object(
        probe["user_data"],
        {"path", "type", "uid", "gid", "mode", "writable_by_runtime_identity", "entries"},
        "MAX user_data probe",
    )
    if (
        probe["schema"] != "yoko.crm.max-release-runtime-probe.v1"
        or type(probe["uid"]) is not int or probe["uid"] <= 0
        or type(probe["gid"]) is not int or probe["gid"] <= 0
        or probe["cwd"] != "/app"
        or probe["index_sha256"] != MAX_INDEX_SHA256
        or probe["package_lock_sha256"] != MAX_LOCK_SHA256
        or type(probe["tini_version"]) is not str or "0.19.0" not in probe["tini_version"]
        or type(probe["browser_executable"]) is not str or not probe["browser_executable"].startswith("/ms-playwright/")
        or type(probe["browser_version"]) is not str or not re.search(r"Chrom(?:e|ium)", probe["browser_version"], re.IGNORECASE)
        or type(probe["playwright_module"]) is not str or not probe["playwright_module"].startswith("/app/node_modules/playwright/")
        or probe["browser_launch"] != "PASS"
        or user_data != {
            "path": "/app/user_data", "type": "directory", "uid": probe["uid"], "gid": probe["gid"],
            "mode": "0755", "writable_by_runtime_identity": True, "entries": [],
        }
        or probe["forbidden_paths_present"] != []
        or environment != {"NODE_ENV": "production", "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright", "TZ": "Europe/Moscow"}
    ):
        fail("MAX runtime semantic probe mismatch")
    return probe


def application_identity() -> dict[str, str]:
    return {
        "commit": APPLICATION_COMMIT,
        "tree": APPLICATION_TREE,
        "gravity_subtree": GRAVITY_SUBTREE,
        "max_subtree": MAX_SUBTREE,
    }


def expected_image_reference(component: str, builder_commit: str) -> str:
    if component not in {"gravity", "max-scraper"} or not SHA40.fullmatch(builder_commit):
        fail("image reference input invalid")
    repository = "yoko/crm-gravity-mvp" if component == "gravity" else "yoko/crm-max-scraper"
    return f"{repository}:{APPLICATION_COMMIT[:12]}-{builder_commit}-coordinated-v1"


def gravity_rootfs_contract(application: Path) -> tuple[dict[str, str | None], set[str], set[str], tuple[str, ...]]:
    package_sha256, _ = file_identity(application / "gravity-mvp/package.json")
    return (
        {"/app/package.json": package_sha256, "/usr/bin/tini": None},
        {"/app/.next", "/app/node_modules", "/app/prisma", "/app/public"},
        set(),
        GRAVITY_NODE_DIFF_IDS,
    )


def max_rootfs_contract(application: Path, probe: dict[str, Any]) -> tuple[dict[str, str | None], set[str], set[str], tuple[str, ...]]:
    source = application / "max-web-scraper"
    required: dict[str, str | None] = {}
    for relative in ("package.json", "package-lock.json", "index.js"):
        required[f"/app/{relative}"] = file_identity(source / relative, 64 * 1024 * 1024)[0]
    for directory in ("contacts", "lib", "media", "parser", "session", "sync", "transport"):
        root = source / directory
        for candidate in sorted(root.rglob("*")):
            if candidate.is_symlink() or not candidate.is_file():
                fail(f"MAX runtime source contains a non-regular path: {candidate.relative_to(source)}")
            relative = candidate.relative_to(source).as_posix()
            required[f"/app/{relative}"] = file_identity(candidate, 64 * 1024 * 1024)[0]
    required.update({
        "/usr/bin/tini": TINI_BINARY_SHA256,
        probe["browser_executable"]: None,
        probe["playwright_module"]: None,
    })
    forbidden = {
        "/app/.env", "/app/.env.local", "/app/test", "/app/scripts", "/app/debug.js",
        "/app/discovery", "/app/check-contacts.js", "/app/maxBrowser.js",
    }
    return required, {"/app/node_modules", "/app/user_data", "/ms-playwright"}, forbidden, PLAYWRIGHT_DIFF_IDS


def gravity_materials(application: Path) -> dict[str, Any]:
    dockerfile_sha, _ = file_identity(application / "gravity-mvp/Dockerfile")
    lock_sha, _ = file_identity(application / "gravity-mvp/package-lock.json")
    return {
        "dockerfile": {"authority": "application", "path": "gravity-mvp/Dockerfile", "sha256": dockerfile_sha},
        "dependency_lock": {"path": "gravity-mvp/package-lock.json", "sha256": lock_sha},
        "dockerfile_frontend": DOCKERFILE_FRONTEND,
        "base_image": {
            "reference": GRAVITY_NODE_BASE,
            "config_digest": GRAVITY_NODE_CONFIG_DIGEST,
            "rootfs_diff_ids": list(GRAVITY_NODE_DIFF_IDS),
        },
        "debian_snapshot": DEBIAN_SNAPSHOT,
        "buildx_version": BUILDX_VERSION,
        "buildkit_image": BUILDKIT_IMAGE,
        "build_args": {
            "NEXT_PUBLIC_AVITO_LEADS_URL": "",
            "NEXT_PUBLIC_MAX_SCRAPER_PHONE": "+79221853150",
            "NEXT_PUBLIC_FORCE_SHOW_ALL_CHANNELS": "true",
        },
    }


def max_materials(application: Path, builder: Path, probe: dict[str, Any]) -> dict[str, Any]:
    release_root = "architecture/recovery/control-plane/v2/hosted-artifacts/crm-6e3f094bf4b4-gravity-max-source-v1"
    dockerfile_path = f"{release_root}/build/max-scraper.Dockerfile"
    probe_path = f"{release_root}/build/max-runtime-probe.js"
    dockerfile_sha, _ = file_identity(builder / dockerfile_path)
    probe_sha, _ = file_identity(builder / probe_path)
    accepted_dockerfile_sha, _ = file_identity(application / "max-web-scraper/Dockerfile")
    lock_sha, _ = file_identity(application / "max-web-scraper/package-lock.json")
    package_sha, _ = file_identity(application / "max-web-scraper/package.json")
    dockerignore_sha, _ = file_identity(application / "max-web-scraper/.dockerignore")
    return {
        "dockerfile": {"authority": "release_builder", "path": dockerfile_path, "sha256": dockerfile_sha},
        "accepted_application_dockerfile": {"path": "max-web-scraper/Dockerfile", "sha256": accepted_dockerfile_sha},
        "dependency_lock": {"path": "max-web-scraper/package-lock.json", "sha256": lock_sha},
        "package_manifest": {"path": "max-web-scraper/package.json", "sha256": package_sha},
        "dockerignore": {"path": "max-web-scraper/.dockerignore", "sha256": dockerignore_sha},
        "runtime_probe_program": {"path": probe_path, "sha256": probe_sha},
        "dockerfile_frontend": DOCKERFILE_FRONTEND,
        "playwright": {
            "source_tag": PLAYWRIGHT_SOURCE_TAG,
            "index_digest": PLAYWRIGHT_INDEX_DIGEST,
            "linux_amd64_manifest_digest": PLAYWRIGHT_AMD64_MANIFEST,
            "config_digest": PLAYWRIGHT_CONFIG_DIGEST,
            "rootfs_diff_ids": list(PLAYWRIGHT_DIFF_IDS),
        },
        "tini_package": {
            "snapshot": "20260801T000000Z",
            "package": "tini",
            "version": "0.19.0-1",
            "architecture": "amd64",
            "url": TINI_URL,
            "sha256": TINI_SHA256,
            "bytes": TINI_BYTES,
            "installed_binary_sha256": TINI_BINARY_SHA256,
            "installed_binary_bytes": TINI_BINARY_BYTES,
        },
        "npm_install": "npm ci --omit=dev --no-audit --no-fund",
        "buildx_version": BUILDX_VERSION,
        "buildkit_image": BUILDKIT_IMAGE,
        "runtime_contract": probe,
    }


def component_attestation(
    component: str,
    builder: dict[str, Any],
    archive_name: str,
    archive: dict[str, Any],
    materials: dict[str, Any],
) -> dict[str, Any]:
    subtree = GRAVITY_SUBTREE if component == "gravity" else MAX_SUBTREE
    schema = "yoko.crm.hosted-coordinated-gravity-image.v1" if component == "gravity" else "yoko.crm.hosted-coordinated-max-scraper-image.v1"
    return {
        "schema": schema,
        "repository": REPOSITORY,
        "component": component,
        "application": {"commit": APPLICATION_COMMIT, "tree": APPLICATION_TREE, "component_subtree": subtree},
        "builder": builder,
        "platform": PLATFORM,
        "image": {"reference": expected_image_reference(component, builder["commit"]), "id": archive["image_id"]},
        "docker_archive": {"path": archive_name, "sha256": archive["archive_sha256"], "bytes": archive["archive_bytes"]},
        "materials": materials,
        "labels": archive["labels"],
    }


def coordinated_manifest(
    builder: dict[str, Any],
    source_authority: dict[str, Any],
    gravity: dict[str, Any],
    gravity_bytes: bytes,
    maximum: dict[str, Any],
    maximum_bytes: bytes,
) -> dict[str, Any]:
    return {
        "schema": "yoko.crm.coordinated-gravity-max-release.v1",
        "repository": REPOSITORY,
        "application": application_identity(),
        "builder": builder,
        "source_authority": source_authority,
        "components": {
            "gravity": {
                "image_reference": gravity["image"]["reference"],
                "image_id": gravity["image"]["id"],
                "docker_archive": gravity["docker_archive"],
                "attestation": {"path": GRAVITY_ATTESTATION, "sha256": sha_bytes(gravity_bytes), "bytes": len(gravity_bytes)},
            },
            "max_scraper": {
                "image_reference": maximum["image"]["reference"],
                "image_id": maximum["image"]["id"],
                "docker_archive": maximum["docker_archive"],
                "attestation": {"path": MAX_ATTESTATION, "sha256": sha_bytes(maximum_bytes), "bytes": len(maximum_bytes)},
            },
        },
        "common": {"platform": PLATFORM, "application_revision_label": APPLICATION_COMMIT, "coordinated_profile_label": PROFILE},
        "artifact_members": list(ARTIFACT_MEMBERS),
    }


def validate_component(
    value: Any,
    component: str,
    builder: dict[str, Any],
    archive_name: str,
    archive: dict[str, Any],
    expected_materials: dict[str, Any],
) -> dict[str, Any]:
    attestation = exact_object(value, {
        "schema", "repository", "component", "application", "builder", "platform",
        "image", "docker_archive", "materials", "labels",
    }, f"{component} attestation")
    expected = component_attestation(component, builder, archive_name, archive, expected_materials)
    if attestation != expected:
        fail(f"{component} attestation binding mismatch")
    return attestation


def verify_artifact(
    artifact: Path,
    application: Path,
    builder_source: Path,
    source_evidence: Path,
    expected_builder_commit: str,
    expected_builder_tree: str,
) -> dict[str, Any]:
    exact_directory(artifact, ARTIFACT_MEMBERS, "coordinated artifact")
    validate_application_source(application)
    builder = builder_identity(builder_source, expected_builder_commit, expected_builder_tree)
    source_authority, proof_bytes = validate_source_authority(source_evidence)
    actual_proof = read_regular_bytes(artifact / SOURCE_PROOF, 2 * 1024 * 1024)
    if actual_proof != proof_bytes:
        fail("coordinated artifact source proof differs from exact source authority")

    gravity_value, gravity_bytes = strict_json_file(artifact / GRAVITY_ATTESTATION, "Gravity attestation")
    maximum_value, maximum_bytes = strict_json_file(artifact / MAX_ATTESTATION, "MAX attestation")
    manifest_value, _ = strict_json_file(artifact / MANIFEST, "coordinated manifest")
    probe = maximum_value.get("materials", {}).get("runtime_contract") if type(maximum_value) is dict else None
    probe = validate_max_probe(probe)
    gravity_files, gravity_directories, gravity_forbidden, gravity_base = gravity_rootfs_contract(application)
    max_files, max_directories, max_forbidden, max_base = max_rootfs_contract(application, probe)
    gravity_reference = expected_image_reference("gravity", expected_builder_commit)
    maximum_reference = expected_image_reference("max-scraper", expected_builder_commit)
    gravity_archive = docker_archive_identity(
        artifact / GRAVITY_ARCHIVE, gravity_reference,
        required_files=gravity_files, required_directories=gravity_directories,
        required_diff_id_prefix=gravity_base,
        forbidden_paths=gravity_forbidden,
    )
    maximum_archive = docker_archive_identity(
        artifact / MAX_ARCHIVE, maximum_reference,
        required_files=max_files, required_directories=max_directories,
        required_diff_id_prefix=max_base,
        forbidden_paths=max_forbidden,
    )
    validate_max_runtime_config(maximum_archive["runtime"])

    gravity = validate_component(
        gravity_value, "gravity", builder, GRAVITY_ARCHIVE, gravity_archive,
        gravity_materials(application),
    )
    maximum = validate_component(
        maximum_value, "max-scraper", builder, MAX_ARCHIVE, maximum_archive,
        max_materials(application, builder_source, probe),
    )
    expected_manifest = coordinated_manifest(
        builder, source_authority, gravity, gravity_bytes, maximum, maximum_bytes,
    )
    if manifest_value != expected_manifest:
        fail("coordinated manifest binding mismatch")
    return {
        "status": "PASS",
        "schema": manifest_value["schema"],
        "application_commit": APPLICATION_COMMIT,
        "builder_commit": expected_builder_commit,
        "gravity_image_id": gravity["image"]["id"],
        "max_image_id": maximum["image"]["id"],
        "combined_docker_archive_bytes": gravity_archive["archive_bytes"] + maximum_archive["archive_bytes"],
    }
