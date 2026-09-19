#!/usr/bin/python3 -I
"""Seal deterministic coordinated Runtime inputs, package, and Owner bootstrap."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
PREFIX = "architecture/recovery/control-plane/v2/owner-bootstrap/crm-c7e29a24e960-gravity-max-source-v1"
PROFILE_ID = "crm-c7e29a24e960-gravity-max-source-v1"
APPLICATION_COMMIT = "c7e29a24e960ddd75e6701d71e06405777e58d1e"
APPLICATION_TREE = "ca47f7d426d2da0299916ca25ef448dc0e7b7b37"
STAGE_A_COMMIT = "f32ee22a1e8967e92f1828075d7650eb8d0f8dea"
STAGE_A_TREE = "25d4fa01e652cbcc015232c7a8cb64fc87e750ad"
ARTIFACT_DIGEST = "cd63ed4aa7364fdff649fa8dc095622610f8dd3dbce96b0a300852759c772442"
ARTIFACT_STORE = f"/var/lib/yoko-privileged-runtime/coordinated-artifacts/{ARTIFACT_DIGEST}"
ROLLBACK_VERSION = "2.0.0-17"
ROLLBACK_SHA = "490a242bd89c5dc5c8377c9d47cf6602fef73bdfa879388080170507eaff8a34"
ROLLBACK_SEAL_SHA = "b2108997c6c9e2d911483b77554bea1e1b6e4923b97bd01a1954ae660762ccf8"
EPOCH = 1788307200
ARTIFACT_FILES = {
    "authoritative-ci-execution.json": {"sha256": "4c356f5b276841ce57f233738dc53c941c2ceeb8e63017b93b716619751c3d76", "bytes": 5590},
    "coordinated-release-manifest.json": {"sha256": "2ac6845b0eccfc079360016fbbecc4b2854c649ffde8924806c5e19757212235", "bytes": 4176},
    "gravity-image-attestation.json": {"sha256": "6dc3d40dfd9967b82d5d6357a60650d6ecec5165614d4719a3738b5774333bd5", "bytes": 2525},
    "gravity-image.docker.tar": {"sha256": "b188beee5cfd8ebfce3fe851470053653c07daaebdeeeaaa83f78f320b6c004f", "bytes": 2527576576},
    "max-scraper-image-attestation.json": {"sha256": "f91728d3baf8523c0b9848af4d219422811143be7a9b5babbeb50c6b747fa3c6", "bytes": 4475},
    "max-scraper-image.docker.tar": {"sha256": "8c43581ec34bf79fe72ac9de33124dc81c89f5297e3f44094a4ac31cfff67033", "bytes": 2278227456},
}


REVIEW_SCHEMA = "yoko.crm.coordinated-runtime-independent-review.v1"
REVIEW_ROLES = ("release-reliability", "privileged-runtime-security")
REVIEW_VERDICTS = frozenset({"PASS", "PASS_WITH_LOW_FINDINGS"})
RESIDUAL_SEVERITIES = frozenset({"LOW", "INFO"})
BLOCKING_SEVERITIES = frozenset({"CRITICAL", "HIGH", "MEDIUM"})
REVIEW_TIMESTAMP = "%Y-%m-%dT%H:%M:%SZ"
REVIEW_MAXIMUM = 1024 * 1024
# Names the sealer itself writes into the bundle review directory. Reviewer-supplied evidence
# may not claim them, or a chosen filename would silently displace sealer-authored content.
REVIEW_RESERVED_NAMES = frozenset({"human-manifest.md", "independent-review.v1.json"})


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


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
        raise ValueError(f"JSON root is not an object: {path}")
    return value


def sha(path: Path, maximum: int | None = None) -> str:
    value = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
        raise ValueError(f"unsafe file: {path}")
    if maximum is not None and value.st_size > maximum:
        raise ValueError(f"file too large: {path}")
    output = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            output.update(chunk)
    finally:
        os.close(fd)
    return output.hexdigest()


def write(path: Path, raw: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".new")
    temporary.unlink(missing_ok=True)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, mode)
    try:
        remaining = memoryview(raw)
        while remaining:
            written = os.write(fd, remaining)
            if written <= 0:
                raise OSError("short write")
            remaining = remaining[written:]
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, path)


def write_json(path: Path, value: Any, mode: int = 0o444) -> None:
    write(path, canonical(value) + b"\n", mode)


def command(args: list[str], *, stdout: int | None = subprocess.PIPE) -> subprocess.CompletedProcess[bytes]:
    completed = subprocess.run(args, check=False, stdin=subprocess.DEVNULL, stdout=stdout, stderr=subprocess.PIPE)
    if completed.returncode != 0:
        raise ValueError(f"command failed: {args[0]}")
    return completed


def git(repository: Path, *args: str) -> str:
    return command(["git", "-C", str(repository), *args]).stdout.decode("ascii").strip()


def assert_clean_identity(repository: Path, commit: str, tree: str, label: str) -> None:
    if git(repository, "rev-parse", "HEAD^{commit}") != commit or git(repository, "rev-parse", "HEAD^{tree}") != tree:
        raise ValueError(f"{label} identity mismatch")
    if command(["git", "-C", str(repository), "status", "--porcelain=v1", "--untracked-files=all"]).stdout:
        raise ValueError(f"{label} is dirty")


def deb_metadata(path: Path) -> list[str]:
    return [
        command(["dpkg-deb", "-f", str(path), field]).stdout.decode("ascii").strip()
        for field in ("Package", "Version", "Architecture")
    ]


def builder_inventory(repository: Path) -> tuple[list[dict[str, Any]], str, str]:
    commit = git(repository, "rev-parse", "HEAD^{commit}")
    tree = git(repository, "rev-parse", "HEAD^{tree}")
    if command(["git", "-C", str(repository), "status", "--porcelain=v1", "--untracked-files=all"]).stdout:
        raise ValueError("runtime builder checkout is dirty")
    raw = command(["git", "-C", str(repository), "ls-tree", "-rz", "--full-tree", "HEAD", PREFIX]).stdout
    rows: list[dict[str, Any]] = []
    for item in raw.split(b"\0"):
        if not item:
            continue
        metadata, raw_path = item.split(b"\t", 1)
        mode, kind, blob = metadata.decode("ascii").split()
        path = raw_path.decode("utf-8")
        if kind != "blob" or mode not in {"100644", "100755"} or not path.startswith(PREFIX + "/"):
            raise ValueError("runtime builder tree contains an unsupported entry")
        relative = path[len(PREFIX) + 1:]
        actual = ROOT / relative
        value = actual.lstat()
        actual_mode = "100755" if value.st_mode & 0o111 else "100644"
        actual_sha = sha(actual)
        if actual_mode != mode or git(repository, "hash-object", path) != blob:
            raise ValueError("runtime builder working bytes differ from Git")
        rows.append({"path": relative, "mode": mode, "blob": blob, "sha256": actual_sha, "bytes": value.st_size})
    rows.sort(key=lambda row: row["path"])
    if len(rows) < 12:
        raise ValueError("runtime builder inventory is incomplete")
    return rows, commit, tree


def parse_time(value: Any) -> dt.datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("timestamp invalid")
    return dt.datetime.fromisoformat(value[:-1] + "+00:00")


def validate_independent_review(path: Path, commit: str, tree: str) -> tuple[dict[str, Any], list[Path]]:
    """Bind two real independent review outcomes to this exact candidate, or refuse to seal.

    The document is an input, never something this sealer can author: it must live outside the
    builder tree, name both required roles, and carry for each one a reviewer, a verdict from the
    accepted set, and the digest of that review's own evidence file, which is verified here and
    copied into the Owner bundle. Any CRITICAL, HIGH or MEDIUM finding refuses the seal; residual
    LOW findings are permitted only when the verdict says so and they are listed explicitly. The
    acceptance template in this directory cannot satisfy any of that, which is the point.
    """
    resolved = path.resolve(strict=True)
    if resolved.is_relative_to(ROOT.resolve()):
        raise ValueError("independent review evidence must be supplied from outside the builder tree")
    document = load(resolved)
    if (
        document.get("schema") != REVIEW_SCHEMA
        or document.get("profile_id") != PROFILE_ID
        or document.get("package_version") != "2.0.0-18"
    ):
        raise ValueError("independent review document contract mismatch")
    if document.get("candidate_commit") != commit or document.get("candidate_tree") != tree:
        raise ValueError("independent review is not bound to the exact sealing candidate")
    reviews = document.get("reviews")
    if not isinstance(reviews, list) or len(reviews) != len(REVIEW_ROLES):
        raise ValueError("independent review must carry exactly one outcome per required role")
    accepted: list[dict[str, Any]] = []
    evidence_files: list[Path] = []
    residual = 0
    for entry in reviews:
        if not isinstance(entry, dict):
            raise ValueError("independent review entry invalid")
        role = entry.get("role")
        if role not in REVIEW_ROLES or any(item["role"] == role for item in accepted):
            raise ValueError("independent review roles are not the exact required set")
        reviewer = entry.get("reviewer")
        if not isinstance(reviewer, str) or not reviewer.strip():
            raise ValueError("independent review entry lacks a reviewer identity")
        if entry.get("independent") is not True or entry.get("executor_assertion") is not False:
            raise ValueError("independent review entry is not an independent reviewer outcome")
        verdict = entry.get("verdict")
        if verdict not in REVIEW_VERDICTS:
            raise ValueError("independent review verdict is not an accepted outcome")
        try:
            dt.datetime.strptime(str(entry.get("reviewed_at")), REVIEW_TIMESTAMP)
        except (TypeError, ValueError) as exc:
            raise ValueError("independent review entry lacks an exact review timestamp") from exc
        evidence = entry.get("evidence")
        if not isinstance(evidence, dict) or set(evidence) != {"path", "sha256", "bytes"}:
            raise ValueError("independent review entry lacks an exact evidence binding")
        name = evidence["path"]
        if not isinstance(name, str) or "/" in name or name in {"", ".", ".."}:
            raise ValueError("independent review evidence path is unsafe")
        if name in REVIEW_RESERVED_NAMES or any(item["evidence"]["path"] == name for item in accepted):
            raise ValueError("independent review evidence path collides with sealed bundle content")
        if not isinstance(evidence["sha256"], str) or len(evidence["sha256"]) != 64:
            raise ValueError("independent review evidence digest is unsafe")
        source = resolved.parent / name
        if sha(source, REVIEW_MAXIMUM) != evidence["sha256"] or source.stat().st_size != evidence["bytes"]:
            raise ValueError("independent review evidence bytes drifted")
        findings = entry.get("findings")
        if not isinstance(findings, list):
            raise ValueError("independent review entry lacks an explicit findings list")
        residual_findings = []
        for finding in findings:
            if not isinstance(finding, dict) or set(finding) != {"id", "severity", "title"}:
                raise ValueError("independent review finding invalid")
            severity = finding.get("severity")
            if severity in BLOCKING_SEVERITIES:
                raise ValueError("independent review carries a blocking finding; release material refused")
            if severity not in RESIDUAL_SEVERITIES:
                raise ValueError("independent review finding severity is not an accepted residual")
            residual_findings.append(finding)
        low = [finding for finding in residual_findings if finding["severity"] == "LOW"]
        if verdict == "PASS" and residual_findings:
            raise ValueError("independent review verdict PASS cannot carry residual findings")
        if verdict == "PASS_WITH_LOW_FINDINGS" and not low:
            raise ValueError("independent review verdict claims residual findings but lists none")
        residual += len(low)
        evidence_files.append(source)
        accepted.append({
            "role": role,
            "reviewer": reviewer,
            "verdict": verdict,
            "reviewed_at": entry["reviewed_at"],
            "evidence": {"path": name, "packed": f"{role}-evidence",
                         "sha256": evidence["sha256"], "bytes": evidence["bytes"]},
            "residual_findings": residual_findings,
        })
    order = sorted(range(len(accepted)), key=lambda index: accepted[index]["role"])
    accepted = [accepted[index] for index in order]
    evidence_files = [evidence_files[index] for index in order]
    return {
        "status": "ACCEPTED",
        "schema": REVIEW_SCHEMA,
        "document": {"path": resolved.name, "sha256": sha(resolved, REVIEW_MAXIMUM)},
        "candidate_commit": commit,
        "candidate_tree": tree,
        "reviews": accepted,
        "residual_low_findings": residual,
        "blocking_findings": 0,
    }, evidence_files


def validate_snapshot(path: Path) -> tuple[dict[str, Any], str]:
    snapshot = load(path)
    if snapshot.get("schema") != "yoko.crm.coordinated-runtime-production-snapshot.v1" or snapshot.get("production_mutated") is not False or snapshot.get("secret_values_emitted") is not False:
        raise ValueError("production snapshot contract mismatch")
    started = parse_time(snapshot.get("started_at"))
    completed = parse_time(snapshot.get("completed_at"))
    now = dt.datetime.now(dt.timezone.utc)
    if started > completed or completed > now + dt.timedelta(minutes=1) or now - completed > dt.timedelta(minutes=15):
        raise ValueError("production snapshot is stale")
    sealing = snapshot.get("sealing")
    required = {
        "runtime_package_version", "runtime_profile_id", "audit_record_count", "audit_last_digest",
        "predecessor_release_critical_identity_sha256", "gravity_container_id", "gravity_image_id",
        "gravity_compose_config_hash", "max_container_id", "max_image_id", "max_compose_config_hash",
        "max_volume_source_sha256", "postgres_container_id", "postgres_image_id",
        "database_identity_sha256", "applied_migration_count", "migration_rows_sha256",
        "unrelated_semantic_fingerprint_sha256",
    }
    if not isinstance(sealing, dict) or set(sealing) != required:
        raise ValueError("production sealing projection mismatch")
    fixed = {
        "runtime_package_version": ROLLBACK_VERSION,
        # The installed runtime being rolled back to still reports its own profile.
        # This mirrors what the live snapshot records, so it must not follow the
        # successor's profile id.
        "runtime_profile_id": "crm-be6b8eb82d8c-gravity-max-source-v1",
        "gravity_image_id": "sha256:5531c67e99b572356f897246b8c845ab4f9b232d9dc029fa311397e46a4d715c",
        "max_image_id": "sha256:87835969ed6335a99d50e1cc2eaf70aa33fdbaf937f4cef658a926f55b26f365",
        "max_volume_source_sha256": "fc08035e511fd21c704ef93e6de3948239f40b5f1a6fb6869aec247a3406f2a3",
        "postgres_image_id": "sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229",
        "database_identity_sha256": "ed88dfeaad2a3dc2e759590d295992cd06531d4403d896ded00b21ea667be1c9",
        # The predecessor runtime reports this digest rather than the rows behind it, so the sealer
        # can no longer re-derive it. Pinning the known predecessor value keeps an independent check
        # here, instead of trusting whatever a hand-edited snapshot document happens to carry.
        "migration_rows_sha256": "78de9c8e61312c0a28669eeedba76f3626d2c41e7df3ae6bf9f2c1270c51b27c",
    }
    if any(sealing.get(key) != value for key, value in fixed.items()):
        raise ValueError("production predecessor drifted")
    for key in (
        "audit_last_digest", "predecessor_release_critical_identity_sha256", "gravity_compose_config_hash",
        "max_compose_config_hash", "migration_rows_sha256", "unrelated_semantic_fingerprint_sha256",
    ):
        if not isinstance(sealing.get(key), str) or len(sealing[key]) != 64:
            raise ValueError("snapshot digest invalid")
    if (
        not isinstance(sealing["audit_record_count"], int)
        or isinstance(sealing["audit_record_count"], bool)
        or sealing["audit_record_count"] < 1
        or not isinstance(sealing["applied_migration_count"], int)
        or isinstance(sealing["applied_migration_count"], bool)
        or sealing["applied_migration_count"] != 63
    ):
        raise ValueError("snapshot bounded count invalid")
    return snapshot, sha(path, 16 * 1024 * 1024)


def validate_artifact(handoff: Path, application: Path, stage_a_builder: Path, repository: Path) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    artifact = handoff / "release-output"
    source_evidence = handoff / "source-authority"
    if sorted(path.name for path in artifact.iterdir()) != sorted(ARTIFACT_FILES):
        raise ValueError("Stage A artifact member allowlist mismatch")
    for name, expected in ARTIFACT_FILES.items():
        value = (artifact / name).lstat()
        if (artifact / name).is_symlink() or not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_size != expected["bytes"]:
            raise ValueError(f"Stage A artifact file mismatch: {name}")
        if name.endswith(".json") and sha(artifact / name, 2 * 1024 * 1024) != expected["sha256"]:
            raise ValueError(f"Stage A metadata digest mismatch: {name}")
    # The content verifier belongs to the Stage A authority that built this artifact, so it is
    # taken from the Stage A builder checkout rather than the runtime builder repository. That
    # checkout has already been pinned to STAGE_A_COMMIT/STAGE_A_TREE above, so the verifier's
    # own bytes are bound to a verified identity; the runtime repository need not carry a copy.
    verifier = stage_a_builder / "architecture/recovery/control-plane/v2/hosted-artifacts/crm-c7e29a24e960-gravity-max-source-v1/verify-coordinated-artifact.py"
    completed = command([
        "/usr/bin/python3", "-I", "-B", str(verifier),
        "--artifact-directory", str(artifact),
        "--application-source", str(application),
        "--builder-source", str(stage_a_builder),
        "--source-authority-evidence", str(source_evidence),
        "--builder-commit", STAGE_A_COMMIT,
        "--builder-tree", STAGE_A_TREE,
    ])
    result = json.loads(completed.stdout.decode("ascii"), object_pairs_hook=duplicate_safe)
    expected_result = {
        "status": "PASS",
        "schema": "yoko.crm.coordinated-gravity-max-release.v1",
        "application_commit": APPLICATION_COMMIT,
        "builder_commit": STAGE_A_COMMIT,
        "gravity_image_id": "sha256:49c8434bdb0c87f881560946bdefaa040ceb5602dafd4bc6d4a6f8ac09c6d898",
        "gravity_containerd_image_id": "sha256:830e29eedc0d460c33ed907e88003973ef9f08282e39116e4ebc8a6a357de698",
        "max_image_id": "sha256:d6c9f0f9c7b800c08fb6366a0b223f607d6aae2502efb86b865e4118abf5e668",
        "max_containerd_image_id": "sha256:cfc4e940d681f2a6a1f84b13b84d398756d616462941f251717827fa0fa0a376",
        "combined_docker_archive_bytes": 4805804032,
    }
    if result != expected_result:
        raise ValueError("Stage A content verifier result mismatch")
    transport = load(handoff / "coordinated-artifact-transport-manifest.json")
    if (
        transport.get("schema") != "yoko.crm.github-artifact-chunk-transport.v1"
        or transport.get("application_commit") != APPLICATION_COMMIT
        or transport.get("builder_commit") != STAGE_A_COMMIT
        or transport.get("coordinated_profile") != PROFILE_ID
        or transport.get("workflow_run") != {"head_branch": "codex/coordinated-gravity-max-c7e29a24", "head_sha": STAGE_A_COMMIT, "id": 35395889864}
        or transport.get("source_artifact") != {
            "bytes": 4805821920,
            "digest": "sha256:" + ARTIFACT_DIGEST,
            "id": 10567922654,
            "name": "coordinated-gravity-max-c7e29a24e960-f32ee22a1e8967e92f1828075d7650eb8d0f8dea",
        }
    ):
        raise ValueError("authenticated Stage A transport identity mismatch")
    files = {name: {"path": f"{ARTIFACT_STORE}/{name}", **record} for name, record in sorted(ARTIFACT_FILES.items())}
    return result, files


def render_profile(snapshot: dict[str, Any], files: dict[str, dict[str, Any]], receipt_path: str, receipt_sha: str) -> bytes:
    sealing = snapshot["sealing"]
    text = (ROOT / "templates/profile.v1.json.in").read_text(encoding="ascii")
    replacements = {
        "@ARTIFACT_RECEIPT_PATH@": receipt_path,
        "@ARTIFACT_RECEIPT_SHA256@": receipt_sha,
        "@ARTIFACT_FILES_JSON@": canonical(files).decode("ascii"),
        "@CAPTURE_COMPLETED_AT@": snapshot["completed_at"],
        "@PREDECESSOR_RELEASE_IDENTITY@": sealing["predecessor_release_critical_identity_sha256"],
        "@UNRELATED_FINGERPRINT@": sealing["unrelated_semantic_fingerprint_sha256"],
        "@PREDECESSOR_GRAVITY_CONTAINER@": sealing["gravity_container_id"],
        "@PREDECESSOR_GRAVITY_CONFIG_HASH@": sealing["gravity_compose_config_hash"],
        "@PREDECESSOR_MAX_CONTAINER@": sealing["max_container_id"],
        "@PREDECESSOR_MAX_CONFIG_HASH@": sealing["max_compose_config_hash"],
        "@POSTGRES_CONTAINER@": sealing["postgres_container_id"],
        "@MIGRATION_ROWS_SHA256@": sealing["migration_rows_sha256"],
    }
    for source, target in replacements.items():
        if text.count(source) != 1:
            raise ValueError(f"profile placeholder count invalid: {source}")
        text = text.replace(source, str(target))
    if remainders(text):
        raise ValueError("unrendered profile placeholder")
    value = json.loads(text, object_pairs_hook=duplicate_safe)
    return canonical(value) + b"\n"


def remainders(text: str) -> bool:
    import re
    return re.search(r"@[A-Z][A-Z0-9_]+@", text) is not None


def copy_exact(source: Path, destination: Path, mode: int) -> None:
    write(destination, source.read_bytes(), mode)


def build_tar(bundle: Path, destination: Path) -> None:
    command([
        "/usr/bin/tar", "--sort=name", f"--mtime=@{EPOCH}", "--owner=0", "--group=0", "--numeric-owner", "--format=gnu",
        "-C", str(bundle), "-cf", str(destination), "payload",
    ], stdout=subprocess.DEVNULL)


def reopen_generated_review_for_cleanup(directory: Path) -> None:
    review = directory / "bundle/payload/review"
    if review.is_symlink():
        raise ValueError("unsafe generated review output path")
    if not review.exists():
        return
    value = review.lstat()
    if not stat.S_ISDIR(value.st_mode) or not review.resolve().is_relative_to(directory.resolve()):
        raise ValueError("unsafe generated review output path")
    review.chmod(0o700)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--builder-repo", required=True, type=Path)
    parser.add_argument("--application-source", required=True, type=Path)
    parser.add_argument("--stage-a-builder-source", required=True, type=Path)
    parser.add_argument("--handoff-root", required=True, type=Path)
    parser.add_argument("--production-snapshot", required=True, type=Path)
    parser.add_argument("--rollback-package", required=True, type=Path)
    parser.add_argument("--rollback-seal", required=True, type=Path)
    parser.add_argument("--independent-review", required=True, type=Path)
    args = parser.parse_args()
    repository = args.builder_repo.resolve(strict=True)
    if ROOT.resolve().is_relative_to(repository) is False:
        raise ValueError("builder directory is outside repository")
    inventory, builder_commit, builder_tree = builder_inventory(repository)
    review, review_evidence = validate_independent_review(args.independent_review, builder_commit, builder_tree)
    assert_clean_identity(args.application_source, APPLICATION_COMMIT, APPLICATION_TREE, "accepted application")
    assert_clean_identity(args.stage_a_builder_source, STAGE_A_COMMIT, STAGE_A_TREE, "Stage A builder")
    snapshot, snapshot_sha = validate_snapshot(args.production_snapshot)
    if sha(args.rollback_package) != ROLLBACK_SHA:
        raise ValueError("direct control-plane rollback package mismatch")
    if deb_metadata(args.rollback_package) != ["yoko-privileged-runtime", ROLLBACK_VERSION, "all"]:
        raise ValueError("direct control-plane rollback metadata mismatch")
    if sha(args.rollback_seal, 16 * 1024 * 1024) != ROLLBACK_SEAL_SHA:
        raise ValueError("direct control-plane rollback seal mismatch")
    artifact_result, files = validate_artifact(args.handoff_root, args.application_source, args.stage_a_builder_source, repository)

    generated = ROOT / "generated"
    dist = ROOT / "dist"
    for directory in (generated, dist):
        if directory.exists():
            if directory.is_symlink() or not directory.resolve().is_relative_to(ROOT.resolve()):
                raise ValueError("unsafe generated output path")
            reopen_generated_review_for_cleanup(directory)
            shutil.rmtree(directory)
    generated.mkdir(mode=0o700)
    dist.mkdir(mode=0o755)
    receipt_path = f"{ARTIFACT_STORE}/artifact-admission.v1.json"
    receipt = {
        "schema": "yoko.crm.coordinated-artifact-admission.v1",
        "profile_id": PROFILE_ID,
        "application_commit": APPLICATION_COMMIT,
        "stage_a_artifact_id": 10567922654,
        "stage_a_artifact_digest": "sha256:" + ARTIFACT_DIGEST,
        "content_verifier": artifact_result,
        "files": files,
        "production_mutated": False,
    }
    write_json(generated / "artifact-admission.v1.json", receipt)
    receipt_sha = sha(generated / "artifact-admission.v1.json")
    profile_raw = render_profile(snapshot, files, receipt_path, receipt_sha)
    write(generated / "profile.v1.json", profile_raw, 0o444)
    copy_exact(ROOT / "templates/crm-activation-profile.py.in", generated / "crm-activation-profile.py", 0o444)
    trusted = {
        "core_sha256": "0f97bafbfe5b430fa7994119b1fc76fead4bdbee26766c730d9e399551ebdffa",
        "predecessor_observer_sha256": "b5ea36c50e12b0fe6c171896258ddfc00a9d2666778735cae6a9b2a8df6d4084",
        "policy_sha256": "8727373b0c6ec79c9abf82f1aaaa58abc2bae67e96aa96a602ac419f308db0e0",
        "sudoers_sha256": "3022dcfc323706da81e760255dd1ab43f9b8662ee699aa8b58fbe6e714cc69d7",
    }
    if (
        sha(ROOT / "src/yoko-privileged-runtime-core.py") != trusted["core_sha256"]
        or sha(ROOT / "src/predecessor-observability-v1.py") != trusted["predecessor_observer_sha256"]
        or sha(ROOT / "src/policy.v2.base.json") != trusted["policy_sha256"]
        or sha(ROOT / "packaging/92-yoko-privileged-runtime") != trusted["sudoers_sha256"]
    ):
        raise ValueError("trusted boundary bytes changed")
    sealed_inputs = {
        "schema": "yoko.crm.coordinated-runtime-sealed-inputs.v1",
        "profile_id": PROFILE_ID,
        "package_version": "2.0.0-18",
        "runtime_builder": {
            "commit": builder_commit,
            "tree": builder_tree,
            "subtree_prefix": PREFIX,
            "subtree_inventory_sha256": hashlib.sha256(canonical(inventory)).hexdigest(),
            "subtree_inventory": inventory,
        },
        "accepted_application": {"commit": APPLICATION_COMMIT, "tree": APPLICATION_TREE},
        "stage_a": {
            "builder_commit": STAGE_A_COMMIT,
            "builder_tree": STAGE_A_TREE,
            "run_id": 35395889864,
            "artifact_id": 10567922654,
            "artifact_digest": "sha256:" + ARTIFACT_DIGEST,
            "artifact_bytes": 4805821920,
            "content_verifier": artifact_result,
        },
        "artifact_admission": {"receipt_path": receipt_path, "receipt_sha256": receipt_sha, "files": files},
        "production_snapshot": {"sha256": snapshot_sha, "completed_at": snapshot["completed_at"], "sealing": snapshot["sealing"]},
        "direct_control_plane_rollback": {
            "package_version": ROLLBACK_VERSION,
            "package_sha256": ROLLBACK_SHA,
            "package_bytes": args.rollback_package.stat().st_size,
            "root_store_path": f"/var/lib/yoko-privileged-runtime/activation-bootstraps/{ROLLBACK_SHA}/yoko-privileged-runtime_{ROLLBACK_VERSION}_all.deb",
            "seal_sha256": ROLLBACK_SEAL_SHA,
        },
        "trusted_boundary": trusted,
        "generated": {
            "profile_runtime_sha256": sha(generated / "crm-activation-profile.py"),
            "profile_sha256": sha(generated / "profile.v1.json"),
        },
        "production_mutated": False,
        "database_mutation_authorized": False,
        "contact_identity_mutation_authorized": False,
    }
    write_json(generated / "sealed-inputs.v1.json", sealed_inputs)

    command([str(ROOT / "packaging/build-package.sh")], stdout=subprocess.DEVNULL)
    package = dist / "yoko-privileged-runtime_2.0.0-18_all.deb"
    package_sha = sha(package)
    release_seal = {
        "schema": "yoko.crm.coordinated-runtime-release-seal.v1",
        "profile_id": PROFILE_ID,
        "package_version": "2.0.0-18",
        "runtime_builder": {"commit": builder_commit, "tree": builder_tree, "subtree_inventory_sha256": sealed_inputs["runtime_builder"]["subtree_inventory_sha256"]},
        "accepted_application": sealed_inputs["accepted_application"],
        "stage_a": sealed_inputs["stage_a"],
        "artifact_admission": sealed_inputs["artifact_admission"],
        "production_snapshot": {"sha256": snapshot_sha, "completed_at": snapshot["completed_at"], "predecessor_release_critical_identity_sha256": snapshot["sealing"]["predecessor_release_critical_identity_sha256"]},
        "direct_control_plane_rollback": sealed_inputs["direct_control_plane_rollback"],
        "sealed_inputs_sha256": sha(generated / "sealed-inputs.v1.json"),
        "package": {"path": package.name, "sha256": package_sha, "bytes": package.stat().st_size, "architecture": "all"},
        "production_mutated": False,
        "independent_review": review,
    }
    write_json(dist / "SEALED_RELEASE.json", release_seal)
    release_seal_sha = sha(dist / "SEALED_RELEASE.json")

    payload = generated / "bundle/payload"
    review_directory = payload / "review"
    review_directory.mkdir(parents=True, mode=0o700)
    payload.chmod(0o700)
    installer = (ROOT / "templates/install.sh.in").read_text(encoding="ascii")
    replacements = {
        "@NEW_DEB_SHA256@": package_sha,
        "@ROLLBACK_SEAL_SHA256@": ROLLBACK_SEAL_SHA,
        "@AUDIT_RECORD_COUNT@": str(snapshot["sealing"]["audit_record_count"]),
        "@AUDIT_LAST_DIGEST@": snapshot["sealing"]["audit_last_digest"],
        "@RELEASE_SEAL_SHA256@": release_seal_sha,
        "@ARTIFACT_RECEIPT_SHA256@": receipt_sha,
    }
    for source, target in replacements.items():
        if installer.count(source) != 1:
            raise ValueError(f"installer placeholder count invalid: {source}")
        installer = installer.replace(source, target)
    if remainders(installer):
        raise ValueError("unrendered installer placeholder")
    write(payload / "install.sh", installer.encode("ascii"), 0o500)
    copy_exact(package, payload / package.name, 0o400)
    copy_exact(dist / "SEALED_RELEASE.json", payload / "SEALED_RELEASE.json", 0o400)
    copy_exact(generated / "artifact-admission.v1.json", payload / "artifact-admission.v1.json", 0o400)
    copy_exact(args.rollback_seal, payload / "runtime-rollback-SEALED_RELEASE.json", 0o400)
    copy_exact(ROOT / "human-manifest.md", review_directory / "human-manifest.md", 0o400)
    copy_exact(args.independent_review.resolve(strict=True), review_directory / "independent-review.v1.json", 0o400)
    # Packed under a deterministic per-role name, never the reviewer's own filename, so the Owner
    # installer can keep an exact static allowlist and no supplied name reaches the bundle.
    for entry, item in zip(review["reviews"], review_evidence):
        copy_exact(item, review_directory / f"{entry['role']}-evidence", 0o400)
    review_directory.chmod(0o500)
    payload_files = {}
    for item in sorted(path for path in payload.rglob("*") if path.is_file()):
        relative = str(item.relative_to(payload))
        payload_files[relative] = {"sha256": sha(item), "bytes": item.stat().st_size, "mode": format(stat.S_IMODE(item.stat().st_mode), "04o")}
    payload_manifest = {
        "schema": "yoko.crm.coordinated-owner-bootstrap-payload.v1",
        "profile_id": PROFILE_ID,
        "new_package": {"name": "yoko-privileged-runtime", "version": "2.0.0-18", "architecture": "all"},
        "direct_rollback": {
            "name": "yoko-privileged-runtime", "version": ROLLBACK_VERSION, "sha256": ROLLBACK_SHA,
            "store_path": f"/var/lib/yoko-privileged-runtime/activation-bootstraps/{ROLLBACK_SHA}/yoko-privileged-runtime_{ROLLBACK_VERSION}_all.deb",
        },
        "files": payload_files,
    }
    write_json(payload / "payload-manifest.json", payload_manifest, 0o400)
    bundle_name = "yoko-crm-coordinated-runtime-2.0.0-18.tar"
    with tempfile.TemporaryDirectory(prefix=".bundle-build.", dir=ROOT) as raw_work:
        work = Path(raw_work)
        build_tar(generated / "bundle", work / "a.tar")
        build_tar(generated / "bundle", work / "b.tar")
        if (work / "a.tar").read_bytes() != (work / "b.tar").read_bytes():
            raise ValueError("bootstrap build is not deterministic")
        copy_exact(work / "a.tar", dist / bundle_name, 0o444)
    bootstrap = dist / bundle_name
    bootstrap_identity = {
        "schema": "yoko.crm.coordinated-runtime-bootstrap-identity.v1",
        "profile_id": PROFILE_ID,
        "runtime_builder_commit": builder_commit,
        "release_seal_sha256": release_seal_sha,
        "package_sha256": package_sha,
        "bootstrap": {"path": bundle_name, "sha256": sha(bootstrap), "bytes": bootstrap.stat().st_size},
        "direct_rollback_package_sha256": ROLLBACK_SHA,
        "independent_review": {"status": review["status"], "document_sha256": review["document"]["sha256"],
                               "candidate_commit": review["candidate_commit"],
                               "residual_low_findings": review["residual_low_findings"],
                               "blocking_findings": review["blocking_findings"]},
        "production_mutated": False,
    }
    write_json(dist / "BOOTSTRAP_IDENTITY.json", bootstrap_identity)
    write_json(dist / "BUILD_EVIDENCE.json", {
        "schema": "yoko.crm.coordinated-runtime-build-evidence.v1",
        "status": "PASS",
        "runtime_builder": {"commit": builder_commit, "tree": builder_tree},
        "stage_a_verifier": artifact_result,
        "package": release_seal["package"],
        "release_seal_sha256": release_seal_sha,
        "bootstrap": bootstrap_identity["bootstrap"],
        "production_mutated": False,
    })
    # Re-check the acceptance independently, against the written seal and the packed bundle rather
    # than the values assembled above. Runs last because it re-hashes what the bundle carries.
    command(["/usr/bin/python3", "-I", "-B", str(ROOT / "packaging/verify-sealed-inputs.py"), "--phase", "release"],
            stdout=subprocess.DEVNULL)
    sys.stdout.buffer.write(canonical({
        "status": "PASS", "builder_commit": builder_commit, "builder_tree": builder_tree,
        "package_sha256": package_sha, "release_seal_sha256": release_seal_sha,
        "bootstrap_sha256": bootstrap_identity["bootstrap"]["sha256"],
    }) + b"\n")


if __name__ == "__main__":
    try:
        main()
    except (OSError, UnicodeError, ValueError, subprocess.SubprocessError) as exc:
        sys.stderr.write(f"release sealing failed: {exc}\n")
        raise SystemExit(1)
