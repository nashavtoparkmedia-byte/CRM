#!/usr/bin/python3
"""Contract for the sealed Calling B2 environment addition.

Activation may add exactly the twelve Owner-approved Calling B2 names, only to `gravity-mvp`, from
one fixed root-only source attached by the activation overlay. Every other service, every other
environment difference and the whole rollback path stay exact. No rollback transaction runs while
the live Gravity container has either kill switch armed.

Every value below is a synthetic marker, never real material. The markers are checked for absence
from every fault, state record, audit call and result the runtime produces.
"""
from __future__ import annotations

import ast
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
MESSAGING = "MAX_SCRAPER_WEBHOOK_SECRET"
MESSAGING_SECRET = "0123456789abcdef" * 4
CALLING_NAMES = [
    "AI_CALL_CONTROLLED_DESTINATION_E164",
    "AI_CALL_CONTROLLED_OPERATOR_TOKEN",
    "AI_CALL_CONTROLLED_REAL_CALL_ENABLED",
    "AI_CALL_CONTROLLED_REQUEST_ID",
    "AI_CALL_DIAL_STRING_TEMPLATE",
    "AI_CALL_LIVE_MODE",
    "AI_CALL_PARK_EXT",
    "AI_CALL_STT_PROVIDER",
    "AI_CALL_TELEPHONY_PROVIDER",
    "AI_CALL_TTS_PROVIDER",
    "AUDIO_BRIDGE_HEALTH_URL",
    "MEGAFON_NUMBER",
]
LIVE = "AI_CALL_LIVE_MODE"
GATE = "AI_CALL_CONTROLLED_REAL_CALL_ENABLED"
TOKEN_MARKER = "tokenMarkerNotARealSecret0123456789abcdefXYZ"
REQUEST_MARKER = "requestMarker_0123456789"
DESTINATION_MARKER = "+70000000077"
CALLER_MARKER = "+70000000088"
DIAL_TEMPLATE = "sofia/gateway/megafon/${number}"
CALLING_VALUES = {
    "AI_CALL_CONTROLLED_DESTINATION_E164": DESTINATION_MARKER,
    "AI_CALL_CONTROLLED_OPERATOR_TOKEN": TOKEN_MARKER,
    "AI_CALL_CONTROLLED_REAL_CALL_ENABLED": "false",
    "AI_CALL_CONTROLLED_REQUEST_ID": REQUEST_MARKER,
    "AI_CALL_DIAL_STRING_TEMPLATE": DIAL_TEMPLATE,
    "AI_CALL_LIVE_MODE": "false",
    "AI_CALL_PARK_EXT": "9999",
    "AI_CALL_STT_PROVIDER": "yandex",
    "AI_CALL_TELEPHONY_PROVIDER": "freeswitch",
    "AI_CALL_TTS_PROVIDER": "yandex",
    "AUDIO_BRIDGE_HEALTH_URL": "http://audio-bridge:3030/health",
    "MEGAFON_NUMBER": CALLER_MARKER,
}
SECRET_MARKERS = (TOKEN_MARKER, REQUEST_MARKER, DESTINATION_MARKER, CALLER_MARKER, MESSAGING_SECRET)
PREDECESSOR_NAMES = ["DATABASE_URL", "FS_ESL_HOST", "NODE_ENV", "PATH"]
GRAVITY_TARGET_NAMES = sorted([*PREDECESSOR_NAMES, MESSAGING, *CALLING_NAMES])
MAX_TARGET_NAMES = sorted([*PREDECESSOR_NAMES, MESSAGING])
MIGRATION_COMMAND = ["sh", "-c", "npx prisma migrate deploy && npm run start"]
CALLING_LOOKING_OUTSIDE_ALLOWLIST = [
    "BRIDGE_SHARED_TOKEN", "RECORDINGS_HOST_PATH", "FS_ESL_PASSWORD", "MEGAFON_SIP_PASSWORD", "AI_CALL_CONTROLLED_EXTRA",
]
UNRELATED_SERVICES = ("tg-bot", "audio-bridge", "freeswitch")


def source_text(values: dict[str, str] | None = None) -> str:
    return "".join(f"{name}='{value}'\n" for name, value in (CALLING_VALUES if values is None else values).items())


def rendered(value: str) -> str:
    return value.replace("$", "$$")


class RuntimeFault(Exception):
    def __init__(self, code: str, exit_code: int = 70, details: dict[str, object] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code
        self.details = details or {}


def load_module(name: str, relative: str):
    loader = importlib.machinery.SourceFileLoader(name, str(ROOT / relative))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    loader.exec_module(module)
    return module


def load_profile():
    return load_module("yoko_calling_b2_environment_tests", "templates/crm-activation-profile.py.in")


def load_core():
    return load_module("yoko_calling_b2_environment_core_tests", "src/yoko-privileged-runtime-core.py")


def assert_no_secret(test: unittest.TestCase, *values: object) -> None:
    text = "".join(repr(value) for value in values)
    for marker in SECRET_MARKERS:
        test.assertNotIn(marker, text)


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
        "name": "crm-" + service,
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


def raw_gravity(record: dict[str, object], environment: object) -> dict[str, object]:
    return {"Id": record["container_id"], "Name": "/" + str(record["name"]), "Config": {"Env": environment}}


def disarmed_environment() -> list[str]:
    return ["PATH=/usr/bin", "NODE_ENV=production", f"{LIVE}=false", f"{GATE}=false", f"AI_CALL_CONTROLLED_OPERATOR_TOKEN={TOKEN_MARKER}"]


class CallingBase(unittest.TestCase):
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
            "calling_b2_environment_sha256": "c" * 64,
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
                      GRAVITY_TARGET_NAMES if gravity_names is None else gravity_names, "g" * 64),
            container("new-max", "max-web-scraper", ["node", "index.js"],
                      MAX_TARGET_NAMES if max_names is None else max_names, "m" * 64),
        )

    def predecessor_pair(self, *, gravity_names=None, max_names=None):
        return (
            container("old-gravity", "gravity-mvp", MIGRATION_COMMAND,
                      PREDECESSOR_NAMES if gravity_names is None else gravity_names, "o" * 64),
            container("old-max", "max-web-scraper", ["node", "index.js"],
                      PREDECESSOR_NAMES if max_names is None else max_names, "p" * 64),
        )

    def postcheck(self, pair, expected: str, *, fingerprint: str = "u" * 64):
        with (
            mock.patch.object(self.runtime, "_validate_compose_inputs"),
            mock.patch.object(self.runtime, "_wait_pair", return_value=pair),
            mock.patch.object(self.runtime, "_database_status", return_value={"state": "EXACT"}),
            mock.patch.object(self.runtime, "_unrelated_fingerprint", return_value=fingerprint),
            mock.patch.object(self.runtime, "_calling_b2_environment", side_effect=AssertionError("postcheck read the Calling source")),
            mock.patch.object(self.runtime, "_release_environment", side_effect=AssertionError("postcheck read a release source")),
        ):
            return self.runtime._postcheck(self.core, {}, self.profile, self.state, expected)

    def assertFault(self, code: str, call, *args, **kwargs):
        with self.assertRaises(Exception) as raised:
            call(*args, **kwargs)
        self.assertEqual(getattr(raised.exception, "code", repr(raised.exception)), code)
        assert_no_secret(self, raised.exception.details, str(raised.exception), raised.exception.__cause__)
        return raised.exception


