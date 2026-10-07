"""Negative and preservation tests for the bounded MAIN_FIRST_PARENT source authority.

This authority trusts exactly one main push run (run 37603139022 of the
architecture-enforcement workflow for main head 8e639943, same non-fork
repository, no pull request) plus the accepted baseline's own main-push
authority. The target is bound by the exact first-parent chain from 8e639943
down to the accepted main anchor be6b8eb8, and the accepted predecessor
application 10318827 (the production repair lineage head) must share exactly
that anchor as merge base with the target. Every member of the tuple is mutated
here one at a time and must be rejected, the lineage guards are exercised one
at a time, the old PR-model fixtures of the accepted predecessor stay rejected,
and the predecessor authorities must still require a push source run.
"""
from __future__ import annotations

import copy
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[7]
AUTHORITY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AUTHORITY))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import coordinated_release_contract as contract  # noqa: E402
from test_coordinated_artifact import execution_proof, write_json, write_source_evidence  # noqa: E402


HOSTED_ARTIFACTS = "architecture/recovery/control-plane/v2/hosted-artifacts"
# Push-model predecessor authorities and the exact bytes they were accepted with.
PREDECESSORS = {
    "crm-be6b8eb82d8c-gravity-max-source-v1": ("0f1a213b2b1f0a8e322fd597aa4575829c6e26fc", "b329d33256db2a4690687ac17bc2881c5212a6f3"),
    "crm-7d3b7f175dde-gravity-max-source-v1": ("7867840d7da7ee371039e414a9f25c566a8eca36", "48c39bdf17225a9e8f27e11f3c3e9da3bc9bd83e"),
    "crm-6e3f094bf4b4-gravity-max-source-v1": (contract.APPLICATION_COMMIT, "9675ad8ee9763bfba6071fa8e6849694eb3645c9"),
}
# The immediate predecessor is the bounded PR-model authority for 10318827; it is
# bound by digest, never re-validated as a push authority.
PR_MODEL_PREDECESSOR = ("crm-10318827e484-gravity-max-source-v1", contract.PREDECESSOR_BUILDER_COMMIT, "cc749e6c5406b30afb004a294e2943301c9db08a")
PUSH_EVENT_GUARD = '        or run.get("event") != "push"\n'
FOREIGN_REPOSITORY_ID = 999999999
# The second parent of the target: the landed branch head, never a blast base.
SECOND_PARENT = "afd4f24b73ae64f2fd9af19e5d64ed4e7839db3d"
# A real commit that is on neither the first-parent chain nor the production repair lineage head.
OTHER_COMMIT = "04053538656b7daccfccd07fad587b7a4bb7e540"


def git_bytes(revision: str, path: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(ROOT), "show", f"{revision}:{path}"])


def git_rev(expression: str) -> str:
    return subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "--verify", expression], text=True).strip()


def set_path(value: Any, path: tuple[Any, ...], new: Any) -> None:
    for key in path[:-1]:
        value = value[key]
    value[path[-1]] = new


def delete_path(value: Any, path: tuple[Any, ...]) -> None:
    for key in path[:-1]:
        value = value[key]
    del value[path[-1]]


