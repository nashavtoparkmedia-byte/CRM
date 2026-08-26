#!/usr/bin/python3
from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "packaging/predecessor-observability-v1"


class PredecessorObservabilityPackageTests(unittest.TestCase):
    def test_builder_is_exact_installed_repair_bound_and_double_deterministic(self) -> None:
        value = (PACKAGE / "build-package.sh").read_text()
        for identity in (
            "544e6d5ace56ab737475ad316e17f6ac12a15ed7706c7f25f1bf97639c2ab7bc",
            "0f97bafbfe5b430fa7994119b1fc76fead4bdbee26766c730d9e399551ebdffa",
            "0c948717cf6665cf443e37d2d742dfb99beb3961485506cfbb6cc6a4cd6eeb82",
            "b870bb3cf1ad35cabd1c58c189232af5c01d683687ffca1d55a86ceb397afa59",
            "b5ea36c50e12b0fe6c171896258ddfc00a9d2666778735cae6a9b2a8df6d4084",
            "6865eab377dda757d101259e7321268998b45ea8b27f6003de0cf7e191a9b54e",
        ):
            self.assertIn(identity, value)
        self.assertIn('"$WORK/a.deb"', value)
        self.assertIn('"$WORK/b.deb"', value)
        self.assertIn('/usr/bin/cmp "$WORK/a.deb" "$WORK/b.deb"', value)
        self.assertIn("--root-owner-group --build -Zgzip -z9", value)
        self.assertIn("audit-data-tar.py", value)
        self.assertIn("test-visudo.sh", value)
        self.assertIn("staged package data allowlist mismatch", value)
        self.assertIn('"$LIBEXEC/__pycache__"', value)
        self.assertIn("source tree must be a clean exact commit", value)

    def test_installer_is_idempotent_and_has_exact_automatic_rollback(self) -> None:
        value = (PACKAGE / "install-package.sh.in").read_text()
        self.assertIn("if new_state_ok; then", value)
        self.assertIn("if previous_state_ok; then", value)
        self.assertIn("previous_runtime_self_check", value)
        self.assertIn("PREDECESSOR_OBSERVABILITY_ALREADY_INSTALLED", value)
        self.assertIn("rollback_exact", value)
        self.assertIn("/usr/bin/dpkg --install \"$ROLLBACK_DEB\"", value)
        self.assertIn("ROLLBACK_DEB_SHA256='6865eab377", value)
        self.assertIn("compare_production_identity", value)
        self.assertIn("production_mutated=false", value)
        self.assertNotIn("release-activate", value)
        self.assertNotIn("service-restart", value)
        self.assertNotIn("database-migrate", value)

    def test_package_privilege_delta_is_one_zero_argument_command(self) -> None:
        sudoers = (ROOT / "packaging/92-yoko-privileged-runtime").read_text()
        matches = re.findall(
            r"/usr/local/sbin/yoko-privileged-runtime predecessor-observe(?:,|\n)",
            sudoers,
        )
        self.assertEqual(len(matches), 1)
        self.assertNotIn("predecessor-observe *", sudoers)
        core = (ROOT / "src/yoko-privileged-runtime-core.py").read_text()
        self.assertIn('"predecessor-observe"}', core)
        self.assertNotRegex(core, r'predecessor-observe"\s*,\s*"[^\"]+"')

    def test_interim_package_preserves_profile_and_policy(self) -> None:
        value = (PACKAGE / "build-package.sh").read_text()
        self.assertIn('INSTALLED_PROFILE_RUNTIME', value)
        self.assertIn('for name in profile.v1.json source.tar.gz gravity-image.docker.tar sealed-inputs.v1.json migration.sql', value)
        self.assertIn("OLD_POLICY_SHA256='8727373", value)
        self.assertNotIn('src/crm-activation-profile.py" "$LIBEXEC/$PROFILE_ID.py', value)
        readme = (PACKAGE / "README.md").read_text()
        self.assertIn("activation and rollback semantics are otherwise byte-identical", readme)
        self.assertIn("never enumerates the\ncontents of `crm_tg_bot_data`", readme)

    def test_installer_template_requires_every_generated_identity(self) -> None:
        value = (PACKAGE / "install-package.sh.in").read_text()
        for token in (
            "PACKAGE_PATH", "PACKAGE_SHA256", "SOURCE_COMMIT", "NEW_RUNTIME_SHA256",
            "NEW_CORE_SHA256", "NEW_OBSERVER_SHA256", "NEW_POLICY_SHA256",
            "NEW_SUDOERS_SHA256", "NEW_INSTALL_MANIFEST_SHA256",
            "NEW_PROFILE_RUNTIME_SHA256", "NEW_PROFILE_MANIFEST_SHA256",
        ):
            self.assertIn(f"@{token}@", value)
        self.assertIn("package_identity_ok", value)
        self.assertIn("new_state_ok", value)
        self.assertIn("old_state_ok", value)
        self.assertIn("previous_state_ok", value)


if __name__ == "__main__":
    unittest.main()
