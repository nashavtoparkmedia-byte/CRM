#!/usr/bin/python3
from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
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


def load_runtime():
    loader = importlib.machinery.SourceFileLoader(
        "yoko_runtime_transition_identity_model",
        str(ROOT / "src/crm-activation-profile.py"),
    )
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    loader.exec_module(module)
    return module


class FixtureCore:
    RuntimeFault = RuntimeFault
    Invocation = staticmethod(lambda primitive, resource: SimpleNamespace(primitive=primitive, resource=resource))

    def __init__(self, profile: dict[str, object]) -> None:
        prestate = profile["pre_activation_live_prestate"]
        invariants = profile["transition_invariants"]
        self.projections = {
            "crm.container.gravity_mvp": {
                "container_id": prestate["gravity_container_id"],
                "image_id": prestate["gravity_image_id"],
                "running": True,
                "health": "healthy",
                "restart_count": 0,
                "compose_labels": {
                    "com.docker.compose.config-hash": prestate["gravity_compose_config_hash"],
                },
                "semantic": {
                    "image_id": prestate["gravity_image_id"],
                    "command": ["sh", "-c", "predecessor"],
                    "compose_labels": {
                        "com.docker.compose.config-hash": prestate["gravity_compose_config_hash"],
                        "com.docker.compose.project": "crm",
                        "com.docker.compose.service": "gravity-mvp",
                    },
                },
            },
            "crm.container.telegram_bot": {
                "container_id": prestate["tg_bot_container_id"],
                "image_id": prestate["tg_bot_image_id"],
                "running": True,
                "health": "healthy",
                "restart_count": 0,
                "compose_labels": {
                    "com.docker.compose.config-hash": prestate["tg_bot_compose_config_hash"],
                },
                "entrypoint": invariants["tg_bot_entrypoint"],
                "cmd": invariants["tg_bot_cmd"],
                "declared_user": invariants["tg_bot_declared_user"],
                "working_dir": invariants["tg_bot_working_dir"],
                "semantic": {
                    "image_id": prestate["tg_bot_image_id"],
                    "command": invariants["tg_bot_cmd"],
                    "compose_labels": {
                        "com.docker.compose.config-hash": prestate["tg_bot_compose_config_hash"],
                        "com.docker.compose.project": "crm",
                        "com.docker.compose.service": "tg-bot",
                    },
                },
            },
        }

    def container_projection(self, _policy, resource):
        return self.projections[resource]

    def tree_manifest(self, _policy, _invocation):
        return {"manifest_sha256": "3" * 64}


class TransitionIdentityModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.runtime = load_runtime()

    def profile(self) -> dict[str, object]:
        return {
            "deployment": {
                "compose_path": "/compose.yml",
                "environment_path": "/environment",
                "compose_project": "crm",
                "compose_service": "gravity-mvp",
                "tg_bot_compose_service": "tg-bot",
                "gravity_container": "crm-gravity-mvp",
                "tg_bot_container": "crm-tg-bot",
                "postgres_container": "crm-postgres",
                "network": "crm_internal",
            },
            "transition_invariants": {
                "compose_sha256": "2" * 64,
                "tg_bot_entrypoint": ["/usr/bin/tini", "--", "/usr/local/bin/tg-bot-entrypoint"],
                "tg_bot_cmd": ["node", "start.js"],
                "tg_bot_declared_user": "",
                "tg_bot_working_dir": "/app",
                "tg_bot_patch_uid": 0,
                "tg_bot_patch_gid": 0,
                "tg_bot_patch_mode": "0644",
                "tg_bot_patch_baseline_state": "ABSENT",
                "tg_bot_patch_baseline_manifest_file_sha256": "4" * 64,
                "tg_bot_patch_baseline_manifest_sha256": "5" * 64,
                "postgres_container_id": "6" * 64,
                "postgres_image_id": "sha256:" + "7" * 64,
            },
            "pre_activation_live_prestate": {
                "authority": "INDEPENDENTLY_ACCEPTED_CURRENT_PREDECESSOR",
                "predecessor_release_critical_identity_sha256": "8" * 64,
                "source_manifest_sha256": "3" * 64,
                "gravity_container_id": "9" * 64,
                "gravity_image_id": "sha256:" + "a" * 64,
                "gravity_compose_config_hash": "b" * 64,
                "tg_bot_container_id": "c" * 64,
                "tg_bot_image_id": "sha256:" + "d" * 64,
                "tg_bot_compose_config_hash": "e" * 64,
            },
            "post_activation_target": {
                "authority": "SEALED_CANDIDATE_DERIVED",
                "compose_config_hash_binding": "DERIVED_FROM_EXACT_SEALED_ACTIVATION_OVERLAY_DURING_PREFLIGHT",
                "gravity_image_reference": self.runtime.TARGET_TAG,
                "gravity_command": ["npm", "run", "start"],
                "tg_bot_image_reference": self.runtime.TG_TARGET_TAG,
                "tg_bot_patch_sha256": self.runtime.TG_PATCH_TARGET_SHA256,
            },
            "rollback_recovery": {
                "authority": "EXACT_ACCEPTED_PRE_ACTIVATION_PREDECESSOR",
                "gravity_image_reference": self.runtime.ROLLBACK_TAG,
                "gravity_image_id": "sha256:" + "a" * 64,
                "gravity_compose_config_hash": "b" * 64,
                "tg_bot_image_reference": self.runtime.TG_ROLLBACK_TAG,
                "tg_bot_image_id": "sha256:" + "d" * 64,
                "tg_bot_compose_config_hash": "e" * 64,
                "database_identity_sha256": "f" * 64,
                "migration_ledger_sha256": "1" * 64,
            },
            "accepted_source": {"tg_bot_patch_size": 1},
        }

    def test_schema_has_three_non_aliasing_transition_domains(self) -> None:
        profile = json.loads((ROOT / "templates/profile.v1.json.in").read_text(encoding="ascii"))
        self.assertEqual(profile["schema"], "yoko.crm.activation-profile.v2")
        self.assertNotIn("production", profile)
        self.assertNotIn("recovery", profile)
        self.assertIn("pre_activation_live_prestate", profile)
        self.assertIn("post_activation_target", profile)
        self.assertIn("rollback_recovery", profile)
        self.assertNotIn("gravity_compose_config_hash", profile["post_activation_target"])
        self.assertNotEqual(
            id(profile["pre_activation_live_prestate"]),
            id(profile["rollback_recovery"]),
        )

    def test_preflight_accepts_predecessor_when_target_is_deliberately_different(self) -> None:
        profile = self.profile()
        core = FixtureCore(profile)
        with (
            mock.patch.object(self.runtime, "_secure_host_file", side_effect=[Path("/compose"), Path("/env")]),
            mock.patch.object(self.runtime, "_sha_file", side_effect=["2" * 64, "0" * 64]),
            mock.patch.object(self.runtime, "_tg_patch_file_probe", return_value={"state": "ABSENT"}),
            mock.patch.object(self.runtime, "_postgres_identity", return_value={"database_identity_sha256": "f" * 64}),
            mock.patch.object(self.runtime, "_unrelated_runtime_identity", return_value={"unrelated": "exact"}),
        ):
            identity = self.runtime._production_preflight_identity(core, {}, profile)
        self.assertEqual(identity["gravity_semantic"]["compose_labels"]["com.docker.compose.config-hash"], "b" * 64)
        self.assertEqual(identity["tg_bot_semantic"]["compose_labels"]["com.docker.compose.config-hash"], "e" * 64)
        self.assertNotIn("post_activation_target", identity)

    def test_wrong_predecessor_hash_fails_before_any_mutation(self) -> None:
        profile = self.profile()
        core = FixtureCore(profile)
        core.projections["crm.container.gravity_mvp"]["compose_labels"]["com.docker.compose.config-hash"] = "0" * 64
        with (
            mock.patch.object(self.runtime, "_secure_host_file", side_effect=[Path("/compose"), Path("/env")]),
            mock.patch.object(self.runtime, "_sha_file", return_value="2" * 64),
        ):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._production_preflight_identity(core, {}, profile)
        self.assertEqual(raised.exception.code, "PRODUCTION_GRAVITY_IDENTITY_DRIFT")

    def test_target_and_recovery_hashes_are_derived_into_distinct_state_domains(self) -> None:
        profile = self.profile()
        state = {"pre_activation_live_identity": {"environment_sha256": "0" * 64}}
        with (
            mock.patch.object(self.runtime, "_validate_production_compose_inputs"),
            mock.patch.object(self.runtime, "_write_fixed_file"),
            mock.patch.object(self.runtime, "_compose_overlay", return_value=b"services: {}\n"),
            mock.patch.object(self.runtime, "_validate_dual_compose_projection"),
            mock.patch.object(
                self.runtime, "_compose_service_hash",
                side_effect=["1" * 64, "2" * 64, "b" * 64, "e" * 64],
            ),
        ):
            domains = self.runtime._derive_transition_identity_domains(SimpleNamespace(), profile, state)
        self.assertEqual(domains["post_activation_target_identity"]["gravity_compose_config_hash"], "1" * 64)
        self.assertEqual(domains["rollback_recovery_identity"]["gravity_compose_config_hash"], "b" * 64)
        self.assertNotEqual(
            domains["post_activation_target_identity"]["gravity_compose_config_hash"],
            domains["rollback_recovery_identity"]["gravity_compose_config_hash"],
        )

    def test_compose_hash_uses_resolved_in_memory_projection(self) -> None:
        resolved = {
            "name": "crm",
            "services": {
                "gravity-mvp": {
                    "environment": {"SERVICE_SECRET": "resolved-but-never-emitted"},
                    "image": self.runtime.ROLLBACK_TAG,
                },
            },
        }
        observed: dict[str, object] = {}

        def run(_core, args, **kwargs):
            observed["args"] = args
            observed["stdin"] = os.read(kwargs["stdin_fd"], 4 * 1024 * 1024)
            return SimpleNamespace(stdout=("gravity-mvp " + "b" * 64 + "\n").encode("ascii"))

        core = SimpleNamespace(RuntimeFault=RuntimeFault)
        original_args = [self.runtime.DOCKER, "compose", "--env-file", "/environment", "-f", "/compose"]
        with (
            mock.patch.object(self.runtime, "_compose_config_json", return_value=resolved),
            mock.patch.object(self.runtime, "_required_success", side_effect=run),
        ):
            value = self.runtime._compose_service_hash(core, original_args, "gravity-mvp")
        self.assertEqual(value, "b" * 64)
        self.assertEqual(
            observed["args"],
            [self.runtime.DOCKER, "compose", "-f", "-", "config", "--hash", "gravity-mvp"],
        )
        self.assertEqual(observed["stdin"], self.runtime._canonical(resolved))
        self.assertNotIn(b"resolved-but-never-emitted", " ".join(observed["args"]).encode("ascii"))

    def test_compose_hash_rejects_oversized_resolved_projection_before_subprocess(self) -> None:
        core = SimpleNamespace(RuntimeFault=RuntimeFault)
        oversized = {"services": {"gravity-mvp": {"environment": {"VALUE": "x" * (4 * 1024 * 1024)}}}}
        with (
            mock.patch.object(self.runtime, "_compose_config_json", return_value=oversized),
            mock.patch.object(self.runtime, "_required_success") as execute,
            self.assertRaises(RuntimeFault) as raised,
        ):
            self.runtime._compose_service_hash(core, [self.runtime.DOCKER, "compose"], "gravity-mvp")
        self.assertEqual(raised.exception.code, "TRANSITION_COMPOSE_HASH_DERIVATION_INVALID")
        execute.assert_not_called()

    def test_prestate_target_alias_is_rejected(self) -> None:
        profile = self.profile()
        with (
            mock.patch.object(self.runtime, "_validate_production_compose_inputs"),
            mock.patch.object(self.runtime, "_write_fixed_file"),
            mock.patch.object(self.runtime, "_compose_overlay", return_value=b"services: {}\n"),
            mock.patch.object(self.runtime, "_validate_dual_compose_projection"),
            mock.patch.object(
                self.runtime, "_compose_service_hash",
                side_effect=["b" * 64, "2" * 64, "b" * 64, "e" * 64],
            ),
        ):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._derive_transition_identity_domains(SimpleNamespace(RuntimeFault=RuntimeFault), profile, {})
        self.assertEqual(raised.exception.code, "TRANSITION_IDENTITY_DOMAIN_ALIAS")

    def test_rollback_verifies_exact_prestate_hash_not_target_hash(self) -> None:
        profile = self.profile()
        original = FixtureCore(profile).projections["crm.container.gravity_mvp"]["semantic"]
        current = {"semantic": dict(original)}
        state = {"pre_activation_live_identity": {"gravity_semantic": original}}
        self.assertEqual(self.runtime._rollback_semantics_compatibility(profile, state, current), "EXACT")
        current["semantic"] = {**original, "compose_labels": {
            **original["compose_labels"],
            "com.docker.compose.config-hash": "1" * 64,
        }}
        self.assertIsNone(self.runtime._rollback_semantics_compatibility(profile, state, current))

    def test_activation_postcheck_requires_derived_target_hashes(self) -> None:
        profile = self.profile()
        core = FixtureCore(profile)
        gravity = core.projections["crm.container.gravity_mvp"]
        telegram = core.projections["crm.container.telegram_bot"]
        gravity.update({
            "image_id": "sha256:" + "1" * 64,
            "compose_labels": {"com.docker.compose.config-hash": "2" * 64},
            "cmd": ["npm", "run", "start"], "declared_user": "app",
            "working_dir": "/app", "entrypoint": ["/usr/bin/tini", "--"],
        })
        telegram.update({
            "image_id": "sha256:" + "3" * 64,
            "compose_labels": {"com.docker.compose.config-hash": "4" * 64},
        })
        state = {
            "tg_target_image_id": telegram["image_id"],
            "pre_activation_live_identity": {
                "gravity_semantic": gravity["semantic"],
                "tg_bot_semantic": telegram["semantic"],
            },
            "post_activation_target_identity": {
                "gravity_compose_config_hash": "2" * 64,
                "tg_bot_compose_config_hash": "4" * 64,
            },
            "database_identity_sha256": "5" * 64,
            "migration_ledger_sha256": "6" * 64,
        }
        with (
            mock.patch.object(self.runtime, "_database_status", return_value=({
                "migration_state": "APPROVED_OUTBOX_APPLIED",
                "database_identity_sha256": "5" * 64,
                "migration_ledger_sha256": "6" * 64,
            }, {})),
            mock.patch.object(self.runtime, "_application_health", return_value={}),
            mock.patch.object(self.runtime, "_tg_bot_health", return_value={}),
            mock.patch.object(self.runtime, "_assert_unrelated_runtime_unchanged"),
        ):
            result = self.runtime._activation_postcheck(
                core, {}, profile, state,
                expected_image=gravity["image_id"], expected_semantic=gravity["semantic"],
            )
            self.assertEqual(result["gravity_image_id"], gravity["image_id"])
            state["post_activation_target_identity"]["gravity_compose_config_hash"] = "7" * 64
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._activation_postcheck(
                    core, {}, profile, state,
                    expected_image=gravity["image_id"], expected_semantic=gravity["semantic"],
                )
        self.assertEqual(raised.exception.code, "GRAVITY_ACTIVATION_IDENTITY_OR_HEALTH_FAILED")


if __name__ == "__main__":
    unittest.main(verbosity=2)