class SealedContractTests(CallingBase):
    def test_allowlist_is_the_exact_closed_owner_set_for_gravity_only(self) -> None:
        self.assertEqual(self.runtime.CALLING_B2_ENVIRONMENT_NAMES, tuple(CALLING_NAMES))
        self.assertEqual(list(self.runtime.CALLING_B2_ENVIRONMENT_NAMES), sorted(CALLING_NAMES))
        self.assertIsInstance(self.runtime.CALLING_B2_ENVIRONMENT_NAMES, tuple)
        self.assertEqual(self.runtime.CALLING_B2_SERVICE, "gravity-mvp")
        self.assertEqual(self.runtime.CALLING_B2_KILL_SWITCHES, (GATE, LIVE))
        self.assertEqual(self.runtime.CALLING_B2_KILL_SWITCH_VALUES, ("false", "true"))
        with self.assertRaises(TypeError):
            self.runtime.CALLING_B2_ENVIRONMENT_CONTRACT["services"] = ["max-web-scraper"]  # type: ignore[index]
        self.assertEqual(self.runtime.CALLING_B2_ENVIRONMENT_CONTRACT["services"], ["gravity-mvp"])
        self.assertIs(self.runtime.CALLING_B2_ENVIRONMENT_CONTRACT["attached_on_rollback"], False)

    def test_source_path_is_the_fixed_release_id_of_the_sealed_profile(self) -> None:
        profile_id = self.runtime.PROFILE_ID
        self.assertEqual(self.runtime.CALLING_B2_ENVIRONMENT_DIRECTORY, f"/var/lib/crm/release-staging/calling-b2/{profile_id}")
        self.assertEqual(self.runtime.CALLING_B2_ENVIRONMENT_SOURCE, f"/var/lib/crm/release-staging/calling-b2/{profile_id}/gravity-mvp.env")
        self.assertNotIn(".env.production", self.runtime.CALLING_B2_ENVIRONMENT_SOURCE)
        self.assertNotEqual(self.runtime.CALLING_B2_ENVIRONMENT_DIRECTORY, self.runtime.RELEASE_ENVIRONMENT_DIRECTORY)

    def rendered_profile(self) -> dict[str, object]:
        raw = (ROOT / "templates/profile.v1.json.in").read_text(encoding="ascii")
        return json.loads(re.sub(r'"@[A-Z_]+@"', '"placeholder"', raw.replace("@ARTIFACT_FILES_JSON@", "{}")))

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

    def test_sealed_profile_section_and_package_verifier_match_the_runtime_contract(self) -> None:
        profile = self.rendered_profile()
        self.assertEqual(profile["calling_b2_environment"], dict(self.runtime.CALLING_B2_ENVIRONMENT_CONTRACT))
        self.assertEqual(self.load(profile)["calling_b2_environment"]["names"], CALLING_NAMES)
        verifier = ast.parse((ROOT / "packaging/verify-sealed-inputs.py").read_text(encoding="ascii"))
        literals = [
            ast.literal_eval(node.comparators[0])
            for node in ast.walk(verifier)
            if isinstance(node, ast.Compare)
            and isinstance(node.left, ast.Call)
            and ast.unparse(node.left) == "profile.get('calling_b2_environment')"
        ]
        self.assertEqual(literals, [dict(self.runtime.CALLING_B2_ENVIRONMENT_CONTRACT)])

    def test_profile_that_widens_or_drops_the_calling_contract_is_refused(self) -> None:
        mutations = [
            lambda value: value["calling_b2_environment"]["names"].append("FOO_SECRET"),
            lambda value: value["calling_b2_environment"]["names"].remove("MEGAFON_NUMBER"),
            lambda value: value["calling_b2_environment"]["services"].append("max-web-scraper"),
            lambda value: value["calling_b2_environment"].__setitem__("source", "/tmp/gravity-mvp.env"),
            lambda value: value["calling_b2_environment"].__setitem__("attached_on_rollback", True),
            lambda value: value["calling_b2_environment"].__setitem__("rollback_requires_disarmed_kill_switches", False),
            lambda value: value["calling_b2_environment"]["kill_switch_values"].append("TRUE"),
            lambda value: value["calling_b2_environment"].__setitem__("all_names_required", False),
            lambda value: value.pop("calling_b2_environment"),
            lambda value: value["negative_properties"].__setitem__("arbitrary_environment_override", True),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(mutation=index):
                profile = self.rendered_profile()
                mutate(profile)
                self.assertFault("ACTIVATION_PROFILE_INVALID", self.load, profile)

    def test_sealer_refuses_before_any_output_until_bound_to_an_exact_successor(self) -> None:
        sealer = load_module("yoko_calling_b2_sealer_tests", "packaging/seal-release.py")
        self.assertIsNone(sealer.CALLING_B2_APPLICATION_COMMIT)
        self.assertEqual(sealer.CALLING_B2_UNBOUND_IDENTITIES, {
            "application_commit": "be6b8eb82d8c074e82a3be0cd53db26137e984be",
            "profile_id": "crm-be6b8eb82d8c-gravity-max-source-v1",
            "package_version": "2.0.0-17",
        })
        with mock.patch.object(sealer.argparse, "ArgumentParser", side_effect=AssertionError("sealer read its inputs")) as parser:
            with self.assertRaisesRegex(ValueError, "Calling B2 capability is not bound"):
                sealer.main()
        parser.assert_not_called()
        successor = "f" * 40
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "packaging").mkdir()

            def attempt(*, calling=successor, application=successor, profile_id="crm-ffffffffffff-gravity-max-source-v1", control="Version: 2.0.0-18\n"):
                (root / "packaging/control").write_text("Package: yoko-privileged-runtime\n" + control, encoding="ascii")
                with (
                    mock.patch.object(sealer, "ROOT", root),
                    mock.patch.object(sealer, "CALLING_B2_APPLICATION_COMMIT", calling),
                    mock.patch.object(sealer, "APPLICATION_COMMIT", application),
                    mock.patch.object(sealer, "PROFILE_ID", profile_id),
                    mock.patch.object(sealer.argparse, "ArgumentParser", side_effect=RuntimeError("bound: inputs are read")),
                ):
                    sealer.main()

            with self.assertRaisesRegex(RuntimeError, "bound: inputs are read"):
                attempt()
            v17 = sealer.CALLING_B2_UNBOUND_IDENTITIES
            refusals = {
                "unbound": dict(calling=None),
                "different commit": dict(calling="e" * 40),
                "v17 application": dict(calling=v17["application_commit"], application=v17["application_commit"]),
                "v17 profile id": dict(profile_id=v17["profile_id"]),
                "v17 package version": dict(control="Version: 2.0.0-17\n"),
                "no package version": dict(control=""),
                "two package versions": dict(control="Version: 2.0.0-18\nVersion: 2.0.0-19\n"),
            }
            for label, arguments in refusals.items():
                with self.subTest(refusal=label):
                    with self.assertRaisesRegex(ValueError, "Calling B2 capability is not bound"):
                        attempt(**arguments)

    def test_package_verifier_refuses_every_phase_until_rebound(self) -> None:
        verifier = load_module("yoko_calling_b2_verifier_tests", "packaging/verify-sealed-inputs.py")
        successor = {"accepted_application": {"commit": "f" * 40}, "profile_id": "crm-ffffffffffff-gravity-max-source-v1", "package_version": "2.0.0-18"}
        verifier.assert_calling_b2_bound(successor, copy.deepcopy(successor))
        v17 = verifier.CALLING_B2_UNBOUND_IDENTITIES
        old = {"accepted_application": {"commit": v17["application_commit"]}, "profile_id": v17["profile_id"], "package_version": v17["package_version"]}
        cases = {
            "v17 application": ({**successor, "accepted_application": {"commit": v17["application_commit"]}},) * 2,
            "v17 profile id": ({**successor, "profile_id": v17["profile_id"]},) * 2,
            "v17 package version": ({**successor, "package_version": v17["package_version"]},) * 2,
            "identity omitted from both": ({"schema": "x"}, {"schema": "x"}),
            "application omitted from both": ({key: value for key, value in successor.items() if key != "accepted_application"},) * 2,
            "empty strings": ({"accepted_application": {"commit": ""}, "profile_id": "", "package_version": ""},) * 2,
            "profile still v17": (successor, old),
            "sealed inputs disagree with profile": (successor, {**successor, "package_version": "2.0.0-19"}),
            "profile not an object": (successor, ["not", "a", "profile"]),
        }
        for label, (sealed, profile) in cases.items():
            with self.subTest(refusal=label):
                with self.assertRaisesRegex(ValueError, "Calling B2 capability is not bound"):
                    verifier.assert_calling_b2_bound(sealed, profile)
        schema = {"schema": "yoko.crm.coordinated-runtime-sealed-inputs.v1"}
        for label, sealed, profile in (
            ("current builder", {**schema, **old}, old),
            ("hand-made inputs omitting the identity", schema, old),
            ("successor inputs over a v17 profile", {**schema, **successor}, old),
        ):
            for phase in ("package", "package-output", "release"):
                with self.subTest(case=label, phase=phase):
                    documents = {"sealed-inputs.v1.json": sealed, "profile.v1.json": profile}
                    with (
                        mock.patch.object(sys, "argv", ["verify-sealed-inputs.py", "--phase", phase]),
                        mock.patch.object(verifier, "load", side_effect=lambda path: documents[Path(path).name]),
                        mock.patch.object(verifier, "git", side_effect=AssertionError("verifier continued past the binding")) as git,
                    ):
                        with self.assertRaisesRegex(ValueError, "Calling B2 capability is not bound"):
                            verifier.main()
                    git.assert_not_called()

