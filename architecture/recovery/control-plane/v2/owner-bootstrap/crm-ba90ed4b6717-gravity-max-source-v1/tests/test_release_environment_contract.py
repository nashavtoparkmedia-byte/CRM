#!/usr/bin/python3
"""Contract for the one sealed release environment addition.

The activation may add exactly `MAX_SCRAPER_WEBHOOK_SECRET`, only to `gravity-mvp` and
`max-web-scraper`, from fixed root-only sources attached by the activation overlay. Every other
environment difference, every other service, and the whole rollback path stay exact.
"""
from __future__ import annotations

import copy
import importlib.machinery
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
NAME = "MAX_SCRAPER_WEBHOOK_SECRET"
SECRET = "0123456789abcdef" * 4
OTHER_SECRET = "fedcba9876543210" * 4
PREDECESSOR_NAMES = ["DATABASE_URL", "NODE_ENV", "PATH"]
RELEASED_NAMES = sorted([*PREDECESSOR_NAMES, NAME])
MIGRATION_COMMAND = ["sh", "-c", "npx prisma migrate deploy && npm run start"]


class RuntimeFault(Exception):
    def __init__(self, code: str, exit_code: int = 70, details: dict[str, object] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code
        self.details = details or {}


def load_profile():
    loader = importlib.machinery.SourceFileLoader(
        "yoko_coordinated_release_environment_tests",
        str(ROOT / "templates/crm-activation-profile.py.in"),
    )
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    loader.exec_module(module)
    return module


def semantic(image: str, service: str, command: list[str], names: list[str], compose_hash: str) -> dict[str, object]:
    value: dict[str, object] = {
        "image_id": image,
        "command": command,
        "entrypoint": ["/usr/bin/tini", "--"],
        "environment_names": names,
        "compose_labels": {
            "com.docker.compose.config-hash": compose_hash,
            "com.docker.compose.project": "crm",
            "com.docker.compose.service": service,
        },
        "name": "crm-" + service,
        "network_names": ["crm_internal"],
    }
    if service == "max-web-scraper":
        value["mounts"] = [{"destination": "/app/user_data", "read_only": False, "source_sha256": "v" * 64, "type": "volume"}]
    return value


def container(image: str, service: str, command: list[str], names: list[str], compose_hash: str) -> dict[str, object]:
    record: dict[str, object] = {
        "container_id": service + "-" + image,
        "image_id": image,
        "running": True,
        "health": "healthy",
        "restart_count": 0,
        "compose_labels": {"com.docker.compose.config-hash": compose_hash},
        "semantic": semantic(image, service, command, names, compose_hash),
    }
    if service == "max-web-scraper":
        record["mounts"] = [{"name": "crm_max_user_data", "read_write": True, "target": "/app/user_data", "type": "volume"}]
    return record


class ReleaseEnvironmentBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.runtime = load_profile()

    def setUp(self) -> None:
        self.core = SimpleNamespace(RuntimeFault=RuntimeFault)
        self.profile = {
            "predecessor": {
                "gravity": {"image_id": "old-gravity"},
                "max_scraper": {"image_id": "old-max", "volume": {"source_sha256": "v" * 64}},
            },
            "target": {"gravity": {"image_id": "new-gravity"}, "max_scraper": {"image_id": "new-max"}},
            "deployment": {
                "compose_path": "/opt/crm/deploy/docker-compose.production.yml",
                "environment_path": "/opt/crm/.env.production",
                "project_directory": "/opt/crm/deploy",
                "gravity_service": "gravity-mvp",
                "max_service": "max-web-scraper",
            },
            "limits": {"health_timeout_seconds": 180, "activation_timeout_seconds": 300},
        }
        self.state = {
            "environment_sha256": "e" * 64,
            "release_environment_sha256": "s" * 64,
            "gravity_semantic": semantic("old-gravity", "gravity-mvp", MIGRATION_COMMAND, PREDECESSOR_NAMES, "o" * 64),
            "max_semantic": semantic("old-max", "max-web-scraper", ["node", "index.js"], PREDECESSOR_NAMES, "p" * 64),
            "target_gravity_compose_hash": "g" * 64,
            "target_max_compose_hash": "m" * 64,
            "rollback_gravity_compose_hash": "o" * 64,
            "rollback_max_compose_hash": "p" * 64,
            "unrelated_semantic_fingerprint_sha256": "u" * 64,
        }

    def target_pair(self, *, gravity_names=None, max_names=None, gravity_command=None):
        return (
            container("new-gravity", "gravity-mvp", gravity_command or ["npm", "run", "start"],
                      RELEASED_NAMES if gravity_names is None else gravity_names, "g" * 64),
            container("new-max", "max-web-scraper", ["node", "index.js"],
                      RELEASED_NAMES if max_names is None else max_names, "m" * 64),
        )

    def predecessor_pair(self, *, gravity_names=None, max_names=None):
        return (
            container("old-gravity", "gravity-mvp", MIGRATION_COMMAND,
                      PREDECESSOR_NAMES if gravity_names is None else gravity_names, "o" * 64),
            container("old-max", "max-web-scraper", ["node", "index.js"],
                      PREDECESSOR_NAMES if max_names is None else max_names, "p" * 64),
        )

    def postcheck(self, pair, expected: str):
        with (
            mock.patch.object(self.runtime, "_validate_compose_inputs"),
            mock.patch.object(self.runtime, "_wait_pair", return_value=pair),
            mock.patch.object(self.runtime, "_database_status", return_value={"state": "EXACT"}),
            mock.patch.object(self.runtime, "_unrelated_fingerprint", return_value="u" * 64),
            mock.patch.object(self.runtime, "_release_environment", side_effect=AssertionError("postcheck must not read release sources")),
        ):
            return self.runtime._postcheck(self.core, {}, self.profile, self.state, expected)

    def assertFault(self, code: str, call, *args, **kwargs) -> RuntimeFault:
        with self.assertRaises(RuntimeFault) as raised:
            call(*args, **kwargs)
        self.assertEqual(raised.exception.code, code)
        self.assertNotIn(SECRET, repr(raised.exception.details))
        self.assertNotIn(SECRET, str(raised.exception))
        return raised.exception


class ActivationSemanticTests(ReleaseEnvironmentBase):
    def test_gravity_addition_of_the_sealed_name_is_accepted(self) -> None:
        expected = self.runtime._expected_pair_semantic(self.core, "gravity-mvp", self.state["gravity_semantic"], target=True)
        self.assertEqual(expected["environment_names"], RELEASED_NAMES)
        gravity, _ = self.target_pair()
        self.assertEqual(
            self.runtime._preserved_semantic(gravity["semantic"]), self.runtime._preserved_semantic(expected)
        )
        self.assertEqual(self.postcheck(self.target_pair(), "TARGET_PAIR")["pair_state"], "TARGET_PAIR")

    def test_max_addition_of_the_sealed_name_is_accepted(self) -> None:
        expected = self.runtime._expected_pair_semantic(self.core, "max-web-scraper", self.state["max_semantic"], target=True)
        self.assertEqual(expected["environment_names"], RELEASED_NAMES)
        _, maximum = self.target_pair()
        self.assertEqual(
            self.runtime._preserved_semantic(maximum["semantic"]), self.runtime._preserved_semantic(expected)
        )
        self.assertTrue(self.postcheck(self.target_pair(), "TARGET_PAIR")["healthy"])

    def test_tg_bot_same_addition_is_rejected(self) -> None:
        tg_bot = semantic("bot", "tg-bot", ["npm", "start"], PREDECESSOR_NAMES, "t" * 64)
        self.assertFault(
            "RELEASE_ENVIRONMENT_SERVICE_NOT_ADMITTED",
            self.runtime._expected_pair_semantic, self.core, "tg-bot", tg_bot, target=True,
        )
        self.assertFault(
            "RELEASE_ENVIRONMENT_SERVICE_NOT_ADMITTED",
            self.runtime._admit_release_environment_projection,
            self.core, "tg-bot", {"environment": {"A": "1"}}, {"environment": {"A": "1", NAME: SECRET}}, SECRET,
        )
        self.assertNotIn("tg-bot", self.runtime.RELEASE_ENVIRONMENT_SOURCES)

    def test_arbitrary_foo_secret_for_gravity_is_rejected(self) -> None:
        for names in (sorted([*RELEASED_NAMES, "FOO_SECRET"]), sorted([*PREDECESSOR_NAMES, "FOO_SECRET"])):
            with self.subTest(names=names):
                self.assertFault("GRAVITY_RUNTIME_SEMANTIC_DRIFT", self.postcheck, self.target_pair(gravity_names=names), "TARGET_PAIR")

    def test_arbitrary_foo_secret_for_max_is_rejected(self) -> None:
        names = sorted([*RELEASED_NAMES, "FOO_SECRET"])
        self.assertFault("MAX_RUNTIME_SEMANTIC_DRIFT", self.postcheck, self.target_pair(max_names=names), "TARGET_PAIR")

    def test_removal_of_an_existing_name_is_rejected(self) -> None:
        removed = [name for name in RELEASED_NAMES if name != "DATABASE_URL"]
        self.assertFault("GRAVITY_RUNTIME_SEMANTIC_DRIFT", self.postcheck, self.target_pair(gravity_names=removed), "TARGET_PAIR")
        self.assertFault("MAX_RUNTIME_SEMANTIC_DRIFT", self.postcheck, self.target_pair(max_names=removed), "TARGET_PAIR")

    def test_change_of_the_unrelated_environment_set_is_rejected(self) -> None:
        swapped = sorted([name for name in RELEASED_NAMES if name != "PATH"] + ["LD_PRELOAD"])
        self.assertFault("MAX_RUNTIME_SEMANTIC_DRIFT", self.postcheck, self.target_pair(max_names=swapped), "TARGET_PAIR")
        self.assertFault("GRAVITY_RUNTIME_SEMANTIC_DRIFT", self.postcheck, self.target_pair(gravity_names=swapped), "TARGET_PAIR")

    def test_missing_the_sealed_name_after_activation_is_rejected(self) -> None:
        self.assertFault("GRAVITY_RUNTIME_SEMANTIC_DRIFT", self.postcheck, self.target_pair(gravity_names=PREDECESSOR_NAMES), "TARGET_PAIR")
        self.assertFault("MAX_RUNTIME_SEMANTIC_DRIFT", self.postcheck, self.target_pair(max_names=PREDECESSOR_NAMES), "TARGET_PAIR")

    def test_release_name_reaching_any_other_running_service_is_rejected(self) -> None:
        # The pair expectation never covers another container; any change to an unrelated
        # service's runtime semantic (for example tg-bot gaining the name) moves the fingerprint.
        with (
            mock.patch.object(self.runtime, "_validate_compose_inputs"),
            mock.patch.object(self.runtime, "_wait_pair", return_value=self.target_pair()),
            mock.patch.object(self.runtime, "_database_status", return_value={"state": "EXACT"}),
            mock.patch.object(self.runtime, "_unrelated_fingerprint", return_value="x" * 64),
        ):
            self.assertFault(
                "UNRELATED_SERVICE_CHANGED_DURING_RELEASE",
                self.runtime._postcheck, self.core, {}, self.profile, self.state, "TARGET_PAIR",
            )

    def test_predecessor_already_carrying_the_name_is_refused(self) -> None:
        carrying = {**self.state["gravity_semantic"], "environment_names": RELEASED_NAMES}
        self.assertFault(
            "RELEASE_ENVIRONMENT_ALREADY_PRESENT",
            self.runtime._expected_pair_semantic, self.core, "gravity-mvp", carrying, target=True,
        )

    def test_unusable_predecessor_environment_projection_is_refused(self) -> None:
        for names in (None, "NODE_ENV", ["PATH", "NODE_ENV"], ["PATH", "PATH"], [""], [1]):
            with self.subTest(names=names):
                value = {**self.state["gravity_semantic"], "environment_names": names}
                self.assertFault(
                    "RELEASE_ENVIRONMENT_PREDECESSOR_INVALID",
                    self.runtime._expected_pair_semantic, self.core, "gravity-mvp", value, target=True,
                )

    def test_gravity_command_must_remain_npm_run_start(self) -> None:
        self.assertEqual(self.postcheck(self.target_pair(), "TARGET_PAIR")["pair_state"], "TARGET_PAIR")
        self.assertFault(
            "TARGET_RUNTIME_COMMAND_DRIFT", self.postcheck, self.target_pair(gravity_command=["npm", "start"]), "TARGET_PAIR"
        )

    def test_migration_command_is_rejected_after_activation(self) -> None:
        self.assertFault(
            "TARGET_RUNTIME_COMMAND_DRIFT", self.postcheck, self.target_pair(gravity_command=MIGRATION_COMMAND), "TARGET_PAIR"
        )


class RollbackInvariantTests(ReleaseEnvironmentBase):
    def test_rollback_to_old_gravity_passes_without_the_release_name(self) -> None:
        result = self.postcheck(self.predecessor_pair(), "PREDECESSOR_PAIR")
        self.assertEqual(result["gravity_image_id"], "old-gravity")

    def test_rollback_to_old_max_passes_without_the_release_name(self) -> None:
        result = self.postcheck(self.predecessor_pair(), "PREDECESSOR_PAIR")
        self.assertEqual(result["max_image_id"], "old-max")

    def test_exception_does_not_apply_to_rollback(self) -> None:
        self.assertFault("GRAVITY_RUNTIME_SEMANTIC_DRIFT", self.postcheck, self.predecessor_pair(gravity_names=RELEASED_NAMES), "PREDECESSOR_PAIR")
        self.assertFault("MAX_RUNTIME_SEMANTIC_DRIFT", self.postcheck, self.predecessor_pair(max_names=RELEASED_NAMES), "PREDECESSOR_PAIR")
        extra = sorted([*PREDECESSOR_NAMES, "FOO_SECRET"])
        self.assertFault("GRAVITY_RUNTIME_SEMANTIC_DRIFT", self.postcheck, self.predecessor_pair(gravity_names=extra), "PREDECESSOR_PAIR")

    def test_rollback_expectation_is_the_unchanged_predecessor_for_any_service_name(self) -> None:
        for service in ("gravity-mvp", "max-web-scraper"):
            predecessor = self.state["gravity_semantic"]
            self.assertIs(self.runtime._expected_pair_semantic(self.core, service, predecessor, target=False), predecessor)

    def run_rollback_from(self, current_pair) -> tuple[dict[str, object], bool, mock.Mock]:
        predecessor = self.predecessor_pair()
        calls = iter([current_pair])
        composed: list[list[str]] = []

        def fake_run(_core, args, **_kwargs):
            composed.append(list(args))
            return SimpleNamespace(stdout=b"", returncode=0)

        with tempfile.TemporaryDirectory() as raw:
            core = SimpleNamespace(RuntimeFault=RuntimeFault, mapped=lambda path: Path(raw) / Path(path).name)
            with (
                mock.patch.object(self.runtime, "_pair", side_effect=lambda *_: next(calls)),
                mock.patch.object(self.runtime, "_assert_rollback_material"),
                mock.patch.object(self.runtime, "_validate_compose_inputs"),
                mock.patch.object(self.runtime, "_validate_projection"),
                mock.patch.object(self.runtime, "_run", side_effect=fake_run),
                mock.patch.object(self.runtime, "_wait_pair", return_value=predecessor),
                mock.patch.object(self.runtime, "_database_status", return_value={"state": "EXACT"}),
                mock.patch.object(self.runtime, "_unrelated_fingerprint", return_value="u" * 64),
                mock.patch.object(self.runtime, "_release_environment", side_effect=AssertionError("rollback read a release source")) as release,
                mock.patch.object(self.runtime, "_validate_release_environment", side_effect=AssertionError("rollback validated a release source")),
            ):
                post, mutated = self.runtime._rollback_pair(core, {}, self.profile, self.state)
        self.assertEqual(len(composed), 1)
        self.assertEqual(composed[0][-2:], ["gravity-mvp", "max-web-scraper"])
        self.assertIn(self.runtime.ROLLBACK_OVERLAY, composed[0])
        self.assertNotIn(self.runtime.ACTIVATE_OVERLAY, composed[0])
        return post, mutated, release

    def test_failed_activation_with_released_target_rolls_back_both_old_images(self) -> None:
        post, mutated, release = self.run_rollback_from(self.target_pair())
        self.assertTrue(mutated)
        self.assertEqual((post["gravity_image_id"], post["max_image_id"]), ("old-gravity", "old-max"))
        release.assert_not_called()

    def test_mixed_pair_rollback_never_depends_on_release_sources(self) -> None:
        gravity, _ = self.target_pair()
        _, maximum = self.predecessor_pair()
        post, mutated, release = self.run_rollback_from((gravity, maximum))
        self.assertTrue(mutated)
        self.assertEqual(post["pair_state"], "PREDECESSOR_PAIR")
        release.assert_not_called()

    def test_rollback_overlay_attaches_no_environment_source(self) -> None:
        rollback = self.runtime._compose_overlay(self.runtime.ROLLBACK_GRAVITY, self.runtime.ROLLBACK_MAX, activate=False).decode("ascii")
        self.assertNotIn("env_file", rollback)
        self.assertNotIn("release-staging", rollback)
        self.assertNotIn("command:", rollback)



class ProjectionTests(ReleaseEnvironmentBase):
    def configs(self):
        base = {
            "name": "crm",
            "networks": {"crm_internal": {"name": "crm_internal"}},
            "services": {
                "gravity-mvp": {
                    "image": "crm/gravity-mvp:wa-history-recovery-20260804",
                    "environment": {"DATABASE_URL": "postgresql://example", "NODE_ENV": "production"},
                    "networks": {"crm_internal": None},
                },
                "max-web-scraper": {
                    "image": "crm/max-web-scraper:latest",
                    "environment": {"CRM_WEBHOOK_URL": "http://gravity-mvp:3002/api/webhooks/max"},
                    "networks": {"crm_internal": None},
                },
                "tg-bot": {"image": "crm/tg-bot:latest", "environment": {"BOT_API": "x"}},
            },
        }
        candidate = copy.deepcopy(base)
        candidate["services"]["gravity-mvp"]["image"] = self.runtime.TARGET_GRAVITY
        candidate["services"]["gravity-mvp"]["command"] = ["npm", "run", "start"]
        candidate["services"]["gravity-mvp"]["environment"][NAME] = SECRET
        candidate["services"]["max-web-scraper"]["image"] = self.runtime.TARGET_MAX
        candidate["services"]["max-web-scraper"]["environment"][NAME] = SECRET
        return base, candidate

    def project(self, base, candidate, *, activate: bool = True, value: str | None = SECRET):
        with (
            mock.patch.object(self.runtime, "_compose_config", side_effect=[base, candidate]),
            mock.patch.object(self.runtime, "_release_environment", side_effect=AssertionError("projection re-read a source")) as release,
        ):
            self.runtime._validate_projection(
                self.core, self.profile, "/overlay", activate=activate, release_value=value if activate else None,
            )
        return release

    def test_exact_activation_projection_is_accepted_for_both_services(self) -> None:
        release = self.project(*self.configs())
        release.assert_not_called()

    def test_projection_requires_the_bound_value_exactly_when_activating(self) -> None:
        base, candidate = self.configs()
        for activate, value in ((True, None), (True, "not-hex"), (False, SECRET)):
            with self.subTest(activate=activate, value=value):
                with mock.patch.object(self.runtime, "_compose_config", side_effect=[base, candidate]):
                    self.assertFault(
                        "RELEASE_ENVIRONMENT_BINDING_INVALID",
                        self.runtime._validate_projection, self.core, self.profile, "/overlay",
                        activate=activate, release_value=value,
                    )

    def test_tg_bot_addition_in_the_rendered_projection_is_rejected(self) -> None:
        base, candidate = self.configs()
        candidate["services"]["tg-bot"]["environment"][NAME] = SECRET
        self.assertFault("UNRELATED_COMPOSE_SERVICE_DRIFT", self.project, base, candidate)

    def test_foo_secret_in_the_rendered_gravity_projection_is_rejected(self) -> None:
        base, candidate = self.configs()
        candidate["services"]["gravity-mvp"]["environment"]["FOO_SECRET"] = "x"
        self.assertFault("PAIR_COMPOSE_PROJECTION_DRIFT", self.project, base, candidate)

    def test_removed_or_changed_rendered_variables_are_rejected(self) -> None:
        base, candidate = self.configs()
        del candidate["services"]["max-web-scraper"]["environment"]["CRM_WEBHOOK_URL"]
        self.assertFault("PAIR_COMPOSE_PROJECTION_DRIFT", self.project, base, candidate)
        base, candidate = self.configs()
        candidate["services"]["gravity-mvp"]["environment"]["NODE_ENV"] = "development"
        self.assertFault("PAIR_COMPOSE_PROJECTION_DRIFT", self.project, base, candidate)

    def test_rendered_value_must_be_the_bound_release_material(self) -> None:
        self.assertFault("RELEASE_ENVIRONMENT_PROJECTION_DRIFT", self.project, *self.configs(), value=OTHER_SECRET)
        base, candidate = self.configs()
        del candidate["services"]["max-web-scraper"]["environment"][NAME]
        self.assertFault("RELEASE_ENVIRONMENT_PROJECTION_DRIFT", self.project, base, candidate)

    def test_name_already_in_the_shared_environment_is_refused(self) -> None:
        base, candidate = self.configs()
        base["services"]["gravity-mvp"]["environment"][NAME] = SECRET
        self.assertFault("RELEASE_ENVIRONMENT_ALREADY_PRESENT", self.project, base, candidate)

    def test_migration_command_in_the_activation_projection_is_rejected(self) -> None:
        base, candidate = self.configs()
        candidate["services"]["gravity-mvp"]["command"] = MIGRATION_COMMAND
        self.assertFault("GRAVITY_SAFE_COMMAND_DRIFT", self.project, base, candidate)

    def test_rollback_projection_admits_no_environment_change_and_reads_no_source(self) -> None:
        base, _ = self.configs()
        candidate = copy.deepcopy(base)
        candidate["services"]["gravity-mvp"]["image"] = self.runtime.ROLLBACK_GRAVITY
        candidate["services"]["max-web-scraper"]["image"] = self.runtime.ROLLBACK_MAX
        release = self.project(base, candidate, activate=False, value=None)
        release.assert_not_called()
        candidate = copy.deepcopy(candidate)
        candidate["services"]["gravity-mvp"]["environment"][NAME] = SECRET
        self.assertFault("PAIR_COMPOSE_PROJECTION_DRIFT", self.project, base, candidate, activate=False)


class OverlayAndProfileTests(ReleaseEnvironmentBase):
    def test_activation_overlay_attaches_only_the_two_sealed_sources(self) -> None:
        overlay = self.runtime._compose_overlay(self.runtime.TARGET_GRAVITY, self.runtime.TARGET_MAX, activate=True).decode("ascii")
        self.assertEqual(overlay.count("env_file:"), 2)
        self.assertEqual(
            re.findall(r"^      - (.+)$", overlay, re.MULTILINE),
            [
                "/var/lib/crm/release-staging/messaging-be6b8eb8/gravity-mvp.env",
                "/var/lib/crm/release-staging/messaging-be6b8eb8/max-web-scraper.env",
            ],
        )
        self.assertEqual(re.findall(r"^  ([a-z-]+):$", overlay, re.MULTILINE), ["gravity-mvp", "max-web-scraper"])
        self.assertIn('command: ["npm", "run", "start"]', overlay)
        self.assertNotIn("prisma", overlay)
        self.assertNotIn(NAME, overlay)
        self.assertNotIn(".env.production", overlay)

    def test_overlay_refuses_crossed_or_foreign_references(self) -> None:
        for gravity, maximum, activate in (
            (self.runtime.ROLLBACK_GRAVITY, self.runtime.ROLLBACK_MAX, True),
            (self.runtime.TARGET_GRAVITY, self.runtime.TARGET_MAX, False),
            (self.runtime.TARGET_GRAVITY, self.runtime.ROLLBACK_MAX, True),
            ("foreign", self.runtime.TARGET_MAX, True),
        ):
            with self.subTest(gravity=gravity, maximum=maximum, activate=activate):
                with self.assertRaisesRegex(RuntimeError, "IMAGE_REFERENCE_INVALID"):
                    self.runtime._compose_overlay(gravity, maximum, activate=activate)

    def test_sealed_contract_is_constant_and_not_extendable(self) -> None:
        with self.assertRaises(TypeError):
            self.runtime.RELEASE_ENVIRONMENT_SOURCES["tg-bot"] = "/tmp/x"  # type: ignore[index]
        self.assertEqual(set(self.runtime.RELEASE_ENVIRONMENT_SOURCES), {"gravity-mvp", "max-web-scraper"})
        self.assertEqual(self.runtime.RELEASE_ENVIRONMENT_NAME, NAME)

    def rendered_profile(self) -> dict[str, object]:
        raw = (ROOT / "templates/profile.v1.json.in").read_text(encoding="utf-8")
        rendered = raw.replace("@ARTIFACT_FILES_JSON@", "{}")
        rendered = re.sub(r'"@[A-Z_]+@"', '"placeholder"', rendered)
        return json.loads(rendered)

    def load(self, profile: dict[str, object]):
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / "profile.v1.json"
            path.write_text(json.dumps(profile), encoding="utf-8")
            core = SimpleNamespace(
                RuntimeFault=RuntimeFault,
                secure_file=lambda *_args, **_kwargs: os.stat(path),
                mapped=lambda _value: path,
                parse_json=lambda value, maximum: json.loads(value),
            )
            return self.runtime._load_profile(core)

    def test_sealed_profile_section_matches_the_runtime_contract(self) -> None:
        profile = self.rendered_profile()
        self.assertEqual(profile["release_environment"], dict(self.runtime.RELEASE_ENVIRONMENT_CONTRACT))
        self.assertIs(profile["negative_properties"]["arbitrary_environment_override"], False)
        self.assertIs(profile["negative_properties"]["arbitrary_artifact_selection"], False)
        self.assertIn("config-activate", profile["disabled_profiles"])
        self.assertIn("database-migrate", profile["disabled_profiles"])
        self.assertEqual(self.load(profile)["release_environment"]["name"], NAME)

    def test_profile_that_widens_the_release_environment_is_refused(self) -> None:
        mutations = [
            lambda value: value["release_environment"].__setitem__("name", "FOO_SECRET"),
            lambda value: value["release_environment"]["sources"].__setitem__("tg-bot", "/var/lib/crm/x.env"),
            lambda value: value["release_environment"].__setitem__("attached_on_rollback", True),
            lambda value: value["release_environment"]["sources"].__setitem__("gravity-mvp", "/tmp/gravity.env"),
            lambda value: value.pop("release_environment"),
            lambda value: value["negative_properties"].__setitem__("arbitrary_environment_override", True),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(mutation=index):
                profile = self.rendered_profile()
                mutate(profile)
                self.assertFault("ACTIVATION_PROFILE_INVALID", self.load, profile)

    def test_arbitrary_artifact_selection_remains_disabled(self) -> None:
        profile = self.rendered_profile()
        self.assertIs(profile["negative_properties"]["arbitrary_artifact_selection"], False)
        for resource, relative in (("crm.container.gravity_mvp", None), (None, "../artifact.tar"), ("x", "y")):
            with self.subTest(resource=resource, relative=relative):
                invocation = SimpleNamespace(primitive="release-preflight", resource=resource, relative_path=relative)
                with mock.patch.object(self.runtime, "_load_profile", return_value=profile):
                    self.assertFault("PROFILE_ARGUMENTS_FORBIDDEN", self.runtime.dispatch, self.core, {}, invocation)
        stage_a = self.rendered_profile()
        stage_a["stage_a"]["artifact_id"] = 1
        self.assertFault("ACTIVATION_PROFILE_INVALID", self.load, stage_a)
        for primitive in ("config-activate", "database-migrate", "artifact-select"):
            with self.subTest(primitive=primitive):
                invocation = SimpleNamespace(primitive=primitive, resource=None, relative_path=None)
                with mock.patch.object(self.runtime, "_load_profile", return_value=profile):
                    self.assertFault("PROFILE_DISABLED", self.runtime.dispatch, self.core, {}, invocation)


def load_core():
    loader = importlib.machinery.SourceFileLoader(
        "yoko_release_environment_core_tests",
        str(ROOT / "src/yoko-privileged-runtime-core.py"),
    )
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    loader.exec_module(module)
    return module


class ReleaseSourceTests(unittest.TestCase):
    """Uses the real Runtime core in its test-root mode, so ownership and mode checks are real."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.runtime = load_profile()
        cls.core = load_core()

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        os.chmod(self.root, 0o700)
        self.previous_root = self.core._test_root
        self.core._test_root = self.root
        release = self.core.mapped(self.runtime.RELEASE_ENVIRONMENT_DIRECTORY)
        release.mkdir(parents=True, mode=0o700)
        for parent in [release, *release.parents]:
            if parent == self.root:
                break
            os.chmod(parent, 0o700 if parent == release or parent.name == "release-staging" else 0o755)
        for service in self.runtime.RELEASE_ENVIRONMENT_SOURCES:
            self.write(service, f"{NAME}={SECRET}\n".encode("ascii"))

    def tearDown(self) -> None:
        self.core._test_root = self.previous_root
        self.directory.cleanup()

    def path(self, service: str) -> Path:
        return self.core.mapped(self.runtime.RELEASE_ENVIRONMENT_SOURCES[service])

    def write(self, service: str, raw: bytes, mode: int = 0o600) -> None:
        target = self.path(service)
        if target.is_symlink() or target.exists():
            target.unlink()
        target.write_bytes(raw)
        target.chmod(mode)

    def assertSourceFault(self, code: str) -> None:
        with self.assertRaises(self.core.RuntimeFault) as raised:
            self.runtime._release_environment(self.core)
        self.assertEqual(raised.exception.code, code)
        self.assertNotIn(SECRET, repr(raised.exception.details) + str(raised.exception))

    def test_identical_sealed_sources_are_bound_by_digest(self) -> None:
        first = self.runtime._release_environment(self.core)
        self.assertEqual(first["value"], SECRET)
        self.assertRegex(first["sha256"], r"^[0-9a-f]{64}$")
        self.assertNotIn(SECRET, first["sha256"])
        self.assertEqual(self.runtime._release_environment(self.core)["sha256"], first["sha256"])

    def test_both_runtimes_must_receive_the_same_material(self) -> None:
        self.write("max-web-scraper", f"{NAME}={OTHER_SECRET}\n".encode("ascii"))
        self.assertSourceFault("RELEASE_ENVIRONMENT_MATERIAL_MISMATCH")

    def test_malformed_sources_are_refused(self) -> None:
        cases = [
            f"FOO_SECRET={SECRET}\n",
            f"{NAME}={SECRET}",
            f"{NAME}={SECRET}\nFOO_SECRET=1\n",
            f"{NAME}={SECRET}\nNODE_OPTIONS=--require=/tmp/x.js\n",
            f"{NAME}={SECRET.upper()}\n",
            f"{NAME}={SECRET[:-1]}\n",
            f"{NAME}={SECRET}0\n",
            f"{NAME}= {SECRET}\n",
            f"{NAME}={SECRET}\r\n",
            f"export {NAME}={SECRET}\n",
            f"{NAME}=\"{SECRET}\"\n",
            f"{NAME}=${{OTHER}}{SECRET[6:]}\n",
            "",
        ]
        for raw in cases:
            with self.subTest(raw=raw.replace(SECRET, "<value>")):
                self.write("gravity-mvp", raw.encode("ascii"))
                self.assertSourceFault("RELEASE_ENVIRONMENT_SOURCE_INVALID")

    def test_unsafe_source_files_are_refused(self) -> None:
        self.write("gravity-mvp", f"{NAME}={SECRET}\n".encode("ascii"), mode=0o644)
        self.assertSourceFault("RELEASE_ENVIRONMENT_SOURCE_UNSAFE")
        self.write("gravity-mvp", f"{NAME}={SECRET}\n".encode("ascii"))
        target = self.path("max-web-scraper")
        target.unlink()
        target.symlink_to(self.path("gravity-mvp"))
        self.assertSourceFault("RELEASE_ENVIRONMENT_SOURCE_UNSAFE")
        target.unlink()
        self.assertSourceFault("RELEASE_ENVIRONMENT_SOURCE_UNSAFE")
        os.link(self.path("gravity-mvp"), target)
        self.assertSourceFault("RELEASE_ENVIRONMENT_SOURCE_UNSAFE")

    def test_source_directory_must_be_root_only(self) -> None:
        release = self.core.mapped(self.runtime.RELEASE_ENVIRONMENT_DIRECTORY)
        for mode in (0o750, 0o770, 0o755):
            with self.subTest(mode=oct(mode)):
                os.chmod(release, mode)
                self.assertSourceFault("RELEASE_ENVIRONMENT_SOURCE_UNSAFE")
        os.chmod(release, 0o700)
        self.runtime._release_environment(self.core)

    def test_group_or_other_writable_ancestor_is_refused(self) -> None:
        ancestor = self.core.mapped("/var/lib/crm")
        for mode in (0o775, 0o757):
            with self.subTest(mode=oct(mode)):
                os.chmod(ancestor, mode)
                self.assertSourceFault("RELEASE_ENVIRONMENT_SOURCE_UNSAFE")
        os.chmod(ancestor, 0o755)
        self.runtime._release_environment(self.core)

    def test_caller_writable_chain_is_refused(self) -> None:
        with mock.patch.object(self.core, "assert_noncaller_writable_chain", side_effect=self.core.RuntimeFault("RESOURCE_CALLER_WRITABLE", 74)):
            self.assertSourceFault("RELEASE_ENVIRONMENT_SOURCE_UNSAFE")

    def test_file_replaced_between_check_and_open_is_refused(self) -> None:
        decoy = self.root / "decoy.env"
        decoy.write_bytes(f"{NAME}={SECRET}\n".encode("ascii"))
        with mock.patch.object(self.runtime, "_fixed_production_file", return_value=os.stat(decoy)):
            self.assertSourceFault("RELEASE_ENVIRONMENT_SOURCE_UNSAFE")

    def test_source_changed_after_preflight_blocks_activation_before_compose(self) -> None:
        state = {"release_environment_sha256": self.runtime._release_environment(self.core)["sha256"]}
        self.assertEqual(self.runtime._validate_release_environment(self.core, state)["value"], SECRET)
        for service in self.runtime.RELEASE_ENVIRONMENT_SOURCES:
            self.write(service, f"{NAME}={OTHER_SECRET}\n".encode("ascii"))
        profile = {"deployment": {}}
        with (
            mock.patch.object(self.runtime, "_validate_compose_inputs"),
            mock.patch.object(self.runtime, "_validate_projection") as projection,
            mock.patch.object(self.runtime, "_run") as run,
        ):
            with self.assertRaises(self.core.RuntimeFault) as raised:
                self.runtime._compose_up(self.core, profile, state, self.runtime.ACTIVATE_OVERLAY, activate=True)
        self.assertEqual(raised.exception.code, "RELEASE_ENVIRONMENT_IDENTITY_DRIFT")
        projection.assert_not_called()
        run.assert_not_called()
        with self.assertRaises(self.core.RuntimeFault) as raised:
            self.runtime._validate_release_environment(self.core, {})
        self.assertEqual(raised.exception.code, "RELEASE_ENVIRONMENT_IDENTITY_DRIFT")


class ReleaseActivateEndToEndTests(ReleaseEnvironmentBase):
    """Drives the real release-activate state machine; only Docker, locks and I/O are stubbed."""

    def setUp(self) -> None:
        super().setUp()
        self.directory = tempfile.TemporaryDirectory()
        logs = Path(self.directory.name)
        self.core = SimpleNamespace(
            RuntimeFault=RuntimeFault,
            audit_status=lambda: {"state": "VALID"},
            now=lambda: "2026-09-16T00:00:00Z",
            mapped=lambda path: logs / Path(path).name,
        )
        self.state = {**self.state, "schema": self.runtime.STATE_SCHEMA, "profile_id": self.runtime.PROFILE_ID, "phase": "PREFLIGHTED"}
        self.invocation = SimpleNamespace(primitive="release-activate", resource=None, relative_path=None)

    def tearDown(self) -> None:
        self.directory.cleanup()

    def activate(self, *, release, pair_sequence, wait_sequence):
        writes: list[dict[str, object]] = []
        composed: list[list[str]] = []
        projections: list[tuple[bool, object]] = []
        pairs = iter(pair_sequence)
        waits = iter(wait_sequence)

        def run(_core, args, **_kwargs):
            composed.append(list(args))
            return SimpleNamespace(stdout=b"", returncode=0)

        def projection(_core, _profile, overlay, *, activate, release_value=None):
            projections.append((activate, release_value))

        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value=dict(self.state)),
            mock.patch.object(self.runtime, "_pair", side_effect=lambda *_: next(pairs)),
            mock.patch.object(self.runtime, "_wait_pair", side_effect=lambda *_: next(waits)),
            mock.patch.object(self.runtime, "_validate_compose_inputs"),
            mock.patch.object(self.runtime, "_validate_target_image"),
            mock.patch.object(self.runtime, "_validate_release_environment", side_effect=release) as validated,
            mock.patch.object(self.runtime, "_release_environment", side_effect=AssertionError("unbound source read")),
            mock.patch.object(self.runtime, "_validate_projection", side_effect=projection),
            mock.patch.object(self.runtime, "_run", side_effect=run),
            mock.patch.object(self.runtime, "_database_status", return_value={"state": "EXACT"}),
            mock.patch.object(self.runtime, "_unrelated_fingerprint", return_value="u" * 64),
            mock.patch.object(self.runtime, "_assert_rollback_material"),
            mock.patch.object(self.runtime, "_write_state", side_effect=lambda _c, value: writes.append(value)),
            mock.patch.object(self.runtime, "_audit"),
        ):
            try:
                result = self.runtime._release_activate(self.core, {}, self.profile, self.invocation)
                failure = None
            except RuntimeFault as exc:
                result, failure = None, exc
        return result, failure, writes, composed, projections, validated

    def bound(self, *_args):
        return {"sha256": "s" * 64, "value": SECRET}

    def test_activation_delivers_exactly_the_bound_release_name(self) -> None:
        predecessor, target = self.predecessor_pair(), self.target_pair()
        result, failure, writes, composed, projections, validated = self.activate(
            release=self.bound, pair_sequence=[predecessor], wait_sequence=[target],
        )
        self.assertIsNone(failure)
        self.assertEqual(result["status"], "ACTIVATED")
        self.assertEqual([value["phase"] for value in writes], ["ACTIVATION_INTENT", "ACTIVATED"])
        self.assertEqual(validated.call_count, 2)
        self.assertEqual(projections, [(True, SECRET)])
        self.assertEqual(len(composed), 1)
        self.assertIn(self.runtime.ACTIVATE_OVERLAY, composed[0])
        self.assertNotIn(SECRET, repr(writes))

    def test_changed_source_after_preflight_refuses_before_intent_and_compose(self) -> None:
        def drifted(*_args):
            raise RuntimeFault("RELEASE_ENVIRONMENT_IDENTITY_DRIFT", 74)

        result, failure, writes, composed, projections, _ = self.activate(
            release=drifted, pair_sequence=[self.predecessor_pair()], wait_sequence=[],
        )
        self.assertIsNone(result)
        self.assertEqual(failure.code, "RELEASE_ENVIRONMENT_IDENTITY_DRIFT")
        self.assertEqual(writes, [])
        self.assertEqual(composed, [])
        self.assertEqual(projections, [])

    def test_failed_activation_rolls_back_to_both_old_images_without_the_sources(self) -> None:
        predecessor = self.predecessor_pair()
        extra = sorted([*RELEASED_NAMES, "FOO_SECRET"])
        drifted_target = self.target_pair(gravity_names=extra)
        result, failure, writes, composed, projections, validated = self.activate(
            release=self.bound,
            # start: predecessor; after failure: target observed; rollback: target observed
            pair_sequence=[predecessor, drifted_target, drifted_target],
            # activation postcheck sees the drift; rollback postcheck sees the old pair
            wait_sequence=[drifted_target, predecessor],
        )
        self.assertIsNone(result)
        self.assertEqual(failure.code, "ACTIVATION_FAILED_AUTOMATIC_ROLLBACK_OK")
        self.assertEqual(failure.details["activation_failure"]["code"], "GRAVITY_RUNTIME_SEMANTIC_DRIFT")
        self.assertEqual(failure.details["rollback"]["pair_state"], "PREDECESSOR_PAIR")
        self.assertEqual((failure.details["rollback"]["gravity_image_id"], failure.details["rollback"]["max_image_id"]), ("old-gravity", "old-max"))
        self.assertEqual(writes[-1]["phase"], "ROLLED_BACK")
        # Sources were consulted only before the intent and at the activation boundary.
        self.assertEqual(validated.call_count, 2)
        self.assertEqual(projections, [(True, SECRET), (False, None)])
        self.assertEqual(len(composed), 2)
        self.assertIn(self.runtime.ACTIVATE_OVERLAY, composed[0])
        self.assertIn(self.runtime.ROLLBACK_OVERLAY, composed[1])

    def test_rollback_after_sources_are_deleted_still_restores_the_old_pair(self) -> None:
        def missing(*_args):
            raise RuntimeFault("RELEASE_ENVIRONMENT_SOURCE_UNSAFE", 74)

        state = {**self.state, "phase": "ACTIVATED"}
        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value=state),
            mock.patch.object(self.runtime, "_pair", return_value=self.target_pair()),
            mock.patch.object(self.runtime, "_wait_pair", return_value=self.predecessor_pair()),
            mock.patch.object(self.runtime, "_validate_compose_inputs"),
            mock.patch.object(self.runtime, "_validate_projection"),
            mock.patch.object(self.runtime, "_validate_release_environment", side_effect=missing) as validated,
            mock.patch.object(self.runtime, "_release_environment", side_effect=missing) as read,
            mock.patch.object(self.runtime, "_run", return_value=SimpleNamespace(stdout=b"", returncode=0)),
            mock.patch.object(self.runtime, "_database_status", return_value={"state": "EXACT"}),
            mock.patch.object(self.runtime, "_unrelated_fingerprint", return_value="u" * 64),
            mock.patch.object(self.runtime, "_assert_rollback_material"),
            mock.patch.object(self.runtime, "_write_state") as write,
            mock.patch.object(self.runtime, "_audit"),
        ):
            result = self.runtime._rollback(self.core, {}, self.profile, SimpleNamespace(primitive="rollback", resource=None, relative_path=None))
        self.assertEqual(result["status"], "ROLLED_BACK")
        self.assertEqual(result["postcheck"]["pair_state"], "PREDECESSOR_PAIR")
        validated.assert_not_called()
        read.assert_not_called()
        self.assertEqual(write.call_args.args[1]["phase"], "ROLLED_BACK")


def compose_available() -> bool:
    try:
        completed = subprocess.run(["/usr/bin/docker", "compose", "version"], capture_output=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0


@unittest.skipUnless(compose_available(), "docker compose CLI is not available")
class RealComposeRenderTests(unittest.TestCase):
    """Renders the real overlay with the real Compose CLI; no daemon, no container, no production file."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.runtime = load_profile()

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        (root / "deploy").mkdir()
        self.environment = root / ".env.production"
        self.environment.write_text("SHARED_A=1\nPOSTGRES_USER=u\n", encoding="ascii")
        (root / "deploy/docker-compose.production.yml").write_text(
            "services:\n"
            "  gravity-mvp:\n    image: crm/gravity-mvp:x\n    env_file:\n      - ../.env.production\n"
            "    environment:\n      NODE_ENV: production\n      DATABASE_URL: postgresql://${POSTGRES_USER}@postgres\n"
            "  max-web-scraper:\n    image: crm/max:x\n    env_file:\n      - ../.env.production\n"
            "    environment:\n      CRM_WEBHOOK_URL: http://gravity-mvp:3002/api/webhooks/max\n"
            "  tg-bot:\n    image: crm/tg:x\n    env_file:\n      - ../.env.production\n",
            encoding="ascii",
        )
        self.release = root / "release"
        self.release.mkdir(mode=0o700)
        self.sources = {service: str(self.release / f"{service}.env") for service in ("gravity-mvp", "max-web-scraper")}
        for path in self.sources.values():
            Path(path).write_text(f"{NAME}={SECRET}\n", encoding="ascii")
        self.profile = {"deployment": {
            "compose_path": str(root / "deploy/docker-compose.production.yml"),
            "environment_path": str(self.environment),
            "project_directory": str(root / "deploy"),
        }}
        self.core = SimpleNamespace(
            RuntimeFault=RuntimeFault,
            mapped=lambda path: Path(path),
            command_env=lambda: {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": str(root)},
        )
        self.root = root
        self.patch = mock.patch.object(self.runtime, "RELEASE_ENVIRONMENT_SOURCES", self.sources)
        self.patch.start()

    def tearDown(self) -> None:
        self.patch.stop()
        self.directory.cleanup()

    def overlay(self, activate: bool, extra: str = "") -> str:
        target = self.root / ("activate.yml" if activate else "rollback.yml")
        references = (self.runtime.TARGET_GRAVITY, self.runtime.TARGET_MAX) if activate else (self.runtime.ROLLBACK_GRAVITY, self.runtime.ROLLBACK_MAX)
        target.write_bytes(self.runtime._compose_overlay(*references, activate=activate) + extra.encode("ascii"))
        return str(target)

    def test_real_render_adds_the_name_to_exactly_the_two_services(self) -> None:
        activate = self.overlay(True)
        self.runtime._validate_projection(self.core, self.profile, activate, activate=True, release_value=SECRET)
        rollback = self.overlay(False)
        self.runtime._validate_projection(self.core, self.profile, rollback, activate=False)
        base = self.runtime._compose_config(self.core, self.runtime._compose_args(self.profile))
        rendered = self.runtime._compose_config(self.core, self.runtime._compose_args(self.profile, activate))
        restored = self.runtime._compose_config(self.core, self.runtime._compose_args(self.profile, rollback))
        for service in ("gravity-mvp", "max-web-scraper", "tg-bot"):
            added = set(rendered["services"][service].get("environment", {})) - set(base["services"][service].get("environment", {}))
            removed = set(base["services"][service].get("environment", {})) - set(rendered["services"][service].get("environment", {}))
            self.assertEqual(added, {NAME} if service != "tg-bot" else set())
            self.assertEqual(removed, set())
            self.assertNotIn(NAME, restored["services"][service].get("environment", {}))
        self.assertEqual(rendered["services"]["gravity-mvp"]["command"], ["npm", "run", "start"])
        hashes = {
            (overlay, service): self.runtime._compose_hash(self.core, self.profile, overlay, service)
            for overlay in (activate, rollback) for service in ("gravity-mvp", "max-web-scraper")
        }
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{64}", value) for value in hashes.values()))
        self.assertNotEqual(hashes[(activate, "gravity-mvp")], hashes[(rollback, "gravity-mvp")])

    def test_real_render_rejects_tg_bot_receiving_the_source(self) -> None:
        activate = self.overlay(True, f"  tg-bot:\n    env_file:\n      - {self.sources['gravity-mvp']}\n")
        with self.assertRaises(RuntimeFault) as raised:
            self.runtime._validate_projection(self.core, self.profile, activate, activate=True, release_value=SECRET)
        self.assertEqual(raised.exception.code, "UNRELATED_COMPOSE_SERVICE_DRIFT")

    def test_real_render_rejects_a_source_that_injects_another_variable(self) -> None:
        Path(self.sources["gravity-mvp"]).write_text(f"{NAME}={SECRET}\nNODE_OPTIONS=--require=/tmp/x.js\n", encoding="ascii")
        with self.assertRaises(RuntimeFault) as raised:
            self.runtime._validate_projection(self.core, self.profile, self.overlay(True), activate=True, release_value=SECRET)
        self.assertEqual(raised.exception.code, "PAIR_COMPOSE_PROJECTION_DRIFT")

    def test_real_render_rejects_a_value_other_than_the_bound_one(self) -> None:
        with self.assertRaises(RuntimeFault) as raised:
            self.runtime._validate_projection(self.core, self.profile, self.overlay(True), activate=True, release_value=OTHER_SECRET)
        self.assertEqual(raised.exception.code, "RELEASE_ENVIRONMENT_PROJECTION_DRIFT")
        self.assertNotIn(SECRET, repr(raised.exception.details))


class PreflightBindingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.runtime = load_profile()

    def test_preflight_refuses_before_loading_when_release_sources_are_invalid(self) -> None:
        core = SimpleNamespace(RuntimeFault=RuntimeFault, audit_status=lambda: {"state": "VALID"}, now=lambda: "2026-09-16T00:00:00Z")
        profile = {
            "predecessor": {"gravity": {"image_id": "old-g"}, "max_scraper": {"image_id": "old-m"}},
            "target": {"gravity": {"image_id": "new-g"}, "max_scraper": {"image_id": "new-m"}},
        }
        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value={"phase": "UNINITIALIZED"}),
            mock.patch.object(self.runtime, "_pair", return_value=({"image_id": "old-g"}, {"image_id": "old-m"})),
            mock.patch.object(self.runtime, "_predecessor_identity", return_value={}),
            mock.patch.object(self.runtime, "_release_environment", side_effect=RuntimeFault("RELEASE_ENVIRONMENT_SOURCE_INVALID", 74)),
            mock.patch.object(self.runtime, "_artifact_receipt") as receipt,
            mock.patch.object(self.runtime, "_load_target") as load,
            mock.patch.object(self.runtime, "_write_state") as write,
            mock.patch.object(self.runtime, "_compose_up") as compose,
        ):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._release_preflight(core, {}, profile, SimpleNamespace(primitive="release-preflight", resource=None, relative_path=None))
        self.assertEqual(raised.exception.code, "RELEASE_ENVIRONMENT_SOURCE_INVALID")
        receipt.assert_not_called()
        load.assert_not_called()
        write.assert_not_called()
        compose.assert_not_called()

    def test_predecessor_identity_refuses_a_predecessor_that_already_carries_the_name(self) -> None:
        core = SimpleNamespace(RuntimeFault=RuntimeFault)
        profile = {
            "predecessor": {
                "gravity": {"image_id": "old-g", "container_id": "cg", "compose_config_hash": "hg"},
                "max_scraper": {"image_id": "old-m", "container_id": "cm", "compose_config_hash": "hm"},
            },
            "target": {"gravity": {"image_id": "new-g"}, "max_scraper": {"image_id": "new-m"}},
        }

        def record(image, container_id, config_hash, names):
            return {
                "image_id": image, "container_id": container_id, "running": True, "health": "healthy", "restart_count": 0,
                "compose_labels": {"com.docker.compose.config-hash": config_hash},
                "semantic": {"environment_names": names},
            }

        with (
            mock.patch.object(self.runtime, "_pair", return_value=(record("old-g", "cg", "hg", RELEASED_NAMES), record("old-m", "cm", "hm", PREDECESSOR_NAMES))),
            mock.patch.object(self.runtime, "_max_volume_exact"),
            mock.patch.object(self.runtime, "_database_status") as database,
        ):
            with self.assertRaises(RuntimeFault) as raised:
                self.runtime._predecessor_identity(core, {}, profile, {"phase": "UNINITIALIZED"})
        self.assertEqual(raised.exception.code, "RELEASE_ENVIRONMENT_ALREADY_PRESENT")
        database.assert_not_called()


if __name__ == "__main__":
    unittest.main()
