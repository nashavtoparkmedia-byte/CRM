#!/usr/bin/python3
"""Contract tests for the Owner bootstrap installer's failure and signal recovery."""
from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = (ROOT / "templates/install.sh.in").read_text(encoding="ascii")
HELPERS = ("old_identity", "new_identity", "audit_exact", "stored_deb_exact", "rollback_previous", "clear_guard")


def body(name: str) -> list[str]:
    start = INSTALLER.index(f"\n{name}() {{\n") + len(f"\n{name}() {{\n")
    end = INSTALLER.index("\n}\n", start)
    return INSTALLER[start:end].splitlines()


class OwnerInstallerRecoveryContractTests(unittest.TestCase):
    def test_installer_is_valid_bash(self) -> None:
        completed = subprocess.run(["/bin/bash", "-n", str(ROOT / "templates/install.sh.in")], capture_output=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_every_helper_step_propagates_failure_from_condition_contexts(self) -> None:
        # bash disables errexit inside a function called from `||`/`if`; each step returns explicitly.
        for name in HELPERS:
            for line in body(name):
                stripped = line.strip()
                if not stripped or stripped.startswith(("#", "local ", "if ", "fi", "guard_owned=", "guard_identity=")):
                    continue
                self.assertTrue(stripped.endswith("|| return 1"), f"{name}: {stripped}")

    def test_identities_require_an_installed_package_status(self) -> None:
        self.assertIn("-f='${Status} ${Version}' yoko-privileged-runtime 2>/dev/null)\" = 'install ok installed 2.0.0-22' || return 1", INSTALLER)
        self.assertIn("-f='${Status} ${Version}' yoko-privileged-runtime 2>/dev/null)\" = 'install ok installed 2.0.0-23' || return 1", INSTALLER)

    def test_signals_leave_through_the_rollback_trap_with_a_failure_status(self) -> None:
        for signal, status in (("HUP", 129), ("INT", 130), ("QUIT", 131), ("TERM", 143)):
            self.assertIn(f"trap 'exit {status}' {signal}", INSTALLER)
        on_exit = INSTALLER[INSTALLER.index("on_exit() {"):INSTALLER.index("trap on_exit EXIT")]
        self.assertLess(on_exit.index("trap '' INT TERM HUP QUIT"), on_exit.index("rollback_previous"))
        self.assertIn('if [ "$rc" -ne 0 ] && [ "$new_attempted" -eq 1 ]; then', on_exit)

    def test_a_failed_rollback_keeps_the_guard(self) -> None:
        on_exit = INSTALLER[INSTALLER.index("on_exit() {"):INSTALLER.index("trap on_exit EXIT")]
        branch = on_exit[on_exit.index("if rollback_previous; then"):on_exit.index("        fi\n        exit")]
        success, failure = branch.split("else", 1)
        self.assertIn("clear_guard", success)
        self.assertNotIn("clear_guard", failure)
        self.assertIn("GUARD_KEPT", failure)

    def test_signal_during_a_failing_step_runs_the_exit_trap_with_failure(self) -> None:
        # Behavioural model of the trap layout: a TERM while a step runs must reach the EXIT trap
        # with a non-zero status (the defect was rc=0, which skipped rollback).
        script = (
            "set -euo pipefail\n"
            "on_exit() { local rc=$?; trap '' INT TERM HUP QUIT; trap - EXIT; echo \"EXIT_RC=$rc\"; exit \"$rc\"; }\n"
            "trap on_exit EXIT\n"
            + "\n".join(re.findall(r"^trap 'exit \d+' [A-Z]+$", INSTALLER, re.M))
            + "\nkill -TERM $$\nsleep 5\necho UNREACHABLE\n"
        )
        completed = subprocess.run(["/bin/bash", "-c", script], capture_output=True, timeout=30)
        self.assertEqual(completed.returncode, 143)
        self.assertIn(b"EXIT_RC=143", completed.stdout)
        self.assertNotIn(b"UNREACHABLE", completed.stdout)


if __name__ == "__main__":
    unittest.main()
