#!/usr/bin/python3
"""Seal one already accepted, clean, source-only commit into Runtime 2.0.0-10."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import importlib.machinery
import importlib.util
import json
import os
import re
import stat
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_SOURCE_PREFIX = "architecture/recovery/control-plane/v2/owner-bootstrap/crm-external-rereview-source-only-v10"
PREDECESSOR_COMMIT = "7aea2823efe50e13a156540993d424594025e403"
PREDECESSOR_IMAGE = "sha256:baf442f880ebca808897a0131a662c603a9119f652cbbc3e47937286dec49179"
TG_BOT_PREDECESSOR_IMAGE = "sha256:0849c4c9912aecf3cb7c35b51abba22cdb1c85a385afa6c2746000d14b9835f6"
TG_BOT_PATCH_PATH = "tg-bot/src/public-bot-maintenance.js"
TG_BOT_PATCH_DESTINATION = "/app/src/public-bot-maintenance.js"
TG_BOT_PATCH_SHA256 = "d31a95451e148423ce8ad0dad0b78d4d7a487f428d5103a05bd3fed4c454c247"
TG_BOT_BASELINE_SHA256 = "22bdb3fd236f04abdd9a2e825b2340339e92664ec94b36d582004d0d6756ed97"
SHA40 = re.compile(r"[0-9a-f]{40}")
SHA64 = re.compile(r"[0-9a-f]{64}")
GITHUB_REPOSITORY = "nashavtoparkmedia-byte/CRM"
AUTHORITATIVE_WORKFLOW_PATH = ".github/workflows/architecture-enforcement.yml"
AUTHORITATIVE_RUNNER_PATH = "tools/architecture/run-authoritative-ci.mjs"
MIGRATION_AUTHORITY_PATH = "architecture/migrations/v1/production-migration-authority.json"
AUTHORITATIVE_CHECK_NAME = "architecture"
GRAVITY_JOB_NAME = "gravity-artifact"
GRAVITY_ARTIFACT_ATTESTATION = "gravity-image-attestation.json"
GRAVITY_DOCKER_ARCHIVE = "gravity-image.docker.tar"
AUTHORITATIVE_CI_EXECUTION_PROOF = "authoritative-ci-execution.json"
GRAVITY_FRONTEND = "docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e"
GRAVITY_NODE_BASE = "node:20-bookworm-slim@sha256:3d0f05455dea2c82e2f76e7e2543964c30f6b7d673fc1a83286736d44fe4c41c"
GRAVITY_DEBIAN_SNAPSHOT = "20260801T000000Z"
GRAVITY_BUILDX_VERSION = "v0.30.1"
GRAVITY_BUILDKIT_IMAGE = "moby/buildkit:v0.25.2@sha256:72bda77240181301a0d5ee57d39fa58e4aabd7eff26f81bbf108088caf810f05"
GRAVITY_BUILD_ARGS = {
    "NEXT_PUBLIC_AVITO_LEADS_URL": "",
    "NEXT_PUBLIC_MAX_SCRAPER_PHONE": "+79221853150",
    "NEXT_PUBLIC_FORCE_SHOW_ALL_CHANNELS": "true",
}
AUTHORITATIVE_CONTROL_SEMANTIC_CATALOG_SHA256 = "2ea7e4740c626347bda39b50c925eba62e46ba7daf8867e2e629f3ace07f1cf0"
AUTHORITATIVE_CONTROL_CATALOG = (
    "authoritative-ci-inventory",
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
    "whole-repository-write-scan",
    "fresh-write-verification",
    "fresh-migration-write-site-authorizations",
    "whole-repository-credential-inventory",
    "fresh-credential-verification",
)


def run(repo: Path, *args: str, binary: bool = False) -> bytes | str:
    value = subprocess.run(
        ["/usr/bin/git", "-C", str(repo), *args], check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180,
    ).stdout
    return value if binary else value.decode("utf-8").strip()


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def exact_object(value: object, keys: set[str], label: str) -> dict[str, object]:
    if type(value) is not dict or set(value) != keys:
        raise SystemExit(f"invalid exact-key {label}")
    return value


def positive_github_id(value: object, label: str) -> int:
    if type(value) is not int or value < 1:
        raise SystemExit(f"invalid hosted GitHub {label}")
    return value


def authoritative_control_catalog_sha256() -> str:
    encoded = (json.dumps(
        list(AUTHORITATIVE_CONTROL_CATALOG), separators=(",", ":"),
    ) + "\n").encode("ascii")
    return sha(encoded)


def github_api(path: str) -> object:
    request = urllib.request.Request(
        f"https://api.github.com/repos/{GITHUB_REPOSITORY}/{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "yoko-runtime-v10-sealer",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status != 200:
                raise SystemExit("GitHub API did not return 200")
            raw = response.read(16 * 1024 * 1024 + 1)
    except (OSError, urllib.error.HTTPError, urllib.error.URLError) as exc:
        raise SystemExit("live public GitHub API verification failed") from exc
    if len(raw) > 16 * 1024 * 1024:
        raise SystemExit("GitHub API response exceeded bound")
    return strict_json_bytes(raw, "GitHub API response")


def validate_hosted_ci_attestation(
    value: object,
    commit: str,
    tree: str,
    workflow_bytes: bytes,
    runner_bytes: bytes,
    github_run: object | None = None,
    github_jobs: object | None = None,
    github_artifact: object | None = None,
) -> dict[str, object]:
    attestation = exact_object(value, {
        "schema", "provider", "repository", "source", "workflow", "runner",
        "run", "check", "jobs", "artifact", "controls",
    }, "hosted CI attestation")
    if (
        attestation["schema"] != "yoko.crm.hosted-authoritative-ci-attestation.v1"
        or attestation["provider"] != "github-actions"
        or attestation["repository"] != GITHUB_REPOSITORY
    ):
        raise SystemExit("hosted CI provider or repository identity mismatch")

    source = exact_object(attestation["source"], {"commit", "tree"}, "hosted CI source identity")
    if source != {"commit": commit, "tree": tree}:
        raise SystemExit("hosted CI attestation targets a different commit or tree")

    workflow = exact_object(attestation["workflow"], {"path", "sha256"}, "hosted CI workflow identity")
    if (
        workflow["path"] != AUTHORITATIVE_WORKFLOW_PATH
        or not isinstance(workflow["sha256"], str)
        or not SHA64.fullmatch(workflow["sha256"])
        or workflow["sha256"] != sha(workflow_bytes)
    ):
        raise SystemExit("hosted CI workflow path or accepted-commit SHA-256 mismatch")

    runner = exact_object(attestation["runner"], {"path", "sha256"}, "authoritative CI runner identity")
    if (
        runner["path"] != AUTHORITATIVE_RUNNER_PATH
        or not isinstance(runner["sha256"], str)
        or not SHA64.fullmatch(runner["sha256"])
        or runner["sha256"] != sha(runner_bytes)
    ):
        raise SystemExit("authoritative CI runner path or accepted-commit SHA-256 mismatch")

    run_identity = exact_object(attestation["run"], {
        "id", "attempt", "url", "head_sha", "conclusion",
    }, "hosted GitHub run identity")
    run_id = positive_github_id(run_identity["id"], "run id")
    run_attempt = positive_github_id(run_identity["attempt"], "run attempt")
    expected_run_url = f"https://github.com/{GITHUB_REPOSITORY}/actions/runs/{run_id}"
    if (
        run_identity["url"] != expected_run_url
        or run_identity["head_sha"] != commit
        or run_identity["conclusion"] != "success"
    ):
        raise SystemExit("hosted GitHub run URL, head SHA, or conclusion mismatch")

    check_identity = exact_object(attestation["check"], {
        "id", "name", "url", "head_sha", "conclusion",
    }, "hosted GitHub check identity")
    positive_github_id(check_identity["id"], "check job id")

    jobs = attestation["jobs"]
    if type(jobs) is not list or len(jobs) != 2:
        raise SystemExit("hosted GitHub jobs identity is not exact")
    expected_job_names = (AUTHORITATIVE_CHECK_NAME, GRAVITY_JOB_NAME)
    accepted_job_ids: list[int] = []
    for index, expected_name in enumerate(expected_job_names):
        job = exact_object(jobs[index], {
            "id", "name", "url", "head_sha", "status", "conclusion",
        }, f"hosted GitHub {expected_name} job")
        job_id = positive_github_id(job["id"], f"{expected_name} job id")
        accepted_job_ids.append(job_id)
        if job != {
            "id": job_id,
            "name": expected_name,
            "url": f"https://github.com/{GITHUB_REPOSITORY}/actions/runs/{run_id}/job/{job_id}",
            "head_sha": commit,
            "status": "completed",
            "conclusion": "success",
        }:
            raise SystemExit("hosted GitHub job identity, head SHA, or conclusion mismatch")
    if check_identity != {
        "id": accepted_job_ids[0],
        "name": AUTHORITATIVE_CHECK_NAME,
        "url": jobs[0]["url"],
        "head_sha": commit,
        "conclusion": "success",
    }:
        raise SystemExit("hosted GitHub check is not the exact architecture job")

    artifact = exact_object(attestation["artifact"], {
        "id", "name", "url", "expired", "size_in_bytes", "digest",
        "workflow_run_id", "head_sha",
    }, "hosted GitHub Gravity artifact")
    artifact_id = positive_github_id(artifact["id"], "artifact id")
    artifact_size = positive_github_id(artifact["size_in_bytes"], "artifact size")
    expected_artifact_name = f"gravity-image-{commit}"
    if (
        artifact["name"] != expected_artifact_name
        or artifact["url"] != f"https://github.com/{GITHUB_REPOSITORY}/actions/runs/{run_id}/artifacts/{artifact_id}"
        or artifact["expired"] is not False
        or artifact_size < 1024
        or not isinstance(artifact["digest"], str)
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", artifact["digest"])
        or artifact["workflow_run_id"] != run_id
        or artifact["head_sha"] != commit
    ):
        raise SystemExit("hosted GitHub Gravity artifact identity mismatch")

    if github_run is not None or github_jobs is not None or github_artifact is not None:
        live_run = exact_object(github_run, set(github_run) if type(github_run) is dict else set(), "live GitHub run")
        if (
            live_run.get("id") != run_id
            or live_run.get("head_sha") != commit
            or live_run.get("run_attempt") != run_attempt
            or live_run.get("status") != "completed"
            or live_run.get("conclusion") != "success"
            or live_run.get("path") != AUTHORITATIVE_WORKFLOW_PATH
            or live_run.get("html_url") != f"https://github.com/{GITHUB_REPOSITORY}/actions/runs/{run_id}"
        ):
            raise SystemExit("live GitHub run does not match accepted hosted identity")
        if type(github_jobs) is not dict or type(github_jobs.get("jobs")) is not list:
            raise SystemExit("live GitHub jobs response invalid")
        live_jobs = {job.get("id"): job for job in github_jobs["jobs"] if type(job) is dict}
        for job_id, expected_name in zip(accepted_job_ids, expected_job_names):
            live_job = live_jobs.get(job_id)
            if (
                type(live_job) is not dict
                or live_job.get("name") != expected_name
                or live_job.get("head_sha") != commit
                or live_job.get("status") != "completed"
                or live_job.get("conclusion") != "success"
                or live_job.get("run_id") != run_id
                or live_job.get("html_url") != f"https://github.com/{GITHUB_REPOSITORY}/actions/runs/{run_id}/job/{job_id}"
            ):
                raise SystemExit("live GitHub job does not match accepted hosted identity")
        live_artifact = exact_object(
            github_artifact,
            set(github_artifact) if type(github_artifact) is dict else set(),
            "live GitHub artifact",
        )
        live_workflow_run = live_artifact.get("workflow_run")
        if (
            live_artifact.get("id") != artifact_id
            or live_artifact.get("name") != expected_artifact_name
            or live_artifact.get("expired") is not False
            or live_artifact.get("size_in_bytes") != artifact_size
            or live_artifact.get("digest") != artifact["digest"]
            or type(live_workflow_run) is not dict
            or live_workflow_run.get("id") != run_id
            or live_workflow_run.get("head_sha") != commit
        ):
            raise SystemExit("live GitHub artifact does not match accepted hosted identity")

    controls = exact_object(attestation["controls"], {
        "count", "catalog_sha256", "semantic_catalog_sha256", "catalog",
    }, "authoritative CI control catalog")
    expected_catalog = list(AUTHORITATIVE_CONTROL_CATALOG)
    expected_catalog_sha256 = authoritative_control_catalog_sha256()
    if (
        len(AUTHORITATIVE_CONTROL_CATALOG) != 52
        or type(controls["count"]) is not int
        or controls["count"] != 52
        or type(controls["catalog"]) is not list
        or controls["catalog"] != expected_catalog
        or controls["catalog_sha256"] != expected_catalog_sha256
        or controls["semantic_catalog_sha256"] != AUTHORITATIVE_CONTROL_SEMANTIC_CATALOG_SHA256
    ):
        raise SystemExit("hosted CI did not attest the exact full 52-control semantic catalog")
    return attestation


def strict_json_bytes(raw: bytes, label: str) -> object:
    def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key in {label}")
            result[key] = value
        return result
    try:
        return json.loads(raw.decode("ascii"), object_pairs_hook=reject_duplicate_keys)
    except (UnicodeError, ValueError) as exc:
        raise SystemExit(f"invalid {label}") from exc


def validate_ci_execution_proof(
    value: object,
    commit: str,
    tree: str,
    accepted_parent_commit: str,
    workflow_bytes: bytes,
    runner_bytes: bytes,
    accepted_controls: object,
) -> dict[str, object]:
    proof = exact_object(value, {
        "schema", "outcome", "source", "workflow", "runner", "runtime", "controls",
    }, "authoritative CI execution proof")
    if (
        proof["schema"] != "yoko.crm.authoritative-ci-execution-proof.v1"
        or proof["outcome"] != "PASS"
        or exact_object(proof["source"], {"commit", "tree"}, "CI proof source")
        != {"commit": commit, "tree": tree}
        or exact_object(proof["workflow"], {"path", "sha256"}, "CI proof workflow")
        != {"path": AUTHORITATIVE_WORKFLOW_PATH, "sha256": sha(workflow_bytes)}
        or exact_object(proof["runner"], {"path", "sha256"}, "CI proof runner")
        != {"path": AUTHORITATIVE_RUNNER_PATH, "sha256": sha(runner_bytes)}
        or exact_object(proof["runtime"], {"node", "blast_base", "blast_base_commit"}, "CI proof runtime")["node"]
        != "20.20.2"
        or proof["runtime"]["blast_base"] != "HEAD^"
        or proof["runtime"]["blast_base_commit"] != accepted_parent_commit
    ):
        raise SystemExit("runner-emitted CI proof source, code, runtime, or outcome mismatch")
    controls = exact_object(proof["controls"], {
        "count", "catalog_sha256", "semantic_catalog_sha256", "executions",
    }, "runner-emitted CI proof controls")
    accepted = exact_object(accepted_controls, {
        "count", "catalog_sha256", "semantic_catalog_sha256", "catalog",
    }, "accepted CI controls")
    expected_catalog = list(AUTHORITATIVE_CONTROL_CATALOG)
    expected_executions = [{"id": control, "status": "PASS"} for control in expected_catalog]
    if (
        controls["count"] != 52
        or controls["catalog_sha256"] != authoritative_control_catalog_sha256()
        or controls["semantic_catalog_sha256"] != AUTHORITATIVE_CONTROL_SEMANTIC_CATALOG_SHA256
        or controls["executions"] != expected_executions
        or accepted["count"] != controls["count"]
        or accepted["catalog"] != expected_catalog
        or accepted["catalog_sha256"] != controls["catalog_sha256"]
        or accepted["semantic_catalog_sha256"] != controls["semantic_catalog_sha256"]
    ):
        raise SystemExit("runner-emitted CI proof does not contain all exact 52 ordered PASS controls")
    return proof


def stream_identity(handle: object, maximum_bytes: int) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    while chunk := handle.read(1024 * 1024):  # type: ignore[attr-defined]
        if total + len(chunk) > maximum_bytes:
            raise SystemExit("stream exceeded its exact byte bound")
        digest.update(chunk)
        total += len(chunk)
    return digest.hexdigest(), total


def stream_identity_to(source: object, destination: object, maximum_bytes: int) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    while chunk := source.read(1024 * 1024):  # type: ignore[attr-defined]
        if total + len(chunk) > maximum_bytes:
            raise SystemExit("stream exceeded its exact byte bound")
        destination.write(chunk)  # type: ignore[attr-defined]
        digest.update(chunk)
        total += len(chunk)
    destination.flush()  # type: ignore[attr-defined]
    return digest.hexdigest(), total


def inspect_gravity_docker_archive(
    docker_archive: object,
    expected_image_reference: str,
    expected_image_id: str,
    commit: str,
    profile_id: str,
) -> None:
    docker_archive.seek(0)  # type: ignore[attr-defined]
    try:
        with tarfile.open(fileobj=docker_archive, mode="r:") as archive:
            members = archive.getmembers()
            names = [member.name for member in members]
            if len(names) != len(set(names)):
                raise SystemExit("Gravity docker archive contains duplicate members")
            for member in members:
                path = Path(member.name)
                if (
                    path.is_absolute()
                    or ".." in path.parts
                    or "\\" in member.name
                    or (not member.isfile() and not member.isdir())
                    or (member.isfile() and member.size < 1)
                    or (member.isdir() and member.size != 0)
                    or member.size > 4 * 1024 * 1024 * 1024
                ):
                    raise SystemExit("Gravity docker archive member invalid")
            if names.count("manifest.json") != 1:
                raise SystemExit("Gravity docker archive manifest missing")
            manifest_file = archive.extractfile("manifest.json")
            if manifest_file is None:
                raise SystemExit("Gravity docker archive manifest missing")
            manifest_bytes = manifest_file.read(1024 * 1024 + 1)
            if len(manifest_bytes) > 1024 * 1024:
                raise SystemExit("Gravity docker archive manifest exceeded bound")
            manifest = strict_json_bytes(manifest_bytes, "Gravity docker archive manifest")
            if type(manifest) is not list or len(manifest) != 1 or type(manifest[0]) is not dict:
                raise SystemExit("Gravity docker archive manifest invalid")
            entry = exact_object(manifest[0], {"Config", "RepoTags", "Layers"}, "Gravity docker archive manifest entry")
            config_name = entry["Config"]
            layers = entry["Layers"]
            if (
                not isinstance(config_name, str)
                or not re.fullmatch(r"[0-9a-f]{64}\.json", config_name)
                or type(layers) is not list
                or len(layers) < 1
                or len(layers) != len(set(layers))
                or any(
                    not isinstance(layer, str)
                    or not layer.endswith("/layer.tar")
                    or Path(layer).is_absolute()
                    or ".." in Path(layer).parts
                    or "\\" in layer
                    for layer in layers
                )
            ):
                raise SystemExit("Gravity docker archive layer inventory invalid")
            required_names = {"manifest.json", config_name, *layers}
            legacy_metadata = {"repositories"}
            layer_directories = set()
            for layer in layers:
                parent = layer.removesuffix("/layer.tar")
                layer_directories.add(parent)
                legacy_metadata.update({f"{parent}/VERSION", f"{parent}/json"})
            regular_names = {member.name for member in members if member.isfile()}
            directory_members = [member.name.rstrip("/") for member in members if member.isdir()]
            if (
                (regular_names != required_names and regular_names != required_names | legacy_metadata)
                or len(directory_members) != len(set(directory_members))
                or not set(directory_members).issubset(layer_directories)
            ):
                raise SystemExit("Gravity docker archive contains unbound members")
            config_file = archive.extractfile(config_name)
            if (
                config_file is None
                or entry["RepoTags"] != [expected_image_reference]
                or f"sha256:{config_name.removesuffix('.json')}" != expected_image_id
            ):
                raise SystemExit("Gravity docker archive image identity mismatch")
            config_bytes = config_file.read(16 * 1024 * 1024 + 1)
            if len(config_bytes) > 16 * 1024 * 1024 or f"sha256:{sha(config_bytes)}" != expected_image_id:
                raise SystemExit("Gravity docker archive config digest mismatch")
            config = strict_json_bytes(config_bytes, "Gravity docker archive config")
            rootfs = exact_object(config.get("rootfs"), {"type", "diff_ids"}, "Gravity docker archive rootfs")
            if (
                config.get("architecture") != "amd64"
                or config.get("os") != "linux"
                or rootfs["type"] != "layers"
                or type(rootfs["diff_ids"]) is not list
                or len(rootfs["diff_ids"]) != len(layers)
            ):
                raise SystemExit("Gravity docker archive rootfs inventory mismatch")
            for layer_name, expected_diff_id in zip(layers, rootfs["diff_ids"]):
                layer_file = archive.extractfile(layer_name)
                if layer_file is None:
                    raise SystemExit("Gravity docker archive layer missing")
                layer_size = archive.getmember(layer_name).size
                observed_sha256, observed_bytes = stream_identity(layer_file, layer_size)
                if observed_bytes != layer_size or expected_diff_id != f"sha256:{observed_sha256}":
                    raise SystemExit("Gravity docker archive layer digest mismatch")
            if regular_names == required_names | legacy_metadata:
                repository, tag = expected_image_reference.rsplit(":", 1)
                repositories_file = archive.extractfile("repositories")
                if repositories_file is None:
                    raise SystemExit("Gravity docker archive repository metadata missing")
                repositories = strict_json_bytes(
                    repositories_file.read(1024 * 1024 + 1),
                    "Gravity docker archive repository metadata",
                )
                if repositories != {repository: {tag: layers[-1].removesuffix("/layer.tar")}}:
                    raise SystemExit("Gravity docker archive repository metadata mismatch")
    except (KeyError, OSError, tarfile.TarError, UnicodeError, ValueError) as exc:
        raise SystemExit("Gravity docker archive invalid") from exc
    labels = (config.get("config") or {}).get("Labels") or {}
    if (
        labels.get("org.opencontainers.image.revision") != commit
        or labels.get("yoko.activation.profile") != profile_id
    ):
        raise SystemExit("Gravity docker archive immutable labels mismatch")


def install_stream_atomic(
    source: object,
    destination: Path,
    mode: int,
    expected_sha256: str,
    expected_bytes: int,
) -> None:
    temporary = destination.with_name(destination.name + ".new")
    temporary.unlink(missing_ok=True)
    installed = False
    try:
        source.seek(0)  # type: ignore[attr-defined]
        with temporary.open("xb") as output:
            observed_sha256, observed_bytes = stream_identity_to(
                source, output, expected_bytes,
            )
            if observed_sha256 != expected_sha256 or observed_bytes != expected_bytes:
                raise SystemExit("installed Gravity docker archive identity mismatch")
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, destination)
        installed = True
    finally:
        if not installed:
            temporary.unlink(missing_ok=True)


def inspect_gravity_artifact_zip(
    artifact_zip: Path,
    docker_archive_destination: Path,
    commit: str,
    tree: str,
    accepted_parent_commit: str,
    profile_id: str,
    accepted_artifact: object,
    dockerfile_bytes: bytes,
    package_lock_bytes: bytes,
    workflow_bytes: bytes,
    runner_bytes: bytes,
    accepted_controls: object,
) -> dict[str, object]:
    artifact = exact_object(accepted_artifact, {
        "id", "name", "url", "expired", "size_in_bytes", "digest",
        "workflow_run_id", "head_sha",
    }, "accepted Gravity artifact")
    maximum_artifact_bytes = 4 * 1024 * 1024 * 1024
    try:
        descriptor = os.open(artifact_zip, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    except OSError as exc:
        raise SystemExit("downloaded GitHub artifact is not a safe regular file") from exc
    try:
        with (
            os.fdopen(descriptor, "rb") as source,
            tempfile.TemporaryFile(mode="w+b") as artifact_copy,
            tempfile.TemporaryFile(mode="w+b") as docker_archive,
        ):
            value = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(value.st_mode)
                or value.st_nlink != 1
                or value.st_size != artifact["size_in_bytes"]
                or value.st_size > maximum_artifact_bytes
            ):
                raise SystemExit("downloaded GitHub artifact bytes do not match live metadata")
            artifact_sha256, artifact_bytes = stream_identity_to(
                source, artifact_copy, value.st_size,
            )
            if artifact_bytes != value.st_size or f"sha256:{artifact_sha256}" != artifact["digest"]:
                raise SystemExit("downloaded GitHub artifact bytes do not match live metadata")
            artifact_copy.seek(0)
            with zipfile.ZipFile(artifact_copy) as archive:
                members = archive.infolist()
                expected_zip_names = [
                    AUTHORITATIVE_CI_EXECUTION_PROOF,
                    GRAVITY_ARTIFACT_ATTESTATION,
                    GRAVITY_DOCKER_ARCHIVE,
                ]
                if (
                    len(members) != len(expected_zip_names)
                    or sorted(member.filename for member in members) != sorted(expected_zip_names)
                    or len({member.filename for member in members}) != len(expected_zip_names)
                ):
                    raise SystemExit("Gravity artifact ZIP inventory mismatch")
                by_name = {member.filename: member for member in members}
                for member in members:
                    path = Path(member.filename)
                    unix_type = (member.external_attr >> 16) & 0o170000
                    if (
                        path.is_absolute()
                        or ".." in path.parts
                        or "\\" in member.filename
                        or member.is_dir()
                        or member.flag_bits & 0x1
                        or member.compress_type != zipfile.ZIP_STORED
                        or member.compress_size != member.file_size
                        or (unix_type not in {0, stat.S_IFREG})
                        or member.file_size < 1
                        or member.file_size > maximum_artifact_bytes
                    ):
                        raise SystemExit("Gravity artifact ZIP member invalid")
                attestation_member = by_name[GRAVITY_ARTIFACT_ATTESTATION]
                if attestation_member.file_size > 1024 * 1024:
                    raise SystemExit("Gravity machine attestation exceeded bound")
                attestation_bytes = archive.read(attestation_member)
                ci_proof_member = by_name[AUTHORITATIVE_CI_EXECUTION_PROOF]
                if ci_proof_member.file_size > 1024 * 1024:
                    raise SystemExit("authoritative CI execution proof exceeded bound")
                ci_proof_bytes = archive.read(ci_proof_member)
                ci_proof = validate_ci_execution_proof(
                    strict_json_bytes(ci_proof_bytes, "authoritative CI execution proof"),
                    commit, tree, accepted_parent_commit, workflow_bytes, runner_bytes,
                    accepted_controls,
                )
                docker_member = by_name[GRAVITY_DOCKER_ARCHIVE]
                with archive.open(docker_member, "r") as reader:
                    docker_sha256, docker_bytes = stream_identity_to(
                        reader, docker_archive, docker_member.file_size,
                    )
                if docker_bytes != docker_member.file_size:
                    raise SystemExit("Gravity docker archive ZIP size mismatch")
            machine = strict_json_bytes(attestation_bytes, "Gravity machine attestation")
            machine = exact_object(machine, {
                "schema", "repository", "commit", "tree", "platform", "image_reference",
                "image_id", "docker_archive", "materials",
            }, "Gravity machine attestation")
            docker_identity = exact_object(machine["docker_archive"], {
                "path", "sha256", "bytes",
            }, "Gravity docker archive identity")
            materials = exact_object(machine["materials"], {
                "dockerfile_sha256", "package_lock_sha256", "dockerfile_frontend",
                "node_base", "debian_snapshot", "buildx_version", "buildkit_image", "build_args",
                "semantic_sha256",
            }, "Gravity build materials")
            semantic = dict(materials)
            semantic_digest = semantic.pop("semantic_sha256")
            expected_image_reference = f"yoko/crm-gravity-mvp:{commit}-source-only-v1"
            if (
                machine["schema"] != "yoko.crm.hosted-gravity-image-artifact.v1"
                or machine["repository"] != GITHUB_REPOSITORY
                or machine["commit"] != commit
                or machine["tree"] != tree
                or machine["platform"] != "linux/amd64"
                or machine["image_reference"] != expected_image_reference
                or not isinstance(machine["image_id"], str)
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", machine["image_id"])
                or docker_identity != {"path": GRAVITY_DOCKER_ARCHIVE, "sha256": docker_sha256, "bytes": docker_bytes}
                or materials["dockerfile_sha256"] != sha(dockerfile_bytes)
                or materials["package_lock_sha256"] != sha(package_lock_bytes)
                or materials["dockerfile_frontend"] != GRAVITY_FRONTEND
                or materials["node_base"] != GRAVITY_NODE_BASE
                or materials["debian_snapshot"] != GRAVITY_DEBIAN_SNAPSHOT
                or materials["buildx_version"] != GRAVITY_BUILDX_VERSION
                or materials["buildkit_image"] != GRAVITY_BUILDKIT_IMAGE
                or materials["build_args"] != GRAVITY_BUILD_ARGS
                or semantic_digest != sha((json.dumps(semantic, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii"))
            ):
                raise SystemExit("Gravity artifact source, image, or material provenance mismatch")
            inspect_gravity_docker_archive(
                docker_archive, expected_image_reference, machine["image_id"], commit, profile_id,
            )
            install_stream_atomic(
                docker_archive, docker_archive_destination, 0o400,
                docker_identity["sha256"], docker_identity["bytes"],
            )
    except (OSError, zipfile.BadZipFile, RuntimeError, UnicodeError, ValueError) as exc:
        raise SystemExit("Gravity artifact ZIP invalid") from exc
    return {
        "github_artifact": artifact,
        "zip_sha256": artifact["digest"].removeprefix("sha256:"),
        "zip_bytes": value.st_size,
        "machine_attestation_sha256": sha(attestation_bytes),
        "ci_execution_proof_sha256": sha(ci_proof_bytes),
        "ci_execution_proof_bytes": len(ci_proof_bytes),
        "docker_archive_sha256": docker_identity["sha256"],
        "docker_archive_bytes": docker_identity["bytes"],
        "image_id": machine["image_id"],
        "image_reference": machine["image_reference"],
        "platform": machine["platform"],
        "materials": materials,
    }


def validate_acceptance_record(
    accepted: object,
    commit: str,
    tree: str,
    workflow_bytes: bytes,
    runner_bytes: bytes,
    github_run: object | None = None,
    github_jobs: object | None = None,
    github_artifact: object | None = None,
) -> dict[str, object]:
    acceptance = exact_object(accepted, {
        "schema", "status", "commit", "tree", "authoritative_ci", "source_only",
        "migration_sql_change_from_7aea", "schema_sync_to_production_authority",
        "accepted_by", "accepted_at",
    }, "acceptance record")
    if (
        acceptance["schema"] != "yoko.crm.accepted-clean-release-commit.v2"
        or acceptance["status"] != "ACCEPTED"
        or acceptance["commit"] != commit
        or acceptance["tree"] != tree
        or acceptance["source_only"] is not True
        or acceptance["migration_sql_change_from_7aea"] is not False
        or acceptance["schema_sync_to_production_authority"] is not True
    ):
        raise SystemExit("acceptance record does not authorize this exact source-only commit")
    validate_hosted_ci_attestation(
        acceptance["authoritative_ci"], commit, tree, workflow_bytes, runner_bytes,
        github_run, github_jobs, github_artifact,
    )
    if (
        not isinstance(acceptance["accepted_by"], str)
        or not re.fullmatch(r"INDEPENDENT_[A-Z0-9_.:-]{3,120}", acceptance["accepted_by"])
        or acceptance["accepted_by"] == "INDEPENDENT_OFFLINE_TEST_FIXTURE"
        or not isinstance(acceptance["accepted_at"], str)
        or not re.fullmatch(r"20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", acceptance["accepted_at"])
    ):
        raise SystemExit("acceptance record lacks independent reviewer identity or UTC acceptance time")
    return acceptance


def git_blob(repo: Path, commit: str, path: str) -> bytes:
    return run(repo, "show", f"{commit}:{path}", binary=True)  # type: ignore[return-value]


def exact_accepted_commit_input(
    repo: Path,
    commit: str,
    repository_path: str,
    supplied_path: Path,
    label: str,
    *,
    maximum_bytes: int = 16 * 1024 * 1024,
) -> bytes:
    """Read one stable regular file and require exact accepted-commit bytes."""
    try:
        expected = git_blob(repo, commit, repository_path)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"accepted commit lacks exact {label} Git blob") from exc
    try:
        descriptor = os.open(supplied_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    except OSError as exc:
        raise SystemExit(f"unsafe supplied {label}") from exc
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size < 1
            or before.st_size > maximum_bytes
        ):
            raise SystemExit(f"unsafe supplied {label}")
        chunks: list[bytes] = []
        total = 0
        while chunk := os.read(descriptor, min(1024 * 1024, maximum_bytes + 1 - total)):
            chunks.append(chunk)
            total += len(chunk)
            if total > maximum_bytes:
                raise SystemExit(f"supplied {label} exceeded bound")
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    stable = ("st_dev", "st_ino", "st_mode", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
    if total != before.st_size or any(getattr(before, key) != getattr(after, key) for key in stable):
        raise SystemExit(f"supplied {label} changed while reading")
    supplied = b"".join(chunks)
    if supplied != expected:
        raise SystemExit(f"supplied {label} is not the exact accepted-commit Git blob")
    return supplied


def bind_builder_source(repo: Path, commit: str, builder_root: Path) -> dict[str, object]:
    """Require every tracked Runtime v10 source byte to come from the accepted commit.

    The release builder runs from a writable staging tree because sealing renders
    content-specific files.  That staging arrangement must not turn the builder,
    templates, validators, package scripts, or tests into an unreviewed authority.
    Bind the complete tracked subtree before any render or build output is written.
    Untracked hydrated inputs are admitted separately by exact SHA and cannot add
    executable package members.
    """
    raw = run(
        repo, "ls-tree", "-r", "-z", commit, "--", RUNTIME_SOURCE_PREFIX,
        binary=True,
    )
    assert isinstance(raw, bytes)
    rows: list[dict[str, object]] = []
    seen: set[str] = set()
    for record in raw.split(b"\0"):
        if not record:
            continue
        try:
            metadata, encoded_path = record.split(b"\t", 1)
            mode, kind, object_id = metadata.decode("ascii").split(" ")
            repository_path = encoded_path.decode("utf-8")
        except (UnicodeError, ValueError) as exc:
            raise SystemExit("accepted Runtime builder Git inventory is malformed") from exc
        prefix = RUNTIME_SOURCE_PREFIX + "/"
        if (
            kind != "blob"
            or mode not in {"100644", "100755"}
            or not repository_path.startswith(prefix)
            or repository_path in seen
        ):
            raise SystemExit("accepted Runtime builder Git inventory contains an unsafe entry")
        seen.add(repository_path)
        relative = repository_path.removeprefix(prefix)
        if not relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
            raise SystemExit("accepted Runtime builder Git path is unsafe")
        local = builder_root / relative
        try:
            value = local.lstat()
        except OSError as exc:
            raise SystemExit(f"accepted Runtime builder source missing: {relative}") from exc
        local_mode = stat.S_IMODE(value.st_mode)
        if (
            local.is_symlink()
            or not stat.S_ISREG(value.st_mode)
            or value.st_nlink != 1
            or bool(local_mode & 0o111) != (mode == "100755")
            or local_mode & 0o022
        ):
            raise SystemExit(f"accepted Runtime builder source metadata drift: {relative}")
        accepted_bytes = exact_accepted_commit_input(
            repo, commit, repository_path, local,
            f"Runtime builder source {relative}", maximum_bytes=256 * 1024 * 1024,
        )
        rows.append({
            "path": repository_path,
            "git_blob_sha1": object_id,
            "sha256": sha(accepted_bytes),
            "bytes": len(accepted_bytes),
            "mode": mode,
        })
    if not rows:
        raise SystemExit("accepted commit lacks the Runtime v10 builder subtree")
    tracked_relative = {
        str(item["path"]).removeprefix(RUNTIME_SOURCE_PREFIX + "/")
        for item in rows
    }
    admitted_hydrated_inputs = {"inputs/yoko-privileged-runtime_2.0.0-9_all.deb"}
    for local in builder_root.rglob("*"):
        relative = local.relative_to(builder_root).as_posix()
        value = local.lstat()
        if stat.S_ISDIR(value.st_mode):
            continue
        if (
            local.is_symlink()
            or not stat.S_ISREG(value.st_mode)
            or value.st_nlink != 1
            or relative not in tracked_relative | admitted_hydrated_inputs
        ):
            raise SystemExit(f"unaccepted Runtime builder staging entry: {relative}")
    rows.sort(key=lambda item: str(item["path"]))
    return {
        "prefix": RUNTIME_SOURCE_PREFIX,
        "file_count": len(rows),
        "inventory_sha256": sha(
            (json.dumps(rows, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")
        ),
        "files": rows,
    }


def archive(repo: Path, commit: str, prefix: str) -> tuple[bytes, dict[str, int]]:
    # BuildKit later receives `gravity-mvp/` as its build context.  Keep that
    # directory at the archive root while carrying the separately deployed
    # Telegram patch under its repository path.  A common commit prefix would
    # make the accepted archive unbuildable as captured by Runtime.
    raw = run(
        repo, "archive", "--format=tar", commit,
        "gravity-mvp", TG_BOT_PATCH_PATH, binary=True,
    )
    assert isinstance(raw, bytes)
    output = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0, compresslevel=9) as handle:
        handle.write(raw)
    compressed = output.getvalue()
    entries = files = directories = unpacked = 0
    with tarfile.open(fileobj=io.BytesIO(compressed), mode="r:gz") as handle:
        if handle.pax_headers.get("comment") != commit:
            raise SystemExit("git archive commit metadata missing")
        for member in handle.getmembers():
            entries += 1
            if member.isfile():
                files += 1
                unpacked += member.size
            elif member.isdir():
                directories += 1
            else:
                raise SystemExit(f"unsupported archive member: {member.name}")
            if not (member.name == "gravity-mvp" or member.name.startswith("gravity-mvp/") or member.name == "tg-bot" or member.name.startswith("tg-bot/")):
                raise SystemExit("archive root inventory mismatch")
    return compressed, {"entries": entries, "regular_files": files, "directories": directories, "uncompressed_bytes": unpacked}


def tg_bot_patch_recipe(commit: str, archive_sha256: str, profile_id: str) -> bytes:
    return (
        f"FROM {TG_BOT_PREDECESSOR_IMAGE}\n"
        f"LABEL org.opencontainers.image.revision=\"{commit}\"\n"
        f"LABEL yoko.activation.profile=\"{profile_id}\"\n"
        f"LABEL yoko.source.archive.sha256=\"{archive_sha256}\"\n"
        f"LABEL yoko.tg-bot.base-image=\"{TG_BOT_PREDECESSOR_IMAGE}\"\n"
        f"LABEL yoko.tg-bot.patch.path=\"{TG_BOT_PATCH_DESTINATION}\"\n"
        f"LABEL yoko.tg-bot.patch.sha256=\"{TG_BOT_PATCH_SHA256}\"\n"
        "COPY --chown=0:0 --chmod=0644 public-bot-maintenance.js /app/src/public-bot-maintenance.js\n"
    ).encode("ascii")


def load_exact(path: Path, keys: set[str]) -> dict[str, object]:
    value = strict_json_bytes(path.read_bytes(), str(path))
    if not isinstance(value, dict) or set(value) != keys:
        raise SystemExit(f"invalid exact-key document: {path}")
    return value


def render(template: Path, destination: Path, tokens: dict[str, str], mode: int) -> None:
    text = template.read_text(encoding="utf-8")
    for key, value in tokens.items():
        text = text.replace(f"@{key}@", value)
    unresolved = set(re.findall(r"@[A-Z0-9_]+@", text)) - {"@OVERLAY_MANIFEST_SHA256@"}
    if unresolved:
        raise SystemExit(f"unresolved template token: {template}")
    temporary = destination.with_suffix(destination.suffix + ".new")
    temporary.write_text(text, encoding="utf-8")
    os.chmod(temporary, mode)
    os.replace(temporary, destination)


def write_json_atomic(path: Path, value: object, mode: int) -> None:
    temporary = path.with_name(path.name + ".new")
    temporary.unlink(missing_ok=True)
    with temporary.open("xb") as handle:
        handle.write((json.dumps(value, indent=2, sort_keys=True) + "\n").encode("ascii"))
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def sealed_input_module() -> object:
    path = ROOT / "packaging/verify-sealed-inputs.py"
    loader = importlib.machinery.SourceFileLoader("yoko_runtime_v10_sealed_inputs", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    if spec is None:
        raise SystemExit("sealed-input verifier cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def production_capture_module() -> object:
    path = ROOT / "packaging/capture-production-snapshot.py"
    loader = importlib.machinery.SourceFileLoader("yoko_runtime_v10_production_capture", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    if spec is None:
        raise SystemExit("production capture verifier cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-repo", type=Path, required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--acceptance-record", type=Path, required=True)
    parser.add_argument("--production-snapshot", type=Path, required=True)
    parser.add_argument("--migration-authority", type=Path, required=True)
    parser.add_argument("--predecessor-attestation", type=Path, required=True)
    parser.add_argument("--gravity-artifact-zip", type=Path, required=True)
    args = parser.parse_args()
    repo = args.source_repo.resolve(strict=True)
    commit = str(run(repo, "rev-parse", f"{args.commit}^{{commit}}"))
    if not SHA40.fullmatch(commit) or commit == PREDECESSOR_COMMIT:
        raise SystemExit("final commit must be a new full SHA-1 commit")
    if run(repo, "rev-parse", "HEAD") != commit or run(repo, "status", "--porcelain", "--untracked-files=all"):
        raise SystemExit("source repository must be clean with HEAD at accepted commit")
    tree = str(run(repo, "rev-parse", f"{commit}^{{tree}}"))
    accepted_parent_commit = str(run(repo, "rev-parse", f"{commit}^"))
    if not SHA40.fullmatch(accepted_parent_commit):
        raise SystemExit("accepted commit parent is not a full SHA-1 commit")
    accepted_builder_source = bind_builder_source(repo, commit, ROOT)

    accepted_raw = strict_json_bytes(
        args.acceptance_record.resolve(strict=True).read_bytes(), "acceptance record",
    )
    workflow_bytes = git_blob(repo, commit, AUTHORITATIVE_WORKFLOW_PATH)
    runner_bytes = git_blob(repo, commit, AUTHORITATIVE_RUNNER_PATH)
    hosted = exact_object(accepted_raw.get("authoritative_ci") if type(accepted_raw) is dict else None, {
        "schema", "provider", "repository", "source", "workflow", "runner",
        "run", "check", "jobs", "artifact", "controls",
    }, "hosted CI attestation")
    hosted_run = exact_object(hosted["run"], {"id", "attempt", "url", "head_sha", "conclusion"}, "hosted run")
    hosted_artifact = exact_object(hosted["artifact"], {
        "id", "name", "url", "expired", "size_in_bytes", "digest", "workflow_run_id", "head_sha",
    }, "hosted artifact")
    run_id = positive_github_id(hosted_run["id"], "run id")
    artifact_id = positive_github_id(hosted_artifact["id"], "artifact id")
    live_run = github_api(f"actions/runs/{run_id}")
    live_jobs = github_api(f"actions/runs/{run_id}/attempts/{positive_github_id(hosted_run['attempt'], 'run attempt')}/jobs?per_page=100")
    live_artifact = github_api(f"actions/artifacts/{artifact_id}")
    accepted = validate_acceptance_record(
        accepted_raw, commit, tree, workflow_bytes, runner_bytes,
        github_run=live_run, github_jobs=live_jobs, github_artifact=live_artifact,
    )
    subprocess.run(["/usr/bin/git", "-C", str(repo), "diff", "--quiet", PREDECESSOR_COMMIT, commit, "--", "gravity-mvp/prisma/migrations"], check=True, timeout=60)

    capture_verifier = production_capture_module()
    try:
        snapshot_document = capture_verifier.load_snapshot(args.production_snapshot.resolve(strict=True))
        snapshot = capture_verifier.sealing_values(snapshot_document)
    except (OSError, ValueError) as exc:
        raise SystemExit(f"production snapshot transcript validation failed: {exc}") from exc
    if snapshot_document["schema"] != "yoko.crm.source-only-production-snapshot.v2" or snapshot_document["status"] != "ACCEPTED_READ_ONLY_CAPTURE" or snapshot_document["host"] != "jvxthcorvm" or snapshot["runtime_package_version"] != "2.0.0-9" or snapshot["runtime_abi"] != "2.0.0" or snapshot["profile_id"] != "crm-af9646f5-gravity-outbox-v1" or snapshot["audit_state"] != "VALID" or snapshot["audit_records"] != 19 or snapshot["audit_last_digest"] != "95668295b49045f430f19512d7cd60c81c88ae6e3586f26dd39fcf12a09f0c81" or snapshot["gravity_image_id"] != PREDECESSOR_IMAGE or snapshot["gravity_oci_revision"] != PREDECESSOR_COMMIT or snapshot["gravity_running"] is not True or snapshot["gravity_health"] != "healthy" or snapshot["gravity_restart_count"] != 0 or snapshot["tg_bot_image_id"] != TG_BOT_PREDECESSOR_IMAGE or snapshot["tg_bot_running"] is not True or snapshot["tg_bot_health"] != "healthy" or snapshot["tg_bot_restart_count"] != 0 or snapshot["tg_bot_entrypoint"] != ["/usr/bin/tini", "--", "/usr/local/bin/tg-bot-entrypoint"] or snapshot["tg_bot_cmd"] != ["node", "start.js"] or snapshot["tg_bot_declared_user"] != "" or snapshot["tg_bot_working_dir"] != "/app" or snapshot["tg_bot_patch_path"] != TG_BOT_PATCH_DESTINATION or snapshot["tg_bot_patch_sha256"] != TG_BOT_BASELINE_SHA256 or snapshot["tg_bot_patch_uid"] != 0 or snapshot["tg_bot_patch_gid"] != 0 or snapshot["tg_bot_patch_mode"] != "0644" or snapshot["tg_bot_patch_size"] != 2385 or snapshot["outbox_catalog_state"] != "EXACT" or snapshot["outbox_counts"] != {"dead_letter": 0, "over_attempt_limit": 0, "pending": 0, "processing": 0, "published": 4, "retry_wait": 0, "stale_claimed": 0, "total": 4} or snapshot["secret_values_emitted"] is not False or snapshot["production_mutated"] is not False:
        raise SystemExit("production snapshot is not the accepted 2.0.0-9 / 7aea / baf442 predecessor")
    for key in ("audit_last_digest", "source_manifest_sha256", "compose_sha256", "compose_config_hash", "gravity_container_id", "tg_bot_container_id", "tg_bot_compose_config_hash", "database_identity_sha256", "migration_ledger_sha256", "outbox_catalog_sha256"):
        if not SHA64.fullmatch(str(snapshot[key])):
            raise SystemExit(f"invalid production snapshot digest: {key}")
    for key in ("gravity_image_id", "tg_bot_image_id", "postgres_image_id"):
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(snapshot[key])):
            raise SystemExit(f"invalid production snapshot image identity: {key}")

    prefix = ""
    first, inventory = archive(repo, commit, prefix)
    second, repeated = archive(repo, commit, prefix)
    if first != second or inventory != repeated:
        raise SystemExit("source archive is not deterministic")
    profile_id = f"crm-{commit[:12]}-gravity-source-v1"
    dockerfile_bytes = git_blob(repo, commit, "gravity-mvp/Dockerfile")
    package_lock_bytes = git_blob(repo, commit, "gravity-mvp/package-lock.json")
    gravity_artifact = inspect_gravity_artifact_zip(
        args.gravity_artifact_zip.absolute(), ROOT / "inputs/gravity-image.docker.tar",
        commit, tree, accepted_parent_commit, profile_id,
        accepted["authoritative_ci"]["artifact"], dockerfile_bytes, package_lock_bytes,
        workflow_bytes, runner_bytes, accepted["authoritative_ci"]["controls"],
    )
    gravity_artifact["github_artifact"] = accepted["authoritative_ci"]["artifact"]
    tg_patch = git_blob(repo, commit, TG_BOT_PATCH_PATH)
    if sha(tg_patch) != TG_BOT_PATCH_SHA256:
        raise SystemExit("accepted Telegram capability patch identity mismatch")
    recipe = tg_bot_patch_recipe(commit, sha(first), profile_id)
    tokens = {"PROFILE_ID": profile_id, "FINAL_COMMIT": commit, "COMMIT_SHORT16": commit[:16]}
    render(ROOT / "templates/yoko-privileged-runtime.in", ROOT / "src/yoko-privileged-runtime", tokens, 0o755)
    render(ROOT / "templates/crm-activation-profile.py.in", ROOT / "src/crm-activation-profile.py", tokens, 0o444)
    render(ROOT / "templates/postinst.in", ROOT / "packaging/postinst", tokens, 0o755)
    render(ROOT / "templates/install.sh.in", ROOT / "bundle/payload/install.sh", tokens, 0o500)

    authority_bytes = exact_accepted_commit_input(
        repo,
        commit,
        MIGRATION_AUTHORITY_PATH,
        args.migration_authority,
        "production migration authority",
    )
    attestation_bytes = args.predecessor_attestation.resolve(strict=True).read_bytes()
    authority = strict_json_bytes(authority_bytes, "production migration authority")
    attestation = strict_json_bytes(attestation_bytes, "predecessor migration attestation")
    if authority.get("schema") != "yoko.crm.production-migration-authority.v1" or authority.get("version") != 1 or len(authority.get("migrations", [])) != 62 or authority.get("current_target") != {"name": "20260809140000_add_domain_outbox", "sha256": "433b0d503f054ed6a8161a059e2650d5e401829dabe8c9d992a1d1763eef0016"}:
        raise SystemExit("canonical production migration authority invalid")
    if sha(attestation_bytes) != "f08319ddfb0feb53a43b45c9e9865707d91c3a827c77cece6b42b8928e1b9a16" or attestation.get("schema") != "yoko.crm.predecessor-runtime-migration-inventory.v1" or attestation.get("version") != 1 or attestation.get("inventory_sha256") != "f07ca981e8acb53b48aacee882bce19473e0f33dafd07f716780ec192dd84c01" or attestation.get("provenance", {}).get("source_artifact_sha256") != "88b20e7a6ce3dfca3df6488f42331a5957494af3825265bb27b63c785d212bb3" or len(attestation.get("rows", [])) != 62:
        raise SystemExit("independent predecessor inventory identity invalid")
    attestation_rows = attestation["rows"]
    attestation_inventory_sha256 = sha((json.dumps(attestation_rows, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii"))
    if (
        attestation_inventory_sha256 != attestation["inventory_sha256"]
        or any(
            not isinstance(row, dict)
            or set(row) != {"name", "sha256", "size"}
            or not re.fullmatch(r"[0-9][A-Za-z0-9_-]{1,199}", str(row.get("name", "")))
            or not SHA64.fullmatch(str(row.get("sha256", "")))
            or isinstance(row.get("size"), bool)
            or not isinstance(row.get("size"), int)
            or row["size"] < 1
            for row in attestation_rows
        )
        or attestation_rows != sorted(attestation_rows, key=lambda row: row["name"])
    ):
        raise SystemExit("independent predecessor inventory rows are not exact hash-pinned authority")
    authority_rows = authority["migrations"]
    if any(row.get("canonical_ordinal") != index + 1 for index, row in enumerate(authority_rows)) or authority_rows != sorted(authority_rows, key=lambda row: row["name"]):
        raise SystemExit("canonical production migration order invalid")
    authority_names = [row["name"] for row in authority_rows]
    if len(set(authority_names)) != 62 or any(not re.fullmatch(r"[0-9][A-Za-z0-9_-]{1,199}", name) for name in authority_names):
        raise SystemExit("canonical production migration names invalid")
    canonical_inventory = [{"name": row["name"], "sha256": row["sha256"], "size": row["size"]} for row in sorted(authority_rows, key=lambda row: row["name"])]
    calculated_inventory_digest = sha((json.dumps(canonical_inventory, separators=(",", ":")) + "\n").encode("ascii"))
    if authority.get("inventory_digest") != calculated_inventory_digest or any(not SHA64.fullmatch(str(row["sha256"])) or isinstance(row["size"], bool) or not isinstance(row["size"], int) or row["size"] < 1 for row in authority_rows):
        raise SystemExit("canonical production migration inventory digest invalid")
    excluded_tg = authority["predecessor_runtime"]["excluded_separate_migration"]
    attested_map = {row["name"]: row["sha256"] for row in attestation_rows}
    if len(attested_map) != 62 or excluded_tg not in attested_map:
        raise SystemExit("independent predecessor inventory duplicate or TG exclusion missing")
    authority_predecessor = {row["name"]: row["sha256"] for row in authority_rows if row["name"] != authority["current_target"]["name"]}
    gravity_attested = dict(attested_map)
    gravity_attested.pop(excluded_tg)
    if gravity_attested != authority_predecessor:
        raise SystemExit("canonical authority does not cross-bind to independent predecessor inventory")
    # Runtime v9 exposed a hash-pinned finite predecessor inventory but not the
    # live Prisma timestamps. Preserve that source order exactly, remove the
    # physically separate TG-bot migration, and append the independently
    # accepted outbox target. This is an explicit semantic chronology authority;
    # timestamps remain live observation evidence and are never fabricated.
    accepted_live_chronology = [
        {"ordinal": index, "migration_name": row["name"], "checksum": row["sha256"]}
        for index, row in enumerate(
            [row for row in attestation_rows if row["name"] != excluded_tg]
            + [{"name": authority["current_target"]["name"], "sha256": authority["current_target"]["sha256"]}],
            1,
        )
    ]
    if (
        len(accepted_live_chronology) != 62
        or len({row["migration_name"] for row in accepted_live_chronology}) != 62
        or {row["migration_name"]: row["checksum"] for row in accepted_live_chronology}
        != {row["name"]: row["sha256"] for row in authority_rows}
    ):
        raise SystemExit("accepted live migration chronology does not cross-bind to canonical authority")
    live_chronology_sha256 = sha(json.dumps(accepted_live_chronology, sort_keys=True, separators=(",", ":")).encode("ascii"))
    if live_chronology_sha256 != "62aaa333a8df02cc9c255da14e8bb7ba70ed441098148846f1855c24623ac465":
        raise SystemExit("accepted live migration chronology authority drift")

    profile = strict_json_bytes(
        (ROOT / "templates/profile.v1.json.in").read_bytes(), "profile template",
    )
    profile["profile_id"] = profile_id
    source = profile["accepted_source"]
    source.update({"commit": commit, "tree": tree, "archive_sha256": sha(first), "archive_entries": inventory["entries"], "archive_regular_files": inventory["regular_files"], "archive_directories": inventory["directories"], "archive_prefix": prefix, "archive_uncompressed_bytes": inventory["uncompressed_bytes"], "dockerfile_sha256": sha(dockerfile_bytes), "package_lock_sha256": sha(package_lock_bytes), "prisma_schema_sha256": sha(git_blob(repo, commit, "gravity-mvp/prisma/schema.prisma")), "tg_bot_patch_sha256": sha(tg_patch), "tg_bot_patch_size": len(tg_patch), "tg_bot_patch_recipe_sha256": sha(recipe), "gravity_image_artifact": gravity_artifact})
    migration = profile["migration"]
    canonical = {row["name"]: row["sha256"] for row in authority_rows}
    if canonical.pop(migration["name"], None) != migration["sha256"]:
        raise SystemExit("exact outbox target authority is absent or changed")
    if len(canonical) != 61 or migration["name"] in canonical:
        raise SystemExit("canonical predecessor migration map must contain exactly 61 entries")
    migration["accepted_predecessor_map"] = dict(sorted(canonical.items()))
    migration["accepted_live_chronology"] = accepted_live_chronology
    migration["accepted_live_chronology_authority"] = {
        "kind": "PINNED_PREDECESSOR_ATTESTATION_ROW_ORDER_PLUS_CURRENT_TARGET",
        "predecessor_attestation_sha256": sha(attestation_bytes),
        "predecessor_attestation_inventory_sha256": attestation["inventory_sha256"],
        "separate_non_gravity_migration": excluded_tg,
        "current_target_appended": authority["current_target"]["name"],
        "sequence_sha256": live_chronology_sha256,
    }
    production = profile["production"]
    for key in ("source_manifest_sha256", "compose_sha256", "compose_config_hash", "gravity_container_id", "gravity_image_id", "tg_bot_container_id", "tg_bot_image_id", "tg_bot_compose_config_hash", "tg_bot_entrypoint", "tg_bot_cmd", "tg_bot_declared_user", "tg_bot_working_dir", "tg_bot_patch_uid", "tg_bot_patch_gid", "tg_bot_patch_mode", "tg_bot_patch_size", "postgres_container_id", "postgres_image_id"):
        production[key] = snapshot[key]
    recovery = profile["recovery"]
    recovery.update({"prior_compose_config_hash": snapshot["compose_config_hash"], "recovered_gravity_container_id": snapshot["gravity_container_id"], "recovered_compose_config_hash": snapshot["compose_config_hash"], "prior_tg_bot_image_id": snapshot["tg_bot_image_id"], "prior_tg_bot_compose_config_hash": snapshot["tg_bot_compose_config_hash"], "recovered_tg_bot_container_id": snapshot["tg_bot_container_id"], "recovered_tg_bot_compose_config_hash": snapshot["tg_bot_compose_config_hash"], "database_identity_sha256": snapshot["database_identity_sha256"], "migration_ledger_sha256": snapshot["migration_ledger_sha256"], "preview_outbox_catalog_sha256": snapshot["outbox_catalog_sha256"]})
    (ROOT / "inputs/source.tar.gz").write_bytes(first)
    os.chmod(ROOT / "inputs/source.tar.gz", 0o400)
    write_json_atomic(ROOT / "src/profile.v1.json", profile, 0o444)

    # Payload finalization tightens these three source documents to 0400. Set
    # their terminal mode before inventorying them so repeated deterministic
    # package/bootstrap builds cannot mutate a sealed input.
    for relative in (
        "bundle/payload/review/human-manifest.md",
        "bundle/payload/review/installation-procedure.md",
        "bundle/payload/review/rollback-analysis.md",
    ):
        os.chmod(ROOT / relative, 0o400)

    verifier = sealed_input_module()
    sealed_inputs = verifier.collect_inputs()
    sealed_inputs_sha256 = sha(verifier.canonical(sealed_inputs))
    sealed_input_document = {
        "schema": "yoko.crm.runtime-v10-sealed-inputs.v1",
        "profile_id": profile_id,
        "commit": commit,
        "tree": tree,
        "sealed_inputs_sha256": sealed_inputs_sha256,
        "files": sealed_inputs,
    }
    sealed_input_path = ROOT / "inputs/sealed-inputs.v1.json"
    sealed_input_temporary = sealed_input_path.with_name(sealed_input_path.name + ".new")
    sealed_input_temporary.unlink(missing_ok=True)
    with sealed_input_temporary.open("xb") as handle:
        handle.write(verifier.canonical(sealed_input_document))
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(sealed_input_temporary, 0o444)
    os.replace(sealed_input_temporary, sealed_input_path)

    sealed = {
        "schema": "yoko.crm.source-only-release-seal.v2",
        "status": "SEALING_BUILD_OUTPUTS",
        "package_version": "2.0.0-10",
        "runtime_abi": "2.0.0",
        "profile_id": profile_id,
        "commit": commit,
        "tree": tree,
        "accepted_builder_source": accepted_builder_source,
        "archive_sha256": sha(first),
        "archive_inventory": inventory,
        "acceptance_record_sha256": sha(args.acceptance_record.read_bytes()),
        "hosted_authoritative_ci": accepted["authoritative_ci"],
        "gravity_image_artifact": gravity_artifact,
        "production_snapshot_sha256": sha(args.production_snapshot.read_bytes()),
        "migration_authority_sha256": sha(authority_bytes),
        "predecessor_attestation_sha256": sha(attestation_bytes),
        "canonical_migration_inventory_digest": authority["inventory_digest"],
        "accepted_live_chronology_sha256": live_chronology_sha256,
        "accepted_live_chronology_authority": "PINNED_PREDECESSOR_ATTESTATION_ROW_ORDER_PLUS_CURRENT_TARGET",
        "predecessor_commit": PREDECESSOR_COMMIT,
        "predecessor_image_id": PREDECESSOR_IMAGE,
        "database_mutation_authorized": False,
        "sealed_inputs": sealed_inputs,
        "sealed_inputs_sha256": sealed_inputs_sha256,
        "built_artifacts": {"deb": None, "bootstrap_tar": None},
    }
    seal_path = ROOT / "SEALED_RELEASE.json"
    write_json_atomic(seal_path, sealed, 0o600)
    (ROOT / "dist").mkdir(mode=0o700, exist_ok=True)

    # First deterministic build derives output identities without making them
    # authoritative. The final seal is then written, followed by a second build
    # whose output must compare byte-for-byte with those sealed identities.
    for script in ("build-package.sh", "build-bootstrap-bundle.sh"):
        subprocess.run([str(ROOT / "packaging" / script)], check=True, timeout=1800)
    sealed["built_artifacts"] = {
        "deb": verifier.artifact_identity(ROOT / "dist/yoko-privileged-runtime_2.0.0-10_all.deb"),
        "bootstrap_tar": verifier.artifact_identity(ROOT / "dist/yoko-crm-source-only-runtime-2.0.0-10.tar"),
    }
    sealed["status"] = "SEALED"
    write_json_atomic(seal_path, sealed, 0o600)
    for script in ("build-package.sh", "build-bootstrap-bundle.sh"):
        subprocess.run([str(ROOT / "packaging" / script)], check=True, timeout=1800)
    subprocess.run(
        ["/usr/bin/python3", "-I", str(ROOT / "packaging/verify-sealed-inputs.py"), "--phase", "evidence"],
        check=True, stdout=subprocess.DEVNULL, timeout=300,
    )


if __name__ == "__main__":
    main()