TUPLE_MUTATIONS: list[tuple[str, str, tuple[Any, ...], Any]] = [
    # source run identity
    ("wrong run id", "run.json", ("id",), contract.BASELINE_RUN_ID),
    ("wrong workflow id", "run.json", ("workflow_id",), 1),
    ("wrong workflow path", "run.json", ("path",), ".github/workflows/coordinated-gravity-max-8e639943.yml"),
    ("wrong head sha (moving main)", "run.json", ("head_sha",), OTHER_COMMIT),
    ("head sha at first parent", "run.json", ("head_sha",), contract.APPLICATION_PARENT),
    ("head sha at second parent", "run.json", ("head_sha",), SECOND_PARENT),
    ("wrong run head branch", "run.json", ("head_branch",), "codex/coordinated-gravity-max-8e639943"),
    ("rerun attempt", "run.json", ("run_attempt",), 2),
    ("pull_request event", "run.json", ("event",), "pull_request"),
    ("pull_request_target event", "run.json", ("event",), "pull_request_target"),
    ("workflow_dispatch event", "run.json", ("event",), "workflow_dispatch"),
    ("failed run", "run.json", ("conclusion",), "failure"),
    ("incomplete run", "run.json", ("status",), "in_progress"),
    ("wrong head commit id", "run.json", ("head_commit", "id"), contract.BASELINE_COMMIT),
    ("wrong head tree", "run.json", ("head_commit", "tree_id"), contract.BASELINE_TREE),
    ("fork head repository", "run.json", ("head_repository", "fork"), True),
    ("foreign head repository", "run.json", ("head_repository", "id"), FOREIGN_REPOSITORY_ID),
    ("foreign repository", "run.json", ("repository", "id"), FOREIGN_REPOSITORY_ID),
    ("pull request bound", "run.json", ("pull_requests",), [{"number": 160, "id": 1, "url": f"{contract.REPOSITORY_API_URL}/pulls/160"}]),
    ("pull requests not a list", "run.json", ("pull_requests",), None),
    # architecture job
    ("wrong job id", "jobs.json", ("jobs", 0, "id"), contract.BASELINE_ARCHITECTURE_JOB_ID),
    ("job of other run", "jobs.json", ("jobs", 0, "run_id"), contract.BASELINE_RUN_ID),
    ("job at other sha", "jobs.json", ("jobs", 0, "head_sha"), contract.APPLICATION_PARENT),
    ("job failed", "jobs.json", ("jobs", 0, "conclusion"), "failure"),
    ("job incomplete", "jobs.json", ("jobs", 0, "status"), "queued"),
    ("job renamed", "jobs.json", ("jobs", 0, "name"), "gravity-artifact"),
    # proof artifact
    ("wrong proof artifact id", "artifact.json", ("id",), contract.BASELINE_PROOF_ARTIFACT_ID),
    ("wrong proof artifact name", "artifact.json", ("name",), f"authoritative-ci-proof-{contract.BASELINE_COMMIT}"),
    ("wrong proof artifact size", "artifact.json", ("size_in_bytes",), 1),
    ("wrong proof artifact digest", "artifact.json", ("digest",), f"sha256:{contract.BASELINE_PROOF_ARTIFACT_SHA256}"),
    ("expired proof artifact", "artifact.json", ("expired",), True),
    ("proof artifact from other run", "artifact.json", ("workflow_run", "id"), contract.BASELINE_RUN_ID),
    ("proof artifact at other sha", "artifact.json", ("workflow_run", "head_sha"), contract.APPLICATION_PARENT),
    ("proof artifact from other branch", "artifact.json", ("workflow_run", "head_branch"), "codex/coordinated-gravity-max-8e639943"),
    ("proof artifact from foreign repository", "artifact.json", ("workflow_run", "repository_id"), FOREIGN_REPOSITORY_ID),
    ("proof artifact from foreign head repository", "artifact.json", ("workflow_run", "head_repository_id"), FOREIGN_REPOSITORY_ID),
    # execution proof
    ("proof for other commit", contract.SOURCE_PROOF, ("source", "commit"), contract.BASELINE_COMMIT),
    ("proof for other tree", contract.SOURCE_PROOF, ("source", "tree"), contract.BASELINE_TREE),
    ("proof failed", contract.SOURCE_PROOF, ("outcome",), "FAIL"),
    ("proof wrong schema", contract.SOURCE_PROOF, ("schema",), "yoko.crm.authoritative-ci-execution-proof.v0"),
    ("blast base at second parent", contract.SOURCE_PROOF, ("runtime", "blast_base_commit"), SECOND_PARENT),
    ("blast base at moving main", contract.SOURCE_PROOF, ("runtime", "blast_base_commit"), OTHER_COMMIT),
    ("blast base at the target itself", contract.SOURCE_PROOF, ("runtime", "blast_base_commit"), contract.APPLICATION_COMMIT),
    ("blast base at predecessor application", contract.SOURCE_PROOF, ("runtime", "blast_base_commit"), contract.PREDECESSOR_APPLICATION_COMMIT),
    ("blast base at the anchor", contract.SOURCE_PROOF, ("runtime", "blast_base_commit"), contract.MAIN_ANCHOR_COMMIT),
    ("blast base at baseline parent", contract.SOURCE_PROOF, ("runtime", "blast_base_commit"), contract.BASELINE_PARENT),
    ("wrong blast base ref", contract.SOURCE_PROOF, ("runtime", "blast_base"), "refs/heads/main"),
    ("wrong node", contract.SOURCE_PROOF, ("runtime", "node"), "20.20.1"),
    ("wrong control count", contract.SOURCE_PROOF, ("controls", "count"), 52),
    ("wrong control catalog", contract.SOURCE_PROOF, ("controls", "catalog_sha256"), "0" * 64),
    ("wrong semantic catalog", contract.SOURCE_PROOF, ("controls", "semantic_catalog_sha256"), "0" * 64),
    ("one control not passing", contract.SOURCE_PROOF, ("controls", "executions", 0, "status"), "FAIL"),
    # baseline main-push authority
    ("baseline wrong run id", "baseline-run.json", ("id",), contract.SOURCE_RUN_ID),
    ("baseline pull_request event", "baseline-run.json", ("event",), "pull_request"),
    ("baseline not on main", "baseline-run.json", ("head_branch",), "codex/coordinated-gravity-max-8e639943"),
    ("baseline at other sha", "baseline-run.json", ("head_sha",), contract.APPLICATION_COMMIT),
    ("baseline rerun attempt", "baseline-run.json", ("run_attempt",), 2),
    ("baseline failed", "baseline-run.json", ("conclusion",), "failure"),
    ("baseline incomplete", "baseline-run.json", ("status",), "queued"),
    ("baseline wrong tree", "baseline-run.json", ("head_commit", "tree_id"), contract.APPLICATION_TREE),
    ("baseline fork head", "baseline-run.json", ("head_repository", "fork"), True),
    ("baseline wrong workflow", "baseline-run.json", ("workflow_id",), 1),
    ("baseline wrong workflow path", "baseline-run.json", ("path",), ".github/workflows/coordinated-gravity-max-be6b8eb8.yml"),
    ("baseline proof artifact run is not an object", "baseline-artifact.json", ("workflow_run",), []),
    ("baseline architecture job failed", "baseline-jobs.json", ("jobs", 0, "conclusion"), "failure"),
    ("baseline architecture job other id", "baseline-jobs.json", ("jobs", 0, "id"), contract.SOURCE_ARCHITECTURE_JOB_ID),
    ("baseline proof artifact other run", "baseline-artifact.json", ("workflow_run", "id"), contract.SOURCE_RUN_ID),
    ("baseline proof artifact other branch", "baseline-artifact.json", ("workflow_run", "head_branch"), "codex/coordinated-gravity-max-8e639943"),
    ("baseline proof for other commit", contract.BASELINE_PROOF, ("source", "commit"), contract.APPLICATION_COMMIT),
    ("baseline proof wrong blast base", contract.BASELINE_PROOF, ("runtime", "blast_base_commit"), contract.BASELINE_COMMIT),
    ("baseline proof failed", contract.BASELINE_PROOF, ("outcome",), "FAIL"),
]


class BoundedSourceAuthorityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.evidence = Path(self.temporary.name) / "source-authority"
        self.evidence.mkdir()
        write_source_evidence(self.evidence)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def mutate(self, name: str, mutation: Callable[[Any], None]) -> None:
        path = self.evidence / name
        value = json.loads(path.read_text())
        mutation(value)
        write_json(path, value)

    def assert_rejected(self, message: str | None = None) -> None:
        with self.assertRaises(contract.ContractError) as caught:
            contract.validate_source_authority(self.evidence)
        if message is not None:
            self.assertIn(message, str(caught.exception))

    def test_exact_tuple_is_accepted_and_recorded(self) -> None:
        authority, proof_bytes = contract.validate_source_authority(self.evidence)
        self.assertEqual(proof_bytes, (self.evidence / contract.SOURCE_PROOF).read_bytes())
        self.assertEqual(authority["run"], {
            "id": 37603139022, "attempt": 1, "workflow_id": 334421867, "event": "push", "branch": "main", "conclusion": "success",
        })
        self.assertEqual(authority["lineage"], {
            "model": "MAIN_FIRST_PARENT",
            "branch": "main",
            "head": {"sha": "8e639943648c6cf7b3a2fd9549b75462c2954082", "tree": "877682e50eaea473e9a8c0829d1b2e5a8cd94fd0"},
            "first_parent": "cfa7468ea70721b7b6aa3a8ee6ddd20900173ee2",
            "chain_length": 32,
            "anchor": {"commit": "be6b8eb82d8c074e82a3be0cd53db26137e984be", "tree": "8fc34b11684318dc2278f210154447229305f16d", "production_accepted": True},
            "predecessor_application": {"commit": "10318827e484fec466ba994a2a7b7ffe070f7336", "merge_base": "be6b8eb82d8c074e82a3be0cd53db26137e984be"},
        })
        self.assertNotIn("pull_request", authority)
        self.assertNotIn("repair_base", authority)
        self.assertEqual(authority["execution_proof"]["blast_base_commit"], "cfa7468ea70721b7b6aa3a8ee6ddd20900173ee2")
        self.assertEqual(authority["baseline"]["run"], {
            "id": 34984925377, "attempt": 1, "workflow_id": 334421867, "event": "push", "branch": "main", "conclusion": "success",
        })
        self.assertEqual(authority["baseline"]["proof_artifact"]["id"], 10411840982)

    def test_tuple_constants_are_the_authorized_identities(self) -> None:
        self.assertEqual(contract.REPOSITORY, "nashavtoparkmedia-byte/CRM")
        self.assertEqual(contract.REPOSITORY_ID, 1183669136)
        self.assertEqual(contract.SOURCE_LINEAGE_MODEL, "MAIN_FIRST_PARENT")
        self.assertEqual(contract.SOURCE_EVENT, "push")
        self.assertEqual(contract.SOURCE_HEAD_BRANCH, "main")
        self.assertEqual(contract.MAIN_BRANCH, "main")
        self.assertEqual(contract.SOURCE_RUN_ID, 37603139022)
        self.assertEqual(contract.SOURCE_RUN_ATTEMPT, 1)
        self.assertEqual(contract.SOURCE_WORKFLOW_ID, 334421867)
        self.assertEqual(contract.APPLICATION_COMMIT, "8e639943648c6cf7b3a2fd9549b75462c2954082")
        self.assertEqual(contract.APPLICATION_TREE, "877682e50eaea473e9a8c0829d1b2e5a8cd94fd0")
        self.assertEqual(contract.APPLICATION_PARENT, "cfa7468ea70721b7b6aa3a8ee6ddd20900173ee2")
        self.assertEqual(contract.SOURCE_BLAST_BASE_COMMIT, contract.APPLICATION_PARENT)
        self.assertEqual(contract.MAIN_ANCHOR_COMMIT, contract.BASELINE_COMMIT)
        self.assertEqual(contract.MAIN_ANCHOR_TREE, contract.BASELINE_TREE)
        self.assertEqual(contract.BASELINE_COMMIT, "be6b8eb82d8c074e82a3be0cd53db26137e984be")
        self.assertEqual(contract.PREDECESSOR_APPLICATION_COMMIT, "10318827e484fec466ba994a2a7b7ffe070f7336")
        self.assertEqual(contract.PREDECESSOR_BUILDER_COMMIT, "46e6107187776929db52ca127061b0c99a21ce71")
        self.assertEqual(contract.SOURCE_ARCHITECTURE_JOB_ID, 112732111891)
        self.assertEqual(contract.SOURCE_PROOF_ARTIFACT_ID, 11485830025)
        self.assertEqual(contract.SOURCE_PROOF_ARTIFACT_SHA256, "54e82626909c41cd46c36908a83f0c05012a73480786161fe4fbdaea2ee6cec9")
        self.assertEqual(contract.BASELINE_RUN_ID, 34984925377)
        self.assertEqual(contract.BASELINE_EVENT, "push")
        self.assertEqual(contract.BASELINE_BRANCH, "main")
        self.assertEqual(contract.SOURCE_WORKFLOW_SHA256, "7acd3668a513e4007121c6b320ba4b5ca683ecaf365c6973a25d33a162476d0a")
        self.assertEqual(contract.SOURCE_RUNNER_SHA256, "e8738068b90a3bece21975a5e7bc01980b0de7f429848ccd1e3e4d6687e9ec30")
        for name in ("SOURCE_PULL_REQUEST_NUMBER", "SOURCE_PULL_REQUEST_ID", "SOURCE_BASE_REF", "REPAIR_BASE_COMMIT", "is_pull_request_repository"):
            self.assertFalse(hasattr(contract, name), name)

    def test_every_tuple_member_mutation_is_rejected(self) -> None:
        for label, member, path, value in TUPLE_MUTATIONS:
            with self.subTest(label):
                original = (self.evidence / member).read_bytes()
                try:
                    self.mutate(member, lambda document, path=path, value=value: set_path(document, path, value))
                    self.assert_rejected()
                finally:
                    (self.evidence / member).write_bytes(original)
        contract.validate_source_authority(self.evidence)

    def test_every_required_run_field_is_mandatory(self) -> None:
        for member, paths in {
            "run.json": [("event",), ("head_branch",), ("head_commit",), ("repository",), ("head_repository",), ("pull_requests",), ("run_attempt",), ("path",)],
            "artifact.json": [("workflow_run", key) for key in ("id", "head_sha", "head_branch", "repository_id", "head_repository_id")],
            "baseline-run.json": [("event",), ("head_branch",), ("head_commit",), ("repository",), ("head_repository",)],
        }.items():
            for path in paths:
                with self.subTest(member=member, path=path):
                    original = (self.evidence / member).read_bytes()
                    try:
                        self.mutate(member, lambda document, path=path: delete_path(document, path))
                        self.assert_rejected()
                    finally:
                        (self.evidence / member).write_bytes(original)

    def test_pull_request_bound_run_is_rejected(self) -> None:
        def bind(run: Any) -> None:
            run["pull_requests"] = [{
                "url": f"{contract.REPOSITORY_API_URL}/pulls/160", "id": 1, "number": 160,
                "head": {"ref": "main", "sha": contract.APPLICATION_COMMIT}, "base": {"ref": "main", "sha": contract.APPLICATION_PARENT},
            }]
        self.mutate("run.json", bind)
        self.assert_rejected("bound to a pull request")

    def test_pull_request_event_is_rejected_even_with_the_exact_head(self) -> None:
        self.mutate("run.json", lambda run: set_path(run, ("event",), "pull_request"))
        self.assert_rejected("live GitHub source run identity mismatch")

    def test_non_main_head_branch_is_rejected(self) -> None:
        for branch in ("codex/coordinated-gravity-max-8e639943", "messaging/s2-evidence-contract", "refs/heads/main", "Main"):
            with self.subTest(branch=branch):
                original = (self.evidence / "run.json").read_bytes()
                try:
                    self.mutate("run.json", lambda run, branch=branch: set_path(run, ("head_branch",), branch))
                    self.assert_rejected("live GitHub source run identity mismatch")
                finally:
                    (self.evidence / "run.json").write_bytes(original)

    def test_moving_main_is_rejected(self) -> None:
        # A later main push run for a newer head is a different authority: both the
        # run tuple and the proof name the exact pinned head, never "current main".
        def later(run: Any) -> None:
            run["id"] = 37700000000
            run["head_sha"] = OTHER_COMMIT
            run["head_commit"] = {"id": OTHER_COMMIT, "tree_id": "0" * 40}
        self.mutate("run.json", later)
        self.assert_rejected("live GitHub source run identity mismatch")

    def test_fork_head_is_rejected(self) -> None:
        self.mutate("run.json", lambda run: run.update(head_repository={"id": FOREIGN_REPOSITORY_ID, "full_name": "attacker/CRM", "fork": True}))
        self.assert_rejected("not the exact non-fork release repository")

    def test_wrong_blast_base_is_rejected(self) -> None:
        for value in (SECOND_PARENT, OTHER_COMMIT, contract.APPLICATION_COMMIT, contract.PREDECESSOR_APPLICATION_COMMIT, contract.MAIN_ANCHOR_COMMIT):
            with self.subTest(value=value[:12]):
                original = (self.evidence / contract.SOURCE_PROOF).read_bytes()
                try:
                    self.mutate(contract.SOURCE_PROOF, lambda proof, value=value: set_path(proof, ("runtime", "blast_base_commit"), value))
                    self.assert_rejected("source execution proof runtime mismatch")
                finally:
                    (self.evidence / contract.SOURCE_PROOF).write_bytes(original)

    def test_wrong_proof_artifact_is_rejected(self) -> None:
        self.mutate("artifact.json", lambda artifact: set_path(artifact, ("id",), 10553161714))
        self.assert_rejected("source proof artifact identity mismatch")

    def test_modified_workflow_and_runner_hashes_are_rejected(self) -> None:
        for field, message in (("workflow", "source execution proof workflow mismatch"), ("runner", "source execution proof runner mismatch")):
            with self.subTest(field):
                original = (self.evidence / contract.SOURCE_PROOF).read_bytes()
                try:
                    self.mutate(contract.SOURCE_PROOF, lambda proof, field=field: set_path(proof, (field, "sha256"), "0" * 64))
                    self.assert_rejected(message)
                finally:
                    (self.evidence / contract.SOURCE_PROOF).write_bytes(original)

    def test_source_proof_cannot_stand_in_for_baseline_proof(self) -> None:
        shutil.copyfile(self.evidence / contract.SOURCE_PROOF, self.evidence / contract.BASELINE_PROOF)
        self.assert_rejected("baseline execution proof source mismatch")

    def test_baseline_proof_cannot_stand_in_for_source_proof(self) -> None:
        shutil.copyfile(self.evidence / contract.BASELINE_PROOF, self.evidence / contract.SOURCE_PROOF)
        self.assert_rejected("source execution proof source mismatch")

    def test_baseline_must_be_the_exact_main_push_authority(self) -> None:
        self.mutate("baseline-run.json", lambda run: run.update(event="pull_request", head_branch="codex/coordinated-gravity-max-8e639943"))
        self.assert_rejected("live GitHub baseline run identity mismatch")

    def test_missing_or_extra_evidence_member_is_rejected(self) -> None:
        for member in contract.SOURCE_EVIDENCE_MEMBERS:
            with self.subTest(missing=member):
                original = (self.evidence / member).read_bytes()
                (self.evidence / member).unlink()
                try:
                    self.assert_rejected("member allowlist mismatch")
                finally:
                    (self.evidence / member).write_bytes(original)
        (self.evidence / "pull-request.json").write_text("{}")
        self.assert_rejected("member allowlist mismatch")

    def test_duplicate_json_key_in_tuple_evidence_is_rejected(self) -> None:
        raw = (self.evidence / "run.json").read_text()
        (self.evidence / "run.json").write_text('{"event":"pull_request",' + raw[1:])
        self.assert_rejected()


