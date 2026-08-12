#!/usr/bin/python3
from __future__ import annotations

import hashlib
import fcntl
import importlib.machinery
import importlib.util
import io
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEB = ROOT / "dist/yoko-privileged-runtime_2.0.0-8_all.deb"
PROFILE_ID = "crm-af9646f5-gravity-outbox-v1"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def valid_rolled_back_recovery_state(profile_runtime, profile: dict[str, object]) -> dict[str, object]:
    recovery = profile["recovery"]
    production = profile["production"]
    return {
        "schema": profile_runtime.STATE_SCHEMA,
        "profile_id": PROFILE_ID,
        "phase": "ROLLED_BACK",
        "accepted_commit": recovery["prior_source_commit"],
        "accepted_archive_sha256": recovery["prior_source_archive_sha256"],
        "target_tag": recovery["prior_target_tag"],
        "target_image_id": recovery["prior_target_image_id"],
        "rollback_tag": profile_runtime.ROLLBACK_TAG,
        "rollback_image_id": production["gravity_image_id"],
        "database_identity_sha256": recovery["database_identity_sha256"],
        "migration_ledger_sha256": recovery["migration_ledger_sha256"],
        "backup_sha256": recovery["backup_sha256"],
        "backup_bytes": recovery["backup_bytes"],
        "restore_verified": True,
        "preview_proof": {
            "migration_ledger_sha256": recovery["migration_ledger_sha256"],
            "outbox_catalog_sha256": recovery["preview_outbox_catalog_sha256"],
        },
        "rollback_image_schema_compatible": True,
        "migration_completed_at": "2026-08-12T17:35:00Z",
        "rollback_completed_at": "2026-08-12T18:00:00Z",
        "activation_failure": True,
        "production_identity": {"gravity_semantic": {"command": ["sh", "-c", "npx prisma migrate deploy && npm run start"]}},
    }


def rollback_semantic(profile: dict[str, object], compose_config_hash: str) -> dict[str, object]:
    production = profile["production"]
    return {
        "command": ["sh", "-c", "npx prisma migrate deploy && npm run start"],
        "compose_labels": {
            "com.docker.compose.config-hash": compose_config_hash,
            "com.docker.compose.project": production["compose_project"],
            "com.docker.compose.service": production["compose_service"],
        },
        "entrypoint": ["/usr/bin/tini", "--"],
        "environment_names": ["DATABASE_URL", "NODE_ENV", "REDIS_URL"],
        "image_id": production["gravity_image_id"],
        "mounts": [{
            "destination": "/app/storage",
            "read_only": False,
            "source_sha256": "1" * 64,
            "type": "bind",
        }],
        "name": production["gravity_container"],
        "network_mode": production["network"],
        "network_names": [production["network"]],
        "privileged": False,
        "published_ports": {
            "3002/tcp": [{"host_ip": "127.0.0.1", "host_port": "3002"}],
        },
        "read_only_rootfs": False,
        "restart_policy": {"maximum_retry_count": 0, "name": "unless-stopped"},
    }


def load(name: str, path: Path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    loader.exec_module(module)
    return module


class PackageFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory(prefix="yoko-activation-package-")
        cls.root = Path(cls.temp.name)
        subprocess.run(["/usr/bin/dpkg-deb", "-x", str(DEB), str(cls.root)], check=True)
        for path in ("usr/sbin", "var", "var/lib"):
            target = cls.root / path
            target.mkdir(parents=True, exist_ok=True)
            os.chmod(target, 0o755)
        subprocess.run(["/usr/bin/install", "-m", "0755", "/bin/true", str(cls.root / "usr/sbin/visudo")], check=True)
        cls.wrapper = cls.root / "usr/local/sbin/yoko-privileged-runtime"
        cls.core_path = cls.root / "usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py"
        cls.profile_runtime_path = cls.root / f"usr/local/libexec/yoko-privileged-runtime/{PROFILE_ID}.py"
        cls.profile_path = cls.root / f"usr/local/share/yoko-privileged-runtime/profiles/{PROFILE_ID}/profile.v1.json"
        cls.core = load("yoko_test_core", cls.core_path)
        cls.profile_runtime = load("yoko_test_activation_profile", cls.profile_runtime_path)
        cls.core._test_root = cls.root
        cls.profile = json.loads(cls.profile_path.read_text(encoding="ascii"))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.core._test_root = None
        cls.temp.cleanup()

    def run_wrapper(self, *args: str) -> subprocess.CompletedProcess[bytes]:
        environment = dict(os.environ)
        environment["YOKO_PRIVILEGED_RUNTIME_TEST_ROOT"] = str(self.root)
        return subprocess.run(["/usr/bin/python3", "-I", str(self.wrapper), *args], env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)


class PositiveTests(PackageFixture):
    def test_debian_inventory_is_exact_and_root_modes_are_narrow(self) -> None:
        expected = {
            "./etc/sudoers.d/92-yoko-privileged-runtime": 0o440,
            "./usr/local/sbin/yoko-privileged-runtime": 0o755,
            "./usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py": 0o444,
            f"./usr/local/libexec/yoko-privileged-runtime/{PROFILE_ID}.py": 0o444,
            "./usr/local/share/yoko-privileged-runtime/install-manifest.v1.json": 0o444,
            "./usr/local/share/yoko-privileged-runtime/policy.v2.json": 0o444,
            f"./usr/local/share/yoko-privileged-runtime/profiles/{PROFILE_ID}/manifest.v1.json": 0o444,
            f"./usr/local/share/yoko-privileged-runtime/profiles/{PROFILE_ID}/migration.sql": 0o444,
            f"./usr/local/share/yoko-privileged-runtime/profiles/{PROFILE_ID}/profile.v1.json": 0o444,
            f"./usr/local/share/yoko-privileged-runtime/profiles/{PROFILE_ID}/source.tar.gz": 0o444,
        }
        data = subprocess.check_output(["/usr/bin/dpkg-deb", "--fsys-tarfile", str(DEB)])
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
            observed = {member.name: stat.S_IMODE(member.mode) for member in archive.getmembers() if member.isfile()}
            ownership = {(member.uid, member.gid) for member in archive.getmembers() if member.isfile()}
        self.assertEqual(observed, expected)
        self.assertEqual(ownership, {(0, 0)})

    def test_self_check_binds_every_activation_artifact(self) -> None:
        completed = self.run_wrapper("self-check")
        self.assertEqual(completed.returncode, 0, completed.stderr.decode())
        value = json.loads(completed.stdout)
        evidence = value["evidence"]
        self.assertTrue(value["ok"])
        self.assertEqual(evidence["package_version"], "2.0.0-8")
        self.assertEqual(evidence["activation_profile_id"], PROFILE_ID)
        self.assertEqual(len(evidence["activation_profile_identity"]), 5)
        self.assertFalse(evidence["generic_command_execution"])
        self.assertFalse(evidence["arbitrary_paths"])
        self.assertFalse(evidence["docker_socket_delegated"])

    def test_capabilities_enable_only_five_reserved_zero_argument_profiles(self) -> None:
        completed = self.run_wrapper("capabilities")
        self.assertEqual(completed.returncode, 0)
        evidence = json.loads(completed.stdout)["evidence"]
        self.assertEqual(evidence["enabled_activation_profiles"], ["database-status", "release-preflight", "database-migrate", "release-activate", "rollback"])
        self.assertEqual(set(evidence["disabled_profiles"]), {"config-activation"})
        self.assertFalse(evidence["arbitrary_package_install"])
        self.assertTrue(all("service-restart" not in record["operations"] for record in evidence["resources"].values()))

    def test_source_archive_inventory_and_commit_are_exact(self) -> None:
        value = self.profile_runtime._archive_inventory(self.core, self.profile)
        self.assertEqual(value["entries"], 3904)
        self.assertEqual(value["regular_files"], 3266)
        self.assertEqual(value["directories"], 638)
        self.assertEqual(sha(self.root / f"usr/local/share/yoko-privileged-runtime/profiles/{PROFILE_ID}/source.tar.gz"), "be616b7d528bc111717d237bcd745a8b106302897e702be4b8af1b8643cba26d")

    def test_migration_reconciliation_has_one_permitted_pending_delta(self) -> None:
        before = self.profile_runtime._expected_production_ledger(self.core, self.profile, migrated=False)
        after = self.profile_runtime._expected_production_ledger(self.core, self.profile, migrated=True)
        self.assertEqual(set(after) - set(before), {"20260809140000_add_domain_outbox"})
        self.assertEqual(after["20260809140000_add_domain_outbox"], "433b0d503f054ed6a8161a059e2650d5e401829dabe8c9d992a1d1763eef0016")
        self.assertEqual(len(after), len(before) + 1)

    def test_live_production_ledger_is_bound_by_exact_normalized_digest(self) -> None:
        accepted = self.profile["migration"]["accepted_production_ledger"]
        self.assertEqual(accepted, {
            "active_migration_count": 61,
            "normalized_observation_sha256": "f8e57fd9fe0166ac964c928c29eb0e87820797508959dae0ba11fd75d5907201",
            "target_state_at_capture": "ABSENT",
            "database_identity_sha256": "ed88dfeaad2a3dc2e759590d295992cd06531d4403d896ded00b21ea667be1c9",
        })

    def test_normalized_ledger_binding_allows_only_the_fixed_target_delta(self) -> None:
        profile = json.loads(json.dumps(self.profile))
        baseline = {
            "active": {"historical_a": "a" * 64, "historical_b": "b" * 64},
            "interrupted_target": 0,
            "rolled_back_target": 0,
        }
        accepted = profile["migration"]["accepted_production_ledger"]
        accepted["active_migration_count"] = 2
        accepted["normalized_observation_sha256"] = self.profile_runtime._digest(baseline)

        before = self.profile_runtime._accepted_production_ledger_shape(baseline, profile)
        self.assertEqual(before, {"baseline_exact": True, "target_absent": True, "target_active": False})

        target = profile["migration"]["name"]
        after = json.loads(json.dumps(baseline))
        after["active"][target] = profile["migration"]["sha256"]
        self.assertEqual(
            self.profile_runtime._accepted_production_ledger_shape(after, profile),
            {"baseline_exact": True, "target_absent": False, "target_active": True},
        )

        interrupted = json.loads(json.dumps(baseline))
        interrupted["interrupted_target"] = 1
        self.assertTrue(self.profile_runtime._accepted_production_ledger_shape(interrupted, profile)["baseline_exact"])

        unrelated = json.loads(json.dumps(baseline))
        unrelated["active"]["unrelated"] = "c" * 64
        self.assertFalse(self.profile_runtime._accepted_production_ledger_shape(unrelated, profile)["baseline_exact"])

        wrong_target = json.loads(json.dumps(baseline))
        wrong_target["active"][target] = "d" * 64
        shape = self.profile_runtime._accepted_production_ledger_shape(wrong_target, profile)
        self.assertTrue(shape["baseline_exact"])
        self.assertFalse(shape["target_absent"])
        self.assertFalse(shape["target_active"])

    def test_review_manifest_is_complete_and_matches_every_package_file(self) -> None:
        manifest = json.loads((ROOT / "bundle/payload/review/package-manifest.json").read_text(encoding="ascii"))
        self.assertEqual(manifest["schema"], "yoko.crm.owner-bootstrap-review-manifest.v2")
        records = manifest["installed_artifacts"]
        self.assertEqual(len(records), 10)
        self.assertEqual(len({record["destination_path"] for record in records}), 10)
        self.assertTrue(all(set(record) == {"source_path", "package_member", "destination_path", "sha256", "bytes", "uid", "gid", "mode", "role", "previous_state_expectation"} for record in records))
        self.assertTrue(all(record["uid"] == 0 and record["gid"] == 0 for record in records))
        self.assertEqual(manifest["new_package"]["sha256"], sha(DEB))
        self.assertFalse(manifest["sudoers_widening"])

    def test_sealed_bundle_has_exact_root_owned_manifest_bound_file_set(self) -> None:
        bundle = ROOT / "dist/yoko-crm-activation-recovery-7aea2823-v3.tar"
        payload_manifest = json.loads((ROOT / "bundle/payload/payload-manifest.json").read_text(encoding="ascii"))
        with tarfile.open(bundle, "r:") as archive:
            members = archive.getmembers()
            self.assertTrue(all(member.uid == 0 and member.gid == 0 for member in members))
            self.assertTrue(all(member.isfile() or member.isdir() for member in members))
            files = {member.name: member for member in members if member.isfile()}
            expected = {"payload/payload-manifest.json", *("payload/" + name for name in payload_manifest["files"])}
            self.assertEqual(set(files), expected)
            for relative, record in payload_manifest["files"].items():
                member = files["payload/" + relative]
                source = archive.extractfile(member)
                self.assertIsNotNone(source)
                self.assertEqual(hashlib.sha256(source.read()).hexdigest(), record["sha256"])
                self.assertEqual(stat.S_IMODE(member.mode), int(record["mode"], 8))

    def test_predecessor_is_exact_and_owner_manifest_references_only_successor_tar(self) -> None:
        predecessor = ROOT / "inputs/yoko-privileged-runtime_2.0.0-7_all.deb"
        self.assertEqual(sha(predecessor), "ababe50bcb0d3597786b1c77118867b1d700a5629bb2719892ce5ae4927a4738")
        current = sha(ROOT / "dist/yoko-crm-activation-recovery-7aea2823-v3.tar")
        manifest = json.loads((ROOT / "manifest.json").read_text(encoding="ascii"))
        self.assertEqual(manifest["bootstrap"]["sha256"], current)
        self.assertEqual(manifest["expected_predecessor"]["package_version"], "2.0.0-7")
        self.assertEqual(manifest["expected_predecessor"]["rollback_deb_sha256"], sha(predecessor))

    def test_candidate_owner_command_is_checksum_pinned_and_syntax_valid(self) -> None:
        path = ROOT / "evidence/CANDIDATE_OWNER_COMMAND_FOR_CRITIC.txt"
        lines = path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines[0], "NOT AUTHORIZED FOR OWNER USE UNTIL EXACT-SHA CRITIC PASS")
        command = lines[1]
        tar_sha = sha(ROOT / "dist/yoko-crm-activation-recovery-7aea2823-v3.tar")
        self.assertIn(tar_sha, command)
        self.assertIn("sha256sum", command)
        self.assertIn("/root/yoko-crm-bootstrap", command)
        self.assertIn("YOKO_ACTIVATION_BOOTSTRAP_FAILED", command)
        for forbidden in ("latest", "curl", "wget", "git ", "docker", "psql", "systemctl"):
            self.assertNotIn(forbidden, command)
        completed = subprocess.run(["/bin/bash", "-n", "-c", command], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr.decode())


