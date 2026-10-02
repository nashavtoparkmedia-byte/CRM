#!/usr/bin/python3
"""Contract tests for the v2 effective layered predecessor observation."""
from __future__ import annotations

import copy
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any


ROOT = Path(__file__).resolve().parents[1]


def load(name: str, path: Path) -> Any:
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    loader.exec_module(module)
    return module


OBSERVATION = load("yoko_predecessor_observability_v2_test", ROOT / "src/predecessor-observability-v1.py")
CORE = load("yoko_privileged_runtime_core_observer_test", ROOT / "src/yoko-privileged-runtime-core.py")

BASE = OBSERVATION.COMPOSE_PATH
PREDECESSOR_OVERLAY = "/var/lib/yoko-privileged-runtime/profiles/crm-aaaaaaaaaaaa-gravity-max-source-v1/activate.compose.yml"
CANDIDATE_OVERLAY = "/var/lib/yoko-privileged-runtime/profiles/crm-bbbbbbbbbbbb-gravity-max-source-v1/activate.compose.yml"
IMAGE_OVERLAY = "/opt/crm/deploy/activate.hotfix.compose.yml"
RELEASE_SECRET = "0123456789abcdef" * 4
SHARED_SECRET = "correct horse battery staple"

GRAVITY_IMAGE = "sha256:" + "2" * 64
TELEGRAM_IMAGE = "sha256:" + "3" * 64
MAX_IMAGE = "sha256:" + "4" * 64
HOTFIX_GRAVITY_IMAGE = "sha256:" + "5" * 64

IMAGE_OVERLAY_TEXT = (
    "# Hotfix — IMAGE OVERLAY ONLY.\n"
    "services:\n"
    "  gravity-mvp:\n"
    "    image: yoko/gravity:hotfix\n"
    "  tg-bot:\n"
    "    # unchanged bot image\n"
    "    image: crm/tg-bot:current\n"
)


def image_object(image_id: str, entrypoint: list[str], command: list[str]) -> dict[str, Any]:
    return {
        "Id": image_id, "Created": "2026-09-01T00:00:00Z", "Os": "linux", "Architecture": "amd64",
        "RepoDigests": [], "Config": {
            "Env": ["PATH=/usr/local/bin:/usr/bin:/bin"],
            "Entrypoint": entrypoint, "Cmd": command,
        },
    }