class SourceTests(unittest.TestCase):
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
        self.release = self.core.mapped(self.runtime.CALLING_B2_ENVIRONMENT_DIRECTORY)
        self.release.mkdir(parents=True, mode=0o700)
        for parent in [self.release, *self.release.parents]:
            if parent == self.root:
                break
            os.chmod(parent, 0o700 if parent == self.release else 0o755)
        self.write(source_text())

    def tearDown(self) -> None:
        self.core._test_root = self.previous_root
        self.directory.cleanup()

    @property
    def path(self) -> Path:
        return self.core.mapped(self.runtime.CALLING_B2_ENVIRONMENT_SOURCE)

    def write(self, text: str | bytes, mode: int = 0o600) -> None:
        target = self.path
        if target.is_symlink() or target.exists():
            target.unlink()
        target.write_bytes(text.encode("ascii") if isinstance(text, str) else text)
        target.chmod(mode)

    def assertSourceFault(self, code: str, **details: object) -> RuntimeFault:
        with self.assertRaises(self.core.RuntimeFault) as raised:
            self.runtime._calling_b2_environment(self.core)
        self.assertEqual(raised.exception.code, code)
        for key, value in details.items():
            self.assertEqual(raised.exception.details.get(key), value)
        assert_no_secret(self, raised.exception.details, str(raised.exception), raised.exception.__cause__)
        return raised.exception

    def test_exact_authoritative_set_is_accepted_and_bound_by_digest(self) -> None:
        first = self.runtime._calling_b2_environment(self.core)
        self.assertEqual(first["values"], CALLING_VALUES)
        self.assertEqual(first["values"]["AI_CALL_DIAL_STRING_TEMPLATE"], DIAL_TEMPLATE)
        self.assertRegex(first["sha256"], r"^[0-9a-f]{64}$")
        assert_no_secret(self, first["sha256"])
        self.assertEqual(self.runtime._calling_b2_environment(self.core)["sha256"], first["sha256"])

    def test_assignment_order_does_not_change_the_admitted_values(self) -> None:
        self.write("".join(reversed(source_text().splitlines(keepends=True))))
        self.assertEqual(self.runtime._calling_b2_environment(self.core)["values"], CALLING_VALUES)

    def test_armed_kill_switches_are_admissible_release_values(self) -> None:
        self.write(source_text({**CALLING_VALUES, LIVE: "true", GATE: "true"}))
        values = self.runtime._calling_b2_environment(self.core)["values"]
        self.assertEqual((values[LIVE], values[GATE]), ("true", "true"))

    def test_unknown_name_is_rejected_without_naming_it(self) -> None:
        self.write(source_text() + "FOO_SECRET='x'\n")
        fault = self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_INVALID", reason="UNKNOWN_NAME")
        self.assertNotIn("FOO_SECRET", repr(fault.details))

    def test_calling_looking_names_outside_the_allowlist_are_rejected(self) -> None:
        for name in [*CALLING_LOOKING_OUTSIDE_ALLOWLIST, MESSAGING]:
            with self.subTest(name=name):
                self.write(source_text() + f"{name}='value'\n")
                self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_INVALID", reason="UNKNOWN_NAME")

    def test_duplicate_name_is_rejected(self) -> None:
        for name in (LIVE, "AI_CALL_CONTROLLED_OPERATOR_TOKEN"):
            with self.subTest(name=name):
                self.write(source_text() + f"{name}='{CALLING_VALUES[name]}'\n")
                self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_INVALID", reason="DUPLICATE_NAME", name=name)

    def test_every_name_is_mandatory(self) -> None:
        for name in CALLING_NAMES:
            with self.subTest(name=name):
                self.write(source_text({key: value for key, value in CALLING_VALUES.items() if key != name}))
                self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_INVALID", reason="MISSING_NAME", names=[name])

    def test_kill_switch_values_other_than_exact_true_or_false_are_rejected(self) -> None:
        for switch in (LIVE, GATE):
            for value in ("TRUE", "True", "FALSE", "False", "1", "0", "yes", "no", "on", "off", "enabled", "armedMarker_0123456789"):
                with self.subTest(switch=switch, value=value):
                    self.write(source_text({**CALLING_VALUES, switch: value}))
                    fault = self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_INVALID", reason="KILL_SWITCH_VALUE", name=switch)
                    self.assertEqual(set(fault.details), {"reason", "name"})
                    self.assertNotIn("armedMarker", repr(fault.details) + str(fault))

    def test_malformed_sources_are_rejected(self) -> None:
        body = source_text()
        first = f"{LIVE}='false'"
        cases = {
            "unquoted": body.replace(first, f"{LIVE}=false"),
            "double quoted": body.replace(first, f'{LIVE}="false"'),
            "trailing text": body.replace(first, first + "x"),
            "trailing comment": body.replace(first, first + " #c"),
            "export": body.replace(first, "export " + first),
            "spaced assignment": body.replace(first, f"{LIVE} = 'false'"),
            "lowercase name": body.replace(first, "ai_call_live_mode='false'"),
            "crlf": body.replace(first + "\n", first + "\r\n"),
            "blank line": body + "\n",
            "comment line": "# staged\n" + body,
            "no final newline": body[:-1],
            "nul": body.replace("'9999'", "'99\x0099'"),
            "non-ascii": body.replace("'yandex'", "'y\u00e4ndex'", 1),
            "whitespace in value": body.replace("'9999'", "'99 99'"),
            "tab in value": body.replace("'9999'", "'99\t99'"),
            "backslash": body.replace("'9999'", "'99\\99'"),
            "backtick": body.replace("'9999'", "'99`99'"),
            "embedded quote": body.replace("'9999'", "'99'99'"),
            "embedded double quote": body.replace("'9999'", "'99\"99'"),
            "empty value": body.replace("'9999'", "''"),
            "value over 256 bytes": body.replace("'9999'", "'" + "9" * 257 + "'"),
            "empty file": "",
        }
        for label, text in cases.items():
            with self.subTest(case=label):
                self.write(text.encode("utf-8"))
                self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_INVALID", reason="SYNTAX")

    def test_oversized_source_is_rejected_before_parsing(self) -> None:
        self.write(source_text() + "#" * (4097 - len(source_text())))
        self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE", source="file")
        with mock.patch.object(self.runtime, "_fixed_production_file", return_value=os.lstat(self.path)):
            self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_INVALID", reason="SIZE")

    def test_wrong_owner_is_rejected(self) -> None:
        wrong_user = (os.geteuid() + 1, os.getegid())
        wrong_group = (os.geteuid(), os.getegid() + 1)
        for owner in (wrong_user, wrong_group):
            with self.subTest(owner=owner):
                with (
                    mock.patch.object(self.core, "secure_directory"),
                    mock.patch.object(self.core, "expected_owner", return_value=owner),
                ):
                    self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE", source="file")
                with mock.patch.object(self.core, "expected_owner", return_value=owner):
                    self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE", source="directory")

    def test_wrong_mode_is_rejected(self) -> None:
        for mode in (0o400, 0o640, 0o644, 0o660, 0o666, 0o700):
            with self.subTest(mode=oct(mode)):
                self.write(source_text(), mode=mode)
                self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE", source="file")

    def test_symlink_hardlink_and_missing_source_are_rejected(self) -> None:
        decoy = self.release / "decoy.env"
        decoy.write_text(source_text(), encoding="ascii")
        decoy.chmod(0o600)
        self.path.unlink()
        self.path.symlink_to(decoy)
        self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE", source="file")
        self.path.unlink()
        self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE", source="file")
        os.link(decoy, self.path)
        self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE", source="file")

    def test_directory_must_be_a_root_only_real_directory(self) -> None:
        for mode in (0o750, 0o755, 0o770, 0o711):
            with self.subTest(mode=oct(mode)):
                os.chmod(self.release, mode)
                self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE", source="directory")
        os.chmod(self.release, 0o700)
        moved = self.release.with_name("moved")
        self.release.rename(moved)
        self.release.symlink_to(moved)
        self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE", source="directory")
        self.release.unlink()
        self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE", source="directory")

    def test_group_or_other_writable_ancestor_is_rejected(self) -> None:
        for ancestor in ("/var/lib/crm", "/var/lib/crm/release-staging", "/var/lib/crm/release-staging/calling-b2"):
            for mode in (0o775, 0o757):
                with self.subTest(ancestor=ancestor, mode=oct(mode)):
                    os.chmod(self.core.mapped(ancestor), mode)
                    self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE", source="directory")
                    os.chmod(self.core.mapped(ancestor), 0o755)
        self.runtime._calling_b2_environment(self.core)

    def test_caller_writable_chain_is_rejected(self) -> None:
        with mock.patch.object(self.core, "assert_noncaller_writable_chain", side_effect=self.core.RuntimeFault("RESOURCE_CALLER_WRITABLE", 74)):
            self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE", source="file")

    def test_inode_substituted_between_check_and_open_is_rejected(self) -> None:
        decoy = self.root / "decoy.env"
        decoy.write_text(source_text(), encoding="ascii")
        with mock.patch.object(self.runtime, "_fixed_production_file", return_value=os.stat(decoy)):
            self.assertSourceFault("CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE", source="file")

    def test_source_modified_after_preflight_is_rejected_before_compose(self) -> None:
        state = {
            "calling_b2_environment_sha256": self.runtime._calling_b2_environment(self.core)["sha256"],
            "release_environment_sha256": "s" * 64,
        }
        self.assertEqual(self.runtime._validate_calling_b2_environment(self.core, state)["values"], CALLING_VALUES)
        changes = {
            "value changed": lambda: self.write(source_text({**CALLING_VALUES, "AI_CALL_CONTROLLED_REQUEST_ID": "requestMarker_9876543210"})),
            "armed after preflight": lambda: self.write(source_text({**CALLING_VALUES, LIVE: "true"})),
            "mode widened": lambda: self.write(source_text(), mode=0o644),
            "removed": lambda: self.path.unlink(),
        }
        codes = {
            "value changed": "CALLING_B2_ENVIRONMENT_IDENTITY_DRIFT",
            "armed after preflight": "CALLING_B2_ENVIRONMENT_IDENTITY_DRIFT",
            "mode widened": "CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE",
            "removed": "CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE",
        }
        for label, change in changes.items():
            with self.subTest(change=label):
                self.write(source_text())
                change()
                with (
                    mock.patch.object(self.runtime, "_validate_compose_inputs"),
                    mock.patch.object(self.runtime, "_validate_release_environment", return_value={"sha256": "s" * 64, "value": MESSAGING_SECRET}),
                    mock.patch.object(self.runtime, "_validate_projection") as projection,
                    mock.patch.object(self.runtime, "_run") as run,
                ):
                    with self.assertRaises(self.core.RuntimeFault) as raised:
                        self.runtime._compose_up(self.core, {"deployment": {}}, state, self.runtime.ACTIVATE_OVERLAY, activate=True)
                self.assertEqual(raised.exception.code, codes[label])
                assert_no_secret(self, raised.exception.details, str(raised.exception))
                projection.assert_not_called()
                run.assert_not_called()
        self.write(source_text())
        for unbound in ({}, {"calling_b2_environment_sha256": "0" * 64}, {"calling_b2_environment_sha256": 7}):
            with self.subTest(state=unbound):
                with self.assertRaises(self.core.RuntimeFault) as raised:
                    self.runtime._validate_calling_b2_environment(self.core, unbound)
                self.assertEqual(raised.exception.code, "CALLING_B2_ENVIRONMENT_IDENTITY_DRIFT")


