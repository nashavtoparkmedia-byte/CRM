#!/usr/bin/python3 -I
"""Seal deterministic coordinated Runtime inputs, package, and Owner bootstrap."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
PREFIX = "architecture/recovery/control-plane/v2/owner-bootstrap/crm-10318827e484-gravity-max-source-v1"
PROFILE_ID = "crm-10318827e484-gravity-max-source-v1"
APPLICATION_COMMIT = "10318827e484fec466ba994a2a7b7ffe070f7336"
APPLICATION_TREE = "b1ba84f39bf1037416b8ae94d61c64ce174e39fa"
STAGE_A_COMMIT = "46e6107187776929db52ca127061b0c99a21ce71"
STAGE_A_TREE = "9b9d4009275d4cbc413f643fb063a7368ef53bff"
ARTIFACT_DIGEST = "29c52cbbdb86aa8d8766e05aa5c7d856ec1d692e2133edab511d025d918b5da0"
ARTIFACT_STORE = f"/var/lib/yoko-privileged-runtime/coordinated-artifacts/{ARTIFACT_DIGEST}"
ROLLBACK_VERSION = "2.0.0-21"
# Direct control-plane rollback: the installed same-version 2.0.0-21 interim package that carries
# predecessor observation v2 and the byte-identical crm-ba90ed4b6717 profile. Its seal is that
# package's build manifest (package-manifest.json).
ROLLBACK_SHA = "0095ce04ce0aa9587883b944e201fbe2ade9524c74458e54dd3c550fc8f72367"
ROLLBACK_SEAL_SHA = "6d283a4bd950947cedfd86fc80ddb551368de83153828746c5f134d8f44efbfe"
# The predecessor being rolled back to, and where its OWN sealed profile lives inside its package.
ROLLBACK_PROFILE_ID = "crm-ba90ed4b6717-gravity-max-source-v1"
ROLLBACK_PROFILE_MEMBER = f"./usr/local/share/yoko-privileged-runtime/profiles/{ROLLBACK_PROFILE_ID}/profile.v1.json"
RELEASE_ENVIRONMENT_NAME = "MAX_SCRAPER_WEBHOOK_SECRET"
PAIR_INSPECTIONS = (
    ("gravity-mvp", "docker-inspect:crm.container.gravity_mvp", "gravity_image_id"),
    ("max-web-scraper", "docker-inspect:crm.container.max_scraper", "max_image_id"),
)
EPOCH = 1788307200
ARTIFACT_FILES = {
    "authoritative-ci-execution.json": {"sha256": "f1493cdc1b2e71bf5743862de42c6782feb6a394f577381b55e9d4b75269d905", "bytes": 5590},
    "coordinated-release-manifest.json": {"sha256": "828876af9ebd49c7bbd97df47f20e06632df18ac2951e3776b33a4bfa0f55a7f", "bytes": 4399},
    "gravity-image-attestation.json": {"sha256": "d0503c5b7bc8bcf69b2abc99f953ce08e1d4610346d7b8a6f2dc4c4ee021d52e", "bytes": 2525},
    "gravity-image.docker.tar": {"sha256": "047eba04eaec84e40a1383cb23a6fef9d6a6affaa8f714a409a4b40a1a68013e", "bytes": 2527864320},
    "max-scraper-image-attestation.json": {"sha256": "dd3ada9ab741d0187d620a91803835410f188b478bde041415f9f4c39d0a7a68", "bytes": 4475},
    "max-scraper-image.docker.tar": {"sha256": "4ce5abee7e5ba684e2d1cc382fb168a1fb20ca196bfd1036e94992357c4ae6cc", "bytes": 2278233600},
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
        or document.get("package_version") != "2.0.0-22"
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
        "runtime_profile_id": "crm-ba90ed4b6717-gravity-max-source-v1",
        "gravity_image_id": "sha256:4dbe322a88fb5a635ffa5abc2d1d22071ba941fc22ce460edde3cd185717868c",
        "max_image_id": "sha256:ede5efb412d462a01bb9965f97a698a2c4b4bd3fb24d4ac478b1710a9943c7c6",
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


def validate_artifact(
    handoff: Path,
    application: Path,
    stage_a_builder: Path,
    predecessor_authority: Path,
    repository: Path,
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
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
    verifier = stage_a_builder / "architecture/recovery/control-plane/v2/hosted-artifacts/crm-10318827e484-gravity-max-source-v1/verify-coordinated-artifact.py"
    completed = command([
        "/usr/bin/python3", "-I", "-B", str(verifier),
        "--artifact-directory", str(artifact),
        "--application-source", str(application),
        "--builder-source", str(stage_a_builder),
        "--source-authority-evidence", str(source_evidence),
        # The Stage A verifier pinned at STAGE_A_COMMIT proves all lineage below its
        # repair base by binding the accepted predecessor authority, so it requires
        # this evidence checkout. Sending the previous generation's six arguments
        # made argparse exit 2 and aborted the seal with no useful diagnosis.
        "--predecessor-authority", str(predecessor_authority),
        "--builder-commit", STAGE_A_COMMIT,
        "--builder-tree", STAGE_A_TREE,
    ])
    result = json.loads(completed.stdout.decode("ascii"), object_pairs_hook=duplicate_safe)
    expected_result = {
        "status": "PASS",
        "schema": "yoko.crm.coordinated-gravity-max-release.v1",
        "application_commit": APPLICATION_COMMIT,
        "builder_commit": STAGE_A_COMMIT,
        "gravity_image_id": "sha256:0247864ab320fa86498da0d69610ce9a910a46d92ded420091b7c4d6b0aa6152",
        "gravity_containerd_image_id": "sha256:f72e18febe4928cac7394805efe4f7029cd3c11ced8451ecb5c6f3c56a7f04e5",
        "max_image_id": "sha256:f9e09bd8c2dcc98c309e440b82f7e8586aac406f2510bbaf9be90d98908b252a",
        "max_containerd_image_id": "sha256:26acfcfab7304d30285c9990dfccaa8a9e148b3b294633d8ae48ce4c8d633da2",
        "combined_docker_archive_bytes": 4806097920,
    }
    if result != expected_result:
        raise ValueError("Stage A content verifier result mismatch")
    transport = load(handoff / "coordinated-artifact-transport-manifest.json")
    if (
        transport.get("schema") != "yoko.crm.github-artifact-chunk-transport.v1"
        or transport.get("application_commit") != APPLICATION_COMMIT
        or transport.get("builder_commit") != STAGE_A_COMMIT
        or transport.get("coordinated_profile") != PROFILE_ID
        or transport.get("workflow_run") != {"head_branch": "codex/coordinated-gravity-max-10318827", "head_sha": STAGE_A_COMMIT, "id": 36978099367}
        or transport.get("source_artifact") != {
            "bytes": 4806116003,
            "digest": "sha256:" + ARTIFACT_DIGEST,
            "id": 11215210912,
            "name": "coordinated-gravity-max-10318827e484-46e6107187776929db52ca127061b0c99a21ce71",
        }
    ):
        raise ValueError("authenticated Stage A transport identity mismatch")
    files = {name: {"path": f"{ARTIFACT_STORE}/{name}", **record} for name, record in sorted(ARTIFACT_FILES.items())}
    return result, files


def predecessor_sealed_profile(package: Path) -> tuple[dict[str, Any], str]:
    """The predecessor's OWN sealed profile, read from inside its digest-verified package."""
    if sha(package) != ROLLBACK_SHA:
        raise ValueError("direct control-plane rollback package mismatch")
    stream = command(["dpkg-deb", "--fsys-tarfile", str(package)]).stdout
    with tarfile.open(fileobj=io.BytesIO(stream), mode="r:") as archive:
        members = [member for member in archive.getmembers() if member.name == ROLLBACK_PROFILE_MEMBER]
        if len(members) != 1 or not members[0].isfile() or members[0].size > 1024 * 1024:
            raise ValueError("predecessor sealed profile missing from its package")
        handle = archive.extractfile(members[0])
        if handle is None:
            raise ValueError("predecessor sealed profile unreadable")
        raw = handle.read()
    profile = json.loads(raw, object_pairs_hook=duplicate_safe)
    if profile.get("profile_id") != ROLLBACK_PROFILE_ID or profile.get("package_version") != ROLLBACK_VERSION:
        raise ValueError("predecessor sealed profile identity mismatch")
    return profile, hashlib.sha256(raw).hexdigest()


