#!/usr/bin/python3
from __future__ import annotations

import copy
import datetime as dt
import importlib.machinery
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
CAPTURE_PATH = ROOT / "packaging/capture-production-snapshot.py"
LOADER = importlib.machinery.SourceFileLoader("yoko_runtime_v10_capture_tests", str(CAPTURE_PATH))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
assert SPEC is not None
capture = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(capture)
UTC = dt.timezone.utc


def version_record() -> dict[str, object]:
    response = {
        "errors": [],
        "evidence": {
            "activation_profile": capture.PROFILE_ID,
            "package_version": capture.PACKAGE_VERSION,
            "response_schema": "yoko.privileged-runtime.response.v1",
            "runtime_version": capture.RUNTIME_VERSION,
        },
        "ok": True,
        "primitive": "version",
        "resource": None,
        "runtime_version": capture.RUNTIME_VERSION,
        "schema": "yoko.privileged-runtime.response.v1",
        "timestamp": "2026-08-13T20:00:00Z",
        "warnings": [],
    }
    raw = capture.canonical(response)
    projection = response["evidence"]
    argv = capture.command_argv("version", None)
    return {
        "sequence": 1,
        "command_id": "01:version:-",
        "argv": argv,
        "argv_sha256": capture.digest(capture.canonical(argv)),
        "response_bytes": len(raw),
        "response_sha256": capture.digest(raw),
        "response_json": raw[:-1].decode("ascii"),
        "response_timestamp": response["timestamp"],
        "response_projection": projection,
        "response_projection_sha256": capture.digest(capture.canonical(projection)),
    }


def database_response(total: int) -> dict[str, object]:
    counts = {
        "dead_letter": 0,
        "over_attempt_limit": 0,
        "pending": 0,
        "processing": 0,
        "published": total,
        "retry_wait": 0,
        "stale_claimed": 0,
        "total": total,
    }
    return {
        "errors": [],
        "evidence": {
            "applied_migration_count": 62,
            "database_identity_sha256": capture.DATABASE_IDENTITY,
            "database_name_sha256": "3f831e31b1b5e63661e38c3af85b8d46c5558d2a4b5029e6c15bfd092e793e6c",
            "database_user_sha256": "9261ceef0b969e70ac20f1510f07a1e0d8db05f20c75161a2ef43b4eba27a7aa",
            "interrupted_target_migrations": 0,
            "migration_ledger_sha256": capture.MIGRATION_LEDGER,
            "migration_state": "APPROVED_OUTBOX_APPLIED",
            "outbox_catalog_state": "EXACT",
            "outbox_counts": counts,
            "postgres_container_id": "57a09acd5b407d72934ea4cb398874fec60d25a815265b018ba9dd4ab5dbddda",
            "postgres_image_id": capture.POSTGRES_IMAGE,
            "profile_id": capture.PROFILE_ID,
            "read_only": True,
            "rolled_back_target_migrations": 0,
            "secret_values_emitted": False,
            "server_version_num": "160014",
            "system_identifier_sha256": "9b73df197b2607b5be82f56cbfc404718e1116353e1d454ce955d0d2b0d86b23",
        },
        "ok": True,
        "primitive": "database-status",
        "resource": None,
        "runtime_version": capture.RUNTIME_VERSION,
        "schema": "yoko.privileged-runtime.response.v1",
        "timestamp": "2026-08-13T20:00:00Z",
        "warnings": [],
    }


def outer_snapshot(at: dt.datetime) -> dict[str, object]:
    stamp = capture.utc_text(at)
    observed = {key: None for key in capture.OBSERVED_KEYS}
    authority = {key: None for key in capture.AUTHORITY_KEYS}
    cross = {"status": "PASS", "checks": capture.CROSS_CHECKS}
    commands: list[object] = []
    transcript = {
        "schema": "yoko.crm.read-only-production-capture-transcript.v1",
        "started_at": stamp,
        "completed_at": stamp,
        "duration_seconds": 0,
        "commands": commands,
        "commands_sha256": capture.digest(capture.canonical(commands)),
        "cross_consistency": cross,
        "cross_consistency_sha256": capture.digest(capture.canonical(cross)),
        "secret_values_emitted": False,
        "production_mutated": False,
    }
    return {
        "schema": "yoko.crm.source-only-production-snapshot.v2",
        "status": "ACCEPTED_READ_ONLY_CAPTURE",
        "captured_at": stamp,
        "host": capture.HOST,
        "observed": observed,
        "sealed_predecessor_authority": authority,
        "capture": transcript,
        "capture_transcript_sha256": capture.digest(capture.canonical(transcript)),
    }