@contextmanager
def patched(name: str, value: Any):
    original = getattr(contract, name)
    setattr(contract, name, value)
    try:
        yield
    finally:
        setattr(contract, name, original)


class ApplicationLineageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory()
        cls.application = Path(cls.temporary.name) / "application"
        subprocess.run(["git", "clone", "--quiet", "--shared", "--no-checkout", str(ROOT), str(cls.application)], check=True)
        subprocess.run(["git", "-C", str(cls.application), "checkout", "--quiet", "--detach", contract.APPLICATION_COMMIT], check=True)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    def test_exact_first_parent_lineage_to_the_main_anchor_is_accepted(self) -> None:
        contract.validate_application_source(self.application)
        chain = contract.APPLICATION_LINEAGE + (contract.MAIN_ANCHOR_COMMIT,)
        for child, parent in zip(chain, chain[1:]):
            parents = contract.commit_parents(self.application, child)
            self.assertEqual(parents[0], parent)
            self.assertIn(len(parents), (1, 2))
        self.assertEqual(len(contract.APPLICATION_LINEAGE), 32)
        self.assertEqual(len(set(contract.APPLICATION_LINEAGE)), 32)
        # The chain is made of landings: every entry is a two-parent GitHub merge.
        self.assertTrue(all(len(contract.commit_parents(self.application, c)) == 2 for c in contract.APPLICATION_LINEAGE))
        self.assertEqual(contract.merge_base(self.application, contract.APPLICATION_COMMIT, contract.PREDECESSOR_APPLICATION_COMMIT), contract.MAIN_ANCHOR_COMMIT)
        self.assertTrue(contract.is_ancestor(self.application, contract.MAIN_ANCHOR_COMMIT, contract.APPLICATION_COMMIT))
        self.assertFalse(contract.is_ancestor(self.application, contract.PREDECESSOR_APPLICATION_COMMIT, contract.APPLICATION_COMMIT))

    def test_anchor_is_the_accepted_baseline_and_blast_base_is_the_first_parent(self) -> None:
        self.assertEqual(contract.MAIN_ANCHOR_COMMIT, contract.BASELINE_COMMIT)
        self.assertEqual(contract.MAIN_ANCHOR_TREE, contract.BASELINE_TREE)
        self.assertEqual(contract.SOURCE_BLAST_BASE_COMMIT, contract.APPLICATION_PARENT)
        self.assertEqual(contract.commit_parents(self.application, contract.APPLICATION_COMMIT)[0], contract.APPLICATION_PARENT)
        self.assertNotEqual(contract.PREDECESSOR_APPLICATION_COMMIT, contract.MAIN_ANCHOR_COMMIT)

    def test_unknown_lineage_model_fails_closed(self) -> None:
        for value in ("PR_REPAIR_DELTA", "MAIN_FIRST_PARENT ", "main_first_parent", "", None):
            with self.subTest(model=value), patched("SOURCE_LINEAGE_MODEL", value):
                with self.assertRaisesRegex(contract.ContractError, "unknown source lineage model"):
                    contract.validate_application_source(self.application)

    def test_lineage_to_any_other_anchor_is_rejected(self) -> None:
        for name, value, message in (
            ("APPLICATION_PARENT", SECOND_PARENT, "application source lineage mismatch"),
            ("APPLICATION_PARENT", contract.BASELINE_COMMIT, "application source lineage mismatch"),
            ("MAIN_ANCHOR_COMMIT", contract.BASELINE_PARENT, "application source lineage mismatch"),
            ("MAIN_ANCHOR_COMMIT", contract.APPLICATION_LINEAGE[-1], "application source lineage mismatch"),
            ("MAIN_ANCHOR_TREE", contract.APPLICATION_TREE, "main anchor lineage mismatch"),
        ):
            with self.subTest(name=name, value=value[:12]), patched(name, value):
                with self.assertRaisesRegex(contract.ContractError, message):
                    contract.validate_application_source(self.application)

    def test_predecessor_descended_or_predecessor_containing_target_is_rejected(self) -> None:
        # Moving the predecessor-application pin onto the main line makes the merge
        # base something other than the accepted anchor: a target that descends from
        # the production lineage, or that the production lineage descends from, is
        # rejected by the same guard.
        for value in (contract.APPLICATION_PARENT, contract.APPLICATION_LINEAGE[5], contract.BASELINE_PARENT):
            with self.subTest(value=value[:12]), patched("PREDECESSOR_APPLICATION_COMMIT", value):
                with self.assertRaisesRegex(contract.ContractError, "predecessor lineage merge-base mismatch"):
                    contract.validate_application_source(self.application)

    def test_wrong_first_parent_and_skipped_first_parent_are_rejected(self) -> None:
        full = contract.APPLICATION_LINEAGE
        for name, value in (
            ("second parent substituted for the first", (full[0], SECOND_PARENT) + full[2:]),
            ("skipped first-parent commit", full[:2] + full[3:]),
            ("repeated commit", full[:1] + full[:1] + full[2:]),
            ("chain ending early", full[:3]),
            ("anchor spliced into the chain", full[:-1] + (contract.MAIN_ANCHOR_COMMIT,)),
            ("substituted lineage sha", full[:7] + (OTHER_COMMIT,) + full[8:]),
            ("predecessor application spliced in", full[:7] + (contract.PREDECESSOR_APPLICATION_COMMIT,) + full[8:]),
            ("chain extended past the anchor", full + (contract.MAIN_ANCHOR_COMMIT,)),
        ):
            with self.subTest(name), patched("APPLICATION_LINEAGE", value):
                with self.assertRaisesRegex(contract.ContractError, "application source lineage mismatch"):
                    contract.validate_application_source(self.application)

    def test_octopus_merge_in_the_chain_is_rejected(self) -> None:
        # No octopus merge exists in this repository's chain, so the parent reader is
        # shadowed for exactly one entry: a three-parent commit whose first parent
        # is still the pinned one must be rejected on its parent count alone.
        target = contract.APPLICATION_LINEAGE[3]
        real = contract.commit_parents

        def octopus(repository: Path, revision: str) -> list[str]:
            parents = real(repository, revision)
            return parents + [OTHER_COMMIT] if revision == target else parents

        with patch.object(contract, "commit_parents", side_effect=octopus):
            with self.assertRaisesRegex(contract.ContractError, "application source lineage mismatch"):
                contract.validate_application_source(self.application)
        # And a parentless entry (a root commit) is rejected the same way.
        with patch.object(contract, "commit_parents", side_effect=lambda repository, revision: [] if revision == target else real(repository, revision)):
            with self.assertRaisesRegex(contract.ContractError, "application source lineage mismatch"):
                contract.validate_application_source(self.application)

    def test_second_parent_in_first_position_is_rejected(self) -> None:
        # Pins the POSITION check, not membership: every chain entry is a real
        # two-parent landing, so swapping the parent order of one entry keeps the
        # pinned commit among its parents while it is no longer the FIRST parent.
        # A contract that accepted "parent in parents" would admit this; the
        # contract must reject it on parents[0] alone.
        target = contract.APPLICATION_LINEAGE[3]
        real = contract.commit_parents

        def swapped(repository: Path, revision: str) -> list[str]:
            parents = real(repository, revision)
            if revision == target:
                self.assertEqual(len(parents), 2)
                return [parents[1], parents[0]]
            return parents

        with patch.object(contract, "commit_parents", side_effect=swapped):
            with self.assertRaisesRegex(contract.ContractError, "application source lineage mismatch"):
                contract.validate_application_source(self.application)
        # The same swap on the target itself is caught by the constant pre-check,
        # so the swap above is the only fixture that reaches the per-hop position test.
        contract.validate_application_source(self.application)

    def test_predecessor_application_cannot_stand_in_for_the_candidate(self) -> None:
        subprocess.run(["git", "-C", str(self.application), "checkout", "--quiet", "--detach", contract.PREDECESSOR_APPLICATION_COMMIT], check=True)
        try:
            with self.assertRaisesRegex(contract.ContractError, "application source identity mismatch"):
                contract.validate_application_source(self.application)
        finally:
            subprocess.run(["git", "-C", str(self.application), "checkout", "--quiet", "--detach", contract.APPLICATION_COMMIT], check=True)

    def test_first_parent_cannot_stand_in_for_the_candidate(self) -> None:
        subprocess.run(["git", "-C", str(self.application), "checkout", "--quiet", "--detach", contract.APPLICATION_PARENT], check=True)
        try:
            with self.assertRaisesRegex(contract.ContractError, "application source identity mismatch"):
                contract.validate_application_source(self.application)
        finally:
            subprocess.run(["git", "-C", str(self.application), "checkout", "--quiet", "--detach", contract.APPLICATION_COMMIT], check=True)

    def test_every_application_identity_member_is_bound(self) -> None:
        for name, value in (
            ("APPLICATION_TREE", contract.BASELINE_TREE),
            ("GRAVITY_SUBTREE", "03175f4baad1563ecf57bbebb9254df12863f07b"),
            ("MAX_SUBTREE", contract.GRAVITY_SUBTREE),
        ):
            with self.subTest(name), patched(name, value):
                with self.assertRaisesRegex(contract.ContractError, "application source identity mismatch"):
                    contract.validate_application_source(self.application)

    def test_other_application_commit_is_rejected(self) -> None:
        subprocess.run(["git", "-C", str(self.application), "checkout", "--quiet", "--detach", contract.BASELINE_COMMIT], check=True)
        try:
            with self.assertRaisesRegex(contract.ContractError, "application source identity mismatch"):
                contract.validate_application_source(self.application)
        finally:
            subprocess.run(["git", "-C", str(self.application), "checkout", "--quiet", "--detach", contract.APPLICATION_COMMIT], check=True)


