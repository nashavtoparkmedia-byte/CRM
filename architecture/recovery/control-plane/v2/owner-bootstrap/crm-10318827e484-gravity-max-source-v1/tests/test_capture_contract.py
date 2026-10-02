#!/usr/bin/python3
from __future__ import annotations

import datetime as dt
import hashlib
import importlib.machinery
import importlib.util
import json
import stat
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


PHASE3_PATH = Path("/opt/codex-work/yoko-v22-seal-10318827/production-snapshot-normalized-phase3.json")
PHASE3 = json.loads(PHASE3_PATH.read_text(encoding="ascii"))
INTERIM_PACKAGE = Path("/opt/codex-work/yoko-v22-seal-10318827/rollback-2.0.0-21-interim/yoko-privileged-runtime_2.0.0-21_all.deb")


class CaptureContractTests(unittest.TestCase):
    def test_phase3_authority_snapshot_is_the_exact_normalized_predecessor(self) -> None:
        self.assertEqual(seal.sha(PHASE3_PATH), "17b8ead7543c3cf54ab58976b65c9e6d480fee0a077a3eaf2d396649bfabacf7")
        sealing = PHASE3["sealing"]
        self.assertEqual(sealing["predecessor_release_critical_identity_sha256"], "f48c638e3fc5f86ebf587295d4ea45f7e1dc151769140c91efeaf0bdc7589d03")
        self.assertEqual(sealing["gravity_image_id"], "sha256:4dbe322a88fb5a635ffa5abc2d1d22071ba941fc22ce460edde3cd185717868c")
        self.assertEqual(sealing["max_image_id"], "sha256:ede5efb412d462a01bb9965f97a698a2c4b4bd3fb24d4ac478b1710a9943c7c6")
        capture.validate_predecessor(PHASE3["commands"]["predecessor-observe"]["evidence"])
        observed = PHASE3["commands"]["predecessor-observe"]["evidence"]
        self.assertEqual(observed["release_critical_identity_sha256"], sealing["predecessor_release_critical_identity_sha256"])
        self.assertEqual(PHASE3["commands"]["self-check"]["evidence"]["predecessor_observability_sha256"], capture.PREDECESSOR_OBSERVER_SHA256)
        maximum = PHASE3["commands"]["docker-inspect:crm.container.max_scraper"]["evidence"]
        self.assertEqual(maximum["mounts"], [{"name": "crm_max_user_data", "read_write": True, "target": "/app/user_data", "type": "volume"}])
        self.assertEqual(len(maximum["semantic"]["environment_names"]), 84)
        self.assertIn("CRM_TELEGRAM_CONNECTION_ID", maximum["semantic"]["environment_names"])
        # tg-bot, nginx and every other unrelated service are bound by the fingerprint the seal pins.
        unrelated = [row for row in PHASE3["commands"]["docker-provenance"]["evidence"]["semantic"]["records"] if row.get("name") not in {"crm-gravity-mvp", "crm-max-scraper"}]
        self.assertIn("crm-tg-bot", [row["name"] for row in unrelated])
        self.assertIn("crm-nginx", [row["name"] for row in unrelated])
        self.assertEqual(capture.digest(unrelated), sealing["unrelated_semantic_fingerprint_sha256"])

    def test_rollback_semantic_from_phase3_and_the_interim_predecessor_package(self) -> None:
        profile, profile_sha = seal.predecessor_sealed_profile(INTERIM_PACKAGE)
        semantic = seal.derive_predecessor_rollback_semantic(PHASE3, profile, profile_sha)
        self.assertEqual(semantic, {
            "release_environment_name": "MAX_SCRAPER_WEBHOOK_SECRET",
            "services": {
                "gravity-mvp": {
                    "command": ["npm", "run", "start"],
                    "release_environment_source": "/var/lib/crm/release-staging/messaging-be6b8eb8/gravity-mvp.env",
                },
                "max-web-scraper": {
                    "command": ["node", "index.js"],
                    "release_environment_source": "/var/lib/crm/release-staging/messaging-be6b8eb8/max-web-scraper.env",
                },
            },
            "provenance": {
                "predecessor_package_sha256": "619f4ebe43dfca98942d9557e0d2fb28aa4b7f819079a7baa28f7ea2eb5cd283",
                "predecessor_profile_id": "crm-ba90ed4b6717-gravity-max-source-v1",
                "predecessor_profile_sha256": "97dd62ea7fba53a3d7c382b723bf131b63a3dc091688de1bf4882471d4c65274",
                "semantic_source": "production-snapshot docker-inspect semantic",
            },
        })
        # The predecessor sealed source is the predecessor profile's own release environment.
        self.assertEqual(profile["release_environment"]["sources"], {
            service: item["release_environment_source"] for service, item in semantic["services"].items()
        })
        # Fail closed: the snapshot shows the name consumed but the predecessor authority has no source.
        stripped = json.loads(json.dumps(profile))
        stripped["release_environment"]["sources"].pop("max-web-scraper")
        with self.assertRaisesRegex(ValueError, "refusing to seal"):
            seal.derive_predecessor_rollback_semantic(PHASE3, stripped, profile_sha)


    def test_sealer_reopens_only_exact_generated_review_directory_for_restart_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            generated = Path(temporary) / "generated"
            review = generated / "bundle/payload/review"
            sibling = generated / "bundle/payload/unrelated"
            review.mkdir(parents=True)
            sibling.mkdir()
            (review / "human-manifest.md").write_text("review\n", encoding="ascii")
            review.chmod(0o500)
            sibling.chmod(0o500)

            seal.reopen_generated_review_for_cleanup(generated)

            self.assertEqual(stat.S_IMODE(review.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(sibling.stat().st_mode), 0o500)
            sibling.chmod(0o700)

    def test_sealer_rejects_symlinked_generated_review_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            generated = Path(temporary) / "generated"
            target = Path(temporary) / "outside"
            (generated / "bundle/payload").mkdir(parents=True)
            target.mkdir()
            (generated / "bundle/payload/review").symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "unsafe generated review output path"):
                seal.reopen_generated_review_for_cleanup(generated)

    def test_rollback_package_metadata_is_parsed_as_values_not_labeled_multi_field_output(self) -> None:
        path = Path("/opt/codex-work/yoko-v22-seal-10318827/rollback-2.0.0-21-interim/yoko-privileged-runtime_2.0.0-21_all.deb")
        self.assertEqual(seal.deb_metadata(path), ["yoko-privileged-runtime", seal.ROLLBACK_VERSION, "all"])

    def test_rollback_package_is_the_exact_interim_observer_package(self) -> None:
        directory = Path("/opt/codex-work/yoko-v22-seal-10318827/rollback-2.0.0-21-interim")
        package = directory / "yoko-privileged-runtime_2.0.0-21_all.deb"
        self.assertEqual(seal.sha(package), seal.ROLLBACK_SHA)
        self.assertEqual(seal.sha(directory / "package-manifest.json"), seal.ROLLBACK_SEAL_SHA)
        manifest = json.loads((directory / "package-manifest.json").read_text(encoding="ascii"))
        self.assertEqual(manifest["package"]["sha256"], seal.ROLLBACK_SHA)
        self.assertEqual(manifest["observer"]["sha256"], capture.PREDECESSOR_OBSERVER_SHA256)
        profile, digest = seal.predecessor_sealed_profile(package)
        self.assertEqual(digest, "97dd62ea7fba53a3d7c382b723bf131b63a3dc091688de1bf4882471d4c65274")
        self.assertEqual(profile["profile_id"], seal.ROLLBACK_PROFILE_ID)

    @staticmethod
    def layered_observation() -> dict:
        services = []
        for name, stack in capture.PREDECESSOR_STACKS.items():
            services.append({
                "compose_service": name,
                "reconstruction": {
                    "model": "EFFECTIVE_LAYERED_CONTAINER_CREATION_STACK",
                    "layers": [{"path": stack[0], "role": "base-compose"}] + [
                        {"path": path} for path in stack[1:]
                    ],
                },
                "environment": {
                    "effective_key_set": ["CRM_TELEGRAM_CONNECTION_ID", "PATH"],
                    "effective_values_match_reconstructed_compose_and_image": True,
                    "plaintext_values_emitted": False,
                },
            })
        return {
            "schema": capture.OBSERVATION_SCHEMA,
            "production_mutated": False,
            "secret_values_emitted": False,
            "compose_source": {
                "compose_file_sha256": capture.BASE_COMPOSE_SHA256,
                "reconstruction_model": "EFFECTIVE_LAYERED_CONTAINER_CREATION_STACK",
                "overlay_layers": json.loads(json.dumps(capture.PREDECESSOR_LAYERS)),
            },
            "services": services,
            "release_critical_identity_sha256": "f" * 64,
        }

    def test_capture_accepts_only_the_pinned_layered_normalized_predecessor(self) -> None:
        capture.validate_predecessor(self.layered_observation())
        mutations = {
            "v1 base-only observation": lambda v: v.update(schema="yoko.crm.predecessor-recreation-observation.v1"),
            "digest-mismatched overlay": lambda v: v["compose_source"]["overlay_layers"][0].update(sha256="0" * 64),
            "changed image pin": lambda v: v["compose_source"]["overlay_layers"][1]["image_pins"].update({"tg-bot": "crm/tg-bot:other"}),
            "future candidate overlay": lambda v: v["compose_source"]["overlay_layers"].append({
                "path": "/var/lib/yoko-privileged-runtime/profiles/crm-10318827e484-gravity-max-source-v1/activate.compose.yml",
                "role": "runtime-profile-overlay", "sha256": "1" * 64,
            }),
            "base compose drift": lambda v: v["compose_source"].update(compose_file_sha256="2" * 64),
            "MAX stack drift": lambda v: v["services"][2]["reconstruction"]["layers"].append({"path": capture.DRIVER_AUTHORITY_OVERLAY}),
            "MAX not normalized": lambda v: v["services"][2]["environment"].update(effective_key_set=["PATH"]),
            "service missing": lambda v: v["services"].pop(1),
            "environment not reconstructed": lambda v: v["services"][0]["environment"].update(effective_values_match_reconstructed_compose_and_image=False),
        }
        for label, mutate in mutations.items():
            value = self.layered_observation()
            mutate(value)
            with self.assertRaises(ValueError, msg=label):
                capture.validate_predecessor(value)

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


    def test_sealer_accepts_only_fresh_exact_predecessor_snapshot(self) -> None:
        completed = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        # A fresh capture of the Phase 3 normalized predecessor: identical sealing identities,
        # only the capture timestamps are new.
        sealing = dict(PHASE3["sealing"])
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
            self.assertEqual(accepted["sealing"], PHASE3["sealing"])
            # Any semantic identity that differs from the Phase 3 authority refuses the seal.
            for key, drifted in (
                ("predecessor_release_critical_identity_sha256", "0" * 64),
                ("max_container_id", "f" * 64),
                ("max_compose_config_hash", "1" * 64),
                ("gravity_container_id", "2" * 64),
                ("unrelated_semantic_fingerprint_sha256", "3" * 64),
                ("audit_record_count", 86),
                ("applied_migration_count", 64),
            ):
                value["sealing"] = dict(sealing, **{key: drifted})
                path.write_text(json.dumps(value), encoding="ascii")
                with self.assertRaisesRegex(ValueError, "drifted", msg=key):
                    seal.validate_snapshot(path)
            value["sealing"] = sealing
            value["completed_at"] = (completed - dt.timedelta(minutes=16)).isoformat().replace("+00:00", "Z")
            value["started_at"] = value["completed_at"]
            path.write_text(json.dumps(value), encoding="ascii")
            with self.assertRaisesRegex(ValueError, "stale"):
                seal.validate_snapshot(path)


if __name__ == "__main__":
    unittest.main()