class ProductionCaptureContractTests(unittest.TestCase):
    def test_healthy_published_outbox_growth_is_accepted_fail_closed(self) -> None:
        for total in (1, 4, 5, 999):
            with self.subTest(total=total):
                response = database_response(total)
                accepted = capture.validate_response(response, "database-status", None)
                self.assertEqual(accepted["evidence"]["outbox_counts"]["total"], total)

        invalid: list[dict[str, object]] = []
        zero = database_response(0)
        invalid.append(zero)
        unpublished = database_response(5)
        unpublished["evidence"]["outbox_counts"]["published"] = 4
        invalid.append(unpublished)
        pending = database_response(5)
        pending["evidence"]["outbox_counts"]["pending"] = 1
        invalid.append(pending)
        bool_total = database_response(5)
        bool_total["evidence"]["outbox_counts"]["total"] = True
        invalid.append(bool_total)
        for response in invalid:
            with self.assertRaisesRegex(capture.CaptureError, "database read-only evidence mismatch"):
                capture.validate_response(response, "database-status", None)

    def test_finite_plan_contains_only_exact_read_only_runtime_verbs(self) -> None:
        self.assertEqual(capture.COMMANDS, (
            ("version", None),
            ("self-check", None),
            ("audit-status", None),
            ("docker-inspect", "crm.container.gravity_mvp"),
            ("docker-inspect", "crm.container.telegram_bot"),
            ("docker-inspect", "crm.container.postgres"),
            ("snapshot-manifest", "crm.repo.production"),
            ("database-status", None),
        ))
        forbidden = {"release-preflight", "release-activate", "service-restart", "database-migrate", "rollback"}
        self.assertFalse(forbidden & {primitive for primitive, _ in capture.COMMANDS})
        with self.assertRaisesRegex(capture.CaptureError, "outside the finite read-only"):
            capture.run_read_only([capture.SUDO, "-n", capture.RUNTIME, "release-preflight"])

    def test_command_record_binds_raw_response_hash_and_projection(self) -> None:
        record = version_record()
        result = capture.validate_command_record(record, 1, "version", None)
        self.assertEqual(result["evidence"]["package_version"], capture.PACKAGE_VERSION)

        tampered_raw = copy.deepcopy(record)
        tampered_raw["response_json"] += " "
        with self.assertRaisesRegex(capture.CaptureError, "response hash mismatch"):
            capture.validate_command_record(tampered_raw, 1, "version", None)

        tampered_projection = copy.deepcopy(record)
        tampered_projection["response_projection"]["package_version"] = "2.0.0-8"
        tampered_projection["response_projection_sha256"] = capture.digest(capture.canonical(tampered_projection["response_projection"]))
        with self.assertRaisesRegex(capture.CaptureError, "projection is not response-derived"):
            capture.validate_command_record(tampered_projection, 1, "version", None)

        wrong_command = copy.deepcopy(record)
        wrong_command["argv"][-1] = "release-preflight"
        wrong_command["argv_sha256"] = capture.digest(capture.canonical(wrong_command["argv"]))
        with self.assertRaisesRegex(capture.CaptureError, "command identity mismatch"):
            capture.validate_command_record(wrong_command, 1, "version", None)

        bool_sequence = copy.deepcopy(record)
        bool_sequence["sequence"] = True
        with self.assertRaisesRegex(capture.CaptureError, "command identity mismatch"):
            capture.validate_command_record(bool_sequence, 1, "version", None)

    def test_duplicate_and_noncanonical_runtime_json_are_rejected(self) -> None:
        record = version_record()
        duplicate = record["response_json"].replace('"ok":true', '"ok":true,"ok":true') + "\n"
        with self.assertRaisesRegex(capture.CaptureError, "duplicate JSON key"):
            capture.parse_json_bytes(duplicate.encode("ascii"), "duplicate")
        pretty = json.dumps(json.loads(record["response_json"]), indent=2).encode("ascii") + b"\n"
        with self.assertRaisesRegex(capture.CaptureError, "not canonical JSON"):
            capture.parse_json_bytes(pretty, "pretty")

    def test_snapshot_transcript_digest_and_freshness_are_mandatory(self) -> None:
        now = dt.datetime(2026, 8, 13, 20, 0, 0, tzinfo=UTC)
        value = outer_snapshot(now)
        with mock.patch.object(capture, "build_snapshot", return_value=value):
            self.assertIs(capture.validate_snapshot_document(value, now=now), value)

        tampered = copy.deepcopy(value)
        tampered["capture"]["commands"] = [{}]
        tampered["capture_transcript_sha256"] = capture.digest(capture.canonical(tampered["capture"]))
        with self.assertRaisesRegex(capture.CaptureError, "command transcript digest mismatch"):
            capture.validate_snapshot_document(tampered, now=now)

        stale = outer_snapshot(now - dt.timedelta(seconds=capture.MAX_SNAPSHOT_AGE_SECONDS + 1))
        with self.assertRaisesRegex(capture.CaptureError, "stale or from the future"):
            capture.validate_snapshot_document(stale, now=now)

        future = outer_snapshot(now + dt.timedelta(seconds=capture.MAX_FUTURE_SKEW_SECONDS + 1))
        with self.assertRaisesRegex(capture.CaptureError, "stale or from the future"):
            capture.validate_snapshot_document(future, now=now)

        bool_duration = outer_snapshot(now)
        bool_duration["capture"]["duration_seconds"] = False
        bool_duration["capture_transcript_sha256"] = capture.digest(capture.canonical(bool_duration["capture"]))
        with self.assertRaisesRegex(capture.CaptureError, "capture interval mismatch"):
            capture.validate_snapshot_document(bool_duration, now=now)

    def test_snapshot_file_rejects_duplicate_keys_and_authority_is_separate(self) -> None:
        now = dt.datetime(2026, 8, 13, 20, 0, 0, tzinfo=UTC)
        value = outer_snapshot(now)
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / "snapshot.json"
            path.write_text('{"schema":"one","schema":"two"}\n', encoding="ascii")
            with self.assertRaisesRegex(capture.CaptureError, "duplicate JSON key"):
                capture.load_snapshot(path, now=now)
        self.assertFalse(set(value["observed"]) & set(value["sealed_predecessor_authority"]))
        self.assertNotIn("tg_bot_patch_sha256", value["observed"])
        self.assertNotIn("outbox_catalog_sha256", value["observed"])


if __name__ == "__main__":
    unittest.main()
