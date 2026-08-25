#!/usr/bin/python3
from __future__ import annotations

import contextlib
import hashlib
import importlib.machinery
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


class RuntimeFault(Exception):
    def __init__(self, code: str, exit_code: int = 70, details: dict[str, object] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code
        self.details = details or {}


class Core:
    RuntimeFault = RuntimeFault


def load_runtime():
    loader = importlib.machinery.SourceFileLoader(
        "yoko_runtime_v10_rollback_control",
        str(ROOT / "src/crm-activation-profile.py"),
    )
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    loader.exec_module(module)
    return module


class RollbackControlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.runtime = load_runtime()

    def profile(self) -> dict[str, object]:
        return {
            "production": {
                "gravity_image_id": "sha256:" + "a" * 64,
                "tg_bot_image_id": "sha256:" + "b" * 64,
                "tg_bot_cmd": ["node", "start.js"],
            },
            "recovery": {
                "database_identity_sha256": "c" * 64,
                "migration_ledger_sha256": "d" * 64,
                "recovered_compose_config_hash": "e" * 64,
                "recovered_tg_bot_compose_config_hash": "f" * 64,
            },
        }

    def source_state(self) -> dict[str, object]:
        profile = self.profile()
        production = profile["production"]
        recovery = profile["recovery"]
        return {
            "schema": self.runtime.STATE_SCHEMA,
            "profile_id": self.runtime.RECOVERY_SOURCE_PROFILE_ID,
            "phase": "ROLLBACK_INTENT",
            "accepted_commit": self.runtime.RECOVERY_SOURCE_COMMIT,
            "accepted_archive_sha256": self.runtime.RECOVERY_SOURCE_ARCHIVE_SHA256,
            "target_tag": self.runtime.RECOVERY_SOURCE_GRAVITY_TAG,
            "target_image_id": "sha256:" + "2" * 64,
            "tg_target_tag": self.runtime.RECOVERY_SOURCE_TG_TAG,
            "tg_target_image_id": "sha256:" + "3" * 64,
            "rollback_tag": self.runtime.ROLLBACK_TAG,
            "rollback_image_id": production["gravity_image_id"],
            "tg_rollback_tag": self.runtime.TG_ROLLBACK_TAG,
            "tg_rollback_image_id": production["tg_bot_image_id"],
            "database_identity_sha256": recovery["database_identity_sha256"],
            "migration_ledger_sha256": recovery["migration_ledger_sha256"],
            "production_identity": {
                "gravity_semantic": {
                    "image_id": production["gravity_image_id"],
                    "command": ["npm", "run", "start"],
                    "compose_labels": {
                        "com.docker.compose.config-hash": recovery["recovered_compose_config_hash"],
                    },
                },
                "tg_bot_semantic": {
                    "image_id": production["tg_bot_image_id"],
                    "command": production["tg_bot_cmd"],
                    "compose_labels": {
                        "com.docker.compose.config-hash": recovery["recovered_tg_bot_compose_config_hash"],
                    },
                },
            },
        }

    def test_rollback_overlay_reconstructs_authoritative_references_and_command(self) -> None:
        raw = self.runtime._compose_overlay(
            self.runtime.PRIOR_TARGET_TAG,
            self.runtime.TG_PREDECESSOR_REFERENCE,
            activate=False,
        ).decode("ascii")
        self.assertEqual(raw.count("command:"), 1)
        self.assertIn(f"image: {self.runtime.PRIOR_TARGET_TAG}\n", raw)
        self.assertIn(f"image: {self.runtime.TG_PREDECESSOR_REFERENCE}\n", raw)
        self.assertIn('command: ["npm", "run", "start"]', raw)
        self.assertNotIn(self.runtime.ROLLBACK_TAG, raw)
        self.assertNotIn(self.runtime.TG_ROLLBACK_TAG, raw)

    def test_predecessor_references_are_exact_image_bound(self) -> None:
        profile = self.profile()
        exact = [
            {"Id": profile["production"]["gravity_image_id"]},
            {"Id": profile["production"]["tg_bot_image_id"]},
        ]
        with mock.patch.object(self.runtime, "_image_inspect", side_effect=exact) as inspect:
            self.runtime._verify_predecessor_compose_references(Core(), profile)
        self.assertEqual(
            [call.args[1] for call in inspect.call_args_list],
            [self.runtime.PRIOR_TARGET_TAG, self.runtime.TG_PREDECESSOR_REFERENCE],
        )
        with mock.patch.object(self.runtime, "_image_inspect", side_effect=[exact[0], {"Id": "wrong"}]):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._verify_predecessor_compose_references(Core(), profile)
        self.assertEqual(raised.exception.code, "TG_BOT_PREDECESSOR_REFERENCE_IDENTITY_DRIFT")

    def test_semantically_drifted_old_images_are_reconstructed_not_accepted(self) -> None:
        profile = self.profile()
        gravity = {"image_id": profile["production"]["gravity_image_id"], "running": True, "health": "healthy"}
        tg_bot = {"image_id": profile["production"]["tg_bot_image_id"], "running": True, "health": "healthy"}
        repaired = {"runtime_semantics_compatibility": "EXACT"}
        with (
            mock.patch.object(self.runtime, "_rollback_state_is_exact", return_value=False),
            mock.patch.object(self.runtime, "_rollback_impl", return_value=repaired) as rebuild,
            mock.patch.object(self.runtime, "_accept_existing_rollback") as accept,
        ):
            result, mutated = self.runtime._restore_or_accept_rollback(
                Core(), {}, profile, {"phase": "ROLLBACK_INTENT"}, gravity, tg_bot,
            )
        self.assertIs(result, repaired)
        self.assertTrue(mutated)
        rebuild.assert_called_once()
        accept.assert_not_called()

    def test_exact_old_images_and_semantics_are_idempotently_accepted(self) -> None:
        accepted = {"runtime_semantics_compatibility": "EXACT"}
        with (
            mock.patch.object(self.runtime, "_rollback_state_is_exact", return_value=True),
            mock.patch.object(self.runtime, "_accept_existing_rollback", return_value=accepted) as accept,
            mock.patch.object(self.runtime, "_rollback_impl") as rebuild,
        ):
            result, mutated = self.runtime._restore_or_accept_rollback(
                Core(), {}, self.profile(), {}, {}, {},
            )
        self.assertIs(result, accepted)
        self.assertFalse(mutated)
        accept.assert_called_once()
        rebuild.assert_not_called()

    def test_combined_failure_preserves_both_machine_identities_and_terminal_status(self) -> None:
        core = Core()
        core.now = lambda: "2026-08-25T00:00:00Z"
        activation = {"code": "FORCED_ACTIVATION_FAILURE", "details": {"probe": "http"}}
        rollback = RuntimeFault("ROLLBACK_SEMANTIC_DRIFT", 74, {"service": "gravity-mvp"})
        stored: list[dict[str, object]] = []
        with mock.patch.object(
            self.runtime,
            "_write_terminal_state",
            side_effect=lambda _core, _invocation, _pre, _result, post: stored.append(post) or post,
        ):
            fault = self.runtime._combined_activation_rollback_fault(
                core, SimpleNamespace(), {"schema": "state"}, activation, rollback, "failed",
            )
        self.assertEqual(fault.code, "ACTIVATION_AND_AUTOMATIC_ROLLBACK_FAILED")
        self.assertEqual(fault.details["activation_failure"], activation)
        self.assertEqual(fault.details["automatic_rollback_failure"], {
            "code": "ROLLBACK_SEMANTIC_DRIFT", "details": {"service": "gravity-mvp"},
        })
        self.assertEqual(fault.details["terminal_status"], "ACTIVATION_AND_AUTOMATIC_ROLLBACK_FAILED")
        self.assertEqual(stored[0]["activation_failure_identity"], activation)
        self.assertEqual(stored[0]["automatic_rollback_failure_identity"], fault.details["automatic_rollback_failure"])

    def test_rollback_health_requires_two_consecutive_stabilized_successes(self) -> None:
        failure = RuntimeFault("GRAVITY_ROLLBACK_APPLICATION_HEALTH_FAILED", 74)
        success = {"rollback_application_health_compatible": True}
        with (
            mock.patch.object(
                self.runtime, "_rollback_application_health_once",
                side_effect=[failure, success, success],
            ) as probe,
            mock.patch.object(
                self.runtime.time, "monotonic",
                side_effect=[0.0, 0.0, 1.0, 1.0, 1.0, 2.0, 2.0],
            ),
            mock.patch.object(self.runtime.time, "sleep") as sleep,
        ):
            evidence = self.runtime._rollback_application_health(Core(), {})
        self.assertEqual(probe.call_count, 3)
        self.assertEqual(evidence["rollback_stabilization_attempts"], 3)
        self.assertEqual(evidence["rollback_stabilization_consecutive_successes"], 2)
        self.assertTrue(evidence["rollback_application_health_compatible"])
        self.assertEqual(sleep.call_count, 2)

    def test_replacement_state_import_accepts_only_exact_rollback_intent(self) -> None:
        profile = self.profile()
        with tempfile.TemporaryDirectory(prefix="yoko-replacement-state-") as temporary:
            root = Path(temporary)
            target = root / self.runtime.RECOVERY_SOURCE_STATE_PATH.lstrip("/")
            target.parent.mkdir(parents=True)
            raw = self.runtime._canonical(self.source_state()) + b"\n"
            target.write_bytes(raw)
            target.chmod(0o600)

            class FixtureCore(Core):
                @staticmethod
                def mapped(path: str) -> Path:
                    return root / path.lstrip("/")

                @staticmethod
                def secure_file(_path: str, _mode: int, maximum: int) -> None:
                    if len(raw) > maximum:
                        raise AssertionError("fixture exceeds bound")

            observed, digest = self.runtime._read_replacement_recovery_state(FixtureCore(), profile)
            self.assertEqual(observed["phase"], "ROLLBACK_INTENT")
            self.assertEqual(digest, hashlib.sha256(raw).hexdigest())
            observed["phase"] = "ROLLED_BACK"
            target.write_bytes(self.runtime._canonical(observed) + b"\n")
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._read_replacement_recovery_state(FixtureCore(), profile)
            self.assertEqual(raised.exception.code, "REPLACEMENT_RECOVERY_STATE_IDENTITY_MISMATCH")

    def test_explicit_rollback_imports_old_profile_then_repairs_before_rolled_back(self) -> None:
        profile = self.profile()
        source = self.source_state()
        imported = {**source, "profile_id": self.runtime.PROFILE_ID}
        repaired = {"runtime_semantics_compatibility": "EXACT"}
        terminal: list[dict[str, object]] = []

        class FixtureCore(Core):
            @staticmethod
            def audit_status() -> dict[str, str]:
                return {"state": "VALID"}

            @staticmethod
            def now() -> str:
                return "2026-08-25T00:00:00Z"

            @staticmethod
            def container_projection(_policy: object, resource: str) -> dict[str, object]:
                image = (
                    profile["production"]["gravity_image_id"]
                    if resource.endswith("gravity_mvp")
                    else profile["production"]["tg_bot_image_id"]
                )
                return {"image_id": image, "running": True, "health": "healthy"}

        def write_terminal(_core, _invocation, _pre, _result, post):
            terminal.append(post)
            return post

        with (
            mock.patch.object(self.runtime, "_lock", return_value=contextlib.nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value={
                "schema": self.runtime.STATE_SCHEMA,
                "profile_id": self.runtime.PROFILE_ID,
                "phase": "UNINITIALIZED",
            }),
            mock.patch.object(self.runtime, "_reconcile_terminal_audit"),
            mock.patch.object(self.runtime, "_read_replacement_recovery_state", return_value=(source, "9" * 64)),
            mock.patch.object(self.runtime, "_write_terminal_state", side_effect=write_terminal),
            mock.patch.object(self.runtime, "_dual_service_image_state", return_value=("old", "old")),
            mock.patch.object(self.runtime, "_restore_or_accept_rollback", return_value=(repaired, True)) as restore,
        ):
            result = self.runtime._rollback(FixtureCore(), {}, profile, SimpleNamespace())
        self.assertEqual(result["status"], "ROLLED_BACK")
        self.assertTrue(result["production_mutated"])
        self.assertEqual(terminal[0]["replacement_recovery_source_profile_id"], self.runtime.RECOVERY_SOURCE_PROFILE_ID)
        self.assertEqual(terminal[-1]["phase"], "ROLLED_BACK")
        restore.assert_called_once()


if __name__ == "__main__":
    unittest.main(verbosity=2)
