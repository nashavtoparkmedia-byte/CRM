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
            "ababe50bcb0d3597786b1c77118867b1d700a5629bb2719892ce5ae4927a4738",
            "50bea3ae95d823cb5fc389d8b68a3a7ce3c1d51d0f86559c3a630bd956dd25d2",
            "8727373b0c6ec79c9abf82f1aaaa58abc2bae67e96aa96a602ac419f308db0e0",
            "fcf71910c0b55a44264b7a847537d422a950f2f0f3fcf260f486d4182f397e51",
            "6e6b7cb2a088cc92fa7aee747adca46c64b4b96d1224be21117be5adef488c06",
        ):
            self.assertIn(digest, INSTALLER)
        self.assertIn("2.0.0-7", INSTALLER)
        self.assertIn("2.0.0-8", INSTALLER)
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
        self.assertIn('if audit_exact && [ "$store_present" -eq 1 ]', INSTALLER)
        self.assertIn("record_count\"]==9", INSTALLER)
        self.assertIn("ade04359a4a016ec3fb8c9b66063f138e5a5882cd38dd7d64160d0a757839e6d", INSTALLER)
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
