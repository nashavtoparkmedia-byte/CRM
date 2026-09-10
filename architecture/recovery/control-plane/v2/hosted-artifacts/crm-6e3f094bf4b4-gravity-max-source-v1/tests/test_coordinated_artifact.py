from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from io import BytesIO
from pathlib import Path


ROOT = Path(__file__).resolve().parents[7]
AUTHORITY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AUTHORITY))

import coordinated_release_contract as contract  # noqa: E402


def write_json(path: Path, value: object) -> None:
    path.write_bytes(contract.canonical_bytes(value))


def image_layer(
    *, application: Path, maximum: bool, empty: bool = False, include_forbidden: bool = False,
    tini_bytes: bytes = b"synthetic tini",
) -> bytes:
    layer = BytesIO()
    with tarfile.open(fileobj=layer, mode="w") as archive:
        def add_directory(name: str, *, uid: int = 0, gid: int = 0, mode: int = 0o755) -> None:
            info = tarfile.TarInfo(name)
            info.type = tarfile.DIRTYPE
            info.uid = uid
            info.gid = gid
            info.mode = mode
            archive.addfile(info)

        def add_file(name: str, raw: bytes, *, uid: int = 0, gid: int = 0, mode: int = 0o444) -> None:
            info = tarfile.TarInfo(name)
            info.size = len(raw)
            info.uid = uid
            info.gid = gid
            info.mode = mode
            archive.addfile(info, BytesIO(raw))

        if not empty:
            add_file("usr/bin/tini", tini_bytes)
        if not empty and maximum:
            source = application / "max-web-scraper"
            for relative in ("package.json", "package-lock.json", "index.js"):
                add_file(f"app/{relative}", (source / relative).read_bytes(), uid=1000, gid=1000)
            for directory in ("contacts", "lib", "media", "parser", "session", "sync", "transport"):
                for candidate in sorted((source / directory).rglob("*")):
                    if candidate.is_file():
                        add_file(
                            f"app/{candidate.relative_to(source).as_posix()}",
                            candidate.read_bytes(), uid=1000, gid=1000,
                        )
            add_file("app/node_modules/playwright/index.js", b"module.exports = {}\n", uid=1000, gid=1000)
            add_file("ms-playwright/chromium-1208/chrome-linux/chrome", b"synthetic chromium", mode=0o555)
            add_directory("app/user_data", uid=1000, gid=1000)
            if include_forbidden:
                add_file("app/maxBrowser.js", (source / "maxBrowser.js").read_bytes(), uid=1000, gid=1000)
        elif not empty:
            add_file("app/package.json", (application / "gravity-mvp/package.json").read_bytes(), uid=999, gid=999)
            for directory in ("app/.next", "app/node_modules", "app/prisma", "app/public"):
                add_directory(directory, uid=999, gid=999)
    return layer.getvalue()


def synthetic_base_layers(
    *, maximum: bool, root_marker_type: bytes = tarfile.DIRTYPE,
    duplicate_root_marker: bool = False,
) -> list[bytes]:
    count = 4 if maximum else 5
    result: list[bytes] = []
    for index in range(count):
        layer = BytesIO()
        with tarfile.open(fileobj=layer, mode="w") as archive:
            if index == 0:
                root = tarfile.TarInfo(".")
                root.type = root_marker_type
                root.mode = 0o755
                if root_marker_type == tarfile.REGTYPE:
                    raw = b"invalid root marker\n"
                    root.size = len(raw)
                    archive.addfile(root, BytesIO(raw))
                else:
                    archive.addfile(root)
                if duplicate_root_marker:
                    duplicate = tarfile.TarInfo(".")
                    duplicate.type = tarfile.DIRTYPE
                    duplicate.mode = 0o755
                    archive.addfile(duplicate)
            raw = f"synthetic base {maximum} {index}\n".encode()
            info = tarfile.TarInfo(f"synthetic-base/{index}.txt")
            info.size = len(raw)
            archive.addfile(info, BytesIO(raw))
        result.append(layer.getvalue())
    return result


def inspect_layer(layer: bytes) -> None:
    outer = BytesIO()
    with tarfile.open(fileobj=outer, mode="w") as archive:
        info = tarfile.TarInfo("layer.tar")
        info.size = len(layer)
        archive.addfile(info, BytesIO(layer))
    outer.seek(0)
    with tarfile.open(fileobj=outer, mode="r") as archive:
        contract.inspect_docker_layer(
            archive,
            archive.getmember("layer.tar"),
            f"sha256:{hashlib.sha256(layer).hexdigest()}",
            set(),
            {},
            {},
        )