class SemanticTests(CallingBase):
    def test_gravity_expectation_is_predecessor_plus_messaging_plus_exact_calling_set(self) -> None:
        expected = self.runtime._expected_pair_semantic(self.core, "gravity-mvp", self.state["gravity_semantic"], target=True)
        self.assertEqual(expected["environment_names"], GRAVITY_TARGET_NAMES)
        self.assertEqual(self.postcheck(self.target_pair(), "TARGET_PAIR")["pair_state"], "TARGET_PAIR")

    def test_max_expectation_never_includes_calling_names(self) -> None:
        expected = self.runtime._expected_pair_semantic(self.core, "max-web-scraper", self.state["max_semantic"], target=True)
        self.assertEqual(expected["environment_names"], MAX_TARGET_NAMES)
        self.assertEqual(self.runtime._admitted_release_names(self.core, "max-web-scraper"), (MESSAGING,))

    def test_max_receiving_calling_names_is_rejected(self) -> None:
        for names in (sorted([*MAX_TARGET_NAMES, *CALLING_NAMES]), sorted([*MAX_TARGET_NAMES, LIVE])):
            with self.subTest(count=len(names)):
                self.assertFault("MAX_RUNTIME_SEMANTIC_DRIFT", self.postcheck, self.target_pair(max_names=names), "TARGET_PAIR")

    def test_unrelated_services_are_never_admitted(self) -> None:
        for service in UNRELATED_SERVICES:
            with self.subTest(service=service):
                predecessor = semantic("x", service, ["run"], PREDECESSOR_NAMES, "t" * 64)
                self.assertFault(
                    "RELEASE_ENVIRONMENT_SERVICE_NOT_ADMITTED",
                    self.runtime._expected_pair_semantic, self.core, service, predecessor, target=True,
                )
                self.assertFault("RELEASE_ENVIRONMENT_SERVICE_NOT_ADMITTED", self.runtime._admitted_release_names, self.core, service)
                self.assertFault(
                    "RELEASE_ENVIRONMENT_SERVICE_NOT_ADMITTED",
                    self.runtime._admit_release_environment_projection,
                    self.core, service, {"environment": {"A": "1"}},
                    {"environment": {"A": "1", **CALLING_VALUES}}, MESSAGING_SECRET, CALLING_VALUES,
                )
        # A Calling name reaching any running unrelated container moves the unrelated fingerprint.
        self.assertFault("UNRELATED_SERVICE_CHANGED_DURING_RELEASE", self.postcheck, self.target_pair(), "TARGET_PAIR", fingerprint="x" * 64)

    def test_gravity_env_drift_is_rejected(self) -> None:
        cases = {
            "unknown FOO_SECRET": sorted([*GRAVITY_TARGET_NAMES, "FOO_SECRET"]),
            "predecessor name removed": [name for name in GRAVITY_TARGET_NAMES if name != "DATABASE_URL"],
            "predecessor name renamed": sorted([name for name in GRAVITY_TARGET_NAMES if name != "NODE_ENV"] + ["NODE_ENV_RENAMED"]),
            "messaging name missing": [name for name in GRAVITY_TARGET_NAMES if name != MESSAGING],
        }
        for extra in CALLING_LOOKING_OUTSIDE_ALLOWLIST:
            cases["outside allowlist " + extra] = sorted([*GRAVITY_TARGET_NAMES, extra])
        for name in CALLING_NAMES:
            cases["calling name missing " + name] = [item for item in GRAVITY_TARGET_NAMES if item != name]
        for label, names in cases.items():
            with self.subTest(case=label):
                self.assertFault("GRAVITY_RUNTIME_SEMANTIC_DRIFT", self.postcheck, self.target_pair(gravity_names=names), "TARGET_PAIR")

    def test_target_command_is_npm_run_start_and_never_a_migration(self) -> None:
        self.assertEqual(self.postcheck(self.target_pair(), "TARGET_PAIR")["pair_state"], "TARGET_PAIR")
        for command in (MIGRATION_COMMAND, ["npm", "start"], ["sh", "-c", "npm run start"], ["npx", "prisma", "migrate", "deploy"]):
            with self.subTest(command=command):
                self.assertFault("TARGET_RUNTIME_COMMAND_DRIFT", self.postcheck, self.target_pair(gravity_command=command), "TARGET_PAIR")

    def test_predecessor_already_carrying_a_calling_name_is_refused(self) -> None:
        for name in CALLING_NAMES:
            with self.subTest(name=name):
                carrying = {**self.state["gravity_semantic"], "environment_names": sorted([*PREDECESSOR_NAMES, name])}
                self.assertFault(
                    "CALLING_B2_ENVIRONMENT_ALREADY_PRESENT",
                    self.runtime._expected_pair_semantic, self.core, "gravity-mvp", carrying, target=True,
                )

    def test_rollback_gravity_receives_zero_calling_names(self) -> None:
        result = self.postcheck(self.predecessor_pair(), "PREDECESSOR_PAIR")
        self.assertEqual(result["gravity_image_id"], "old-gravity")
        for names in (sorted([*PREDECESSOR_NAMES, LIVE]), sorted([*PREDECESSOR_NAMES, *CALLING_NAMES]), GRAVITY_TARGET_NAMES):
            with self.subTest(count=len(names)):
                self.assertFault(
                    "ROLLBACK_CALLING_B2_ENVIRONMENT_PRESENT", self.postcheck, self.predecessor_pair(gravity_names=names), "PREDECESSOR_PAIR",
                )

    def test_arbitrary_env_drift_remains_rejected_during_rollback(self) -> None:
        extra = sorted([*PREDECESSOR_NAMES, "FOO_SECRET"])
        removed = [name for name in PREDECESSOR_NAMES if name != "PATH"]
        self.assertFault("GRAVITY_RUNTIME_SEMANTIC_DRIFT", self.postcheck, self.predecessor_pair(gravity_names=extra), "PREDECESSOR_PAIR")
        self.assertFault("GRAVITY_RUNTIME_SEMANTIC_DRIFT", self.postcheck, self.predecessor_pair(gravity_names=removed), "PREDECESSOR_PAIR")
        self.assertFault("MAX_RUNTIME_SEMANTIC_DRIFT", self.postcheck, self.predecessor_pair(max_names=extra), "PREDECESSOR_PAIR")
        self.assertFault("MAX_RUNTIME_SEMANTIC_DRIFT", self.postcheck, self.predecessor_pair(max_names=sorted([*PREDECESSOR_NAMES, MESSAGING])), "PREDECESSOR_PAIR")


class ProjectionTests(CallingBase):
    def configs(self):
        base = {
            "name": "crm",
            "networks": {"crm_internal": {"name": "crm_internal"}},
            "services": {
                "gravity-mvp": {
                    "image": "crm/gravity-mvp:wa-history-recovery-20260804",
                    "environment": {"DATABASE_URL": "postgresql://example", "NODE_ENV": "production", "BRIDGE_SHARED_TOKEN": "shared"},
                    "networks": {"crm_internal": None},
                },
                "max-web-scraper": {
                    "image": "crm/max-web-scraper:latest",
                    "environment": {"CRM_WEBHOOK_URL": "http://gravity-mvp:3002/api/webhooks/max"},
                    "networks": {"crm_internal": None},
                },
                "tg-bot": {"image": "crm/tg-bot:latest", "environment": {"BOT_API": "x"}},
                "audio-bridge": {"image": "crm/audio-bridge:latest", "environment": {"AUDIO_BRIDGE_PORT": "3030"}},
                "freeswitch": {"image": "crm/freeswitch:latest", "environment": {"MEGAFON_SIP_USERNAME": "u"}},
            },
        }
        candidate = copy.deepcopy(base)
        gravity = candidate["services"]["gravity-mvp"]
        gravity["image"] = self.runtime.TARGET_GRAVITY
        gravity["command"] = ["npm", "run", "start"]
        gravity["environment"][MESSAGING] = MESSAGING_SECRET
        gravity["environment"].update({name: rendered(value) for name, value in CALLING_VALUES.items()})
        candidate["services"]["max-web-scraper"]["image"] = self.runtime.TARGET_MAX
        candidate["services"]["max-web-scraper"]["environment"][MESSAGING] = MESSAGING_SECRET
        return base, candidate

    def project(self, base, candidate, *, activate: bool = True, calling_values=CALLING_VALUES):
        with (
            mock.patch.object(self.runtime, "_compose_config", side_effect=[base, candidate]),
            mock.patch.object(self.runtime, "_calling_b2_environment", side_effect=AssertionError("projection re-read the Calling source")) as calling,
        ):
            self.runtime._validate_projection(
                self.core, self.profile, "/overlay", activate=activate,
                release_value=MESSAGING_SECRET if activate else None, calling_values=calling_values,
            )
        return calling

    def test_exact_projection_attaches_calling_only_to_gravity(self) -> None:
        base, candidate = self.configs()
        self.assertEqual(candidate["services"]["gravity-mvp"]["environment"]["AI_CALL_DIAL_STRING_TEMPLATE"], "sofia/gateway/megafon/$${number}")
        self.project(base, candidate).assert_not_called()

    def test_render_is_compared_with_compose_dollar_escaping_exactly(self) -> None:
        base, candidate = self.configs()
        candidate["services"]["gravity-mvp"]["environment"]["AI_CALL_DIAL_STRING_TEMPLATE"] = DIAL_TEMPLATE
        self.assertFault("CALLING_B2_ENVIRONMENT_PROJECTION_DRIFT", self.project, base, candidate)
        base, candidate = self.configs()
        candidate["services"]["gravity-mvp"]["environment"]["AI_CALL_DIAL_STRING_TEMPLATE"] = "sofia/gateway/megafon/"
        self.assertFault("CALLING_B2_ENVIRONMENT_PROJECTION_DRIFT", self.project, base, candidate)

    def test_rendered_value_other_than_the_bound_one_is_rejected(self) -> None:
        for name in CALLING_NAMES:
            with self.subTest(name=name):
                base, candidate = self.configs()
                candidate["services"]["gravity-mvp"]["environment"][name] = "different"
                fault = self.assertFault("CALLING_B2_ENVIRONMENT_PROJECTION_DRIFT", self.project, base, candidate)
                self.assertEqual(fault.details, {"service": "gravity-mvp"})
                base, candidate = self.configs()
                del candidate["services"]["gravity-mvp"]["environment"][name]
                self.assertFault("CALLING_B2_ENVIRONMENT_PROJECTION_DRIFT", self.project, base, candidate)

    def test_max_receiving_the_calling_source_is_rejected(self) -> None:
        base, candidate = self.configs()
        candidate["services"]["max-web-scraper"]["environment"].update({name: rendered(value) for name, value in CALLING_VALUES.items()})
        self.assertFault("PAIR_COMPOSE_PROJECTION_DRIFT", self.project, base, candidate)
        base, candidate = self.configs()
        candidate["services"]["max-web-scraper"]["environment"][LIVE] = "false"
        self.assertFault("PAIR_COMPOSE_PROJECTION_DRIFT", self.project, base, candidate)

    def test_unrelated_services_receiving_the_calling_source_are_rejected(self) -> None:
        for service in UNRELATED_SERVICES:
            with self.subTest(service=service):
                base, candidate = self.configs()
                candidate["services"][service]["environment"].update({name: rendered(value) for name, value in CALLING_VALUES.items()})
                self.assertFault("UNRELATED_COMPOSE_SERVICE_DRIFT", self.project, base, candidate)

    def test_gravity_env_drift_in_the_render_is_rejected(self) -> None:
        mutations = {
            "unknown FOO_SECRET": lambda env: env.__setitem__("FOO_SECRET", "x"),
            "calling-looking extra": lambda env: env.__setitem__("AI_CALL_CONTROLLED_EXTRA", "x"),
            "predecessor removed": lambda env: env.pop("DATABASE_URL"),
            "unrelated predecessor changed": lambda env: env.__setitem__("BRIDGE_SHARED_TOKEN", "changed"),
            "node env changed": lambda env: env.__setitem__("NODE_ENV", "development"),
        }
        for label, mutate in mutations.items():
            with self.subTest(case=label):
                base, candidate = self.configs()
                mutate(candidate["services"]["gravity-mvp"]["environment"])
                self.assertFault("PAIR_COMPOSE_PROJECTION_DRIFT", self.project, base, candidate)

    def test_name_already_in_the_shared_environment_is_refused(self) -> None:
        for name in (LIVE, "MEGAFON_NUMBER", "AUDIO_BRIDGE_HEALTH_URL"):
            with self.subTest(name=name):
                base, candidate = self.configs()
                base["services"]["gravity-mvp"]["environment"][name] = rendered(CALLING_VALUES[name])
                self.assertFault("CALLING_B2_ENVIRONMENT_ALREADY_PRESENT", self.project, base, candidate)

    def test_activation_requires_exactly_the_bound_calling_set(self) -> None:
        partial = {key: value for key, value in CALLING_VALUES.items() if key != "MEGAFON_NUMBER"}
        for label, values in (("none", None), ("partial", partial), ("extra", {**CALLING_VALUES, "FOO_SECRET": "x"}), ("list", list(CALLING_VALUES))):
            with self.subTest(values=label):
                self.assertFault("CALLING_B2_ENVIRONMENT_BINDING_INVALID", self.project, *self.configs(), calling_values=values)

    def test_migration_command_in_the_render_is_rejected(self) -> None:
        base, candidate = self.configs()
        candidate["services"]["gravity-mvp"]["command"] = MIGRATION_COMMAND
        self.assertFault("GRAVITY_SAFE_COMMAND_DRIFT", self.project, base, candidate)

    def test_rollback_projection_admits_no_calling_name_and_reads_no_source(self) -> None:
        base, _ = self.configs()
        candidate = copy.deepcopy(base)
        candidate["services"]["gravity-mvp"]["image"] = self.runtime.ROLLBACK_GRAVITY
        candidate["services"]["max-web-scraper"]["image"] = self.runtime.ROLLBACK_MAX
        self.project(base, candidate, activate=False, calling_values=None).assert_not_called()
        self.assertFault("CALLING_B2_ENVIRONMENT_BINDING_INVALID", self.project, base, copy.deepcopy(candidate), activate=False)
        attached = copy.deepcopy(candidate)
        attached["services"]["gravity-mvp"]["environment"][LIVE] = "false"
        self.assertFault("PAIR_COMPOSE_PROJECTION_DRIFT", self.project, base, attached, activate=False, calling_values=None)


