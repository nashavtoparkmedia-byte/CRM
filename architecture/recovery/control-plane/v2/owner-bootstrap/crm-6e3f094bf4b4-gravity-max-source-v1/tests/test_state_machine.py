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
                    mock.patch.object(self.runtime, "_assert_rollback_material") as material,
                    mock.patch.object(self.runtime, "_compose_up") as compose,
                    mock.patch.object(self.runtime, "_postcheck", return_value={"pair_state": "PREDECESSOR_PAIR"}) as postcheck,
                ):
                    result, mutated = self.runtime._rollback_pair(self.core, {}, self.profile, {})
                    self.assertTrue(mutated)
                    self.assertEqual(result["pair_state"], "PREDECESSOR_PAIR")
                    material.assert_called_once()
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

    def test_target_recovery_postcheck_and_rollback_failure_is_terminal_and_retry_fenced(self) -> None:
        state = {"phase": "ACTIVATION_INTENT"}
        writes: list[dict[str, object]] = []
        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value=state),
            mock.patch.object(self.runtime, "_pair", return_value=self.pair("new-g", "new-m")),
            mock.patch.object(self.runtime, "_postcheck", side_effect=RuntimeFault("TARGET_POSTCHECK_FAILED", 74)),
            mock.patch.object(self.runtime, "_rollback_pair", side_effect=RuntimeFault("ROLLBACK_POSTCHECK_FAILED", 74)),
            mock.patch.object(self.runtime, "_write_state", side_effect=lambda _core, value: writes.append(value)),
            mock.patch.object(self.runtime, "_audit") as audit,
        ):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._release_activate(self.core, {}, self.profile, self.invocation)
        self.assertEqual(raised.exception.code, "ACTIVATION_AND_AUTOMATIC_ROLLBACK_FAILED")
        self.assertEqual([value["phase"] for value in writes], ["ACTIVATION_FAILED", "ROLLBACK_INTENT", "ROLLBACK_FAILED"])
        self.assertEqual(audit.call_args_list[0].args[3], "target_postcheck_failed")
        self.assertEqual(audit.call_args_list[1].args[3], "target_rollback_intent")
        self.assertEqual(audit.call_args_list[2].args[3], "target_postcheck_and_rollback_failed")

        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value=writes[-1]),
            mock.patch.object(self.runtime, "_pair") as pair,
            mock.patch.object(self.runtime, "_compose_up") as compose,
        ):
            with self.assertRaises(RuntimeFault) as retry:
                self.runtime._release_activate(self.core, {}, self.profile, self.invocation)
        self.assertEqual(retry.exception.code, "RELEASE_PREFLIGHT_REQUIRED")
        pair.assert_not_called()
        compose.assert_not_called()

    def test_mixed_recovery_postcheck_failure_fences_both_vectors_and_callers(self) -> None:
        cases = (
            ("preflight", self.runtime._release_preflight, {"phase": "PREFLIGHTED"}),
            ("activate", self.runtime._release_activate, {"phase": "ACTIVATION_INTENT"}),
        )
        for caller, operation, state in cases:
            for observed in (self.pair("new-g", "old-m"), self.pair("old-g", "new-m")):
                with self.subTest(caller=caller, observed=observed):
                    writes: list[dict[str, object]] = []
                    invocation = SimpleNamespace(primitive=f"release-{caller}", resource=None, relative_path=None)
                    with (
                        mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
                        mock.patch.object(self.runtime, "_read_state", return_value=state),
                        mock.patch.object(self.runtime, "_pair", side_effect=[observed, observed]),
                        mock.patch.object(self.runtime, "_assert_rollback_material"),
                        mock.patch.object(self.runtime, "_compose_up") as compose,
                        mock.patch.object(self.runtime, "_postcheck", side_effect=RuntimeFault("ROLLBACK_POSTCHECK_FAILED", 74)),
                        mock.patch.object(self.runtime, "_write_state", side_effect=lambda _core, value: writes.append(value)),
                        mock.patch.object(self.runtime, "_audit") as audit,
                    ):
                        compose.side_effect = lambda *_args, **_kwargs: self.assertEqual(writes[-1]["phase"], "ROLLBACK_INTENT")
                        with self.assertRaises(RuntimeFault) as raised:
                            operation(self.core, {}, self.profile, invocation)
                    self.assertEqual(raised.exception.code, "ROLLBACK_POSTCHECK_FAILED")
                    self.assertEqual([value["phase"] for value in writes], ["ROLLBACK_INTENT", "ROLLBACK_FAILED"])
                    self.assertEqual([call.args[3] for call in audit.call_args_list], ["mixed_rollback_intent", "mixed_rollback_failed"])
                    compose.assert_called_once()
                    self.assertFalse(compose.call_args.kwargs["activate"])

                    with (
                        mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
                        mock.patch.object(self.runtime, "_read_state", return_value=writes[-1]),
                        mock.patch.object(self.runtime, "_pair") as pair,
                        mock.patch.object(self.runtime, "_compose_up") as retry_compose,
                    ):
                        with self.assertRaises(RuntimeFault) as retry:
                            self.runtime._release_activate(self.core, {}, self.profile, self.invocation)
                    self.assertEqual(retry.exception.code, "RELEASE_PREFLIGHT_REQUIRED")
                    pair.assert_not_called()
                    retry_compose.assert_not_called()

    def test_explicit_rollback_postcheck_failure_is_terminal_and_retry_fenced(self) -> None:
        state = {"phase": "ACTIVATED"}
        target_pair = self.pair("new-g", "new-m")
        writes: list[dict[str, object]] = []
        invocation = SimpleNamespace(primitive="rollback", resource=None, relative_path=None)
        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value=state),
            mock.patch.object(self.runtime, "_pair", side_effect=[target_pair, target_pair]),
            mock.patch.object(self.runtime, "_assert_rollback_material"),
            mock.patch.object(self.runtime, "_compose_up") as compose,
            mock.patch.object(self.runtime, "_postcheck", side_effect=RuntimeFault("ROLLBACK_POSTCHECK_FAILED", 74)),
            mock.patch.object(self.runtime, "_write_state", side_effect=lambda _core, value: writes.append(value)),
            mock.patch.object(self.runtime, "_audit") as audit,
        ):
            compose.side_effect = lambda *_args, **_kwargs: self.assertEqual(writes[-1]["phase"], "ROLLBACK_INTENT")
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._rollback(self.core, {}, self.profile, invocation)
        self.assertEqual(raised.exception.code, "ROLLBACK_POSTCHECK_FAILED")
        self.assertEqual([value["phase"] for value in writes], ["ROLLBACK_INTENT", "ROLLBACK_FAILED"])
        self.assertEqual([call.args[3] for call in audit.call_args_list], ["rollback_intent", "rollback_failed"])
        compose.assert_called_once()
        self.assertFalse(compose.call_args.kwargs["activate"])

        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value=writes[-1]),
            mock.patch.object(self.runtime, "_pair") as pair,
            mock.patch.object(self.runtime, "_compose_up") as retry_compose,
        ):
            with self.assertRaises(RuntimeFault) as retry:
                self.runtime._release_activate(self.core, {}, self.profile, self.invocation)
        self.assertEqual(retry.exception.code, "RELEASE_PREFLIGHT_REQUIRED")
        pair.assert_not_called()
        retry_compose.assert_not_called()

    def test_release_activate_fences_incomplete_or_failed_rollback_before_pair_inspection(self) -> None:
        for phase in ("ROLLBACK_INTENT", "ROLLBACK_FAILED"):
            with self.subTest(phase=phase):
                with (
                    mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
                    mock.patch.object(self.runtime, "_read_state", return_value={"phase": phase}),
                    mock.patch.object(self.runtime, "_pair") as pair,
                    mock.patch.object(self.runtime, "_compose_up") as compose,
                ):
                    with self.assertRaises(RuntimeFault) as raised:
                        self.runtime._release_activate(self.core, {}, self.profile, self.invocation)
                self.assertEqual(raised.exception.code, "RELEASE_PREFLIGHT_REQUIRED")
                pair.assert_not_called()
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
            mock.patch.object(self.runtime, "_image_inspect", return_value=None),
            mock.patch.object(self.runtime, "_archive_bytes", return_value=1024),
            mock.patch.object(self.runtime, "_storage_guard", return_value={"available_bytes": 9, "required_bytes": 8, "shortfall_bytes": 0}),
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