def derive_predecessor_rollback_semantic(
    snapshot: dict[str, Any], predecessor_profile: dict[str, Any], predecessor_profile_sha: str
) -> dict[str, Any]:
    """Rollback reproduces the predecessor from two authorities only.

    1. The production snapshot's recorded semantic for each pair container: its active command and
       its environment names, bound to the sealed predecessor image identity.
    2. The predecessor's OWN sealed profile: the release_environment source mapping it attached.

    A recorded release-environment name is reproduced only from the predecessor's own source for
    that service. If the snapshot shows the predecessor consuming the name but its sealed authority
    has no source for it, sealing FAILS CLOSED: no successor source and no name-based inference is
    ever substituted. The projection carries commands, paths and digests, never a value.
    """
    sealing = snapshot["sealing"]
    commands = snapshot.get("commands")
    release = predecessor_profile.get("release_environment")
    sources: dict[str, Any] = {}
    if release is not None:
        if not isinstance(release, dict) or release.get("name") != RELEASE_ENVIRONMENT_NAME or not isinstance(release.get("sources"), dict):
            raise ValueError("predecessor release environment authority invalid")
        sources = release["sources"]
    services: dict[str, Any] = {}
    for service, key, image_key in PAIR_INSPECTIONS:
        record = commands.get(key) if isinstance(commands, dict) else None
        evidence = record.get("evidence") if isinstance(record, dict) else None
        semantic = evidence.get("semantic") if isinstance(evidence, dict) else None
        if not isinstance(semantic, dict) or semantic.get("image_id") != sealing[image_key]:
            raise ValueError(f"recorded predecessor semantic for {service} is not the sealed predecessor")
        active = semantic.get("command")
        names = semantic.get("environment_names")
        if not isinstance(active, list) or not active or any(not isinstance(argument, str) or not argument for argument in active):
            raise ValueError(f"recorded predecessor command for {service} is invalid")
        if not isinstance(names, list) or any(not isinstance(name, str) or not name for name in names):
            raise ValueError(f"recorded predecessor environment names for {service} are invalid")
        source = None
        if RELEASE_ENVIRONMENT_NAME in names:
            source = sources.get(service)
            if not isinstance(source, str) or not source:
                raise ValueError(
                    f"predecessor {service} consumes {RELEASE_ENVIRONMENT_NAME} but its own sealed profile "
                    "provides no source for it: rollback cannot reproduce it, refusing to seal"
                )
        services[service] = {"command": list(active), "release_environment_source": source}
    return {
        "release_environment_name": RELEASE_ENVIRONMENT_NAME,
        "services": services,
        "provenance": {
            "predecessor_package_sha256": ROLLBACK_SHA,
            "predecessor_profile_id": ROLLBACK_PROFILE_ID,
            "predecessor_profile_sha256": predecessor_profile_sha,
            "semantic_source": "production-snapshot docker-inspect semantic",
        },
    }


