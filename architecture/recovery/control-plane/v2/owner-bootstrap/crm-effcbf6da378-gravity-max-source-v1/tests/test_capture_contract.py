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


# The 2.0.0-23 authority snapshot: a read-only capture of the live predecessor taken with this
# capture tool at derivation time. The seal pins its sealing block; a fresh capture must equal it.
AUTHORITY_PATH = Path("/opt/codex-work/yoko-v23-seal-effcbf6d/production-snapshot-authority.json")
AUTHORITY = json.loads(AUTHORITY_PATH.read_text(encoding="ascii"))
ROLLBACK_DIRECTORY = Path("/opt/codex-work/yoko-v23-seal-effcbf6d/rollback-2.0.0-22")
ROLLBACK_PACKAGE = ROLLBACK_DIRECTORY / "yoko-privileged-runtime_2.0.0-22_all.deb"
PREDECESSOR_PROFILE_SHA256 = "91d42f8783a9b0416faf995931a88889009b8a31d94c525f5ea7b4e45fbbdc95"


class CaptureContractTests(unittest.TestCase):
    def test_authority_snapshot_is_the_exact_live_predecessor(self) -> None:
        self.assertEqual(seal.sha(AUTHORITY_PATH), "4f5611f998408eccf20e7965b2caf7af5e34e7d1060a054fe773ceb9555f9da1")
        sealing = AUTHORITY["sealing"]
        self.assertEqual(sealing["predecessor_release_critical_identity_sha256"], "175a76cb275af8259c5652a9d2b82ac961ef7eb189d924ed18ac7dcf6f860154")
        self.assertEqual(sealing["gravity_image_id"], "sha256:458ff5cb42fecec5f040a6e918705a267a1cf5e9f547f5d709f0c5bc4612c8be")
        self.assertEqual(sealing["max_image_id"], "sha256:26acfcfab7304d30285c9990dfccaa8a9e148b3b294633d8ae48ce4c8d633da2")
        capture.validate_predecessor(AUTHORITY["commands"]["predecessor-observe"]["evidence"])
        observed = AUTHORITY["commands"]["predecessor-observe"]["evidence"]
        self.assertEqual(observed["release_critical_identity_sha256"], sealing["predecessor_release_critical_identity_sha256"])
        self.assertEqual(AUTHORITY["commands"]["self-check"]["evidence"]["predecessor_observability_sha256"], capture.PREDECESSOR_OBSERVER_SHA256)
        gravity = AUTHORITY["commands"]["docker-inspect:crm.container.gravity_mvp"]["evidence"]
        maximum = AUTHORITY["commands"]["docker-inspect:crm.container.max_scraper"]["evidence"]
        self.assertEqual(maximum["mounts"], [{"name": "crm_max_user_data", "read_write": True, "target": "/app/user_data", "type": "volume"}])
        self.assertEqual(len(maximum["semantic"]["environment_names"]), 84)
        self.assertIn("CRM_TELEGRAM_CONNECTION_ID", maximum["semantic"]["environment_names"])
        # The predecessor pair is itself an activated coordinated release: Gravity runs the
        # activation command, and both pair services already carry the release name.
        self.assertEqual(gravity["semantic"]["command"], ["npm", "run", "start"])
        self.assertEqual(maximum["semantic"]["command"], ["node", "index.js"])
        for record in (gravity, maximum):
            self.assertIn(seal.RELEASE_ENVIRONMENT_NAME, record["semantic"]["environment_names"])
        # tg-bot, nginx and every other unrelated service are bound by the fingerprint the seal pins.
        unrelated = [row for row in AUTHORITY["commands"]["docker-provenance"]["evidence"]["semantic"]["records"] if row.get("name") not in {"crm-gravity-mvp", "crm-max-scraper"}]
        self.assertIn("crm-tg-bot", [row["name"] for row in unrelated])
        self.assertIn("crm-nginx", [row["name"] for row in unrelated])
        self.assertEqual(capture.digest(unrelated), sealing["unrelated_semantic_fingerprint_sha256"])

    def test_rollback_semantic_from_the_authority_snapshot_and_the_2_0_0_22_package(self) -> None:
        profile, profile_sha = seal.predecessor_sealed_profile(ROLLBACK_PACKAGE)
        semantic = seal.derive_predecessor_rollback_semantic(AUTHORITY, profile, profile_sha)
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
                "predecessor_package_sha256": "1c78ce00eca19b8ef87bd200138105ec9d47a9b07968de0b42f68e9d58d972df",
                "predecessor_profile_id": "crm-10318827e484-gravity-max-source-v1",
                "predecessor_profile_sha256": PREDECESSOR_PROFILE_SHA256,
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
            seal.derive_predecessor_rollback_semantic(AUTHORITY, stripped, profile_sha)


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
        self.assertEqual(seal.deb_metadata(ROLLBACK_PACKAGE), ["yoko-privileged-runtime", seal.ROLLBACK_VERSION, "all"])

    def test_rollback_package_is_the_exact_installed_2_0_0_22_release(self) -> None:
        self.assertEqual(seal.sha(ROLLBACK_PACKAGE), seal.ROLLBACK_SHA)
        self.assertEqual(seal.sha(ROLLBACK_DIRECTORY / "SEALED_RELEASE.json"), seal.ROLLBACK_SEAL_SHA)
        release = json.loads((ROLLBACK_DIRECTORY / "SEALED_RELEASE.json").read_text(encoding="ascii"))
        self.assertEqual(release["package"]["sha256"], seal.ROLLBACK_SHA)
        self.assertEqual(release["package_version"], seal.ROLLBACK_VERSION)
        self.assertEqual(release["profile_id"], seal.ROLLBACK_PROFILE_ID)
        self.assertEqual(release["package"]["path"], f"yoko-privileged-runtime_{seal.ROLLBACK_VERSION}_all.deb")
        profile, digest = seal.predecessor_sealed_profile(ROLLBACK_PACKAGE)
        self.assertEqual(digest, PREDECESSOR_PROFILE_SHA256)
        self.assertEqual(profile["profile_id"], seal.ROLLBACK_PROFILE_ID)
        # The predecessor profile was sealed for the pair that 2.0.0-22 activated; its MAX target is
        # exactly the MAX the live predecessor still runs.
        self.assertEqual(profile["target"]["max_scraper"]["containerd_image_id"], AUTHORITY["sealing"]["max_image_id"])

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
                "path": "/var/lib/yoko-privileged-runtime/profiles/crm-effcbf6da378-gravity-max-source-v1/activate.compose.yml",
                "role": "runtime-profile-overlay", "sha256": "1" * 64,
            }),
            "previous runtime overlay dropped": lambda v: v["compose_source"]["overlay_layers"].pop(3),
            "base compose drift": lambda v: v["compose_source"].update(compose_file_sha256="2" * 64),
            "MAX stack drift": lambda v: v["services"][2]["reconstruction"]["layers"].append({"path": capture.PERSON_CONFIRM_OVERLAY}),
            "Gravity without the person-confirmation layer": lambda v: v["services"][0]["reconstruction"]["layers"].pop(),
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
        # A fresh capture of the authority predecessor: identical sealing identities, only the
        # capture timestamps are new.
        sealing = dict(AUTHORITY["sealing"])
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
            self.assertEqual(accepted["sealing"], AUTHORITY["sealing"])
            # Any semantic identity that differs from the authority snapshot refuses the seal.
            for key, drifted in (
                ("predecessor_release_critical_identity_sha256", "0" * 64),
                ("max_container_id", "f" * 64),
                ("max_compose_config_hash", "1" * 64),
                ("gravity_container_id", "2" * 64),
                ("gravity_image_id", "sha256:" + "4" * 64),
                ("unrelated_semantic_fingerprint_sha256", "3" * 64),
                ("runtime_package_version", "2.0.0-21"),
                ("audit_record_count", 89),
                ("applied_migration_count", 69),
                ("migration_rows_sha256", "5" * 64),
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
