#!/usr/bin/python3 -I
"""Reproduce the fixed attacks and verify a separately authored internal review.

The legacy filename remains a stable entry point.  This program prints replay
evidence for a separate internal reviewer, or consumes that review and reruns
the exact attacks.  It never authors the review, invents reviewer identity, or
substitutes for the new external project re-review required after READY.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR_RELATIVE = "packaging/verify-independent-critic.py"
INTERNAL_REVIEW_SCHEMA = "yoko.crm.internal-runtime-bootstrap-review.v1"
INTERNAL_VERIFICATION_SCHEMA = "yoko.crm.internal-runtime-bootstrap-review-verification.v1"
VALIDATOR_IDENTITY_SCHEMA = "yoko.crm.internal-runtime-bootstrap-replay-validator.v1"
ATTACK_EVIDENCE_SCHEMA = "yoko.crm.internal-runtime-attack-evidence.v1"
NODE_VERSION = "v20.20.2"
NODE_SHA256 = "6295488653f0d93b0a157841746fef7e72cc4328cfb60c4bbe0ca2668a836ffd"
SHA40 = re.compile(r"[0-9a-f]{40}")
SHA64 = re.compile(r"[0-9a-f]{64}")
UTC_SECOND = re.compile(r"20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")
MAX_INTERNAL_REVIEW_AGE = timedelta(hours=24)
ATTACK_IDS = (
    "clean-checkout-ci",
    "raw-credential-synthetic-bypass",
    "unauthorized-migration-write",
    "public-internal-facade-laundering",
    "overlapping-manifest-ownership",
    "stale-forbidden-dependency-plan",
    "missing-migration-provenance",
    "denominator-drift",
)
ATTACK_COMMANDS: dict[str, tuple[tuple[str, ...], ...]] = {
    "clean-checkout-ci": (
        ("tools/architecture/run-authoritative-ci.mjs",),
    ),
    "raw-credential-synthetic-bypass": (
        ("tools/architecture/v2/test-authoritative-credential-inventory.mjs",),
    ),
    "unauthorized-migration-write": (
        (
            "tools/architecture/v2/analyze.mjs", "--root", ".", "--strict",
            "--workers", "4", "--worker-timeout-ms", "120000", "--progress-every", "25",
            "--surface-registry",
            "architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json",
            "--progress-jsonl", "$FRESH_WRITE_PROGRESS", "--output", "$FRESH_WRITE_ANALYSIS",
        ),
        ("tools/architecture/v2/test-migration-write-site-authorizations.mjs", "$FRESH_WRITE_ANALYSIS"),
    ),
    "public-internal-facade-laundering": (
        ("tools/architecture/test-architecture-enforcement.mjs",),
    ),
    "overlapping-manifest-ownership": (
        ("--test", "tools/architecture/__tests__/context-manifests.test.mjs"),
    ),
    "stale-forbidden-dependency-plan": (
        ("tools/architecture/test-final-dependency-artifact.mjs",),
    ),
    "missing-migration-provenance": (
        ("tools/architecture/test-production-migration-authority.mjs",),
    ),
    "denominator-drift": (
        ("tools/architecture/v2/test-original-dod-canonical-mapping.mjs",),
    ),
}
BOOTSTRAP_MTIME = 1786492800
NEW_DEB_NAME = "yoko-privileged-runtime_2.0.0-10_all.deb"
OLD_DEB_NAME = "yoko-privileged-runtime_2.0.0-9_all.deb"
BOOTSTRAP_MODES = {
    "payload": 0o700,
    "payload/install.sh": 0o500,
    "payload/payload-manifest.json": 0o400,
    "payload/review": 0o500,
    "payload/review/human-manifest.md": 0o400,
    "payload/review/installation-procedure.md": 0o400,
    "payload/review/package-manifest.json": 0o400,
    "payload/review/rollback-analysis.md": 0o400,
    f"payload/{NEW_DEB_NAME}": 0o400,
    f"payload/{OLD_DEB_NAME}": 0o400,
}


def canonical_bytes(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def exact_object(value: object, keys: set[str], label: str) -> dict[str, Any]:
    if type(value) is not dict or set(value) != keys:
        raise SystemExit(f"invalid exact-key {label}")
    return value


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON key: {key}")
        value[key] = item
    return value


def parse_json_bytes(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=reject_duplicate_keys,
        )
    except (UnicodeError, ValueError, json.JSONDecodeError) as exc:
        raise SystemExit(f"invalid {label}") from exc
    if type(value) is not dict:
        raise SystemExit(f"invalid {label}")
    return value


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise SystemExit(f"invalid {label}") from exc
    return parse_json_bytes(raw, label)


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["/usr/bin/git", "-C", str(repo), *args],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, timeout=180,
    ).stdout.strip()


def validate_source_repo(repo: Path, source: dict[str, Any]) -> None:
    if (
        set(source) != {"commit", "tree"}
        or not isinstance(source["commit"], str)
        or not SHA40.fullmatch(source["commit"])
        or not isinstance(source["tree"], str)
        or not SHA40.fullmatch(source["tree"])
    ):
        raise SystemExit("invalid sealed source identity")
    try:
        head = git(repo, "rev-parse", "HEAD^{commit}")
        tree = git(repo, "rev-parse", "HEAD^{tree}")
        dirty = git(repo, "status", "--porcelain", "--untracked-files=all")
    except (OSError, subprocess.SubprocessError) as exc:
        raise SystemExit("accepted source checkout unavailable") from exc
    if head != source["commit"] or tree != source["tree"] or dirty:
        raise SystemExit("internal replay source checkout is not the exact clean accepted commit/tree")


def validated_node() -> Path:
    candidate = shutil.which("node")
    if candidate is None:
        raise SystemExit("exact Node.js internal replay runtime unavailable")
    node = Path(candidate).resolve(strict=True)
    if sha(node) != NODE_SHA256:
        raise SystemExit("Node.js internal replay runtime identity mismatch")
    try:
        version = subprocess.run(
            [str(node), "--version"], check=True, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, timeout=30,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError) as exc:
        raise SystemExit("Node.js internal replay runtime unavailable") from exc
    if version != NODE_VERSION:
        raise SystemExit("Node.js internal replay runtime version mismatch")
    return node


def hosted_ci_digest(value: object) -> str:
    return digest_bytes(canonical_bytes(value))


def expected_bindings(
    seal: dict[str, Any], seal_path: Path, tar_path: Path, deb_path: Path,
) -> dict[str, Any]:
    hosted = seal.get("hosted_authoritative_ci")
    if type(hosted) is not dict or not {"workflow", "run", "jobs", "artifact"}.issubset(hosted):
        raise SystemExit("seal lacks exact hosted workflow/run/jobs/artifact authority")
    source = {"commit": seal.get("commit"), "tree": seal.get("tree")}
    validate_source_shape = (
        isinstance(source["commit"], str) and SHA40.fullmatch(source["commit"])
        and isinstance(source["tree"], str) and SHA40.fullmatch(source["tree"])
    )
    for field in ("acceptance_record_sha256", "production_snapshot_sha256"):
        if not isinstance(seal.get(field), str) or not SHA64.fullmatch(seal[field]):
            raise SystemExit(f"seal lacks exact {field}")
    if not validate_source_shape:
        raise SystemExit("seal lacks exact accepted source identity")
    return {
        "source": source,
        "hosted_authoritative_ci": hosted,
        "hosted_authoritative_ci_sha256": hosted_ci_digest(hosted),
        "acceptance_record_sha256": seal["acceptance_record_sha256"],
        "production_snapshot_sha256": seal["production_snapshot_sha256"],
        "sealed_release_sha256": sha(seal_path),
        "debian_package": {"sha256": sha(deb_path), "bytes": deb_path.stat().st_size},
        "bootstrap_tar": {"sha256": sha(tar_path), "bytes": tar_path.stat().st_size},
    }


def validate_bootstrap_tar(tar_path: Path, deb_path: Path) -> str:
    try:
        with tarfile.open(tar_path, mode="r:") as archive:
            members = archive.getmembers()
            if (
                len(members) != len(BOOTSTRAP_MODES)
                or {member.name for member in members} != set(BOOTSTRAP_MODES)
            ):
                raise SystemExit("bootstrap tar inventory is not exact")
            material: list[dict[str, Any]] = []
            content: dict[str, bytes] = {}
            for member in members:
                expected_mode = BOOTSTRAP_MODES[member.name]
                expected_directory = member.name in {"payload", "payload/review"}
                if (
                    member.uid != 0
                    or member.gid != 0
                    or member.mode != expected_mode
                    or member.mtime != BOOTSTRAP_MTIME
                    or member.name.startswith("/")
                    or ".." in Path(member.name).parts
                    or member.issym()
                    or member.islnk()
                    or (expected_directory and not member.isdir())
                    or (not expected_directory and not member.isfile())
                ):
                    raise SystemExit("bootstrap tar member metadata is not exact")
                identity: dict[str, Any] = {
                    "path": member.name,
                    "type": "directory" if expected_directory else "file",
                    "mode": format(member.mode, "04o"),
                    "uid": member.uid,
                    "gid": member.gid,
                    "mtime": member.mtime,
                    "bytes": member.size,
                }
                if not expected_directory:
                    source = archive.extractfile(member)
                    if source is None:
                        raise SystemExit("bootstrap tar member is unavailable")
                    raw = source.read(256 * 1024 * 1024 + 1)
                    if len(raw) > 256 * 1024 * 1024 or len(raw) != member.size:
                        raise SystemExit("bootstrap tar member exceeded its exact bound")
                    content[member.name] = raw
                    identity["sha256"] = digest_bytes(raw)
                material.append(identity)
    except (OSError, tarfile.TarError) as exc:
        raise SystemExit("bootstrap tar is invalid") from exc

    embedded_deb = content[f"payload/{NEW_DEB_NAME}"]
    if (
        len(embedded_deb) != deb_path.stat().st_size
        or digest_bytes(embedded_deb) != sha(deb_path)
        or embedded_deb != deb_path.read_bytes()
    ):
        raise SystemExit("bootstrap tar does not contain the exact Debian package")
    payload = parse_json_bytes(content["payload/payload-manifest.json"], "bootstrap payload manifest")
    review = parse_json_bytes(content["payload/review/package-manifest.json"], "bootstrap review manifest")
    payload_files = payload.get("files")
    new_package = review.get("new_package")
    if (
        payload.get("schema") != "yoko.crm.owner-bootstrap-payload.v1"
        or type(payload_files) is not dict
        or set(payload_files) != {
            "install.sh", NEW_DEB_NAME, OLD_DEB_NAME,
            "review/human-manifest.md", "review/installation-procedure.md",
            "review/package-manifest.json", "review/rollback-analysis.md",
        }
        or review.get("schema") != "yoko.crm.owner-bootstrap-review-manifest.v2"
        or type(new_package) is not dict
        or new_package.get("path") != NEW_DEB_NAME
        or new_package.get("sha256") != sha(deb_path)
        or new_package.get("bytes") != deb_path.stat().st_size
    ):
        raise SystemExit("bootstrap tar package/review manifests are not exact")
    for relative, recorded in payload_files.items():
        member_name = f"payload/{relative}"
        if (
            type(recorded) is not dict
            or set(recorded) != {"sha256", "mode"}
            or recorded["sha256"] != digest_bytes(content[member_name])
            or recorded["mode"] != format(BOOTSTRAP_MODES[member_name], "04o")
        ):
            raise SystemExit("bootstrap tar payload identity mismatch")
    return digest_bytes(canonical_bytes(sorted(material, key=lambda item: item["path"])))


def validator_identity() -> dict[str, str]:
    path = ROOT / VALIDATOR_RELATIVE
    return {
        "schema": VALIDATOR_IDENTITY_SCHEMA,
        "path": VALIDATOR_RELATIVE,
        "sha256": sha(path),
        "node_version": NODE_VERSION,
        "node_sha256": NODE_SHA256,
        "attack_catalog_sha256": digest_bytes(canonical_bytes(list(ATTACK_IDS))),
        "attack_execution_catalog_sha256": digest_bytes(canonical_bytes([
            {"id": attack_id, "commands": normalized_commands(attack_id)}
            for attack_id in ATTACK_IDS
        ])),
    }


def normalized_commands(attack_id: str) -> list[list[str]]:
    return [["NODE_20.20.2", *arguments] for arguments in ATTACK_COMMANDS[attack_id]]


def replay_environment(node: Path, temporary: Path) -> dict[str, str]:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is required for the isolated full-CI internal replay")
    temporary.mkdir(mode=0o700, parents=True, exist_ok=True)
    home = temporary / "home"
    home.mkdir(mode=0o700)
    environment = {
        "CI": "1",
        "DATABASE_URL": database_url,
        "HOME": str(home),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": f"{node.parent}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "TMPDIR": str(temporary),
        "YOKO_BLAST_BASE": "HEAD^",
    }
    postgres_container = os.environ.get("YOKO_POSTGRES_CLIENT_CONTAINER")
    if postgres_container:
        environment["YOKO_POSTGRES_CLIENT_CONTAINER"] = postgres_container
    return environment


def run_attack_command(
    node: Path,
    repo: Path,
    arguments: tuple[str, ...],
    replacements: dict[str, str],
    environment: dict[str, str],
) -> None:
    resolved = [replacements.get(argument, argument) for argument in arguments]
    if resolved[0].endswith("/run-authoritative-ci.mjs"):
        timeout = 3600
    elif resolved[0].endswith("/analyze.mjs"):
        timeout = 900
    else:
        timeout = 300
    completed = subprocess.run(
        [str(node), *resolved], cwd=repo, env=environment,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
    )
    if completed.returncode != 0:
        raise SystemExit(f"internal attack reproduction failed: {arguments[0]}")
    if len(completed.stdout) > 4 * 1024 * 1024 or len(completed.stderr) > 4 * 1024 * 1024:
        raise SystemExit(f"internal attack evidence exceeded bound: {arguments[0]}")


def execute_attacks(
    repo: Path,
    source: dict[str, Any],
    bindings: dict[str, Any],
    node: Path,
) -> list[dict[str, str]]:
    output: list[dict[str, str]] = []
    with tempfile.TemporaryDirectory(prefix="yoko-internal-adversarial-replay-") as temporary_raw:
        temporary = Path(temporary_raw)
        environment = replay_environment(node, temporary)
        replacements = {
            "$FRESH_WRITE_ANALYSIS": str(temporary / "fresh-write-analysis.json"),
            "$FRESH_WRITE_PROGRESS": str(temporary / "fresh-write-progress.jsonl"),
        }
        for attack_id in ATTACK_IDS:
            for command in ATTACK_COMMANDS[attack_id]:
                run_attack_command(node, repo, command, replacements, environment)
            supplement: dict[str, Any] = {}
            if attack_id == "unauthorized-migration-write":
                analysis_path = Path(replacements["$FRESH_WRITE_ANALYSIS"])
                analysis = read_json(analysis_path, "fresh write analysis")
                analysis_sha256 = analysis.get("analysis_sha256")
                execution = analysis.get("execution")
                if (
                    not isinstance(analysis_sha256, str)
                    or not SHA64.fullmatch(analysis_sha256)
                    or type(execution) is not dict
                    or execution.get("complete") is not True
                    or execution.get("worker_failures") != 0
                    or execution.get("worker_timeouts") != 0
                ):
                    raise SystemExit("fresh migration-write attack evidence is incomplete")
                supplement["fresh_write_analysis_sha256"] = analysis_sha256
            material = {
                "schema": ATTACK_EVIDENCE_SCHEMA,
                "id": attack_id,
                "source": source,
                "bootstrap_tar_sha256": bindings["bootstrap_tar"]["sha256"],
                "debian_package_sha256": bindings["debian_package"]["sha256"],
                "sealed_release_sha256": bindings["sealed_release_sha256"],
                "validator_sha256": validator_identity()["sha256"],
                "commands": normalized_commands(attack_id),
                "environment": {
                    "fixed": ["CI=1", "YOKO_BLAST_BASE=HEAD^", "LANG=C.UTF-8", "LC_ALL=C.UTF-8"],
                    "database_url_required": True,
                    "postgres_client_container_optional": True,
                    "ambient_node_options_allowed": False,
                },
                "supplement": supplement,
                "result": "PASS",
            }
            output.append({
                "id": attack_id,
                "status": "PASS",
                "evidence_sha256": digest_bytes(canonical_bytes(material)),
            })
    validate_source_repo(repo, source)
    return output


def validate_executed_at(value: object) -> datetime:
    if not isinstance(value, str) or not UTC_SECOND.fullmatch(value):
        raise SystemExit("internal replay executed_at is not exact UTC-second form")
    try:
        observed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise SystemExit("internal replay executed_at is invalid") from exc
    if observed > datetime.now(timezone.utc):
        raise SystemExit("internal replay executed_at is in the future")
    return observed


def validate_attack_results(recorded: object) -> list[dict[str, str]]:
    if type(recorded) is not list:
        raise SystemExit("internal attack evidence is not a list")
    ids: list[str] = []
    for attack in recorded:
        exact = exact_object(attack, {"id", "status", "evidence_sha256"}, "internal attack")
        if (
            not isinstance(exact["id"], str)
            or exact["status"] != "PASS"
            or not isinstance(exact["evidence_sha256"], str)
            or not SHA64.fullmatch(exact["evidence_sha256"])
        ):
            raise SystemExit("internal attack evidence is invalid")
        ids.append(exact["id"])
    if tuple(ids) != ATTACK_IDS or len(set(ids)) != len(ATTACK_IDS):
        raise SystemExit("internal attack ID set is missing, duplicate, unknown, or reordered")
    return recorded


def build_replay_evidence(
    bindings: dict[str, Any], attacks: list[dict[str, str]], executed_at: str,
) -> dict[str, Any]:
    validate_executed_at(executed_at)
    return {
        "schema": "yoko.crm.internal-runtime-bootstrap-adversarial-replay.v1",
        "status": "PASS",
        "role": "INTERNAL_ADVERSARIAL_EVIDENCE_ONLY",
        "executed_at": executed_at,
        "bindings": bindings,
        "validator": validator_identity(),
        "attacks": validate_attack_results(attacks),
        "owner_authorization": False,
        "external_reviewer_attestation": False,
        "repository_mutated_by_replay": False,
        "production_mutated_by_replay": False,
    }


def validate_internal_review(
    review: object,
    bindings: dict[str, Any],
    attacks: list[dict[str, str]],
) -> dict[str, Any]:
    """Consume, but never create, the separate internal review decision.

    Reviewer identity is an explicit human/process assertion, not a fabricated
    cryptographic identity.  Mechanical value comes from exact release bindings
    plus a fresh local rerun whose ordered evidence must match byte-for-byte.
    """
    value = exact_object(review, {
        "schema", "verdict", "reviewer_assertion", "reviewed_at", "separation_assertion",
        "bindings", "validator", "attacks", "residual_findings",
        "repository_mutated_by_reviewer", "production_mutated_by_reviewer",
    }, "internal review")
    reviewed_at = validate_executed_at(value["reviewed_at"])
    reviewer = value["reviewer_assertion"]
    if (
        value["schema"] != INTERNAL_REVIEW_SCHEMA
        or value["verdict"] != "PASS"
        or not isinstance(reviewer, str)
        or not re.fullmatch(r"INTERNAL_[A-Z0-9_.:-]{3,120}", reviewer)
        or value["separation_assertion"] != "NOT_THE_EXECUTOR_AND_NOT_THE_POST_READY_EXTERNAL_REVIEWER"
        or canonical_bytes(value["bindings"]) != canonical_bytes(bindings)
        or canonical_bytes(value["validator"]) != canonical_bytes(validator_identity())
        or value["residual_findings"] != []
        or value["repository_mutated_by_reviewer"] is not False
        or value["production_mutated_by_reviewer"] is not False
    ):
        raise SystemExit("internal review does not authorize this exact sealed release")
    if datetime.now(timezone.utc) - reviewed_at > MAX_INTERNAL_REVIEW_AGE:
        raise SystemExit("internal review is stale")
    recorded = validate_attack_results(value["attacks"])
    if canonical_bytes(recorded) != canonical_bytes(attacks):
        raise SystemExit("internal review attack evidence does not match the fresh replay")
    return value


def release_inputs_unchanged(
    initial: dict[str, str], seal_path: Path, tar_path: Path, deb_path: Path,
) -> None:
    current = {"seal": sha(seal_path), "tar": sha(tar_path), "deb": sha(deb_path)}
    if current != initial:
        raise SystemExit("sealed release changed during internal replay")


def main() -> None:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--replay-evidence", action="store_true")
    mode.add_argument("--verify-review", action="store_true")
    parser.add_argument("--source-repo", type=Path, required=True)
    parser.add_argument("--seal", type=Path, required=True)
    parser.add_argument("--tar", type=Path, required=True)
    parser.add_argument("--deb", type=Path, required=True)
    parser.add_argument("--review-artifact", type=Path)
    args = parser.parse_args()

    seal_path = args.seal.resolve(strict=True)
    tar_path = args.tar.resolve(strict=True)
    deb_path = args.deb.resolve(strict=True)
    repo = args.source_repo.resolve(strict=True)
    initial = {"seal": sha(seal_path), "tar": sha(tar_path), "deb": sha(deb_path)}
    seal = read_json(seal_path, "sealed release")
    bindings = expected_bindings(seal, seal_path, tar_path, deb_path)
    bindings["bootstrap_tar"]["inventory_sha256"] = validate_bootstrap_tar(tar_path, deb_path)
    if (
        bindings["sealed_release_sha256"] != initial["seal"]
        or bindings["bootstrap_tar"]["sha256"] != initial["tar"]
        or bindings["debian_package"]["sha256"] != initial["deb"]
    ):
        raise SystemExit("sealed release changed while critic bindings were materialized")
    source = bindings["source"]
    validate_source_repo(repo, source)
    release_inputs_unchanged(initial, seal_path, tar_path, deb_path)
    node = validated_node()
    attacks = execute_attacks(repo, source, bindings, node)
    release_inputs_unchanged(initial, seal_path, tar_path, deb_path)
    validate_source_repo(repo, source)
    executed_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if args.replay_evidence:
        if args.review_artifact is not None:
            raise SystemExit("--review-artifact is valid only with --verify-review")
        result = build_replay_evidence(bindings, attacks, executed_at)
        release_inputs_unchanged(initial, seal_path, tar_path, deb_path)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return
    if args.review_artifact is None:
        raise SystemExit("--verify-review requires --review-artifact")
    review_path = args.review_artifact.resolve(strict=True)
    review_initial_sha256 = sha(review_path)
    review = validate_internal_review(
        read_json(review_path, "internal review artifact"), bindings, attacks,
    )
    if sha(review_path) != review_initial_sha256:
        raise SystemExit("internal review artifact changed during verification")
    result = {
        "schema": INTERNAL_VERIFICATION_SCHEMA,
        "status": "PASS",
        "reviewer_assertion": review["reviewer_assertion"],
        "reviewed_at": review["reviewed_at"],
        "internal_review_artifact_sha256": review_initial_sha256,
        "sealed_release_sha256": bindings["sealed_release_sha256"],
        "bootstrap_tar_sha256": bindings["bootstrap_tar"]["sha256"],
        "debian_package_sha256": bindings["debian_package"]["sha256"],
        "hosted_authoritative_ci_sha256": bindings["hosted_authoritative_ci_sha256"],
        "attack_catalog_sha256": validator_identity()["attack_catalog_sha256"],
        "attack_execution_catalog_sha256": validator_identity()["attack_execution_catalog_sha256"],
        "attacks": attacks,
        "validator": validator_identity(),
        "external_project_rereview_satisfied": False,
    }
    release_inputs_unchanged(initial, seal_path, tar_path, deb_path)
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
