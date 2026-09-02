#!/usr/bin/python3
from __future__ import annotations

import importlib.machinery
import importlib.util
import os
import stat
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


def load_profile():
    loader = importlib.machinery.SourceFileLoader(
        "yoko_coordinated_profile_contract_tests",
        str(ROOT / "templates/crm-activation-profile.py.in"),
    )
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    loader.exec_module(module)
    return module


class ProfileContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.runtime = load_profile()

    def profile(self) -> dict[str, object]:
        return {
            "predecessor": {
                "gravity": {"image_id": "old-gravity"},
                "max_scraper": {
                    "image_id": "old-max",
                    "volume": {"source_sha256": "v" * 64},
                },
            },
            "target": {
                "gravity": {"image_id": "new-gravity"},
                "max_scraper": {"image_id": "new-max"},
            },
        }

    def projection(self, image: str, service: str, command: list[str], compose_hash: str) -> dict[str, object]:
        semantic = {
            "image_id": image,
            "command": command,
            "compose_labels": {
                "com.docker.compose.config-hash": compose_hash,
                "com.docker.compose.project": "crm",
                "com.docker.compose.service": service,
            },
        }
        result: dict[str, object] = {
            "container_id": service + "-container",
            "image_id": image,
            "running": True,
            "health": "healthy",
            "restart_count": 0,
            "compose_labels": {"com.docker.compose.config-hash": compose_hash},
            "semantic": semantic,
        }
        if service == "max-web-scraper":
            result["mounts"] = [{"name": "crm_max_user_data", "read_write": True, "target": "/app/user_data", "type": "volume"}]
            semantic["mounts"] = [{"destination": "/app/user_data", "read_only": False, "source_sha256": "v" * 64, "type": "volume"}]
        return result

    def test_pair_classifier_covers_all_terminal_mixed_and_unknown_vectors(self) -> None:
        profile = self.profile()
        cases = {
            ("old-gravity", "old-max"): "PREDECESSOR_PAIR",
            ("new-gravity", "new-max"): "TARGET_PAIR",
            ("new-gravity", "old-max"): "MIXED_KNOWN",
            ("old-gravity", "new-max"): "MIXED_KNOWN",
            ("foreign", "old-max"): "UNKNOWN",
            ("old-gravity", "foreign"): "UNKNOWN",
            ("foreign", "foreign"): "UNKNOWN",
        }
        for vector, expected in cases.items():
            with self.subTest(vector=vector):
                observed = ({"image_id": vector[0]}, {"image_id": vector[1]})
                self.assertEqual(self.runtime._classify(profile, *observed)[0], expected)

    def test_overlays_are_fixed_pair_only_and_activation_disables_migration_command(self) -> None:
        activation = self.runtime._compose_overlay(self.runtime.TARGET_GRAVITY, self.runtime.TARGET_MAX, activate=True).decode("ascii")
        rollback = self.runtime._compose_overlay(self.runtime.ROLLBACK_GRAVITY, self.runtime.ROLLBACK_MAX, activate=False).decode("ascii")
        self.assertIn('command: ["npm", "run", "start"]', activation)
        self.assertNotIn("prisma", activation)
        self.assertNotIn("command:", rollback)
        self.assertEqual(activation.count("image:"), 2)
        self.assertEqual(rollback.count("image:"), 2)
        with self.assertRaisesRegex(RuntimeError, "IMAGE_REFERENCE_INVALID"):
            self.runtime._compose_overlay("foreign", self.runtime.TARGET_MAX, activate=True)

    def test_production_configuration_uses_noncaller_writable_chain_contract(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            target = root / "opt/crm/deploy/docker-compose.production.yml"
            target.parent.mkdir(parents=True)
            target.write_text("services: {}\n", encoding="ascii")
            target.chmod(0o644)
            core = SimpleNamespace(
                RuntimeFault=RuntimeFault,
                mapped=lambda _path: target,
                expected_owner=lambda: (os.geteuid(), os.getegid()),
                assert_noncaller_writable_chain=mock.Mock(),
            )
            value = self.runtime._fixed_production_file(core, "/opt/crm/deploy/docker-compose.production.yml", 0o644, 1024)
            self.assertTrue(stat.S_ISREG(value.st_mode))
            core.assert_noncaller_writable_chain.assert_called_once_with(target)
            target.chmod(0o664)
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._fixed_production_file(core, "/opt/crm/deploy/docker-compose.production.yml", 0o644, 1024)
            self.assertEqual(raised.exception.code, "PRODUCTION_CONFIGURATION_FILE_UNSAFE")

    def test_target_postcheck_preserves_volume_database_and_unrelated_services(self) -> None:
        profile = self.profile()
        gravity = self.projection("new-gravity", "gravity-mvp", ["npm", "run", "start"], "g" * 64)
        maximum = self.projection("new-max", "max-web-scraper", ["node", "index.js"], "m" * 64)
        state = {
            "environment_sha256": "e" * 64,
            "gravity_semantic": self.projection("old-gravity", "gravity-mvp", ["sh", "-c", "migrate && start"], "o" * 64)["semantic"],
            "max_semantic": self.projection("old-max", "max-web-scraper", ["node", "index.js"], "p" * 64)["semantic"],
            "target_gravity_compose_hash": "g" * 64,
            "target_max_compose_hash": "m" * 64,
            "unrelated_semantic_fingerprint_sha256": "u" * 64,
        }
        core = SimpleNamespace(RuntimeFault=RuntimeFault)
        with (
            mock.patch.object(self.runtime, "_validate_compose_inputs"),
            mock.patch.object(self.runtime, "_wait_pair", return_value=(gravity, maximum)),
            mock.patch.object(self.runtime, "_database_status", return_value={"state": "EXACT"}),
            mock.patch.object(self.runtime, "_unrelated_fingerprint", return_value="u" * 64),
        ):
            result = self.runtime._postcheck(core, {}, profile, state, "TARGET_PAIR")
        self.assertTrue(result["max_volume_preserved"])
        self.assertTrue(result["unrelated_services_unchanged"])
        self.assertEqual(result["database"], {"state": "EXACT"})

        maximum["mounts"] = []
        with (
            mock.patch.object(self.runtime, "_validate_compose_inputs"),
            mock.patch.object(self.runtime, "_wait_pair", return_value=(gravity, maximum)),
        ):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._postcheck(core, {}, profile, state, "TARGET_PAIR")
        self.assertEqual(raised.exception.code, "MAX_PERSISTENT_VOLUME_IDENTITY_DRIFT")


if __name__ == "__main__":
    unittest.main()