class ReleaseCapacityTests(unittest.TestCase):
    """B1 -- the free-space guard must be derived from real artifact sizes and fail closed."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.runtime = load_profile()

    def setUp(self) -> None:
        self.core = SimpleNamespace(RuntimeFault=RuntimeFault, mapped=lambda value: Path(value))
        self.profile = {
            "target": {"gravity": {"image_id": "new-g"}, "max_scraper": {"image_id": "new-m"}},
            "limits": {"minimum_free_bytes": 500, "image_load_expansion_permille": 2000, "image_load_timeout_seconds": 60},
            "artifact_admission": {"files": {
                "gravity-image.docker.tar": {"path": "/p/g", "sha256": "a" * 64, "bytes": 1000},
                "max-scraper-image.docker.tar": {"path": "/p/m", "sha256": "b" * 64, "bytes": 400},
            }},
        }

    def statvfs(self, *available: int):
        return mock.patch.object(
            self.runtime.os, "statvfs",
            side_effect=[SimpleNamespace(f_bavail=value, f_frsize=1) for value in available],
        )

    def test_projection_accounts_for_content_blob_and_unpacked_snapshot(self) -> None:
        with self.statvfs(10_000):
            projection = self.runtime._storage_projection(self.core, self.profile, [1000])
        # 1000 admitted archive bytes cost 2000 on disk at 2000 permille, plus the 500 reserve.
        self.assertEqual(projection["projected_load_bytes"], 2000)
        self.assertEqual(projection["required_bytes"], 2500)
        self.assertEqual(projection["pending_archive_bytes"], 1000)

    def test_guard_refuses_just_below_required_and_admits_at_the_exact_boundary(self) -> None:
        with self.statvfs(2499):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._storage_guard(self.core, self.profile, [1000], "gravity_image_load")
        self.assertEqual(raised.exception.code, "INSUFFICIENT_RELEASE_STORAGE")
        self.assertEqual(raised.exception.details["shortfall_bytes"], 1)
        self.assertEqual(raised.exception.details["stage"], "gravity_image_load")

        with self.statvfs(2500):
            boundary = self.runtime._storage_guard(self.core, self.profile, [1000], "gravity_image_load")
        self.assertEqual(boundary["shortfall_bytes"], 0)

        with self.statvfs(9001):
            ample = self.runtime._storage_guard(self.core, self.profile, [1000], "gravity_image_load")
        self.assertEqual(ample["available_bytes"], 9001)

    def test_guard_requires_room_for_every_archive_still_pending(self) -> None:
        # 1000 + 400 admitted bytes -> 2800 on disk, plus 500 reserve.
        with self.statvfs(3299):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._storage_guard(self.core, self.profile, [1000, 400], "gravity_image_load")
        self.assertEqual(raised.exception.details["required_bytes"], 3300)
        with self.statvfs(3300):
            self.runtime._storage_guard(self.core, self.profile, [1000, 400], "gravity_image_load")

    def test_invalid_or_missing_storage_limits_fail_closed(self) -> None:
        for limits in ({"minimum_free_bytes": 500}, {"minimum_free_bytes": 500, "image_load_expansion_permille": 999}):
            with self.subTest(limits=limits):
                with self.assertRaises(RuntimeFault) as raised:
                    self.runtime._storage_projection(self.core, {**self.profile, "limits": limits}, [1])
                self.assertEqual(raised.exception.code, "STORAGE_LIMITS_INVALID")

    def test_load_target_refuses_before_docker_load_when_capacity_is_insufficient(self) -> None:
        with (
            mock.patch.object(self.runtime, "_image_inspect", return_value=None),
            mock.patch.object(self.runtime, "_artifact_path") as artifact_path,
            mock.patch.object(self.runtime, "_run") as run,
            self.statvfs(2499),
        ):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._load_target(
                    self.core, self.profile, "gravity", "gravity-image.docker.tar", "ref",
                )
        self.assertEqual(raised.exception.code, "INSUFFICIENT_RELEASE_STORAGE")
        artifact_path.assert_not_called()
        run.assert_not_called()

    def test_second_image_load_is_refused_when_capacity_drops_after_the_first(self) -> None:
        loaded: list[str] = []

        # First guard sees room for both archives; a foreign consumer then takes the space.
        with (
            mock.patch.object(self.runtime, "_image_inspect", return_value=None),
            mock.patch.object(self.runtime, "_artifact_path", side_effect=lambda *a, **k: Path("/dev/null")),
            mock.patch.object(self.runtime, "_validate_target_image", side_effect=lambda *a, **k: {"Id": "x"}),
            mock.patch.object(self.runtime, "_run", side_effect=lambda *a, **k: loaded.append(a[1][2])),
            self.statvfs(3300, 900),
        ):
            self.runtime._load_target(
                self.core, self.profile, "gravity", "gravity-image.docker.tar", "ref-g",
                remaining_bytes=[400],
            )
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._load_target(
                    self.core, self.profile, "max", "max-scraper-image.docker.tar", "ref-m",
                )
        self.assertEqual(raised.exception.code, "INSUFFICIENT_RELEASE_STORAGE")
        # 400 admitted bytes -> 800 on disk + 500 reserve = 1300 required against 900 available.
        self.assertEqual(raised.exception.details["required_bytes"], 1300)
        self.assertEqual(len(loaded), 1)

    def test_reserve_floor_is_enforced_even_when_both_target_images_are_already_loaded(self) -> None:
        """A re-preflight that loads nothing must still be refused on a full filesystem."""
        core = SimpleNamespace(
            RuntimeFault=RuntimeFault,
            audit_status=lambda: {"state": "VALID"},
            now=lambda: "2026-09-09T00:00:00Z",
            mapped=lambda value: Path(value),
        )
        profile = {
            **self.profile,
            "predecessor": {"gravity": {"image_id": "old-g"}, "max_scraper": {"image_id": "old-m"}},
        }
        profile["artifact_admission"]["receipt_sha256"] = "r" * 64
        writes: list[dict[str, object]] = []
        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value={"phase": "ROLLED_BACK"}),
            mock.patch.object(self.runtime, "_pair", return_value=({"image_id": "old-g"}, {"image_id": "old-m"})),
            mock.patch.object(self.runtime, "_predecessor_identity", return_value={}),
            mock.patch.object(self.runtime, "_artifact_receipt", return_value={"files": {}}),
            # Both target images already present -> nothing to load, so nothing is pending.
            mock.patch.object(self.runtime, "_image_inspect", return_value={"Id": "present"}),
            mock.patch.object(self.runtime, "_load_target") as load_target,
            mock.patch.object(self.runtime, "_seal_rollback_reference") as seal,
            mock.patch.object(self.runtime, "_compose_up") as compose,
            mock.patch.object(self.runtime, "_write_state", side_effect=lambda _c, value: writes.append(value)),
            mock.patch.object(self.runtime, "_audit"),
            self.statvfs(499),
        ):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._release_preflight(core, {}, profile, SimpleNamespace(
                    primitive="release-preflight", resource=None, relative_path=None))
        self.assertEqual(raised.exception.code, "INSUFFICIENT_RELEASE_STORAGE")
        # required == the bare reserve when no archive is pending
        self.assertEqual(raised.exception.details["required_bytes"], 500)
        self.assertEqual(raised.exception.details["stage"], "preflight")
        load_target.assert_not_called()
        seal.assert_not_called()
        compose.assert_not_called()
        self.assertEqual(writes, [])

    def test_post_load_reserve_is_enforced_not_merely_reported(self) -> None:
        """Preflight must never return PREFLIGHTED while carrying a nonzero shortfall."""
        core = SimpleNamespace(
            RuntimeFault=RuntimeFault,
            audit_status=lambda: {"state": "VALID"},
            now=lambda: "2026-09-09T00:00:00Z",
            mapped=lambda value: Path(value),
        )
        profile = {
            **self.profile,
            "predecessor": {"gravity": {"image_id": "old-g"}, "max_scraper": {"image_id": "old-m"}},
        }
        profile["artifact_admission"]["receipt_sha256"] = "r" * 64
        writes: list[dict[str, object]] = []
        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value={"phase": "UNINITIALIZED"}),
            mock.patch.object(self.runtime, "_pair", return_value=({"image_id": "old-g"}, {"image_id": "old-m"})),
            mock.patch.object(self.runtime, "_predecessor_identity", return_value={}),
            mock.patch.object(self.runtime, "_artifact_receipt", return_value={"files": {}}),
            mock.patch.object(self.runtime, "_image_inspect", return_value=None),
            mock.patch.object(self.runtime, "_load_target", side_effect=[{"Id": "new-g"}, {"Id": "new-m"}]),
            mock.patch.object(self.runtime, "_seal_rollback_reference") as seal,
            mock.patch.object(self.runtime, "_compose_up") as compose,
            mock.patch.object(self.runtime, "_write_state", side_effect=lambda _c, value: writes.append(value)),
            mock.patch.object(self.runtime, "_audit"),
            # first guard admits (needs 3300), post-load measurement falls under the reserve
            self.statvfs(3300, 499),
        ):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._release_preflight(core, {}, profile, SimpleNamespace(
                    primitive="release-preflight", resource=None, relative_path=None))
        self.assertEqual(raised.exception.code, "INSUFFICIENT_RELEASE_STORAGE")
        self.assertEqual(raised.exception.details["stage"], "post_load")
        seal.assert_not_called()
        compose.assert_not_called()
        self.assertEqual(writes, [])

    def test_capacity_failure_during_preflight_performs_no_compose_activation(self) -> None:
        writes: list[dict[str, object]] = []
        core = SimpleNamespace(
            RuntimeFault=RuntimeFault,
            audit_status=lambda: {"state": "VALID"},
            now=lambda: "2026-09-09T00:00:00Z",
            mapped=lambda value: Path(value),
        )
        profile = {
            **self.profile,
            "predecessor": {"gravity": {"image_id": "old-g"}, "max_scraper": {"image_id": "old-m"}},
            "target": {"gravity": {"image_id": "new-g"}, "max_scraper": {"image_id": "new-m"}},
        }
        profile["artifact_admission"]["receipt_sha256"] = "r" * 64
        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value={"phase": "UNINITIALIZED"}),
            mock.patch.object(self.runtime, "_pair", return_value=({"image_id": "old-g"}, {"image_id": "old-m"})),
            mock.patch.object(self.runtime, "_predecessor_identity", return_value={}),
            mock.patch.object(self.runtime, "_artifact_receipt", return_value={"files": {}}),
            mock.patch.object(self.runtime, "_image_inspect", return_value=None),
            mock.patch.object(
                self.runtime, "_load_target",
                side_effect=RuntimeFault("INSUFFICIENT_RELEASE_STORAGE", 75),
            ),
            mock.patch.object(self.runtime, "_seal_rollback_reference") as seal,
            mock.patch.object(self.runtime, "_compose_up") as compose,
            mock.patch.object(self.runtime, "_write_state", side_effect=lambda _c, value: writes.append(value)),
            mock.patch.object(self.runtime, "_audit"),
            self.statvfs(10_000_000),
        ):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._release_preflight(core, {}, profile, SimpleNamespace(
                    primitive="release-preflight", resource=None, relative_path=None))
        self.assertEqual(raised.exception.code, "INSUFFICIENT_RELEASE_STORAGE")
        compose.assert_not_called()
        seal.assert_not_called()
        self.assertEqual(writes, [])


class PredecessorRetryTests(unittest.TestCase):
    """B2 -- a safe rollback must leave the release retryable without weakening identity."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.runtime = load_profile()

    def setUp(self) -> None:
        self.core = SimpleNamespace(
            RuntimeFault=RuntimeFault,
            audit_status=lambda: {"state": "VALID"},
            now=lambda: "2026-09-09T00:00:00Z",
        )
        self.profile = {
            "predecessor": {
                "gravity": {"image_id": "old-g", "container_id": "cg0", "compose_config_hash": "hg0"},
                "max_scraper": {"image_id": "old-m", "container_id": "cm0", "compose_config_hash": "hm0"},
                "unrelated_semantic_fingerprint_sha256": "u" * 64,
            },
            "target": {"gravity": {"image_id": "new-g"}, "max_scraper": {"image_id": "new-m"}},
        }

    @staticmethod
    def container(image: str, container_id: str, config_hash: str, **overrides):
        record = {
            "image_id": image,
            "container_id": container_id,
            "compose_labels": {"com.docker.compose.config-hash": config_hash},
            "running": True,
            "health": "healthy",
            "restart_count": 0,
            "semantic": {"name": container_id},
        }
        record.update(overrides)
        return record

    def identity(self, gravity, maximum, state):
        with (
            mock.patch.object(self.runtime, "_pair", return_value=(gravity, maximum)),
            mock.patch.object(self.runtime, "_max_volume_exact"),
            mock.patch.object(self.runtime, "_database_status", return_value={
                "state": "EXACT", "database_identity_sha256": "d" * 64, "migration_rows_sha256": "m" * 64}),
            mock.patch.object(self.runtime, "_unrelated_fingerprint", return_value="u" * 64),
            mock.patch.object(self.runtime, "_secure_compose_inputs", return_value=(None, Path("/env"))),
            mock.patch.object(self.runtime, "_sha_file", return_value="e" * 64),
        ):
            return self.runtime._predecessor_identity(self.core, {}, self.profile, state)

    def test_sealed_predecessor_instance_is_accepted(self) -> None:
        result = self.identity(
            self.container("old-g", "cg0", "hg0"), self.container("old-m", "cm0", "hm0"), {"phase": "UNINITIALIZED"}
        )
        self.assertEqual(result["environment_sha256"], "e" * 64)

    def test_instance_recorded_by_our_own_rollback_is_accepted_for_a_fresh_preflight(self) -> None:
        state = {
            "phase": "ROLLED_BACK",
            "predecessor_instance": {
                "gravity": {"container_id": "cg1", "compose_config_hash": "hg1"},
                "max_scraper": {"container_id": "cm1", "compose_config_hash": "hm1"},
            },
        }
        result = self.identity(
            self.container("old-g", "cg1", "hg1"), self.container("old-m", "cm1", "hm1"), state
        )
        self.assertEqual(result["unrelated_semantic_fingerprint_sha256"], "u" * 64)

    def test_unrecorded_container_instance_is_still_rejected(self) -> None:
        with self.assertRaises(RuntimeFault) as raised:
            self.identity(
                self.container("old-g", "cg9", "hg9"), self.container("old-m", "cm0", "hm0"), {"phase": "ROLLED_BACK"}
            )
        self.assertEqual(raised.exception.code, "GRAVITY_PREDECESSOR_IDENTITY_DRIFT")

    def test_recorded_instance_is_not_honoured_outside_the_rolled_back_phase(self) -> None:
        state = {
            "phase": "PREFLIGHTED",
            "predecessor_instance": {
                "gravity": {"container_id": "cg1", "compose_config_hash": "hg1"},
                "max_scraper": {"container_id": "cm1", "compose_config_hash": "hm1"},
            },
        }
        with self.assertRaises(RuntimeFault) as raised:
            self.identity(self.container("old-g", "cg1", "hg1"), self.container("old-m", "cm1", "hm1"), state)
        self.assertEqual(raised.exception.code, "GRAVITY_PREDECESSOR_IDENTITY_DRIFT")

    def test_immutable_identity_is_not_weakened_by_the_ephemeral_allowance(self) -> None:
        state = {
            "phase": "ROLLED_BACK",
            "predecessor_instance": {
                "gravity": {"container_id": "cg1", "compose_config_hash": "hg1"},
                "max_scraper": {"container_id": "cm1", "compose_config_hash": "hm1"},
            },
        }
        cases = {
            "wrong image fails closed as an unknown pair": (
                self.container("foreign", "cg1", "hg1"), self.container("old-m", "cm1", "hm1"),
                "PREDECESSOR_PAIR_REQUIRED",
            ),
            "target image fails closed as a mixed pair": (
                self.container("new-g", "cg1", "hg1"), self.container("old-m", "cm1", "hm1"),
                "PREDECESSOR_PAIR_REQUIRED",
            ),
            "unhealthy container is rejected": (
                self.container("old-g", "cg1", "hg1", health="starting"), self.container("old-m", "cm1", "hm1"),
                "GRAVITY_PREDECESSOR_IDENTITY_DRIFT",
            ),
            "restarted container is rejected": (
                self.container("old-g", "cg1", "hg1"), self.container("old-m", "cm1", "hm1", restart_count=2),
                "MAX_PREDECESSOR_IDENTITY_DRIFT",
            ),
        }
        for label, (gravity, maximum, expected) in cases.items():
            with self.subTest(label=label):
                with self.assertRaises(RuntimeFault) as raised:
                    self.identity(gravity, maximum, state)
                self.assertEqual(raised.exception.code, expected)

    def test_no_op_rollback_does_not_widen_the_accepted_instance_set(self) -> None:
        rollback = {
            "pair_state": "PREDECESSOR_PAIR",
            "gravity_container_id": "cg9", "gravity_compose_config_hash": "hg9",
            "max_container_id": "cm9", "max_compose_config_hash": "hm9",
        }
        with (
            mock.patch.object(self.runtime, "_rollback_pair", return_value=(rollback, False)),
            mock.patch.object(self.runtime, "_write_state"),
            mock.patch.object(self.runtime, "_audit"),
        ):
            _, mutated, recorded = self.runtime._rollback_with_fencing(
                self.core, {}, self.profile, SimpleNamespace(primitive="rollback"), {"phase": "ACTIVATED"},
                intent_result="rollback_intent", failure_result="rollback_failed",
            )
        self.assertFalse(mutated)
        self.assertNotIn("predecessor_instance", recorded)
        with self.assertRaises(RuntimeFault) as raised:
            self.identity(
                self.container("old-g", "cg9", "hg9"), self.container("old-m", "cm9", "hm9"),
                {**recorded, "phase": "ROLLED_BACK"},
            )
        self.assertEqual(raised.exception.code, "GRAVITY_PREDECESSOR_IDENTITY_DRIFT")

    def test_no_op_rollback_carries_forward_an_earlier_recorded_instance(self) -> None:
        earlier = {
            "gravity": {"container_id": "cg1", "compose_config_hash": "hg1"},
            "max_scraper": {"container_id": "cm1", "compose_config_hash": "hm1"},
        }
        with (
            mock.patch.object(self.runtime, "_rollback_pair", return_value=({"pair_state": "PREDECESSOR_PAIR"}, False)),
            mock.patch.object(self.runtime, "_write_state"),
            mock.patch.object(self.runtime, "_audit"),
        ):
            _, _, recorded = self.runtime._rollback_with_fencing(
                self.core, {}, self.profile, SimpleNamespace(primitive="rollback"),
                {"phase": "ROLLED_BACK", "predecessor_instance": earlier},
                intent_result="rollback_intent", failure_result="rollback_failed",
            )
        self.assertEqual(recorded["predecessor_instance"], earlier)

    def test_rollback_records_the_instance_it_created_so_the_next_preflight_can_bind(self) -> None:
        rollback = {
            "pair_state": "PREDECESSOR_PAIR",
            "gravity_container_id": "cg1",
            "gravity_compose_config_hash": "hg1",
            "max_container_id": "cm1",
            "max_compose_config_hash": "hm1",
        }
        with (
            mock.patch.object(self.runtime, "_rollback_pair", return_value=(rollback, True)),
            mock.patch.object(self.runtime, "_write_state"),
            mock.patch.object(self.runtime, "_audit"),
            mock.patch.object(self.runtime, "_log_evidence", return_value={"path": "/rollback.log"}),
        ):
            _, mutated, recorded = self.runtime._rollback_with_fencing(
                self.core, {}, self.profile, SimpleNamespace(primitive="rollback"), {"phase": "ACTIVATION_FAILED"},
                intent_result="activation_rollback_intent", failure_result="activation_and_rollback_failed",
            )
        self.assertTrue(mutated)
        self.assertEqual(recorded["predecessor_instance"], {
            "gravity": {"container_id": "cg1", "compose_config_hash": "hg1"},
            "max_scraper": {"container_id": "cm1", "compose_config_hash": "hm1"},
        })
        # And that recorded instance is exactly what a fresh preflight will accept.
        result = self.identity(
            self.container("old-g", "cg1", "hg1"),
            self.container("old-m", "cm1", "hm1"),
            {**recorded, "phase": "ROLLED_BACK"},
        )
        self.assertEqual(result["database"]["state"], "EXACT")


