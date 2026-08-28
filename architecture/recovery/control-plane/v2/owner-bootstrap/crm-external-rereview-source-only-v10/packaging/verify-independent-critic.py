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
RUNTIME_SOURCE_PREFIX = "architecture/recovery/control-plane/v2/owner-bootstrap/crm-external-rereview-source-only-v10"
TRANSITION_VALIDATOR_RELATIVE = VALIDATOR_RELATIVE
TRANSITION_TESTS = (
    ("tests/test_transition_identity_model.py", "TransitionIdentityModelTests"),
    ("tests/test_rollback_control.py", "RollbackControlTests"),
    ("tests/test_builder_contract.py", "BootstrapTransitionTests"),
)
TRANSITION_EVIDENCE_SCHEMA = "yoko.crm.transition-identity-strategy-review-evidence.v1"
TRANSITION_REVIEW_SCHEMA = "yoko.crm.transition-identity-strategy-independent-runtime-review.v1"
TRANSITION_VERIFICATION_SCHEMA = "yoko.crm.transition-identity-strategy-independent-runtime-review-verification.v1"
MAX_TRANSITION_REVIEW_AGE = timedelta(hours=24)
TRANSITION_TARGETED_TESTS = (
    "schema_has_three_non_aliasing_transition_domains",
    "preflight_accepts_predecessor_when_target_is_deliberately_different",
    "wrong_predecessor_hash_fails_before_any_mutation",
    "target_and_recovery_hashes_are_derived_into_distinct_state_domains",
    "prestate_target_alias_is_rejected",
    "rollback_verifies_exact_prestate_hash_not_target_hash",
    "activation_postcheck_requires_derived_target_hashes",
    "rollback_overlay_reconstructs_exact_live_prestate_without_target_command",
    "predecessor_references_are_exact_image_bound",
    "semantically_drifted_old_images_are_reconstructed_not_accepted",
    "exact_old_images_and_semantics_are_idempotently_accepted",
    "combined_failure_preserves_both_machine_identities_and_terminal_status",
    "rollback_health_requires_two_consecutive_stabilized_successes",
    "uninitialized_rollback_never_imports_historical_transition_state",
    "exact_observability_prestate_accepted",
    "historical_only_prestate_rejected_without_mutation",
    "mixed_and_wrong_identity_prestates_rejected_without_mutation",
    "forced_post_mutation_failure_restores_exact_observability_runtime",
    "rollback_self_check_audit_store_and_provenance_verified",
    "successor_retry_is_idempotent",
    "power_loss_guard_reconciliation_is_idempotent",
    "wrong_or_substituted_direct_rollback_deb_rejected",
    "payload_and_successor_identity_substitution_rejected",
    "owner_envelope_rejects_low_space_and_cleans_exact_staging",
    "installer_rejects_low_space_before_dpkg",
    "transition_scope_preserves_zero_argument_boundary",
)
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
NEW_DEB_NAME = "yoko-privileged-runtime_2.0.0-12_all.deb"
ROLLBACK_DEB_NAME = "yoko-privileged-runtime_2.0.0-10_all.deb"
PREDECESSOR_PACKAGE = {
    "name": "yoko-privileged-runtime",
    "version": "2.0.0-10",
    "profile_id": "crm-ae2082d852e3-gravity-source-v1",
    "source_commit": "ae2082d852e3f9c1b9dc774993955f65f5bd097d",
    "sha256": "9c23ae1ad93da8db9eee1111f6b177e6d32be48e6505a96b6d66dc2633febe6a",
    "payload_path": ROLLBACK_DEB_NAME,
    "store_path": "/var/lib/yoko-privileged-runtime/activation-bootstraps/9c23ae1ad93da8db9eee1111f6b177e6d32be48e6505a96b6d66dc2633febe6a/yoko-privileged-runtime_2.0.0-10_all.deb",
}
PREDECESSOR_REVIEW_IDENTITY = {
    "package_version": "2.0.0-10",
    "profile_id": "crm-ae2082d852e3-gravity-source-v1",
    "source_commit": "ae2082d852e3f9c1b9dc774993955f65f5bd097d",
    "source_tree": "0053965a53e434f5d0c56e80abfec2ab2c9b15c0",
    "runtime_sha256": "44a49a00e98e1ca7315bab70e20e436432f38a3b2f4934259fa419c35138f5ba",
    "core_sha256": "0f97bafbfe5b430fa7994119b1fc76fead4bdbee26766c730d9e399551ebdffa",
    "observer_sha256": "b5ea36c50e12b0fe6c171896258ddfc00a9d2666778735cae6a9b2a8df6d4084",
    "profile_runtime_sha256": "ae69315dd38cd8d39ae9ea7947529aed7685d961de4524822a21fb6bb9ac114e",
    "policy_sha256": "8727373b0c6ec79c9abf82f1aaaa58abc2bae67e96aa96a602ac419f308db0e0",
    "install_manifest_sha256": "9ee1e7970b25d1944c58b5c6dff74e3ef8368bb389a29857e64750753aa8042a",
    "profile_manifest_sha256": "67615b6b20209c8bdcc96a4fbe4a02c6f78b58f5c96ac147e1311c7c6155c572",
    "profile_sha256": "f958936b7ac352ac9bee96fe602b8158caa7cdbcad92b0a9277605233aab2076",
    "migration_sha256": "433b0d503f054ed6a8161a059e2650d5e401829dabe8c9d992a1d1763eef0016",
    "source_archive_sha256": "f40e331dbb84609e6550ea060a1dd03041809c6418da5f4b9df39e6c630d9826",
    "sudoers_sha256": "3022dcfc323706da81e760255dd1ab43f9b8662ee699aa8b58fbe6e714cc69d7",
    "registry_sha256": "8ea5c3b7113e1dd2ad5a74b82a1fb0bf56643fd59774dccf37e8aa9eb67bd057",
    "rollback_deb_sha256": PREDECESSOR_PACKAGE["sha256"],
    "rollback_deb_payload_path": PREDECESSOR_PACKAGE["payload_path"],
    "rollback_deb_store_path": PREDECESSOR_PACKAGE["store_path"],
    "rollback_provenance_sha256": "3c9aaa7f9faaf445db691b7db034d3a2c4ac316b80c773a6679bd8020303e0be",
    "audit_state": "VALID",
    "audit_records": 36,
    "audit_last_digest": "7f7e4d739c9396c0d9757f0f2a60d57a50457048ce49cfd152ca46365306e344",
}
STREAM_CHUNK_BYTES = 1024 * 1024
MAX_BOOTSTRAP_DOCUMENT_BYTES = 4 * 1024 * 1024
FULL_AUTHORITATIVE_CI_TIMEOUT_SECONDS = 4 * 60 * 60
FRESH_WRITE_ANALYSIS_TIMEOUT_SECONDS = 15 * 60
DEFAULT_ATTACK_COMMAND_TIMEOUT_SECONDS = 5 * 60
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
    f"payload/{ROLLBACK_DEB_NAME}": 0o400,
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
        "direct_rollback_package": {
            "sha256": PREDECESSOR_PACKAGE["sha256"],
            "source_commit": PREDECESSOR_PACKAGE["source_commit"],
        },
        "bootstrap_tar": {"sha256": sha(tar_path), "bytes": tar_path.stat().st_size},
    }


