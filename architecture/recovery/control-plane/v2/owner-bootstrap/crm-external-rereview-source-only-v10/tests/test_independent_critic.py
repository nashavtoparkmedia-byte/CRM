#!/usr/bin/python3
from __future__ import annotations

import hashlib
import io
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def load_validator():
    loader = importlib.machinery.SourceFileLoader(
        "yoko_runtime_v10_internal_adversarial_replay_contract",
        str(ROOT / "packaging/verify-independent-critic.py"),
    )
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    loader.exec_module(module)
    return module


def load_finalizer():
    loader = importlib.machinery.SourceFileLoader(
        "yoko_runtime_v10_final_evidence_contract",
        str(ROOT / "packaging/finalize-evidence.py"),
    )
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    loader.exec_module(module)
    return module


class InternalAdversarialReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.validator = load_validator()
        cls.finalizer = load_finalizer()

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="yoko-critic-contract-")
        self.directory = Path(self.temporary.name)
        self.tar = self.directory / "bootstrap.tar"
        self.deb = self.directory / "runtime.deb"
        self.seal_path = self.directory / "SEALED_RELEASE.json"
        self.tar.write_bytes(b"exact bootstrap tar\n")
        self.deb.write_bytes(b"exact debian package\n")
        commit = "a" * 40
        tree = "b" * 40
        self.hosted = {
            "schema": "yoko.crm.hosted-authoritative-ci-attestation.v1",
            "provider": "github-actions",
            "repository": "nashavtoparkmedia-byte/CRM",
            "source": {"commit": commit, "tree": tree},
            "workflow": {
                "path": ".github/workflows/architecture-enforcement.yml",
                "sha256": "c" * 64,
            },
            "runner": {
                "path": "tools/architecture/run-authoritative-ci.mjs",
                "sha256": "d" * 64,
            },
            "run": {
                "id": 1001,
                "attempt": 1,
                "url": "https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/1001/attempts/1",
                "head_sha": commit,
                "conclusion": "success",
            },
            "check": {
                "id": 2002,
                "name": "architecture",
                "url": "https://github.com/nashavtoparkmedia-byte/CRM/runs/2002",
                "head_sha": commit,
                "conclusion": "success",
            },
            "jobs": [
                {
                    "id": 3003,
                    "name": "architecture",
                    "url": "https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/1001/job/3003",
                    "head_sha": commit,
                    "status": "completed",
                    "conclusion": "success",
                },
                {
                    "id": 4004,
                    "name": "gravity-artifact",
                    "url": "https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/1001/job/4004",
                    "head_sha": commit,
                    "status": "completed",
                    "conclusion": "success",
                },
            ],
            "artifact": {
                "id": 5005,
                "name": f"gravity-image-{commit}",
                "url": "https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/1001/artifacts/5005",
                "expired": False,
                "size_in_bytes": 8192,
                "digest": "sha256:" + "e" * 64,
                "workflow_run_id": 1001,
                "head_sha": commit,
            },
            "controls": {
                "count": 52,
                "catalog_sha256": "f" * 64,
                "semantic_catalog_sha256": "0" * 64,
                "catalog": [f"control-{index}" for index in range(52)],
            },
        }
        self.seal = {
            "schema": "yoko.crm.source-only-release-seal.v1",
            "commit": commit,
            "tree": tree,
            "acceptance_record_sha256": "1" * 64,
            "production_snapshot_sha256": "2" * 64,
            "hosted_authoritative_ci": self.hosted,
        }
        self.seal_path.write_text(json.dumps(self.seal, sort_keys=True) + "\n", encoding="ascii")
        self.bindings = self.validator.expected_bindings(
            self.seal, self.seal_path, self.tar, self.deb,
        )
        self.attacks = [
            {
                "id": attack_id,
                "status": "PASS",
                "evidence_sha256": hashlib.sha256(attack_id.encode("ascii")).hexdigest(),
            }
            for attack_id in self.validator.ATTACK_IDS
        ]
        self.replay = self.validator.build_replay_evidence(
            self.bindings, self.attacks, "2020-01-01T00:00:00Z",
        )
        self.review = {
            "schema": self.validator.INTERNAL_REVIEW_SCHEMA,
            "verdict": "PASS",
            "reviewer_assertion": "INTERNAL_SEPARATE_TEST_REVIEWER",
            "reviewed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "separation_assertion": "NOT_THE_EXECUTOR_AND_NOT_THE_POST_READY_EXTERNAL_REVIEWER",
            "bindings": self.bindings,
            "validator": self.validator.validator_identity(),
            "attacks": self.attacks,
            "residual_findings": [],
            "repository_mutated_by_reviewer": False,
            "production_mutated_by_reviewer": False,
        }

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_bootstrap_tar(
        self, *, embedded_deb: bytes | None = None, symlink_member: str | None = None,
    ) -> None:
        deb = self.deb.read_bytes() if embedded_deb is None else embedded_deb
        files = {
            "payload/install.sh": b"#!/bin/sh\nexit 0\n",
            f"payload/{self.validator.NEW_DEB_NAME}": deb,
            f"payload/{self.validator.OLD_DEB_NAME}": b"old debian package\n",
            "payload/review/human-manifest.md": b"reviewed\n",
            "payload/review/installation-procedure.md": b"install\n",
            "payload/review/rollback-analysis.md": b"rollback\n",
        }
        review = {
            "schema": "yoko.crm.owner-bootstrap-review-manifest.v2",
            "new_package": {
                "path": self.validator.NEW_DEB_NAME,
                "sha256": hashlib.sha256(deb).hexdigest(),
                "bytes": len(deb),
            },
        }
        files["payload/review/package-manifest.json"] = (
            json.dumps(review, sort_keys=True) + "\n"
        ).encode("ascii")
        payload_files = {}
        for name, raw in files.items():
            relative = name.removeprefix("payload/")
            payload_files[relative] = {
                "sha256": hashlib.sha256(raw).hexdigest(),
                "mode": format(self.validator.BOOTSTRAP_MODES[name], "04o"),
            }
        payload = {
            "schema": "yoko.crm.owner-bootstrap-payload.v1",
            "files": payload_files,
        }
        files["payload/payload-manifest.json"] = (
            json.dumps(payload, sort_keys=True) + "\n"
        ).encode("ascii")
        with tarfile.open(self.tar, "w", format=tarfile.GNU_FORMAT) as archive:
            for name in sorted(self.validator.BOOTSTRAP_MODES):
                member = tarfile.TarInfo(name)
                member.uid = 0
                member.gid = 0
                member.mode = self.validator.BOOTSTRAP_MODES[name]
                member.mtime = self.validator.BOOTSTRAP_MTIME
                if name in {"payload", "payload/review"}:
                    member.type = tarfile.DIRTYPE
                    archive.addfile(member)
                elif name == symlink_member:
                    member.type = tarfile.SYMTYPE
                    member.linkname = "/etc/passwd"
                    archive.addfile(member)
                else:
                    raw = files[name]
                    member.size = len(raw)
                    archive.addfile(member, io.BytesIO(raw))

    def test_exact_fixed_eight_attack_replay_is_explicitly_non_authorizing(self) -> None:
        self.assertEqual(
            tuple(attack["id"] for attack in self.replay["attacks"]),
            self.validator.ATTACK_IDS,
        )
        self.assertEqual(len(set(self.validator.ATTACK_IDS)), 8)
        self.assertEqual(self.replay["role"], "INTERNAL_ADVERSARIAL_EVIDENCE_ONLY")
        self.assertIs(self.replay["owner_authorization"], False)
        self.assertIs(self.replay["external_reviewer_attestation"], False)
        for forbidden in ("reviewer", "independent", "verdict", "reviewed_at"):
            self.assertNotIn(forbidden, self.replay)

    def test_separately_authored_internal_review_is_consumed(self) -> None:
        accepted = self.validator.validate_internal_review(
            self.review, self.bindings, self.attacks,
        )
        self.assertEqual(accepted["reviewer_assertion"], "INTERNAL_SEPARATE_TEST_REVIEWER")

    def test_internal_review_identity_separation_bindings_and_attacks_fail_closed(self) -> None:
        mutations = (
            lambda value: value.__setitem__("reviewer_assertion", "EXECUTOR"),
            lambda value: value.__setitem__("separation_assertion", "SAME_EXECUTOR"),
            lambda value: value["bindings"].__setitem__("sealed_release_sha256", "0" * 64),
            lambda value: value["validator"].__setitem__("sha256", "0" * 64),
            lambda value: value["attacks"][0].__setitem__("evidence_sha256", "0" * 64),
            lambda value: value.__setitem__("residual_findings", ["unresolved"]),
        )
        for mutation in mutations:
            candidate = json.loads(json.dumps(self.review))
            mutation(candidate)
            with self.subTest(candidate=candidate):
                with self.assertRaisesRegex(SystemExit, "internal review"):
                    self.validator.validate_internal_review(candidate, self.bindings, self.attacks)

    def test_attack_result_shape_and_exact_catalog_fail_closed(self) -> None:
        candidates = []
        missing = json.loads(json.dumps(self.attacks))
        missing.pop()
        candidates.append(missing)
        duplicate = json.loads(json.dumps(self.attacks))
        duplicate[-1] = dict(duplicate[0])
        candidates.append(duplicate)
        unknown = json.loads(json.dumps(self.attacks))
        unknown[-1]["id"] = "invented-ninth-attack"
        candidates.append(unknown)
        reordered = json.loads(json.dumps(self.attacks))
        reordered[0], reordered[1] = reordered[1], reordered[0]
        candidates.append(reordered)
        bad_status = json.loads(json.dumps(self.attacks))
        bad_status[3]["status"] = "SKIPPED"
        candidates.append(bad_status)
        bad_digest = json.loads(json.dumps(self.attacks))
        bad_digest[3]["evidence_sha256"] = "short"
        candidates.append(bad_digest)
        extra = json.loads(json.dumps(self.attacks))
        extra[3]["unverified"] = True
        candidates.append(extra)
        for candidate in candidates:
            with self.subTest(candidate=candidate):
                with self.assertRaisesRegex(SystemExit, "internal attack"):
                    self.validator.validate_attack_results(candidate)

    def test_future_or_malformed_execution_time_fails_closed(self) -> None:
        for value in ("2099-01-01T00:00:00Z", "2026-08-13", True):
            with self.subTest(value=value):
                with self.assertRaisesRegex(SystemExit, "internal replay executed_at"):
                    self.validator.validate_executed_at(value)

    def test_stale_internal_review_fails_closed(self) -> None:
        stale = json.loads(json.dumps(self.review))
        stale["reviewed_at"] = "2020-01-01T00:00:00Z"
        with self.assertRaisesRegex(SystemExit, "internal review is stale"):
            self.validator.validate_internal_review(stale, self.bindings, self.attacks)

    def test_no_self_issued_external_pass_or_owner_authorization_path_exists(self) -> None:
        replay_source = (ROOT / "packaging/verify-independent-critic.py").read_text()
        finalizer = (ROOT / "packaging/finalize-evidence.py").read_text()
        for forbidden in (
            "build_critic_artifact", "build_internal_review", "--emit",
            "--critic-artifact", "independent-runtime-bootstrap-critic-verification",
        ):
            self.assertNotIn(forbidden, replay_source)
            self.assertNotIn(forbidden, finalizer)
        self.assertIn('mode.add_argument("--replay-evidence"', replay_source)
        self.assertIn('mode.add_argument("--verify-review"', replay_source)
        self.assertIn('choices=("PENDING", "PASS")', finalizer)
        self.assertIn('"self_issued_review_accepted": False', finalizer)
        self.assertIn('"external_project_rereview_satisfied": False', finalizer)

    def test_duplicate_json_keys_are_rejected_before_semantic_validation(self) -> None:
        path = self.directory / "duplicate.json"
        path.write_text('{"verdict":"FAIL","verdict":"PASS"}\n', encoding="ascii")
        with self.assertRaisesRegex(SystemExit, "invalid duplicate-key fixture"):
            self.validator.read_json(path, "duplicate-key fixture")

    def test_source_identity_requires_exact_clean_commit_and_tree(self) -> None:
        repo = self.directory / "repo"
        repo.mkdir()
        subprocess.run(["/usr/bin/git", "init", "-q", str(repo)], check=True)
        subprocess.run(["/usr/bin/git", "-C", str(repo), "config", "user.name", "Runtime Test"], check=True)
        subprocess.run(["/usr/bin/git", "-C", str(repo), "config", "user.email", "runtime@example.invalid"], check=True)
        (repo / "source.txt").write_text("accepted\n", encoding="ascii")
        subprocess.run(["/usr/bin/git", "-C", str(repo), "add", "source.txt"], check=True)
        subprocess.run(["/usr/bin/git", "-C", str(repo), "commit", "-q", "-m", "accepted"], check=True)
        source = {
            "commit": subprocess.check_output(["/usr/bin/git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip(),
            "tree": subprocess.check_output(["/usr/bin/git", "-C", str(repo), "rev-parse", "HEAD^{tree}"], text=True).strip(),
        }
        self.validator.validate_source_repo(repo, source)
        (repo / "untracked.txt").write_text("drift\n", encoding="ascii")
        with self.assertRaisesRegex(SystemExit, "not the exact clean accepted"):
            self.validator.validate_source_repo(repo, source)
        (repo / "untracked.txt").unlink()
        with self.assertRaisesRegex(SystemExit, "not the exact clean accepted"):
            self.validator.validate_source_repo(repo, {**source, "tree": "0" * 40})

    def test_release_mutation_during_replay_is_rejected(self) -> None:
        initial = {
            "seal": self.validator.sha(self.seal_path),
            "tar": self.validator.sha(self.tar),
            "deb": self.validator.sha(self.deb),
        }
        self.validator.release_inputs_unchanged(initial, self.seal_path, self.tar, self.deb)
        self.tar.write_bytes(b"mutated after internal replay started\n")
        with self.assertRaisesRegex(SystemExit, "changed during internal replay"):
            self.validator.release_inputs_unchanged(initial, self.seal_path, self.tar, self.deb)

    def test_exact_bootstrap_tar_inventory_and_embedded_deb_are_consumed(self) -> None:
        self.write_bootstrap_tar()
        inventory_sha = self.validator.validate_bootstrap_tar(self.tar, self.deb)
        self.assertRegex(inventory_sha, r"^[0-9a-f]{64}$")
        self.write_bootstrap_tar(embedded_deb=b"substituted debian package\n")
        with self.assertRaisesRegex(SystemExit, "exact Debian package"):
            self.validator.validate_bootstrap_tar(self.tar, self.deb)

    def test_large_exact_new_deb_has_a_streamed_exact_size_contract(self) -> None:
        formerly_rejected_size = 256 * 1024 * 1024 + 1
        self.validator.validate_bootstrap_member_size(
            f"payload/{self.validator.NEW_DEB_NAME}",
            formerly_rejected_size,
            formerly_rejected_size,
        )
        with self.assertRaisesRegex(SystemExit, "exact Debian package"):
            self.validator.validate_bootstrap_member_size(
                f"payload/{self.validator.NEW_DEB_NAME}",
                formerly_rejected_size,
                formerly_rejected_size + 1,
            )
        with self.assertRaisesRegex(SystemExit, "exceeded its exact bound"):
            self.validator.validate_bootstrap_member_size(
                "payload/review/package-manifest.json",
                formerly_rejected_size,
                formerly_rejected_size,
            )

    def test_streamed_exact_deb_comparison_fails_closed_on_same_size_substitution(self) -> None:
        substituted = self.directory / "substituted.deb"
        exact = self.deb.read_bytes()
        substituted.write_bytes(bytes([exact[0] ^ 1]) + exact[1:])
        self.assertEqual(substituted.stat().st_size, self.deb.stat().st_size)
        with substituted.open("rb") as source:
            with self.assertRaisesRegex(SystemExit, "exact Debian package"):
                self.validator.consume_bootstrap_member(
                    source, substituted.stat().st_size, exact_path=self.deb,
                )

    def test_bootstrap_tar_link_metadata_fails_closed(self) -> None:
        self.write_bootstrap_tar(symlink_member="payload/review/human-manifest.md")
        with self.assertRaisesRegex(SystemExit, "member metadata"):
            self.validator.validate_bootstrap_tar(self.tar, self.deb)

    def test_internal_replay_process_environment_excludes_ambient_injection(self) -> None:
        with mock.patch.dict(os.environ, {
            "DATABASE_URL": "postgresql://localhost/db?schema=yoko_migration_authority_replay_critic",
            "NODE_OPTIONS": "--require=/tmp/attacker.js",
            "NPM_CONFIG_USERCONFIG": "/tmp/attacker-npmrc",
            "YOKO_POSTGRES_CLIENT_CONTAINER": "postgres-container",
        }, clear=True):
            environment = self.validator.replay_environment(
                Path("/exact/node/bin/node"), self.directory / "environment",
            )
        self.assertNotIn("NODE_OPTIONS", environment)
        self.assertNotIn("NPM_CONFIG_USERCONFIG", environment)
        self.assertEqual(environment["CI"], "1")
        self.assertEqual(environment["YOKO_BLAST_BASE"], "HEAD^")
        self.assertEqual(environment["YOKO_POSTGRES_CLIENT_CONTAINER"], "postgres-container")

    def test_fixed_catalog_runs_full_ci_then_the_seven_exact_negative_attacks(self) -> None:
        self.assertEqual(tuple(self.validator.ATTACK_COMMANDS), self.validator.ATTACK_IDS)
        self.assertEqual(
            self.validator.ATTACK_COMMANDS["clean-checkout-ci"],
            (("tools/architecture/run-authoritative-ci.mjs",),),
        )
        source = (ROOT / "packaging/verify-independent-critic.py").read_text()
        rerun = source.index("attacks = execute_attacks(")
        materialize = source.index("result = build_replay_evidence(")
        self.assertLess(rerun, materialize)
        self.assertGreaterEqual(source.count("release_inputs_unchanged("), 3)

    def test_exhaustive_replay_has_bounded_multi_hour_timeouts(self) -> None:
        self.assertEqual(
            self.validator.FULL_AUTHORITATIVE_CI_TIMEOUT_SECONDS,
            4 * 60 * 60,
        )
        self.assertEqual(
            self.validator.FRESH_WRITE_ANALYSIS_TIMEOUT_SECONDS,
            15 * 60,
        )
        self.assertEqual(
            self.validator.DEFAULT_ATTACK_COMMAND_TIMEOUT_SECONDS,
            5 * 60,
        )
        self.assertEqual(
            self.finalizer.INTERNAL_REVIEW_VERIFICATION_TIMEOUT_SECONDS,
            6 * 60 * 60,
        )

    def test_full_ci_replay_timeout_fails_closed_without_uncaught_traceback(self) -> None:
        timeout = self.validator.FULL_AUTHORITATIVE_CI_TIMEOUT_SECONDS
        with mock.patch.object(
            self.validator.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(cmd=["node"], timeout=timeout),
        ) as run:
            with self.assertRaisesRegex(
                SystemExit,
                rf"^internal attack reproduction timed out after {timeout}s: "
                r"tools/architecture/run-authoritative-ci\.mjs$",
            ):
                self.validator.run_attack_command(
                    Path("/exact/node/bin/node"),
                    self.directory,
                    ("tools/architecture/run-authoritative-ci.mjs",),
                    {},
                    {},
                )
        self.assertEqual(run.call_args.kwargs["timeout"], timeout)


if __name__ == "__main__":
    unittest.main()