class RollbackImageIdentityTests(unittest.TestCase):
    """B3 -- rollback must resolve its mutable tags to the authorised predecessor image ids."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.runtime = load_profile()

    def setUp(self) -> None:
        self.core = SimpleNamespace(RuntimeFault=RuntimeFault)
        self.profile = {
            "predecessor": {"gravity": {"image_id": "old-g"}, "max_scraper": {"image_id": "old-m"}},
            "target": {"gravity": {"image_id": "new-g"}, "max_scraper": {"image_id": "new-m"}},
        }

    def test_exact_predecessor_images_are_accepted(self) -> None:
        with mock.patch.object(self.runtime, "_image_inspect", side_effect=[{"Id": "old-g"}, {"Id": "old-m"}]):
            resolved = self.runtime._assert_rollback_material(self.core, self.profile)
        self.assertEqual(resolved, {"gravity_image_id": "old-g", "max_image_id": "old-m"})

    def test_tag_resolving_to_a_different_image_is_refused(self) -> None:
        with mock.patch.object(self.runtime, "_image_inspect", return_value={"Id": "someone-elses"}):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._assert_rollback_material(self.core, self.profile)
        self.assertEqual(raised.exception.code, "GRAVITY_ROLLBACK_REFERENCE_DRIFT")
        self.assertEqual(raised.exception.details["expected_image_id"], "old-g")

    def test_missing_or_pruned_predecessor_image_is_refused(self) -> None:
        with mock.patch.object(self.runtime, "_image_inspect", return_value=None):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._assert_rollback_material(self.core, self.profile)
        self.assertEqual(raised.exception.code, "GRAVITY_ROLLBACK_IMAGE_MISSING")

    def test_max_side_is_validated_independently(self) -> None:
        with mock.patch.object(self.runtime, "_image_inspect", side_effect=[{"Id": "old-g"}, None]):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._assert_rollback_material(self.core, self.profile)
        self.assertEqual(raised.exception.code, "MAX_ROLLBACK_IMAGE_MISSING")

    def test_no_compose_rollback_runs_after_a_rollback_identity_failure(self) -> None:
        with (
            mock.patch.object(self.runtime, "_pair", return_value=({"image_id": "new-g"}, {"image_id": "new-m"})),
            mock.patch.object(self.runtime, "_image_inspect", return_value=None),
            mock.patch.object(self.runtime, "_compose_up") as compose,
            mock.patch.object(self.runtime, "_postcheck") as postcheck,
        ):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._rollback_pair(self.core, {}, self.profile, {})
        self.assertEqual(raised.exception.code, "GRAVITY_ROLLBACK_IMAGE_MISSING")
        compose.assert_not_called()
        postcheck.assert_not_called()

    def test_no_registry_pull_is_introduced_as_a_fallback(self) -> None:
        source = (ROOT / "templates/crm-activation-profile.py.in").read_text()
        self.assertNotIn('"pull"', source.replace('"--pull", "never"', ""))
        self.assertIn('"--pull", "never"', source)


class ActivationDiagnosticsTests(unittest.TestCase):
    """B4 -- the rollback must not destroy the evidence of the activation that failed."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.runtime = load_profile()

    def test_activation_and_rollback_logs_are_separate_files(self) -> None:
        self.assertNotEqual(self.runtime.ACTIVATE_COMPOSE_LOG, self.runtime.ROLLBACK_COMPOSE_LOG)
        self.assertEqual(self.runtime._compose_log_path(True), self.runtime.ACTIVATE_COMPOSE_LOG)
        self.assertEqual(self.runtime._compose_log_path(False), self.runtime.ROLLBACK_COMPOSE_LOG)

    def test_failed_activation_evidence_survives_the_automatic_rollback(self) -> None:
        import hashlib
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            activation_text = b"gravity-mvp failed to become healthy\n"
            rollback_text = b"rollback recreated the predecessor pair\n"
            core = SimpleNamespace(
                RuntimeFault=RuntimeFault,
                audit_status=lambda: {"state": "VALID"},
                now=lambda: "2026-09-09T00:00:00Z",
                mapped=lambda value: root / Path(value).name,
            )
            profile = {
                "predecessor": {"gravity": {"image_id": "old-g"}, "max_scraper": {"image_id": "old-m"}},
                "target": {"gravity": {"image_id": "new-g"}, "max_scraper": {"image_id": "new-m"}},
            }
            writes: list[dict[str, object]] = []

            def activation_attempt(*_args, **_kwargs):
                (root / Path(self.runtime.ACTIVATE_COMPOSE_LOG).name).write_bytes(activation_text)
                raise RuntimeFault("PAIR_COMPOSE_ACTIVATION_FAILED", 74)

            def rollback_attempt(*_args, **_kwargs):
                (root / Path(self.runtime.ROLLBACK_COMPOSE_LOG).name).write_bytes(rollback_text)
                return {
                    "pair_state": "PREDECESSOR_PAIR",
                    "gravity_container_id": "cg1", "gravity_compose_config_hash": "hg1",
                    "max_container_id": "cm1", "max_compose_config_hash": "hm1",
                }, True

            with (
                mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
                mock.patch.object(self.runtime, "_read_state", return_value={"phase": "PREFLIGHTED"}),
                mock.patch.object(self.runtime, "_pair", return_value=({"image_id": "old-g"}, {"image_id": "old-m"})),
                mock.patch.object(self.runtime, "_validate_compose_inputs"),
                mock.patch.object(self.runtime, "_validate_target_image"),
                mock.patch.object(self.runtime, "_compose_up", side_effect=activation_attempt),
                mock.patch.object(self.runtime, "_rollback_pair", side_effect=rollback_attempt),
                mock.patch.object(self.runtime, "_write_state", side_effect=lambda _c, value: writes.append(value)),
                mock.patch.object(self.runtime, "_audit"),
            ):
                with self.assertRaises(RuntimeFault) as raised:
                    self.runtime._release_activate(core, {}, profile, SimpleNamespace(
                        primitive="release-activate", resource=None, relative_path=None))

            self.assertEqual(raised.exception.code, "ACTIVATION_FAILED_AUTOMATIC_ROLLBACK_OK")
            terminal = writes[-1]
            self.assertEqual(terminal["phase"], "ROLLED_BACK")

            activation = terminal["activation_diagnostics"]
            rollback = terminal["rollback_diagnostics"]
            # Diagnostic A and diagnostic B are recorded independently...
            self.assertNotEqual(activation["path"], rollback["path"])
            self.assertEqual(activation["sha256"], hashlib.sha256(activation_text).hexdigest())
            self.assertEqual(rollback["sha256"], hashlib.sha256(rollback_text).hexdigest())
            self.assertEqual(activation["bytes"], len(activation_text))
            # ...and both transcripts still exist on disk after the rollback completed.
            self.assertEqual((root / Path(self.runtime.ACTIVATE_COMPOSE_LOG).name).read_bytes(), activation_text)
            self.assertEqual((root / Path(self.runtime.ROLLBACK_COMPOSE_LOG).name).read_bytes(), rollback_text)

    def test_evidence_capture_never_breaks_the_fencing_write(self) -> None:
        core = SimpleNamespace(RuntimeFault=RuntimeFault, mapped=mock.Mock(side_effect=OSError("gone")))
        evidence = self.runtime._log_evidence(core, "/missing.log", "2026-09-09T00:00:00Z")
        self.assertEqual(evidence["path"], "/missing.log")
        self.assertIsNone(evidence["sha256"])
        self.assertIsNone(evidence["bytes"])


if __name__ == "__main__":
    unittest.main()
