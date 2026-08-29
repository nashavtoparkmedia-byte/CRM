#!/usr/bin/python3
from __future__ import annotations

import contextlib
import importlib.machinery
import importlib.util
import json
import sys
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
            "deployment": {
                "compose_project": "crm",
                "compose_service": "gravity-mvp",
                "tg_bot_compose_service": "tg-bot",
            },
            "transition_invariants": {
                "tg_bot_entrypoint": ["/usr/bin/tini", "--", "/usr/local/bin/tg-bot-entrypoint"],
                "tg_bot_cmd": ["node", "start.js"],
                "tg_bot_declared_user": "",
                "tg_bot_working_dir": "/app",
            },
            "rollback_recovery": {
                "gravity_image_reference": self.runtime.ROLLBACK_TAG,
                "gravity_image_id": "sha256:" + "a" * 64,
                "gravity_compose_config_hash": "e" * 64,
                "tg_bot_image_reference": self.runtime.TG_ROLLBACK_TAG,
                "tg_bot_image_id": "sha256:" + "b" * 64,
                "tg_bot_compose_config_hash": "f" * 64,
                "database_identity_sha256": "c" * 64,
                "migration_ledger_sha256": "d" * 64,
            },
        }

    def test_rollback_overlay_reconstructs_exact_live_prestate_without_target_command(self) -> None:
        raw = self.runtime._compose_overlay(
            self.runtime.ROLLBACK_TAG,
            self.runtime.TG_ROLLBACK_TAG,
            activate=False,
        ).decode("ascii")
        self.assertEqual(raw.count("command:"), 0)
        self.assertIn(f"image: {self.runtime.ROLLBACK_TAG}\n", raw)
        self.assertIn(f"image: {self.runtime.TG_ROLLBACK_TAG}\n", raw)

    def test_predecessor_references_are_exact_image_bound(self) -> None:
        profile = self.profile()
        recovery = profile["rollback_recovery"]
        exact = [
            {"Id": recovery["gravity_image_id"]},
            {"Id": recovery["tg_bot_image_id"]},
        ]
        with mock.patch.object(self.runtime, "_image_inspect", side_effect=exact) as inspect:
            self.runtime._verify_predecessor_compose_references(Core(), profile)
        self.assertEqual(
            [call.args[1] for call in inspect.call_args_list],
            [self.runtime.ROLLBACK_TAG, self.runtime.TG_ROLLBACK_TAG],
        )
        with mock.patch.object(self.runtime, "_image_inspect", side_effect=[exact[0], {"Id": "wrong"}]):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._verify_predecessor_compose_references(Core(), profile)
        self.assertEqual(raised.exception.code, "TG_BOT_PREDECESSOR_REFERENCE_IDENTITY_DRIFT")

    def test_semantically_drifted_old_images_are_reconstructed_not_accepted(self) -> None:
        profile = self.profile()
        recovery = profile["rollback_recovery"]
        gravity = {"image_id": recovery["gravity_image_id"], "running": True, "health": "healthy"}
        tg_bot = {"image_id": recovery["tg_bot_image_id"], "running": True, "health": "healthy"}
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

    def test_uninitialized_rollback_never_imports_historical_transition_state(self) -> None:
        profile = self.profile()
        with (
            mock.patch.object(self.runtime, "_lock", return_value=contextlib.nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value={
                "schema": self.runtime.STATE_SCHEMA,
                "profile_id": self.runtime.PROFILE_ID,
                "phase": "UNINITIALIZED",
            }),
            mock.patch.object(self.runtime, "_reconcile_terminal_audit"),
            mock.patch.object(self.runtime, "_write_terminal_state") as write_terminal,
            mock.patch.object(self.runtime, "_restore_or_accept_rollback") as restore,
        ):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._rollback(Core(), {}, profile, SimpleNamespace())
        self.assertEqual(raised.exception.code, "ROLLBACK_NOT_AVAILABLE_BEFORE_PREFLIGHT")
        write_terminal.assert_not_called()
        restore.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