class OverlayTests(CallingBase):
    def test_activation_overlay_attaches_the_calling_source_to_gravity_only(self) -> None:
        overlay = self.runtime._compose_overlay(self.runtime.TARGET_GRAVITY, self.runtime.TARGET_MAX, activate=True).decode("ascii")
        sections = dict(re.findall(r"^  ([a-z-]+):\n((?:    .*\n|      .*\n)*)", overlay, re.MULTILINE))
        self.assertEqual(set(sections), {"gravity-mvp", "max-web-scraper"})
        self.assertEqual(overlay.count(self.runtime.CALLING_B2_ENVIRONMENT_SOURCE), 1)
        self.assertIn(self.runtime.CALLING_B2_ENVIRONMENT_SOURCE, sections["gravity-mvp"])
        self.assertNotIn("calling-b2", sections["max-web-scraper"])
        self.assertEqual(
            re.findall(r"^      - (.+)$", sections["gravity-mvp"], re.MULTILINE),
            [self.runtime.RELEASE_ENVIRONMENT_SOURCES["gravity-mvp"], self.runtime.CALLING_B2_ENVIRONMENT_SOURCE],
        )
        self.assertIn('command: ["npm", "run", "start"]', sections["gravity-mvp"])
        for forbidden in ("prisma", "migrate", ".env.production", *CALLING_NAMES):
            self.assertNotIn(forbidden, overlay)

    def test_rollback_overlay_attaches_no_calling_source(self) -> None:
        overlay = self.runtime._compose_overlay(self.runtime.ROLLBACK_GRAVITY, self.runtime.ROLLBACK_MAX, activate=False).decode("ascii")
        for forbidden in ("env_file", "calling-b2", "release-staging", "command:"):
            self.assertNotIn(forbidden, overlay)


class KillSwitchGuardTests(CallingBase):
    def guard(self, environment, *, raw_id: str | None = None, gravity=None):
        gravity = gravity if gravity is not None else self.target_pair()[0]
        raw = raw_gravity(gravity, environment)
        if raw_id is not None:
            raw["Id"] = raw_id
        with (
            mock.patch.object(self.runtime, "_raw_container", return_value=raw) as inspected,
            mock.patch.object(self.runtime, "_calling_b2_environment", side_effect=AssertionError("guard read the staging source")),
        ):
            self.runtime._assert_calling_b2_disarmed(self.core, gravity)
        inspected.assert_called_once_with(self.core, "crm-gravity-mvp")

    def test_both_kill_switches_false_is_disarmed(self) -> None:
        self.guard(disarmed_environment())

    def test_absent_kill_switches_follow_the_application_contract_as_disarmed(self) -> None:
        self.guard(["PATH=/usr/bin", "NODE_ENV=production"])
        self.guard(["PATH=/usr/bin", f"{LIVE}=false"])
        self.guard(["PATH=/usr/bin", f"{GATE}=false"])
        self.guard([], gravity=self.predecessor_pair()[0])

    def test_live_mode_true_is_armed(self) -> None:
        fault = self.assertFault("CALLING_B2_KILL_SWITCH_ARMED", self.guard, [f"{LIVE}=true", f"{GATE}=false"])
        self.assertEqual(fault.details, {"armed_kill_switches": [LIVE]})

    def test_controlled_real_call_true_is_armed(self) -> None:
        fault = self.assertFault("CALLING_B2_KILL_SWITCH_ARMED", self.guard, [f"{LIVE}=false", f"{GATE}=true"])
        self.assertEqual(fault.details, {"armed_kill_switches": [GATE]})

    def test_both_true_is_armed(self) -> None:
        fault = self.assertFault("CALLING_B2_KILL_SWITCH_ARMED", self.guard, [f"{LIVE}=true", f"{GATE}=true"])
        self.assertEqual(fault.details, {"armed_kill_switches": [GATE, LIVE]})

    def test_any_doubt_counts_as_armed_and_is_never_weaker_than_the_application(self) -> None:
        cases = {
            "upper TRUE": [f"{LIVE}=TRUE"],
            "title True": [f"{LIVE}=True"],
            "leading space": [f"{LIVE}= true"],
            "trailing space": [f"{LIVE}=true "],
            "false with space": [f"{LIVE}=false "],
            "title False": [f"{LIVE}=False"],
            "empty": [f"{LIVE}="],
            "one": [f"{LIVE}=1"],
            "zero": [f"{LIVE}=0"],
            "no": [f"{LIVE}=no"],
            "marker": [f"{LIVE}=armedMarker_0123456789"],
            "duplicate false": [f"{LIVE}=false", f"{LIVE}=false"],
            "false then true": [f"{LIVE}=false", f"{LIVE}=true"],
            "lowercase key": ["ai_call_live_mode=false"],
            "padded key": [f"{LIVE} =false"],
        }
        for label, environment in cases.items():
            with self.subTest(case=label):
                fault = self.assertFault("CALLING_B2_KILL_SWITCH_ARMED", self.guard, [*environment, f"{GATE}=false"])
                self.assertEqual(fault.details, {"armed_kill_switches": [LIVE]})
                self.assertNotIn("armedMarker", repr(fault.details) + str(fault))

    def test_unreadable_or_unbound_environment_is_unproven(self) -> None:
        for label, environment in {
            "no env list": None,
            "env mapping": {LIVE: "false"},
            "entry without separator": [LIVE],
            "entry with nul": [f"{LIVE}=fal\x00se"],
            "non string entry": [7],
        }.items():
            with self.subTest(case=label):
                self.assertFault("CALLING_B2_KILL_SWITCH_STATE_UNPROVEN", self.guard, environment)
        self.assertFault("CALLING_B2_KILL_SWITCH_STATE_UNPROVEN", self.guard, disarmed_environment(), raw_id="another-container")
        for gravity in ({"container_id": "x"}, {"name": "crm-gravity-mvp"}, None, {"name": "", "container_id": "x"}):
            with self.subTest(gravity=gravity):
                self.assertFault("CALLING_B2_KILL_SWITCH_STATE_UNPROVEN", self.runtime._assert_calling_b2_disarmed, self.core, gravity)
        with mock.patch.object(self.runtime, "_raw_container", side_effect=RuntimeFault("CONTAINER_INSPECT_FAILED", 74)):
            self.assertFault("CALLING_B2_KILL_SWITCH_STATE_UNPROVEN", self.runtime._assert_calling_b2_disarmed, self.core, self.target_pair()[0])

    def test_guard_reports_names_never_values(self) -> None:
        fault = self.assertFault(
            "CALLING_B2_KILL_SWITCH_ARMED", self.guard,
            [f"{LIVE}=true", f"{GATE}=true", f"AI_CALL_CONTROLLED_OPERATOR_TOKEN={TOKEN_MARKER}", f"MEGAFON_NUMBER={CALLER_MARKER}"],
        )
        self.assertEqual(set(fault.details), {"armed_kill_switches"})


