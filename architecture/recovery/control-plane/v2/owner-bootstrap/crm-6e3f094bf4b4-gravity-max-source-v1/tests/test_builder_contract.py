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
        create = sealer.index("review.mkdir(parents=True, mode=0o700)")
        write = sealer.index('copy_exact(ROOT / "human-manifest.md", review / "human-manifest.md", 0o400)')
        close = sealer.index("review.chmod(0o500)")
        self.assertLess(create, write)
        self.assertLess(write, close)

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


if __name__ == "__main__":
    unittest.main()