def docker_archive(
    path: Path,
    reference: str,
    *,
    application: Path,
    maximum: bool,
    empty: bool = False,
    include_forbidden: bool = False,
    substitute_base: bool = False,
    tini_bytes: bytes = b"synthetic tini",
    oci_blob: bool = False,
    descriptor_size_delta: int = 0,
    substitute_blob_digest: bool = False,
    extra_blob: bool = False,
) -> tuple[str, str]:
    labels = {
        "org.opencontainers.image.revision": contract.APPLICATION_COMMIT,
        "yoko.activation.profile": contract.PROFILE,
    }
    runtime = {"Labels": labels}
    if maximum:
        runtime.update({
            "User": "pwuser",
            "WorkingDir": "/app",
            "Entrypoint": ["/usr/bin/tini", "--"],
            "Cmd": ["node", "index.js"],
            "Env": [
                "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "LANG=C.UTF-8",
                "LC_ALL=C.UTF-8",
                "NODE_ENV=production",
                "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
                "TZ=Europe/Moscow",
            ],
            "Healthcheck": {
                "Test": ["CMD-SHELL", 'pgrep -f "node.*index" >/dev/null || exit 1'],
                "Interval": 60_000_000_000,
                "Timeout": 10_000_000_000,
                "StartPeriod": 60_000_000_000,
                "Retries": 3,
            },
        })
    base_layers = synthetic_base_layers(maximum=maximum)
    if substitute_base:
        base_layers[0] = image_layer(application=application, maximum=False, empty=True) + b"substituted base"
    layers = base_layers + [
        image_layer(
            application=application, maximum=maximum, empty=empty, include_forbidden=include_forbidden,
            tini_bytes=tini_bytes,
        ),
    ]
    diff_ids = [f"sha256:{hashlib.sha256(layer).hexdigest()}" for layer in layers]
    layer_names = [
        f"blobs/sha256/{diff_id.removeprefix('sha256:')}" if oci_blob else f"layer-{index}/layer.tar"
        for index, diff_id in enumerate(diff_ids)
    ]
    if oci_blob and substitute_blob_digest:
        layer_names[0] = f"blobs/sha256/{'0' * 64}"
    config = contract.canonical_bytes({
        "architecture": "amd64",
        "os": "linux",
        "rootfs": {"type": "layers", "diff_ids": diff_ids},
        "config": runtime,
    })
    config_hash = hashlib.sha256(config).hexdigest()
    config_name = f"blobs/sha256/{config_hash}" if oci_blob else f"{config_hash}.json"
    if not oci_blob:
        manifest = contract.canonical_bytes([{
            "Config": config_name,
            "RepoTags": [reference],
            "Layers": layer_names,
        }])
        files = [
            ("manifest.json", manifest),
            (config_name, config),
            *zip(layer_names, layers, strict=True),
        ]
        containerd_image_id = f"sha256:{config_hash}"
        directories: tuple[str, ...] = ()
    else:
        layer_descriptors = [
            {
                "mediaType": "application/vnd.oci.image.layer.v1.tar",
                "digest": f"sha256:{layer_name.removeprefix('blobs/sha256/')}",
                "size": len(layer) + descriptor_size_delta,
            }
            for layer_name, layer in zip(layer_names, layers, strict=True)
        ]
        image_manifest = contract.canonical_bytes({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": f"sha256:{config_hash}",
                "size": len(config),
            },
            "layers": layer_descriptors,
        })
        image_manifest_hash = hashlib.sha256(image_manifest).hexdigest()
        image_manifest_name = f"blobs/sha256/{image_manifest_hash}"
        repository, tag = reference.rsplit(":", 1)
        index = contract.canonical_bytes({
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [{
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "digest": f"sha256:{image_manifest_hash}",
                "size": len(image_manifest),
                "annotations": {
                    "io.containerd.image.name": f"docker.io/{reference}",
                    "org.opencontainers.image.ref.name": tag,
                },
            }],
        })
        layer_sources = {
            descriptor["digest"]: descriptor
            for descriptor in layer_descriptors
        }
        manifest = contract.canonical_bytes([{
            "Config": config_name,
            "RepoTags": [reference],
            "Layers": layer_names,
            "LayerSources": layer_sources,
        }])
        legacy_files: list[tuple[str, bytes]] = []
        parent_id: str | None = None
        for index_value in range(len(layers)):
            row_id = hashlib.sha256(f"legacy-layer-{index_value}".encode("ascii")).hexdigest()
            row: dict[str, object] = {
                "id": row_id,
                "created": "2026-09-01T00:00:00Z",
                "container_config": {},
                "os": "linux",
            }
            if parent_id is not None:
                row["parent"] = parent_id
            if index_value == len(layers) - 1:
                row.update({"architecture": "amd64", "config": {"Labels": labels}})
            raw = contract.canonical_bytes(row)
            legacy_files.append((f"blobs/sha256/{hashlib.sha256(raw).hexdigest()}", raw))
            parent_id = row_id
        files = [
            ("manifest.json", manifest),
            ("repositories", contract.canonical_bytes({
                repository: {tag: layer_names[-1].removeprefix("blobs/sha256/")},
            })),
            ("index.json", index),
            ("oci-layout", contract.canonical_bytes({"imageLayoutVersion": "1.0.0"})),
            (config_name, config),
            (image_manifest_name, image_manifest),
            *zip(layer_names, layers, strict=True),
            *legacy_files,
        ]
        if extra_blob:
            raw = b"unbound content-addressed payload\n"
            files.append((f"blobs/sha256/{hashlib.sha256(raw).hexdigest()}", raw))
        containerd_image_id = f"sha256:{image_manifest_hash}"
        directories = ("blobs", "blobs/sha256")
    with tarfile.open(path, "w") as archive:
        for name in directories:
            info = tarfile.TarInfo(name)
            info.type = tarfile.DIRTYPE
            info.mode = 0o755
            archive.addfile(info)
        for name, raw in files:
            info = tarfile.TarInfo(name)
            info.size = len(raw)
            info.mode = 0o444
            archive.addfile(info, BytesIO(raw))
    return f"sha256:{config_hash}", containerd_image_id


