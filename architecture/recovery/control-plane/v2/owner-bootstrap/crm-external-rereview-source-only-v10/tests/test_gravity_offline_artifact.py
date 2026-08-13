#!/usr/bin/python3
from __future__ import annotations

import hashlib
import importlib.machinery
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


class RuntimeFault(Exception):
    def __init__(self, code: str, *_args: object) -> None:
        super().__init__(code)
        self.code = code


class Core:
    RuntimeFault = RuntimeFault


def load_runtime():
    loader = importlib.machinery.SourceFileLoader(
        "yoko_runtime_v10_gravity_offline_contract",
        str(ROOT / "src/crm-activation-profile.py"),
    )
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    loader.exec_module(module)
    return module


class GravityOfflineArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.runtime = load_runtime()

    def profile(self, archive: bytes, image_id: str = "sha256:" + "a" * 64) -> dict[str, object]:
        return {
            "accepted_source": {
                "commit": "b" * 40,
                "gravity_image_artifact": {
                    "docker_archive_sha256": hashlib.sha256(archive).hexdigest(),
                    "docker_archive_bytes": len(archive),
                    "image_id": image_id,
                },
            },
            "limits": {"build_timeout_seconds": 30},
        }

    def assert_collision(self, existing: dict[str, object]) -> None:
        with mock.patch.object(self.runtime, "_image_inspect", return_value=existing):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._build_candidate(Core(), self.profile(b"archive"), Path("unused"))
        self.assertEqual(raised.exception.code, "TARGET_IMAGE_TAG_COLLISION")

    def test_preexisting_tag_with_wrong_identity_is_rejected_before_load(self) -> None:
        self.assert_collision({"Id": "sha256:" + "c" * 64, "Config": {"Labels": {}}})

    def test_preexisting_tag_with_matching_identity_and_labels_is_still_rejected(self) -> None:
        image_id = "sha256:" + "a" * 64
        self.assert_collision({
            "Id": image_id,
            "Config": {"Labels": {
                "org.opencontainers.image.revision": "b" * 40,
                "yoko.activation.profile": self.runtime.PROFILE_ID,
            }},
        })

    def test_candidate_uses_only_exact_offline_docker_load_then_revalidates(self) -> None:
        archive = b"exact hosted docker archive\n"
        expected_image = "sha256:" + "a" * 64
        commands: list[list[str]] = []
        with tempfile.TemporaryDirectory(prefix="gravity-offline-contract-") as temporary:
            archive_path = Path(temporary) / "gravity-image.docker.tar"
            archive_path.write_bytes(archive)

            def run_required(_core: object, command: list[str], **_kwargs: object) -> SimpleNamespace:
                commands.append(command)
                return SimpleNamespace(
                    stdout=f"Loaded image: {self.runtime.TARGET_TAG}\n".encode("ascii"),
                    stderr=b"",
                )

            with (
                mock.patch.object(self.runtime, "_image_inspect", return_value=None),
                mock.patch.object(self.runtime, "_secure_host_file", return_value=archive_path),
                mock.patch.object(self.runtime, "_required_success", side_effect=run_required),
                mock.patch.object(
                    self.runtime, "_verify_gravity_candidate_image",
                    return_value={"Id": expected_image},
                ) as revalidate,
            ):
                observed = self.runtime._build_candidate(
                    Core(), self.profile(archive, expected_image), Path("unused"),
                )
        self.assertEqual(observed, expected_image)
        self.assertEqual(commands, [[
            self.runtime.DOCKER, "image", "load", "--input",
            self.runtime.GRAVITY_IMAGE_ARCHIVE_PATH,
        ]])
        revalidate.assert_called_once()

    def test_candidate_revalidation_rejects_id_or_label_replacement(self) -> None:
        archive = b"archive"
        profile = self.profile(archive)
        candidates = (
            {"Id": "sha256:" + "d" * 64, "Config": {"Labels": {}}},
            {
                "Id": "sha256:" + "a" * 64,
                "Config": {"Labels": {
                    "org.opencontainers.image.revision": "e" * 40,
                    "yoko.activation.profile": self.runtime.PROFILE_ID,
                }},
            },
        )
        for candidate in candidates:
            with self.subTest(candidate=candidate), mock.patch.object(
                self.runtime, "_image_inspect", return_value=candidate,
            ):
                with self.assertRaises(RuntimeFault):
                    self.runtime._verify_gravity_candidate_image(Core(), profile)

    def test_automatic_rollback_completion_does_not_depend_on_target_tag(self) -> None:
        state = {"phase": "RELEASE_ACTIVATION_ROLLBACK_INTENT"}
        gravity = {"image_id": "old-gravity", "running": True, "health": "healthy"}
        tg_bot = {"image_id": "old-tg", "running": True, "health": "healthy"}
        profile = {
            "production": {
                "gravity_image_id": "old-gravity",
                "tg_bot_image_id": "old-tg",
            },
        }
        rollback = {
            "old_exact_pair_restored": True,
            "runtime_semantics_compatibility": {"status": "EXACT"},
            "tg_runtime_semantics_compatibility": {"status": "EXACT"},
        }
        rolled_state = {**state, "phase": "ROLLED_BACK"}
        with (
            mock.patch.object(
                self.runtime, "_verify_gravity_candidate_image",
                side_effect=AssertionError("target tag must not gate predecessor rollback"),
            ),
            mock.patch.object(
                self.runtime, "_image_inspect",
                return_value={"Id": "sha256:" + "f" * 64},
            ),
            mock.patch.object(
                self.runtime, "_complete_activation_rollback",
                wraps=self.runtime._complete_activation_rollback,
            ),
            mock.patch.object(
                self.runtime, "_write_terminal_state", return_value=rolled_state,
            ),
            mock.patch.object(
                self.runtime, "_dual_service_image_state", return_value=("old", "old"),
            ),
            mock.patch.object(
                self.runtime, "_accept_existing_rollback", return_value=rollback,
            ),
            mock.patch.object(
                Core, "container_projection",
                side_effect=[gravity, tg_bot], create=True,
            ),
            mock.patch.object(Core, "now", return_value="2026-08-13T00:00:00Z", create=True),
        ):
            observed, terminal = self.runtime._complete_activation_rollback(
                Core(), {}, profile, object(), state, activation_recovery=True,
            )
        self.assertEqual(observed, rollback)
        self.assertEqual(terminal["phase"], "ROLLED_BACK")

    def test_activation_path_still_revalidates_target_tag(self) -> None:
        source = (ROOT / "src/crm-activation-profile.py").read_text(encoding="utf-8")
        release_activate = source.split("def _release_activate", 1)[1].split("def _rollback", 1)[0]
        self.assertIn("target = _verify_gravity_candidate_image(core, profile)", release_activate)


if __name__ == "__main__":
    unittest.main()
