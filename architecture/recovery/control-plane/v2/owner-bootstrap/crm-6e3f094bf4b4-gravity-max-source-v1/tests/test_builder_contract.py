#!/usr/bin/python3
from __future__ import annotations

import hashlib
import json
import re
import subprocess
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

    def test_snapshot_template_matches_capture_document_shape(self) -> None:
        value = json.loads((ROOT / "production-snapshot.template.json").read_text(encoding="ascii"))
        self.assertEqual(set(value), {"schema", "started_at", "completed_at", "production_mutated", "secret_values_emitted", "commands", "sealing"})
        self.assertFalse(value["production_mutated"])
        self.assertFalse(value["secret_values_emitted"])


if __name__ == "__main__":
    unittest.main()