def validate_bootstrap_member_size(
    name: str, member_size: int, exact_deb_size: int, exact_rollback_size: int | None = None,
) -> None:
    exact_sizes = {f"payload/{NEW_DEB_NAME}": exact_deb_size}
    if exact_rollback_size is not None:
        exact_sizes[f"payload/{ROLLBACK_DEB_NAME}"] = exact_rollback_size
    if name in exact_sizes:
        if member_size != exact_sizes[name]:
            raise SystemExit("bootstrap tar does not contain the exact Debian package")
        return
    maximum = MAX_BOOTSTRAP_DOCUMENT_BYTES
    if member_size < 0 or member_size > maximum:
        raise SystemExit("bootstrap tar member exceeded its exact bound")


def consume_bootstrap_member(
    source: Any, member_size: int, *, exact_path: Path | None = None, capture: bool = True,
) -> tuple[str, bytes | None]:
    digest = hashlib.sha256()
    captured = bytearray() if capture and exact_path is None else None
    total = 0
    try:
        expected = exact_path.open("rb") if exact_path is not None else None
        try:
            while total < member_size:
                chunk = source.read(min(STREAM_CHUNK_BYTES, member_size - total))
                if not chunk:
                    raise SystemExit("bootstrap tar member length is not exact")
                if expected is not None and chunk != expected.read(len(chunk)):
                    raise SystemExit("bootstrap tar does not contain the exact Debian package")
                digest.update(chunk)
                if captured is not None:
                    captured.extend(chunk)
                total += len(chunk)
            if source.read(1) or (expected is not None and expected.read(1)):
                message = (
                    "bootstrap tar does not contain the exact Debian package"
                    if expected is not None
                    else "bootstrap tar member length is not exact"
                )
                raise SystemExit(message)
        finally:
            if expected is not None:
                expected.close()
    except OSError as exc:
        raise SystemExit("bootstrap tar member is unavailable") from exc
    return digest.hexdigest(), bytes(captured) if captured is not None else None


