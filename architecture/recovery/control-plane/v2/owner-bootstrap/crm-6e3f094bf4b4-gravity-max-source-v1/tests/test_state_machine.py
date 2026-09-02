#!/usr/bin/python3
from __future__ import annotations

import importlib.machinery
import importlib.util
import sys
import unittest
from contextlib import nullcontext
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


def load_profile():
    loader = importlib.machinery.SourceFileLoader(
        "yoko_coordinated_state_machine_tests",
        str(ROOT / "templates/crm-activation-profile.py.in"),
    )
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    loader.exec_module(module)
    return module


class StateMachineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.runtime = load_profile()

    def setUp(self) -> None:
        self.core = SimpleNamespace(
            RuntimeFault=RuntimeFault,
            audit_status=lambda: {"state": "VALID"},
            now=lambda: "2026-09-02T00:00:00Z",
        )
        self.profile = {
            "predecessor": {"gravity": {"image_id": "old-g"}, "max_scraper": {"image_id": "old-m"}},
            "target": {"gravity": {"image_id": "new-g"}, "max_scraper": {"image_id": "new-m"}},
        }
        self.invocation = SimpleNamespace(primitive="release-activate", resource=None, relative_path=None)

    @staticmethod
    def pair(gravity: str, maximum: str):
        return ({"image_id": gravity}, {"image_id": maximum})

    def test_rollback_pair_repairs_both_known_mixed_vectors_with_one_pair_transaction(self) -> None:
        for pair in (self.pair("new-g", "old-m"), self.pair("old-g", "new-m")):
            with self.subTest(pair=pair):
                with (
                    mock.patch.object(self.runtime, "_pair", return_value=pair),
                    mock.patch.object(self.runtime, "_compose_up") as compose,
                    mock.patch.object(self.runtime, "_postcheck", return_value={"pair_state": "PREDECESSOR_PAIR"}) as postcheck,
                ):
                    result, mutated = self.runtime._rollback_pair(self.core, {}, self.profile, {})
                    self.assertTrue(mutated)
                    self.assertEqual(result["pair_state"], "PREDECESSOR_PAIR")
                    compose.assert_called_once()
                    self.assertFalse(compose.call_args.kwargs["activate"])
                    postcheck.assert_called_once()

    def test_unknown_pair_fails_closed_without_compose_mutation(self) -> None:
        with (
            mock.patch.object(self.runtime, "_pair", return_value=self.pair("foreign", "old-m")),
            mock.patch.object(self.runtime, "_compose_up") as compose,
            mock.patch.object(self.runtime, "_postcheck") as postcheck,
        ):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._rollback_pair(self.core, {}, self.profile, {})
        self.assertEqual(raised.exception.code, "UNKNOWN_PAIR_FAIL_CLOSED")
        compose.assert_not_called()
        postcheck.assert_not_called()

    def test_activation_from_preflight_is_one_fixed_attempt_and_records_target(self) -> None:
        state = {"phase": "PREFLIGHTED"}
        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value=state),
            mock.patch.object(self.runtime, "_pair", return_value=self.pair("old-g", "old-m")),
            mock.patch.object(self.runtime, "_validate_compose_inputs"),
            mock.patch.object(self.runtime, "_validate_target_image"),
            mock.patch.object(self.runtime, "_compose_up") as compose,
            mock.patch.object(self.runtime, "_postcheck", return_value={"pair_state": "TARGET_PAIR"}),
            mock.patch.object(self.runtime, "_write_state") as write_state,
            mock.patch.object(self.runtime, "_audit"),
        ):
            result = self.runtime._release_activate(self.core, {}, self.profile, self.invocation)
        self.assertEqual(result["status"], "ACTIVATED")
        compose.assert_called_once()
        self.assertTrue(compose.call_args.kwargs["activate"])
        self.assertEqual(write_state.call_args_list[-1].args[1]["phase"], "ACTIVATED")

    def test_restart_after_target_convergence_recovers_without_second_compose(self) -> None:
        state = {"phase": "ACTIVATION_INTENT"}
        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value=state),
            mock.patch.object(self.runtime, "_pair", return_value=self.pair("new-g", "new-m")),
            mock.patch.object(self.runtime, "_postcheck", return_value={"pair_state": "TARGET_PAIR"}),
            mock.patch.object(self.runtime, "_compose_up") as compose,
            mock.patch.object(self.runtime, "_write_state"),
            mock.patch.object(self.runtime, "_audit"),
        ):
            result = self.runtime._release_activate(self.core, {}, self.profile, self.invocation)
        self.assertEqual(result["status"], "ACTIVATED_RECOVERED")
        self.assertFalse(result["production_mutated"])
        compose.assert_not_called()

    def test_activation_failure_rolls_back_pair_and_reports_failure(self) -> None:
        state = {"phase": "PREFLIGHTED"}
        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value=state),
            mock.patch.object(self.runtime, "_pair", side_effect=[self.pair("old-g", "old-m"), self.pair("new-g", "old-m")]),
            mock.patch.object(self.runtime, "_validate_compose_inputs"),
            mock.patch.object(self.runtime, "_validate_target_image"),
            mock.patch.object(self.runtime, "_compose_up", side_effect=RuntimeFault("PAIR_COMPOSE_ACTIVATION_FAILED", 74)),
            mock.patch.object(self.runtime, "_rollback_pair", return_value=({"pair_state": "PREDECESSOR_PAIR"}, True)) as rollback,
            mock.patch.object(self.runtime, "_write_state") as write_state,
            mock.patch.object(self.runtime, "_audit"),
        ):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._release_activate(self.core, {}, self.profile, self.invocation)
        self.assertEqual(raised.exception.code, "ACTIVATION_FAILED_AUTOMATIC_ROLLBACK_OK")
        rollback.assert_called_once()
        self.assertEqual(write_state.call_args_list[-1].args[1]["phase"], "ROLLED_BACK")

    def test_activation_failure_with_unknown_observation_never_overwrites_it(self) -> None:
        state = {"phase": "PREFLIGHTED"}
        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value=state),
            mock.patch.object(self.runtime, "_pair", side_effect=[self.pair("old-g", "old-m"), self.pair("foreign", "old-m")]),
            mock.patch.object(self.runtime, "_validate_compose_inputs"),
            mock.patch.object(self.runtime, "_validate_target_image"),
            mock.patch.object(self.runtime, "_compose_up", side_effect=RuntimeFault("PAIR_COMPOSE_ACTIVATION_FAILED", 74)),
            mock.patch.object(self.runtime, "_rollback_pair") as rollback,
            mock.patch.object(self.runtime, "_write_state"),
            mock.patch.object(self.runtime, "_audit"),
        ):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._release_activate(self.core, {}, self.profile, self.invocation)
        self.assertEqual(raised.exception.code, "ACTIVATION_FAILED_UNKNOWN_STATE_NOT_OVERWRITTEN")
        rollback.assert_not_called()

    def test_preflight_binds_exact_predecessor_and_artifacts_without_compose_mutation(self) -> None:
        profile = {
            **self.profile,
            "artifact_admission": {"receipt_sha256": "r" * 64},
            "limits": {},
        }
        identity = {
            "environment_sha256": "e" * 64,
            "gravity_semantic": {"service": "gravity"},
            "max_semantic": {"service": "max"},
            "unrelated_semantic_fingerprint_sha256": "u" * 64,
            "database": {"database_identity_sha256": "d" * 64, "migration_rows_sha256": "m" * 64},
        }
        receipt = {"files": {"one": {}, "two": {}}}
        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value={"schema": self.runtime.STATE_SCHEMA, "profile_id": self.runtime.PROFILE_ID, "phase": "UNINITIALIZED"}),
            mock.patch.object(self.runtime, "_pair", return_value=self.pair("old-g", "old-m")),
            mock.patch.object(self.runtime, "_predecessor_identity", return_value=identity),
            mock.patch.object(self.runtime, "_artifact_receipt", return_value=receipt),
            mock.patch.object(self.runtime, "_artifact_path") as artifact_path,
            mock.patch.object(self.runtime, "_storage_guard", return_value={"available_bytes": 9, "minimum_free_bytes": 8}),
            mock.patch.object(self.runtime, "_load_target", side_effect=[{"Id": "new-g"}, {"Id": "new-m"}]),
            mock.patch.object(self.runtime, "_seal_rollback_reference"),
            mock.patch.object(self.runtime, "_derive_compose_domains", return_value={
                "target_gravity_compose_hash": "1" * 64,
                "target_max_compose_hash": "2" * 64,
                "rollback_gravity_compose_hash": "3" * 64,
                "rollback_max_compose_hash": "4" * 64,
            }),
            mock.patch.object(self.runtime, "_write_state") as write_state,
            mock.patch.object(self.runtime, "_audit"),
            mock.patch.object(self.runtime, "_compose_up") as compose,
        ):
            result = self.runtime._release_preflight(self.core, {}, profile, self.invocation)
        self.assertEqual(result["status"], "PREFLIGHTED")
        self.assertFalse(result["production_mutated"])
        self.assertEqual(artifact_path.call_count, 2)
        self.assertEqual(write_state.call_args.args[1]["phase"], "PREFLIGHTED")
        compose.assert_not_called()

    def test_preflight_and_rollback_are_idempotent_in_terminal_pair_states(self) -> None:
        activated = {"phase": "ACTIVATED"}
        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value=activated),
            mock.patch.object(self.runtime, "_pair", return_value=self.pair("new-g", "new-m")),
            mock.patch.object(self.runtime, "_postcheck", return_value={"pair_state": "TARGET_PAIR"}),
            mock.patch.object(self.runtime, "_compose_up") as compose,
        ):
            result = self.runtime._release_preflight(self.core, {}, self.profile, self.invocation)
        self.assertEqual(result["status"], "ALREADY_ACTIVATED")
        self.assertFalse(result["production_mutated"])
        compose.assert_not_called()

        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value={"phase": "ROLLED_BACK"}),
            mock.patch.object(self.runtime, "_pair", return_value=self.pair("old-g", "old-m")),
            mock.patch.object(self.runtime, "_rollback_pair", return_value=({"pair_state": "PREDECESSOR_PAIR"}, False)),
            mock.patch.object(self.runtime, "_write_state"),
            mock.patch.object(self.runtime, "_audit"),
        ):
            result = self.runtime._rollback(self.core, {}, self.profile, self.invocation)
        self.assertEqual(result["status"], "ALREADY_ROLLED_BACK")
        self.assertFalse(result["production_mutated"])


if __name__ == "__main__":
    unittest.main()
