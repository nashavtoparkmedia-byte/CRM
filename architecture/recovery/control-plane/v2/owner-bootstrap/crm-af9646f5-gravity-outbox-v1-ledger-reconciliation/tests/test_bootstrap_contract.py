#!/usr/bin/python3
from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = (ROOT / "bundle/payload/install.sh").read_text(encoding="utf-8")
POSTINST = (ROOT / "packaging/postinst").read_text(encoding="utf-8")


class BootstrapContractTests(unittest.TestCase):
    def test_installer_is_zero_argument_fixed_location_and_offline(self) -> None:
        self.assertIn("test \"$#\" -eq 0", INSTALLER)
        self.assertIn("EXPECTED_DIR=$(/bin/pwd -P)", INSTALLER)
        self.assertIn("yoko-crm-bootstrap-stage", INSTALLER)
        self.assertIn("readlink -f -- \"$0\"", INSTALLER)
        for forbidden in ("curl ", "wget ", "git clone", "git pull", "apt-get", "ssh ", "scp "):
            self.assertNotIn(forbidden, INSTALLER)

    def test_bootstrap_does_not_invoke_profiles_or_production_tools(self) -> None:
        mutation_verbs = (" database-status", " database-migrate", " release-preflight", " release-activate", " rollback")
        install_body = INSTALLER.split("old_identity()", 1)[0] + INSTALLER.split("rollback_previous()", 1)[0]
        for verb in mutation_verbs:
            self.assertNotIn(verb, install_body)
        for forbidden in ("docker compose", "docker restart", "pg_dump", "pg_restore", "psql ", "/opt/crm"):
            self.assertNotIn(forbidden, INSTALLER)
            self.assertNotIn(forbidden, POSTINST)

    def test_failure_path_reinstalls_and_proves_exact_predecessor(self) -> None:
        self.assertIn('/usr/bin/dpkg --install "$EXPECTED_DIR/$OLD_DEB"', INSTALLER)
        self.assertIn("${db:Status-Abbrev} ${Version}", INSTALLER)
        for digest in (
            "597f58d813f7a0f3631b9d1778588db880c00e7df97d92a51cef385f8f4d8ba0",
            "bb4f9ef5f35c2054ab4a9169083191849f988886ddaa2c8afa66b7727389b185",
            "8727373b0c6ec79c9abf82f1aaaa58abc2bae67e96aa96a602ac419f308db0e0",
            "a9aae93899ea9d69f895bb476208c720491d33a689bf9c91348e11acd0b955ad",
            "6e6b7cb2a088cc92fa7aee747adca46c64b4b96d1224be21117be5adef488c06",
        ):
            self.assertIn(digest, INSTALLER)
        self.assertIn("2.0.0-6", INSTALLER)
        self.assertIn("2.0.0-7", INSTALLER)
        self.assertIn("YOKO_ACTIVATION_BOOTSTRAP_FAILED", INSTALLER)
        self.assertGreaterEqual(INSTALLER.count("|| return 1"), 10)

    def test_postinstall_checks_capabilities_and_effective_negative_sudo(self) -> None:
        self.assertIn("enabled_activation_profiles", POSTINST)
        for denied in ("/bin/sh -c ':'", "/usr/bin/docker ps", "/usr/bin/dpkg --status sudo", "self-check unexpected", '"$verb" unexpected', "fs-stat ../../../etc", "service-restart crm.container.unrelated"):
            self.assertIn(denied, POSTINST)
        self.assertNotIn("release-preflight >/", POSTINST)

    def test_no_generic_bootstrap_grant_or_wildcard_is_created(self) -> None:
        joined = INSTALLER + POSTINST
        for forbidden in ("NOPASSWD: ALL", "sudo ALL", "chmod 0777", "chown codexbot", "setfacl", "usermod", "docker.sock"):
            self.assertNotIn(forbidden, joined)
        self.assertFalse(re.search(r"/usr/local/sbin/yoko-privileged-runtime \*", joined))

    def test_interrupted_bootstrap_is_exactly_reconcilable(self) -> None:
        self.assertIn("ALREADY_INSTALLED", INSTALLER)
        self.assertIn('if [ -e "$store" ]', INSTALLER)
        self.assertIn("if new_identity; then", INSTALLER)
        self.assertIn('if audit_empty && [ "$store_present" -eq 1 ]', INSTALLER)
        self.assertIn("if rollback_previous; then", INSTALLER)
        self.assertIn("reconcile_stored_file", INSTALLER)
        self.assertIn("stored_file_exact", INSTALLER)
        self.assertIn("BOOTSTRAP_GUARD", INSTALLER)
        self.assertIn("clear_guard", INSTALLER)
        valid_successor = INSTALLER.split("if new_identity; then", 1)[1].split("new_attempted=1", 1)[0]
        self.assertIn("Never\n        # downgrade or otherwise mutate", valid_successor)
        self.assertIn("exit 1", valid_successor)
        self.assertNotIn("rollback_previous", valid_successor)
        self.assertNotIn('test ! -e "$store"', INSTALLER)


if __name__ == "__main__":
    unittest.main(verbosity=2)
