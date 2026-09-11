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


# Target image identity acceptance across both Docker image-store backends.
#
# The same sealed image artifact has two exact content addresses. The classic graph driver
# reports the config blob digest as the image id; Docker's containerd image store reports the
# digest of the OCI manifest or index instead, and echoes it back as Descriptor.digest. Both
# are pinned per component by the profile. These tests pin that exactly one of them is ever
# accepted, that the choice is made by the engine's own descriptor rather than by the caller,
# and that no wrong, malformed or cross-component identity can satisfy the check.

GRAVITY_CONFIG = "sha256:707a0e82514468338192d01600cf5cc46c15be6ca0a37e0498a48156b0fb5a3e"
GRAVITY_INDEX = "sha256:00ffd8b1ae64aa3018f26578da05a96c9f1e77e42d8fc9906f0f4ddaa7918af2"
MAX_CONFIG = "sha256:653d3c3714ed62777b3307a1da96c21ddc5218ce103a8b0fcf0a0bad88c86307"
MAX_INDEX = "sha256:75e2e96bb07acf9fe25f4aab6c89175b6c13fa10bf71e2b9005f6f8cc319ab5a"
REVISION = "6e3f094bf4b42c1400c705843ab107dacd6d1cf8"
PROFILE = "crm-6e3f094bf4b4-gravity-max-source-v1"
INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json"


class TargetImageIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.runtime = load_profile()

    def setUp(self) -> None:
        self.core = SimpleNamespace(RuntimeFault=RuntimeFault)

    @staticmethod
    def record(component: str) -> dict[str, str]:
        if component == "gravity":
            return {"image_id": GRAVITY_CONFIG, "containerd_image_id": GRAVITY_INDEX}
        return {"image_id": MAX_CONFIG, "containerd_image_id": MAX_INDEX}

    @staticmethod
    def image(component: str, image_id: str, *, descriptor_digest: str | None = None,
              media_type: str = INDEX_MEDIA_TYPE, revision: str = REVISION,
              profile: str = PROFILE, os_name: str = "linux", architecture: str = "amd64",
              drop_descriptor: bool = True) -> dict[str, object]:
        if component == "gravity":
            runtime_config = {
                "User": "app", "WorkingDir": "/app", "Entrypoint": ["/usr/bin/tini", "--"],
                "Cmd": ["sh", "-c", "npx prisma migrate deploy && npm run start"],
            }
        else:
            runtime_config = {
                "User": "pwuser", "WorkingDir": "/app", "Entrypoint": ["/usr/bin/tini", "--"],
                "Cmd": ["node", "index.js"],
            }
        value: dict[str, object] = {
            "Id": image_id,
            "Os": os_name,
            "Architecture": architecture,
            "Config": {
                **runtime_config,
                "Labels": {
                    "org.opencontainers.image.revision": revision,
                    "yoko.activation.profile": profile,
                },
            },
        }
        if descriptor_digest is not None:
            value["Descriptor"] = {"mediaType": media_type, "digest": descriptor_digest, "size": 856}
        elif not drop_descriptor:
            value["Descriptor"] = None
        return value

    def validate(self, component: str, image: dict[str, object]):
        with mock.patch.object(self.runtime, "_image_inspect", return_value=image):
            return self.runtime._validate_target_image(self.core, self.record(component), "ref", component)

    # ---- accepted: exactly one identity per backend -------------------------------------

    def test_classic_graph_driver_config_digest_is_accepted(self) -> None:
        for component, digest in (("gravity", GRAVITY_CONFIG), ("max", MAX_CONFIG)):
            with self.subTest(component=component):
                result = self.validate(component, self.image(component, digest))
                self.assertEqual(result["Id"], digest)

    def test_containerd_image_store_index_digest_is_accepted(self) -> None:
        for component, digest in (("gravity", GRAVITY_INDEX), ("max", MAX_INDEX)):
            with self.subTest(component=component):
                image = self.image(component, digest, descriptor_digest=digest)
                self.assertEqual(self.validate(component, image)["Id"], digest)

    def test_containerd_manifest_media_type_is_also_accepted(self) -> None:
        image = self.image("gravity", GRAVITY_INDEX, descriptor_digest=GRAVITY_INDEX,
                           media_type="application/vnd.oci.image.manifest.v1+json")
        self.assertEqual(self.validate("gravity", image)["Id"], GRAVITY_INDEX)

    # ---- refused: the other sealed identity for the same backend -------------------------

    def test_index_digest_without_a_corroborating_descriptor_is_refused(self) -> None:
        """The containerd identity is accepted only when the engine itself corroborates it."""
        image = self.image("gravity", GRAVITY_INDEX)
        with self.assertRaises(RuntimeFault) as caught:
            self.validate("gravity", image)
        self.assertEqual(caught.exception.code, "GRAVITY_TARGET_IMAGE_IDENTITY_MISMATCH")

    def test_config_digest_stands_on_its_own_even_when_a_descriptor_names_the_index(self) -> None:
        """An engine may report the config digest and still describe the manifest it came from.

        The descriptor only selects which sealed identity to expect; it is not itself the identity.
        An image whose id is the sealed config digest IS the sealed artifact, so it is accepted,
        and the id still has to match a sealed value exactly.
        """
        image = self.image("gravity", GRAVITY_CONFIG, descriptor_digest=GRAVITY_INDEX)
        self.assertEqual(self.validate("gravity", image)["Id"], GRAVITY_CONFIG)
        foreign = self.image("gravity", MAX_CONFIG, descriptor_digest=GRAVITY_INDEX)
        with self.assertRaises(RuntimeFault):
            self.validate("gravity", foreign)

    # ---- refused: wrong identities -------------------------------------------------------

    def test_wrong_config_digest_is_refused(self) -> None:
        image = self.image("gravity", "sha256:" + "1" * 64)
        with self.assertRaises(RuntimeFault) as caught:
            self.validate("gravity", image)
        self.assertEqual(caught.exception.code, "GRAVITY_TARGET_IMAGE_IDENTITY_MISMATCH")

    def test_wrong_index_digest_is_refused(self) -> None:
        wrong = "sha256:" + "2" * 64
        image = self.image("max", wrong, descriptor_digest=wrong)
        with self.assertRaises(RuntimeFault) as caught:
            self.validate("max", image)
        self.assertEqual(caught.exception.code, "MAX_TARGET_IMAGE_IDENTITY_MISMATCH")

    # ---- refused: cross-component ---------------------------------------------------------

    def test_other_component_config_digest_is_refused(self) -> None:
        for component, foreign in (("gravity", MAX_CONFIG), ("max", GRAVITY_CONFIG)):
            with self.subTest(component=component):
                with self.assertRaises(RuntimeFault):
                    self.validate(component, self.image(component, foreign))

    def test_other_component_index_digest_is_refused(self) -> None:
        for component, foreign in (("gravity", MAX_INDEX), ("max", GRAVITY_INDEX)):
            with self.subTest(component=component):
                image = self.image(component, foreign, descriptor_digest=foreign)
                with self.assertRaises(RuntimeFault):
                    self.validate(component, image)

    # ---- refused: labels, platform, malformed ---------------------------------------------

    def test_matching_labels_but_wrong_identity_is_refused(self) -> None:
        image = self.image("gravity", "sha256:" + "3" * 64)
        self.assertEqual(image["Config"]["Labels"]["yoko.activation.profile"], PROFILE)
        with self.assertRaises(RuntimeFault):
            self.validate("gravity", image)

    def test_correct_identity_but_wrong_revision_label_is_refused(self) -> None:
        image = self.image("gravity", GRAVITY_CONFIG, revision="0" * 40)
        with self.assertRaises(RuntimeFault):
            self.validate("gravity", image)

    def test_correct_identity_but_wrong_profile_label_is_refused(self) -> None:
        image = self.image("gravity", GRAVITY_CONFIG, profile="crm-other-profile-v1")
        with self.assertRaises(RuntimeFault):
            self.validate("gravity", image)

    def test_wrong_os_or_architecture_is_refused(self) -> None:
        for kwargs in ({"os_name": "windows"}, {"architecture": "arm64"}):
            with self.subTest(**kwargs):
                image = self.image("gravity", GRAVITY_CONFIG, **kwargs)
                with self.assertRaises(RuntimeFault):
                    self.validate("gravity", image)

    def test_missing_or_malformed_identity_is_refused(self) -> None:
        for observed in (None, "", "707a0e82", "sha256:", "sha512:" + "a" * 64, "sha256:" + "Z" * 64):
            with self.subTest(observed=observed):
                image = self.image("gravity", observed)  # type: ignore[arg-type]
                with self.assertRaises(RuntimeFault):
                    self.validate("gravity", image)

    def test_malformed_descriptor_falls_back_to_the_stricter_config_identity(self) -> None:
        """A descriptor the engine did not corroborate must not widen what is accepted."""
        for descriptor in ({"mediaType": INDEX_MEDIA_TYPE, "digest": "not-a-digest"},
                           {"mediaType": "text/plain", "digest": GRAVITY_INDEX},
                           {"digest": GRAVITY_INDEX},
                           "not-a-mapping"):
            with self.subTest(descriptor=descriptor):
                image = self.image("gravity", GRAVITY_INDEX)
                image["Descriptor"] = descriptor
                with self.assertRaises(RuntimeFault):
                    self.validate("gravity", image)
                accepted = self.image("gravity", GRAVITY_CONFIG)
                accepted["Descriptor"] = descriptor
                self.assertEqual(self.validate("gravity", accepted)["Id"], GRAVITY_CONFIG)

    # ---- refused: the profile itself must seal both identities ----------------------------

    def test_a_component_missing_either_sealed_identity_is_refused(self) -> None:
        for record in ({"image_id": GRAVITY_CONFIG},
                       {"containerd_image_id": GRAVITY_INDEX},
                       {"image_id": GRAVITY_CONFIG, "containerd_image_id": GRAVITY_CONFIG},
                       {"image_id": GRAVITY_CONFIG, "containerd_image_id": "sha256:short"}):
            with self.subTest(record=sorted(record)):
                image = self.image("gravity", GRAVITY_CONFIG)
                with self.assertRaises(RuntimeFault) as caught:
                    self.runtime._sealed_image_identity(self.core, image, record, "gravity")
                self.assertEqual(caught.exception.code, "GRAVITY_TARGET_IMAGE_IDENTITY_UNSEALED")

    def test_accepted_identity_set_is_exactly_the_two_sealed_values(self) -> None:
        """No third value can ever be returned as the expected identity."""
        record = self.record("gravity")
        for image in (self.image("gravity", GRAVITY_CONFIG),
                      self.image("gravity", GRAVITY_INDEX, descriptor_digest=GRAVITY_INDEX),
                      self.image("gravity", "sha256:" + "4" * 64)):
            expected = self.runtime._sealed_image_identity(self.core, image, record, "gravity")
            self.assertIn(expected, {GRAVITY_CONFIG, GRAVITY_INDEX})

    # ---- failure stays bounded -------------------------------------------------------------

    def test_validation_failure_removes_the_loaded_image_and_never_activates(self) -> None:
        profile = {
            "target": {"gravity": self.record("gravity"), "max_scraper": self.record("max")},
            "limits": {"image_load_timeout_seconds": 60},
            "artifact_admission": {"files": {"gravity-image.docker.tar": {"bytes": 1, "sha256": "a" * 64,
                                                                          "path": "/tmp/x"}}},
        }
        calls: list[list[str]] = []

        def run(core, argv, **kwargs):
            calls.append(list(argv))
            return SimpleNamespace(stdout=b"", stderr=b"")

        loaded = self.image("gravity", "sha256:" + "5" * 64)
        with mock.patch.object(self.runtime, "_image_inspect", side_effect=[None, loaded, loaded]), \
             mock.patch.object(self.runtime, "_storage_guard", return_value={}), \
             mock.patch.object(self.runtime, "_archive_bytes", return_value=1), \
             mock.patch.object(self.runtime, "_artifact_path", return_value="/dev/null"), \
             mock.patch.object(self.runtime, "_run", side_effect=run), \
             mock.patch.object(self.runtime, "_compose_up") as compose:
            with self.assertRaises(RuntimeFault):
                self.runtime._load_target(self.core, profile, "gravity", "gravity-image.docker.tar", "ref")
        self.assertTrue(any(argv[1:3] == ["image", "rm"] for argv in calls), calls)
        compose.assert_not_called()

    # ---- the pair classifier reads container ids, which carry no descriptor -----------------

    def test_classifier_accepts_either_sealed_identity_for_the_target_pair(self) -> None:
        """A-F1/F2: a running container names its image without any descriptor to disambiguate."""
        profile = {
            "predecessor": {"gravity": {"image_id": "sha256:" + "a" * 64},
                            "max_scraper": {"image_id": "sha256:" + "b" * 64}},
            "target": {"gravity": self.record("gravity"), "max_scraper": self.record("max")},
        }
        for gravity_id, max_id in ((GRAVITY_CONFIG, MAX_CONFIG), (GRAVITY_INDEX, MAX_INDEX),
                                   (GRAVITY_CONFIG, MAX_INDEX), (GRAVITY_INDEX, MAX_CONFIG)):
            with self.subTest(gravity=gravity_id[:14], max=max_id[:14]):
                state, vector = self.runtime._classify(profile, {"image_id": gravity_id}, {"image_id": max_id})
                self.assertEqual(state, "TARGET_PAIR")
                self.assertEqual(vector, ("target", "target"))

    def test_classifier_still_separates_predecessor_from_target(self) -> None:
        profile = {
            "predecessor": {"gravity": {"image_id": "sha256:" + "a" * 64},
                            "max_scraper": {"image_id": "sha256:" + "b" * 64}},
            "target": {"gravity": self.record("gravity"), "max_scraper": self.record("max")},
        }
        state, vector = self.runtime._classify(
            profile, {"image_id": "sha256:" + "a" * 64}, {"image_id": "sha256:" + "b" * 64})
        self.assertEqual((state, vector), ("PREDECESSOR_PAIR", ("predecessor", "predecessor")))
        state, vector = self.runtime._classify(
            profile, {"image_id": "sha256:" + "a" * 64}, {"image_id": MAX_INDEX})
        self.assertEqual((state, vector), ("MIXED_KNOWN", ("predecessor", "target")))

    def test_classifier_refuses_cross_component_and_unknown_identities(self) -> None:
        profile = {
            "predecessor": {"gravity": {"image_id": "sha256:" + "a" * 64},
                            "max_scraper": {"image_id": "sha256:" + "b" * 64}},
            "target": {"gravity": self.record("gravity"), "max_scraper": self.record("max")},
        }
        for gravity_id, max_id in ((MAX_CONFIG, MAX_CONFIG), (MAX_INDEX, MAX_INDEX),
                                   (GRAVITY_CONFIG, GRAVITY_INDEX), ("sha256:" + "9" * 64, MAX_INDEX),
                                   (None, MAX_INDEX), ("", MAX_INDEX)):
            with self.subTest(gravity=str(gravity_id)[:14]):
                state, _ = self.runtime._classify(profile, {"image_id": gravity_id}, {"image_id": max_id})
                self.assertEqual(state, "UNKNOWN")

    def test_classifier_refuses_when_predecessor_and_target_share_an_identity(self) -> None:
        """An ambiguous profile must classify as unknown rather than silently pick one side."""
        profile = {
            "predecessor": {"gravity": {"image_id": GRAVITY_CONFIG},
                            "max_scraper": {"image_id": MAX_CONFIG}},
            "target": {"gravity": self.record("gravity"), "max_scraper": self.record("max")},
        }
        state, vector = self.runtime._classify(
            profile, {"image_id": GRAVITY_CONFIG}, {"image_id": MAX_CONFIG})
        self.assertEqual(state, "UNKNOWN")
        self.assertEqual(vector, ("unknown", "unknown"))

    def test_sealed_constants_in_these_tests_match_the_profile_template(self) -> None:
        """F7: the digests asserted here must be the ones the profile actually seals."""
        import json
        import re
        raw = (ROOT / "templates/profile.v1.json.in").read_text(encoding="utf-8")
        rendered = raw.replace("@ARTIFACT_FILES_JSON@", "{}")
        rendered = re.sub(r'"@[A-Z_]+@"', '"placeholder"', rendered)
        target = json.loads(rendered)["target"]
        self.assertEqual(target["gravity"]["image_id"], GRAVITY_CONFIG)
        self.assertEqual(target["gravity"]["containerd_image_id"], GRAVITY_INDEX)
        self.assertEqual(target["max_scraper"]["image_id"], MAX_CONFIG)
        self.assertEqual(target["max_scraper"]["containerd_image_id"], MAX_INDEX)


if __name__ == "__main__":
    unittest.main()
