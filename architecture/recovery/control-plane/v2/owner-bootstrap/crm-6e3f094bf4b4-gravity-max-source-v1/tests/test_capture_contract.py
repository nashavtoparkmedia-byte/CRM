#!/usr/bin/python3
from __future__ import annotations

import datetime as dt
import hashlib
import importlib.machinery
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
LOADER = importlib.machinery.SourceFileLoader("yoko_coordinated_capture_tests", str(ROOT / "packaging/capture-production-snapshot.py"))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
assert SPEC is not None
capture = importlib.util.module_from_spec(SPEC)
sys.modules[LOADER.name] = capture
LOADER.exec_module(capture)

SEAL_LOADER = importlib.machinery.SourceFileLoader("yoko_coordinated_seal_tests", str(ROOT / "packaging/seal-release.py"))
SEAL_SPEC = importlib.util.spec_from_loader(SEAL_LOADER.name, SEAL_LOADER)
assert SEAL_SPEC is not None
seal = importlib.util.module_from_spec(SEAL_SPEC)
sys.modules[SEAL_LOADER.name] = seal
SEAL_LOADER.exec_module(seal)


class CaptureContractTests(unittest.TestCase):
    def test_v14_package_metadata_is_parsed_as_values_not_labeled_multi_field_output(self) -> None:
        path = Path("/opt/codex-work/runtime-v14-seal-f9f05a7c/builder/architecture/recovery/control-plane/v2/owner-bootstrap/crm-external-rereview-source-only-v10/dist/yoko-privileged-runtime_2.0.0-14_all.deb")
        self.assertEqual(seal.deb_metadata(path), ["yoko-privileged-runtime", "2.0.0-14", "all"])

    def test_capture_plan_is_finite_and_read_only(self) -> None:
        self.assertEqual(capture.COMMANDS, (
            ("version", None),
            ("self-check", None),
            ("audit-status", None),
            ("storage-status", None),
            ("predecessor-observe", None),
            ("docker-inspect", "crm.container.gravity_mvp"),
            ("docker-inspect", "crm.container.max_scraper"),
            ("docker-inspect", "crm.container.postgres"),
            ("database-status", None),
            ("docker-provenance", None),
        ))
        forbidden = {"release-preflight", "release-activate", "rollback", "service-restart", "database-migrate"}
        self.assertFalse(forbidden & {primitive for primitive, _ in capture.COMMANDS})

    def test_runtime_capture_uses_fixed_sudo_argv_and_rejects_stderr(self) -> None:
        response = {
            "schema": "yoko.privileged-runtime.response.v1", "runtime_version": "2.0.0",
            "primitive": "version", "resource": None, "ok": True, "errors": [], "evidence": {},
        }
        completed = mock.Mock(returncode=0, stdout=json.dumps(response).encode("ascii"), stderr=b"")
        with mock.patch.object(capture.subprocess, "run", return_value=completed) as execute:
            capture.run("version", None)
        self.assertEqual(execute.call_args.args[0], ["/usr/bin/sudo", "-n", "/usr/local/sbin/yoko-privileged-runtime", "version"])
        completed.stderr = b"unexpected"
        with mock.patch.object(capture.subprocess, "run", return_value=completed), self.assertRaises(ValueError):
            capture.run("version", None)

    def test_migration_projection_is_exact_ordered_and_secret_free(self) -> None:
        rows = []
        for ordinal in range(1, 63):
            rows.append({
                "status": "FINISHED_ACTIVE", "observed_chronological_ordinal": ordinal,
                "migration_id": f"id-{ordinal}", "checksum": hashlib.sha256(str(ordinal).encode()).hexdigest(),
                "migration_name": f"{ordinal:04d}_fixture", "finished_at": "2026-01-01T00:00:00.000000Z",
                "rolled_back_at": None, "started_at": "2026-01-01T00:00:00.000000Z", "applied_steps_count": 1,
                "logs_present": False, "logs_bytes": None, "logs_sha256": None,
            })
        projected = capture.project_migration_rows({"canonical_live_rows": rows})
        self.assertEqual([row["ordinal"] for row in projected], list(range(1, 63)))
        self.assertNotIn("logs_present", projected[0])
        rows[1]["status"] = "FAILED"
        with self.assertRaises(ValueError):
            capture.project_migration_rows({"canonical_live_rows": rows})

    def test_sealer_accepts_only_fresh_exact_predecessor_snapshot(self) -> None:
        completed = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        rows = [{"ordinal": ordinal} for ordinal in range(1, 63)]
        sealing = {
            "runtime_package_version": "2.0.0-14",
            "runtime_profile_id": "crm-41f69fe8fe3f-gravity-source-v1",
            "audit_record_count": 47,
            "audit_last_digest": "a" * 64,
            "predecessor_release_critical_identity_sha256": "b" * 64,
            "gravity_container_id": "g",
            "gravity_image_id": "sha256:5531c67e99b572356f897246b8c845ab4f9b232d9dc029fa311397e46a4d715c",
            "gravity_compose_config_hash": "c" * 64,
            "max_container_id": "m",
            "max_image_id": "sha256:87835969ed6335a99d50e1cc2eaf70aa33fdbaf937f4cef658a926f55b26f365",
            "max_compose_config_hash": "d" * 64,
            "max_volume_source_sha256": "fc08035e511fd21c704ef93e6de3948239f40b5f1a6fb6869aec247a3406f2a3",
            "postgres_container_id": "p",
            "postgres_image_id": "sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229",
            "database_identity_sha256": "ed88dfeaad2a3dc2e759590d295992cd06531d4403d896ded00b21ea667be1c9",
            "migration_rows": rows,
            "migration_rows_sha256": hashlib.sha256(seal.canonical(rows)).hexdigest(),
            "unrelated_semantic_fingerprint_sha256": "e" * 64,
        }
        value = {
            "schema": "yoko.crm.coordinated-runtime-production-snapshot.v1",
            "started_at": (completed - dt.timedelta(seconds=1)).isoformat().replace("+00:00", "Z"),
            "completed_at": completed.isoformat().replace("+00:00", "Z"),
            "production_mutated": False, "secret_values_emitted": False,
            "commands": {}, "sealing": sealing,
        }
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / "snapshot.json"
            path.write_text(json.dumps(value), encoding="ascii")
            accepted, _ = seal.validate_snapshot(path)
            self.assertEqual(accepted["sealing"]["audit_record_count"], 47)
            value["completed_at"] = (completed - dt.timedelta(minutes=16)).isoformat().replace("+00:00", "Z")
            value["started_at"] = value["completed_at"]
            path.write_text(json.dumps(value), encoding="ascii")
            with self.assertRaisesRegex(ValueError, "stale"):
                seal.validate_snapshot(path)


if __name__ == "__main__":
    unittest.main()
