#!/usr/bin/python3
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[5]
TRUSTED = {
    "src/yoko-privileged-runtime-core.py": "0f97bafbfe5b430fa7994119b1fc76fead4bdbee26766c730d9e399551ebdffa",
    "src/predecessor-observability-v1.py": "b5ea36c50e12b0fe6c171896258ddfc00a9d2666778735cae6a9b2a8df6d4084",
    "src/policy.v2.base.json": "8727373b0c6ec79c9abf82f1aaaa58abc2bae67e96aa96a602ac419f308db0e0",
    "packaging/92-yoko-privileged-runtime": "3022dcfc323706da81e760255dd1ab43f9b8662ee699aa8b58fbe6e714cc69d7",
}


class BuilderContractTests(unittest.TestCase):
    def test_trusted_runtime_boundary_is_byte_identical(self) -> None:
        for relative, expected in TRUSTED.items():
            with self.subTest(relative=relative):
                self.assertEqual(hashlib.sha256((ROOT / relative).read_bytes()).hexdigest(), expected)

    def test_application_source_is_not_changed_by_runtime_builder(self) -> None:
        accepted = subprocess.run(
            ["git", "-C", str(REPOSITORY), "rev-parse", "6e3f094bf4b42c1400c705843ab107dacd6d1cf8^{tree}"],
            check=True, text=True, stdout=subprocess.PIPE,
        ).stdout.strip()
        self.assertEqual(accepted, "8d3e507cda69a2862db946b2e34c5ea329c425ac")

    def test_stage_a_verifier_cannot_dirty_the_runtime_builder(self) -> None:
        sealer = (ROOT / "packaging/seal-release.py").read_text(encoding="ascii")
        self.assertIn('"/usr/bin/python3", "-I", "-B", str(verifier)', sealer)

    def test_review_directory_is_writable_only_during_staging(self) -> None:
        sealer = (ROOT / "packaging/seal-release.py").read_text(encoding="ascii")
        create = sealer.index("review_directory.mkdir(parents=True, mode=0o700)")
        write = sealer.index('copy_exact(ROOT / "human-manifest.md", review_directory / "human-manifest.md", 0o400)')
        evidence = sealer.index('copy_exact(item, review_directory / item.name, 0o400)')
        close = sealer.index("review_directory.chmod(0o500)")
        self.assertLess(create, write)
        self.assertLess(write, evidence)
        self.assertLess(evidence, close)

    def test_profile_and_wrapper_expose_only_exact_zero_argument_mutations(self) -> None:
        profile = (ROOT / "templates/crm-activation-profile.py.in").read_text(encoding="ascii")
        wrapper = (ROOT / "templates/yoko-privileged-runtime.in").read_text(encoding="ascii")
        policy = json.loads((ROOT / "src/policy.v2.base.json").read_text(encoding="ascii"))
        self.assertIn("PROFILE_ARGUMENTS_FORBIDDEN", profile)
        self.assertIn('invocation.resource is not None or invocation.relative_path is not None', profile)
        self.assertIn('["database-status", "release-preflight", "release-activate", "rollback"]', wrapper)
        self.assertEqual(set(policy["disabled_profiles"]), {"release-activation", "config-activation", "database-migration", "rollback"})
        for forbidden in ("subprocess.Popen", "shell=True", "/bin/sh", "docker.sock", "eval(", "exec("):
            self.assertNotIn(forbidden, profile)

    def test_installer_is_content_specific_fail_closed_and_restartable(self) -> None:
        installer = (ROOT / "templates/install.sh.in").read_text(encoding="ascii")
        self.assertIn("test \"$#\" -eq 0", installer)
        self.assertIn("EXPECTED_HOST='jvxthcorvm'", installer)
        self.assertIn("HANDOFF='/opt/codex-work/yoko-stage-a-handoff.u0l9So/release-output'", installer)
        self.assertIn(".incoming-'+final.name", installer)
        self.assertIn("if [ -e \"$BOOTSTRAP_GUARD\" ]; then", installer)
        self.assertIn('/usr/bin/flock -x "$bootstrap_lock_fd"', installer)
        self.assertIn('os.O_CREAT|os.O_EXCL|os.O_CLOEXEC|os.O_NOFOLLOW', installer)
        lock = installer.index('/usr/bin/flock -x "$bootstrap_lock_fd"')
        guard = installer.index('if [ -e "$BOOTSTRAP_GUARD" ]; then', lock)
        version = installer.index('installed_version=', guard)
        self.assertLess(lock, guard)
        self.assertLess(guard, version)
        self.assertIn('test "$(/usr/bin/stat -c \'%d:%i\' "$BOOTSTRAP_GUARD")" = "$guard_identity"', installer)
        self.assertIn("new_attempted=1", installer)
        self.assertIn("rollback_previous", installer)
        self.assertIn("stored_deb_exact \"$OLD_DEB_STORE\"", installer)
        for forbidden in ("curl ", "wget ", "git clone", "apt-get", "docker compose", "pg_dump", "psql ", "sudoers.d/"):
            self.assertNotIn(forbidden, installer)

    def test_embedded_installer_python_and_shell_templates_parse(self) -> None:
        installer = (ROOT / "templates/install.sh.in").read_text(encoding="ascii")
        blocks = re.findall(r"<<'PY'\n(.*?)\nPY", installer, flags=re.DOTALL)
        self.assertEqual(len(blocks), 4)
        for index, block in enumerate(blocks):
            with self.subTest(index=index):
                compile(block, f"install.sh.in:{index}", "exec")
        for relative in ("templates/install.sh.in", "templates/postinst.in", "packaging/build-package.sh"):
            subprocess.run(["bash", "-n", str(ROOT / relative)], check=True)

    def test_artifact_admission_breaks_retained_caller_writable_inode(self) -> None:
        installer = (ROOT / "templates/install.sh.in").read_text(encoding="ascii")
        blocks = re.findall(r"<<'PY'\n(.*?)\nPY", installer, flags=re.DOTALL)
        admission = blocks[2]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "handoff"
            parent = root / "store"
            source.mkdir(mode=0o700)
            parent.mkdir(mode=0o700)
            name = "gravity-image.docker.tar"
            original = b"reviewed-stage-a-archive"
            replacement = b"attacker-controlled-data"
            self.assertEqual(len(original), len(replacement))
            source_path = source / name
            retained = os.open(source_path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(retained, original)
                os.fsync(retained)
                source_path.chmod(0o444)
                receipt = root / "artifact-admission.v1.json"
                receipt.write_text(json.dumps({"files": {name: {
                    "bytes": len(original),
                    "sha256": hashlib.sha256(original).hexdigest(),
                }}}), encoding="ascii")
                receipt.chmod(0o400)
                final = parent / "content-digest"
                subprocess.run(
                    [sys.executable, "-I", "-", str(source), str(parent), str(final), str(receipt), str(os.geteuid()), str(os.getegid())],
                    input=admission,
                    text=True,
                    check=True,
                )
                admitted = final / name
                self.assertNotEqual(source_path.stat().st_ino, admitted.stat().st_ino)
                os.lseek(retained, 0, os.SEEK_SET)
                os.write(retained, replacement)
                os.fsync(retained)
                self.assertEqual(source_path.read_bytes(), replacement)
                self.assertEqual(admitted.read_bytes(), original)
                with admitted.open("rb") as runtime_load_source:
                    self.assertEqual(runtime_load_source.read(), original)
            finally:
                os.close(retained)

    def test_installer_lifetime_lock_serializes_two_processes(self) -> None:
        installer = (ROOT / "templates/install.sh.in").read_text(encoding="ascii")
        lock = installer.split("# BEGIN INSTALL LIFETIME LOCK\n", 1)[1].split("# END INSTALL LIFETIME LOCK", 1)[0]
        lock = lock.replace("'0:0:700'", f"'{os.geteuid()}:{os.getegid()}:700'")
        lock = lock.replace("'0:0:600:1'", f"'{os.geteuid()}:{os.getegid()}:600:1'")
        harness = f"""#!/bin/bash
set -euo pipefail
umask 077
BOOTSTRAP_LOCK_DIR=$1
BOOTSTRAP_LOCK=\"$BOOTSTRAP_LOCK_DIR/coordinated-bootstrap.lock\"
state=$2
events=$3
label=$4
{lock}
printf '%s\\n' \"$label:entered\" >>\"$events\"
if [ ! -e \"$state\" ]; then
    printf '%s\\n' v15 >\"$state\"
    /usr/bin/sleep 0.3
    printf '%s\\n' \"$label:installed\" >>\"$events\"
else
    test \"$(cat \"$state\")\" = v15
    printf '%s\\n' \"$label:observed-v15\" >>\"$events\"
fi
printf '%s\\n' \"$label:success\" >>\"$events\"
"""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state = root / "package-state"
            events = root / "events"
            first = subprocess.Popen(["bash", "-c", harness, "installer", str(root / "lock"), str(state), str(events), "first"])
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if events.exists() and "first:entered" in events.read_text(encoding="ascii"):
                    break
                time.sleep(0.01)
            else:
                first.kill()
                self.fail("first installer did not enter the serialized section")
            second = subprocess.Popen(["bash", "-c", harness, "installer", str(root / "lock"), str(state), str(events), "second"])
            self.assertEqual(first.wait(timeout=5), 0)
            self.assertEqual(second.wait(timeout=5), 0)
            self.assertEqual(
                events.read_text(encoding="ascii").splitlines(),
                ["first:entered", "first:installed", "first:success", "second:entered", "second:observed-v15", "second:success"],
            )
            self.assertEqual(state.read_text(encoding="ascii"), "v15\n")

    def test_snapshot_template_matches_capture_document_shape(self) -> None:
        value = json.loads((ROOT / "production-snapshot.template.json").read_text(encoding="ascii"))
        self.assertEqual(set(value), {"schema", "started_at", "completed_at", "production_mutated", "secret_values_emitted", "commands", "sealing"})
        self.assertFalse(value["production_mutated"])
        self.assertFalse(value["secret_values_emitted"])


def _load_sealer():
    import importlib.machinery
    import importlib.util

    loader = importlib.machinery.SourceFileLoader(
        "yoko_seal_release_review_tests", str(ROOT / "packaging/seal-release.py")
    )
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    loader.exec_module(module)
    return module


class IndependentReviewBindingTests(unittest.TestCase):
    """The seal must derive independent acceptance from real evidence, never assert it."""

    COMMIT = "a" * 40
    TREE = "b" * 40

    @classmethod
    def setUpClass(cls) -> None:
        cls.sealer = _load_sealer()

    def document(self, directory: Path, **overrides):
        evidence = directory / "reliability.md"
        evidence.write_text("reliability transcript\n", encoding="ascii")
        security = directory / "security.md"
        security.write_text("security transcript\n", encoding="ascii")

        def binding(path: Path):
            raw = path.read_bytes()
            return {"path": path.name, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}

        value = {
            "schema": "yoko.crm.coordinated-runtime-independent-review.v1",
            "profile_id": "crm-6e3f094bf4b4-gravity-max-source-v1",
            "package_version": "2.0.0-15",
            "candidate_commit": self.COMMIT,
            "candidate_tree": self.TREE,
            "reviews": [
                {
                    "role": "release-reliability", "reviewer": "R1", "independent": True,
                    "executor_assertion": False, "verdict": "PASS_WITH_LOW_FINDINGS",
                    "reviewed_at": "2026-09-10T00:00:00Z", "evidence": binding(evidence),
                    "findings": [{"id": "R5-01", "severity": "LOW", "title": "residual"}],
                },
                {
                    "role": "privileged-runtime-security", "reviewer": "R2", "independent": True,
                    "executor_assertion": False, "verdict": "PASS",
                    "reviewed_at": "2026-09-10T00:00:00Z", "evidence": binding(security),
                    "findings": [],
                },
            ],
        }
        value.update(overrides)
        path = directory / "independent-review.v1.json"
        path.write_text(json.dumps(value), encoding="ascii")
        return path, value

    def write(self, directory: Path, value) -> Path:
        path = directory / "independent-review.v1.json"
        path.write_text(json.dumps(value), encoding="ascii")
        return path

    def test_exact_two_role_review_binds_to_the_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path, _ = self.document(Path(raw))
            accepted, evidence = self.sealer.validate_independent_review(path, self.COMMIT, self.TREE)
        self.assertEqual(accepted["status"], "ACCEPTED")
        self.assertEqual(accepted["candidate_commit"], self.COMMIT)
        self.assertEqual([item["role"] for item in accepted["reviews"]],
                         ["privileged-runtime-security", "release-reliability"])
        self.assertEqual(accepted["residual_low_findings"], 1)
        self.assertEqual(accepted["blocking_findings"], 0)
        self.assertEqual(len(evidence), 2)

    def test_review_bound_to_another_candidate_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path, _ = self.document(Path(raw))
            with self.assertRaises(ValueError) as raised:
                self.sealer.validate_independent_review(path, "c" * 40, self.TREE)
        self.assertIn("exact sealing candidate", str(raised.exception))

    def test_blocking_finding_refuses_the_seal(self) -> None:
        for severity in ("CRITICAL", "HIGH", "MEDIUM"):
            with self.subTest(severity=severity), tempfile.TemporaryDirectory() as raw:
                directory = Path(raw)
                _, value = self.document(directory)
                value["reviews"][0]["findings"] = [{"id": "X", "severity": severity, "title": "blocking"}]
                path = self.write(directory, value)
                with self.assertRaises(ValueError) as raised:
                    self.sealer.validate_independent_review(path, self.COMMIT, self.TREE)
                self.assertIn("blocking finding", str(raised.exception))

    def test_missing_role_or_duplicate_role_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            _, value = self.document(directory)
            value["reviews"][1]["role"] = "release-reliability"
            path = self.write(directory, value)
            with self.assertRaises(ValueError) as raised:
                self.sealer.validate_independent_review(path, self.COMMIT, self.TREE)
        self.assertIn("exact required set", str(raised.exception))

    def test_executor_self_certification_is_refused(self) -> None:
        for field, bad in (("independent", False), ("executor_assertion", True)):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as raw:
                directory = Path(raw)
                _, value = self.document(directory)
                value["reviews"][0][field] = bad
                path = self.write(directory, value)
                with self.assertRaises(ValueError) as raised:
                    self.sealer.validate_independent_review(path, self.COMMIT, self.TREE)
                self.assertIn("independent reviewer outcome", str(raised.exception))

    def test_evidence_digest_drift_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            path, _ = self.document(directory)
            (directory / "reliability.md").write_text("tampered\n", encoding="ascii")
            with self.assertRaises(ValueError) as raised:
                self.sealer.validate_independent_review(path, self.COMMIT, self.TREE)
        self.assertIn("evidence bytes drifted", str(raised.exception))

    def test_verdict_and_findings_must_agree(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            _, value = self.document(directory)
            value["reviews"][1]["verdict"] = "PASS_WITH_LOW_FINDINGS"
            path = self.write(directory, value)
            with self.assertRaises(ValueError) as raised:
                self.sealer.validate_independent_review(path, self.COMMIT, self.TREE)
            self.assertIn("lists none", str(raised.exception))
            value["reviews"][0]["verdict"] = "PASS"
            value["reviews"][1]["verdict"] = "PASS"
            path = self.write(directory, value)
            with self.assertRaises(ValueError) as raised:
                self.sealer.validate_independent_review(path, self.COMMIT, self.TREE)
            self.assertIn("cannot carry residual findings", str(raised.exception))

    def test_unaccepted_verdict_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            _, value = self.document(directory)
            value["reviews"][0]["verdict"] = "REPAIR_REQUIRED"
            path = self.write(directory, value)
            with self.assertRaises(ValueError) as raised:
                self.sealer.validate_independent_review(path, self.COMMIT, self.TREE)
        self.assertIn("not an accepted outcome", str(raised.exception))

    def test_acceptance_template_cannot_masquerade_as_review_evidence(self) -> None:
        template = ROOT / "acceptance-record.template.json"
        self.assertTrue(template.is_file())
        with self.assertRaises(ValueError) as raised:
            self.sealer.validate_independent_review(template, self.COMMIT, self.TREE)
        self.assertIn("outside the builder tree", str(raised.exception))

    def test_evidence_filename_cannot_displace_sealed_bundle_content(self) -> None:
        for reserved in ("human-manifest.md", "independent-review.v1.json"):
            with self.subTest(reserved=reserved), tempfile.TemporaryDirectory() as raw:
                directory = Path(raw)
                _, value = self.document(directory)
                target = directory / reserved
                target.write_text("displacing content\n", encoding="ascii")
                raw_bytes = target.read_bytes()
                value["reviews"][0]["evidence"] = {
                    "path": reserved,
                    "sha256": hashlib.sha256(raw_bytes).hexdigest(),
                    "bytes": len(raw_bytes),
                }
                path = self.write(directory, value)
                with self.assertRaises(ValueError) as raised:
                    self.sealer.validate_independent_review(path, self.COMMIT, self.TREE)
                self.assertIn("collides with sealed bundle content", str(raised.exception))

    def test_two_reviews_cannot_share_one_evidence_filename(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            _, value = self.document(directory)
            value["reviews"][1]["evidence"] = dict(value["reviews"][0]["evidence"])
            path = self.write(directory, value)
            with self.assertRaises(ValueError) as raised:
                self.sealer.validate_independent_review(path, self.COMMIT, self.TREE)
        self.assertIn("collides with sealed bundle content", str(raised.exception))

    def test_package_output_verifier_gates_the_same_review_contract(self) -> None:
        """R6-02: the gate that runs against the built package is itself pinned."""
        verifier = (ROOT / "packaging/verify-sealed-inputs.py").read_text(encoding="ascii")
        for required in (
            'REVIEW_SCHEMA = "yoko.crm.coordinated-runtime-independent-review.v1"',
            'REVIEW_ROLES = ("release-reliability", "privileged-runtime-security")',
            'release seal carries no independent review acceptance',
            'independent review acceptance contract mismatch',
            'independent review is not bound to the sealed candidate',
            'release seal accepts a blocking review finding',
            'independent review does not cover the exact required roles',
            'independent review verdict is not an accepted outcome',
            'independent review residual finding severity is not accepted',
            'independent review residual finding count is stale',
            'independent review document binding invalid',
        ):
            with self.subTest(required=required[:48]):
                self.assertIn(required, verifier)
        # the gate must sit on the package-output phase, not only on the sealer's own value
        self.assertLess(verifier.index('args.phase == "package-output"'),
                        verifier.index("release seal carries no independent review acceptance"))

    def test_sealer_requires_the_review_input_and_emits_no_pending(self) -> None:
        source = (ROOT / "packaging/seal-release.py").read_text(encoding="ascii")
        self.assertIn('parser.add_argument("--independent-review", required=True', source)
        self.assertNotIn('"independent_review": "PENDING"', source)


if __name__ == "__main__":
    unittest.main()