class RollbackFlowTests(CallingBase):
    def setUp(self) -> None:
        super().setUp()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        logs = Path(self.directory.name)
        self.core = SimpleNamespace(
            RuntimeFault=RuntimeFault,
            audit_status=lambda: {"state": "VALID"},
            now=lambda: "2026-09-17T00:00:00Z",
            mapped=lambda path: logs / Path(path).name,
        )
        self.invocation = SimpleNamespace(primitive="rollback", resource=None, relative_path=None)

    def rollback(self, *, current, environment, phase="ACTIVATED", source_missing=True):
        writes: list[dict[str, object]] = []
        audits: list[tuple[object, ...]] = []
        composed: list[list[str]] = []

        def run(_core, args, **_kwargs):
            composed.append(list(args))
            return SimpleNamespace(stdout=b"", returncode=0)

        def deleted(*_args):
            raise RuntimeFault("CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE", 74, {"source": "file"})

        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value={**self.state, "schema": self.runtime.STATE_SCHEMA, "profile_id": self.runtime.PROFILE_ID, "phase": phase}),
            mock.patch.object(self.runtime, "_pair", return_value=current),
            mock.patch.object(self.runtime, "_raw_container", return_value=raw_gravity(current[0], environment)),
            mock.patch.object(self.runtime, "_wait_pair", return_value=self.predecessor_pair()),
            mock.patch.object(self.runtime, "_validate_compose_inputs"),
            mock.patch.object(self.runtime, "_validate_projection"),
            mock.patch.object(self.runtime, "_calling_b2_environment", side_effect=deleted if source_missing else AssertionError) as calling,
            mock.patch.object(self.runtime, "_validate_calling_b2_environment", side_effect=deleted) as validated,
            mock.patch.object(self.runtime, "_release_environment", side_effect=deleted),
            mock.patch.object(self.runtime, "_validate_release_environment", side_effect=deleted),
            mock.patch.object(self.runtime, "_run", side_effect=run),
            mock.patch.object(self.runtime, "_database_status", return_value={"state": "EXACT"}),
            mock.patch.object(self.runtime, "_unrelated_fingerprint", return_value="u" * 64),
            mock.patch.object(self.runtime, "_assert_rollback_material"),
            mock.patch.object(self.runtime, "_write_state", side_effect=lambda _core, value: writes.append(value)),
            mock.patch.object(self.runtime, "_audit", side_effect=lambda *args: audits.append(args)),
        ):
            try:
                result, failure = self.runtime._rollback(self.core, {}, self.profile, self.invocation), None
            except RuntimeFault as exc:
                result, failure = None, exc
        calling.assert_not_called()
        validated.assert_not_called()
        assert_no_secret(self, result, writes, audits, failure and failure.details)
        return result, failure, writes, audits, composed

    def test_disarmed_rollback_is_allowed_and_restores_exact_predecessor_without_the_source(self) -> None:
        result, failure, writes, _, composed = self.rollback(current=self.target_pair(), environment=disarmed_environment())
        self.assertIsNone(failure)
        self.assertEqual(result["status"], "ROLLED_BACK")
        self.assertEqual((result["postcheck"]["gravity_image_id"], result["postcheck"]["max_image_id"]), ("old-gravity", "old-max"))
        self.assertEqual([value["phase"] for value in writes], ["ROLLBACK_INTENT", "ROLLED_BACK"])
        self.assertEqual(len(composed), 1)
        self.assertIn(self.runtime.ROLLBACK_OVERLAY, composed[0])
        self.assertNotIn(self.runtime.ACTIVATE_OVERLAY, composed[0])

    def test_armed_rollback_is_refused_before_any_intent_or_compose(self) -> None:
        for label, environment, armed in (
            ("live", [f"{LIVE}=true", f"{GATE}=false"], [LIVE]),
            ("gate", [f"{LIVE}=false", f"{GATE}=true"], [GATE]),
            ("both", [f"{LIVE}=true", f"{GATE}=true"], [GATE, LIVE]),
        ):
            with self.subTest(case=label):
                result, failure, writes, audits, composed = self.rollback(current=self.target_pair(), environment=environment)
                self.assertIsNone(result)
                self.assertEqual(failure.code, "CALLING_B2_KILL_SWITCH_ARMED")
                self.assertEqual(failure.details, {"armed_kill_switches": armed})
                self.assertEqual((writes, audits, composed), ([], [], []))

    def test_every_rollback_transaction_checks_the_guard_even_when_called_directly(self) -> None:
        with (
            mock.patch.object(self.runtime, "_pair", return_value=self.target_pair()),
            mock.patch.object(self.runtime, "_raw_container", return_value=raw_gravity(self.target_pair()[0], [f"{LIVE}=true"])),
            mock.patch.object(self.runtime, "_assert_rollback_material") as material,
            mock.patch.object(self.runtime, "_compose_up") as compose,
            mock.patch.object(self.runtime, "_postcheck") as postcheck,
        ):
            self.assertFault("CALLING_B2_KILL_SWITCH_ARMED", self.runtime._rollback_pair, self.core, {}, self.profile, self.state)
        material.assert_not_called()
        compose.assert_not_called()
        postcheck.assert_not_called()

    def test_mixed_recovery_refuses_while_armed_before_any_intent(self) -> None:
        gravity, _ = self.target_pair()
        _, maximum = self.predecessor_pair()
        for caller in ("preflight", "activate"):
            with self.subTest(caller=caller):
                with (
                    mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
                    mock.patch.object(self.runtime, "_read_state", return_value={**self.state, "phase": "PREFLIGHTED"}),
                    mock.patch.object(self.runtime, "_pair", return_value=(gravity, maximum)),
                    mock.patch.object(self.runtime, "_raw_container", return_value=raw_gravity(gravity, [f"{GATE}=true"])),
                    mock.patch.object(self.runtime, "_rollback_with_fencing") as fencing,
                    mock.patch.object(self.runtime, "_write_state") as write,
                    mock.patch.object(self.runtime, "_audit") as audit,
                ):
                    call = self.runtime._release_preflight if caller == "preflight" else self.runtime._release_activate
                    self.assertFault("CALLING_B2_KILL_SWITCH_ARMED", call, self.core, {}, self.profile, self.invocation)
                fencing.assert_not_called()
                write.assert_not_called()
                audit.assert_not_called()


