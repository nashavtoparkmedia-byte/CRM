from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest import mock


AUTHORITY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AUTHORITY))

import coordinated_release_contract as contract  # noqa: E402
import hosted_artifact_transport as transport  # noqa: E402


BUILDER = "a" * 40
RUN_ID = 123456789


def identity(raw: bytes, *, digest: str | None = None, size: int | None = None) -> dict[str, object]:
    artifact_id = 987654321
    return {
        "id": artifact_id,
        "name": transport.release_artifact_name(BUILDER),
        "size_in_bytes": len(raw) if size is None else size,
        "digest": f"sha256:{digest or hashlib.sha256(raw).hexdigest()}",
        "expired": False,
        "archive_download_url": f"https://api.github.com/repos/{contract.REPOSITORY}/actions/artifacts/{artifact_id}/zip",
        "workflow_run": {
            "id": RUN_ID,
            "head_branch": transport.BRANCH,
            "head_sha": BUILDER,
        },
    }


def registry_artifact(name: str, artifact_id: int, digest: str, size: int) -> dict[str, object]:
    return {
        "id": artifact_id,
        "name": name,
        "size_in_bytes": size,
        "digest": digest,
        "expired": False,
        "workflow_run": {
            "id": RUN_ID,
            "head_branch": transport.BRANCH,
            "head_sha": BUILDER,
        },
    }


class HostedArtifactTransportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.raw = b"exact hosted zip!"
        self.identity = identity(self.raw)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def emit(self, output: Path | None = None) -> tuple[Path, dict[str, object]]:
        destination = output or self.base / "transport"
        manifest = transport.emit_transport(
            BytesIO(self.raw),
            self.identity,
            destination,
            BUILDER,
            RUN_ID,
            chunk_bytes=8,
            chunk_count=3,
        )
        return destination, manifest

    def test_exact_zip_is_chunked_and_reconstructed(self) -> None:
        destination, emitted = self.emit()
        verified = transport.verify_transport(
            self.identity,
            destination,
            BUILDER,
            RUN_ID,
            chunk_bytes=8,
            chunk_count=3,
        )
        reconstructed = b"".join((destination / name).read_bytes() for name in transport.PART_NAMES[:3])
        self.assertEqual(reconstructed, self.raw)
        self.assertEqual(verified, emitted)
        manifest_raw = (destination / transport.MANIFEST_NAME).read_bytes()
        self.assertEqual(manifest_raw, contract.canonical_bytes(json.loads(manifest_raw)))

    def test_source_digest_mismatch_is_rejected_before_manifest(self) -> None:
        altered = identity(self.raw, digest="0" * 64)
        destination = self.base / "bad-digest"
        with self.assertRaisesRegex(contract.ContractError, "stream digest mismatch"):
            transport.emit_transport(
                BytesIO(self.raw), altered, destination, BUILDER, RUN_ID,
                chunk_bytes=8, chunk_count=3,
            )
        self.assertFalse((destination / transport.MANIFEST_NAME).exists())

    def test_source_size_and_extra_bytes_are_rejected(self) -> None:
        too_short = identity(self.raw, size=len(self.raw) + 1)
        with self.assertRaisesRegex(contract.ContractError, "ended early"):
            transport.emit_transport(
                BytesIO(self.raw), too_short, self.base / "short", BUILDER, RUN_ID,
                chunk_bytes=8, chunk_count=3,
            )
        extra = identity(self.raw)
        with self.assertRaisesRegex(contract.ContractError, "size mismatch"):
            transport.emit_transport(
                BytesIO(self.raw + b"x"), extra, self.base / "extra", BUILDER, RUN_ID,
                chunk_bytes=8, chunk_count=3,
            )

    def test_insufficient_capacity_is_rejected_before_any_output(self) -> None:
        destination = self.base / "no-capacity"
        required = len(self.raw) + transport.MINIMUM_FREE_RESERVE_BYTES
        with mock.patch.object(transport, "_available_bytes", return_value=required - 1):
            with self.assertRaisesRegex(contract.ContractError, "insufficient free space"):
                transport.emit_transport(
                    BytesIO(self.raw), self.identity, destination, BUILDER, RUN_ID,
                    chunk_bytes=8, chunk_count=3,
                )
        self.assertFalse(destination.exists())

    def test_wrong_source_authority_is_rejected(self) -> None:
        cases = [
            ("name", "unexpected"),
            ("expired", True),
            ("archive_download_url", "https://example.invalid/artifact.zip"),
        ]
        for key, value in cases:
            with self.subTest(key=key):
                altered = dict(self.identity)
                altered[key] = value
                with self.assertRaisesRegex(contract.ContractError, "identity mismatch"):
                    transport.validate_hosted_artifact_identity(
                        altered, BUILDER, RUN_ID, chunk_bytes=8, chunk_count=3,
                    )
        altered = dict(self.identity)
        altered["workflow_run"] = dict(self.identity["workflow_run"], id=RUN_ID + 1)  # type: ignore[arg-type]
        with self.assertRaisesRegex(contract.ContractError, "identity mismatch"):
            transport.validate_hosted_artifact_identity(
                altered, BUILDER, RUN_ID, chunk_bytes=8, chunk_count=3,
            )

    def test_existing_output_and_tampered_chunk_are_rejected(self) -> None:
        existing = self.base / "existing"
        existing.mkdir()
        with self.assertRaisesRegex(RuntimeError, "exact transport directory"):
            transport.emit_transport(
                BytesIO(self.raw), self.identity, existing, BUILDER, RUN_ID,
                chunk_bytes=8, chunk_count=3,
            )
        destination, _ = self.emit(self.base / "tampered")
        first = destination / transport.PART_NAMES[0]
        first.chmod(0o644)
        first.write_bytes(b"tampered")
        with self.assertRaisesRegex(contract.ContractError, "manifest binding mismatch|digest mismatch"):
            transport.verify_transport(
                self.identity, destination, BUILDER, RUN_ID,
                chunk_bytes=8, chunk_count=3,
            )

    def test_hosted_registry_binds_exact_release_and_bounded_shards(self) -> None:
        source_bytes = 4_803_272_428
        source_digest = f"sha256:{'1' * 64}"
        source = identity(b"", digest="1" * 64, size=source_bytes)
        expected_names = (
            transport.release_artifact_name(BUILDER),
            *transport.transport_artifact_names(BUILDER),
        )
        artifacts = []
        for index, name in enumerate(expected_names):
            size = source_bytes if index == 0 else 1024
            digest = source_digest if index == 0 else f"sha256:{index:064x}"
            artifacts.append(registry_artifact(name, 1000 + index, digest, size))
        source["id"] = artifacts[0]["id"]
        source["digest"] = source_digest
        source["archive_download_url"] = (
            f"https://api.github.com/repos/{contract.REPOSITORY}/actions/artifacts/{source['id']}/zip"
        )
        listing = {"total_count": len(artifacts), "artifacts": artifacts}
        verified = transport.validate_hosted_transport_registry(listing, source, BUILDER, RUN_ID)
        self.assertEqual([row["name"] for row in verified], list(expected_names))

        partial = {"total_count": len(artifacts) - 1, "artifacts": artifacts[:-1]}
        with self.assertRaisesRegex(contract.ContractError, "inventory mismatch"):
            transport.validate_hosted_transport_registry(partial, source, BUILDER, RUN_ID)
        verified_after_recovery = transport.validate_hosted_transport_registry(
            listing, source, BUILDER, RUN_ID,
        )
        self.assertEqual(verified_after_recovery, verified)

        artifacts[1]["size_in_bytes"] = transport.CONNECTOR_MAX_BYTES + 1
        with self.assertRaisesRegex(contract.ContractError, "connector limit"):
            transport.validate_hosted_transport_registry(listing, source, BUILDER, RUN_ID)


if __name__ == "__main__":
    unittest.main()