def source_proof() -> dict[str, object]:
    return {
        "schema": "yoko.crm.authoritative-ci-execution-proof.v1",
        "outcome": "PASS",
        "source": {"commit": contract.APPLICATION_COMMIT, "tree": contract.APPLICATION_TREE},
        "workflow": {"path": contract.SOURCE_WORKFLOW_PATH, "sha256": contract.SOURCE_WORKFLOW_SHA256},
        "runner": {"path": contract.SOURCE_RUNNER_PATH, "sha256": contract.SOURCE_RUNNER_SHA256},
        "runtime": {"node": "20.20.2", "blast_base": "HEAD^", "blast_base_commit": contract.APPLICATION_PARENT},
        "controls": {
            "count": 52,
            "catalog_sha256": contract.SOURCE_CONTROL_ID_SHA256,
            "semantic_catalog_sha256": contract.SOURCE_CONTROL_SEMANTIC_SHA256,
            "executions": [{"id": value, "status": "PASS"} for value in contract.CONTROL_IDS],
        },
    }


class CoordinatedArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.original_material_authorities = (
            contract.GRAVITY_NODE_DIFF_IDS,
            contract.PLAYWRIGHT_DIFF_IDS,
            contract.TINI_BINARY_SHA256,
            contract.TINI_BINARY_BYTES,
        )
        gravity_layers = synthetic_base_layers(maximum=False)
        maximum_layers = synthetic_base_layers(maximum=True)
        contract.GRAVITY_NODE_DIFF_IDS = tuple(f"sha256:{hashlib.sha256(layer).hexdigest()}" for layer in gravity_layers)
        contract.PLAYWRIGHT_DIFF_IDS = tuple(f"sha256:{hashlib.sha256(layer).hexdigest()}" for layer in maximum_layers)
        contract.TINI_BINARY_SHA256 = hashlib.sha256(b"synthetic tini").hexdigest()
        contract.TINI_BINARY_BYTES = len(b"synthetic tini")
        cls.temporary = tempfile.TemporaryDirectory()
        cls.base = Path(cls.temporary.name)
        cls.builder = cls.base / "builder"
        cls.application = cls.base / "application"
        subprocess.run(["git", "clone", "--quiet", "--shared", str(ROOT), str(cls.builder)], check=True)
        subprocess.run(["git", "-C", str(cls.builder), "checkout", "--quiet", "--detach", "HEAD"], check=True)
        subprocess.run(["git", "clone", "--quiet", "--shared", "--no-checkout", str(ROOT), str(cls.application)], check=True)
        subprocess.run(["git", "-C", str(cls.application), "checkout", "--quiet", "--detach", contract.APPLICATION_COMMIT], check=True)
        cls.builder_commit = subprocess.check_output(["git", "-C", str(cls.builder), "rev-parse", "HEAD"], text=True).strip()
        cls.builder_tree = subprocess.check_output(["git", "-C", str(cls.builder), "rev-parse", "HEAD^{tree}"], text=True).strip()

        cls.evidence = cls.base / "source-evidence"
        cls.evidence.mkdir()
        write_json(cls.evidence / contract.SOURCE_PROOF, source_proof())
        write_json(cls.evidence / "run.json", {
            "id": contract.SOURCE_RUN_ID,
            "workflow_id": contract.SOURCE_WORKFLOW_ID,
            "head_sha": contract.APPLICATION_COMMIT,
            "run_attempt": 1,
            "event": "push",
            "status": "completed",
            "conclusion": "success",
            "path": contract.SOURCE_WORKFLOW_PATH,
        })
        write_json(cls.evidence / "jobs.json", {"jobs": [{
            "id": contract.SOURCE_ARCHITECTURE_JOB_ID,
            "name": "architecture",
            "run_id": contract.SOURCE_RUN_ID,
            "head_sha": contract.APPLICATION_COMMIT,
            "status": "completed",
            "conclusion": "success",
        }]})
        write_json(cls.evidence / "artifact.json", {
            "id": contract.SOURCE_PROOF_ARTIFACT_ID,
            "name": contract.SOURCE_PROOF_ARTIFACT_NAME,
            "size_in_bytes": contract.SOURCE_PROOF_ARTIFACT_BYTES,
            "digest": f"sha256:{contract.SOURCE_PROOF_ARTIFACT_SHA256}",
            "expired": False,
            "workflow_run": {"id": contract.SOURCE_RUN_ID, "head_sha": contract.APPLICATION_COMMIT},
        })
        cls.probe = cls.base / "max-runtime-probe.json"
        write_json(cls.probe, {
            "schema": "yoko.crm.max-release-runtime-probe.v1",
            "uid": 1000,
            "gid": 1000,
            "cwd": "/app",
            "index_sha256": contract.MAX_INDEX_SHA256,
            "package_lock_sha256": contract.MAX_LOCK_SHA256,
            "tini_version": "tini version 0.19.0",
            "browser_executable": "/ms-playwright/chromium-1208/chrome-linux/chrome",
            "browser_version": "Chromium 145.0.7632.6",
            "playwright_module": "/app/node_modules/playwright/index.js",
            "browser_launch": "PASS",
            "user_data": {
                "path": "/app/user_data",
                "type": "directory",
                "uid": 1000,
                "gid": 1000,
                "mode": "0755",
                "writable_by_runtime_identity": True,
                "entries": [],
            },
            "forbidden_paths_present": [],
            "environment": {"NODE_ENV": "production", "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright", "TZ": "Europe/Moscow"},
        })

        cls.artifact = cls.base / "artifact"
        cls.artifact.mkdir()
        docker_archive(
            cls.artifact / contract.GRAVITY_ARCHIVE,
            contract.expected_image_reference("gravity", cls.builder_commit),
            application=cls.application,
            maximum=False,
        )
        docker_archive(
            cls.artifact / contract.MAX_ARCHIVE,
            contract.expected_image_reference("max-scraper", cls.builder_commit),
            application=cls.application,
            maximum=True,
        )
        cls.run_emitter(cls.artifact)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()
        (
            contract.GRAVITY_NODE_DIFF_IDS,
            contract.PLAYWRIGHT_DIFF_IDS,
            contract.TINI_BINARY_SHA256,
            contract.TINI_BINARY_BYTES,
        ) = cls.original_material_authorities

    @classmethod
    def run_emitter(cls, artifact: Path) -> None:
        contract.exact_directory(artifact, (contract.GRAVITY_ARCHIVE, contract.MAX_ARCHIVE), "pre-attestation artifact")
        contract.validate_application_source(cls.application)
        builder = contract.builder_identity(cls.builder, cls.builder_commit, cls.builder_tree)
        source_authority, proof_bytes = contract.validate_source_authority(cls.evidence)
        probe = contract.validate_max_probe(json.loads(cls.probe.read_text()))
        gravity_files, gravity_directories, gravity_forbidden, gravity_base = contract.gravity_rootfs_contract(cls.application)
        max_files, max_directories, max_forbidden, max_base = contract.max_rootfs_contract(cls.application, probe)
        gravity_archive = contract.docker_archive_identity(
            artifact / contract.GRAVITY_ARCHIVE,
            contract.expected_image_reference("gravity", cls.builder_commit),
            required_files=gravity_files,
            required_directories=gravity_directories,
            required_diff_id_prefix=gravity_base,
            forbidden_paths=gravity_forbidden,
        )
        max_archive = contract.docker_archive_identity(
            artifact / contract.MAX_ARCHIVE,
            contract.expected_image_reference("max-scraper", cls.builder_commit),
            required_files=max_files,
            required_directories=max_directories,
            required_diff_id_prefix=max_base,
            forbidden_paths=max_forbidden,
        )
        contract.validate_max_runtime_config(max_archive["runtime"])
        gravity = contract.component_attestation(
            "gravity", builder, contract.GRAVITY_ARCHIVE, gravity_archive,
            contract.gravity_materials(cls.application),
        )
        maximum = contract.component_attestation(
            "max-scraper", builder, contract.MAX_ARCHIVE, max_archive,
            contract.max_materials(cls.application, cls.builder, probe),
        )
        gravity_bytes = contract.canonical_bytes(gravity)
        maximum_bytes = contract.canonical_bytes(maximum)
        manifest = contract.coordinated_manifest(
            builder, source_authority, gravity, gravity_bytes, maximum, maximum_bytes,
        )
        (artifact / contract.SOURCE_PROOF).write_bytes(proof_bytes)
        (artifact / contract.GRAVITY_ATTESTATION).write_bytes(gravity_bytes)
        (artifact / contract.MAX_ATTESTATION).write_bytes(maximum_bytes)
        (artifact / contract.MANIFEST).write_bytes(contract.canonical_bytes(manifest))

    def verify(self, artifact: Path, *, builder_commit: str | None = None, builder_tree: str | None = None) -> subprocess.CompletedProcess[str]:
        try:
            value = contract.verify_artifact(
                artifact, self.application, self.builder, self.evidence,
                builder_commit or self.builder_commit,
                builder_tree or self.builder_tree,
            )
            return subprocess.CompletedProcess([], 0, json.dumps(value), "")
        except (contract.ContractError, OSError, ValueError) as exc:
            return subprocess.CompletedProcess([], 1, "", str(exc))

    def mutated(self) -> Path:
        target = Path(tempfile.mkdtemp(dir=self.base)) / "artifact"
        shutil.copytree(self.artifact, target)
        for member in target.iterdir():
            member.chmod(0o644)
        return target

    def mutate_json(self, artifact: Path, name: str, mutation) -> None:
        path = artifact / name
        value = json.loads(path.read_text())
        mutation(value)
        write_json(path, value)

    def assert_rejected(self, artifact: Path, **kwargs) -> None:
        result = self.verify(artifact, **kwargs)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def assert_max_archive_rejected(self, path: Path) -> None:
        with self.assertRaises(contract.ContractError):
            self.max_archive_identity(path)

    def max_archive_identity(self, path: Path) -> dict[str, object]:
        probe = contract.validate_max_probe(json.loads(self.probe.read_text()))
        files, directories, forbidden, base = contract.max_rootfs_contract(self.application, probe)
        return contract.docker_archive_identity(
            path,
            contract.expected_image_reference("max-scraper", self.builder_commit),
            required_files=files,
            required_directories=directories,
            required_diff_id_prefix=base,
            forbidden_paths=forbidden,
        )

    def rewrite_manifest(self, path: Path, mutation) -> None:
        entries: list[tuple[tarfile.TarInfo, bytes | None]] = []
        with tarfile.open(path, "r") as archive:
            for member in archive.getmembers():
                raw = archive.extractfile(member).read() if member.isfile() else None
                if member.name == "manifest.json" and raw is not None:
                    value = json.loads(raw)
                    mutation(value)
                    raw = contract.canonical_bytes(value)
                    member.size = len(raw)
                entries.append((member, raw))
        with tarfile.open(path, "w") as archive:
            for member, raw in entries:
                archive.addfile(member, BytesIO(raw) if raw is not None else None)

    def test_positive_exact_artifact(self) -> None:
        result = self.verify(self.artifact)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        verified = json.loads(result.stdout)
        self.assertEqual(verified["status"], "PASS")
        self.assertEqual(verified["gravity_image_id"], verified["gravity_containerd_image_id"])
        self.assertEqual(verified["max_image_id"], verified["max_containerd_image_id"])

    def test_oci_blob_artifact_binds_both_runtime_image_identities_end_to_end(self) -> None:
        artifact = self.mutated()
        for name in contract.ARTIFACT_MEMBERS:
            if name not in (contract.GRAVITY_ARCHIVE, contract.MAX_ARCHIVE):
                (artifact / name).unlink()
        gravity_ids = docker_archive(
            artifact / contract.GRAVITY_ARCHIVE,
            contract.expected_image_reference("gravity", self.builder_commit),
            application=self.application,
            maximum=False,
            oci_blob=True,
        )
        maximum_ids = docker_archive(
            artifact / contract.MAX_ARCHIVE,
            contract.expected_image_reference("max-scraper", self.builder_commit),
            application=self.application,
            maximum=True,
            oci_blob=True,
        )
        self.run_emitter(artifact)
        result = self.verify(artifact)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        verified = json.loads(result.stdout)
        self.assertEqual(
            (verified["gravity_image_id"], verified["gravity_containerd_image_id"]),
            gravity_ids,
        )
        self.assertEqual(
            (verified["max_image_id"], verified["max_containerd_image_id"]),
            maximum_ids,
        )
        gravity_attestation = json.loads((artifact / contract.GRAVITY_ATTESTATION).read_text())
        maximum_attestation = json.loads((artifact / contract.MAX_ATTESTATION).read_text())
        manifest = json.loads((artifact / contract.MANIFEST).read_text())
        self.assertEqual(
            gravity_attestation["image"],
            {
                "reference": contract.expected_image_reference("gravity", self.builder_commit),
                "id": gravity_ids[0],
                "containerd_image_id": gravity_ids[1],
            },
        )
        self.assertEqual(
            maximum_attestation["image"],
            {
                "reference": contract.expected_image_reference("max-scraper", self.builder_commit),
                "id": maximum_ids[0],
                "containerd_image_id": maximum_ids[1],
            },
        )
        self.assertEqual(manifest["components"]["gravity"]["containerd_image_id"], gravity_ids[1])
        self.assertEqual(manifest["components"]["max_scraper"]["containerd_image_id"], maximum_ids[1])

    def test_oci_blob_docker_archive_is_fully_validated(self) -> None:
        path = self.base / "oci-blob-max-image.tar"
        image_id, containerd_image_id = docker_archive(
            path,
            contract.expected_image_reference("max-scraper", self.builder_commit),
            application=self.application,
            maximum=True,
            oci_blob=True,
        )
        identity = self.max_archive_identity(path)
        self.assertEqual(identity["image_id"], image_id)
        self.assertEqual(identity["containerd_image_id"], containerd_image_id)

    def test_canonical_layer_root_marker_accepted(self) -> None:
        inspect_layer(synthetic_base_layers(maximum=True)[0])

    def test_outer_archive_unsafe_path_errors_are_exact_and_terminal_safe(self) -> None:
        cases = {
            "/absolute": '(absolute): "/absolute"',
            "name\\with-control\n": '(backslash): "name\\\\with-control\\n"',
            "./.": '(root alias): "./."',
            "safe/../escape": '(parent traversal): "safe/../escape"',
        }
        for name, expected in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(contract.ContractError) as caught:
                    contract.safe_tar_name(name, "Docker archive")
                self.assertIn(expected, str(caught.exception))

    def test_linux_layer_literal_backslash_filename_accepted(self) -> None:
        layer = BytesIO()
        with tarfile.open(fileobj=layer, mode="w") as archive:
            entry = tarfile.TarInfo(r"usr/lib/systemd/system/system-systemd\x2dcryptsetup.slice")
            archive.addfile(entry, BytesIO())
        inspect_layer(layer.getvalue())

    def test_linux_layer_traversal_remains_rejected(self) -> None:
        layer = BytesIO()
        with tarfile.open(fileobj=layer, mode="w") as archive:
            entry = tarfile.TarInfo("safe/../escape")
            archive.addfile(entry, BytesIO())
        with self.assertRaisesRegex(contract.ContractError, "parent traversal"):
            inspect_layer(layer.getvalue())

    def test_non_directory_layer_root_marker_rejected(self) -> None:
        layer = synthetic_base_layers(maximum=True, root_marker_type=tarfile.REGTYPE)[0]
        with self.assertRaisesRegex(contract.ContractError, "invalid root directory marker"):
            inspect_layer(layer)

    def test_duplicate_layer_root_marker_rejected(self) -> None:
        layer = synthetic_base_layers(maximum=True, duplicate_root_marker=True)[0]
        with self.assertRaisesRegex(contract.ContractError, "invalid root directory marker"):
            inspect_layer(layer)

    def test_oci_blob_layer_descriptor_drift_rejected(self) -> None:
        path = self.base / "oci-layer-descriptor-drift.tar"
        docker_archive(
            path,
            contract.expected_image_reference("max-scraper", self.builder_commit),
            application=self.application,
            maximum=True,
            oci_blob=True,
            descriptor_size_delta=1,
        )
        self.assert_max_archive_rejected(path)

    def test_oci_blob_content_digest_substitution_rejected(self) -> None:
        path = self.base / "oci-layer-content-digest-substitution.tar"
        docker_archive(
            path,
            contract.expected_image_reference("max-scraper", self.builder_commit),
            application=self.application,
            maximum=True,
            oci_blob=True,
            substitute_blob_digest=True,
        )
        self.assert_max_archive_rejected(path)

    def test_oci_blob_unbound_content_rejected(self) -> None:
        path = self.base / "oci-unbound-content.tar"
        docker_archive(
            path,
            contract.expected_image_reference("max-scraper", self.builder_commit),
            application=self.application,
            maximum=True,
            oci_blob=True,
            extra_blob=True,
        )
        self.assert_max_archive_rejected(path)

    def test_unknown_docker_manifest_field_rejected(self) -> None:
        path = self.base / "unknown-manifest-field.tar"
        shutil.copy2(self.artifact / contract.MAX_ARCHIVE, path)
        self.rewrite_manifest(path, lambda value: value[0].update(Unexpected="rejected"))
        self.assert_max_archive_rejected(path)

    def test_valid_utf8_github_metadata_is_accepted_fail_closed(self) -> None:
        utf8 = '{"display_title":"Merge repair-…"}'.encode("utf-8")
        escaped = b'{"display_title":"Merge repair-\\u2026"}'
        self.assertEqual(
            contract.strict_json_bytes(utf8, "UTF-8 JSON"),
            contract.strict_json_bytes(escaped, "escaped ASCII JSON"),
        )

        run_path = self.evidence / "run.json"
        original = run_path.read_bytes()
        value = json.loads(original)
        value["display_title"] = "Merge pull request from repair-main-…"
        run_path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        try:
            source_authority, _ = contract.validate_source_authority(self.evidence)
            self.assertEqual(source_authority["run"]["id"], contract.SOURCE_RUN_ID)
        finally:
            run_path.write_bytes(original)

        with self.assertRaises(contract.ContractError):
            contract.strict_json_bytes(b'{"display_title":"\xe2"}', "invalid UTF-8")
        with self.assertRaises(contract.ContractError):
            contract.strict_json_bytes(
                '{"display_title":"…","display_title":"duplicate"}'.encode("utf-8"),
                "duplicate UTF-8 JSON",
            )

    def test_empty_max_image_rootfs_rejected(self) -> None:
        path = self.base / "empty-max-image.tar"
        docker_archive(
            path,
            contract.expected_image_reference("max-scraper", self.builder_commit),
            application=self.application,
            maximum=True,
            empty=True,
        )
        self.assert_max_archive_rejected(path)

    def test_substituted_playwright_base_layer_chain_rejected(self) -> None:
        path = self.base / "substituted-playwright-base.tar"
        docker_archive(
            path,
            contract.expected_image_reference("max-scraper", self.builder_commit),
            application=self.application,
            maximum=True,
            substitute_base=True,
        )
        self.assert_max_archive_rejected(path)

    def test_substituted_tini_binary_rejected(self) -> None:
        path = self.base / "substituted-tini.tar"
        docker_archive(
            path,
            contract.expected_image_reference("max-scraper", self.builder_commit),
            application=self.application,
            maximum=True,
            tini_bytes=b"not the pinned Tini binary",
        )
        self.assert_max_archive_rejected(path)

    def test_legacy_max_browser_capability_rejected(self) -> None:
        path = self.base / "forbidden-max-browser.tar"
        docker_archive(
            path,
            contract.expected_image_reference("max-scraper", self.builder_commit),
            application=self.application,
            maximum=True,
            include_forbidden=True,
        )
        self.assert_max_archive_rejected(path)

    def test_inner_unreferenced_archive_member_rejected(self) -> None:
        path = self.base / "extra-inner-member.tar"
        shutil.copy2(self.artifact / contract.MAX_ARCHIVE, path)
        with tarfile.open(path, "a") as archive:
            raw = b"not referenced\n"
            info = tarfile.TarInfo("unexpected.txt")
            info.size = len(raw)
            archive.addfile(info, BytesIO(raw))
        self.assert_max_archive_rejected(path)

    def test_inner_special_archive_member_rejected(self) -> None:
        path = self.base / "special-inner-member.tar"
        shutil.copy2(self.artifact / contract.MAX_ARCHIVE, path)
        with tarfile.open(path, "a") as archive:
            info = tarfile.TarInfo("unsafe-link")
            info.type = tarfile.SYMTYPE
            info.linkname = "manifest.json"
            archive.addfile(info)
        self.assert_max_archive_rejected(path)

    def test_missing_referenced_layer_rejected(self) -> None:
        path = self.base / "missing-layer.tar"
        shutil.copy2(self.artifact / contract.MAX_ARCHIVE, path)
        self.rewrite_manifest(path, lambda value: value[0].update(Layers=["missing/layer.tar"]))
        self.assert_max_archive_rejected(path)

    def test_unsafe_referenced_layer_path_rejected(self) -> None:
        path = self.base / "unsafe-layer.tar"
        shutil.copy2(self.artifact / contract.MAX_ARCHIVE, path)
        self.rewrite_manifest(path, lambda value: value[0].update(Layers=["../layer.tar"]))
        self.assert_max_archive_rejected(path)

    def test_extra_archive_member_rejected(self) -> None:
        artifact = self.mutated()
        (artifact / "unexpected.txt").write_text("no\n")
        self.assert_rejected(artifact)

    def test_wrong_builder_commit_rejected(self) -> None:
        self.assert_rejected(self.artifact, builder_commit="0" * 40)

    def test_wrong_builder_tree_rejected(self) -> None:
        self.assert_rejected(self.artifact, builder_tree="0" * 40)

    def test_wrong_application_tree_rejected(self) -> None:
        artifact = self.mutated()
        self.mutate_json(artifact, contract.MANIFEST, lambda value: value["application"].update(tree="0" * 40))
        self.assert_rejected(artifact)

    def test_wrong_component_subtree_rejected(self) -> None:
        artifact = self.mutated()
        self.mutate_json(artifact, contract.MAX_ATTESTATION, lambda value: value["application"].update(component_subtree="0" * 40))
        self.assert_rejected(artifact)

    def test_wrong_profile_label_rejected(self) -> None:
        artifact = self.mutated()
        self.mutate_json(artifact, contract.MAX_ATTESTATION, lambda value: value["labels"].update({"yoko.activation.profile": "wrong"}))
        self.assert_rejected(artifact)

    def test_mismatched_component_revision_rejected(self) -> None:
        artifact = self.mutated()
        self.mutate_json(artifact, contract.MAX_ATTESTATION, lambda value: value["application"].update(commit="0" * 40))
        self.assert_rejected(artifact)

    def test_wrong_docker_archive_digest_rejected(self) -> None:
        artifact = self.mutated()
        self.mutate_json(artifact, contract.MANIFEST, lambda value: value["components"]["gravity"]["docker_archive"].update(sha256="0" * 64))
        self.assert_rejected(artifact)

    def test_component_attestations_from_different_builder_rejected(self) -> None:
        artifact = self.mutated()
        self.mutate_json(artifact, contract.MAX_ATTESTATION, lambda value: value["builder"].update(commit="0" * 40))
        self.assert_rejected(artifact)

    def test_changed_workflow_authority_rejected(self) -> None:
        artifact = self.mutated()
        self.mutate_json(artifact, contract.MANIFEST, lambda value: value["builder"]["workflow"].update(sha256="0" * 64))
        self.assert_rejected(artifact)

    def test_secret_or_material_mutation_rejected(self) -> None:
        artifact = self.mutated()
        self.mutate_json(artifact, contract.MAX_ATTESTATION, lambda value: value["materials"]["tini_package"].update(sha256="0" * 64))
        self.assert_rejected(artifact)

    def test_max_runtime_semantic_mutation_rejected(self) -> None:
        artifact = self.mutated()
        self.mutate_json(artifact, contract.MAX_ATTESTATION, lambda value: value["materials"]["runtime_contract"].update(uid=0))
        self.assert_rejected(artifact)

    def test_max_browser_launch_failure_rejected(self) -> None:
        artifact = self.mutated()
        self.mutate_json(
            artifact,
            contract.MAX_ATTESTATION,
            lambda value: value["materials"]["runtime_contract"].update(browser_launch="FAIL"),
        )
        self.assert_rejected(artifact)

    def test_max_user_data_ownership_failure_rejected(self) -> None:
        artifact = self.mutated()
        self.mutate_json(
            artifact,
            contract.MAX_ATTESTATION,
            lambda value: value["materials"]["runtime_contract"]["user_data"].update(uid=0),
        )
        self.assert_rejected(artifact)

    def test_duplicate_json_key_rejected(self) -> None:
        artifact = self.mutated()
        path = artifact / contract.MANIFEST
        raw = path.read_text()
        path.write_text('{"schema":"duplicate",' + raw[1:])
        self.assert_rejected(artifact)

    def test_malformed_or_extra_authority_field_rejected(self) -> None:
        artifact = self.mutated()
        self.mutate_json(artifact, contract.MANIFEST, lambda value: value["source_authority"].update(unreviewed=True))
        self.assert_rejected(artifact)


if __name__ == "__main__":
    unittest.main()