def load_contract(source: bytes, directory: Path, name: str):
    path = directory / f"{name}.py"
    path.write_bytes(source)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def predecessor_evidence(module, evidence: Path, event: str) -> None:
    evidence.mkdir()
    proof = execution_proof(module.APPLICATION_COMMIT, module.APPLICATION_TREE, module.APPLICATION_PARENT)
    evidence.joinpath(module.SOURCE_PROOF).write_bytes(module.canonical_bytes(proof))
    documents = {
        "run.json": {
            "id": module.SOURCE_RUN_ID, "workflow_id": module.SOURCE_WORKFLOW_ID, "head_sha": module.APPLICATION_COMMIT,
            "run_attempt": module.SOURCE_RUN_ATTEMPT, "event": event, "status": "completed", "conclusion": "success",
            "path": module.SOURCE_WORKFLOW_PATH,
        },
        "jobs.json": {"jobs": [{
            "id": module.SOURCE_ARCHITECTURE_JOB_ID, "name": "architecture", "run_id": module.SOURCE_RUN_ID,
            "head_sha": module.APPLICATION_COMMIT, "status": "completed", "conclusion": "success",
        }]},
        "artifact.json": {
            "id": module.SOURCE_PROOF_ARTIFACT_ID, "name": module.SOURCE_PROOF_ARTIFACT_NAME,
            "size_in_bytes": module.SOURCE_PROOF_ARTIFACT_BYTES, "digest": f"sha256:{module.SOURCE_PROOF_ARTIFACT_SHA256}",
            "expired": False, "workflow_run": {"id": module.SOURCE_RUN_ID, "head_sha": module.APPLICATION_COMMIT},
        },
    }
    for name, value in documents.items():
        evidence.joinpath(name).write_bytes(module.canonical_bytes(value))


