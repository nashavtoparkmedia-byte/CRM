"""Negative and preservation tests for the bounded pull_request source authority.

This authority trusts exactly one pull_request run (PR #107, run 35825049410,
base release/messaging-hotfix-base-be6b8eb8-20260918 at be6b8eb8, head
fb9fb30d, same non-fork repository) plus the baseline's main-push authority.
Every member of that tuple is mutated here one at a time and must be rejected,
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


ROOT = Path(__file__).resolve().parents[7]
AUTHORITY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AUTHORITY))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import coordinated_release_contract as contract  # noqa: E402
from test_coordinated_artifact import execution_proof, write_json, write_source_evidence  # noqa: E402


HOSTED_ARTIFACTS = "architecture/recovery/control-plane/v2/hosted-artifacts"
# Predecessor authorities and the exact bytes they were accepted with.
PREDECESSORS = {
    "crm-be6b8eb82d8c-gravity-max-source-v1": ("0f1a213b2b1f0a8e322fd597aa4575829c6e26fc", "b329d33256db2a4690687ac17bc2881c5212a6f3"),
    "crm-7d3b7f175dde-gravity-max-source-v1": ("7867840d7da7ee371039e414a9f25c566a8eca36", "48c39bdf17225a9e8f27e11f3c3e9da3bc9bd83e"),
    "crm-6e3f094bf4b4-gravity-max-source-v1": (contract.APPLICATION_COMMIT, "9675ad8ee9763bfba6071fa8e6849694eb3645c9"),
}
PUSH_EVENT_GUARD = '        or run.get("event") != "push"\n'
FOREIGN_REPOSITORY_ID = 999999999
MAIN_TIP_AT_ISSUE = "5232cd31f7553d76929fbeb6bae56931939f5c22"
OTHER_COMMIT = "474c0707f457c233e292a3d4b4fd60c012d72f9f"


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


PR = ("pull_requests", 0)
TUPLE_MUTATIONS: list[tuple[str, str, tuple[Any, ...], Any]] = [
    # source run identity
    ("wrong run id", "run.json", ("id",), 35339523768),
    ("wrong workflow id", "run.json", ("workflow_id",), 334421868),
    ("wrong run head sha", "run.json", ("head_sha",), OTHER_COMMIT),
    ("wrong run head branch", "run.json", ("head_branch",), "main"),
    ("rerun attempt", "run.json", ("run_attempt",), 2),
    ("push event", "run.json", ("event",), "push"),
    ("pull_request_target event", "run.json", ("event",), "pull_request_target"),
    ("workflow_dispatch event", "run.json", ("event",), "workflow_dispatch"),
    ("incomplete run", "run.json", ("status",), "in_progress"),
    ("failed run", "run.json", ("conclusion",), "failure"),
    ("cancelled run", "run.json", ("conclusion",), "cancelled"),
    ("missing conclusion", "run.json", ("conclusion",), None),
    ("wrong workflow path", "run.json", ("path",), ".github/workflows/coordinated-gravity-max-fb9fb30d.yml"),
    ("wrong head commit", "run.json", ("head_commit", "id"), OTHER_COMMIT),
    ("wrong head tree", "run.json", ("head_commit", "tree_id"), contract.BASELINE_TREE),
    ("foreign repository", "run.json", ("repository", "id"), FOREIGN_REPOSITORY_ID),
    ("renamed repository", "run.json", ("repository", "full_name"), "attacker/CRM"),
    ("fork head repository id", "run.json", ("head_repository", "id"), FOREIGN_REPOSITORY_ID),
    ("fork head repository name", "run.json", ("head_repository", "full_name"), "attacker/CRM"),
    ("fork head repository flag", "run.json", ("head_repository", "fork"), True),
    ("missing fork flag", "run.json", ("head_repository", "fork"), None),
    # pull request tuple
    ("no pull request", "run.json", ("pull_requests",), []),
    ("wrong pull request number", "run.json", PR + ("number",), 108),
    ("wrong pull request id", "run.json", PR + ("id",), 4568234927),
    ("wrong pull request url", "run.json", PR + ("url",), f"{contract.REPOSITORY_API_URL}/pulls/108"),
    ("wrong pull request head ref", "run.json", PR + ("head", "ref"), "codex/other"),
    ("wrong pull request head sha", "run.json", PR + ("head", "sha"), OTHER_COMMIT),
    ("fork pull request head repo", "run.json", PR + ("head", "repo", "id"), FOREIGN_REPOSITORY_ID),
    ("fork pull request head url", "run.json", PR + ("head", "repo", "url"), "https://api.github.com/repos/attacker/CRM"),
    ("fork pull request head name", "run.json", PR + ("head", "repo", "name"), "CRM-fork"),
    ("pull request into main", "run.json", PR + ("base", "ref"), "main"),
    ("pull request into other base branch", "run.json", PR + ("base", "ref"), "release/messaging-max-20260913"),
    ("pull request base at moving main", "run.json", PR + ("base", "sha"), MAIN_TIP_AT_ISSUE),
    ("pull request base at hotfix parent", "run.json", PR + ("base", "sha"), contract.APPLICATION_PARENT),
    ("pull request base in foreign repo", "run.json", PR + ("base", "repo", "id"), FOREIGN_REPOSITORY_ID),
    # architecture job
    ("wrong architecture job id", "jobs.json", ("jobs", 0, "id"), 105581992613),
    ("wrong architecture job name", "jobs.json", ("jobs", 0, "name"), "gravity-artifact"),
    ("architecture job from other run", "jobs.json", ("jobs", 0, "run_id"), 35339523768),
    ("architecture job at other sha", "jobs.json", ("jobs", 0, "head_sha"), OTHER_COMMIT),
    ("architecture job incomplete", "jobs.json", ("jobs", 0, "status"), "in_progress"),
    ("architecture job failed", "jobs.json", ("jobs", 0, "conclusion"), "failure"),
    # proof artifact
    ("wrong proof artifact id", "artifact.json", ("id",), 10553161714),
    ("wrong proof artifact name", "artifact.json", ("name",), f"authoritative-ci-proof-{contract.BASELINE_COMMIT}"),
    ("wrong proof artifact size", "artifact.json", ("size_in_bytes",), 5767),
    ("wrong proof artifact digest", "artifact.json", ("digest",), "sha256:" + "0" * 64),
    ("expired proof artifact", "artifact.json", ("expired",), True),
    ("proof artifact from other run", "artifact.json", ("workflow_run", "id"), contract.BASELINE_RUN_ID),
    ("proof artifact at other sha", "artifact.json", ("workflow_run", "head_sha"), contract.BASELINE_COMMIT),
    ("proof artifact from other branch", "artifact.json", ("workflow_run", "head_branch"), "main"),
    ("proof artifact from foreign repo", "artifact.json", ("workflow_run", "repository_id"), FOREIGN_REPOSITORY_ID),
    ("proof artifact from fork head", "artifact.json", ("workflow_run", "head_repository_id"), FOREIGN_REPOSITORY_ID),
    ("proof artifact run is not an object", "artifact.json", ("workflow_run",), None),
    # source execution proof
    ("proof outcome failed", contract.SOURCE_PROOF, ("outcome",), "FAIL"),
    ("proof for other commit", contract.SOURCE_PROOF, ("source", "commit"), contract.BASELINE_COMMIT),
    ("proof for other tree", contract.SOURCE_PROOF, ("source", "tree"), contract.BASELINE_TREE),
    ("modified workflow hash", contract.SOURCE_PROOF, ("workflow", "sha256"), "0" * 64),
    ("modified workflow path", contract.SOURCE_PROOF, ("workflow", "path"), ".github/workflows/other.yml"),
    ("modified runner hash", contract.SOURCE_PROOF, ("runner", "sha256"), "0" * 64),
    ("blast base at hotfix parent", contract.SOURCE_PROOF, ("runtime", "blast_base_commit"), contract.APPLICATION_PARENT),
    ("blast base at moving main", contract.SOURCE_PROOF, ("runtime", "blast_base_commit"), MAIN_TIP_AT_ISSUE),
    ("blast base at baseline parent", contract.SOURCE_PROOF, ("runtime", "blast_base_commit"), contract.BASELINE_PARENT),
    ("wrong blast base ref", contract.SOURCE_PROOF, ("runtime", "blast_base"), "refs/heads/main"),
    ("wrong node", contract.SOURCE_PROOF, ("runtime", "node"), "20.20.3"),
    ("partial control catalog", contract.SOURCE_PROOF, ("controls", "count"), 52),
    ("wrong control catalog", contract.SOURCE_PROOF, ("controls", "catalog_sha256"), "0" * 64),
    ("wrong semantic catalog", contract.SOURCE_PROOF, ("controls", "semantic_catalog_sha256"), "0" * 64),
    ("failed control", contract.SOURCE_PROOF, ("controls", "executions", 0, "status"), "FAIL"),
    # baseline main-push authority
    ("baseline wrong run id", "baseline-run.json", ("id",), contract.SOURCE_RUN_ID),
    ("baseline pull_request event", "baseline-run.json", ("event",), "pull_request"),
    ("baseline not on main", "baseline-run.json", ("head_branch",), contract.SOURCE_BASE_REF),
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
    ("baseline proof artifact id", "baseline-artifact.json", ("id",), contract.SOURCE_PROOF_ARTIFACT_ID),
    ("baseline proof artifact digest", "baseline-artifact.json", ("digest",), "sha256:" + "0" * 64),
    ("baseline proof artifact expired", "baseline-artifact.json", ("expired",), True),
    ("baseline proof artifact other run", "baseline-artifact.json", ("workflow_run", "id"), contract.SOURCE_RUN_ID),
    ("baseline proof artifact other branch", "baseline-artifact.json", ("workflow_run", "head_branch"), contract.SOURCE_HEAD_BRANCH),
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
            "id": 35825049410, "attempt": 1, "workflow_id": 334421867, "event": "pull_request", "conclusion": "success",
        })
        self.assertEqual(authority["pull_request"], {
            "number": 113,
            "id": 4610313546,
            "repository_id": 1183669136,
            "head": {"ref": "codex/messaging-max-dom-fallback-inbound-repair-20260922", "sha": "fb9fb30d9eb221a04342fe0ef7324f78d8ff7576"},
            "base": {"ref": "release/messaging-dom-fallback-repair-base-c7e29a24-20260923", "sha": "c7e29a24e960ddd75e6701d71e06405777e58d1e"},
        })
        self.assertEqual(authority["execution_proof"]["blast_base_commit"], "c7e29a24e960ddd75e6701d71e06405777e58d1e")
        self.assertEqual(authority["baseline"]["run"], {
            "id": 34984925377, "attempt": 1, "workflow_id": 334421867, "event": "push", "branch": "main", "conclusion": "success",
        })
        self.assertEqual(authority["baseline"]["proof_artifact"]["id"], 10411840982)

    def test_tuple_constants_are_the_authorized_identities(self) -> None:
        self.assertEqual(contract.REPOSITORY, "nashavtoparkmedia-byte/CRM")
        self.assertEqual(contract.REPOSITORY_ID, 1183669136)
        self.assertEqual(contract.SOURCE_EVENT, "pull_request")
        self.assertEqual(contract.SOURCE_RUN_ID, 35825049410)
        self.assertEqual(contract.SOURCE_RUN_ATTEMPT, 1)
        self.assertEqual(contract.SOURCE_WORKFLOW_ID, 334421867)
        self.assertEqual(contract.SOURCE_PULL_REQUEST_NUMBER, 113)
        self.assertEqual(contract.SOURCE_BASE_REF, "release/messaging-dom-fallback-repair-base-c7e29a24-20260923")
        self.assertEqual(contract.BASELINE_COMMIT, "be6b8eb82d8c074e82a3be0cd53db26137e984be")
        self.assertEqual(contract.SOURCE_BLAST_BASE_COMMIT, contract.REPAIR_BASE_COMMIT)
        self.assertEqual(contract.REPAIR_BASE_COMMIT, "c7e29a24e960ddd75e6701d71e06405777e58d1e")
        self.assertFalse(contract.REPAIR_BASE_PRODUCTION_ACCEPTED)
        self.assertEqual(contract.APPLICATION_COMMIT, "fb9fb30d9eb221a04342fe0ef7324f78d8ff7576")
        self.assertEqual(contract.APPLICATION_TREE, "a5a86806833ffb85175a639c4b0880fd9deb1318")
        self.assertEqual(contract.SOURCE_ARCHITECTURE_JOB_ID, 107064850637)
        self.assertEqual(contract.SOURCE_PROOF_ARTIFACT_ID, 10739658988)
        self.assertEqual(contract.SOURCE_PROOF_ARTIFACT_SHA256, "a59e283061d567afb20e0866cdbcf74a6af248f7b1ea6f509d9165720069079f")
        self.assertEqual(contract.BASELINE_RUN_ID, 34984925377)
        self.assertEqual(contract.BASELINE_EVENT, "push")
        self.assertEqual(contract.BASELINE_BRANCH, "main")
        self.assertEqual(contract.SOURCE_WORKFLOW_SHA256, "7acd3668a513e4007121c6b320ba4b5ca683ecaf365c6973a25d33a162476d0a")
        self.assertEqual(contract.SOURCE_RUNNER_SHA256, "e8738068b90a3bece21975a5e7bc01980b0de7f429848ccd1e3e4d6687e9ec30")

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
            "run.json": [("event",), ("head_branch",), ("head_commit",), ("repository",), ("head_repository",), ("pull_requests",)]
            + [PR + (key,) for key in ("number", "id", "url", "head", "base")],
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

    def test_arbitrary_pull_request_runs_are_rejected(self) -> None:
        def arbitrary(run: Any) -> None:
            run["id"] = 35000000000
            run["pull_requests"][0]["number"] = 42
            run["pull_requests"][0]["id"] = 1
            run["pull_requests"][0]["url"] = f"{contract.REPOSITORY_API_URL}/pulls/42"
        self.mutate("run.json", arbitrary)
        self.assert_rejected("live GitHub source run identity mismatch")

    def test_additional_pull_request_association_is_rejected(self) -> None:
        def associate(run: Any) -> None:
            extra = copy.deepcopy(run["pull_requests"][0])
            extra["number"] = 108
            run["pull_requests"].append(extra)
        self.mutate("run.json", associate)
        self.assert_rejected("exactly one pull request")

    def test_wrong_pull_request_number_is_rejected(self) -> None:
        self.mutate("run.json", lambda run: set_path(run, PR + ("number",), 108))
        self.assert_rejected("pull request tuple mismatch")

    def test_wrong_base_branch_is_rejected(self) -> None:
        self.mutate("run.json", lambda run: set_path(run, PR + ("base", "ref"), "main"))
        self.assert_rejected("pull request tuple mismatch")

    def test_wrong_base_sha_is_rejected(self) -> None:
        self.mutate("run.json", lambda run: set_path(run, PR + ("base", "sha"), MAIN_TIP_AT_ISSUE))
        self.assert_rejected("pull request tuple mismatch")

    def test_wrong_head_sha_is_rejected(self) -> None:
        self.mutate("run.json", lambda run: set_path(run, PR + ("head", "sha"), OTHER_COMMIT))
        self.assert_rejected("pull request tuple mismatch")

    def test_fork_head_is_rejected(self) -> None:
        def fork(run: Any) -> None:
            run["head_repository"] = {"id": FOREIGN_REPOSITORY_ID, "full_name": "attacker/CRM", "fork": True}
            run["pull_requests"][0]["head"]["repo"] = {
                "id": FOREIGN_REPOSITORY_ID, "url": "https://api.github.com/repos/attacker/CRM", "name": "CRM",
            }
        self.mutate("run.json", fork)
        self.assert_rejected("not the exact non-fork release repository")

    def test_wrong_run_id_is_rejected(self) -> None:
        self.mutate("run.json", lambda run: set_path(run, ("id",), contract.BASELINE_RUN_ID))
        self.assert_rejected("live GitHub source run identity mismatch")

    def test_unsuccessful_and_incomplete_runs_are_rejected(self) -> None:
        for field, value in (("conclusion", "failure"), ("conclusion", "cancelled"), ("status", "in_progress"), ("status", "queued")):
            with self.subTest(field=field, value=value):
                original = (self.evidence / "run.json").read_bytes()
                try:
                    self.mutate("run.json", lambda run, field=field, value=value: set_path(run, (field,), value))
                    self.assert_rejected("live GitHub source run identity mismatch")
                finally:
                    (self.evidence / "run.json").write_bytes(original)

    def test_push_event_is_not_accepted_for_this_tuple(self) -> None:
        self.mutate("run.json", lambda run: set_path(run, ("event",), "push"))
        self.assert_rejected("live GitHub source run identity mismatch")

    def test_wrong_blast_base_is_rejected(self) -> None:
        self.mutate(contract.SOURCE_PROOF, lambda proof: set_path(proof, ("runtime", "blast_base_commit"), contract.APPLICATION_PARENT))
        self.assert_rejected("source execution proof runtime mismatch")

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

    def test_baseline_must_be_the_exact_main_push_authority(self) -> None:
        self.mutate("baseline-run.json", lambda run: run.update(event="pull_request", head_branch=contract.SOURCE_BASE_REF))
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
        (self.evidence / "run.json").write_text('{"event":"push",' + raw[1:])
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

    def test_exact_repair_lineage_to_repair_base_and_baseline_is_accepted(self) -> None:
        contract.validate_application_source(self.application)
        chain = contract.APPLICATION_LINEAGE + (contract.REPAIR_BASE_COMMIT,)
        for child, parent in zip(chain, chain[1:]):
            self.assertEqual(contract.commit_parents(self.application, child), [parent])
        self.assertEqual(contract.commit_parents(self.application, contract.REPAIR_BASE_COMMIT), [contract.REPAIR_BASE_PARENT])
        self.assertEqual(contract.commit_parents(self.application, contract.REPAIR_BASE_PARENT), [contract.BASELINE_COMMIT])

    def test_repair_base_is_never_recorded_as_production_accepted(self) -> None:
        self.assertFalse(contract.REPAIR_BASE_PRODUCTION_ACCEPTED)
        self.assertNotEqual(contract.REPAIR_BASE_COMMIT, contract.BASELINE_COMMIT)
        self.assertEqual(contract.SOURCE_BLAST_BASE_COMMIT, contract.REPAIR_BASE_COMMIT)

    def test_lineage_to_any_other_base_is_rejected(self) -> None:
        for name, value in (
            ("APPLICATION_PARENT", contract.BASELINE_COMMIT),
            ("REPAIR_BASE_COMMIT", contract.BASELINE_COMMIT),
            ("REPAIR_BASE_TREE", contract.APPLICATION_TREE),
            ("REPAIR_BASE_PARENT", contract.BASELINE_PARENT),
            ("BASELINE_COMMIT", contract.BASELINE_PARENT),
            ("BASELINE_TREE", contract.APPLICATION_TREE),
        ):
            with self.subTest(name), patched(name, value):
                with self.assertRaisesRegex(contract.ContractError, "lineage mismatch"):
                    contract.validate_application_source(self.application)

    def test_truncated_or_substituted_repair_chain_is_rejected(self) -> None:
        full = contract.APPLICATION_LINEAGE
        for name, value in (
            ("dropped middle commit", full[:2] + full[3:]),
            ("repeated commit", full[:1] + full[:1] + full[2:]),
            ("chain ending early", full[:3]),
            ("baseline spliced into the chain", full[:-1] + (contract.BASELINE_COMMIT,)),
        ):
            with self.subTest(name), patched("APPLICATION_LINEAGE", value):
                with self.assertRaises(contract.ContractError):
                    contract.validate_application_source(self.application)

    def test_repair_base_cannot_stand_in_for_the_candidate(self) -> None:
        subprocess.run(["git", "-C", str(self.application), "checkout", "--quiet", "--detach", contract.REPAIR_BASE_COMMIT], check=True)
        try:
            with self.assertRaisesRegex(contract.ContractError, "application source identity mismatch"):
                contract.validate_application_source(self.application)
        finally:
            subprocess.run(["git", "-C", str(self.application), "checkout", "--quiet", "--detach", contract.APPLICATION_COMMIT], check=True)

    def test_self_consistent_other_baseline_is_rejected(self) -> None:
        # A different, internally consistent baseline (its own commit and tree) is
        # still not the parent of APPLICATION_PARENT, so only the lineage edge can catch it.
        other_tree = subprocess.check_output(
            ["git", "-C", str(self.application), "rev-parse", f"{contract.BASELINE_PARENT}^{{tree}}"], text=True,
        ).strip()
        # A different, internally consistent baseline is still not the parent of
        # the repair base, so only the lineage edge can catch it.
        with patched("BASELINE_COMMIT", contract.BASELINE_PARENT), patched("BASELINE_TREE", other_tree):
            with self.assertRaisesRegex(contract.ContractError, "lineage mismatch"):
                contract.validate_application_source(self.application)

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
        # The only predecessor inside this checkout is carried byte-identically from the application commit.
        self.assertEqual(
            git_rev(f"HEAD:{HOSTED_ARTIFACTS}/crm-6e3f094bf4b4-gravity-max-source-v1"),
            PREDECESSORS["crm-6e3f094bf4b4-gravity-max-source-v1"][1],
        )
        self.assertFalse((ROOT / HOSTED_ARTIFACTS / "crm-be6b8eb82d8c-gravity-max-source-v1").exists())
        self.assertFalse((ROOT / HOSTED_ARTIFACTS / "crm-7d3b7f175dde-gravity-max-source-v1").exists())

    def test_every_predecessor_contract_still_requires_push(self) -> None:
        for name, (revision, _) in PREDECESSORS.items():
            with self.subTest(name):
                source = git_bytes(revision, f"{HOSTED_ARTIFACTS}/{name}/coordinated_release_contract.py").decode()
                self.assertEqual(source.count(PUSH_EVENT_GUARD), 1)
                self.assertNotIn("pull_request", source)

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