class NegativeTests(PackageFixture):
    def test_bootstrap_guard_blocks_every_activation_profile_but_not_validation(self) -> None:
        guard = self.root / "var/lib/yoko-privileged-runtime/activation-bootstrap-installing.v1"
        guard.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(guard.parent, 0o700)
        guard.write_bytes(b"")
        os.chmod(guard, 0o400)
        try:
            for verb in ("database-status", "release-preflight", "database-migrate", "release-activate", "rollback"):
                completed = self.run_wrapper(verb)
                self.assertEqual(completed.returncode, 77, (verb, completed.stderr.decode(), completed.stdout))
                self.assertEqual(json.loads(completed.stdout)["errors"][0]["code"], "ACTIVATION_BOOTSTRAP_IN_PROGRESS")
            self.assertEqual(self.run_wrapper("self-check").returncode, 0)
            self.assertEqual(self.run_wrapper("capabilities").returncode, 0)
        finally:
            guard.unlink(missing_ok=True)

    def test_every_profile_rejects_extra_path_command_service_or_environment_input(self) -> None:
        injections = ["/etc/shadow", "crm-postgres", "sh;-c;id", "DATABASE_URL=x", "../../../opt/crm"]
        for verb in ("database-status", "release-preflight", "database-migrate", "release-activate", "rollback"):
            for injection in injections:
                completed = self.run_wrapper(verb, injection)
                self.assertEqual(completed.returncode, 64, (verb, injection, completed.stdout))
                self.assertEqual(json.loads(completed.stdout)["errors"][0]["code"], "INPUT_INVALID")

    def test_config_activate_remains_disabled(self) -> None:
        completed = self.run_wrapper("config-activate")
        self.assertEqual(completed.returncode, 77)
        self.assertEqual(json.loads(completed.stdout)["errors"][0]["code"], "PROFILE_DISABLED")

    def test_compose_overlay_cannot_select_another_image(self) -> None:
        for value in ("image;id", "$(id)", "x\nservices:", "x y", "../unsafe"):
            with self.assertRaises(RuntimeError):
                self.profile_runtime._compose_overlay(value, activate=True)
        rendered = self.profile_runtime._compose_overlay(self.profile_runtime.TARGET_TAG, activate=True).decode()
        self.assertEqual(rendered.count("  gravity-mvp:\n"), 1)
        self.assertIn('command: ["npm", "run", "start"]', rendered)
        self.assertNotIn("migrate deploy", rendered)

    def test_persistent_runtime_has_no_shell_or_caller_selected_execution_surface(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        for forbidden in ("shell=True", "os.system(", "subprocess.Popen", "eval(", "exec(", "input(", "sys.stdin", "/bin/sh", "scripts/deploy.sh", "backup-pg.sh", "restore-pg.sh"):
            self.assertNotIn(forbidden, runtime)
        self.assertIn("shell=False", runtime)
        self.assertNotRegex(runtime, r"def dispatch\([^)]*argv")
        self.assertNotIn('"-e", f"DATABASE_URL=', runtime)
        self.assertNotIn('"-e", f"POSTGRES_PASSWORD=', runtime)
        self.assertIn('"--env-file", MIGRATION_ENV', runtime)
        self.assertIn('"--env-file", PREVIEW_POSTGRES_ENV', runtime)

    def test_preview_fixed_name_collision_is_not_deleted(self) -> None:
        original = self.profile_runtime._run
        calls: list[list[str]] = []
        try:
            def spoofed(core, args, **kwargs):
                calls.append(list(args))
                value = [{"Config": {"Labels": {"yoko.activation.profile": "unrelated"}}}]
                return subprocess.CompletedProcess(args, 0, json.dumps(value).encode(), b"")
            self.profile_runtime._run = spoofed
            with self.assertRaises(self.core.RuntimeFault) as raised:
                self.profile_runtime._cleanup_preview(self.core)
            self.assertEqual(raised.exception.code, "PREVIEW_CONTAINER_NAME_COLLISION")
            self.assertFalse(any(args[1:3] == ["rm", "-f"] for args in calls))
        finally:
            self.profile_runtime._run = original

    def test_fixed_runner_collision_is_not_killed_or_deleted(self) -> None:
        original = self.profile_runtime._run
        calls: list[list[str]] = []
        try:
            def spoofed(core, args, **kwargs):
                calls.append(list(args))
                value = [{"Config": {"Labels": {"yoko.activation.profile": PROFILE_ID, "yoko.activation.runner": "different"}}, "State": {"Running": True}}]
                return subprocess.CompletedProcess(args, 0, json.dumps(value).encode(), b"")
            self.profile_runtime._run = spoofed
            with self.assertRaises(self.core.RuntimeFault) as raised:
                self.profile_runtime._cleanup_runner(self.core, self.profile_runtime.PRODUCTION_MIGRATION_RUNNER)
            self.assertEqual(raised.exception.code, "MIGRATION_RUNNER_NAME_COLLISION")
            self.assertFalse(any(args[1] in {"kill", "rm"} for args in calls))
        finally:
            self.profile_runtime._run = original

    def test_fixed_runner_absence_is_exact_and_all_other_inspect_failures_fail_closed(self) -> None:
        original = self.profile_runtime._run
        runner = self.profile_runtime.PRODUCTION_MIGRATION_RUNNER
        calls: list[list[str]] = []
        try:
            def exact_absent(core, args, **kwargs):
                calls.append(list(args))
                error = f"Error response from daemon: No such container: {runner}\n".encode()
                return subprocess.CompletedProcess(args, 1, b"[]\n", error)
            self.profile_runtime._run = exact_absent
            self.profile_runtime._cleanup_runner(self.core, runner)
            self.assertEqual(len(calls), 1)

            for returncode, stdout, stderr in (
                (1, b"[]\n", b"Cannot connect to the Docker daemon\n"),
                (1, b"[]\n", b"permission denied while trying to connect to the Docker API\n"),
                (125, b"", b"docker command failed\n"),
                (1, b"not-empty\n", f"Error response from daemon: No such container: {runner}\n".encode()),
            ):
                calls.clear()
                def failed(core, args, returncode=returncode, stdout=stdout, stderr=stderr, **kwargs):
                    calls.append(list(args))
                    return subprocess.CompletedProcess(args, returncode, stdout, stderr)
                self.profile_runtime._run = failed
                with self.assertRaises(self.core.RuntimeFault) as raised:
                    self.profile_runtime._cleanup_runner(self.core, runner)
                self.assertEqual(raised.exception.code, "MIGRATION_RUNNER_INSPECT_FAILED")
                self.assertFalse(any(args[1] in {"kill", "rm"} for args in calls))
        finally:
            self.profile_runtime._run = original

    def test_optional_image_and_preview_cleanup_inspection_fail_closed(self) -> None:
        original = self.profile_runtime._run
        try:
            self.profile_runtime._run = lambda core, args, **kwargs: subprocess.CompletedProcess(
                args, 1, b"[]\n", b"Cannot connect to the Docker daemon\n"
            )
            with self.assertRaises(self.core.RuntimeFault) as image_failure:
                self.profile_runtime._image_inspect(self.core, self.profile_runtime.TARGET_TAG, required=False)
            self.assertEqual(image_failure.exception.code, "IMAGE_IDENTITY_UNAVAILABLE")
            with self.assertRaises(self.core.RuntimeFault) as preview_failure:
                self.profile_runtime._cleanup_preview(self.core)
            self.assertEqual(preview_failure.exception.code, "PREVIEW_CONTAINER_INSPECT_FAILED")
        finally:
            self.profile_runtime._run = original

    def test_production_database_url_is_bound_to_inspected_user_and_database(self) -> None:
        original = self.profile_runtime._container_environment
        identity = {"user": "crm owner", "database": "crm/main"}
        try:
            self.profile_runtime._container_environment = lambda core, container: {
                "DATABASE_URL": "postgresql://crm%20owner:secret@postgres:5432/crm%2Fmain"
            }
            self.assertEqual(
                self.profile_runtime._production_database_url(self.core, self.profile, identity),
                "postgresql://crm%20owner:secret@postgres:5432/crm%2Fmain",
            )
            for drifted in (
                "postgresql://other:secret@postgres:5432/crm%2Fmain",
                "postgresql://crm%20owner:secret@postgres:5432/other",
            ):
                self.profile_runtime._container_environment = lambda core, container, value=drifted: {"DATABASE_URL": value}
                with self.assertRaises(self.core.RuntimeFault) as raised:
                    self.profile_runtime._production_database_url(self.core, self.profile, identity)
                self.assertEqual(raised.exception.code, "PRODUCTION_DATABASE_URL_INVALID")
        finally:
            self.profile_runtime._container_environment = original

    def test_outbox_catalog_requires_full_exact_definition(self) -> None:
        expected = {
            "enum_labels": ["pending", "processing", "retry_wait", "published", "dead_letter"],
            "columns": [
                {"name": "id", "type": "text", "not_null": True, "default": ""},
                {"name": "eventId", "type": "text", "not_null": True, "default": ""},
                {"name": "eventType", "type": "text", "not_null": True, "default": ""},
                {"name": "eventVersion", "type": "integer", "not_null": True, "default": ""},
                {"name": "aggregateType", "type": "text", "not_null": True, "default": ""},
                {"name": "aggregateId", "type": "text", "not_null": True, "default": ""},
                {"name": "payload", "type": "jsonb", "not_null": True, "default": ""},
                {"name": "status", "type": "\"DomainOutboxStatus\"", "not_null": True, "default": "'pending'::\"DomainOutboxStatus\""},
                {"name": "attempts", "type": "integer", "not_null": True, "default": "0"},
                {"name": "maxAttempts", "type": "integer", "not_null": True, "default": "5"},
                {"name": "availableAt", "type": "timestamp(3) without time zone", "not_null": True, "default": "CURRENT_TIMESTAMP"},
                {"name": "claimedAt", "type": "timestamp(3) without time zone", "not_null": False, "default": ""},
                {"name": "publishedAt", "type": "timestamp(3) without time zone", "not_null": False, "default": ""},
                {"name": "lastError", "type": "character varying(1000)", "not_null": False, "default": ""},
                {"name": "correlationId", "type": "text", "not_null": False, "default": ""},
                {"name": "causationId", "type": "text", "not_null": False, "default": ""},
                {"name": "createdAt", "type": "timestamp(3) without time zone", "not_null": True, "default": "CURRENT_TIMESTAMP"},
                {"name": "updatedAt", "type": "timestamp(3) without time zone", "not_null": True, "default": ""},
            ],
            "constraints": [{"name": "domain_outbox_events_pkey", "definition": "PRIMARY KEY (id)"}],
            "indexes": [
                {"name": "domain_outbox_events_aggregateType_aggregateId_createdAt_idx", "definition": "CREATE INDEX \"domain_outbox_events_aggregateType_aggregateId_createdAt_idx\" ON public.domain_outbox_events USING btree (\"aggregateType\", \"aggregateId\", \"createdAt\")"},
                {"name": "domain_outbox_events_eventId_key", "definition": "CREATE UNIQUE INDEX \"domain_outbox_events_eventId_key\" ON public.domain_outbox_events USING btree (\"eventId\")"},
                {"name": "domain_outbox_events_pkey", "definition": "CREATE UNIQUE INDEX domain_outbox_events_pkey ON public.domain_outbox_events USING btree (id)"},
                {"name": "domain_outbox_events_status_availableAt_createdAt_idx", "definition": "CREATE INDEX \"domain_outbox_events_status_availableAt_createdAt_idx\" ON public.domain_outbox_events USING btree (status, \"availableAt\", \"createdAt\")"},
            ],
        }
        original = self.profile_runtime._psql
        try:
            self.profile_runtime._psql = lambda *args, **kwargs: json.dumps(expected, separators=(",", ":")).encode()
            self.assertEqual(self.profile_runtime._outbox_catalog(self.core, {})["state"], "EXACT")
            for key in ("enum_labels", "columns", "constraints", "indexes"):
                drifted = json.loads(json.dumps(expected))
                drifted[key] = drifted[key][:-1]
                self.profile_runtime._psql = lambda *args, value=drifted, **kwargs: json.dumps(value, separators=(",", ":")).encode()
                self.assertEqual(self.profile_runtime._outbox_catalog(self.core, {})["state"], "PARTIAL_OR_DRIFTED", key)
        finally:
            self.profile_runtime._psql = original

    def test_profile_package_disables_all_concurrent_service_restart_mutations(self) -> None:
        policy = self.core.load_policy()
        for logical, record in policy["resources"].items():
            if record["kind"] == "container":
                self.assertNotIn("service-restart", record["operations"], logical)
        with self.assertRaises(self.core.RuntimeFault) as raised:
            self.core.dispatch(policy, self.core.Invocation("service-restart", "crm.container.gravity_mvp"))
        self.assertEqual(raised.exception.code, "RESOURCE_OPERATION_DENIED")

    def test_interrupted_database_mutation_has_a_recoverable_state(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        persisted = runtime.index('"phase": "DATABASE_PRODUCTION_INTENT"')
        production = runtime.index('code="PRODUCTION_MIGRATION_FAILED"', persisted)
        self.assertLess(persisted, production)
        self.assertIn('state.get("phase") == "DATABASE_PRODUCTION_INTENT"', runtime)
        self.assertIn("PRODUCTION_MIGRATION_RUNNER", runtime)
        self.assertIn("MIGRATION_RUNNER_NAME_COLLISION", runtime)
        self.assertIn('"APPROVED_OUTBOX_INTERRUPTED"', runtime)
        self.assertIn("_repair_interrupted_outbox_migration", runtime)
        self.assertIn('"migrate", "resolve", "--rolled-back"', runtime)
        self.assertIn("PRODUCTION_RESOLVE_RUNNER", runtime)
        self.assertIn("DROP TABLE IF EXISTS public.domain_outbox_events; DROP TYPE IF EXISTS", runtime)
        self.assertNotIn("DROP TABLE IF EXISTS public.domain_outbox_events CASCADE", runtime)

    def test_database_recovery_quiesces_both_production_runners_before_first_status_read(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        branch = runtime.index('if state.get("phase") == "DATABASE_PRODUCTION_INTENT":')
        quiesce = runtime.index("_quiesce_production_runners(core, runner_identities)", branch)
        backup = runtime.index("_verify_recovery_backup(core, profile, state)", branch)
        status_read = runtime.index("status, recovery_identity = _database_status(core, profile)", branch)
        repair = runtime.index("_repair_interrupted_outbox_migration(", branch)
        retry = runtime.index("_start_prepared_production_runner(", branch)
        self.assertLess(quiesce, backup)
        self.assertLess(backup, status_read)
        self.assertLess(status_read, repair)
        self.assertLess(repair, retry)
        recovery = runtime[branch:runtime.index('if state.get("phase") != "PREFLIGHT_READY":', branch)]
        self.assertNotIn('[DOCKER, "create"', recovery)

    def test_production_runners_are_created_and_sealed_before_durable_intent(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        normal = runtime.index("production_runner_identities = _prepare_production_runners(")
        durable = runtime.index("_write_state(core, prepared_state)", normal)
        start = runtime.index("_start_prepared_production_runner(", durable)
        self.assertLess(normal, durable)
        self.assertLess(durable, start)
        prepare = runtime[runtime.index("def _prepare_production_runners"):runtime.index("def _quiesce_production_runners")]
        self.assertRegex(prepare, r'DOCKER,\s+"create",\s+"--name",\s+runner')
        self.assertNotIn('[DOCKER, "run"', prepare)

    def test_quiesce_reuses_identity_sealed_containers_without_create_window(self) -> None:
        original = self.profile_runtime._run
        calls: list[list[str]] = []
        try:
            def inspected(core, args, **kwargs):
                calls.append(list(args))
                runner = args[-1]
                raw = [{
                    "Id": "1" * 64,
                    "Created": "2026-08-12T00:00:00.000000000Z",
                    "Name": "/" + runner,
                    "Image": "sha256:" + "1" * 64,
                    "Config": {
                        "Image": "sha256:" + "1" * 64,
                        "Entrypoint": ["/app/node_modules/.bin/prisma"],
                        "Cmd": self.profile_runtime._production_runner_command(runner),
                        "Labels": {
                            "yoko.activation.profile": PROFILE_ID,
                            "yoko.activation.runner": runner,
                        },
                        "Env": ["DATABASE_URL=postgresql://fixed:secret@postgres:5432/fixed"],
                    },
                    "HostConfig": {
                        "NetworkMode": self.profile["production"]["network"],
                        "Privileged": False,
                        "Binds": None,
                        "CapAdd": None,
                        "Devices": [],
                        "PidMode": "",
                        "ReadonlyRootfs": False,
                        "SecurityOpt": None,
                    },
                    "State": {"Running": False, "ExitCode": 0},
                }]
                return subprocess.CompletedProcess(args, 0, json.dumps(raw).encode(), b"")
            self.profile_runtime._run = inspected
            identities = {
                runner: self.profile_runtime._production_runner_observation(self.core, runner)[1]
                for runner in (
                    self.profile_runtime.PRODUCTION_MIGRATION_RUNNER,
                    self.profile_runtime.PRODUCTION_RESOLVE_RUNNER,
                )
            }
            calls.clear()
            self.profile_runtime._quiesce_production_runners(self.core, identities)
            self.assertEqual(sum(args[1:3] == ["container", "inspect"] for args in calls), 4)
            self.assertFalse(any("create" in args or "run" in args for args in calls))
        finally:
            self.profile_runtime._run = original

    def test_database_recovery_rehashes_secure_backup_before_any_retry(self) -> None:
        self.profile_runtime._ensure_roots(self.core)
        target = self.core.mapped(self.profile_runtime.BACKUP_PATH)
        raw = b"a" * 2048
        target.write_bytes(raw)
        os.chmod(target, 0o400)
        state = {"backup_sha256": hashlib.sha256(raw).hexdigest(), "backup_bytes": len(raw)}
        try:
            verified = self.profile_runtime._verify_recovery_backup(self.core, self.profile, state)
            self.assertEqual(verified["status"], "REHASHED_AND_VERIFIED")
            os.chmod(target, 0o600)
            target.write_bytes(b"b" * len(raw))
            os.chmod(target, 0o400)
            with self.assertRaises(self.core.RuntimeFault) as drifted:
                self.profile_runtime._verify_recovery_backup(self.core, self.profile, state)
            self.assertEqual(drifted.exception.code, "DATABASE_RECOVERY_BACKUP_IDENTITY_DRIFT")
            target.unlink()
            with self.assertRaises(Exception):
                self.profile_runtime._verify_recovery_backup(self.core, self.profile, state)
        finally:
            target.unlink(missing_ok=True)

    def test_production_runner_seal_rejects_exact_config_object_replacement(self) -> None:
        original = self.profile_runtime._run
        runner = self.profile_runtime.PRODUCTION_MIGRATION_RUNNER
        object_id = "a" * 64
        try:
            def inspected(core, args, **kwargs):
                raw = [{
                    "Id": object_id,
                    "Created": "2026-08-12T00:00:00.000000000Z",
                    "Name": "/" + runner,
                    "Image": "sha256:" + "1" * 64,
                    "Config": {
                        "Image": "sha256:" + "1" * 64,
                        "Entrypoint": ["/app/node_modules/.bin/prisma"],
                        "Cmd": self.profile_runtime._production_runner_command(runner),
                        "Labels": {"yoko.activation.profile": PROFILE_ID, "yoko.activation.runner": runner},
                        "Env": ["DATABASE_URL=postgresql://fixed:secret@postgres:5432/fixed"],
                    },
                    "HostConfig": {
                        "NetworkMode": self.profile["production"]["network"], "Privileged": False,
                        "Binds": None, "CapAdd": None, "Devices": [], "PidMode": "",
                        "ReadonlyRootfs": False, "SecurityOpt": None,
                    },
                    "State": {"Running": False, "ExitCode": 0},
                }]
                return subprocess.CompletedProcess(args, 0, json.dumps(raw).encode(), b"")
            self.profile_runtime._run = inspected
            original_identity = self.profile_runtime._production_runner_observation(self.core, runner)[1]
            object_id = "b" * 64
            replacement_identity = self.profile_runtime._production_runner_observation(self.core, runner)[1]
            self.assertNotEqual(original_identity, replacement_identity)
            with self.assertRaises(self.core.RuntimeFault) as replaced:
                self.profile_runtime._quiesce_production_runners(
                    self.core,
                    {runner: original_identity, self.profile_runtime.PRODUCTION_RESOLVE_RUNNER: "c" * 64},
                )
            self.assertEqual(replaced.exception.code, "PRODUCTION_RUNNER_IDENTITY_DRIFT")
        finally:
            self.profile_runtime._run = original

    def test_terminal_audit_receipt_reconciles_exactly_once_after_crash_window(self) -> None:
        self.profile_runtime._ensure_roots(self.core)
        audit = self.core.mapped(self.core.AUDIT_LOG)
        audit.unlink(missing_ok=True)
        invocation = self.core.Invocation("database-migrate", None)
        pre = {"schema": self.profile_runtime.STATE_SCHEMA, "profile_id": PROFILE_ID, "phase": "DATABASE_PRODUCTION_INTENT"}
        post = {"schema": self.profile_runtime.STATE_SCHEMA, "profile_id": PROFILE_ID, "phase": "MIGRATED"}
        receipt = {
            "primitive": invocation.primitive,
            "resource": None,
            "request_digest": self.core.request_digest(invocation),
            "pre_state_digest": self.profile_runtime._digest(pre),
            "result": "ok",
            "post_state_digest": self.profile_runtime._digest(post),
        }
        terminal = {**post, "terminal_audit_receipt": receipt}
        self.profile_runtime._write_state(self.core, terminal)
        self.assertEqual(self.core.audit_status()["state"], "EMPTY")
        self.profile_runtime._reconcile_terminal_audit(self.core, terminal)
        first = self.core.audit_status()
        self.assertEqual(first["record_count"], 1)
        self.assertNotIn("terminal_audit_receipt", terminal)
        self.profile_runtime._reconcile_terminal_audit(self.core, terminal)
        second = self.core.audit_status()
        self.assertEqual(second, first)
        audit.unlink(missing_ok=True)

    def test_terminal_receipt_cannot_follow_state_into_a_later_phase(self) -> None:
        self.profile_runtime._ensure_roots(self.core)
        audit = self.core.mapped(self.core.AUDIT_LOG)
        audit.unlink(missing_ok=True)
        invocation = self.core.Invocation("release-preflight", None)
        pre = {"schema": self.profile_runtime.STATE_SCHEMA, "profile_id": PROFILE_ID, "phase": "UNINITIALIZED"}
        post = {"schema": self.profile_runtime.STATE_SCHEMA, "profile_id": PROFILE_ID, "phase": "PREFLIGHT_READY"}
        receipt = {
            "primitive": invocation.primitive,
            "resource": None,
            "request_digest": self.core.request_digest(invocation),
            "pre_state_digest": self.profile_runtime._digest(pre),
            "result": "ok",
            "post_state_digest": self.profile_runtime._digest(post),
        }
        drifted = {**post, "phase": "DATABASE_PRODUCTION_INTENT", "terminal_audit_receipt": receipt}
        try:
            self.profile_runtime._write_state(self.core, drifted)
            with self.assertRaises(self.core.RuntimeFault) as raised:
                self.profile_runtime._reconcile_terminal_audit(self.core, drifted)
            self.assertEqual(raised.exception.code, "TERMINAL_AUDIT_RECEIPT_STATE_DRIFT")
            self.assertEqual(self.core.audit_status()["state"], "EMPTY")
        finally:
            audit.unlink(missing_ok=True)

    def test_terminal_receipt_is_consumed_before_next_lifecycle_transition(self) -> None:
        self.profile_runtime._ensure_roots(self.core)
        audit = self.core.mapped(self.core.AUDIT_LOG)
        audit.unlink(missing_ok=True)
        uninitialized = {"schema": self.profile_runtime.STATE_SCHEMA, "profile_id": PROFILE_ID, "phase": "UNINITIALIZED"}
        preflight = {**uninitialized, "phase": "PREFLIGHT_READY"}
        migrated = {**preflight, "phase": "MIGRATED"}
        try:
            ready = self.profile_runtime._write_terminal_state(
                self.core, self.core.Invocation("release-preflight", None), uninitialized, "ok", preflight
            )
            self.assertNotIn("terminal_audit_receipt", ready)
            finished = self.profile_runtime._write_terminal_state(
                self.core, self.core.Invocation("database-migrate", None), ready, "ok", migrated
            )
            self.assertNotIn("terminal_audit_receipt", finished)
            self.assertEqual(finished["phase"], "MIGRATED")
            self.assertEqual(self.core.audit_status()["record_count"], 2)
        finally:
            audit.unlink(missing_ok=True)

    def test_spawned_fixed_child_inherits_transaction_lock_until_it_exits(self) -> None:
        lock_path = self.root / "orphan-child-transaction.lock"
        started_path = self.root / "orphan-child-started"
        child_code = f"import pathlib,time; pathlib.Path({str(started_path)!r}).write_text('started'); time.sleep(2)"
        helper = textwrap.dedent(f"""
            import fcntl, os, pathlib, subprocess, time
            target = pathlib.Path({str(lock_path)!r})
            fd = os.open(target, os.O_RDWR | os.O_CREAT, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
            subprocess.Popen([
                '/usr/bin/python3', '-c',
                {child_code!r},
            ], pass_fds=(fd,))
            time.sleep(30)
        """)
        parent = subprocess.Popen(["/usr/bin/python3", "-c", helper])
        try:
            deadline = time.monotonic() + 5
            while not started_path.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(started_path.exists())
            parent.kill()
            parent.wait(timeout=5)
            contender = os.open(lock_path, os.O_RDWR)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                time.sleep(2.2)
                fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(contender)
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait(timeout=5)
            started_path.unlink(missing_ok=True)
            lock_path.unlink(missing_ok=True)

    def test_profile_subprocesses_receive_only_the_active_transaction_lock_fd(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        self.assertIn("_transaction_lock_fd = fd", runtime)
        self.assertIn("pass_fds = () if _transaction_lock_fd is None else (_transaction_lock_fd,)", runtime)
        self.assertIn("pass_fds=pass_fds", runtime)

    def test_every_production_start_outcome_is_quiesced_before_database_status(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        repair = runtime.index("def _repair_interrupted_outbox_migration")
        resolve_start = runtime.index("_resolve_interrupted_target(", repair)
        resolve_quiesce = runtime.index("_quiesce_production_runners(core, runner_identities)", resolve_start)
        resolve_ledger = runtime.index("_migration_ledger_observation(core, identity, profile)", resolve_quiesce)
        self.assertLess(resolve_start, resolve_quiesce)
        self.assertLess(resolve_quiesce, resolve_ledger)
        database = runtime.index("def _database_migrate")
        for identities in ("runner_identities", "production_runner_identities"):
            start = runtime.index("_start_prepared_production_runner(", database)
            quiesce = runtime.index(f"_quiesce_production_runners(core, {identities})", start)
            status = runtime.index("_database_status(core, profile)", quiesce)
            self.assertLess(start, quiesce)
            self.assertLess(quiesce, status)
            database = status
        terminal = runtime.index('if state.get("phase") in {"MIGRATED", "ACTIVATED", "ROLLED_BACK"}:')
        terminal_quiesce = runtime.index("_quiesce_production_runners", terminal)
        terminal_status = runtime.index("_database_status(core, profile)", terminal_quiesce)
        self.assertLess(terminal_quiesce, terminal_status)

    def test_all_prepared_production_runner_call_sites_have_post_outcome_quiesce(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        definition = runtime.index("def _start_prepared_production_runner")
        next_definition = runtime.index("def _retire_production_runners", definition)
        call_sites: list[int] = []
        cursor = next_definition
        while True:
            cursor = runtime.find("_start_prepared_production_runner(", cursor)
            if cursor < 0:
                break
            call_sites.append(cursor)
            cursor += 1
        self.assertEqual(len(call_sites), 3)

    def test_public_database_status_holds_transaction_lock_and_quiesces_recorded_runners(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        start = runtime.index("def _database_status_profile")
        end = runtime.index("\ndef ", start + 5)
        body = runtime[start:end]
        self.assertIn("with _lock(core):", body)
        state = body.index("state = _read_state(core)")
        quiesce = body.index("_quiesce_production_runners(core, identities)")
        read = body.index("_database_status(core, profile)")
        self.assertIn("PRODUCTION_RUNNER_TERMINAL_CLEANUP_REQUIRED", body)
        self.assertLess(state, quiesce)
        self.assertLess(quiesce, read)
        dispatch = runtime.index('if invocation.primitive == "database-status":')
        self.assertIn("return _database_status_profile(core, profile)", runtime[dispatch:dispatch + 180])

    def test_terminal_runner_retirement_accepts_exact_absence(self) -> None:
        original_run = self.profile_runtime._run
        identities = {
            self.profile_runtime.PRODUCTION_MIGRATION_RUNNER: "a" * 64,
            self.profile_runtime.PRODUCTION_RESOLVE_RUNNER: "b" * 64,
        }
        state = {
            "schema": self.profile_runtime.STATE_SCHEMA,
            "profile_id": PROFILE_ID,
            "phase": "MIGRATED",
            "production_runner_identities": identities,
        }
        try:
            def absent(core, args, **kwargs):
                name = args[-1]
                error = f"Error response from daemon: No such container: {name}\n".encode()
                return subprocess.CompletedProcess(args, 1, b"[]\n", error)
            self.profile_runtime._run = absent
            self.profile_runtime._retire_production_runners(self.core, identities)
        finally:
            self.profile_runtime._run = original_run

    def test_terminal_runner_retirement_accepts_exact_partial_absence(self) -> None:
        original_run = self.profile_runtime._run
        migration = self.profile_runtime.PRODUCTION_MIGRATION_RUNNER
        resolve = self.profile_runtime.PRODUCTION_RESOLVE_RUNNER
        raw = [{
            "Id": "d" * 64,
            "Created": "2026-08-12T00:00:00Z",
            "Name": "/" + resolve,
            "Image": "sha256:" + "e" * 64,
            "Config": {
                "Image": "sha256:" + "e" * 64,
                "Entrypoint": ["/app/node_modules/.bin/prisma"],
                "Cmd": ["migrate", "resolve", "--rolled-back", self.profile["migration"]["name"]],
                "Labels": {"yoko.activation.profile": PROFILE_ID, "yoko.activation.runner": resolve},
                "Env": ["DATABASE_URL=postgresql://fixed@database/fixed"],
            },
            "HostConfig": {
                "NetworkMode": self.profile["production"]["network"],
                "Privileged": False,
                "Binds": None,
                "CapAdd": None,
                "Devices": None,
                "PidMode": "",
                "ReadonlyRootfs": False,
                "SecurityOpt": None,
            },
            "State": {"Running": False, "ExitCode": 0},
        }]
        calls: list[tuple[str, ...]] = []
        try:
            def observed(core, args, **kwargs):
                calls.append(tuple(args))
                if args[-1] == migration:
                    error = f"Error response from daemon: No such container: {migration}\n".encode()
                    return subprocess.CompletedProcess(args, 1, b"[]\n", error)
                if args[1:3] == ["container", "inspect"]:
                    return subprocess.CompletedProcess(args, 0, json.dumps(raw).encode(), b"")
                if args[1:3] == ["rm", resolve]:
                    return subprocess.CompletedProcess(args, 0, (resolve + "\n").encode(), b"")
                self.fail(f"unexpected docker call: {args!r}")
            self.profile_runtime._run = observed
            resolve_identity = self.profile_runtime._production_runner_observation(self.core, resolve)[1]
            calls.clear()
            self.profile_runtime._retire_production_runners(
                self.core, {migration: "a" * 64, resolve: resolve_identity}
            )
            self.assertFalse(any(call[1:3] == ("rm", migration) for call in calls))
            self.assertTrue(any(call[1:3] == ("rm", resolve) for call in calls))
        finally:
            self.profile_runtime._run = original_run

    def test_terminal_state_excludes_retired_runner_map_before_terminal_audit(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        database = runtime[runtime.index("def _database_migrate"):runtime.index("def _release_activate")]
        self.assertEqual(database.count('pop("production_runner_identities", None)'), 2)
        self.assertEqual(database.count('"phase": "DATABASE_RUNNER_RETIRE_INTENT"'), 3)
        self.assertEqual(database.count('"runner_retire_final_state": next_state'), 2)
        self.assertEqual(database.count('"runner_retire_intent", retire_intent'), 2)
        self.assertEqual(database.count('_write_terminal_state(core, invocation, retire_intent,'), 2)

    def test_partial_runner_retirement_recovers_from_durable_intent_before_terminal_state(self) -> None:
        names = (
            "_read_state", "_reconcile_terminal_audit", "_retire_production_runners",
            "_database_status", "_write_terminal_state",
        )
        originals = {name: getattr(self.profile_runtime, name) for name in names}
        identities = {
            self.profile_runtime.PRODUCTION_MIGRATION_RUNNER: "a" * 64,
            self.profile_runtime.PRODUCTION_RESOLVE_RUNNER: "b" * 64,
        }
        final_state = {
            "schema": self.profile_runtime.STATE_SCHEMA,
            "profile_id": PROFILE_ID,
            "phase": "MIGRATED",
            "migration_ledger_sha256": "c" * 64,
            "migration_completed_at": "2026-08-12T00:00:00Z",
            "database_identity_sha256": "d" * 64,
            "target_image_id": "sha256:" + "e" * 64,
        }
        retire_intent = {
            "schema": self.profile_runtime.STATE_SCHEMA,
            "profile_id": PROFILE_ID,
            "phase": "DATABASE_RUNNER_RETIRE_INTENT",
            "migration_ledger_sha256": "f" * 64,
            "database_identity_sha256": "d" * 64,
            "target_image_id": "sha256:" + "e" * 64,
            "production_runner_identities": identities,
            "runner_retire_final_state": final_state,
        }
        calls: list[object] = []
        status = {
            "migration_state": "APPROVED_OUTBOX_APPLIED",
            "migration_ledger_sha256": "c" * 64,
            "database_identity_sha256": "d" * 64,
        }
        try:
            self.profile_runtime._read_state = lambda core: dict(retire_intent)
            self.profile_runtime._reconcile_terminal_audit = lambda *args: calls.append("reconcile")
            self.profile_runtime._retire_production_runners = lambda core, sealed: calls.append(("retire", sealed))
            self.profile_runtime._database_status = lambda *args: (calls.append("status") or (status, {}))
            def terminal(core, invocation, pre, result, post):
                calls.append(("terminal", result, pre["phase"], post["phase"]))
                return dict(post)
            self.profile_runtime._write_terminal_state = terminal
            result = self.profile_runtime._database_migrate(
                self.core, self.profile, self.core.Invocation("database-migrate", None)
            )
            self.assertEqual(result["status"], "ALREADY_MIGRATED")
            self.assertEqual(calls, [
                "reconcile",
                ("retire", identities),
                "status",
                ("terminal", "runner_retire_recovered_ok", "DATABASE_RUNNER_RETIRE_INTENT", "MIGRATED"),
                "status",
            ])
        finally:
            for name, value in originals.items():
                setattr(self.profile_runtime, name, value)

    def test_runner_retire_intent_rejects_unsealed_final_state_drift(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        database = runtime.index("def _database_migrate")
        branch = runtime[runtime.index('if state.get("phase") == "DATABASE_RUNNER_RETIRE_INTENT":', database):]
        self.assertIn('"migration_ledger_sha256",', branch[:1800])
        self.assertIn('any(final_state.get(key) != value for key, value in retained.items())', branch[:2200])
        self.assertIn('set(final_state) != expected_final_keys', branch[:2200])

    def test_database_status_rejects_runner_retire_intent_without_db_read_or_cleanup(self) -> None:
        names = ("_read_state", "_reconcile_terminal_audit", "_database_status", "_quiesce_production_runners")
        originals = {name: getattr(self.profile_runtime, name) for name in names}
        identities = {
            self.profile_runtime.PRODUCTION_MIGRATION_RUNNER: "a" * 64,
            self.profile_runtime.PRODUCTION_RESOLVE_RUNNER: "b" * 64,
        }
        try:
            retire_state = {
                "schema": self.profile_runtime.STATE_SCHEMA,
                "profile_id": PROFILE_ID,
                "phase": "DATABASE_RUNNER_RETIRE_INTENT",
                "production_runner_identities": identities,
            }
            self.profile_runtime._read_state = lambda core: retire_state
            self.profile_runtime._reconcile_terminal_audit = lambda *args: None
            self.profile_runtime._database_status = lambda *args: self.fail("database read must stay blocked")
            self.profile_runtime._quiesce_production_runners = lambda *args: self.fail("status must not mutate runners")
            with self.assertRaises(self.core.RuntimeFault) as raised:
                self.profile_runtime._database_status_profile(self.core, self.profile)
            self.assertEqual(raised.exception.code, "PRODUCTION_RUNNER_TERMINAL_CLEANUP_REQUIRED")
            retire_state.pop("production_runner_identities")
            with self.assertRaises(self.core.RuntimeFault) as missing:
                self.profile_runtime._database_status_profile(self.core, self.profile)
            self.assertEqual(missing.exception.code, "PRODUCTION_RUNNER_TERMINAL_CLEANUP_REQUIRED")
        finally:
            for name, value in originals.items():
                setattr(self.profile_runtime, name, value)

    def test_terminal_crash_cleanup_is_audited_and_status_never_mutates(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        terminal = runtime.index('if state.get("phase") in {"MIGRATED", "ACTIVATED", "ROLLED_BACK"}:')
        cleanup_intent = runtime.index('"runner_cleanup_intent"', terminal)
        retire = runtime.index("_retire_production_runners", cleanup_intent)
        cleanup_terminal = runtime.index('"runner_cleanup_ok"', retire)
        status = runtime[runtime.index("def _database_status_profile"):runtime.index("def _secure_host_file")]
        self.assertLess(cleanup_intent, retire)
        self.assertLess(retire, cleanup_terminal)
        self.assertIn("_write_terminal_state", runtime[terminal:retire])
        self.assertNotIn("_retire_production_runners", status)
        self.assertIn("PRODUCTION_RUNNER_TERMINAL_CLEANUP_REQUIRED", status)

    def test_every_terminal_state_write_uses_reconcilable_receipt(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        for result in ("recovered_ok", "ok", "recovery_failed_rolled_back", "failed_rolled_back"):
            self.assertIn(f'_write_terminal_state(core, invocation,', runtime)
            self.assertIn(f'"{result}"', runtime)
        for phase in ('"phase": "MIGRATED"', '"phase": "ACTIVATED"', '"phase": "ROLLED_BACK"'):
            index = 0
            while True:
                index = runtime.find(phase, index)
                if index < 0:
                    break
                following = runtime[index:index + 1400]
                self.assertIn("_write_terminal_state", following, (phase, index))
                index += len(phase)

    def test_ledger_observation_accepts_only_one_exact_unfinished_target(self) -> None:
        original = self.profile_runtime._psql
        target = self.profile["migration"]["name"]
        checksum = self.profile["migration"]["sha256"]
        try:
            self.profile_runtime._psql = lambda *args, **kwargs: f"{target}\t{checksum}\t0\t1\n".encode()
            value = self.profile_runtime._migration_ledger_observation(self.core, {}, self.profile)
            self.assertEqual(value["active"], {})
            self.assertEqual(value["interrupted_target"], 1)
            self.assertEqual(value["rolled_back_target"], 0)
            for line in (
                f"different\t{checksum}\t0\t1\n",
                f"{target}\t{'0' * 64}\t0\t1\n",
                f"{target}\t{checksum}\t0\t1\n{target}\t{checksum}\t0\t1\n",
            ):
                self.profile_runtime._psql = lambda *args, value=line, **kwargs: value.encode()
                with self.assertRaises(self.core.RuntimeFault) as raised:
                    self.profile_runtime._migration_ledger_observation(self.core, {}, self.profile)
                self.assertEqual(raised.exception.code, "MIGRATION_LEDGER_INVALID")
        finally:
            self.profile_runtime._psql = original

    def test_interrupted_migration_repair_is_fixed_empty_cleanup_then_resolve(self) -> None:
        names = (
            "_migration_ledger_observation", "_outbox_catalog",
            "_psql", "_resolve_interrupted_target", "_quiesce_production_runners",
        )
        originals = {name: getattr(self.profile_runtime, name) for name in names}
        calls: list[object] = []
        expected = {"20260101000000_base": "a" * 64}
        observations = iter([
            {"active": expected, "interrupted_target": 1, "rolled_back_target": 0},
            {"active": expected, "interrupted_target": 0, "rolled_back_target": 1},
        ])
        catalogs = iter([
            {"state": "PARTIAL_OR_DRIFTED", "enum_labels": ["pending"], "columns": [], "constraints": [], "indexes": []},
            {"state": "ABSENT", "enum_labels": [], "columns": [], "constraints": [], "indexes": []},
        ])
        accepted = self.profile["migration"]["accepted_production_ledger"]
        accepted["active_migration_count"] = 1
        accepted["normalized_observation_sha256"] = self.profile_runtime._digest({
            "active": expected, "interrupted_target": 0, "rolled_back_target": 0,
        })
        try:
            self.profile_runtime._migration_ledger_observation = lambda *args: (calls.append("ledger") or next(observations))
            self.profile_runtime._outbox_catalog = lambda *args: (calls.append("catalog") or next(catalogs))
            self.profile_runtime._psql = lambda core, identity, sql, **kwargs: (calls.append(("sql", sql)) or b"")
            self.profile_runtime._resolve_interrupted_target = lambda *args: calls.append("resolve")
            self.profile_runtime._quiesce_production_runners = lambda *args: calls.append("quiesce")
            identities = {
                self.profile_runtime.PRODUCTION_MIGRATION_RUNNER: "b" * 64,
                self.profile_runtime.PRODUCTION_RESOLVE_RUNNER: "c" * 64,
            }
            value = self.profile_runtime._repair_interrupted_outbox_migration(self.core, self.profile, {}, identities)
            self.assertTrue(value["partial_objects_removed"])
            self.assertEqual(calls, [
                "ledger", "catalog",
                ("sql", 'DROP TABLE IF EXISTS public.domain_outbox_events; DROP TYPE IF EXISTS public."DomainOutboxStatus";'),
                "catalog", "resolve", "quiesce", "ledger",
            ])
        finally:
            for name, value in originals.items():
                setattr(self.profile_runtime, name, value)

    def test_interrupted_resolve_failure_quiesces_before_ledger_and_rethrows(self) -> None:
        names = (
            "_migration_ledger_observation", "_outbox_catalog",
            "_psql", "_resolve_interrupted_target", "_quiesce_production_runners",
        )
        originals = {name: getattr(self.profile_runtime, name) for name in names}
        calls: list[str] = []
        expected = {"20260101000000_base": "a" * 64}
        observations = iter([
            {"active": expected, "interrupted_target": 1, "rolled_back_target": 0},
            {"active": expected, "interrupted_target": 1, "rolled_back_target": 0},
        ])
        catalogs = iter([
            {"state": "PARTIAL_OR_DRIFTED", "enum_labels": ["pending"], "columns": [], "constraints": [], "indexes": []},
            {"state": "ABSENT", "enum_labels": [], "columns": [], "constraints": [], "indexes": []},
        ])
        accepted = self.profile["migration"]["accepted_production_ledger"]
        accepted["active_migration_count"] = 1
        accepted["normalized_observation_sha256"] = self.profile_runtime._digest({
            "active": expected, "interrupted_target": 0, "rolled_back_target": 0,
        })
        fault = self.core.RuntimeFault("PRODUCTION_MIGRATION_RESOLVE_FAILED", 74)
        try:
            self.profile_runtime._migration_ledger_observation = lambda *args: (calls.append("ledger") or next(observations))
            self.profile_runtime._outbox_catalog = lambda *args: (calls.append("catalog") or next(catalogs))
            self.profile_runtime._psql = lambda *args, **kwargs: (calls.append("sql") or b"")
            def failed_resolve(*args):
                calls.append("resolve_failed")
                raise fault
            self.profile_runtime._resolve_interrupted_target = failed_resolve
            self.profile_runtime._quiesce_production_runners = lambda *args: calls.append("quiesce")
            identities = {
                self.profile_runtime.PRODUCTION_MIGRATION_RUNNER: "b" * 64,
                self.profile_runtime.PRODUCTION_RESOLVE_RUNNER: "c" * 64,
            }
            with self.assertRaises(self.core.RuntimeFault) as raised:
                self.profile_runtime._repair_interrupted_outbox_migration(self.core, self.profile, {}, identities)
            self.assertIs(raised.exception, fault)
            self.assertLess(calls.index("resolve_failed"), calls.index("quiesce"))
            self.assertLess(calls.index("quiesce"), len(calls) - 1 - calls[::-1].index("ledger"))
        finally:
            for name, value in originals.items():
                setattr(self.profile_runtime, name, value)

    def test_database_status_exposes_exact_interrupted_target_without_false_drift(self) -> None:
        names = ("_postgres_identity", "_migration_ledger_observation", "_outbox_catalog")
        originals = {name: getattr(self.profile_runtime, name) for name in names}
        before = {"20260101000000_base": "a" * 64}
        identity = {
            "database_identity_sha256": "b" * 64,
            "database_name_sha256": "c" * 64,
            "database_user_sha256": "d" * 64,
            "system_identifier_sha256": "e" * 64,
            "server_version_num": "160000",
            "container_id": "f" * 64,
            "image_id": "sha256:" + "1" * 64,
        }
        accepted = self.profile["migration"]["accepted_production_ledger"]
        accepted["active_migration_count"] = 1
        accepted["normalized_observation_sha256"] = self.profile_runtime._digest({
            "active": before, "interrupted_target": 0, "rolled_back_target": 0,
        })
        accepted["database_identity_sha256"] = identity["database_identity_sha256"]
        try:
            self.profile_runtime._postgres_identity = lambda *args: identity
            self.profile_runtime._migration_ledger_observation = lambda *args: {"active": before, "interrupted_target": 1, "rolled_back_target": 0}
            self.profile_runtime._outbox_catalog = lambda *args: {"state": "PARTIAL_OR_DRIFTED", "enum_labels": ["pending"], "columns": [], "constraints": [], "indexes": []}
            status, observed = self.profile_runtime._database_status(self.core, self.profile)
            self.assertIs(observed, identity)
            self.assertEqual(status["migration_state"], "APPROVED_OUTBOX_INTERRUPTED")
            self.assertEqual(status["interrupted_target_migrations"], 1)
            self.assertIsNone(status["outbox_counts"])
        finally:
            for name, value in originals.items():
                setattr(self.profile_runtime, name, value)

    def test_interrupted_activation_has_recovery_and_rollback_phases(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        persist = runtime.index("_write_state(core, intent)")
        compose = runtime.index("_compose_up(core, profile, state, ACTIVATE_OVERLAY)", persist)
        self.assertLess(persist, compose)
        self.assertIn('state.get("phase") == "RELEASE_ACTIVATION_INTENT"', runtime)
        self.assertIn('{"ACTIVATED", "RELEASE_ACTIVATION_INTENT", "ROLLBACK_INTENT"}', runtime)
        self.assertIn('"recovery_failed_rolled_back"', runtime)
        self.assertIn('"activation_recovery": activation_recovery', runtime)
        self.assertIn('"phase": "RELEASE_ACTIVATION_ROLLBACK_INTENT"', runtime)
        self.assertIn('state.get("phase") == "RELEASE_ACTIVATION_ROLLBACK_INTENT"', runtime)

    def test_every_compose_activation_and_rollback_revalidates_sealed_inputs(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        compose = runtime[runtime.index("def _validate_production_compose_inputs"):runtime.index("def _preserved_gravity_semantics")]
        self.assertEqual(compose.count("_validate_production_compose_inputs(core, profile, state)"), 2)
        self.assertIn('production["compose_sha256"]', compose)
        self.assertIn('production_identity["environment_sha256"]', compose)
        self.assertIn("_secure_host_file", compose)
        self.assertIn("_sha_file", compose)
        rollback = runtime[runtime.index("def _rollback_impl"):runtime.index("def dispatch")]
        self.assertIn("_compose_up(core, profile, state, ROLLBACK_OVERLAY)", rollback)
        self.assertIn("_compose_up(core, profile, state, ACTIVATE_OVERLAY)", rollback)

    def test_compose_rejects_sealed_environment_drift_before_any_docker_call(self) -> None:
        original_secure = self.profile_runtime._secure_host_file
        original_run = self.profile_runtime._run
        compose = self.root / "sealed-compose.yml"
        environment = self.root / "sealed-environment.env"
        compose.write_text("services: {}\n", encoding="ascii")
        environment.write_text("SECRET=before\n", encoding="ascii")
        os.chmod(compose, 0o644)
        os.chmod(environment, 0o600)
        profile = json.loads(json.dumps(self.profile))
        profile["production"]["compose_sha256"] = sha(compose)
        profile["production"]["compose_path"] = "/sealed-compose.yml"
        profile["production"]["environment_path"] = "/sealed-environment.env"
        state = {"production_identity": {"environment_sha256": sha(environment)}}
        calls: list[list[str]] = []
        try:
            self.profile_runtime._secure_host_file = lambda core, path, mode, maximum: {
                "/sealed-compose.yml": compose,
                "/sealed-environment.env": environment,
            }[path]
            self.profile_runtime._run = lambda core, args, **kwargs: (
                calls.append(args) or subprocess.CompletedProcess(args, 0, b"", b"")
            )
            environment.write_text("SECRET=after\n", encoding="ascii")
            with self.assertRaises(self.core.RuntimeFault) as raised:
                self.profile_runtime._compose_up(
                    self.core, profile, state, self.profile_runtime.ACTIVATE_OVERLAY
                )
            self.assertEqual(raised.exception.code, "PRODUCTION_COMPOSE_INPUT_IDENTITY_DRIFT")
            self.assertEqual(calls, [])
        finally:
            self.profile_runtime._secure_host_file = original_secure
            self.profile_runtime._run = original_run
            compose.unlink(missing_ok=True)
            environment.unlink(missing_ok=True)

    def test_explicit_rollback_recovers_durable_intent_after_partial_old_image_restore(self) -> None:
        profile_names = (
            "_read_state", "_reconcile_terminal_audit", "_write_terminal_state",
            "_rollback_impl", "_audit",
        )
        profile_originals = {name: getattr(self.profile_runtime, name) for name in profile_names}
        core_originals = {name: getattr(self.core, name) for name in ("audit_status", "container_projection")}
        intent = {
            "schema": self.profile_runtime.STATE_SCHEMA,
            "profile_id": PROFILE_ID,
            "phase": "ROLLBACK_INTENT",
            "target_image_id": "sha256:" + "a" * 64,
            "production_identity": {"environment_sha256": "b" * 64},
            "rollback_intent_at": "2026-08-12T00:00:00Z",
        }
        gravity = {
            "image_id": self.profile["production"]["gravity_image_id"],
            "running": False,
            "health": "unhealthy",
        }
        calls: list[object] = []
        try:
            self.profile_runtime._read_state = lambda core: dict(intent)
            self.profile_runtime._reconcile_terminal_audit = lambda *args: calls.append("reconcile")
            self.core.audit_status = lambda: {"state": "VALID"}
            self.core.container_projection = lambda *args: gravity
            self.profile_runtime._rollback_impl = lambda core, policy, profile, state: (
                calls.append(("rollback", state["phase"]))
                or {"gravity_image_id": gravity["image_id"], "running": True, "healthy": True}
            )
            def terminal(core, invocation, pre, result, post):
                calls.append(("terminal", result, pre["phase"], post["phase"]))
                return dict(post)
            self.profile_runtime._write_terminal_state = terminal
            self.profile_runtime._audit = lambda *args: calls.append("failed-audit")
            result = self.profile_runtime._rollback(
                self.core, self.core.load_policy(), self.profile, self.core.Invocation("rollback", None)
            )
            self.assertTrue(result["production_mutated"])
            self.assertEqual(calls, [
                "reconcile",
                ("rollback", "ROLLBACK_INTENT"),
                ("terminal", "ok", "ROLLBACK_INTENT", "ROLLED_BACK"),
            ])
        finally:
            for name, value in profile_originals.items():
                setattr(self.profile_runtime, name, value)
            for name, value in core_originals.items():
                setattr(self.core, name, value)

    def test_fresh_explicit_rollback_persists_audited_intent_before_compose(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        rollback = runtime[runtime.index("def _rollback("):runtime.index("def dispatch")]
        intent = rollback.index('"phase": "ROLLBACK_INTENT"')
        durable = rollback.index('_write_terminal_state(core, invocation, state, "intent", intent)', intent)
        mutation = rollback.index("_rollback_impl(core, policy, profile, intent)", durable)
        self.assertLess(intent, durable)
        self.assertLess(durable, mutation)
        self.assertIn('state.get("phase") == "ROLLBACK_INTENT"', rollback)

    def test_automatic_rollback_persists_and_recovers_its_own_intent(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        helper = runtime[runtime.index("def _complete_activation_rollback"):runtime.index("def _release_activate")]
        durable = helper.index('"phase": "RELEASE_ACTIVATION_ROLLBACK_INTENT"')
        receipt = helper.index('"activation_rollback_intent"', durable)
        mutation = helper.index("_rollback_impl(core, policy, profile, intent)", receipt)
        self.assertLess(durable, receipt)
        self.assertLess(receipt, mutation)
        release = runtime[runtime.index("def _release_activate"):runtime.index("def _rollback(")]
        self.assertIn('state.get("phase") == "RELEASE_ACTIVATION_ROLLBACK_INTENT"', release)
        self.assertIn("_complete_activation_rollback(", release)

    def test_backup_is_recreated_and_every_transient_runner_is_named(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        backup = runtime.index("def _create_backup")
        unlink = runtime.index("target.unlink()", backup)
        create = runtime.index("os.O_EXCL", backup)
        self.assertLess(unlink, create)
        self.assertNotIn('[DOCKER, "run", "--rm"', runtime)
        for name in ("BACKUP_LIST_RUNNER", "PREVIEW_MIGRATION_RUNNER", "ROLLBACK_PROOF_RUNNER", "PRODUCTION_MIGRATION_RUNNER"):
            self.assertIn(name, runtime)

    def test_activation_postcheck_pins_command_user_workdir_and_entrypoint(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        self.assertIn('gravity["cmd"] != ["npm", "run", "start"]', runtime)
        self.assertIn('gravity["declared_user"] != "app"', runtime)
        self.assertIn('gravity["working_dir"] != "/app"', runtime)
        self.assertIn('gravity["entrypoint"] != ["/usr/bin/tini", "--"]', runtime)

    def test_application_health_requires_http_200_and_json_status_ok(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        self.assertIn("r.statusCode===200&&v&&v.status==='ok'", runtime)
        self.assertIn("JSON.parse(b)", runtime)
        self.assertNotIn("r.statusCode>=200&&r.statusCode<500", runtime)

    def test_rollback_health_is_narrowly_predecessor_compatible_without_weakening_target(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        target = runtime[runtime.index("def _application_health"):runtime.index("def _rollback_application_health")]
        rollback = runtime[runtime.index("def _rollback_application_health"):runtime.index("def _activation_postcheck")]
        self.assertIn("r.statusCode===200&&v&&v.status==='ok'", target)
        self.assertNotIn("s==='degraded'", target)
        self.assertIn("r.statusCode===200&&(s==='ok'||s==='degraded')", rollback)
        self.assertNotIn("statusCode>=200", rollback)
        self.assertNotIn("/api/health/infra", rollback)
        self.assertNotIn("domain_outbox_publisher_started", rollback)

        original = self.profile_runtime._run
        try:
            self.profile_runtime._run = lambda *args, **kwargs: subprocess.CompletedProcess(args, 2, b"", b"")
            with self.assertRaises(self.core.RuntimeFault) as raised:
                self.profile_runtime._rollback_application_health(self.core, self.profile)
            self.assertEqual(raised.exception.code, "GRAVITY_ROLLBACK_APPLICATION_HEALTH_FAILED")
        finally:
            self.profile_runtime._run = original

    def test_recovery_profile_binds_exact_live_state_and_corrected_source(self) -> None:
        self.assertEqual(self.profile["package_version"], "2.0.0-8")
        self.assertEqual(self.profile["accepted_source"]["commit"], "7aea2823efe50e13a156540993d424594025e403")
        self.assertEqual(self.profile["accepted_source"]["tree"], "dbb380be0775d41b246248a9fe8fbf99bcb38d22")
        self.assertEqual(self.profile["production"]["gravity_container_id"], "f2604662889815d31e449ab52b14e053da9b4fb9598cd72e209b4ccd5014b700")
        self.assertEqual(self.profile["production"]["compose_config_hash"], "4c1adad9993cb54c5723a202df6a3d3786709e0a01e42fff24d2230a83a411da")
        self.assertEqual(self.profile["recovery"], {
            "predecessor_package_version": "2.0.0-7",
            "prior_source_commit": "af9646f51c1274d718d83eb4c78faf92f214a184",
            "prior_source_archive_sha256": "c43d6e6ea0735b7a5dad9117822df24b7ec0133685c69b8c13b50effc7c9f808",
            "prior_target_tag": "yoko/crm-gravity-mvp:af9646f51c1274d718d83eb4c78faf92f214a184-profile-v1",
            "prior_target_image_id": "sha256:5ee4bdc2242b24a8f8c2c3ef71d18e0f20c9b3b0df8810517553b4097d03936c",
            "prior_compose_config_hash": "6db5dbf0f52f8d8e4fd30c1fcaf658c04a72c7f8ec034c3b38436792b8939014",
            "recovered_gravity_container_id": "f2604662889815d31e449ab52b14e053da9b4fb9598cd72e209b4ccd5014b700",
            "recovered_compose_config_hash": "4c1adad9993cb54c5723a202df6a3d3786709e0a01e42fff24d2230a83a411da",
            "database_identity_sha256": "ed88dfeaad2a3dc2e759590d295992cd06531d4403d896ded00b21ea667be1c9",
            "migration_ledger_sha256": "a50f1a8988f79c85059354d6b2d45e9e8ed07284fc27c78d98face6680f25dfc",
            "backup_sha256": "31bc226112ba63909f6bb2d22dd2d873b342684aad8b82fe6a25bf5d99ee5d41",
            "backup_bytes": 194477048,
            "preview_outbox_catalog_sha256": "ef0bce36bca8283b491a966ff3886644a8887f4bded3deebbec7ce559ac2defe",
        })

    def test_rolled_back_retry_reverifies_proofs_and_seals_migrated_candidate_without_db_mutation(self) -> None:
        names = (
            "_image_inspect", "_verify_recovery_backup", "_database_status",
            "_archive_inventory", "_production_preflight_identity", "_storage_guard",
            "_audit", "_extract_source", "_build_candidate", "_seal_rollback_image",
            "_write_terminal_state", "_read_state",
        )
        originals = {name: getattr(self.profile_runtime, name) for name in names}
        state = valid_rolled_back_recovery_state(self.profile_runtime, self.profile)
        recovery = self.profile["recovery"]
        calls: list[str] = []
        terminal: dict[str, object] = {}
        new_target = "sha256:" + "9" * 64
        try:
            def image(core, reference, **kwargs):
                calls.append("prior_image" if reference == self.profile_runtime.PRIOR_TARGET_TAG else "rollback_image")
                return {"Id": recovery["prior_target_image_id"] if reference == self.profile_runtime.PRIOR_TARGET_TAG else self.profile["production"]["gravity_image_id"]}
            self.profile_runtime._image_inspect = image
            self.profile_runtime._verify_recovery_backup = lambda *args: (calls.append("backup") or {"sha256": recovery["backup_sha256"], "bytes": recovery["backup_bytes"], "status": "REHASHED_AND_VERIFIED"})
            database = {"migration_state": "APPROVED_OUTBOX_APPLIED", "database_identity_sha256": recovery["database_identity_sha256"], "migration_ledger_sha256": recovery["migration_ledger_sha256"]}
            self.profile_runtime._database_status = lambda *args: (calls.append("database") or (database, {}))
            self.profile_runtime._archive_inventory = lambda *args: (calls.append("archive") or {"entries": 3904})
            self.profile_runtime._production_preflight_identity = lambda *args: (calls.append("production") or {"gravity_semantic": {"command": ["old"]}, "environment_sha256": "a" * 64})
            self.profile_runtime._storage_guard = lambda *args: (calls.append("storage") or {"available_bytes": 20, "minimum_reserve_bytes": 8, "required_working_bytes": 3})
            self.profile_runtime._audit = lambda *args: calls.append("audit")
            self.profile_runtime._extract_source = lambda *args: (calls.append("extract") or Path("/sealed/source"))
            self.profile_runtime._build_candidate = lambda *args: (calls.append("build") or new_target)
            self.profile_runtime._seal_rollback_image = lambda *args: calls.append("seal")
            def write_terminal(core, invocation, pre, result, post):
                calls.append("terminal")
                terminal.update(post)
                return dict(post)
            self.profile_runtime._write_terminal_state = write_terminal
            self.profile_runtime._read_state = lambda *args: dict(state)
            result = self.profile_runtime._release_retry_preflight(
                self.core, self.core.load_policy(), self.profile,
                self.core.Invocation("release-preflight", None), dict(state),
            )
            self.assertEqual(result["status"], "PREFLIGHT_READY_DATABASE_ALREADY_MIGRATED")
            self.assertFalse(result["production_mutation"])
            self.assertFalse(result["production_database_mutation"])
            self.assertEqual(terminal["phase"], "MIGRATED")
            self.assertEqual(terminal["accepted_commit"], self.profile["accepted_source"]["commit"])
            self.assertEqual(terminal["target_image_id"], new_target)
            self.assertEqual(terminal["backup_sha256"], recovery["backup_sha256"])
            self.assertLess(calls.index("backup"), calls.index("build"))
            self.assertLess(calls.index("database"), calls.index("build"))
            helper = self.profile_runtime_path.read_text(encoding="utf-8")
            helper = helper[helper.index("def _release_retry_preflight"):helper.index("def _release_preflight")]
            for forbidden in ("_create_backup(", "_run_candidate_migration(", "_prepare_production_runners(", "_psql("):
                self.assertNotIn(forbidden, helper)
        finally:
            for name, value in originals.items():
                setattr(self.profile_runtime, name, value)

    def test_rolled_back_retry_rejects_each_material_state_drift_before_backup_or_build(self) -> None:
        original_image = self.profile_runtime._image_inspect
        original_backup = self.profile_runtime._verify_recovery_backup
        recovery = self.profile["recovery"]
        reached: list[str] = []
        try:
            self.profile_runtime._image_inspect = lambda core, reference, **kwargs: {"Id": recovery["prior_target_image_id"] if reference == self.profile_runtime.PRIOR_TARGET_TAG else self.profile["production"]["gravity_image_id"]}
            self.profile_runtime._verify_recovery_backup = lambda *args: (reached.append("backup") or {})
            mutations = {
                "source": ("accepted_commit", "0" * 40),
                "target": ("target_image_id", "sha256:" + "0" * 64),
                "database": ("database_identity_sha256", "0" * 64),
                "backup": ("backup_sha256", "0" * 64),
                "restore": ("restore_verified", False),
                "preview": ("preview_proof", {"migration_ledger_sha256": recovery["migration_ledger_sha256"], "outbox_catalog_sha256": "0" * 64}),
            }
            for label, (key, value) in mutations.items():
                with self.subTest(label=label):
                    state = valid_rolled_back_recovery_state(self.profile_runtime, self.profile)
                    state[key] = value
                    with self.assertRaises(self.core.RuntimeFault) as raised:
                        self.profile_runtime._release_retry_preflight(
                            self.core, self.core.load_policy(), self.profile,
                            self.core.Invocation("release-preflight", None), state,
                        )
                    self.assertEqual(raised.exception.code, "ROLLED_BACK_RETRY_STATE_INVALID")
            self.assertEqual(reached, [])
        finally:
            self.profile_runtime._image_inspect = original_image
            self.profile_runtime._verify_recovery_backup = original_backup

    def test_migrated_retry_database_gate_rehashes_backup_and_rejects_identity_drift(self) -> None:
        names = ("_read_state", "_reconcile_terminal_audit", "_database_status", "_verify_recovery_backup")
        originals = {name: getattr(self.profile_runtime, name) for name in names}
        state = valid_rolled_back_recovery_state(self.profile_runtime, self.profile)
        state["phase"] = "MIGRATED"
        calls: list[str] = []
        try:
            self.profile_runtime._read_state = lambda *args: dict(state)
            self.profile_runtime._reconcile_terminal_audit = lambda *args: None
            self.profile_runtime._verify_recovery_backup = lambda *args: calls.append("backup")
            self.profile_runtime._database_status = lambda *args: ({
                "migration_state": "APPROVED_OUTBOX_APPLIED",
                "database_identity_sha256": "0" * 64,
                "migration_ledger_sha256": state["migration_ledger_sha256"],
            }, {})
            with self.assertRaises(self.core.RuntimeFault) as raised:
                self.profile_runtime._database_migrate(
                    self.core, self.profile, self.core.Invocation("database-migrate", None)
                )
            self.assertEqual(raised.exception.code, "MIGRATED_STATE_IDENTITY_DRIFT")
            self.assertEqual(calls, [])
        finally:
            for name, value in originals.items():
                setattr(self.profile_runtime, name, value)

    def test_rollback_pins_original_image_command_and_runtime_semantics(self) -> None:
        runtime = self.profile_runtime_path.read_text(encoding="utf-8")
        self.assertIn('current.get("command") != original.get("command")', runtime)
        self.assertIn('raise core.RuntimeFault("ROLLBACK_SEMANTIC_DRIFT", 74)', runtime)
        self.assertIn('"original_runtime_semantics_restored": True', runtime)
        helper = runtime[runtime.index("def _accept_existing_rollback"):runtime.index("def _complete_activation_rollback")]
        self.assertIn('_rollback_semantics_compatibility(profile, state, gravity)', helper)
        self.assertIn('_validate_production_compose_inputs(core, profile, state)', helper)
        self.assertIn('_rollback_application_health(core, profile)', helper)

    def test_only_exact_inherited_v7_compose_hash_transition_is_compatible(self) -> None:
        recovery = self.profile["recovery"]
        state = valid_rolled_back_recovery_state(self.profile_runtime, self.profile)
        state["phase"] = "RELEASE_ACTIVATION_ROLLBACK_INTENT"
        state["activation_rollback_intent_at"] = "2026-08-12T17:59:00Z"
        state["activation_recovery"] = False
        state["production_identity"]["gravity_semantic"] = rollback_semantic(
            self.profile, recovery["prior_compose_config_hash"]
        )
        current = {
            "container_id": recovery["recovered_gravity_container_id"],
            "semantic": rollback_semantic(self.profile, recovery["recovered_compose_config_hash"]),
        }
        self.assertEqual(
            self.profile_runtime._rollback_semantics_compatibility(self.profile, state, current),
            "PINNED_V7_ROLLBACK_CONFIG_TRANSITION",
        )

        mutations = {
            "wrong_phase": lambda value: value.update(phase="MIGRATED"),
            "wrong_source": lambda value: value.update(accepted_commit="0" * 40),
            "wrong_container": lambda value: value.update(container_id="0" * 64),
            "wrong_current_hash": lambda value: value["semantic"]["compose_labels"].update({"com.docker.compose.config-hash": "0" * 64}),
            "wrong_project": lambda value: value["semantic"]["compose_labels"].update({"com.docker.compose.project": "other"}),
            "command_drift": lambda value: value["semantic"].update(command=["npm", "run", "start"]),
            "mount_drift": lambda value: value["semantic"].update(mounts=[]),
            "network_drift": lambda value: value["semantic"].update(network_names=["other"]),
            "environment_name_drift": lambda value: value["semantic"].update(environment_names=["NODE_ENV"]),
            "privilege_drift": lambda value: value["semantic"].update(privileged=True),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                changed_state = json.loads(json.dumps(state))
                changed_current = json.loads(json.dumps(current))
                target = changed_state if label in {"wrong_phase", "wrong_source"} else changed_current
                mutate(target)
                self.assertIsNone(
                    self.profile_runtime._rollback_semantics_compatibility(
                        self.profile, changed_state, changed_current
                    )
                )

    def test_release_activate_closes_exact_inherited_v7_rollback_intent(self) -> None:
        recovery = self.profile["recovery"]
        state = valid_rolled_back_recovery_state(self.profile_runtime, self.profile)
        state["phase"] = "RELEASE_ACTIVATION_ROLLBACK_INTENT"
        state["activation_rollback_intent_at"] = "2026-08-12T17:59:00Z"
        state["activation_recovery"] = False
        state["production_identity"]["gravity_semantic"] = rollback_semantic(
            self.profile, recovery["prior_compose_config_hash"]
        )
        current = {
            "container_id": recovery["recovered_gravity_container_id"],
            "image_id": self.profile["production"]["gravity_image_id"],
            "running": True,
            "health": "healthy",
            "semantic": rollback_semantic(self.profile, recovery["recovered_compose_config_hash"]),
        }
        profile_names = (
            "_read_state", "_reconcile_terminal_audit", "_validate_production_compose_inputs",
            "_rollback_database_postcheck", "_rollback_application_health", "_write_terminal_state",
        )
        profile_originals = {name: getattr(self.profile_runtime, name) for name in profile_names}
        core_originals = {
            "audit_status": self.core.audit_status,
            "container_projection": self.core.container_projection,
        }
        terminal: dict[str, object] = {}
        try:
            self.profile_runtime._read_state = lambda *args: dict(state)
            self.profile_runtime._reconcile_terminal_audit = lambda *args: None
            self.profile_runtime._validate_production_compose_inputs = lambda *args: None
            self.profile_runtime._rollback_database_postcheck = lambda *args: {
                "migration_state": "APPROVED_OUTBOX_APPLIED",
                "database_identity_sha256": recovery["database_identity_sha256"],
                "migration_ledger_sha256": recovery["migration_ledger_sha256"],
            }
            self.profile_runtime._rollback_application_health = lambda *args: {
                "rollback_application_health_compatible": True,
            }
            def write_terminal(core, invocation, pre, result, post):
                terminal.clear()
                terminal.update(post)
                return dict(post)
            self.profile_runtime._write_terminal_state = write_terminal
            self.core.audit_status = lambda: {"state": "VALID"}
            self.core.container_projection = lambda *args: json.loads(json.dumps(current))

            result = self.profile_runtime._release_activate(
                self.core,
                self.core.load_policy(),
                self.profile,
                self.core.Invocation("release-activate", None),
            )
            self.assertEqual(result["status"], "ROLLED_BACK_RECOVERED")
            self.assertEqual(result["state_phase"], "ROLLED_BACK")
            self.assertEqual(
                result["rollback"]["runtime_semantics_compatibility"],
                "PINNED_V7_ROLLBACK_CONFIG_TRANSITION",
            )
            self.assertEqual(terminal["phase"], "ROLLED_BACK")
            self.assertEqual(
                terminal["rollback_runtime_semantics_compatibility"],
                "PINNED_V7_ROLLBACK_CONFIG_TRANSITION",
            )
        finally:
            for name, value in profile_originals.items():
                setattr(self.profile_runtime, name, value)
            for name, value in core_originals.items():
                setattr(self.core, name, value)

    def test_profile_manifest_contains_data_not_executable_commands(self) -> None:
        rendered = json.dumps(self.profile, sort_keys=True)
        for forbidden in ("/bin/sh", "sudo", "docker run", "psql", "pg_dump", "systemctl", "command_argv", "script"):
            self.assertNotIn(forbidden, rendered)
        self.assertTrue(all(value is False for value in self.profile["negative_properties"].values()))

    def test_sudoers_is_byte_identical_and_not_widened(self) -> None:
        packaged = self.root / "etc/sudoers.d/92-yoko-privileged-runtime"
        source = ROOT / "packaging/92-yoko-privileged-runtime"
        self.assertEqual(sha(packaged), sha(source))
        self.assertEqual(sha(packaged), "6e6b7cb2a088cc92fa7aee747adca46c64b4b96d1224be21117be5adef488c06")
        text = packaged.read_text(encoding="utf-8")
        self.assertNotIn("NOPASSWD: ALL", text)
        self.assertNotIn("/usr/bin/docker", text)
        for verb in ("database-status", "release-preflight", "database-migrate", "release-activate", "rollback"):
            self.assertRegex(text, rf"yoko-privileged-runtime {re.escape(verb)}(?:,|\n)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
