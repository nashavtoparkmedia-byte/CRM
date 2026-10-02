#!/usr/bin/python3
"""Contract tests for the predecessor-observation-v2 interim root installer."""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = (ROOT / "packaging/predecessor-observability-v2/install-package.sh.in").read_text(encoding="ascii")
BUILDER = (ROOT / "packaging/predecessor-observability-v2/build-package.sh").read_text(encoding="ascii")


def lock_block() -> str:
    start = INSTALLER.index("# BEGIN BOOTSTRAP LOCK")
    end = INSTALLER.index("# END BOOTSTRAP LOCK")
    return INSTALLER[start:end]


class InterimInstallerContractTests(unittest.TestCase):
    def run_lock_gate(self, directory: Path) -> subprocess.CompletedProcess[bytes]:
        script = (
            "set -eu\n"
            f"BOOTSTRAP_LOCK_DIR='{directory}'\n"
            f"BOOTSTRAP_LOCK='{directory}/coordinated-bootstrap.lock'\n"
            + lock_block()
            + "echo LOCK_ACQUIRED\n"
        )
        return subprocess.run(["/bin/sh", "-c", script], capture_output=True, timeout=60)

    def test_caller_owned_lock_directory_aborts_before_opening_the_lock(self) -> None:
        if os.geteuid() == 0:
            self.skipTest("the gate is proven against a non-root owner")
        with tempfile.TemporaryDirectory() as raw:
            decoy = Path(raw) / "decoy"
            decoy.write_text("must survive\n", encoding="ascii")
            directory = Path(raw) / "lockdir"
            directory.mkdir(mode=0o700)
            (directory / "coordinated-bootstrap.lock").symlink_to(decoy)
            completed = self.run_lock_gate(directory)
            self.assertEqual(completed.returncode, 78, completed.stderr)
            self.assertIn(b"BOOTSTRAP_LOCK_DIRECTORY_UNSAFE", completed.stderr)
            self.assertNotIn(b"LOCK_ACQUIRED", completed.stdout)
            self.assertEqual(decoy.read_text(encoding="ascii"), "must survive\n")

    def test_symlinked_or_missing_lock_directory_aborts(self) -> None:
        if os.geteuid() == 0:
            self.skipTest("the gate is proven against a non-root owner")
        with tempfile.TemporaryDirectory() as raw:
            target = Path(raw) / "target"
            target.mkdir(mode=0o700)
            link = Path(raw) / "link"
            link.symlink_to(target, target_is_directory=True)
            self.assertEqual(self.run_lock_gate(link).returncode, 78)
            # A directory this caller creates is caller-owned, never root 0:0:700.
            self.assertEqual(self.run_lock_gate(Path(raw) / "absent").returncode, 78)

    def test_lock_gates_are_individually_aborting(self) -> None:
        for line in lock_block().splitlines():
            stripped = line.strip()
            if stripped.startswith("[") and "&&" in stripped:
                self.fail(f"AND-list gate does not abort under set -e: {stripped}")

    def test_dpkg_only_installs_the_verified_private_copy_or_the_exact_original(self) -> None:
        targets = re.findall(r"/usr/bin/dpkg --install (\S+)", INSTALLER)
        self.assertEqual(sorted(set(targets)), ['"$PRIVATE_PACKAGE"', '"$ROLLBACK_DEB"'])
        self.assertEqual(INSTALLER.count('"$PACKAGE_PATH"'), 1)
        self.assertIn('private_copy "$PACKAGE_PATH" "$PRIVATE_PACKAGE"', INSTALLER)
        self.assertIn('package_identity_ok "$PRIVATE_PACKAGE" || fail OBSERVABILITY_PACKAGE_IDENTITY_CHANGED', INSTALLER)
        self.assertIn("os.O_NOFOLLOW", INSTALLER)

    def test_failures_after_dpkg_restore_the_original(self) -> None:
        after = INSTALLER[INSTALLER.index("attempted=1\n"):]
        for line in after.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith(("attempted=", "echo ")):
                continue
            self.assertTrue(stripped.endswith(tuple(["_FAILED", "_CHANGED"])) and "|| fail " in stripped, stripped)
        self.assertIn('capture_identity "$WORK/after" || fail PRODUCTION_IDENTITY_CAPTURE_FAILED', INSTALLER)
        self.assertIn("trap on_exit EXIT", INSTALLER)
        self.assertIn("trap 'exit 129' HUP INT TERM", INSTALLER)
        self.assertIn('if [ "$rc" -ne 0 ] && [ "$attempted" = 1 ] && [ "$handled" = 0 ]; then', INSTALLER)

    def test_rollback_cannot_be_interrupted_and_copies_are_bounded(self) -> None:
        fail = INSTALLER[INSTALLER.index("fail() {"):]
        self.assertTrue(fail.split("\n")[1].strip() == "trap '' HUP INT TERM")
        on_exit = INSTALLER[INSTALLER.index("on_exit() {"):INSTALLER.index("trap on_exit EXIT")]
        self.assertLess(on_exit.index("trap '' HUP INT TERM"), on_exit.index("rollback_exact"))
        self.assertIn("PREDECESSOR_OBSERVABILITY_V2_NOT_INSTALLED", on_exit)
        self.assertIn("value.st_size>MAXIMUM", INSTALLER)
        self.assertIn("if total>MAXIMUM", INSTALLER)
        self.assertIn("/usr/bin/head -c 1048576 -- '$INSTALLER'", BUILDER)

    def test_store_is_published_atomically_and_forgotten_on_rollback(self) -> None:
        self.assertIn('mktemp -d "$STORE/.interim-staging.XXXXXX"', INSTALLER)
        self.assertIn('/usr/bin/mv -T -- "$staging" "$INTERIM_STORE"', INSTALLER)
        self.assertEqual(INSTALLER.count("forget_store || true"), 2)

    def test_owner_command_runs_a_verified_root_owned_copy(self) -> None:
        self.assertIn("/usr/bin/mktemp -d /root/yoko-observer-v2-install.XXXXXX", BUILDER)
        self.assertIn('/usr/bin/chmod 0500 \\"\\$D/install.sh\\"', BUILDER)
        self.assertNotIn("&& /bin/sh '$INSTALLER'", BUILDER)

    def test_every_template_token_is_rendered(self) -> None:
        tokens = set(re.findall(r"@([A-Z0-9_]+)@", INSTALLER))
        rendered = set(re.findall(r"'([A-Z0-9_]+)':", BUILDER[BUILDER.index("tokens={"):]))
        self.assertTrue(tokens)
        self.assertLessEqual(tokens, rendered)


if __name__ == "__main__":
    unittest.main()
