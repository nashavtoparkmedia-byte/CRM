#!/usr/bin/python3
from __future__ import annotations

import hashlib
import importlib.machinery
import importlib.util
import io
import json
import sys
import tarfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COMMIT = "c" * 40
PROFILE_ID = f"crm-{COMMIT[:12]}-gravity-source-v1"
IMAGE_REFERENCE = f"yoko/crm-gravity-mvp:{COMMIT}-source-only-v1"


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("ascii")


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def deterministic_tar(files: dict[str, bytes], directories: tuple[str, ...] = ()) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name in directories:
            member = tarfile.TarInfo(name)
            member.type = tarfile.DIRTYPE
            member.mode = 0o755
            member.uid = member.gid = 0
            archive.addfile(member)
        for name, value in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(value)
            member.mode = 0o644
            member.uid = member.gid = 0
            archive.addfile(member, io.BytesIO(value))
    return output.getvalue()


def load_sealer():
    loader = importlib.machinery.SourceFileLoader(
        "yoko_runtime_v10_docker_archive_formats", str(ROOT / "packaging/seal-release.py"),
    )
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    loader.exec_module(module)
    return module


def oci_blob_archive(*, descriptor_size_delta: int = 0, extra_blob: bool = False) -> tuple[bytes, str]:
    layer = deterministic_tar({"fixture.txt": b"hosted gravity layer\n"})
    layer_hex = digest(layer)
    layer_name = f"blobs/sha256/{layer_hex}"
    config = canonical({
        "architecture": "amd64",
        "os": "linux",
        "config": {"Labels": {
            "org.opencontainers.image.revision": COMMIT,
            "yoko.activation.profile": PROFILE_ID,
        }},
        "rootfs": {"type": "layers", "diff_ids": [f"sha256:{layer_hex}"]},
    })
    config_hex = digest(config)
    config_name = f"blobs/sha256/{config_hex}"
    layer_descriptor = {
        "mediaType": "application/vnd.oci.image.layer.v1.tar",
        "digest": f"sha256:{layer_hex}",
        "size": len(layer) + descriptor_size_delta,
    }
    image_manifest = canonical({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": {
            "mediaType": "application/vnd.oci.image.config.v1+json",
            "digest": f"sha256:{config_hex}",
            "size": len(config),
        },
        "layers": [layer_descriptor],
    })
    image_manifest_hex = digest(image_manifest)
    image_manifest_name = f"blobs/sha256/{image_manifest_hex}"
    _repository, tag = IMAGE_REFERENCE.rsplit(":", 1)
    index = canonical({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [{
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "digest": f"sha256:{image_manifest_hex}",
            "size": len(image_manifest),
            "annotations": {
                "io.containerd.image.name": f"docker.io/{IMAGE_REFERENCE}",
                "org.opencontainers.image.ref.name": tag,
            },
        }],
    })
    legacy_metadata = canonical({
        "id": "d" * 64,
        "created": "2026-08-15T00:00:00Z",
        "container_config": {},
        "config": {"Labels": {
            "org.opencontainers.image.revision": COMMIT,
            "yoko.activation.profile": PROFILE_ID,
        }},
        "architecture": "amd64",
        "os": "linux",
    })
    legacy_name = f"blobs/sha256/{digest(legacy_metadata)}"
    manifest = canonical([{
        "Config": config_name,
        "RepoTags": [IMAGE_REFERENCE],
        "Layers": [layer_name],
        "LayerSources": {f"sha256:{layer_hex}": layer_descriptor},
    }])
    files = {
        "manifest.json": manifest,
        "repositories": canonical({"yoko/crm-gravity-mvp": {tag: layer_hex}}),
        "index.json": index,
        "oci-layout": canonical({"imageLayoutVersion": "1.0.0"}),
        config_name: config,
        image_manifest_name: image_manifest,
        layer_name: layer,
        legacy_name: legacy_metadata,
    }
    if extra_blob:
        value = b"unbound content-addressed payload\n"
        files[f"blobs/sha256/{digest(value)}"] = value
    return deterministic_tar(files, ("blobs/", "blobs/sha256/")), f"sha256:{config_hex}"


class DockerArchiveFormatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sealer = load_sealer()

    def validate(self, archive: bytes, image_id: str) -> None:
        self.sealer.inspect_gravity_docker_archive(
            io.BytesIO(archive), IMAGE_REFERENCE, image_id, COMMIT, PROFILE_ID,
        )

    def test_oci_blob_docker_archive_is_fully_validated(self) -> None:
        archive, image_id = oci_blob_archive()
        self.validate(archive, image_id)

    def test_oci_layer_descriptor_drift_fails_closed(self) -> None:
        archive, image_id = oci_blob_archive(descriptor_size_delta=1)
        with self.assertRaises(SystemExit):
            self.validate(archive, image_id)

    def test_unbound_content_addressed_blob_fails_closed(self) -> None:
        archive, image_id = oci_blob_archive(extra_blob=True)
        with self.assertRaises(SystemExit):
            self.validate(archive, image_id)


if __name__ == "__main__":
    unittest.main()
