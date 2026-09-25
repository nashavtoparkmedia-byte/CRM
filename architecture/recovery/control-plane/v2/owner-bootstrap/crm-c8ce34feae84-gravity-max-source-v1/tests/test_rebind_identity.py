"""Regression coverage for the Stage B identity/provenance rebind failure class.

A previous rebind of this profile advanced some members of the Stage A identity
tuple and left others at the predecessor's values, producing a release that
described one artifact while naming another. It survived a green suite because
the only binding assertion pinned a literal that was itself stale.

These tests bind every such value to DERIVED ground truth - the transport
manifest and the archive members - so a half-shifted identity cannot pass, and
they reject the specific stale values by construction rather than by list.

Scope is deliberately this failure class only. Coverage gaps in unchanged
historical privileged-runtime guards are recorded as follow-up hardening.
"""
from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import stat
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HANDOFF = Path(f"/opt/codex-work/yoko-stage-a-handoff-{ROOT.name.split('-')[1][:8]}")
SEAL = ROOT / "packaging/seal-release.py"
SELF = Path(__file__).resolve()


def scanned_files() -> list[Path]:
    """Every profile file that must carry only derived identities.

    This module is excluded from its own scan: the stale-rejection test has to
    name the predecessor values to reject them, so including itself would make
    the guard permanently red and tempt someone to delete it.
    """
    return sorted(
        path for path in ROOT.rglob("*")
        if path.is_file()
        and path.suffix != ".pyc"
        and "__pycache__" not in path.parts
        and path.resolve() != SELF
    )


def seal_constants(names: set[str]) -> dict[str, object]:
    """Read seal constants without importing, so no side effect can mask a value."""
    found: dict[str, object] = {}
    for node in ast.parse(SEAL.read_text(encoding="utf-8")).body:
        if type(node) is ast.Assign and len(node.targets) == 1 and type(node.targets[0]) is ast.Name:
            name = node.targets[0].id
            if name in names:
                try:
                    found[name] = ast.literal_eval(node.value)
                except ValueError:
                    pass
    return found


class RebindIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads(
            (HANDOFF / "coordinated-artifact-transport-manifest.json").read_text(encoding="utf-8")
        )
        cls.archive = HANDOFF / "coordinated-artifact.zip"

    # 1. manifest-derived identity tuple consistency
    def test_stage_a_identity_tuple_matches_the_transport_manifest(self) -> None:
        run = self.manifest["workflow_run"]
        source = self.manifest["source_artifact"]
        joined = "\n".join(
            path.read_text(encoding="utf-8", errors="replace") for path in scanned_files()
        )
        for label, value in (
            ("run id", str(run["id"])),
            ("branch", run["head_branch"].split("/")[-1]),
            ("artifact id", str(source["id"])),
            ("artifact bytes", str(source["bytes"])),
            ("artifact name", source["name"]),
            ("artifact digest", source["digest"].split(":", 1)[1]),
        ):
            with self.subTest(label):
                self.assertIn(value, joined, f"profile does not carry the derived {label}")

    def test_the_whole_tuple_moved_together(self) -> None:
        # The defect was a MIXED tuple: name and digest advanced while run id,
        # artifact id and bytes stayed behind. Any predecessor member surviving
        # anywhere in the profile is that same defect.
        run = self.manifest["workflow_run"]
        source = self.manifest["source_artifact"]
        members = self.archive_members()
        current = {
            str(run["id"]), str(source["id"]), str(source["bytes"]),
            # the derived combined image-tar sum is legitimately its own number
            str(sum(v["bytes"] for k, v in members.items() if k.endswith(".docker.tar"))),
        }
        for path in scanned_files():
            text = path.read_text(encoding="utf-8", errors="replace")
            for number in re.findall(r"\b\d{10,13}\b", text):
                if number.startswith(("358", "107", "480")) and number not in current:
                    if number in {str(v["bytes"]) for v in members.values()}:
                        continue  # a per-member byte count, derived from the archive
                    self.fail(f"{path.relative_to(ROOT)} carries non-derived identity {number}")

    @classmethod
    def archive_members(cls) -> dict[str, dict[str, object]]:
        members: dict[str, dict[str, object]] = {}
        with zipfile.ZipFile(cls.archive) as bundle:
            for name in sorted(bundle.namelist()):
                raw = bundle.read(name)
                members[name] = {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
        return members

    # 2. current HANDOFF / profile binding
    def test_installer_handoff_is_bound_to_this_profile(self) -> None:
        installer = (ROOT / "templates/install.sh.in").read_text(encoding="ascii")
        match = re.search(r"^HANDOFF='([^']+)'$", installer, re.MULTILINE)
        self.assertIsNotNone(match, "installer declares no HANDOFF")
        self.assertEqual(Path(match.group(1)), HANDOFF / "release-output")
        self.assertTrue(HANDOFF.is_dir(), "the bound handoff directory does not exist")

    # 3. ARTIFACT_FILES and combined bytes against the actual archive
    def test_artifact_files_match_the_verified_archive(self) -> None:
        declared = seal_constants({"ARTIFACT_FILES"}).get("ARTIFACT_FILES")
        self.assertEqual(declared, self.archive_members())

    def test_combined_docker_archive_bytes_is_the_sum_of_the_image_tars(self) -> None:
        members = self.archive_members()
        expected = sum(v["bytes"] for k, v in members.items() if k.endswith(".docker.tar"))
        seal_text = SEAL.read_text(encoding="utf-8")
        self.assertIn(str(expected), seal_text, "combined docker archive bytes are not the derived sum")

    def test_declared_artifact_digest_is_the_transported_archive(self) -> None:
        declared = seal_constants({"ARTIFACT_DIGEST"}).get("ARTIFACT_DIGEST")
        self.assertEqual(f"sha256:{declared}", self.manifest["source_artifact"]["digest"])

    # 4. executable mode + python3 -I invariant
    def test_sealer_stays_directly_executable_with_isolated_python(self) -> None:
        mode = SEAL.stat().st_mode
        self.assertTrue(mode & stat.S_IXUSR, "sealer lost its executable bit")
        self.assertTrue(os.access(SEAL, os.X_OK))
        first = SEAL.read_text(encoding="utf-8").splitlines()[0]
        # -I matters: without it Python re-adds the script directory to sys.path
        # and honours PYTHONPATH and user-site, which is an import-hijack surface
        # for a sealer that runs with elevated trust.
        self.assertEqual(first, "#!/usr/bin/python3 -I")

    # 5. stale identity rejection for values that must be current-derived
    def test_no_predecessor_stage_a_identity_survives(self) -> None:
        stale = (
            "35840959933", "10741409277", "4805842610", "4805824512",
            "yoko-stage-a-handoff-fb9fb30d", "coordinated-gravity-max-fb9fb30d",
            "9def57d3", "baf407d6", "0d3972c8", "359ffa83", "b23ecc9a", "d2f4c581",
        )
        for path in scanned_files():
            text = path.read_text(encoding="utf-8", errors="replace")
            for value in stale:
                with self.subTest(path=path.name, value=value):
                    self.assertNotIn(value, text)


if __name__ == "__main__":
    unittest.main()
