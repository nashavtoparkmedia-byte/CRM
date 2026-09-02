#!/usr/bin/python3 -I
"""Seal deterministic Runtime v15 inputs, package, and Owner bootstrap."""
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
PREFIX = "architecture/recovery/control-plane/v2/owner-bootstrap/crm-6e3f094bf4b4-gravity-max-source-v1"
PROFILE_ID = "crm-6e3f094bf4b4-gravity-max-source-v1"
APPLICATION_COMMIT = "6e3f094bf4b42c1400c705843ab107dacd6d1cf8"
APPLICATION_TREE = "8d3e507cda69a2862db946b2e34c5ea329c425ac"
STAGE_A_COMMIT = "64f3f529e5e31368c55a40a91157db7e740e5ed1"
STAGE_A_TREE = "a5448a31ffdb84ead24e9cbf6a8252c755c55293"
ARTIFACT_DIGEST = "721c56b5800a4b2b4855cd5f9dff323c27057e3c8368f155e72c6cd01558f3ea"
ARTIFACT_STORE = f"/var/lib/yoko-privileged-runtime/coordinated-artifacts/{ARTIFACT_DIGEST}"
V14_SHA = "af08fcf17f64bcd028692d4d9289bc38f91d9df46b8c40c9f7e8df595d1337c4"
V14_SEAL_SHA = "8a7e28a3ad49ab6fb3be27e9bfa42d75aff6755b41a1d40119ce806026adb5ad"
EPOCH = 1788307200
ARTIFACT_FILES = {
    "authoritative-ci-execution.json": {"sha256": "b3538bb506a173dbb67d9d306bb33889bb653dd64528e3bed620f140d4d2aa48", "bytes": 5454},
    "coordinated-release-manifest.json": {"sha256": "6aee02bc32cddd648f5ceba94faac11201891b9363f1e5b5e1198d413eec8508", "bytes": 3044},
    "gravity-image-attestation.json": {"sha256": "a3b2914928efd1537229afc6485d7489b2aa041d217c6ea1d649fd358ce1a9f2", "bytes": 2525},
    "gravity-image.docker.tar": {"sha256": "4aa239fd788eeda5a192e4af3f5d9b126e57d8a224b3829954d487c2b3026d71", "bytes": 2525087744},
    "max-scraper-image-attestation.json": {"sha256": "ef482d3555488e54a1b6b09a61955a2c33113da29500564b526b4bf4f9dedd3d", "bytes": 4475},
    "max-scraper-image.docker.tar": {"sha256": "5d2e9ffbef26fb034089c6627ec7e3f1e5d07325ab79e4571ae088b4e8451428", "bytes": 2278168576},
}


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
        "database_identity_sha256", "migration_rows", "migration_rows_sha256",
        "unrelated_semantic_fingerprint_sha256",
    }
    if not isinstance(sealing, dict) or set(sealing) != required:
        raise ValueError("production sealing projection mismatch")
    fixed = {
        "runtime_package_version": "2.0.0-14",
        "runtime_profile_id": "crm-41f69fe8fe3f-gravity-source-v1",
        "gravity_image_id": "sha256:5531c67e99b572356f897246b8c845ab4f9b232d9dc029fa311397e46a4d715c",
        "max_image_id": "sha256:87835969ed6335a99d50e1cc2eaf70aa33fdbaf937f4cef658a926f55b26f365",
        "max_volume_source_sha256": "fc08035e511fd21c704ef93e6de3948239f40b5f1a6fb6869aec247a3406f2a3",
        "postgres_image_id": "sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229",
        "database_identity_sha256": "ed88dfeaad2a3dc2e759590d295992cd06531d4403d896ded00b21ea667be1c9",
    }
    if any(sealing.get(key) != value for key, value in fixed.items()):
        raise ValueError("production predecessor drifted")
    for key in (
        "audit_last_digest", "predecessor_release_critical_identity_sha256", "gravity_compose_config_hash",
        "max_compose_config_hash", "migration_rows_sha256", "unrelated_semantic_fingerprint_sha256",
    ):
        if not isinstance(sealing.get(key), str) or len(sealing[key]) != 64:
            raise ValueError("snapshot digest invalid")
    if not isinstance(sealing["audit_record_count"], int) or sealing["audit_record_count"] < 1 or len(sealing["migration_rows"]) != 62:
        raise ValueError("snapshot bounded count invalid")
    if hashlib.sha256(canonical(sealing["migration_rows"])).hexdigest() != sealing["migration_rows_sha256"]:
        raise ValueError("migration projection digest mismatch")
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
    verifier = repository / "architecture/recovery/control-plane/v2/hosted-artifacts/crm-6e3f094bf4b4-gravity-max-source-v1/verify-coordinated-artifact.py"
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
        "gravity_image_id": "sha256:707a0e82514468338192d01600cf5cc46c15be6ca0a37e0498a48156b0fb5a3e",
        "gravity_containerd_image_id": "sha256:00ffd8b1ae64aa3018f26578da05a96c9f1e77e42d8fc9906f0f4ddaa7918af2",
        "max_image_id": "sha256:653d3c3714ed62777b3307a1da96c21ddc5218ce103a8b0fcf0a0bad88c86307",
        "max_containerd_image_id": "sha256:75e2e96bb07acf9fe25f4aab6c89175b6c13fa10bf71e2b9005f6f8cc319ab5a",
        "combined_docker_archive_bytes": 4803256320,
    }
    if result != expected_result:
        raise ValueError("Stage A content verifier result mismatch")
    transport = load(handoff / "coordinated-artifact-transport-manifest.json")
    if (
        transport.get("schema") != "yoko.crm.github-artifact-chunk-transport.v1"
        or transport.get("application_commit") != APPLICATION_COMMIT
        or transport.get("builder_commit") != STAGE_A_COMMIT
        or transport.get("coordinated_profile") != PROFILE_ID
        or transport.get("workflow_run") != {"head_branch": "codex/prepare-max-coordinated-release-20260901", "head_sha": STAGE_A_COMMIT, "id": 33542881677}
        or transport.get("source_artifact") != {
            "bytes": 4803272912,
            "digest": "sha256:" + ARTIFACT_DIGEST,
            "id": 9814812256,
            "name": "coordinated-gravity-max-6e3f094bf4b4-64f3f529e5e31368c55a40a91157db7e740e5ed1",
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
    parser.add_argument("--v14-package", required=True, type=Path)
    parser.add_argument("--v14-seal", required=True, type=Path)
    args = parser.parse_args()
    repository = args.builder_repo.resolve(strict=True)
    if ROOT.resolve().is_relative_to(repository) is False:
        raise ValueError("builder directory is outside repository")
    inventory, builder_commit, builder_tree = builder_inventory(repository)
    assert_clean_identity(args.application_source, APPLICATION_COMMIT, APPLICATION_TREE, "accepted application")
    assert_clean_identity(args.stage_a_builder_source, STAGE_A_COMMIT, STAGE_A_TREE, "Stage A builder")
    snapshot, snapshot_sha = validate_snapshot(args.production_snapshot)
    if sha(args.v14_package) != V14_SHA:
        raise ValueError("Runtime v14 rollback package mismatch")
    if deb_metadata(args.v14_package) != ["yoko-privileged-runtime", "2.0.0-14", "all"]:
        raise ValueError("Runtime v14 rollback metadata mismatch")
    if sha(args.v14_seal, 16 * 1024 * 1024) != V14_SEAL_SHA:
        raise ValueError("Runtime v14 rollback seal mismatch")
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
        "stage_a_artifact_id": 9814812256,
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
        "package_version": "2.0.0-15",
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
            "run_id": 33542881677,
            "artifact_id": 9814812256,
            "artifact_digest": "sha256:" + ARTIFACT_DIGEST,
            "artifact_bytes": 4803272912,
            "content_verifier": artifact_result,
        },
        "artifact_admission": {"receipt_path": receipt_path, "receipt_sha256": receipt_sha, "files": files},
        "production_snapshot": {"sha256": snapshot_sha, "completed_at": snapshot["completed_at"], "sealing": snapshot["sealing"]},
        "direct_control_plane_rollback": {
            "package_version": "2.0.0-14",
            "package_sha256": V14_SHA,
            "package_bytes": args.v14_package.stat().st_size,
            "root_store_path": f"/var/lib/yoko-privileged-runtime/activation-bootstraps/{V14_SHA}/yoko-privileged-runtime_2.0.0-14_all.deb",
            "seal_sha256": V14_SEAL_SHA,
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
    package = dist / "yoko-privileged-runtime_2.0.0-15_all.deb"
    package_sha = sha(package)
    release_seal = {
        "schema": "yoko.crm.coordinated-runtime-release-seal.v1",
        "profile_id": PROFILE_ID,
        "package_version": "2.0.0-15",
        "runtime_builder": {"commit": builder_commit, "tree": builder_tree, "subtree_inventory_sha256": sealed_inputs["runtime_builder"]["subtree_inventory_sha256"]},
        "accepted_application": sealed_inputs["accepted_application"],
        "stage_a": sealed_inputs["stage_a"],
        "artifact_admission": sealed_inputs["artifact_admission"],
        "production_snapshot": {"sha256": snapshot_sha, "completed_at": snapshot["completed_at"], "predecessor_release_critical_identity_sha256": snapshot["sealing"]["predecessor_release_critical_identity_sha256"]},
        "direct_control_plane_rollback": sealed_inputs["direct_control_plane_rollback"],
        "sealed_inputs_sha256": sha(generated / "sealed-inputs.v1.json"),
        "package": {"path": package.name, "sha256": package_sha, "bytes": package.stat().st_size, "architecture": "all"},
        "production_mutated": False,
        "independent_review": "PENDING",
    }
    write_json(dist / "SEALED_RELEASE.json", release_seal)
    release_seal_sha = sha(dist / "SEALED_RELEASE.json")

    payload = generated / "bundle/payload"
    review = payload / "review"
    review.mkdir(parents=True, mode=0o700)
    payload.chmod(0o700)
    installer = (ROOT / "templates/install.sh.in").read_text(encoding="ascii")
    replacements = {
        "@NEW_DEB_SHA256@": package_sha,
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
    copy_exact(args.v14_seal, payload / "runtime-v14-SEALED_RELEASE.json", 0o400)
    copy_exact(ROOT / "human-manifest.md", review / "human-manifest.md", 0o400)
    review.chmod(0o500)
    payload_files = {}
    for item in sorted(path for path in payload.rglob("*") if path.is_file()):
        relative = str(item.relative_to(payload))
        payload_files[relative] = {"sha256": sha(item), "bytes": item.stat().st_size, "mode": format(stat.S_IMODE(item.stat().st_mode), "04o")}
    payload_manifest = {
        "schema": "yoko.crm.coordinated-owner-bootstrap-payload.v1",
        "profile_id": PROFILE_ID,
        "new_package": {"name": "yoko-privileged-runtime", "version": "2.0.0-15", "architecture": "all"},
        "direct_rollback": {
            "name": "yoko-privileged-runtime", "version": "2.0.0-14", "sha256": V14_SHA,
            "store_path": f"/var/lib/yoko-privileged-runtime/activation-bootstraps/{V14_SHA}/yoko-privileged-runtime_2.0.0-14_all.deb",
        },
        "files": payload_files,
    }
    write_json(payload / "payload-manifest.json", payload_manifest, 0o400)
    bundle_name = "yoko-crm-coordinated-runtime-2.0.0-15.tar"
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
        "direct_rollback_package_sha256": V14_SHA,
        "independent_review": "PENDING",
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
