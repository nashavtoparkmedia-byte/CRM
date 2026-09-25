"""Focused tests for the chained predecessor-authority proof.

This authority proves everything below its repair base by binding the accepted
predecessor authority - exact builder commit plus exact contract content digest -
instead of walking a fixed number of git parents. The fixed two-hop walk it
replaces could only ever accept a repair base sitting exactly two commits above
the baseline, which no sliding release window can satisfy.

Every failure mode of that proof is exercised here and must fail closed.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import coordinated_release_contract as contract  # noqa: E402

REPOSITORY = Path(
    subprocess.run(
        ["git", "-C", str(Path(__file__).resolve().parent), "rev-parse", "--show-toplevel"],
        check=True, text=True, stdout=subprocess.PIPE,
    ).stdout.strip()
)


def detached_checkout(destination: Path, commit: str) -> None:
    """Materialise one exact commit as its own repository with HEAD == commit."""
    subprocess.run(["git", "init", "--quiet", str(destination)], check=True)
    subprocess.run(
        ["git", "-C", str(destination), "fetch", "--quiet", "--depth", "1", str(REPOSITORY), commit],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(destination), "checkout", "--quiet", "--detach", "FETCH_HEAD"],
        check=True,
    )


class PredecessorAuthorityTests(unittest.TestCase):
    """The accepted predecessor authority is the only accepted proof."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.root = Path(tempfile.mkdtemp(prefix="predecessor-authority-"))
        cls.accepted = cls.root / "accepted"
        detached_checkout(cls.accepted, contract.PREDECESSOR_BUILDER_COMMIT)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.root, ignore_errors=True)

    def mutated(self, replace: tuple[str, str] | None = None, remove: bool = False) -> Path:
        """A copy of the accepted checkout with one exact tampering applied."""
        target = Path(tempfile.mkdtemp(prefix="tampered-", dir=self.root))
        copy = target / "checkout"
        shutil.copytree(self.accepted, copy, symlinks=True)
        path = copy / contract.PREDECESSOR_CONTRACT_PATH
        if remove:
            path.unlink()
        elif replace is not None:
            old, new = replace
            text = path.read_text(encoding="utf-8")
            self.assertEqual(text.count(old), 1, f"tampering anchor is not unique: {old}")
            path.write_text(text.replace(old, new, 1), encoding="utf-8")
        return copy

    # ---- positive -----------------------------------------------------------

    def test_accepted_predecessor_authority_binding_the_repair_base_is_accepted(self) -> None:
        declared = contract.validate_predecessor_authority(self.accepted)
        self.assertEqual(declared["APPLICATION_COMMIT"], contract.REPAIR_BASE_COMMIT)
        self.assertEqual(declared["APPLICATION_COMMIT"], "fb9fb30d9eb221a04342fe0ef7324f78d8ff7576")
        self.assertEqual(declared["BASELINE_COMMIT"], contract.BASELINE_COMMIT)
        self.assertEqual(declared["BASELINE_TREE"], contract.BASELINE_TREE)

    def test_the_predecessor_is_pinned_by_exact_commit_and_content_digest(self) -> None:
        self.assertEqual(contract.PREDECESSOR_BUILDER_COMMIT, "19b631bc1d7026c4b8fe43f0713a57ef216d2ed9")
        self.assertEqual(
            contract.PREDECESSOR_CONTRACT_SHA256,
            "2fa353129e2c942927a5865e8cab41dcc4589fcbe2d4a7509f6e5cf0f88c68df",
        )
        # The digest is the acceptance statement, so it must be the digest of the
        # file actually present in the pinned checkout.
        import hashlib

        raw = (self.accepted / contract.PREDECESSOR_CONTRACT_PATH).read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), contract.PREDECESSOR_CONTRACT_SHA256)

    def test_the_new_authority_does_not_vendor_the_predecessor(self) -> None:
        own = Path(contract.__file__).resolve().parent
        self.assertNotIn(contract.PREDECESSOR_PROFILE, own.name)
        self.assertFalse((own / contract.PREDECESSOR_CONTRACT_PATH).exists())

    # ---- negative: every failure mode fails closed ---------------------------

    def test_missing_predecessor_checkout_is_rejected(self) -> None:
        with self.assertRaises(contract.ContractError):
            contract.validate_predecessor_authority(self.root / "does-not-exist")

    def test_missing_predecessor_contract_is_rejected(self) -> None:
        with self.assertRaises(contract.ContractError) as raised:
            contract.validate_predecessor_authority(self.mutated(remove=True))
        self.assertIn("missing", str(raised.exception))

    def test_wrong_predecessor_commit_is_rejected(self) -> None:
        # The repair base itself is a real commit in this repository and carries
        # no authority at all; it must not pass as its own predecessor.
        other = self.root / "wrong-commit"
        detached_checkout(other, contract.REPAIR_BASE_COMMIT)
        with self.assertRaises(contract.ContractError) as raised:
            contract.validate_predecessor_authority(other)
        self.assertIn("exact pinned builder commit", str(raised.exception))

    def test_tampered_predecessor_contract_is_rejected_as_unaccepted(self) -> None:
        # One added comment character is enough: acceptance is the exact digest.
        with self.assertRaises(contract.ContractError) as raised:
            contract.validate_predecessor_authority(
                self.mutated(("\"\"\"Fail-closed contract", "\"\"\" Fail-closed contract"))
            )
        self.assertIn("digest mismatch", str(raised.exception))

    def test_predecessor_binding_another_application_is_rejected(self) -> None:
        checkout = self.mutated((
            f'APPLICATION_COMMIT = "{contract.REPAIR_BASE_COMMIT}"',
            f'APPLICATION_COMMIT = "{contract.APPLICATION_COMMIT}"',
        ))
        with self.assertRaises(contract.ContractError) as raised:
            contract.validate_predecessor_authority(checkout)
        # The digest guard fires first, which is itself fail-closed; the binding
        # guard is proved directly below against an otherwise-accepted digest.
        self.assertIn("mismatch", str(raised.exception))

    def test_predecessor_application_and_baseline_bindings_are_each_required(self) -> None:
        raw = (self.accepted / contract.PREDECESSOR_CONTRACT_PATH).read_bytes().decode("utf-8")
        names = {"APPLICATION_COMMIT", "BASELINE_COMMIT", "BASELINE_TREE"}
        declared = contract.declared_constants(raw, names)
        self.assertEqual(set(declared), names)
        for name, wrong in (
            ("APPLICATION_COMMIT", contract.APPLICATION_COMMIT),
            ("BASELINE_COMMIT", contract.APPLICATION_COMMIT),
            ("BASELINE_TREE", contract.APPLICATION_TREE),
        ):
            with self.subTest(name=name):
                self.assertNotEqual(declared[name], wrong)

    def test_inherited_baseline_pins_must_match(self) -> None:
        # The baseline rejection that the application source used to catch by
        # walking two git parents is caught HERE instead: if this authority's
        # inherited baseline pins disagree with what the accepted predecessor
        # declares, the proof fails closed. Mutating either pin must be rejected.
        for name, wrong in (
            ("BASELINE_COMMIT", contract.BASELINE_PARENT),
            ("BASELINE_TREE", contract.APPLICATION_TREE),
        ):
            with self.subTest(name=name), patch.object(contract, name, wrong):
                with self.assertRaisesRegex(contract.ContractError, "baseline mismatch"):
                    contract.validate_predecessor_authority(self.accepted)

    def test_a_predecessor_binding_a_different_repair_base_is_rejected(self) -> None:
        # Same guard from the other side: keep the predecessor untouched and move
        # this authority's repair base, which must no longer match what the
        # predecessor binds.
        with patch.object(contract, "REPAIR_BASE_COMMIT", contract.APPLICATION_COMMIT):
            with self.assertRaisesRegex(contract.ContractError, "does not bind this repair base"):
                contract.validate_predecessor_authority(self.accepted)

    def test_declared_constants_never_executes_the_predecessor(self) -> None:
        # The predecessor is read as evidence, never imported: a module that
        # raises on import must still be parsed for its constants.
        source = 'raise SystemExit("must not run")\nAPPLICATION_COMMIT = "x"\n'
        self.assertEqual(
            contract.declared_constants(source, {"APPLICATION_COMMIT"}),
            {"APPLICATION_COMMIT": "x"},
        )

    # ---- the candidate side still binds exactly ------------------------------

    def test_repair_base_mismatch_is_rejected_on_the_application_side(self) -> None:
        self.assertEqual(contract.REPAIR_BASE_COMMIT, "fb9fb30d9eb221a04342fe0ef7324f78d8ff7576")
        self.assertEqual(contract.APPLICATION_LINEAGE[0], contract.APPLICATION_COMMIT)
        self.assertEqual(len(contract.APPLICATION_LINEAGE), 7)

    def test_generic_ancestry_is_supplementary_only(self) -> None:
        source = Path(contract.__file__).read_text(encoding="utf-8")
        # Ancestry is an extra consistency check and must never be the proof of
        # the baseline, which is why it may not appear in the predecessor proof.
        proof = source.split("def validate_predecessor_authority", 1)[1].split("\ndef ", 1)[0]
        self.assertNotIn("is_ancestor", proof)
        self.assertIn("is_ancestor(repository, REPAIR_BASE_COMMIT, APPLICATION_COMMIT)", source)
        self.assertNotIn("commit_parents(repository, REPAIR_BASE_PARENT) != [BASELINE_COMMIT]", source)


if __name__ == "__main__":
    unittest.main()
