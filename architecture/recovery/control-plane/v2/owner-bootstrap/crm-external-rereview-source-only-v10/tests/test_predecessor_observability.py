#!/usr/bin/python3
from __future__ import annotations

import hashlib
import importlib.machinery
import importlib.util
import json
import copy
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


OBSERVATION = load(
    "yoko_predecessor_observability_test",
    ROOT / "src/predecessor-observability-v1.py",
)
CORE = load("yoko_privileged_runtime_core_test", ROOT / "src/yoko-privileged-runtime-core.py")
CAPTURE = load(
    "yoko_predecessor_capture_test",
    ROOT / "packaging/capture-production-snapshot.py",
)


class FakeCore:
    RuntimeFault = CORE.RuntimeFault
    DOCKER = "/usr/bin/docker"

    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self._temporary_root = tempfile.TemporaryDirectory()
        root = Path(self._temporary_root.name)
        compose = root / OBSERVATION.COMPOSE_PATH.lstrip("/")
        environment = root / OBSERVATION.ENVIRONMENT_PATH.lstrip("/")
        compose.parent.mkdir(parents=True)
        compose.write_text("services: {}\n", encoding="ascii")
        environment.write_text("PLACEHOLDER=value\n", encoding="ascii")
        compose.chmod(0o644)
        environment.chmod(0o600)
        self.secret_values = {
            "SHARED_SECRET": "correct horse battery staple",
            "LOW_ENTROPY_PIN": "1234",
        }
        self.compose = {
            "name": "crm",
            "services": {
                "gravity-mvp": self._service("gravity-mvp", "rollback-gravity", [
                    "sh", "-c", "npx prisma migrate deploy && npm run start",
                ]),
                "tg-bot": self._service("tg-bot", "rollback-tg", ["node", "start.js"]),
                "postgres": {"image": "postgres:16"},
            },
        }
        self.objects = self._objects()

    def __del__(self) -> None:
        self._temporary_root.cleanup()

    @staticmethod
    def canonical(value: Any) -> bytes:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")

    @staticmethod
    def _service(name: str, image: str, command: list[str]) -> dict[str, Any]:
        entrypoint = ["/usr/bin/tini", "--"]
        if name == "tg-bot":
            entrypoint.append("/usr/local/bin/tg-bot-entrypoint")
        return {
            "image": image,
            "command": command,
            "entrypoint": entrypoint,
            "working_dir": "/app",
            "environment": {
                "SHARED_SECRET": "correct horse battery staple",
                "LOW_ENTROPY_PIN": "1234",
            },
            "init": False,
            "privileged": False,
            "read_only": False,
            "restart": "unless-stopped",
            "healthcheck": {
                "test": ["CMD-SHELL", "probe " + "correct horse battery staple"],
            },
            "deploy": {"labels": {"opaque": "1234"}},
            "networks": {"internal": {"aliases": [name]}},
            "volumes": ["crm_tg_bot_data:/app/data"] if name == "tg-bot" else [],
        }

    @staticmethod
    def _host() -> dict[str, Any]:
        return {
            "AutoRemove": False,
            "BlkioWeight": 0,
            "CgroupnsMode": "private",
            "CpuPeriod": 0,
            "CpuQuota": 0,
            "CpuRealtimePeriod": 0,
            "CpuRealtimeRuntime": 0,
            "CpuShares": 0,
            "Init": False,
            "IpcMode": "private",
            "Isolation": "",
            "Memory": 0,
            "MemoryReservation": 0,
            "MemorySwap": 0,
            "MemorySwappiness": None,
            "NanoCpus": 0,
            "NetworkMode": "crm_internal",
            "OomKillDisable": False,
            "OomScoreAdj": 0,
            "PidMode": "",
            "PidsLimit": None,
            "Privileged": False,
            "ReadonlyRootfs": False,
            "Runtime": "runc",
            "ShmSize": 67108864,
            "UTSMode": "",
            "UsernsMode": "",
            "CapAdd": None,
            "CapDrop": None,
            "SecurityOpt": None,
            "Devices": None,
            "DeviceRequests": None,
            "ExtraHosts": [],
            "Dns": [],
            "DnsOptions": [],
            "DnsSearch": [],
            "Ulimits": [],
            "RestartPolicy": {"Name": "unless-stopped", "MaximumRetryCount": 0},
            "Sysctls": None,
            "Tmpfs": None,
        }

    def _container(self, name: str, service: str, image: str, image_id: str, command: list[str]) -> dict[str, Any]:
        entrypoint = ["/usr/bin/tini", "--"]
        mounts: list[dict[str, Any]] = []
        if service == "tg-bot":
            entrypoint.append("/usr/local/bin/tg-bot-entrypoint")
            mounts.append({
                "Type": "volume", "Name": "crm_tg_bot_data", "Destination": "/app/data",
                "RW": True, "Propagation": "",
            })
        return {
            "Id": ("a" if service == "gravity-mvp" else "b") * 64,
            "Name": "/" + name,
            "Created": "2026-08-25T05:14:21.000000000Z",
            "Image": image_id,
            "Mounts": mounts,
            "Config": {
                "Image": image,
                "Hostname": ("a" if service == "gravity-mvp" else "b") * 12,
                "Env": [
                    "PATH=/usr/local/bin:/usr/bin:/bin",
                    "SHARED_SECRET=" + self.secret_values["SHARED_SECRET"],
                    "LOW_ENTROPY_PIN=" + self.secret_values["LOW_ENTROPY_PIN"],
                    "HOSTNAME=" + (("a" if service == "gravity-mvp" else "b") * 12),
                ],
                "Entrypoint": entrypoint,
                "Cmd": command,
                "WorkingDir": "/app",
                "User": "app" if service == "gravity-mvp" else "",
                "Labels": {
                    "com.docker.compose.project": "crm",
                    "com.docker.compose.service": service,
                    "com.docker.compose.config-hash": ("c" if service == "gravity-mvp" else "d") * 64,
                    "com.docker.compose.image": image_id,
                    "com.docker.compose.version": "5.1.4",
                },
                "Healthcheck": {
                    "Test": ["CMD", "node", "healthcheck.js"],
                    "Interval": 30000000000,
                    "Timeout": 10000000000,
                    "StartPeriod": 0,
                    "StartInterval": 0,
                    "Retries": 3,
                },
                "StopSignal": "SIGTERM",
                "StopTimeout": 10,
            },
            "HostConfig": self._host(),
            "NetworkSettings": {
                "Ports": {},
                "Networks": {
                    "crm_internal": {
                        "NetworkID": "e" * 64,
                        "EndpointID": ("f" if service == "gravity-mvp" else "1") * 64,
                        "Aliases": [name, service],
                        "DNSNames": [name, service],
                        "DriverOpts": None,
                        "MacAddress": "02:42:ac:12:00:02",
                        "Gateway": "172.18.0.1",
                        "IPAddress": "172.18.0.2",
                        "IPPrefixLen": 16,
                        "IPv6Gateway": "",
                        "GlobalIPv6Address": "",
                        "GlobalIPv6PrefixLen": 0,
                    },
                },
            },
        }

    def _objects(self) -> dict[tuple[str, str], dict[str, Any]]:
        gravity_id = "sha256:" + "2" * 64
        telegram_id = "sha256:" + "3" * 64
        return {
            ("container", "crm-gravity-mvp"): self._container(
                "crm-gravity-mvp", "gravity-mvp", "rollback-gravity", gravity_id,
                ["sh", "-c", "npx prisma migrate deploy && npm run start"],
            ),
            ("container", "crm-tg-bot"): self._container(
                "crm-tg-bot", "tg-bot", "rollback-tg", telegram_id, ["node", "start.js"],
            ),
            ("image", gravity_id): {
                "Id": gravity_id, "Created": "2026-08-12T19:10:54Z", "Os": "linux",
                "Architecture": "amd64", "RepoDigests": ["gravity@" + gravity_id],
                "Config": {"Env": ["PATH=/usr/local/bin:/usr/bin:/bin"]},
            },
            ("image", telegram_id): {
                "Id": telegram_id, "Created": "2026-08-05T09:47:47Z", "Os": "linux",
                "Architecture": "amd64", "RepoDigests": ["telegram@" + telegram_id],
                "Config": {"Env": ["PATH=/usr/local/bin:/usr/bin:/bin"]},
            },
            ("volume", "crm_tg_bot_data"): {
                "Name": "crm_tg_bot_data", "Driver": "local", "Options": None,
                "Scope": "local", "Labels": {
                    "com.docker.compose.project": "crm",
                    "com.docker.compose.volume": "tg_bot_data",
                },
            },
            ("network", "crm_internal"): {
                "Id": "e" * 64, "Name": "crm_internal", "Driver": "bridge",
                "Scope": "local", "Internal": True, "Attachable": False,
                "Ingress": False, "EnableIPv6": False,
                "IPAM": {
                    "Driver": "default", "Options": None,
                    "Config": [{"Subnet": "172.18.0.0/16", "Gateway": "172.18.0.1"}],
                },
                "Options": {"com.docker.network.bridge.enable_icc": "true"},
                "Labels": {
                    "com.docker.compose.project": "crm",
                    "com.docker.compose.network": "internal",
                },
            },
        }

    def mapped(self, path: str) -> Path:
        return Path(self._temporary_root.name) / path.lstrip("/")

    def assert_noncaller_writable_chain(self, path: Path) -> None:
        self.calls.append(["assert-noncaller-writable-chain", str(path)])

    @staticmethod
    def expected_owner() -> tuple[int, int]:
        return os.getuid(), os.getgid()

    def hash_file(self, path: Path, *, maximum: int) -> str:
        self.calls.append(["hash-file", str(path), str(maximum)])
        return "4" * 64

    def run_fixed(self, args: list[str], *, timeout: int) -> Any:
        self.calls.append(list(args))
        if args[-2] == "--hash":
            service = args[-1]
            value = ("c" if service == "gravity-mvp" else "d") * 64
            return SimpleNamespace(returncode=0, stdout=f"{service} {value}\n".encode("ascii"), stderr=b"")
        return SimpleNamespace(returncode=0, stdout=self.canonical(self.compose), stderr=b"")

    def parse_json(self, raw: bytes, *, maximum: int) -> Any:
        return json.loads(raw)

    def docker_json(self, args: list[str], policy: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(["/usr/bin/docker", *args])
        if len(args) != 3 or args[1] != "inspect":
            raise AssertionError(f"non-inspection Docker call: {args}")
        return self.objects[(args[0], args[2])]

    @staticmethod
    def semantic_published_ports(value: Any) -> dict[str, Any]:
        return {} if value in (None, {}) else value


POLICY = {
    "limits": {"command_timeout_seconds": 20},
    "resources": {
        "crm.container.gravity_mvp": {
            "kind": "container", "name": "crm-gravity-mvp", "operations": ["docker-inspect"],
        },
        "crm.container.telegram_bot": {
            "kind": "container", "name": "crm-tg-bot", "operations": ["docker-inspect"],
        },
    },
}


class PredecessorObservationTests(unittest.TestCase):
    def test_exact_read_only_secret_safe_projection(self) -> None:
        core = FakeCore()
        first = OBSERVATION.observe(core, POLICY)
        second = OBSERVATION.observe(FakeCore(), POLICY)
        self.assertEqual(first, second)
        self.assertEqual(first["schema"], "yoko.crm.predecessor-recreation-observation.v1")
        self.assertFalse(first["production_mutated"])
        self.assertFalse(first["secret_values_emitted"])
        self.assertRegex(first["release_critical_identity_sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual([service["compose_service"] for service in first["services"]], ["gravity-mvp", "tg-bot"])
        telegram = first["services"][1]
        self.assertEqual(telegram["mounts"], [{
            "type": "volume", "target": "/app/data", "read_write": True,
            "propagation": "", "name": "crm_tg_bot_data",
        }])
        self.assertTrue(telegram["environment"]["effective_values_match_resolved_compose_and_image"])
        self.assertTrue(telegram["compose"]["base_matches_container_creation"])
        self.assertEqual(
            telegram["compose"]["secret_free_resolved_service_shape"]["environment_keys"],
            ["LOW_ENTROPY_PIN", "SHARED_SECRET"],
        )
        self.assertNotIn("secret_free_resolved_service_sha256", telegram["compose"])
        self.assertFalse(telegram["lifecycle"]["healthcheck"]["test_plaintext_emitted"])
        serialized = json.dumps(first, sort_keys=True)
        for value in core.secret_values.values():
            self.assertNotIn(value, serialized)
            self.assertNotIn(hashlib.sha256(value.encode()).hexdigest(), serialized)
        docker_commands = [
            call for call in core.calls
            if call and call[0] == "/usr/bin/docker" and call[1] != "compose"
        ]
        self.assertTrue(docker_commands)
        for command in docker_commands:
            self.assertNotIn(command[1], {"start", "stop", "restart", "run", "create", "rm", "pull", "build", "tag", "compose"})
            self.assertEqual(command[2], "inspect")
        compose_calls = [call for call in core.calls if call[:2] == ["/usr/bin/docker", "compose"]]
        self.assertEqual(len(compose_calls), 3)
        self.assertEqual(compose_calls[0][-3:], ["config", "--format", "json"])
        self.assertEqual(
            [call[-3:] for call in compose_calls[1:]],
            [["config", "--hash", "gravity-mvp"], ["config", "--hash", "tg-bot"]],
        )
        for call in compose_calls:
            for forbidden in ("up", "down", "start", "stop", "restart", "create", "rm", "pull", "build", "tag"):
                self.assertNotIn(forbidden, call)
        fixed_paths = [
            call[1] for call in core.calls
            if call and call[0] == "assert-noncaller-writable-chain"
        ]
        self.assertEqual(fixed_paths, [
            str(core.mapped(OBSERVATION.COMPOSE_PATH)),
            str(core.mapped(OBSERVATION.ENVIRONMENT_PATH)),
        ])

    def test_capture_projection_excludes_recreated_container_dns_name(self) -> None:
        observed = OBSERVATION.observe(FakeCore(), POLICY)["services"][0]
        recreated = copy.deepcopy(observed)
        recreated["container"]["id"] = "9" * 64
        recreated["container"]["created"] = "2026-08-28T00:00:00Z"
        recreated["network_attachments"][0]["dns_names"] = ["9" * 12, "crm-gravity-mvp", "gravity-mvp"]
        self.assertEqual(
            CAPTURE.predecessor_release_critical_service(observed),
            CAPTURE.predecessor_release_critical_service(recreated),
        )
        self.assertNotEqual(
            CAPTURE.predecessor_release_critical_service(
                observed, include_ephemeral_dns_names=True,
            ),
            CAPTURE.predecessor_release_critical_service(
                recreated, include_ephemeral_dns_names=True,
            ),
        )
        recreated["network_attachments"][0]["aliases"] = ["different"]
        self.assertNotEqual(
            CAPTURE.predecessor_release_critical_service(observed),
            CAPTURE.predecessor_release_critical_service(recreated),
        )

    def test_fixed_production_files_require_exact_leaf_identity(self) -> None:
        core = FakeCore()
        environment = core.mapped(OBSERVATION.ENVIRONMENT_PATH)
        environment.chmod(0o644)
        with self.assertRaises(CORE.RuntimeFault) as captured:
            OBSERVATION.observe(core, POLICY)
        self.assertEqual(captured.exception.code, "PRODUCTION_CONFIGURATION_FILE_UNSAFE")

    def test_container_creation_overlay_hash_is_recorded_separately(self) -> None:
        core = FakeCore()
        original = core.run_fixed

        def drifted(args: list[str], *, timeout: int) -> Any:
            result = original(args, timeout=timeout)
            if args[-3:] == ["config", "--hash", "tg-bot"]:
                result.stdout = b"tg-bot " + (b"9" * 64) + b"\n"
            return result

        core.run_fixed = drifted  # type: ignore[method-assign]
        result = OBSERVATION.observe(core, POLICY)
        telegram = result["services"][1]
        self.assertEqual(telegram["compose"]["container_creation_config_hash"], "d" * 64)
        self.assertEqual(telegram["compose"]["base_resolved_config_hash"], "9" * 64)
        self.assertFalse(telegram["compose"]["base_matches_container_creation"])

    def test_mutable_volume_content_is_never_enumerated(self) -> None:
        core = FakeCore()
        result = OBSERVATION.observe(core, POLICY)
        self.assertEqual(result["state_partition"]["mutable_application_runtime_state"], "PRESERVED_NOT_CONTENT_HASHED")
        calls = json.dumps(core.calls)
        self.assertNotIn("/app/data/", calls)
        self.assertNotIn("exec", calls)
        self.assertNotIn("volume ls", calls)

    def test_environment_value_drift_fails_without_value_details(self) -> None:
        core = FakeCore()
        raw = core.objects[("container", "crm-tg-bot")]
        raw["Config"]["Env"] = [
            item.replace("LOW_ENTROPY_PIN=1234", "LOW_ENTROPY_PIN=9999")
            for item in raw["Config"]["Env"]
        ]
        with self.assertRaises(CORE.RuntimeFault) as captured:
            OBSERVATION.observe(core, POLICY)
        self.assertEqual(captured.exception.code, "EFFECTIVE_ENVIRONMENT_VALUE_DRIFT")
        self.assertNotIn("9999", json.dumps(captured.exception.details))

    def test_arbitrary_bind_source_is_rejected(self) -> None:
        core = FakeCore()
        core.objects[("container", "crm-gravity-mvp")]["Mounts"] = [{
            "Type": "bind", "Source": "/etc", "Destination": "/host", "RW": False,
            "Propagation": "rprivate",
        }]
        with self.assertRaises(CORE.RuntimeFault) as captured:
            OBSERVATION.observe(core, POLICY)
        self.assertEqual(captured.exception.code, "BIND_SOURCE_OUTSIDE_PROJECT")

    def test_unknown_policy_resource_is_rejected(self) -> None:
        core = FakeCore()
        policy = json.loads(json.dumps(POLICY))
        policy["resources"]["crm.container.telegram_bot"]["name"] = "attacker-container"
        with self.assertRaises(CORE.RuntimeFault) as captured:
            OBSERVATION.observe(core, policy)
        self.assertEqual(captured.exception.code, "OBSERVATION_POLICY_BINDING_INVALID")

    def test_cli_shape_is_zero_argument_only(self) -> None:
        invocation = CORE.parse_cli(["runtime", "predecessor-observe"])
        self.assertEqual(invocation.primitive, "predecessor-observe")
        self.assertIsNone(invocation.resource)
        for argv in (
            ["runtime", "predecessor-observe", "crm.container.telegram_bot"],
            ["runtime", "predecessor-observe", "/etc"],
            ["runtime", "predecessor-observe", "docker", "start"],
        ):
            with self.assertRaises(CORE.RuntimeFault) as captured:
                CORE.parse_cli(argv)
            self.assertEqual(captured.exception.code, "INPUT_INVALID")

    def test_capture_accepts_only_digest_consistent_secret_safe_observation(self) -> None:
        evidence = copy.deepcopy(OBSERVATION.observe(FakeCore(), POLICY))
        evidence["compose_source"]["compose_file_sha256"] = CAPTURE.COMPOSE_SHA
        for service, image, compose_hash in zip(
            evidence["services"],
            (CAPTURE.PREDECESSOR_IMAGE, CAPTURE.TG_BOT_IMAGE),
            (CAPTURE.GRAVITY_COMPOSE, CAPTURE.TG_COMPOSE),
        ):
            service["image"]["id"] = image
            service["compose"]["container_creation_config_hash"] = compose_hash
            service["compose"]["labels"]["com.docker.compose.config-hash"] = compose_hash
        evidence["release_critical_identity_sha256"] = CAPTURE.compact_digest({
            "schema": evidence["schema"],
            "compose_source": evidence["compose_source"],
            "services": [CAPTURE.predecessor_release_critical_service(service) for service in evidence["services"]],
            "volumes": evidence["volumes"],
            "networks": evidence["networks"],
        })
        self.assertIs(CAPTURE.validate_predecessor_evidence(evidence), evidence)
        evidence["release_critical_identity_sha256"] = CAPTURE.compact_digest({
            "schema": evidence["schema"],
            "compose_source": evidence["compose_source"],
            "services": [
                CAPTURE.predecessor_release_critical_service(
                    service, include_ephemeral_dns_names=True,
                )
                for service in evidence["services"]
            ],
            "volumes": evidence["volumes"],
            "networks": evidence["networks"],
        })
        self.assertIs(CAPTURE.validate_predecessor_evidence(evidence), evidence)
        evidence["services"][1]["mounts"][0]["read_write"] = False
        with self.assertRaises(CAPTURE.CaptureError):
            CAPTURE.validate_predecessor_evidence(evidence)


if __name__ == "__main__":
    unittest.main()