def render_profile(
    snapshot: dict[str, Any], files: dict[str, dict[str, Any]], receipt_path: str, receipt_sha: str,
    rollback_semantic: dict[str, Any],
) -> bytes:
    sealing = snapshot["sealing"]
    text = (ROOT / "templates/profile.v1.json.in").read_text(encoding="ascii")
    replacements = {
        "@ARTIFACT_RECEIPT_PATH@": receipt_path,
        "@ARTIFACT_RECEIPT_SHA256@": receipt_sha,
        "@ARTIFACT_FILES_JSON@": canonical(files).decode("ascii"),
        "@PREDECESSOR_ROLLBACK_SEMANTIC_JSON@": canonical(rollback_semantic).decode("ascii"),
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
    parser.add_argument("--predecessor-authority", required=True, type=Path)
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
    predecessor_profile, predecessor_profile_sha = predecessor_sealed_profile(args.rollback_package)
    rollback_semantic = derive_predecessor_rollback_semantic(snapshot, predecessor_profile, predecessor_profile_sha)
    artifact_result, files = validate_artifact(
        args.handoff_root,
        args.application_source,
        args.stage_a_builder_source,
        args.predecessor_authority,
        repository,
    )

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
        "stage_a_artifact_id": 11215210912,
        "stage_a_artifact_digest": "sha256:" + ARTIFACT_DIGEST,
        "content_verifier": artifact_result,
        "files": files,
        "production_mutated": False,
    }
    write_json(generated / "artifact-admission.v1.json", receipt)
    receipt_sha = sha(generated / "artifact-admission.v1.json")
    profile_raw = render_profile(snapshot, files, receipt_path, receipt_sha, rollback_semantic)
    write(generated / "profile.v1.json", profile_raw, 0o444)
    copy_exact(ROOT / "templates/crm-activation-profile.py.in", generated / "crm-activation-profile.py", 0o444)
    trusted = {
        "core_sha256": "0f97bafbfe5b430fa7994119b1fc76fead4bdbee26766c730d9e399551ebdffa",
        "predecessor_observer_sha256": "1d430cb9797e31a0236213e9e2c69ad2951b0f343ae6eabe5b014e664a27604a",
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
        "package_version": "2.0.0-22",
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
            "run_id": 36978099367,
            "artifact_id": 11215210912,
            "artifact_digest": "sha256:" + ARTIFACT_DIGEST,
            "artifact_bytes": 4806116003,
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
    package = dist / "yoko-privileged-runtime_2.0.0-22_all.deb"
    package_sha = sha(package)
    release_seal = {
        "schema": "yoko.crm.coordinated-runtime-release-seal.v1",
        "profile_id": PROFILE_ID,
        "package_version": "2.0.0-22",
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
        "new_package": {"name": "yoko-privileged-runtime", "version": "2.0.0-22", "architecture": "all"},
        "direct_rollback": {
            "name": "yoko-privileged-runtime", "version": ROLLBACK_VERSION, "sha256": ROLLBACK_SHA,
            "store_path": f"/var/lib/yoko-privileged-runtime/activation-bootstraps/{ROLLBACK_SHA}/yoko-privileged-runtime_{ROLLBACK_VERSION}_all.deb",
        },
        "files": payload_files,
    }
    write_json(payload / "payload-manifest.json", payload_manifest, 0o400)
    bundle_name = "yoko-crm-coordinated-runtime-2.0.0-22.tar"
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