class ActivationFlowTests(CallingBase):
    """Drives the real preflight and activation paths against a real Calling source in test-root mode."""

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.real_core = load_core()

    def setUp(self) -> None:
        super().setUp()
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        os.chmod(root, 0o700)
        self.previous_root = self.real_core._test_root
        self.real_core._test_root = root
        release = self.real_core.mapped(self.runtime.CALLING_B2_ENVIRONMENT_DIRECTORY)
        release.mkdir(parents=True, mode=0o700)
        for parent in [release, *release.parents]:
            if parent == root:
                break
            os.chmod(parent, 0o700 if parent == release else 0o755)
        self.real_core.mapped(self.runtime.STATE_DIR).mkdir(parents=True, mode=0o700)
        self.source = self.real_core.mapped(self.runtime.CALLING_B2_ENVIRONMENT_SOURCE)
        self.source.write_text(source_text(), encoding="ascii")
        self.source.chmod(0o600)
        self.core = SimpleNamespace(
            RuntimeFault=self.real_core.RuntimeFault,
            secure_directory=self.real_core.secure_directory,
            mapped=self.real_core.mapped,
            expected_owner=self.real_core.expected_owner,
            assert_noncaller_writable_chain=self.real_core.assert_noncaller_writable_chain,
            audit_status=lambda: {"state": "VALID"},
            now=lambda: "2026-09-17T00:00:00Z",
        )
        self.state = {
            **self.state,
            "schema": self.runtime.STATE_SCHEMA,
            "profile_id": self.runtime.PROFILE_ID,
            "phase": "PREFLIGHTED",
            "calling_b2_environment_sha256": self.runtime._calling_b2_environment(self.core)["sha256"],
        }
        self.invocation = SimpleNamespace(primitive="release-activate", resource=None, relative_path=None)

    def tearDown(self) -> None:
        self.real_core._test_root = self.previous_root
        self.directory.cleanup()
        super().tearDown()

    def activate(self, *, pair_sequence, wait_sequence, raw_environment=None, phase="PREFLIGHTED"):
        writes: list[dict[str, object]] = []
        audits: list[tuple[object, ...]] = []
        composed: list[list[str]] = []
        projections: list[tuple[bool, object]] = []
        pairs = iter(pair_sequence)
        waits = iter(wait_sequence)

        def run(_core, args, **_kwargs):
            composed.append(list(args))
            return SimpleNamespace(stdout=b"", returncode=0)

        def projection(_core, _profile, _overlay, *, activate, release_value=None, calling_values=None):
            projections.append((activate, dict(calling_values) if calling_values is not None else None))

        self.audits = audits
        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value={**self.state, "phase": phase}),
            mock.patch.object(self.runtime, "_pair", side_effect=lambda *_: next(pairs)),
            mock.patch.object(self.runtime, "_wait_pair", side_effect=lambda *_: next(waits)),
            mock.patch.object(self.runtime, "_raw_container", side_effect=lambda _core, _name: raw_gravity(self.target_pair()[0], raw_environment or disarmed_environment())),
            mock.patch.object(self.runtime, "_validate_compose_inputs"),
            mock.patch.object(self.runtime, "_validate_target_image"),
            mock.patch.object(self.runtime, "_validate_release_environment", return_value={"sha256": "s" * 64, "value": MESSAGING_SECRET}),
            mock.patch.object(self.runtime, "_validate_projection", side_effect=projection),
            mock.patch.object(self.runtime, "_run", side_effect=run),
            mock.patch.object(self.runtime, "_database_status", return_value={"state": "EXACT"}),
            mock.patch.object(self.runtime, "_unrelated_fingerprint", return_value="u" * 64),
            mock.patch.object(self.runtime, "_assert_rollback_material"),
            mock.patch.object(self.runtime, "_write_state", side_effect=lambda _core, value: writes.append(value)),
            mock.patch.object(self.runtime, "_audit", side_effect=lambda *args: audits.append(args)),
        ):
            try:
                result, failure = self.runtime._release_activate(self.core, {}, self.profile, self.invocation), None
            except self.real_core.RuntimeFault as exc:
                result, failure = None, exc
        assert_no_secret(self, result, writes, audits, failure and failure.details, failure and str(failure))
        return result, failure, writes, composed, projections

    def test_bound_unchanged_source_activates_gravity_with_the_exact_calling_set(self) -> None:
        result, failure, writes, composed, projections = self.activate(
            pair_sequence=[self.predecessor_pair()], wait_sequence=[self.target_pair()],
        )
        self.assertIsNone(failure)
        self.assertEqual(result["status"], "ACTIVATED")
        self.assertEqual([value["phase"] for value in writes], ["ACTIVATION_INTENT", "ACTIVATED"])
        self.assertEqual(projections, [(True, CALLING_VALUES)])
        self.assertEqual(len(composed), 1)
        self.assertIn(self.runtime.ACTIVATE_OVERLAY, composed[0])
        self.assertEqual(composed[0][-2:], ["gravity-mvp", "max-web-scraper"])

    def test_source_changed_after_preflight_refuses_before_intent_and_compose(self) -> None:
        self.source.write_text(source_text({**CALLING_VALUES, LIVE: "true"}), encoding="ascii")
        result, failure, writes, composed, projections = self.activate(pair_sequence=[self.predecessor_pair()], wait_sequence=[])
        self.assertIsNone(result)
        self.assertEqual(failure.code, "CALLING_B2_ENVIRONMENT_IDENTITY_DRIFT")
        self.assertEqual((writes, composed, projections), ([], [], []))

    def test_failed_activation_rolls_back_only_when_disarmed(self) -> None:
        drifted = self.target_pair(gravity_names=sorted([*GRAVITY_TARGET_NAMES, "FOO_SECRET"]))
        result, failure, writes, composed, projections = self.activate(
            pair_sequence=[self.predecessor_pair(), drifted, drifted],
            wait_sequence=[drifted, self.predecessor_pair()],
        )
        self.assertIsNone(result)
        self.assertEqual(failure.code, "ACTIVATION_FAILED_AUTOMATIC_ROLLBACK_OK")
        self.assertEqual(failure.details["activation_failure"]["code"], "GRAVITY_RUNTIME_SEMANTIC_DRIFT")
        self.assertEqual(writes[-1]["phase"], "ROLLED_BACK")
        self.assertEqual([item[0] for item in projections], [True, False])
        self.assertEqual(projections[1], (False, None))
        self.assertIn(self.runtime.ROLLBACK_OVERLAY, composed[1])

    def test_failed_activation_with_an_armed_gravity_is_refused_before_any_rollback_intent(self) -> None:
        drifted = self.target_pair(gravity_names=sorted([*GRAVITY_TARGET_NAMES, "FOO_SECRET"]))
        result, failure, writes, composed, projections = self.activate(
            pair_sequence=[self.predecessor_pair(), drifted],
            wait_sequence=[drifted],
            raw_environment=[f"{LIVE}=true", f"{GATE}=true", f"AI_CALL_CONTROLLED_OPERATOR_TOKEN={TOKEN_MARKER}"],
        )
        self.assertIsNone(result)
        refusal = {"code": "CALLING_B2_KILL_SWITCH_ARMED", "details": {"armed_kill_switches": [GATE, LIVE]}}
        self.assertEqual(failure.code, "ACTIVATION_FAILED_AUTOMATIC_ROLLBACK_REFUSED")
        self.assertEqual(failure.details["rollback_refusal"], refusal)
        self.assertEqual(failure.details["activation_failure"]["code"], "GRAVITY_RUNTIME_SEMANTIC_DRIFT")
        self.assertEqual([value["phase"] for value in writes], ["ACTIVATION_INTENT", "ACTIVATION_FAILED"])
        self.assertEqual(writes[-1]["automatic_rollback_refusal"], refusal)
        self.assertEqual([audit[3] for audit in self.audits], ["intent", "failed_rollback_refused_calling_b2"])
        self.assertEqual(len(composed), 1)
        self.assertEqual([item[0] for item in projections], [True])

    def test_target_recovery_with_an_armed_gravity_is_refused_before_any_rollback_intent(self) -> None:
        drifted = self.target_pair(gravity_names=sorted([*GRAVITY_TARGET_NAMES, "FOO_SECRET"]))
        result, failure, writes, composed, _ = self.activate(
            pair_sequence=[self.target_pair()], wait_sequence=[drifted],
            raw_environment=[f"{LIVE}=true", f"{GATE}=false"], phase="ACTIVATION_INTENT",
        )
        self.assertIsNone(result)
        self.assertEqual(failure.code, "ACTIVATION_FAILED_AUTOMATIC_ROLLBACK_REFUSED")
        self.assertEqual(failure.details["rollback_refusal"]["details"], {"armed_kill_switches": [LIVE]})
        self.assertEqual([value["phase"] for value in writes], ["ACTIVATION_FAILED"])
        self.assertEqual([audit[3] for audit in self.audits], ["target_postcheck_failed_rollback_refused_calling_b2"])
        self.assertEqual(composed, [])

    def test_recheck_of_an_armed_activated_release_only_reports_and_keeps_its_state(self) -> None:
        drifted = self.target_pair(gravity_names=sorted([*GRAVITY_TARGET_NAMES, "FOO_SECRET"]))
        for label, environment, code in (
            ("armed", [f"{GATE}=true"], "CALLING_B2_KILL_SWITCH_ARMED"),
            ("unproven", [LIVE], "CALLING_B2_KILL_SWITCH_STATE_UNPROVEN"),
        ):
            with self.subTest(case=label):
                result, failure, writes, composed, _ = self.activate(
                    pair_sequence=[self.target_pair()], wait_sequence=[drifted], raw_environment=environment, phase="ACTIVATED",
                )
                self.assertIsNone(result)
                self.assertEqual(failure.code, "ACTIVATED_POSTCHECK_FAILED_ROLLBACK_REFUSED")
                self.assertEqual(failure.details["rollback_refusal"]["code"], code)
                self.assertEqual(failure.details["activation_failure"]["code"], "GRAVITY_RUNTIME_SEMANTIC_DRIFT")
                self.assertEqual((writes, composed), ([], []))

    def test_recheck_of_a_disarmed_activated_release_keeps_the_existing_automatic_rollback(self) -> None:
        drifted = self.target_pair(gravity_names=sorted([*GRAVITY_TARGET_NAMES, "FOO_SECRET"]))
        result, failure, writes, composed, _ = self.activate(
            pair_sequence=[self.target_pair(), drifted], wait_sequence=[drifted, self.predecessor_pair()], phase="ACTIVATED",
        )
        self.assertIsNone(result)
        self.assertEqual(failure.code, "ACTIVATION_FAILED_AUTOMATIC_ROLLBACK_OK")
        self.assertEqual([value["phase"] for value in writes], ["ACTIVATION_FAILED", "ROLLBACK_INTENT", "ROLLED_BACK"])
        self.assertNotIn("automatic_rollback_refusal", writes[0])
        self.assertEqual(self.audits[0][3], "target_postcheck_failed")
        self.assertEqual(len(composed), 1)
        self.assertIn(self.runtime.ROLLBACK_OVERLAY, composed[0])

    def test_preflight_binds_the_calling_digest_and_refuses_an_invalid_source_before_loading(self) -> None:
        bound = self.runtime._calling_b2_environment(self.core)
        captured: dict[str, object] = {}
        with (
            mock.patch.object(self.runtime, "_lock", return_value=nullcontext()),
            mock.patch.object(self.runtime, "_read_state", return_value={"phase": "UNINITIALIZED"}),
            mock.patch.object(self.runtime, "_pair", return_value=self.predecessor_pair()),
            mock.patch.object(self.runtime, "_predecessor_identity", return_value={
                "environment_sha256": "e" * 64, "gravity_semantic": {}, "max_semantic": {},
                "unrelated_semantic_fingerprint_sha256": "u" * 64, "predecessor_instance": {},
                "database": {"database_identity_sha256": "d" * 64, "migration_rows_sha256": "r" * 64},
            }),
            mock.patch.object(self.runtime, "_release_environment", return_value={"sha256": "s" * 64, "value": MESSAGING_SECRET}),
            mock.patch.object(self.runtime, "_artifact_receipt", return_value={"files": {}}),
            mock.patch.object(self.runtime, "_image_inspect", return_value={"Id": "loaded"}),
            mock.patch.object(self.runtime, "_storage_guard", return_value={}),
            mock.patch.object(self.runtime, "_load_target", return_value={"Id": "loaded"}),
            mock.patch.object(self.runtime, "_seal_rollback_reference"),
            mock.patch.object(self.runtime, "_derive_compose_domains", side_effect=lambda _c, _p, release, calling: captured.update(release=release, calling=dict(calling)) or {}),
            mock.patch.object(self.runtime, "_write_state", side_effect=lambda _c, value: captured.update(state=value)),
            mock.patch.object(self.runtime, "_audit"),
        ):
            profile = {**self.profile, "artifact_admission": {"receipt_sha256": "a" * 64}}
            result = self.runtime._release_preflight(self.core, {}, profile, SimpleNamespace(primitive="release-preflight", resource=None, relative_path=None))
            self.assertEqual(result["status"], "PREFLIGHTED")
            self.assertEqual(captured["calling"], CALLING_VALUES)
            self.assertEqual(captured["state"]["calling_b2_environment_sha256"], bound["sha256"])
            assert_no_secret(self, {key: value for key, value in captured.items() if key != "calling" and key != "release"}, result)
            self.source.write_text(source_text() + "FOO_SECRET='x'\n", encoding="ascii")
            with (
                mock.patch.object(self.runtime, "_artifact_receipt") as receipt,
                mock.patch.object(self.runtime, "_load_target") as load,
                mock.patch.object(self.runtime, "_write_state") as write,
            ):
                with self.assertRaises(self.real_core.RuntimeFault) as raised:
                    self.runtime._release_preflight(self.core, {}, profile, SimpleNamespace(primitive="release-preflight", resource=None, relative_path=None))
                self.assertEqual(raised.exception.code, "CALLING_B2_ENVIRONMENT_SOURCE_INVALID")
                receipt.assert_not_called()
                load.assert_not_called()
                write.assert_not_called()