def validate_bootstrap_tar(
    tar_path: Path, deb_path: Path, rollback_path: Path | None = None,
) -> str:
    rollback = rollback_path or ROOT / "inputs" / ROLLBACK_DEB_NAME
    try:
        exact_deb_size = deb_path.stat().st_size
        exact_rollback_size = rollback.stat().st_size
        with tarfile.open(tar_path, mode="r:") as archive:
            members = archive.getmembers()
            if (
                len(members) != len(BOOTSTRAP_MODES)
                or {member.name for member in members} != set(BOOTSTRAP_MODES)
            ):
                raise SystemExit("bootstrap tar inventory is not exact")
            material: list[dict[str, Any]] = []
            content: dict[str, bytes] = {}
            member_digests: dict[str, str] = {}
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
                    validate_bootstrap_member_size(
                        member.name, member.size, exact_deb_size, exact_rollback_size,
                    )
                    source = archive.extractfile(member)
                    if source is None:
                        raise SystemExit("bootstrap tar member is unavailable")
                    member_digest, raw = consume_bootstrap_member(
                        source,
                        member.size,
                        exact_path=(
                            deb_path if member.name == f"payload/{NEW_DEB_NAME}"
                            else rollback if member.name == f"payload/{ROLLBACK_DEB_NAME}"
                            else None
                        ),
                        capture=member.name not in {
                            f"payload/{NEW_DEB_NAME}", f"payload/{ROLLBACK_DEB_NAME}",
                        },
                    )
                    member_digests[member.name] = member_digest
                    if raw is not None:
                        content[member.name] = raw
                    identity["sha256"] = member_digest
                material.append(identity)
    except (OSError, tarfile.TarError) as exc:
        raise SystemExit("bootstrap tar is invalid") from exc

    exact_deb_sha256 = sha(deb_path)
    if member_digests[f"payload/{NEW_DEB_NAME}"] != exact_deb_sha256:
        raise SystemExit("bootstrap tar does not contain the exact Debian package")
    if member_digests[f"payload/{ROLLBACK_DEB_NAME}"] != PREDECESSOR_PACKAGE["sha256"]:
        raise SystemExit("bootstrap tar does not contain the exact direct rollback package")
    payload = parse_json_bytes(content["payload/payload-manifest.json"], "bootstrap payload manifest")
    review = parse_json_bytes(content["payload/review/package-manifest.json"], "bootstrap review manifest")
    payload_files = payload.get("files")
    new_package = review.get("new_package")
    previous_state = review.get("previous_state")
    if (
        payload.get("schema") != "yoko.crm.owner-bootstrap-payload.v1"
        or payload.get("previous_package") != PREDECESSOR_PACKAGE
        or type(payload_files) is not dict
        or set(payload_files) != {
            "install.sh", NEW_DEB_NAME, ROLLBACK_DEB_NAME,
            "review/human-manifest.md", "review/installation-procedure.md",
            "review/package-manifest.json", "review/rollback-analysis.md",
        }
        or review.get("schema") != "yoko.crm.owner-bootstrap-review-manifest.v3"
        or previous_state != PREDECESSOR_REVIEW_IDENTITY
        or type(new_package) is not dict
        or new_package.get("path") != NEW_DEB_NAME
        or new_package.get("sha256") != exact_deb_sha256
        or new_package.get("bytes") != exact_deb_size
        or new_package.get("name") != "yoko-privileged-runtime"
        or new_package.get("version") != "2.0.0-12"
        or new_package.get("runtime_abi") != "2.0.0"
        or new_package.get("architecture") != "all"
    ):
        raise SystemExit("bootstrap tar package/review manifests are not exact")
    for relative, recorded in payload_files.items():
        member_name = f"payload/{relative}"
        if (
            type(recorded) is not dict
            or set(recorded) != {"sha256", "mode"}
            or recorded["sha256"] != member_digests[member_name]
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
        timeout = FULL_AUTHORITATIVE_CI_TIMEOUT_SECONDS
    elif resolved[0].endswith("/analyze.mjs"):
        timeout = FRESH_WRITE_ANALYSIS_TIMEOUT_SECONDS
    else:
        timeout = DEFAULT_ATTACK_COMMAND_TIMEOUT_SECONDS
    try:
        completed = subprocess.run(
            [str(node), *resolved], cwd=repo, env=environment,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise SystemExit(
            f"internal attack reproduction timed out after {timeout}s: {arguments[0]}"
        ) from None
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


def transition_validator_identity() -> dict[str, object]:
    catalog = list(TRANSITION_TARGETED_TESTS)
    return {
        "schema": "yoko.crm.transition-identity-strategy-review-validator.v1",
        "path": TRANSITION_VALIDATOR_RELATIVE,
        "sha256": sha(ROOT / TRANSITION_VALIDATOR_RELATIVE),
        "tests": [
            {"path": path, "class": test_class, "sha256": sha(ROOT / path)}
            for path, test_class in TRANSITION_TESTS
        ],
        "inventory_validator_path": VALIDATOR_RELATIVE,
        "inventory_validator_sha256": sha(ROOT / VALIDATOR_RELATIVE),
        "catalog": catalog,
        "catalog_sha256": digest_bytes(canonical_bytes(catalog)),
    }


def transition_exact_bindings(source_repo: Path, seal_path: Path, tar_path: Path, deb_path: Path) -> dict[str, object]:
    seal = json.loads(seal_path.read_text(encoding="ascii"))
    if (
        type(seal) is not dict
        or seal.get("schema") != "yoko.crm.source-only-release-seal.v2"
        or seal.get("status") != "SEALED"
        or not isinstance(seal.get("commit"), str)
        or not SHA40.fullmatch(seal["commit"])
        or not isinstance(seal.get("tree"), str)
        or not SHA40.fullmatch(seal["tree"])
    ):
        raise SystemExit("bootstrap transition review requires an exact sealed release")
    if (
        git(source_repo, "rev-parse", "HEAD^{commit}") != seal["commit"]
        or git(source_repo, "rev-parse", "HEAD^{tree}") != seal["tree"]
        or git(source_repo, "status", "--porcelain", "--untracked-files=all")
    ):
        raise SystemExit("bootstrap transition review source is not the exact clean sealed checkout")
    for relative in (
        TRANSITION_VALIDATOR_RELATIVE,
        VALIDATOR_RELATIVE,
        *(path for path, _test_class in TRANSITION_TESTS),
    ):
        if sha(source_repo / RUNTIME_SOURCE_PREFIX / relative) != sha(ROOT / relative):
            raise SystemExit("bootstrap transition review source/validator binding mismatch")
    rollback = ROOT / "inputs" / ROLLBACK_DEB_NAME
    if sha(rollback) != PREDECESSOR_PACKAGE["sha256"]:
        raise SystemExit("direct rollback package identity mismatch")
    provenance = seal.get("direct_rollback_provenance")
    if (
        type(provenance) is not dict
        or set(provenance) != {
            "schema", "source_commit", "source_tree", "profile_id", "package",
            "prior_seal", "installed_identity", "direct_rollback",
            "historical_package_is_direct_rollback",
        }
        or provenance.get("schema") != "yoko.crm.direct-bootstrap-rollback-provenance.v2"
        or provenance.get("source_commit") != PREDECESSOR_PACKAGE["source_commit"]
        or provenance.get("source_tree") != PREDECESSOR_REVIEW_IDENTITY["source_tree"]
        or provenance.get("profile_id") != PREDECESSOR_PACKAGE["profile_id"]
        or provenance.get("package", {}).get("sha256") != PREDECESSOR_PACKAGE["sha256"]
        or provenance.get("prior_seal", {}).get("sha256") != PREDECESSOR_REVIEW_IDENTITY["rollback_provenance_sha256"]
        or provenance.get("installed_identity") != {
            "/etc/sudoers.d/92-yoko-privileged-runtime": PREDECESSOR_REVIEW_IDENTITY["sudoers_sha256"],
            "/usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py": PREDECESSOR_REVIEW_IDENTITY["core_sha256"],
            "/usr/local/libexec/yoko-privileged-runtime/crm-ae2082d852e3-gravity-source-v1.py": PREDECESSOR_REVIEW_IDENTITY["profile_runtime_sha256"],
            "/usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py": PREDECESSOR_REVIEW_IDENTITY["observer_sha256"],
            "/usr/local/sbin/yoko-privileged-runtime": PREDECESSOR_REVIEW_IDENTITY["runtime_sha256"],
            "/usr/local/share/yoko-privileged-runtime/install-manifest.v1.json": PREDECESSOR_REVIEW_IDENTITY["install_manifest_sha256"],
            "/usr/local/share/yoko-privileged-runtime/policy.v2.json": PREDECESSOR_REVIEW_IDENTITY["policy_sha256"],
            "/usr/local/share/yoko-privileged-runtime/profiles/crm-ae2082d852e3-gravity-source-v1/manifest.v1.json": PREDECESSOR_REVIEW_IDENTITY["profile_manifest_sha256"],
        }
        or provenance.get("direct_rollback") is not True
        or provenance.get("historical_package_is_direct_rollback") is not False
    ):
        raise SystemExit("seal does not bind the exact direct rollback provenance")
    inventory_sha256 = validate_bootstrap_tar(tar_path, deb_path, rollback)
    bindings = expected_bindings(seal, seal_path, tar_path, deb_path)
    bindings.update({
        "bootstrap_inventory_sha256": inventory_sha256,
        "direct_rollback_package": {
            "path": f"inputs/{ROLLBACK_DEB_NAME}",
            "sha256": PREDECESSOR_PACKAGE["sha256"],
            "bytes": rollback.stat().st_size,
            "source_commit": PREDECESSOR_PACKAGE["source_commit"],
        },
    })
    return bindings


def transition_run_targeted_tests(source_repo: Path) -> dict[str, object]:
    sources: dict[str, str] = {}
    for relative, test_class in TRANSITION_TESTS:
        completed = subprocess.run(
            ["/usr/bin/python3", "-I", "-B", str(ROOT / relative), test_class, "-q"],
            cwd=source_repo,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=20 * 60,
        )
        if completed.returncode != 0:
            sys.stderr.buffer.write(completed.stdout)
            sys.stderr.buffer.write(completed.stderr)
            raise SystemExit("bounded transition-identity strategy qualification failed")
        sources[relative] = sha(ROOT / relative)
    return {
        "status": "PASS",
        "count": len(TRANSITION_TARGETED_TESTS),
        "catalog": list(TRANSITION_TARGETED_TESTS),
        "catalog_sha256": digest_bytes(canonical_bytes(list(TRANSITION_TARGETED_TESTS))),
        "test_sources": sources,
    }


def transition_build_evidence(bindings: dict[str, object], qualification: dict[str, object]) -> dict[str, object]:
    return {
        "schema": TRANSITION_EVIDENCE_SCHEMA,
        "role": "BOUNDED_TRANSITION_IDENTITY_STRATEGY_EVIDENCE_ONLY",
        "scope": "TRANSITION_IDENTITY_STRATEGY_REPAIR",
        "bindings": bindings,
        "validator": transition_validator_identity(),
        "qualification": qualification,
        "reviewer_verdict": None,
        "owner_authorization": False,
        "production_mutation": False,
        "predecessor_acceptance_reopened": False,
        "full_replay_executed": False,
    }


def transition_read_review(path: Path) -> dict[str, Any]:
    return read_json(path, "independent bootstrap transition review")


def transition_validate_review(
    review: dict[str, Any], bindings: dict[str, object], qualification: dict[str, object],
) -> None:
    expected_keys = {
        "schema", "verdict", "reviewer_assertion", "reviewed_at", "separation_assertion",
        "scope", "bindings", "validator", "qualification", "residual_findings",
        "repository_mutated_by_reviewer", "production_mutated_by_reviewer",
        "predecessor_acceptance_reopened", "full_replay_executed",
    }
    reviewer = review.get("reviewer_assertion")
    reviewed_at = review.get("reviewed_at")
    if (
        set(review) != expected_keys
        or review.get("schema") != TRANSITION_REVIEW_SCHEMA
        or review.get("verdict") != "PASS"
        or not isinstance(reviewer, str)
        or not re.fullmatch(r"INDEPENDENT_[A-Z0-9_.:-]{3,120}", reviewer)
        or reviewer in {"INDEPENDENT_EXECUTOR", "INDEPENDENT_SELF_REVIEW"}
        or review.get("separation_assertion") != "NOT_THE_REPAIR_EXECUTOR_AND_NOT_THE_PREDECESSOR_REVIEWER"
        or review.get("scope") != "TRANSITION_IDENTITY_STRATEGY_REPAIR"
        or review.get("bindings") != bindings
        or review.get("validator") != transition_validator_identity()
        or review.get("qualification") != qualification
        or review.get("residual_findings") != []
        or review.get("repository_mutated_by_reviewer") is not False
        or review.get("production_mutated_by_reviewer") is not False
        or review.get("predecessor_acceptance_reopened") is not False
        or review.get("full_replay_executed") is not False
        or not isinstance(reviewed_at, str)
        or not UTC_SECOND.fullmatch(reviewed_at)
    ):
        raise SystemExit("independent bootstrap transition review is not exact")
    timestamp = datetime.strptime(reviewed_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    age = datetime.now(timezone.utc) - timestamp
    if age < -timedelta(minutes=5) or age > MAX_TRANSITION_REVIEW_AGE:
        raise SystemExit("independent bootstrap transition review is stale or future-dated")




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
    mode.add_argument("--bootstrap-review-evidence", action="store_true")
    mode.add_argument("--verify-bootstrap-review", action="store_true")
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
    if args.bootstrap_review_evidence or args.verify_bootstrap_review:
        if args.verify_bootstrap_review != (args.review_artifact is not None):
            raise SystemExit("--review-artifact is required only with --verify-bootstrap-review")
        bindings = transition_exact_bindings(repo, seal_path, tar_path, deb_path)
        qualification = transition_run_targeted_tests(repo)
        if args.bootstrap_review_evidence:
            print(json.dumps(
                transition_build_evidence(bindings, qualification),
                sort_keys=True, separators=(",", ":"),
            ))
            return
        assert args.review_artifact is not None
        review_path = args.review_artifact.resolve(strict=True)
        review_initial_sha256 = sha(review_path)
        review = transition_read_review(review_path)
        transition_validate_review(review, bindings, qualification)
        if sha(review_path) != review_initial_sha256:
            raise SystemExit("independent bootstrap transition review changed during verification")
        result = {
            "schema": TRANSITION_VERIFICATION_SCHEMA,
            "status": "PASS",
            "verdict": "PASS",
            "reviewer_assertion": review["reviewer_assertion"],
            "reviewed_at": review["reviewed_at"],
            "independent_review_artifact_sha256": review_initial_sha256,
            "sealed_release_sha256": bindings["sealed_release_sha256"],
            "bootstrap_tar_sha256": bindings["bootstrap_tar"]["sha256"],
            "debian_package_sha256": bindings["debian_package"]["sha256"],
            "direct_rollback_package_sha256": PREDECESSOR_PACKAGE["sha256"],
            "qualification": qualification,
            "scope": "TRANSITION_IDENTITY_STRATEGY_REPAIR",
            "predecessor_acceptance_reopened": False,
            "full_replay_executed": False,
        }
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return
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