class PredecessorAuthorityPreservationTests(unittest.TestCase):
    def test_predecessor_authority_trees_are_unchanged(self) -> None:
        for name, (revision, tree) in PREDECESSORS.items():
            with self.subTest(name):
                self.assertEqual(git_rev(f"{revision}:{HOSTED_ARTIFACTS}/{name}"), tree)
        name, revision, tree = PR_MODEL_PREDECESSOR
        self.assertEqual(git_rev(f"{revision}:{HOSTED_ARTIFACTS}/{name}"), tree)
        # The only predecessor inside this checkout is carried byte-identically from the application commit.
        self.assertEqual(
            git_rev(f"HEAD:{HOSTED_ARTIFACTS}/crm-6e3f094bf4b4-gravity-max-source-v1"),
            PREDECESSORS["crm-6e3f094bf4b4-gravity-max-source-v1"][1],
        )
        for absent in ("crm-be6b8eb82d8c", "crm-7d3b7f175dde", "crm-10318827e484", "crm-ba90ed4b6717"):
            self.assertFalse((ROOT / HOSTED_ARTIFACTS / f"{absent}-gravity-max-source-v1").exists(), absent)

    def test_every_push_model_predecessor_contract_still_requires_push(self) -> None:
        for name, (revision, _) in PREDECESSORS.items():
            with self.subTest(name):
                source = git_bytes(revision, f"{HOSTED_ARTIFACTS}/{name}/coordinated_release_contract.py").decode()
                self.assertEqual(source.count(PUSH_EVENT_GUARD), 1)
                self.assertNotIn("pull_request", source)

    def test_the_pr_model_predecessor_is_bound_by_digest_and_keeps_its_own_model(self) -> None:
        # The immediate predecessor (10318827) is the bounded PR-model authority. It
        # is proved here by exact commit and content digest only; its own tuple is
        # never re-validated under this authority's push model, and this authority
        # never inherits its pull-request tuple.
        name, revision, _ = PR_MODEL_PREDECESSOR
        raw = git_bytes(revision, f"{HOSTED_ARTIFACTS}/{name}/coordinated_release_contract.py")
        import hashlib
        self.assertEqual(hashlib.sha256(raw).hexdigest(), contract.PREDECESSOR_CONTRACT_SHA256)
        source = raw.decode()
        self.assertIn('SOURCE_EVENT = "pull_request"', source)
        self.assertNotIn("SOURCE_LINEAGE_MODEL", source)
        own = Path(contract.__file__).read_text(encoding="utf-8")
        self.assertEqual(own.count('SOURCE_EVENT = "push"'), 1)
        self.assertNotIn("SOURCE_PULL_REQUEST", own)
        self.assertNotIn("REPAIR_BASE", own)

    def test_this_authority_rejects_the_predecessor_pr_model_evidence(self) -> None:
        # The accepted predecessor's own (pull_request) tuple is not evidence here.
        name, revision, _ = PR_MODEL_PREDECESSOR
        source = git_bytes(revision, f"{HOSTED_ARTIFACTS}/{name}/coordinated_release_contract.py")
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            predecessor = load_contract(source, base, "predecessor_10318827_contract")
            evidence = base / "pr-evidence"
            predecessor_evidence(predecessor, evidence, "pull_request")
            for member in ("baseline-run.json", "baseline-jobs.json", "baseline-artifact.json", predecessor.BASELINE_PROOF):
                evidence.joinpath(member).write_bytes(b"{}")
            with self.assertRaises(contract.ContractError):
                contract.validate_source_authority(evidence)

    def test_be6b8eb8_authority_rejects_pull_request_runs_and_accepts_its_push_run(self) -> None:
        revision = PREDECESSORS["crm-be6b8eb82d8c-gravity-max-source-v1"][0]
        source = git_bytes(revision, f"{HOSTED_ARTIFACTS}/crm-be6b8eb82d8c-gravity-max-source-v1/coordinated_release_contract.py")
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            predecessor = load_contract(source, base, "predecessor_be6b8eb8_contract")
            push = base / "push"
            predecessor_evidence(predecessor, push, "push")
            predecessor.validate_source_authority(push)
            pull_request = base / "pull-request"
            predecessor_evidence(predecessor, pull_request, "pull_request")
            with self.assertRaisesRegex(predecessor.ContractError, "live GitHub source run identity mismatch"):
                predecessor.validate_source_authority(pull_request)

    def test_bounded_evidence_is_not_accepted_by_the_be6b8eb8_authority(self) -> None:
        revision = PREDECESSORS["crm-be6b8eb82d8c-gravity-max-source-v1"][0]
        source = git_bytes(revision, f"{HOSTED_ARTIFACTS}/crm-be6b8eb82d8c-gravity-max-source-v1/coordinated_release_contract.py")
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            predecessor = load_contract(source, base, "predecessor_be6b8eb8_contract_bounded")
            evidence = base / "bounded"
            evidence.mkdir()
            write_source_evidence(evidence)
            with self.assertRaises(predecessor.ContractError):
                predecessor.validate_source_authority(evidence)


if __name__ == "__main__":
    unittest.main()