class ExistingInvariantTests(CallingBase):
    def rendered_profile(self) -> dict[str, object]:
        raw = (ROOT / "templates/profile.v1.json.in").read_text(encoding="ascii")
        return json.loads(re.sub(r'"@[A-Z_]+@"', '"placeholder"', raw.replace("@ARTIFACT_FILES_JSON@", "{}")))

    def test_arbitrary_artifact_selection_and_arguments_remain_disabled(self) -> None:
        profile = self.rendered_profile()
        self.assertIs(profile["negative_properties"]["arbitrary_artifact_selection"], False)
        self.assertIs(profile["negative_properties"]["arbitrary_environment_override"], False)
        for resource, relative in (("crm.container.gravity_mvp", None), (None, "calling-b2/gravity-mvp.env"), ("x", "y")):
            for primitive in ("release-preflight", "release-activate", "rollback"):
                with self.subTest(primitive=primitive, resource=resource, relative=relative):
                    invocation = SimpleNamespace(primitive=primitive, resource=resource, relative_path=relative)
                    with mock.patch.object(self.runtime, "_load_profile", return_value=profile):
                        self.assertFault("PROFILE_ARGUMENTS_FORBIDDEN", self.runtime.dispatch, self.core, {}, invocation)

    def test_database_migrate_and_config_activate_remain_disabled(self) -> None:
        profile = self.rendered_profile()
        self.assertEqual(profile["enabled_zero_argument_profiles"], ["database-status", "release-preflight", "release-activate", "rollback"])
        self.assertEqual(set(profile["disabled_profiles"]), {"config-activate", "database-migrate"})
        self.assertIs(profile["database"]["mutation_authorized"], False)
        for primitive in ("database-migrate", "config-activate", "calling-disarm", "calling-arm"):
            with self.subTest(primitive=primitive):
                invocation = SimpleNamespace(primitive=primitive, resource=None, relative_path=None)
                with mock.patch.object(self.runtime, "_load_profile", return_value=profile):
                    self.assertFault("PROFILE_DISABLED", self.runtime.dispatch, self.core, {}, invocation)

    def test_profile_source_carries_no_generic_environment_or_command_escape(self) -> None:
        source = (ROOT / "templates/crm-activation-profile.py.in").read_text(encoding="ascii")
        for forbidden in ("os.environ", "allow_env_drift", "sys.argv", "input(", "shell=True", "subprocess.Popen"):
            self.assertNotIn(forbidden, source)
        self.assertEqual(source.count("CALLING_B2_ENVIRONMENT_SOURCE_MAXIMUM = "), 1)


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
        self.environment.write_text("SHARED_A=1\nPOSTGRES_USER=u\nBRIDGE_SHARED_TOKEN=shared\n", encoding="ascii")
        services = ""
        for service in ("gravity-mvp", "max-web-scraper", "tg-bot", "audio-bridge", "freeswitch"):
            services += f"  {service}:\n    image: crm/{service}:x\n    env_file:\n      - ../.env.production\n"
            if service == "gravity-mvp":
                services += "    environment:\n      NODE_ENV: production\n      DATABASE_URL: postgresql://${POSTGRES_USER}@postgres\n"
        (root / "deploy/docker-compose.production.yml").write_text("services:\n" + services, encoding="ascii")
        release = root / "release"
        release.mkdir(mode=0o700)
        self.sources = {service: str(release / f"{service}.env") for service in ("gravity-mvp", "max-web-scraper")}
        for path in self.sources.values():
            Path(path).write_text(f"{MESSAGING}={MESSAGING_SECRET}\n", encoding="ascii")
        self.calling_source = release / "calling-gravity-mvp.env"
        self.calling_source.write_text(source_text(), encoding="ascii")
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
        self.patches = [
            mock.patch.object(self.runtime, "RELEASE_ENVIRONMENT_SOURCES", self.sources),
            mock.patch.object(self.runtime, "CALLING_B2_ENVIRONMENT_SOURCE", str(self.calling_source)),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self) -> None:
        for patch in reversed(self.patches):
            patch.stop()
        self.directory.cleanup()

    def overlay(self, activate: bool, extra: str = "") -> str:
        target = self.root / ("activate.yml" if activate else "rollback.yml")
        references = (self.runtime.TARGET_GRAVITY, self.runtime.TARGET_MAX) if activate else (self.runtime.ROLLBACK_GRAVITY, self.runtime.ROLLBACK_MAX)
        target.write_bytes(self.runtime._compose_overlay(*references, activate=activate) + extra.encode("ascii"))
        return str(target)

    def validate(self, overlay: str, *, calling_values=CALLING_VALUES) -> None:
        self.runtime._validate_projection(
            self.core, self.profile, overlay, activate=True, release_value=MESSAGING_SECRET, calling_values=calling_values,
        )

    def assertRenderFault(self, code: str, overlay: str, **kwargs) -> None:
        with self.assertRaises(RuntimeFault) as raised:
            self.validate(overlay, **kwargs)
        self.assertEqual(raised.exception.code, code)
        assert_no_secret(self, raised.exception.details, str(raised.exception))

    def test_real_render_attaches_calling_names_only_to_gravity(self) -> None:
        activate = self.overlay(True)
        self.validate(activate)
        rollback = self.overlay(False)
        self.runtime._validate_projection(self.core, self.profile, rollback, activate=False)
        base = self.runtime._compose_config(self.core, self.runtime._compose_args(self.profile))
        render = self.runtime._compose_config(self.core, self.runtime._compose_args(self.profile, activate))
        restored = self.runtime._compose_config(self.core, self.runtime._compose_args(self.profile, rollback))
        for service in ("gravity-mvp", "max-web-scraper", "tg-bot", "audio-bridge", "freeswitch"):
            added = set(render["services"][service].get("environment", {})) - set(base["services"][service].get("environment", {}))
            expected = {MESSAGING, *CALLING_NAMES} if service == "gravity-mvp" else {MESSAGING} if service == "max-web-scraper" else set()
            self.assertEqual(added, expected, service)
            self.assertFalse(set(CALLING_NAMES) & set(restored["services"][service].get("environment", {})), service)
            self.assertFalse(set(CALLING_NAMES) & set(base["services"][service].get("environment", {})), service)
        gravity = render["services"]["gravity-mvp"]
        self.assertEqual(gravity["command"], ["npm", "run", "start"])
        self.assertEqual(gravity["environment"]["AI_CALL_DIAL_STRING_TEMPLATE"], "sofia/gateway/megafon/$${number}")
        hashes = {
            (overlay, service): self.runtime._compose_hash(self.core, self.profile, overlay, service)
            for overlay in (activate, rollback) for service in ("gravity-mvp", "max-web-scraper")
        }
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{64}", value) for value in hashes.values()))
        self.assertNotEqual(hashes[(activate, "gravity-mvp")], hashes[(rollback, "gravity-mvp")])

    def test_real_render_hash_binds_calling_values(self) -> None:
        activate = self.overlay(True)
        first = self.runtime._compose_hash(self.core, self.profile, activate, "gravity-mvp")
        self.calling_source.write_text(source_text({**CALLING_VALUES, LIVE: "true"}), encoding="ascii")
        second = self.runtime._compose_hash(self.core, self.profile, activate, "gravity-mvp")
        self.assertNotEqual(first, second)
        self.assertEqual(
            self.runtime._compose_hash(self.core, self.profile, activate, "max-web-scraper"),
            self.runtime._compose_hash(self.core, self.profile, activate, "max-web-scraper"),
        )

    def test_real_render_calling_capability_has_no_shared_env_file_dependency(self) -> None:
        self.assertNotIn(LIVE, self.environment.read_text(encoding="ascii"))
        self.validate(self.overlay(True))
        self.environment.write_text(self.environment.read_text(encoding="ascii") + f"{LIVE}=false\n", encoding="ascii")
        self.assertRenderFault("CALLING_B2_ENVIRONMENT_ALREADY_PRESENT", self.overlay(True))

    def test_real_render_rejects_the_calling_source_on_any_other_service(self) -> None:
        source = str(self.calling_source)
        extra = f"    env_file:\n      - {source}\n"
        self.assertRenderFault("PAIR_COMPOSE_PROJECTION_DRIFT", self.overlay_with_max_calling(source))
        for service in UNRELATED_SERVICES:
            with self.subTest(service=service):
                self.assertRenderFault("UNRELATED_COMPOSE_SERVICE_DRIFT", self.overlay(True, f"  {service}:\n{extra}"))

    def overlay_with_max_calling(self, source: str) -> str:
        path = Path(self.overlay(True))
        text = path.read_text(encoding="ascii")
        messaging = self.sources["max-web-scraper"]
        self.assertEqual(text.count(f"      - {messaging}\n"), 1)
        path.write_text(text.replace(f"      - {messaging}\n", f"      - {messaging}\n      - {source}\n"), encoding="ascii")
        return str(path)

    def test_real_render_rejects_a_source_that_injects_or_changes_variables(self) -> None:
        self.calling_source.write_text(source_text() + "NODE_OPTIONS='--require=/tmp/x.js'\n", encoding="ascii")
        self.assertRenderFault("PAIR_COMPOSE_PROJECTION_DRIFT", self.overlay(True))
        self.calling_source.write_text(source_text() + "BRIDGE_SHARED_TOKEN='replaced'\n", encoding="ascii")
        self.assertRenderFault("PAIR_COMPOSE_PROJECTION_DRIFT", self.overlay(True))
        self.calling_source.write_text(source_text(), encoding="ascii")
        self.assertRenderFault("CALLING_B2_ENVIRONMENT_PROJECTION_DRIFT", self.overlay(True), calling_values={**CALLING_VALUES, "AI_CALL_PARK_EXT": "9998"})
        # Unquoted, Compose would interpolate `${number}` away, so the render differs from the bound value.
        unquoted = source_text().replace(f"AI_CALL_DIAL_STRING_TEMPLATE='{DIAL_TEMPLATE}'", f"AI_CALL_DIAL_STRING_TEMPLATE={DIAL_TEMPLATE}")
        self.assertNotEqual(unquoted, source_text())
        self.calling_source.write_text(unquoted, encoding="ascii")
        self.assertRenderFault("CALLING_B2_ENVIRONMENT_PROJECTION_DRIFT", self.overlay(True))


if __name__ == "__main__":
    unittest.main()
