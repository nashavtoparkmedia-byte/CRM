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
            ["git", "-C", str(REPOSITORY), "rev-parse", "7d3b7f175ddebc7db3a9a3fbced24957f1be7c16^{tree}"],
            check=True, text=True, stdout=subprocess.PIPE,
        ).stdout.strip()
        self.assertEqual(accepted, "4bec65fe7e800062700abf1af3abe64b8fecc1d9")

    def test_stage_a_verifier_cannot_dirty_the_runtime_builder(self) -> None:
        sealer = (ROOT / "packaging/seal-release.py").read_text(encoding="ascii")
        self.assertIn('"/usr/bin/python3", "-I", "-B", str(verifier)', sealer)

    def test_review_directory_is_writable_only_during_staging(self) -> None:
        sealer = (ROOT / "packaging/seal-release.py").read_text(encoding="ascii")
        create = sealer.index("review_directory.mkdir(parents=True, mode=0o700)")
        write = sealer.index('copy_exact(ROOT / "human-manifest.md", review_directory / "human-manifest.md", 0o400)')
        evidence = sealer.index('review_directory / f"{entry[\'role\']}-evidence"')
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
            "profile_id": "crm-7d3b7f175dde-gravity-max-source-v1",
            "package_version": "2.0.0-16",
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

    def test_release_verifier_behaviourally_refuses_every_bad_seal(self) -> None:
        """R6R1-01: exercise the gate, do not merely grep it. An inverted verifier fails here."""
        import importlib.machinery
        import importlib.util

        loader = importlib.machinery.SourceFileLoader(
            "yoko_verify_sealed_inputs_tests", str(ROOT / "packaging/verify-sealed-inputs.py")
        )
        spec = importlib.util.spec_from_loader(loader.name, loader)
        assert spec is not None
        verifier = importlib.util.module_from_spec(spec)
        sys.modules[loader.name] = verifier
        loader.exec_module(verifier)

        head, tree = "a" * 40, "b" * 40
        stage = tempfile.TemporaryDirectory()
        self.addCleanup(stage.cleanup)
        packed = Path(stage.name) / "bundle/payload/review"
        packed.mkdir(parents=True)
        document_bytes = b"review document\n"
        (packed / "independent-review.v1.json").write_bytes(document_bytes)
        evidence_bytes = {}
        for role in ("release-reliability", "privileged-runtime-security"):
            raw = f"{role} transcript\n".encode()
            (packed / f"{role}-evidence").write_bytes(raw)
            evidence_bytes[role] = raw
        verifier.GENERATED = Path(stage.name)
        digest = lambda raw: hashlib.sha256(raw).hexdigest()

        def seal(**overrides):
            review = {
                "status": "ACCEPTED",
                "schema": "yoko.crm.coordinated-runtime-independent-review.v1",
                "document": {"path": "independent-review.v1.json", "sha256": digest(document_bytes)},
                "candidate_commit": head, "candidate_tree": tree,
                "reviews": [
                    {"role": "release-reliability", "reviewer": "R1", "verdict": "PASS_WITH_LOW_FINDINGS",
                     "reviewed_at": "2026-09-10T00:00:00Z",
                     "evidence": {"path": "a.md", "packed": "release-reliability-evidence",
                                  "sha256": digest(evidence_bytes["release-reliability"]),
                                  "bytes": len(evidence_bytes["release-reliability"])},
                     "residual_findings": [{"id": "X", "severity": "LOW", "title": "residual"}]},
                    {"role": "privileged-runtime-security", "reviewer": "R2", "verdict": "PASS",
                     "reviewed_at": "2026-09-10T00:00:00Z",
                     "evidence": {"path": "b.md", "packed": "privileged-runtime-security-evidence",
                                  "sha256": digest(evidence_bytes["privileged-runtime-security"]),
                                  "bytes": len(evidence_bytes["privileged-runtime-security"])},
                     "residual_findings": []},
                ],
                "residual_low_findings": 1, "blocking_findings": 0,
            }
            review.update(overrides)
            return {"independent_review": review}

        self.assertEqual(verifier.validate_release_review(seal(), head, tree), 1)

        cases = {
            "no acceptance": ({}, "carries no independent review acceptance"),
            "status not accepted": ({"status": "PENDING"}, "acceptance contract mismatch"),
            "wrong schema": ({"schema": "yoko.crm.coordinated-runtime-acceptance.v1"}, "acceptance contract mismatch"),
            "other candidate": ({"candidate_commit": "f" * 40}, "not bound to the sealed candidate"),
            "other tree": ({"candidate_tree": "f" * 40}, "not bound to the sealed candidate"),
            "blocking accepted": ({"blocking_findings": 1}, "accepts a blocking review finding"),
            "residual count stale": ({"residual_low_findings": 0}, "residual finding count is stale"),
            "document binding": ({"document": {"path": "x"}}, "document binding invalid"),
        }
        for label, (override, message) in cases.items():
            with self.subTest(label=label):
                value = seal() if label != "no acceptance" else {"independent_review": None}
                if label != "no acceptance":
                    value["independent_review"].update(override)
                with self.assertRaises(ValueError) as raised:
                    verifier.validate_release_review(value, head, tree)
                self.assertIn(message, str(raised.exception))

        missing_role = seal()
        missing_role["independent_review"]["reviews"] = missing_role["independent_review"]["reviews"][:1]
        missing_role["independent_review"]["residual_low_findings"] = 1
        with self.assertRaises(ValueError) as raised:
            verifier.validate_release_review(missing_role, head, tree)
        self.assertIn("exact required roles", str(raised.exception))

        bad_verdict = seal()
        bad_verdict["independent_review"]["reviews"][1]["verdict"] = "REPAIR_REQUIRED"
        with self.assertRaises(ValueError) as raised:
            verifier.validate_release_review(bad_verdict, head, tree)
        self.assertIn("not an accepted outcome", str(raised.exception))

        bad_severity = seal()
        bad_severity["independent_review"]["reviews"][1]["residual_findings"] = [
            {"id": "Y", "severity": "HIGH", "title": "blocking"}
        ]
        with self.assertRaises(ValueError) as raised:
            verifier.validate_release_review(bad_severity, head, tree)
        self.assertIn("residual finding severity is not accepted", str(raised.exception))

        for label, blocking in (("json false", False), ("json float", 0.0), ("string", "0")):
            with self.subTest(label=label):
                value = seal()
                value["independent_review"]["blocking_findings"] = blocking
                with self.assertRaises(ValueError) as raised:
                    verifier.validate_release_review(value, head, tree)
                self.assertIn("accepts a blocking review finding", str(raised.exception))

        for label, findings in (("none", None), ("dict", {}), ("string", "LOW")):
            with self.subTest(label=label):
                value = seal()
                value["independent_review"]["reviews"][1]["residual_findings"] = findings
                with self.assertRaises(ValueError) as raised:
                    verifier.validate_release_review(value, head, tree)
                self.assertIn("explicit residual findings list", str(raised.exception))

        swapped = seal()
        swapped["independent_review"]["reviews"][0]["evidence"]["sha256"] = "f" * 64
        with self.assertRaises(ValueError) as raised:
            verifier.validate_release_review(swapped, head, tree)
        self.assertIn("packed independent review evidence does not match", str(raised.exception))

        forged = seal()
        forged["independent_review"]["document"]["sha256"] = "f" * 64
        with self.assertRaises(ValueError) as raised:
            verifier.validate_release_review(forged, head, tree)
        self.assertIn("packed independent review document does not match", str(raised.exception))

        one_reviewer = seal()
        one_reviewer["independent_review"]["reviews"][1]["reviewer"] = "R1"
        with self.assertRaises(ValueError) as raised:
            verifier.validate_release_review(one_reviewer, head, tree)
        self.assertIn("distinct reviewers", str(raised.exception))

    def test_compose_transcript_mode_is_pinned_to_0600(self) -> None:
        profile = (ROOT / "templates/crm-activation-profile.py.in").read_text(encoding="ascii")
        self.assertIn("os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600", profile)
        # inspect the _compose_up body specifically: both the open mode and its reassertion are 0600
        start = profile.index("def _compose_up(")
        body = profile[start:profile.index("\ndef ", start + 1)]
        self.assertIn("os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600", body)
        self.assertIn("os.fchmod(fd, 0o600)", body)
        self.assertNotIn("0o644", body)

    def test_packed_review_material_matches_the_installer_allowlist(self) -> None:
        """R7S-01: the bundle the sealer writes must be exactly what install.sh admits."""
        sealer = (ROOT / "packaging/seal-release.py").read_text(encoding="ascii")
        installer = (ROOT / "templates/install.sh.in").read_text(encoding="ascii")
        self.assertIn('review_directory / f"{entry[\'role\']}-evidence"', sealer)
        for name in ("review/human-manifest.md", "review/independent-review.v1.json",
                     "review/release-reliability-evidence", "review/privileged-runtime-security-evidence"):
            with self.subTest(name=name):
                self.assertIn(f'"{name}":0o400', installer)

    def test_release_phase_runs_after_the_seal_is_written(self) -> None:
        verifier = (ROOT / "packaging/verify-sealed-inputs.py").read_text(encoding="ascii")
        self.assertIn('choices=("package", "package-output", "release")', verifier)
        sealer = (ROOT / "packaging/seal-release.py").read_text(encoding="ascii")
        written = sealer.index('write_json(dist / "SEALED_RELEASE.json", release_seal)')
        packedreview = sealer.index('review_directory / f"{entry[\'role\']}-evidence"')
        checked = sealer.index('"--phase", "release"')
        self.assertLess(written, packedreview)
        self.assertLess(packedreview, checked)

    def test_sealer_requires_the_review_input_and_emits_no_pending(self) -> None:
        source = (ROOT / "packaging/seal-release.py").read_text(encoding="ascii")
        self.assertIn('parser.add_argument("--independent-review", required=True', source)
        self.assertNotIn('"independent_review": "PENDING"', source)

    def test_installer_only_names_files_the_sealer_actually_packs(self) -> None:
        """F1/F6: every $EXPECTED_DIR file the installer touches must exist in the payload.

        The rollback seal was renamed in the sealer and the installer allowlist but not in the
        installer's own digest check, which would have aborted every install path.
        """
        import re
        installer = (ROOT / "templates/install.sh.in").read_text(encoding="utf-8")
        sealer = (ROOT / "packaging/seal-release.py").read_text(encoding="utf-8")
        allowlist = set(re.findall(r'^\s*"([^"]+)":0o[0-7]+,', re.search(
            r"expected=\{(.*?)\n\}", installer, re.S).group(1), re.M))
        referenced = set(re.findall(r'\$EXPECTED_DIR/([A-Za-z0-9._-]+)', installer))
        self.assertTrue(referenced, "installer references no payload files")
        unpacked = {name for name in referenced if name not in allowlist and name != "$NEW_DEB"}
        self.assertEqual(unpacked, set(), f"installer names files absent from its own allowlist: {sorted(unpacked)}")
        for name in sorted(allowlist):
            if "/" in name or name == "payload-manifest.json":
                continue
            self.assertIn(name, sealer, f"sealer never writes payload member {name}")

    def test_every_installer_version_reference_agrees_with_the_package_being_installed(self) -> None:
        """B-1: the unpack-directory regex escapes its dots, so a literal grep for the version misses it.

        Collect every version literal in the installer, however it is written, and require each to be
        either the successor being installed or the predecessor being rolled back to — nothing else.
        """
        import re
        installer = (ROOT / "templates/install.sh.in").read_text(encoding="utf-8")
        new_version = re.search(r"NEW_DEB='yoko-privileged-runtime_([0-9.-]+)_all\.deb'", installer).group(1)
        old_version = re.search(r"OLD_DEB='yoko-privileged-runtime_([0-9.-]+)_all\.deb'", installer).group(1)
        self.assertNotEqual(new_version, old_version)
        found = {literal.replace("\\", "") for literal in re.findall(r"2(?:\\?\.)0(?:\\?\.)0-\d+", installer)}
        self.assertTrue(found, "installer names no version at all")
        self.assertEqual(found - {new_version, old_version}, set(),
                         f"installer names versions that are neither successor nor rollback: {sorted(found)}")
        unpack = re.search(r"yoko-coordinated-runtime-(2(?:\\?\.)0(?:\\?\.)0-\d+)", installer).group(1).replace("\\", "")
        self.assertEqual(unpack, new_version, "unpack directory names a different release than the package")

    def test_installer_rollback_seal_digest_is_rendered_not_hardcoded(self) -> None:
        installer = (ROOT / "templates/install.sh.in").read_text(encoding="utf-8")
        sealer = (ROOT / "packaging/seal-release.py").read_text(encoding="utf-8")
        self.assertIn("@ROLLBACK_SEAL_SHA256@", installer)
        self.assertIn('"@ROLLBACK_SEAL_SHA256@": ROLLBACK_SEAL_SHA', sealer)
        self.assertNotIn("8a7e28a3ad49ab6fb3be27e9bfa42d75aff6755b41a1d40119ce806026adb5ad", installer)


if __name__ == "__main__":
    unittest.main()