class FakeCore:
    RuntimeFault = CORE.RuntimeFault
    DOCKER = "/usr/bin/docker"

    def __init__(self, *, layered: bool = True) -> None:
        self.calls: list[list[str]] = []
        self._temporary_root = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary_root.name)
        self.write(BASE, "services: {}\n", 0o644)
        self.write(OBSERVATION.ENVIRONMENT_PATH, "SHARED_SECRET=x\n", 0o600)
        self.write(PREDECESSOR_OVERLAY, "services: {}\n", 0o400)
        self.write(CANDIDATE_OVERLAY, "candidate: never-consumed\n", 0o400)
        self.write(IMAGE_OVERLAY, IMAGE_OVERLAY_TEXT, 0o644)
        self.images = {
            "yoko/gravity:predecessor": image_object(GRAVITY_IMAGE, ["/usr/bin/tini", "--"], ["sh", "-c", "npx prisma migrate deploy && npm run start"]),
            "yoko/gravity:hotfix": image_object(HOTFIX_GRAVITY_IMAGE, ["/usr/bin/tini", "--"], ["sh", "-c", "npx prisma migrate deploy && npm run start"]),
            "crm/tg-bot:current": image_object(TELEGRAM_IMAGE, ["/usr/bin/tini", "--", "/usr/local/bin/tg-bot-entrypoint"], ["node", "start.js"]),
            "yoko/max:predecessor": image_object(MAX_IMAGE, ["/usr/bin/tini", "--"], ["node", "index.js"]),
        }
        for value in list(self.images.values()):
            self.images[value["Id"]] = value
        self.resolutions = {
            (BASE,): self.resolved(overlay=False),
            (BASE, PREDECESSOR_OVERLAY): self.resolved(overlay=True),
        }
        if layered:
            stacks = {
                "gravity-mvp": [BASE, PREDECESSOR_OVERLAY, IMAGE_OVERLAY],
                "tg-bot": [BASE, PREDECESSOR_OVERLAY, IMAGE_OVERLAY],
                "max-web-scraper": [BASE, PREDECESSOR_OVERLAY],
            }
            gravity_image, gravity_ref, gravity_command = HOTFIX_GRAVITY_IMAGE, "yoko/gravity:hotfix", ["npm", "run", "start"]
        else:
            stacks = {name: [BASE] for name in ("gravity-mvp", "tg-bot", "max-web-scraper")}
            gravity_image, gravity_ref = GRAVITY_IMAGE, "yoko/gravity:predecessor"
            gravity_command = ["sh", "-c", "npx prisma migrate deploy && npm run start"]
        released = layered
        self.containers = {
            "crm-gravity-mvp": self.container(
                "crm-gravity-mvp", "gravity-mvp", gravity_ref, gravity_image, gravity_command,
                stacks["gravity-mvp"], release=released,
                mounts=[("crm_gravity_recordings", "/app/recordings", True), ("crm_freeswitch_recordings", "/app/freeswitch-recordings", False)],
            ),
            "crm-tg-bot": self.container(
                "crm-tg-bot", "tg-bot", "crm/tg-bot:current", TELEGRAM_IMAGE, ["node", "start.js"],
                stacks["tg-bot"], release=False, mounts=[("crm_tg_bot_data", "/app/data", True)],
            ),
            "crm-max-scraper": self.container(
                "crm-max-scraper", "max-web-scraper", "yoko/max:predecessor", MAX_IMAGE, ["node", "index.js"],
                stacks["max-web-scraper"], release=released, mounts=[("crm_max_user_data", "/app/user_data", True)],
            ),
        }

    def __del__(self) -> None:
        self._temporary_root.cleanup()

    def write(self, path: str, text: str, mode: int) -> None:
        target = self.mapped(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            target.chmod(0o600)
        target.write_text(text, encoding="utf-8")
        target.chmod(mode)

    @staticmethod
    def canonical(value: Any) -> bytes:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")

    @staticmethod
    def resolved(*, overlay: bool) -> dict[str, Any]:
        def service(image: str, volumes: list[tuple[str, str, bool]], environment: dict[str, str], command: Any = None) -> dict[str, Any]:
            return {
                "image": image, "command": command, "entrypoint": None, "restart": "unless-stopped",
                "environment": environment,
                "networks": {"crm_internal": None},
                "volumes": [{"type": "volume", "source": source, "target": target, "read_only": read_only} for source, target, read_only in volumes],
            }
        release = {"MAX_SCRAPER_WEBHOOK_SECRET": RELEASE_SECRET} if overlay else {}
        return {
            "name": "crm",
            "services": {
                "gravity-mvp": service(
                    "yoko/gravity:predecessor",
                    [("gravity_recordings", "/app/recordings", False), ("freeswitch_recordings", "/app/freeswitch-recordings", True)],
                    {"SHARED_SECRET": SHARED_SECRET, **release},
                    ["npm", "run", "start"] if overlay else None,
                ),
                "tg-bot": service("crm/tg-bot:current", [("tg_bot_data", "/app/data", False)], {"SHARED_SECRET": SHARED_SECRET}),
                "max-web-scraper": service("yoko/max:predecessor", [("max_user_data", "/app/user_data", False)], {"SHARED_SECRET": SHARED_SECRET, **release}),
                "postgres": {"image": "postgres:16"},
            },
            "volumes": {
                key: {"name": "crm_" + key}
                for key in ("gravity_recordings", "freeswitch_recordings", "tg_bot_data", "max_user_data")
            },
            "networks": {"crm_internal": {"name": "crm_internal"}},
        }

    @staticmethod
    def host() -> dict[str, Any]:
        return {
            "Init": None, "NetworkMode": "crm_internal", "Privileged": False, "ReadonlyRootfs": False,
            "RestartPolicy": {"Name": "unless-stopped", "MaximumRetryCount": 0},
            "ExtraHosts": [], "Dns": [], "DnsOptions": [], "DnsSearch": [], "Ulimits": [],
        }

    def container(
        self, name: str, service: str, reference: str, image_id: str, command: list[str],
        stack: list[str], *, release: bool, mounts: list[tuple[str, str, bool]],
    ) -> dict[str, Any]:
        environment = ["PATH=/usr/local/bin:/usr/bin:/bin", "SHARED_SECRET=" + SHARED_SECRET, "HOSTNAME=" + "a" * 12]
        if release:
            environment.append("MAX_SCRAPER_WEBHOOK_SECRET=" + RELEASE_SECRET)
        return {
            "Id": hashlib.sha256(name.encode()).hexdigest(),
            "Name": "/" + name,
            "Created": "2026-10-01T21:02:20Z",
            "Image": image_id,
            "Mounts": [
                {"Type": "volume", "Name": volume, "Destination": target, "RW": rw, "Propagation": ""}
                for volume, target, rw in mounts
            ],
            "Config": {
                "Image": reference,
                "Hostname": "a" * 12,
                "Env": environment,
                "Entrypoint": list(self.images[reference]["Config"]["Entrypoint"]),
                "Cmd": command,
                "WorkingDir": "/app",
                "User": "",
                "Labels": {
                    "com.docker.compose.project": "crm",
                    "com.docker.compose.service": service,
                    "com.docker.compose.config-hash": hashlib.sha256(service.encode()).hexdigest(),
                    "com.docker.compose.version": "5.1.4",
                    "com.docker.compose.project.config_files": ",".join(stack),
                    "com.docker.compose.project.working_dir": "/opt/crm/deploy",
                    "com.docker.compose.project.environment_file": "/opt/crm/.env.production",
                },
                "Healthcheck": None,
                "StopSignal": "SIGTERM",
                "StopTimeout": 10,
            },
            "HostConfig": self.host(),
            "NetworkSettings": {
                "Ports": {},
                "Networks": {"crm_internal": {"NetworkID": "e" * 64, "EndpointID": "f" * 64, "Aliases": [service], "DNSNames": [name]}},
            },
        }

    # Core surface used by the observer.
    def mapped(self, path: str) -> Path:
        return self.root / path.lstrip("/")

    def assert_noncaller_writable_chain(self, path: Path) -> None:
        self.calls.append(["assert-noncaller-writable-chain", str(path)])

    @staticmethod
    def expected_owner() -> tuple[int, int]:
        return os.getuid(), os.getgid()

    def secure_file(self, path: str, mode: int, *, maximum: int) -> os.stat_result:
        self.calls.append(["secure-file", path, format(mode, "04o")])
        target = self.mapped(path)
        value = target.lstat()
        if target.is_symlink() or (value.st_mode & 0o7777) != mode or value.st_size > maximum:
            raise CORE.RuntimeFault("UNSAFE_FILE")
        return value

    def hash_file(self, path: Path, *, maximum: int) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def run_fixed(self, args: list[str], *, timeout: int) -> Any:
        self.calls.append(list(args))
        files = tuple(args[index + 1] for index, item in enumerate(args) if item == "-f")
        if args[-3:] != ["config", "--format", "json"] or files not in self.resolutions:
            return SimpleNamespace(returncode=1, stdout=b"", stderr=b"")
        return SimpleNamespace(returncode=0, stdout=self.canonical(self.resolutions[files]), stderr=b"")

    @staticmethod
    def parse_json(raw: bytes, *, maximum: int) -> Any:
        return json.loads(raw)

    def docker_json(self, args: list[str], policy: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(["/usr/bin/docker", *args])
        if len(args) != 3 or args[1] != "inspect":
            raise AssertionError(f"non-inspection Docker call: {args}")
        kind, name = args[0], args[2]
        if kind == "container":
            return self.containers[name]
        if kind == "image":
            return self.images[name]
        if kind == "volume":
            return {"Name": name, "Driver": "local", "Options": None, "Scope": "local", "Labels": {}}
        if kind == "network":
            return {"Id": "e" * 64, "Name": name, "Driver": "bridge", "Scope": "local", "Internal": True, "IPAM": None, "Options": None, "Labels": {}}
        raise AssertionError(args)

    @staticmethod
    def semantic_published_ports(value: Any) -> dict[str, Any]:
        return {} if value in (None, {}) else value


POLICY = {
    "limits": {"command_timeout_seconds": 20},
    "resources": {
        "crm.container.gravity_mvp": {"kind": "container", "name": "crm-gravity-mvp", "operations": ["docker-inspect"]},
        "crm.container.telegram_bot": {"kind": "container", "name": "crm-tg-bot", "operations": ["docker-inspect"]},
        "crm.container.max_scraper": {"kind": "container", "name": "crm-max-scraper", "operations": ["docker-inspect"]},
    },
}


class PredecessorObservationV2Tests(unittest.TestCase):
    def fault(self, core: FakeCore) -> Any:
        with self.assertRaises(CORE.RuntimeFault) as captured:
            OBSERVATION.observe(core, POLICY)
        return captured.exception

    # 1. base-only predecessor still validates when no overlay contributes semantics
    def test_base_only_predecessor_validates(self) -> None:
        core = FakeCore(layered=False)
        result = OBSERVATION.observe(core, POLICY)
        self.assertEqual(result["schema"], "yoko.crm.predecessor-recreation-observation.v2")
        self.assertEqual([item["compose_service"] for item in result["services"]], ["gravity-mvp", "tg-bot", "max-web-scraper"])
        self.assertEqual(result["compose_source"]["overlay_layers"], [])
        for service in result["services"]:
            self.assertEqual(service["reconstruction"]["compose_files_resolved"], [BASE])
        gravity = result["services"][0]
        self.assertEqual(gravity["execution"]["command"], ["sh", "-c", "npx prisma migrate deploy && npm run start"])
        compose_calls = [call for call in core.calls if call[:2] == ["/usr/bin/docker", "compose"]]
        self.assertEqual(len(compose_calls), 1)

    # 2. a digest-bound sealed overlay validates when the live service uses it
    def test_sealed_overlay_predecessor_validates_with_bound_digests(self) -> None:
        core = FakeCore()
        result = OBSERVATION.observe(core, POLICY)
        gravity, telegram, maximum = result["services"]
        self.assertEqual(gravity["execution"]["command"], ["npm", "run", "start"])
        self.assertEqual(gravity["image"]["id"], HOTFIX_GRAVITY_IMAGE)
        self.assertIn("MAX_SCRAPER_WEBHOOK_SECRET", gravity["environment"]["effective_key_set"])
        self.assertIn("MAX_SCRAPER_WEBHOOK_SECRET", maximum["environment"]["effective_key_set"])
        self.assertEqual(maximum["reconstruction"]["compose_files_resolved"], [BASE, PREDECESSOR_OVERLAY])
        layers = {layer["path"]: layer for layer in result["compose_source"]["overlay_layers"]}
        self.assertEqual(set(layers), {PREDECESSOR_OVERLAY, IMAGE_OVERLAY})
        self.assertEqual(layers[PREDECESSOR_OVERLAY]["role"], "runtime-profile-overlay")
        self.assertEqual(layers[PREDECESSOR_OVERLAY]["sha256"], hashlib.sha256(b"services: {}\n").hexdigest())
        self.assertEqual(layers[IMAGE_OVERLAY]["sha256"], hashlib.sha256(IMAGE_OVERLAY_TEXT.encode()).hexdigest())
        self.assertEqual(layers[IMAGE_OVERLAY]["image_pins"], {"gravity-mvp": "yoko/gravity:hotfix", "tg-bot": "crm/tg-bot:current"})
        self.assertIn(["secure-file", PREDECESSOR_OVERLAY, "0400"], core.calls)
        # The image-only overlay is never handed to Compose.
        for call in core.calls:
            if call[:2] == ["/usr/bin/docker", "compose"]:
                self.assertNotIn(IMAGE_OVERLAY, call)
        self.assertEqual(OBSERVATION.observe(FakeCore(), POLICY), result)

    # 3. a missing required predecessor layer fails closed
    def test_missing_layer_fails_closed(self) -> None:
        core = FakeCore()
        core.mapped(IMAGE_OVERLAY).unlink()
        self.assertEqual(self.fault(core).code, "PREDECESSOR_LAYER_MISSING")
        core = FakeCore()
        core.mapped(PREDECESSOR_OVERLAY).unlink()
        self.assertEqual(self.fault(core).code, "PREDECESSOR_LAYER_MISSING")
        core = FakeCore()
        del core.containers["crm-max-scraper"]["Config"]["Labels"]["com.docker.compose.project.config_files"]
        self.assertEqual(self.fault(core).code, "PREDECESSOR_LAYER_STACK_MISSING")
        core = FakeCore()
        core.containers["crm-tg-bot"]["Config"]["Labels"]["com.docker.compose.project.config_files"] = PREDECESSOR_OVERLAY
        self.assertEqual(self.fault(core).code, "PREDECESSOR_LAYER_STACK_UNSUPPORTED")

    # 4. an untrusted or digest-mismatched overlay fails closed
    def test_untrusted_or_changed_overlay_fails_closed(self) -> None:
        core = FakeCore()
        core.write(IMAGE_OVERLAY, IMAGE_OVERLAY_TEXT + "    command: [\"sh\"]\n", 0o644)
        self.assertEqual(self.fault(core).code, "PREDECESSOR_OVERLAY_NOT_IMAGE_ONLY")
        core = FakeCore()
        core.write(IMAGE_OVERLAY, IMAGE_OVERLAY_TEXT.replace("image: yoko/gravity:hotfix", "env_file: /etc/shadow"), 0o644)
        self.assertEqual(self.fault(core).code, "PREDECESSOR_OVERLAY_NOT_IMAGE_ONLY")
        core = FakeCore()
        core.mapped(PREDECESSOR_OVERLAY).chmod(0o644)
        self.assertEqual(self.fault(core).code, "PREDECESSOR_LAYER_UNTRUSTED")
        for path in ("/tmp/../etc/x.compose.yml", "/opt/crm/deploy/x.yml", "relative.compose.yml"):
            core = FakeCore()
            core.containers["crm-gravity-mvp"]["Config"]["Labels"]["com.docker.compose.project.config_files"] = BASE + "," + path
            self.assertEqual(self.fault(core).code, "PREDECESSOR_LAYER_UNTRUSTED", path)
        # A recorded layer whose content changed after creation no longer
        # reconstructs the running container.
        core = FakeCore()
        core.write(IMAGE_OVERLAY, IMAGE_OVERLAY_TEXT.replace("yoko/gravity:hotfix", "yoko/gravity:predecessor"), 0o644)
        self.assertEqual(self.fault(core).code, "TARGET_IMAGE_RECONSTRUCTION_DRIFT")
        # Every consumed layer digest is bound into the release-critical identity.
        first = OBSERVATION.observe(FakeCore(), POLICY)["release_critical_identity_sha256"]
        core = FakeCore()
        core.write(IMAGE_OVERLAY, "# reviewed\n" + IMAGE_OVERLAY_TEXT, 0o644)
        self.assertNotEqual(OBSERVATION.observe(core, POLICY)["release_critical_identity_sha256"], first)

    # 5. a future candidate overlay cannot enter predecessor reconstruction
    def test_candidate_overlay_never_enters_reconstruction(self) -> None:
        core = FakeCore()
        result = OBSERVATION.observe(core, POLICY)
        self.assertNotIn(CANDIDATE_OVERLAY, json.dumps(core.calls))
        self.assertNotIn(CANDIDATE_OVERLAY, json.dumps(result))
        # Even naming it after the predecessor overlay is a second Runtime
        # layer, which no single release transition produces.
        core = FakeCore()
        core.containers["crm-max-scraper"]["Config"]["Labels"]["com.docker.compose.project.config_files"] = ",".join([BASE, PREDECESSOR_OVERLAY, CANDIDATE_OVERLAY])
        self.assertEqual(self.fault(core).code, "PREDECESSOR_LAYER_STACK_UNSUPPORTED")
        # A candidate overlay cannot certify a predecessor that was not
        # created from it: substituted into the recorded stack it resolves the
        # candidate's image and command, which the running container lacks.
        core = FakeCore()
        candidate = copy.deepcopy(core.resolutions[(BASE, PREDECESSOR_OVERLAY)])
        candidate["services"]["max-web-scraper"]["image"] = "yoko/max:candidate"
        core.images["yoko/max:candidate"] = image_object("sha256:" + "8" * 64, ["/usr/bin/tini", "--"], ["node", "index.js"])
        core.resolutions[(BASE, CANDIDATE_OVERLAY)] = candidate
        core.containers["crm-max-scraper"]["Config"]["Labels"]["com.docker.compose.project.config_files"] = ",".join([BASE, CANDIDATE_OVERLAY])
        self.assertEqual(self.fault(core).code, "TARGET_IMAGE_RECONSTRUCTION_DRIFT")
        core = FakeCore()
        core.containers["crm-max-scraper"]["Config"]["Labels"]["com.docker.compose.project.config_files"] = ",".join([BASE, IMAGE_OVERLAY, PREDECESSOR_OVERLAY])
        self.assertEqual(self.fault(core).code, "PREDECESSOR_LAYER_STACK_UNSUPPORTED")

    # 6. unexpected environment-name drift still fails
    def test_environment_name_drift_fails(self) -> None:
        core = FakeCore()
        core.containers["crm-tg-bot"]["Config"]["Env"].append("MAX_SCRAPER_WEBHOOK_SECRET=" + RELEASE_SECRET)
        fault = self.fault(core)
        self.assertEqual((fault.code, fault.details), ("EFFECTIVE_ENVIRONMENT_KEY_DRIFT", {"service": "tg-bot", "unexpected_key": "MAX_SCRAPER_WEBHOOK_SECRET"}))
        core = FakeCore()
        core.resolutions[(BASE, PREDECESSOR_OVERLAY)]["services"]["max-web-scraper"]["environment"]["CRM_TELEGRAM_CONNECTION_ID"] = "cid"
        fault = self.fault(core)
        self.assertEqual((fault.code, fault.details), ("EFFECTIVE_ENVIRONMENT_KEY_DRIFT", {"service": "max-web-scraper", "missing_keys": ["CRM_TELEGRAM_CONNECTION_ID"]}))
        # The base-only model is still refused for an overlay-activated service.
        core = FakeCore()
        core.containers["crm-gravity-mvp"]["Config"]["Labels"]["com.docker.compose.project.config_files"] = ",".join([BASE, IMAGE_OVERLAY])
        self.assertEqual(self.fault(core).code, "COMMAND_RECONSTRUCTION_DRIFT")

    # 7. command drift still fails
    def test_command_and_entrypoint_drift_fail(self) -> None:
        core = FakeCore()
        core.containers["crm-gravity-mvp"]["Config"]["Cmd"] = ["sh", "-c", "npx prisma migrate deploy && npm run start"]
        self.assertEqual(self.fault(core).code, "COMMAND_RECONSTRUCTION_DRIFT")
        core = FakeCore()
        core.resolutions[(BASE, PREDECESSOR_OVERLAY)]["services"]["gravity-mvp"]["command"] = None
        self.assertEqual(self.fault(core).code, "COMMAND_RECONSTRUCTION_DRIFT")
        core = FakeCore()
        core.containers["crm-gravity-mvp"]["Config"]["Cmd"] = ["sh", "-c", "anything"]
        self.assertEqual(self.fault(core).code, "COMMAND_CONFIGURATION_INVALID")
        core = FakeCore()
        core.resolutions[(BASE, PREDECESSOR_OVERLAY)]["services"]["max-web-scraper"]["entrypoint"] = ["/usr/bin/tini", "-s", "--"]
        self.assertEqual(self.fault(core).code, "ENTRYPOINT_RECONSTRUCTION_DRIFT")

    # 8. mount drift still fails
    def test_mount_and_network_drift_fail(self) -> None:
        core = FakeCore()
        core.containers["crm-gravity-mvp"]["Mounts"][1]["RW"] = True
        self.assertEqual(self.fault(core).code, "MOUNT_RECONSTRUCTION_DRIFT")
        core = FakeCore()
        core.containers["crm-max-scraper"]["Mounts"][0]["Name"] = "crm_max_user_data_new"
        self.assertEqual(self.fault(core).code, "MOUNT_RECONSTRUCTION_DRIFT")
        core = FakeCore()
        core.resolutions[(BASE, PREDECESSOR_OVERLAY)]["services"]["tg-bot"]["volumes"] = []
        self.assertEqual(self.fault(core).code, "MOUNT_RECONSTRUCTION_DRIFT")
        core = FakeCore()
        core.resolutions[(BASE, PREDECESSOR_OVERLAY)]["networks"]["crm_internal"]["name"] = "crm_default"
        self.assertEqual(self.fault(core).code, "NETWORK_RECONSTRUCTION_DRIFT")
        core = FakeCore()
        core.containers["crm-max-scraper"]["HostConfig"]["RestartPolicy"]["Name"] = "always"
        self.assertEqual(self.fault(core).code, "RESTART_POLICY_RECONSTRUCTION_DRIFT")

    # 9. service/image drift still fails
    def test_service_and_image_drift_fail(self) -> None:
        core = FakeCore()
        core.containers["crm-max-scraper"]["Image"] = GRAVITY_IMAGE
        self.assertEqual(self.fault(core).code, "TARGET_IMAGE_RECONSTRUCTION_DRIFT")
        core = FakeCore()
        core.containers["crm-gravity-mvp"]["Config"]["Image"] = "yoko/gravity:predecessor"
        self.assertEqual(self.fault(core).code, "TARGET_IMAGE_RECONSTRUCTION_DRIFT")
        core = FakeCore()
        core.images["yoko/max:predecessor"] = copy.deepcopy(core.images["yoko/max:predecessor"])
        core.images["yoko/max:predecessor"]["Id"] = "sha256:" + "9" * 64
        self.assertEqual(self.fault(core).code, "TARGET_IMAGE_RECONSTRUCTION_DRIFT")
        core = FakeCore()
        core.containers["crm-tg-bot"]["Config"]["Labels"]["com.docker.compose.service"] = "gravity-mvp"
        self.assertEqual(self.fault(core).code, "COMPOSE_LABELS_INVALID")
        core = FakeCore()
        core.containers["crm-max-scraper"]["Config"]["Labels"]["com.docker.compose.project.working_dir"] = "/opt/codex-work"
        self.assertEqual(self.fault(core).code, "PREDECESSOR_PROJECT_SOURCE_MISMATCH")
        core = FakeCore()
        del core.resolutions[(BASE, PREDECESSOR_OVERLAY)]["services"]["max-web-scraper"]
        self.assertEqual(self.fault(core).code, "RESOLVED_COMPOSE_SERVICE_MISSING")

    # 10. secrets are never printed or embedded in observation evidence
    def test_secret_values_never_emitted(self) -> None:
        core = FakeCore()
        result = OBSERVATION.observe(core, POLICY)
        serialized = json.dumps(result, sort_keys=True)
        for value in (SHARED_SECRET, RELEASE_SECRET):
            self.assertNotIn(value, serialized)
            self.assertNotIn(hashlib.sha256(value.encode()).hexdigest(), serialized)
        self.assertFalse(result["secret_values_emitted"])
        self.assertFalse(result["production_mutated"])
        core = FakeCore()
        core.containers["crm-gravity-mvp"]["Config"]["Env"] = [
            item if not item.startswith("MAX_SCRAPER_WEBHOOK_SECRET=") else "MAX_SCRAPER_WEBHOOK_SECRET=" + "f" * 64
            for item in core.containers["crm-gravity-mvp"]["Config"]["Env"]
        ]
        fault = self.fault(core)
        self.assertEqual(fault.code, "EFFECTIVE_ENVIRONMENT_VALUE_DRIFT")
        rendered = json.dumps(fault.details)
        self.assertNotIn(RELEASE_SECRET, rendered)
        self.assertNotIn("f" * 64, rendered)

    def test_only_inspection_and_compose_config_are_executed(self) -> None:
        core = FakeCore()
        OBSERVATION.observe(core, POLICY)
        for call in core.calls:
            if call and call[0] == "/usr/bin/docker":
                if call[1] == "compose":
                    self.assertEqual(call[-3:], ["config", "--format", "json"])
                    for forbidden in ("up", "down", "start", "stop", "restart", "create", "rm", "pull", "build"):
                        self.assertNotIn(forbidden, call)
                else:
                    self.assertEqual(call[2], "inspect")
        self.assertEqual(
            [call[1] for call in core.calls if call[0] == "assert-noncaller-writable-chain"],
            [str(core.mapped(BASE)), str(core.mapped(OBSERVATION.ENVIRONMENT_PATH))],
        )

    def test_image_only_grammar_is_strict(self) -> None:
        core = FakeCore()
        accepted = OBSERVATION._image_only_overlay(core, IMAGE_OVERLAY, IMAGE_OVERLAY_TEXT.encode())
        self.assertEqual(accepted, {"gravity-mvp": "yoko/gravity:hotfix", "tg-bot": "crm/tg-bot:current"})
        for text in (
            "services:\n  gravity-mvp:\n",
            "services:\n  gravity-mvp:\n    image: a:b\n    image: c:d\n",
            "services:\n  gravity-mvp:\n    image: a:b\n  gravity-mvp:\n    image: a:b\n",
            "services:\n\tgravity-mvp:\n    image: a:b\n",
            "services:\n  gravity-mvp:\n    image: \"a:b\"\n",
            "services:\n  gravity-mvp:\n    image: -flag\n",
            "x-anchor: &a\nservices:\n  gravity-mvp:\n    image: a:b\n",
            "services:\n  gravity-mvp:\n    image: a:b # trailing\n",
            "",
        ):
            with self.assertRaises(CORE.RuntimeFault, msg=text) as captured:
                OBSERVATION._image_only_overlay(core, IMAGE_OVERLAY, text.encode())
            self.assertEqual(captured.exception.code, "PREDECESSOR_OVERLAY_NOT_IMAGE_ONLY")

    def test_unknown_policy_resource_is_rejected(self) -> None:
        policy = json.loads(json.dumps(POLICY))
        policy["resources"]["crm.container.max_scraper"]["name"] = "attacker-container"
        with self.assertRaises(CORE.RuntimeFault) as captured:
            OBSERVATION.observe(FakeCore(), policy)
        self.assertEqual(captured.exception.code, "OBSERVATION_POLICY_BINDING_INVALID")


if __name__ == "__main__":
    unittest.main()
