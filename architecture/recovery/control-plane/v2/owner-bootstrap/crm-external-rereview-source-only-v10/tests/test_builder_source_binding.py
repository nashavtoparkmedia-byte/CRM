#!/usr/bin/python3
from __future__ import annotations

import importlib.machinery
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AcceptedBuilderSourceBindingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        loader = importlib.machinery.SourceFileLoader(
            "yoko_runtime_v10_builder_source_binding",
            str(ROOT / "packaging/seal-release.py"),
        )
        spec = importlib.util.spec_from_loader(loader.name, loader)
        assert spec is not None
        cls.sealer = importlib.util.module_from_spec(spec)
        sys.modules[loader.name] = cls.sealer
        loader.exec_module(cls.sealer)

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="yoko-builder-source-bind-")
        base = Path(self.temporary.name)
        self.repo = base / "repo"
        self.stage = base / "stage"
        subprocess.run(["/usr/bin/git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(["/usr/bin/git", "-C", str(self.repo), "config", "user.name", "Runtime Test"], check=True)
        subprocess.run(["/usr/bin/git", "-C", str(self.repo), "config", "user.email", "runtime@example.invalid"], check=True)
        source = self.repo / self.sealer.RUNTIME_SOURCE_PREFIX
        (source / "packaging").mkdir(parents=True)
        (source / "templates").mkdir()
        (source / "packaging/seal-release.py").write_bytes(b"#!/usr/bin/python3\nprint('accepted')\n")
        (source / "templates/profile.json.in").write_bytes(b'{"accepted":true}\n')
        os.chmod(source / "packaging/seal-release.py", 0o755)
        os.chmod(source / "templates/profile.json.in", 0o600)
        subprocess.run(["/usr/bin/git", "-C", str(self.repo), "add", "."], check=True)
        subprocess.run(["/usr/bin/git", "-C", str(self.repo), "commit", "-q", "-m", "accepted builder"], check=True)
        self.commit = subprocess.check_output(
            ["/usr/bin/git", "-C", str(self.repo), "rev-parse", "HEAD"], text=True,
        ).strip()
        shutil.copytree(source, self.stage)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_complete_exact_commit_subtree_is_bound(self) -> None:
        result = self.sealer.bind_builder_source(self.repo, self.commit, self.stage)
        self.assertEqual(result["file_count"], 2)
        self.assertEqual(
            {row["path"] for row in result["files"]},
            {
                f"{self.sealer.RUNTIME_SOURCE_PREFIX}/packaging/seal-release.py",
                f"{self.sealer.RUNTIME_SOURCE_PREFIX}/templates/profile.json.in",
            },
        )

    def test_commit_without_runtime_subtree_fails_closed(self) -> None:
        empty_repo = Path(self.temporary.name) / "empty-repo"
        subprocess.run(["/usr/bin/git", "init", "-q", str(empty_repo)], check=True)
        subprocess.run(["/usr/bin/git", "-C", str(empty_repo), "config", "user.name", "Runtime Test"], check=True)
        subprocess.run(["/usr/bin/git", "-C", str(empty_repo), "config", "user.email", "runtime@example.invalid"], check=True)
        (empty_repo / "unrelated.txt").write_text("accepted but unrelated\n")
        subprocess.run(["/usr/bin/git", "-C", str(empty_repo), "add", "."], check=True)
        subprocess.run(["/usr/bin/git", "-C", str(empty_repo), "commit", "-q", "-m", "no builder"], check=True)
        commit = subprocess.check_output(
            ["/usr/bin/git", "-C", str(empty_repo), "rev-parse", "HEAD"], text=True,
        ).strip()
        with self.assertRaisesRegex(SystemExit, "lacks the Runtime v10 builder subtree"):
            self.sealer.bind_builder_source(empty_repo, commit, self.stage)

    def test_byte_missing_mode_link_and_untracked_drift_fail_closed(self) -> None:
        script = self.stage / "packaging/seal-release.py"
        template = self.stage / "templates/profile.json.in"

        mutations = {
            "byte": lambda: script.write_bytes(b"#!/usr/bin/python3\nprint('substituted')\n"),
            "missing": script.unlink,
            "executable": lambda: os.chmod(script, 0o644),
            "group-writable": lambda: os.chmod(template, 0o620),
            "symlink": lambda: (template.unlink(), template.symlink_to("/etc/passwd")),
            "untracked-executable": lambda: (
                (self.stage / "packaging/substitute.py").write_text("print('unreviewed')\n"),
                os.chmod(self.stage / "packaging/substitute.py", 0o755),
            ),
        }
        for label, mutation in mutations.items():
            with self.subTest(label=label):
                shutil.rmtree(self.stage)
                shutil.copytree(self.repo / self.sealer.RUNTIME_SOURCE_PREFIX, self.stage)
                mutation()
                with self.assertRaises(SystemExit):
                    self.sealer.bind_builder_source(self.repo, self.commit, self.stage)

    def test_git_symlink_is_not_an_accepted_builder_blob(self) -> None:
        source = self.repo / self.sealer.RUNTIME_SOURCE_PREFIX
        link = source / "templates/substitution.in"
        link.symlink_to("profile.json.in")
        subprocess.run(["/usr/bin/git", "-C", str(self.repo), "add", "."], check=True)
        subprocess.run(["/usr/bin/git", "-C", str(self.repo), "commit", "-q", "-m", "unsafe symlink"], check=True)
        unsafe_commit = subprocess.check_output(
            ["/usr/bin/git", "-C", str(self.repo), "rev-parse", "HEAD"], text=True,
        ).strip()
        shutil.rmtree(self.stage)
        shutil.copytree(source, self.stage, symlinks=True)
        with self.assertRaisesRegex(SystemExit, "unsafe entry"):
            self.sealer.bind_builder_source(self.repo, unsafe_commit, self.stage)


if __name__ == "__main__":
    unittest.main()
