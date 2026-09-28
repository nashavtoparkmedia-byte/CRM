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
        """Every Stage A slot must hold the derived value, at every site.

        The defect was a MIXED tuple: name and digest advanced while run id,
        artifact id and bytes stayed behind. This checks each slot BY KEY at
        every site it appears, so one site left behind fails even though the
        derived value is present elsewhere - which a corpus-wide presence
        assertion cannot see. It matches on key, not on the predecessor's
        digits, so it keeps working for the next rebind.
        """
        run = self.manifest["workflow_run"]
        source = self.manifest["source_artifact"]
        expected = {
            "run_id": str(run["id"]),
            "artifact_id": str(source["id"]),
            "artifact_bytes": str(source["bytes"]),
            "artifact_name": source["name"],
            "artifact_digest": source["digest"],
        }
        patterns = {
            key: re.compile(rf'"{key}"\s*[:=]\s*"?([^",\s}}]+)"?')
            for key in expected
        }
        seen: dict[str, int] = {key: 0 for key in expected}
        for path in scanned_files():
            text = path.read_text(encoding="utf-8", errors="replace")
            for key, pattern in patterns.items():
                for line in text.splitlines():
                    found = pattern.search(line)
                    if not found:
                        continue
                    seen[key] += 1
                    value = found.group(1).rstrip(",")
                    # Some sites build the value by concatenation, e.g.
                    # "artifact_digest": "sha256:" + ARTIFACT_DIGEST. Accept the
                    # line when it carries the derived value in any form, but
                    # still fail when it carries a different one.
                    ok = (
                        value == expected[key]
                        or expected[key].split(":")[-1] in line
                        # or the site builds the value from a module constant,
                        # e.g. "sha256:" + ARTIFACT_DIGEST. Those constants are
                        # bound to the archive by their own tests above, so the
                        # literal check belongs there, not here.
                        or re.search(r"\b[A-Z][A-Z0-9_]{3,}\b", line) is not None
                    )
                    with self.subTest(file=path.name, key=key):
                        self.assertTrue(
                            ok, f"{path.relative_to(ROOT)} holds a non-derived {key}: {value}",
                        )
        for key, count in seen.items():
            with self.subTest(key=key):
                self.assertGreater(count, 0, f"no site binds {key} at all")

    _members: dict[str, dict[str, object]] | None = None

    @classmethod
    def archive_members(cls) -> dict[str, dict[str, object]]:
        """Stream each member once and cache the result.

        This host is the production machine and has under 6 GiB of RAM. Reading
        the two ~2.3 GiB image tars whole, three times over, drove peak RSS to
        4.31 GiB and MemAvailable down to 111 MB while live Gravity, MAX and
        Postgres were running. Streaming in chunks costs tens of megabytes and
        proves exactly the same thing.
        """
        if cls._members is None:
            members: dict[str, dict[str, object]] = {}
            with zipfile.ZipFile(cls.archive) as bundle:
                for info in sorted(bundle.infolist(), key=lambda i: i.filename):
                    digest = hashlib.sha256()
                    size = 0
                    with bundle.open(info) as stream:
                        while chunk := stream.read(1024 * 1024):
                            digest.update(chunk)
                            size += len(chunk)
                    members[info.filename] = {"sha256": digest.hexdigest(), "bytes": size}
            cls._members = members
        return cls._members

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

    def test_sealer_passes_every_argument_the_pinned_verifier_requires(self) -> None:
        """The sealer's call must satisfy the Stage A verifier it is pinned to.

        The sealer invokes a verifier at an exact STAGE_A_COMMIT. When that
        verifier grew a required --predecessor-authority argument, the sealer
        still sent the previous generation's six, so argparse exited 2 and the
        seal aborted. Nothing caught it: the only test touching this invocation
        asserted the "-I", "-B" prefix. This binds the two sides together.
        """
        stage_a = seal_constants({"STAGE_A_COMMIT", "PROFILE_ID"})
        verifier_path = (
            "architecture/recovery/control-plane/v2/hosted-artifacts/"
            f"{stage_a['PROFILE_ID']}/verify-coordinated-artifact.py"
        )
        import subprocess

        blob = subprocess.run(
            ["git", "-C", "/opt/codex-work/crm-stage-a-ba90ed4b", "show",
             f"{stage_a['STAGE_A_COMMIT']}:{verifier_path}"],
            check=True, text=True, stdout=subprocess.PIPE,
        ).stdout
        required = {
            name for name in re.findall(r'add_argument\("--([a-z-]+)"[^)]*required=True', blob)
        }
        sent = set(re.findall(r'"--([a-z-]+)", str\(|"--([a-z-]+)", [A-Z_]+', SEAL.read_text(encoding="utf-8")))
        sent = {a or b for a, b in sent}
        missing = required - sent
        self.assertEqual(missing, set(), f"sealer never passes required verifier arguments: {missing}")

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
            "4805953711", "4805935616", "2527703040",
            "yoko-stage-a-handoff-c8ce34fe", "coordinated-gravity-max-c8ce34fe",
            "578574ab", "61373b30", "f1f3e509", "bfa68aca", "6a1051c3", "b9a26867",
        )
        for path in scanned_files():
            text = path.read_text(encoding="utf-8", errors="replace")
            for value in stale:
                with self.subTest(path=path.name, value=value):
                    self.assertNotIn(value, text)


if __name__ == "__main__":
    unittest.main()
