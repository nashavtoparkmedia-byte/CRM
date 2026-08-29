#!/usr/bin/python3
from __future__ import annotations

import hashlib
import io
import importlib.machinery
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CORE_SHA = "0f97bafbfe5b430fa7994119b1fc76fead4bdbee26766c730d9e399551ebdffa"
OBSERVABILITY_SHA = "b5ea36c50e12b0fe6c171896258ddfc00a9d2666778735cae6a9b2a8df6d4084"
POLICY_SHA = "8727373b0c6ec79c9abf82f1aaaa58abc2bae67e96aa96a602ac419f308db0e0"
SUDOERS_SHA = "3022dcfc323706da81e760255dd1ab43f9b8662ee699aa8b58fbe6e714cc69d7"
TG_PATCH_PATH = "tg-bot/src/public-bot-maintenance.js"
MIGRATION_AUTHORITY_PATH = "architecture/migrations/v1/production-migration-authority.json"
PREDECESSOR_ATTESTATION_PATH = "architecture/migrations/v1/predecessor-runtime-migration-inventory.json"
AUTHORITATIVE_WORKFLOW_PATH = ".github/workflows/architecture-enforcement.yml"
AUTHORITATIVE_RUNNER_PATH = "tools/architecture/run-authoritative-ci.mjs"
RUNTIME_SOURCE_PREFIX = "architecture/recovery/control-plane/v2/owner-bootstrap/crm-external-rereview-source-only-v10"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def repository_root() -> Path:
    for start in (ROOT, Path.cwd()):
        try:
            result = subprocess.run(
                ["/usr/bin/git", "-C", str(start), "rev-parse", "--show-toplevel"],
                check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=30,
            )
        except (OSError, subprocess.CalledProcessError):
            continue
        candidate = Path(result.stdout.strip()).resolve(strict=True)
        if all((candidate / relative).is_file() for relative in (
            TG_PATCH_PATH,
            MIGRATION_AUTHORITY_PATH,
            PREDECESSOR_ATTESTATION_PATH,
        )):
            return candidate
    raise RuntimeError("unable to discover the Runtime v10 source repository from the test package or current directory")


def git_blob(repo: Path, revision: str | None, relative: str) -> bytes:
    object_name = f"{revision}:{relative}" if revision else f":{relative}"
    return subprocess.run(
        ["/usr/bin/git", "-C", str(repo), "show", object_name],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
    ).stdout


def deterministic_tar(files: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.GNU_FORMAT) as archive:
        for name, data in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o644
            member.uid = member.gid = 0
            member.mtime = 0
            archive.addfile(member, io.BytesIO(data))
    return output.getvalue()


class StaticContractTests(unittest.TestCase):
    def test_hosted_image_attestation_streams_bounded_stable_inputs(self) -> None:
        workflow = (repository_root() / AUTHORITATIVE_WORKFLOW_PATH).read_text()
        seal = (ROOT / "packaging/seal-release.py").read_text()
        self.assertIn("def file_identity(path):", workflow)
        self.assertIn("os.O_NOFOLLOW", workflow)
        self.assertNotIn("archive.read_bytes()", workflow)
        self.assertNotIn("dockerfile.read_bytes()", workflow)
        self.assertNotIn("lock.read_bytes()", workflow)
        self.assertNotIn("args.gravity_artifact_zip.resolve(strict=True)", seal)
        self.assertIn("source, artifact_copy, value.st_size", seal)
        self.assertIn("reader, docker_archive, docker_member.file_size", seal)
        self.assertIn("stream_identity(layer_file, layer_size)", seal)
        self.assertIn("YOKO_CI_ATTESTATION_OUTPUT: authoritative-ci-execution.json", workflow)
        self.assertIn("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093", workflow)
        self.assertIn("authoritative-ci-execution.json", workflow)
        self.assertIn("validate_ci_execution_proof(", seal)
        self.assertIn("all exact 52 ordered PASS controls", seal)

    def test_immutable_shared_runtime_inputs_remain_exact(self) -> None:
        self.assertEqual(sha(ROOT / "src/yoko-privileged-runtime-core.py"), CORE_SHA)
        self.assertEqual(sha(ROOT / "src/predecessor-observability-v1.py"), OBSERVABILITY_SHA)
        self.assertEqual(sha(ROOT / "src/policy.v2.base.json"), POLICY_SHA)
        self.assertEqual(sha(ROOT / "packaging/92-yoko-privileged-runtime"), SUDOERS_SHA)

    def test_source_only_profile_disables_database_mutation(self) -> None:
        wrapper = (ROOT / "templates/yoko-privileged-runtime.in").read_text()
        profile = (ROOT / "templates/crm-activation-profile.py.in").read_text()
        self.assertEqual((ROOT / "src/crm-activation-profile.py").read_bytes(), (ROOT / "templates/crm-activation-profile.py.in").read_bytes())
        self.assertIn('"database-migration": "Source-only release', wrapper)
        self.assertNotIn('invocation.primitive in {"database-status", "release-preflight", "database-migrate"', wrapper)
        self.assertIn('if invocation.primitive == "database-migrate":\n        raise core.RuntimeFault("PROFILE_DISABLED"', profile)
        self.assertIn('"phase": "MIGRATED"', profile)
        self.assertIn('"migration_completed_at": "SOURCE_ONLY_NO_DATABASE_MUTATION"', profile)
        for field in ("canonical_active_inventory_sha256", "expected_canonical_active_inventory_sha256", "canonical_predecessor_entry_count", "canonical_target_name", "canonical_target_checksum", "canonical_active_map_exact", "canonical_live_rows", "canonical_live_rows_sha256", "canonical_live_chronology_exact", "expected_live_chronology_sha256"):
            self.assertIn(field, profile)

    def test_human_contract_requires_semantic_chronology_gate(self) -> None:
        readme = (ROOT / "README.md").read_text()
        manifest = (ROOT / "human-manifest.md").read_text()
        payload_manifest = (ROOT / "bundle/payload/review/human-manifest.md").read_text()
        self.assertNotIn("Chronology is observation evidence, not an authorization predicate", readme)
        self.assertIn("sealed semantic order is an authorization predicate", readme)
        self.assertIn("known-row reorder is `DRIFTED`", manifest)
        self.assertIn("reorder of known rows is", payload_manifest)

    def test_human_contract_matches_exact_candidate_adoption_and_cleanup(self) -> None:
        documents = [
            (ROOT / "README.md").read_text(),
            (ROOT / "human-manifest.md").read_text(),
            (ROOT / "bundle/payload/review/human-manifest.md").read_text(),
        ]
        for document in documents:
            self.assertIn("adopt", document)
            self.assertIn("foreign", document)
            self.assertIn("remov", document)

    def test_terminal_rollback_cannot_reseal_or_change_source(self) -> None:
        profile = (ROOT / "templates/crm-activation-profile.py.in").read_text()
        self.assertIn('if state.get("phase") == "ROLLED_BACK":\n            raise core.RuntimeFault("ROLLED_BACK_RELEASE_TERMINAL"', profile)
        self.assertIn('TARGET_TAG = "yoko/crm-gravity-mvp:@FINAL_COMMIT@-source-only-v1"', profile)
        self.assertIn('ROLLBACK_TAG = "yoko/crm-gravity-mvp:rollback-baf442f8', profile)
        self.assertIn('TG_TARGET_TAG = "yoko/crm-tg-bot:@FINAL_COMMIT@-public-capability-v1"', profile)
        self.assertIn('TG_ROLLBACK_TAG = "yoko/crm-tg-bot:rollback-0849c4c9912', profile)
        self.assertIn('not observation["interrupted_target"] and not observation["rolled_back_target"]', profile)

    def test_dual_service_overlay_and_one_file_derivation_are_fixed(self) -> None:
        profile = (ROOT / "templates/crm-activation-profile.py.in").read_text()
        seal = (ROOT / "packaging/seal-release.py").read_text()
        snapshot = json.loads((ROOT / "production-snapshot.template.json").read_text())
        self.assertIn('"  gravity-mvp:\\n"', profile)
        self.assertIn('"  tg-bot:\\n"', profile)
        self.assertIn('deployment["compose_service"], deployment["tg_bot_compose_service"]', profile)
        self.assertIn('"--no-deps", "--no-build", "--pull", "never", "--force-recreate", "--wait"', profile)
        self.assertIn('COPY --chown=0:0 --chmod=0644 public-bot-maintenance.js /app/src/public-bot-maintenance.js', profile)
        self.assertIn('TG_BASE_REFERENCE = "crm/tg-bot@sha256:0849c4c9912aecf3cb7c35b51abba22cdb1c85a385afa6c2746000d14b9835f6"', profile)
        self.assertIn('f"FROM {TG_BASE_REFERENCE}\\n"', profile)
        self.assertNotIn('f"FROM {TG_BASE_IMAGE}\\n"', profile)
        self.assertIn('TG_BOT_PREDECESSOR_REFERENCE = f"crm/tg-bot@{TG_BOT_PREDECESSOR_IMAGE}"', seal)
        self.assertTrue(self._sealed_tg_recipe_uses_reference_and_preserves_image_identity(seal))
        self.assertIn('[DOCKER, "diff", TG_DIFF_PROOF_CONTAINER]', profile)
        self.assertIn('["C /app", "C /app/src", f"A {TG_PATCH_DESTINATION}"]', profile)
        self.assertIn('target_layers[:-1] != base_layers', profile)
        self.assertIn('target_config != base_config', profile)
        self.assertIn('"--pull=false", "--network", "none", "--no-cache"', profile)
        self.assertIn('"gravity-mvp", TG_BOT_PATCH_PATH', seal)
        self.assertEqual(snapshot["schema"], "yoko.crm.source-only-production-snapshot.v3")
        self.assertEqual(snapshot["status"], "RECAPTURE_REQUIRED")
        self.assertEqual(snapshot["observed"], {})
        self.assertEqual(snapshot["sealed_predecessor_authority"]["tg_bot_patch_baseline_state"], "ABSENT")
        self.assertEqual(snapshot["sealed_predecessor_authority"]["tg_bot_patch_baseline_manifest_sha256"], "72397e9c7e3c728b94d1e5645da825ddd75216bfacd13212b4671fe15f206d56")
        self.assertIn("capture-production-snapshot.py", seal)
        self.assertIn("load_snapshot(args.production_snapshot.resolve(strict=True))", seal)

    @staticmethod
    def _sealed_tg_recipe_uses_reference_and_preserves_image_identity(seal: str) -> bool:
        recipe_start = seal.index("def tg_bot_patch_recipe(")
        recipe_end = seal.index("\n\ndef validate_tg_bot_baseline_manifest", recipe_start)
        recipe = seal[recipe_start:recipe_end]
        return (
            'f"FROM {TG_BOT_PREDECESSOR_REFERENCE}\\n"' in recipe
            and 'f"LABEL yoko.tg-bot.base-image=\\"{TG_BOT_PREDECESSOR_IMAGE}\\"\\n"' in recipe
            and 'f"FROM {TG_BOT_PREDECESSOR_IMAGE}\\n"' not in recipe
        )

    def test_archive_has_exact_root_inventory_without_common_prefix(self) -> None:
        profile = json.loads((ROOT / "templates/profile.v1.json.in").read_text())
        runtime = (ROOT / "templates/crm-activation-profile.py.in").read_text()
        seal = (ROOT / "packaging/seal-release.py").read_text()
        self.assertEqual(profile["accepted_source"]["archive_prefix"], "")
        self.assertIn('name == "gravity-mvp"', runtime)
        self.assertIn('name in {"tg-bot", "tg-bot/src", source.get("tg_bot_patch_source_path")}', runtime)
        self.assertIn('raise core.RuntimeFault("SOURCE_ARCHIVE_PATH_INVALID"', runtime)
        self.assertNotIn('f"--prefix={prefix}"', seal)

    def test_complete_provenance_contract_is_exact(self) -> None:
        profile = (ROOT / "templates/crm-activation-profile.py.in").read_text()
        self.assertIn('Complete provenance is required; no missing resource is accepted.', profile)
        self.assertIn('provenance.get("complete") is not True', profile)
        self.assertIn('provenance.get("failures") != EXPECTED_PROVENANCE_FAILURES', profile)
        self.assertIn('provenance["semantic"]["fingerprint_sha256"] != core.semantic_fingerprint(semantic_records)', profile)
        self.assertIn('"provenance_failures_sha256": _digest(EXPECTED_PROVENANCE_FAILURES)', profile)
        self.assertNotIn('"seo.container.site", "code": "CONTAINER_NOT_FOUND"', profile)

    def test_bootstrap_and_sudo_negative_contract(self) -> None:
        installer = (ROOT / "templates/install.sh.in").read_text()
        postinst = (ROOT / "templates/postinst.in").read_text()
        self.assertIn('test "$#" -eq 0', installer)
        self.assertIn("EXPECTED_HOST='jvxthcorvm'", installer)
        self.assertIn("EXPECTED_AUDIT_RECORDS='43'", installer)
        self.assertIn("EXPECTED_AUDIT_DIGEST='7d00ca9a", installer)
        self.assertIn("OLD_PROFILE_ID='crm-d4575d20f91e-gravity-source-v1'", installer)
        self.assertIn("OLD_DEB_SHA='db5a91ea3192c541", installer)
        self.assertIn('readonly OLD_DEB_SOURCE="$EXPECTED_DIR/$OLD_DEB"', installer)
        self.assertIn('readonly OLD_DEB_STORED="$OLD_DEB_STORE/$OLD_DEB"', installer)
        self.assertIn('/usr/bin/dpkg --install "$OLD_DEB_STORED"', installer)
        self.assertNotIn("assert v[", installer)
        self.assertNotIn("2.0.0-9_all.deb", installer)
        for forbidden in ("curl ", "wget ", "git clone", "apt-get", "docker compose", "pg_dump", "psql "):
            self.assertNotIn(forbidden, installer)
        for denied in ("/bin/sh -c ':'", "/usr/bin/docker ps", "/usr/bin/dpkg --status sudo", "self-check unexpected", "predecessor-observe crm.container.telegram_bot", "fs-stat ../../../etc", "service-restart crm.container.unrelated"):
            self.assertIn(denied, postinst)
        self.assertIn("predecessor-observe", (ROOT / "packaging/92-yoko-privileged-runtime").read_text())
        self.assertNotIn("NOPASSWD: ALL", (ROOT / "packaging/92-yoko-privileged-runtime").read_text())

    def test_installer_requires_complete_provenance_and_full_identity(self) -> None:
        installer = (ROOT / "templates/install.sh.in").read_text()
        self.assertIn('expected=[]', installer)
        self.assertIn('e.get("complete") is not True', installer)
        self.assertIn('e.get("failures")!=expected', installer)
        self.assertIn('record["semantic"].get("name")!=name', installer)
        self.assertIn('semantic["records"]!=expected_semantic', installer)
        self.assertIn('semantic["fingerprint_sha256"]!=semantic_sha256', installer)
        self.assertIn('"failures_sha256"', installer)
        self.assertIn('"semantic_sha256"', installer)
        self.assertIn('"containers_sha256"', installer)
        self.assertIn('test "$pre_provenance_identity" = "$post_provenance_identity"', installer)
        self.assertNotIn('"seo.container.site","code":"CONTAINER_NOT_FOUND"', installer)

    def test_installer_provenance_validator_rejects_failure_and_shape_drift(self) -> None:
        installer = (ROOT / "templates/install.sh.in").read_text()
        match = re.search(r"provenance_identity\(\) \{\n    /usr/bin/python3 -I -c '\n(.*?)\n'\n\}", installer, re.DOTALL)
        self.assertIsNotNone(match)
        script = match.group(1)
        semantic = {"name": "crm-gravity-mvp", "image_id": "sha256:" + "b" * 64}
        record = {
            "name": "crm-gravity-mvp",
            "container_id": "a" * 64,
            "image_id": "sha256:" + "b" * 64,
            "status": "running",
            "started_at": "2026-08-13T00:00:00Z",
            "restart_count": 0,
            "semantic": semantic,
        }
        expected_fingerprint = hashlib.sha256(json.dumps(
            {"records": [semantic], "schema": "yoko.ai-calls.production-semantic-identity.v1"},
            sort_keys=True, separators=(",", ":"),
        ).encode("ascii")).hexdigest()

        def run(value: dict[str, object]) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                ["/usr/bin/python3", "-I", "-c", script],
                input=json.dumps(value), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=30,
            )

        accepted = {"ok": True, "evidence": {"complete": True, "failures": [], "records": [record], "semantic": {"schema": "yoko.ai-calls.production-semantic-identity.v1", "records": [semantic], "fingerprint_sha256": expected_fingerprint}}}
        self.assertEqual(run(accepted).returncode, 0)
        candidates = []
        for failures, complete in (
            ([], False),
            ([{"logical_resource": "seo.container.site", "code": "CONTAINER_NOT_FOUND"}], True),
            ([{"logical_resource": "crm.container.telegram_bot", "code": "CONTAINER_NOT_FOUND"}], False),
            ([{"logical_resource": "seo.container.site", "code": "CONTAINER_NOT_FOUND"}, {"logical_resource": "crm.container.max_scraper", "code": "CONTAINER_NOT_FOUND"}], False),
        ):
            value = json.loads(json.dumps(accepted))
            value["evidence"]["failures"] = failures
            value["evidence"]["complete"] = complete
            candidates.append(value)
        wrong_cross_bind = json.loads(json.dumps(accepted))
        wrong_cross_bind["evidence"]["semantic"]["records"][0]["image_id"] = "sha256:" + "c" * 64
        candidates.append(wrong_cross_bind)
        wrong_fingerprint = json.loads(json.dumps(accepted))
        wrong_fingerprint["evidence"]["semantic"]["fingerprint_sha256"] = "0" * 64
        candidates.append(wrong_fingerprint)
        missing_record = json.loads(json.dumps(accepted))
        missing_record["evidence"]["records"] = []
        candidates.append(missing_record)
        for candidate in candidates:
            self.assertNotEqual(run(candidate).returncode, 0)

    def test_all_build_layers_require_deterministic_double_output(self) -> None:
        seal = (ROOT / "packaging/seal-release.py").read_text()
        package = (ROOT / "packaging/build-package.sh").read_text()
        bundle = (ROOT / "packaging/build-bootstrap-bundle.sh").read_text()
        self.assertIn("if first != second", seal)
        self.assertIn('/usr/bin/cmp "$WORK/a.deb" "$WORK/b.deb"', package)
        self.assertIn('/usr/bin/cmp "$WORK/a.tar" "$WORK/b.tar"', bundle)

    def test_internal_critic_cannot_self_issue_its_review(self) -> None:
        finalizer = (ROOT / "packaging/finalize-evidence.py").read_text()
        critic = (ROOT / "packaging/verify-independent-critic.py").read_text()
        self.assertIn('--verify-bootstrap-review', finalizer)
        self.assertIn('yoko.crm.transition-identity-strategy-independent-runtime-review-verification.v1', finalizer)
        self.assertIn('review_verification.get("sealed_release_sha256") != sha(SEAL)', finalizer)
        self.assertIn('"self_issued_review_accepted": False', finalizer)
        self.assertIn('mode.add_argument("--bootstrap-review-evidence"', critic)
        self.assertIn('mode.add_argument("--verify-bootstrap-review"', critic)
        self.assertNotIn('def build_critic_artifact', critic)
        self.assertNotIn('def build_internal_review', critic)
        self.assertNotIn('REVIEWER =', critic)

    def test_sealer_fails_closed_on_dirty_unaccepted_or_schema_delta(self) -> None:
        seal = (ROOT / "packaging/seal-release.py").read_text()
        self.assertIn('"status", "--porcelain", "--untracked-files=all"', seal)
        self.assertIn('validate_hosted_ci_attestation(', seal)
        self.assertIn('hosted CI did not attest the exact full 52-control semantic catalog', seal)
        self.assertIn('workflow["sha256"] != sha(workflow_bytes)', seal)
        self.assertIn('run_identity["head_sha"] != commit', seal)
        self.assertIn('if check_identity != {', seal)
        self.assertIn('"head_sha": commit,', seal)
        self.assertIn('PREDECESSOR_COMMIT, commit, "--", "gravity-mvp/prisma/migrations"', seal)
        self.assertIn('"--predecessor-attestation"', seal)
        self.assertIn('gravity_attested != authority_predecessor', seal)
        self.assertIn('attestation_inventory_sha256 != attestation["inventory_sha256"]', seal)
        self.assertIn('sha(attestation_bytes) != "f08319ddfb0feb53a43b45c9e9865707d91c3a827c77cece6b42b8928e1b9a16"', seal)
        self.assertIn("exact_accepted_commit_input(", seal)
        self.assertIn("MIGRATION_AUTHORITY_PATH", seal)
        self.assertIn("is not the exact accepted-commit Git blob", seal)
        self.assertIn("bind_builder_source(repo, commit, ROOT)", seal)
        self.assertIn('"accepted_builder_source": accepted_builder_source', seal)
        self.assertIn("unaccepted Runtime builder staging entry", seal)
        self.assertIn('PINNED_PREDECESSOR_ATTESTATION_ROW_ORDER_PLUS_CURRENT_TARGET', seal)
        self.assertIn('accepted_live_chronology_sha256', seal)
        self.assertIn('accepted live migration chronology authority drift', seal)
        self.assertIn('"status"] != "ACCEPTED_READ_ONLY_CAPTURE"', seal)
        self.assertIn('acceptance record lacks independent reviewer identity or UTC acceptance time', seal)


class RealDockerTgBaseReferenceTests(unittest.TestCase):
    @staticmethod
    def _docker(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            args,
            cwd=cwd,
            env={**os.environ, "DOCKER_BUILDKIT": "1"},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=180,
        )

    @unittest.skipUnless(os.environ.get("YOKO_RUNTIME_REAL_DOCKER") == "1", "real Docker regression is an explicit hosted gate")
    def test_real_buildkit_rejects_bare_config_id_and_builds_from_repo_digest(self) -> None:
        base_reference = os.environ.get("YOKO_TG_REFERENCE_TEST_BASE", "")
        self.assertRegex(base_reference, r"^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$")
        server = self._docker("/usr/bin/docker", "version", "--format", "{{json .Server}}")
        self.assertEqual(server.returncode, 0, server.stderr.decode("utf-8", "replace"))
        self.assertIsInstance(json.loads(server.stdout), dict)
        inspected = self._docker("/usr/bin/docker", "image", "inspect", base_reference)
        self.assertEqual(inspected.returncode, 0, inspected.stderr.decode("utf-8", "replace"))
        image = json.loads(inspected.stdout)[0]
        image_id = image["Id"]
        self.assertRegex(image_id, r"^sha256:[0-9a-f]{64}$")
        self.assertIn(base_reference, image.get("RepoDigests") or [])

        target = f"yoko/tg-base-reference-regression:{os.getpid()}-{time.time_ns()}"
        self.addCleanup(lambda: self._docker("/usr/bin/docker", "image", "rm", target))
        with tempfile.TemporaryDirectory(prefix="yoko-tg-base-reference-") as temporary:
            context = Path(temporary)
            (context / "public-bot-maintenance.js").write_text("export const regression = true;\n", encoding="ascii")
            dockerfile = context / "Dockerfile"
            dockerfile.write_text(
                f"FROM {image_id}\n"
                "COPY --chown=0:0 --chmod=0644 public-bot-maintenance.js /app/src/public-bot-maintenance.js\n",
                encoding="ascii",
            )
            rejected = self._docker(
                "/usr/bin/docker", "build", "--pull=false", "--network", "none", "--no-cache",
                "--tag", target, "--file", str(dockerfile), str(context), cwd=context,
            )
            self.assertNotEqual(rejected.returncode, 0, "BuildKit unexpectedly accepted a bare config-image ID in FROM")
            rejection = (rejected.stdout + rejected.stderr).decode("utf-8", "replace").lower()
            self.assertIn(image_id, rejection)
            self.assertTrue(
                any(marker in rejection for marker in ("failed to resolve", "not found", "pull access denied", "invalid reference")),
                rejection,
            )

            dockerfile.write_text(
                f"FROM {base_reference}\n"
                "LABEL yoko.tg-bot.base-image=\"regression-pinned\"\n"
                "COPY --chown=0:0 --chmod=0644 public-bot-maintenance.js /app/src/public-bot-maintenance.js\n",
                encoding="ascii",
            )
            accepted = self._docker(
                "/usr/bin/docker", "build", "--pull=false", "--network", "none", "--no-cache",
                "--tag", target, "--file", str(dockerfile), str(context), cwd=context,
            )
            self.assertEqual(accepted.returncode, 0, accepted.stderr.decode("utf-8", "replace"))
            derived = self._docker("/usr/bin/docker", "image", "inspect", target)
            self.assertEqual(derived.returncode, 0, derived.stderr.decode("utf-8", "replace"))
            value = json.loads(derived.stdout)[0]
            self.assertEqual((value.get("Config") or {}).get("Labels", {}).get("yoko.tg-bot.base-image"), "regression-pinned")

    @unittest.skipUnless(os.environ.get("YOKO_RUNTIME_REAL_DOCKER") == "1", "real Docker regression is an explicit hosted gate")
    def test_real_compose_failed_activation_and_rollback_restore_exact_predecessor_semantics(self) -> None:
        base_reference = os.environ.get("YOKO_TG_REFERENCE_TEST_BASE", "")
        self.assertRegex(base_reference, r"^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$")
        server = self._docker("/usr/bin/docker", "version", "--format", "{{json .Server}}")
        self.assertEqual(server.returncode, 0, server.stderr.decode("utf-8", "replace"))
        loader = importlib.machinery.SourceFileLoader(
            f"yoko_real_rollback_{os.getpid()}_{time.time_ns()}",
            str(ROOT / "src/crm-activation-profile.py"),
        )
        spec = importlib.util.spec_from_loader(loader.name, loader)
        self.assertIsNotNone(spec)
        assert spec is not None
        runtime = importlib.util.module_from_spec(spec)
        sys.modules[loader.name] = runtime
        loader.exec_module(runtime)
        suffix = f"{os.getpid()}-{time.time_ns()}"
        project = f"yokorollback{os.getpid()}{time.time_ns()}"
        tags = {
            "gravity_prior": f"yoko/rollback-fixture-gravity:{suffix}-prior",
            "gravity_rollback": f"yoko/rollback-fixture-gravity:{suffix}-rollback",
            "gravity_target": f"yoko/rollback-fixture-gravity:{suffix}-target",
            "tg_prior": f"yoko/rollback-fixture-tg:{suffix}-prior",
            "tg_rollback": f"yoko/rollback-fixture-tg:{suffix}-rollback",
            "tg_target": f"yoko/rollback-fixture-tg:{suffix}-target",
        }
        names = {
            "gravity": f"{project}-gravity",
            "tg": f"{project}-tg",
            "db": f"{project}-db",
        }

        def docker(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[bytes]:
            return self._docker("/usr/bin/docker", *args, cwd=cwd)

        def required(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[bytes]:
            completed = docker(*args, cwd=cwd)
            self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", "replace"))
            return completed

        with tempfile.TemporaryDirectory(prefix="yoko-real-rollback-") as temporary:
            root = Path(temporary)
            gravity_service = root / "gravity-service"
            gravity_service.write_text(
                "#!/bin/sh\n"
                "while true; do\n"
                "  { printf 'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: 21\\r\\nConnection: close\\r\\n\\r\\n{\"status\":\"degraded\"}'; } | /bin/busybox nc -l -p 3002\n"
                "done\n",
                encoding="ascii",
            )
            tg_service = root / "tg-service"
            tg_service.write_text(
                "#!/bin/sh\n"
                "while true; do\n"
                "  { printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nOK'; } | /bin/busybox nc -l -p 3001\n"
                "done\n",
                encoding="ascii",
            )
            launcher = root / "launcher"
            launcher.write_text("#!/bin/sh\nexec /usr/local/bin/gravity-service\n", encoding="ascii")
            gravity_dockerfile = root / "Dockerfile.gravity"
            gravity_dockerfile.write_text(
                "ARG BASE\n"
                "FROM ${BASE}\n"
                "COPY --chmod=0755 gravity-service /usr/local/bin/gravity-service\n"
                "COPY --chmod=0755 launcher /usr/local/bin/npm\n"
                "COPY --chmod=0755 launcher /usr/local/bin/npx\n"
                "ENTRYPOINT []\n"
                "CMD [\"npx\",\"prisma\",\"migrate\",\"deploy\",\"&&\",\"npm\",\"run\",\"start\"]\n"
                "HEALTHCHECK --interval=1s --timeout=1s --retries=10 CMD /bin/busybox wget -q -O - http://127.0.0.1:3002/ >/dev/null || exit 1\n",
                encoding="ascii",
            )
            tg_dockerfile = root / "Dockerfile.tg"
            tg_dockerfile.write_text(
                "ARG BASE\n"
                "FROM ${BASE}\n"
                "COPY --chmod=0755 tg-service /usr/local/bin/tg-service\n"
                "ENTRYPOINT []\n"
                "CMD [\"/usr/local/bin/tg-service\"]\n"
                "HEALTHCHECK --interval=1s --timeout=1s --retries=10 CMD /bin/busybox wget -q -O - http://127.0.0.1:3001/ >/dev/null || exit 1\n",
                encoding="ascii",
            )
            for dockerfile, tag in (
                (gravity_dockerfile, tags["gravity_prior"]),
                (tg_dockerfile, tags["tg_prior"]),
            ):
                required(
                    "build", "--pull=false", "--network", "none", "--no-cache",
                    "--build-arg", f"BASE={base_reference}", "--tag", tag,
                    "--file", str(dockerfile), str(root), cwd=root,
                )
            required("tag", tags["gravity_prior"], tags["gravity_rollback"])
            required("tag", tags["tg_prior"], tags["tg_rollback"])
            target_gravity = root / "Dockerfile.gravity-target"
            target_gravity.write_text(
                f"FROM {tags['gravity_prior']}\n"
                "LABEL yoko.rollback-fixture=target-gravity\n"
                "HEALTHCHECK --interval=1s --timeout=1s --retries=2 CMD exit 1\n",
                encoding="ascii",
            )
            target_tg = root / "Dockerfile.tg-target"
            target_tg.write_text(
                f"FROM {tags['tg_prior']}\nLABEL yoko.rollback-fixture=target-tg\n",
                encoding="ascii",
            )
            required("build", "--pull=false", "--network", "none", "--no-cache", "--tag", tags["gravity_target"], "--file", str(target_gravity), str(root), cwd=root)
            required("build", "--pull=false", "--network", "none", "--no-cache", "--tag", tags["tg_target"], "--file", str(target_tg), str(root), cwd=root)

            base = root / "compose.yml"
            base.write_text(
                "services:\n"
                "  gravity-mvp:\n"
                f"    image: {tags['gravity_prior']}\n"
                f"    container_name: {names['gravity']}\n"
                "    networks: [fixture]\n"
                "  tg-bot:\n"
                f"    image: {tags['tg_prior']}\n"
                f"    container_name: {names['tg']}\n"
                "    networks: [fixture]\n"
                "  postgres:\n"
                f"    image: {base_reference}\n"
                f"    container_name: {names['db']}\n"
                "    environment:\n"
                "      POSTGRES_PASSWORD: fixture\n"
                "    healthcheck:\n"
                "      test: [\"CMD-SHELL\", \"pg_isready -U postgres\"]\n"
                "      interval: 1s\n"
                "      timeout: 1s\n"
                "      retries: 20\n"
                "    networks: [fixture]\n"
                "networks:\n"
                "  fixture: {}\n",
                encoding="ascii",
            )
            predecessor = root / "predecessor.yml"
            predecessor.write_bytes(
                runtime._compose_overlay(
                    tags["gravity_rollback"], tags["tg_rollback"], activate=False,
                ),
            )
            target = root / "target.yml"
            target.write_bytes(
                runtime._compose_overlay(
                    tags["gravity_target"], tags["tg_target"], activate=True,
                ),
            )
            drift = root / "drift.yml"
            drift.write_text(
                "services:\n"
                "  gravity-mvp:\n"
                f"    image: {tags['gravity_rollback']}\n"
                "    command: [\"npm\", \"run\", \"start\"]\n"
                "  tg-bot:\n"
                f"    image: {tags['tg_prior']}\n",
                encoding="ascii",
            )

            compose = ("compose", "--project-name", project, "--project-directory", str(root), "-f", str(base))
            self.addCleanup(lambda: docker("image", "rm", *reversed(list(tags.values()))))
            self.addCleanup(lambda: docker("network", "rm", f"{project}_fixture"))
            self.addCleanup(lambda: docker("container", "rm", "--force", names["gravity"], names["tg"], names["db"]))
            required(*compose, "up", "-d", "--wait", "--wait-timeout", "30", "postgres", cwd=root)
            required(*compose, "-f", str(predecessor), "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "--wait", "--wait-timeout", "30", "gravity-mvp", "tg-bot", cwd=root)

            def inspect(name: str) -> dict[str, object]:
                return json.loads(required("container", "inspect", name).stdout)[0]

            predecessor_gravity = inspect(names["gravity"])
            predecessor_tg = inspect(names["tg"])
            predecessor_db = inspect(names["db"])

            def semantics(gravity: dict[str, object], tg: dict[str, object]) -> dict[str, object]:
                return {
                    "gravity": {
                        "image": gravity["Image"],
                        "command": gravity["Config"]["Cmd"],
                        "config_hash": gravity["Config"]["Labels"]["com.docker.compose.config-hash"],
                        "health": gravity["State"]["Health"]["Status"],
                    },
                    "tg": {
                        "image": tg["Image"],
                        "command": tg["Config"]["Cmd"],
                        "config_hash": tg["Config"]["Labels"]["com.docker.compose.config-hash"],
                        "health": tg["State"]["Health"]["Status"],
                    },
                }

            predecessor_provenance = semantics(predecessor_gravity, predecessor_tg)
            sentinel = required(
                "exec", names["db"], "psql", "-U", "postgres", "-Atqc",
                "CREATE TABLE yoko_rollback_fixture(id integer PRIMARY KEY, value text NOT NULL); "
                "INSERT INTO yoko_rollback_fixture VALUES (1, 'unchanged'); "
                "SELECT id::text || ':' || value FROM yoko_rollback_fixture ORDER BY id;",
            ).stdout
            database_digest = hashlib.sha256(sentinel).hexdigest()

            state_path = root / "release-state.json"
            audit_path = root / "release-audit.jsonl"
            state = {"phase": "MIGRATED", "profile": "controlled-real-docker-fixture"}
            state_path.write_text(json.dumps(state, sort_keys=True) + "\n", encoding="ascii")

            def transition(phase: str, result: str) -> None:
                nonlocal state
                before = hashlib.sha256(json.dumps(state, sort_keys=True).encode("ascii")).hexdigest()
                next_state = {**state, "phase": phase}
                after = hashlib.sha256(json.dumps(next_state, sort_keys=True).encode("ascii")).hexdigest()
                previous = "0" * 64
                if audit_path.exists():
                    previous = json.loads(audit_path.read_text(encoding="ascii").splitlines()[-1])["digest"]
                body = {"previous": previous, "pre": before, "post": after, "result": result}
                record = {**body, "digest": hashlib.sha256(json.dumps(body, sort_keys=True).encode("ascii")).hexdigest()}
                with audit_path.open("a", encoding="ascii") as handle:
                    handle.write(json.dumps(record, sort_keys=True) + "\n")
                state = next_state
                state_path.write_text(json.dumps(state, sort_keys=True) + "\n", encoding="ascii")

            expected = {
                "gravity_image": predecessor_gravity["Image"],
                "gravity_command": predecessor_gravity["Config"]["Cmd"],
                "gravity_config": predecessor_gravity["Config"]["Labels"]["com.docker.compose.config-hash"],
                "tg_image": predecessor_tg["Image"],
                "tg_command": predecessor_tg["Config"]["Cmd"],
                "tg_config": predecessor_tg["Config"]["Labels"]["com.docker.compose.config-hash"],
                "db_id": predecessor_db["Id"],
                "db_image": predecessor_db["Image"],
            }
            self.assertEqual(
                expected["gravity_command"],
                ["npx", "prisma", "migrate", "deploy", "&&", "npm", "run", "start"],
            )
            transition("RELEASE_ACTIVATION_INTENT", "activation_intent")
            failed = docker(*compose, "-f", str(target), "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "--wait", "--wait-timeout", "10", "gravity-mvp", "tg-bot", cwd=root)
            self.assertNotEqual(failed.returncode, 0, "forced activation failure unexpectedly passed")
            transition("RELEASE_ACTIVATION_ROLLBACK_INTENT", "forced_activation_failure")

            required(*compose, "-f", str(predecessor), "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "--wait", "--wait-timeout", "30", "gravity-mvp", "tg-bot", cwd=root)
            rolled_gravity = inspect(names["gravity"])
            rolled_tg = inspect(names["tg"])
            rolled_db = inspect(names["db"])
            transition("ROLLED_BACK", "automatic_rollback_exact")
            self.assertEqual(rolled_gravity["Image"], expected["gravity_image"])
            self.assertEqual(rolled_gravity["Config"]["Cmd"], expected["gravity_command"])
            self.assertEqual(rolled_gravity["Config"]["Labels"]["com.docker.compose.config-hash"], expected["gravity_config"])
            self.assertEqual(rolled_tg["Image"], expected["tg_image"])
            self.assertEqual(rolled_tg["Config"]["Cmd"], expected["tg_command"])
            self.assertEqual(rolled_tg["Config"]["Labels"]["com.docker.compose.config-hash"], expected["tg_config"])
            self.assertEqual((rolled_db["Id"], rolled_db["Image"]), (expected["db_id"], expected["db_image"]))
            self.assertEqual(semantics(rolled_gravity, rolled_tg), predecessor_provenance)
            rolled_sentinel = required(
                "exec", names["db"], "psql", "-U", "postgres", "-Atqc",
                "SELECT id::text || ':' || value FROM yoko_rollback_fixture ORDER BY id;",
            ).stdout
            self.assertEqual(hashlib.sha256(rolled_sentinel).hexdigest(), database_digest)
            required("exec", names["gravity"], "/bin/busybox", "wget", "-q", "-O", "-", "http://127.0.0.1:3002/")
            required("exec", names["tg"], "/bin/busybox", "wget", "-q", "-O", "-", "http://127.0.0.1:3001/")

            # Reproduce the strategy defect: old image IDs are back, but the
            # post-activation target command is incorrectly imposed on the
            # rollback domain, producing semantic/config drift.
            required(*compose, "-f", str(drift), "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "--wait", "--wait-timeout", "30", "gravity-mvp", "tg-bot", cwd=root)
            drifted_gravity = inspect(names["gravity"])
            drifted_tg = inspect(names["tg"])
            self.assertEqual(drifted_gravity["Image"], expected["gravity_image"])
            self.assertEqual(drifted_tg["Image"], expected["tg_image"])
            self.assertNotEqual(drifted_gravity["Config"]["Cmd"], expected["gravity_command"])
            self.assertNotEqual(drifted_gravity["Config"]["Labels"]["com.docker.compose.config-hash"], expected["gravity_config"])
            self.assertNotEqual(drifted_tg["Config"]["Labels"]["com.docker.compose.config-hash"], expected["tg_config"])
            transition("ROLLBACK_INTENT", "drifted_predecessor_detected")

            required(*compose, "-f", str(predecessor), "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "--wait", "--wait-timeout", "30", "gravity-mvp", "tg-bot", cwd=root)
            recovered_gravity = inspect(names["gravity"])
            recovered_tg = inspect(names["tg"])
            recovered_db = inspect(names["db"])
            transition("ROLLED_BACK", "rollback_intent_recovery_exact")
            self.assertEqual(recovered_gravity["Config"]["Cmd"], expected["gravity_command"])
            self.assertEqual(recovered_gravity["Config"]["Labels"]["com.docker.compose.config-hash"], expected["gravity_config"])
            self.assertEqual(recovered_tg["Config"]["Labels"]["com.docker.compose.config-hash"], expected["tg_config"])
            self.assertEqual((recovered_db["Id"], recovered_db["Image"]), (expected["db_id"], expected["db_image"]))
            self.assertEqual(semantics(recovered_gravity, recovered_tg), predecessor_provenance)
            recovered_sentinel = required(
                "exec", names["db"], "psql", "-U", "postgres", "-Atqc",
                "SELECT id::text || ':' || value FROM yoko_rollback_fixture ORDER BY id;",
            ).stdout
            self.assertEqual(hashlib.sha256(recovered_sentinel).hexdigest(), database_digest)
            self.assertEqual(recovered_gravity["State"]["Health"]["Status"], "healthy")
            self.assertEqual(recovered_tg["State"]["Health"]["Status"], "healthy")
            required("exec", names["gravity"], "/bin/busybox", "wget", "-q", "-O", "-", "http://127.0.0.1:3002/")
            required("exec", names["tg"], "/bin/busybox", "wget", "-q", "-O", "-", "http://127.0.0.1:3001/")
            audit = [json.loads(line) for line in audit_path.read_text(encoding="ascii").splitlines()]
            previous = "0" * 64
            for record in audit:
                self.assertEqual(record["previous"], previous)
                body = {key: record[key] for key in ("previous", "pre", "post", "result")}
                self.assertEqual(record["digest"], hashlib.sha256(json.dumps(body, sort_keys=True).encode("ascii")).hexdigest())
                previous = record["digest"]
            self.assertEqual(state["phase"], "ROLLED_BACK")
            self.assertEqual(len(audit), 5)
            proof = {
                "activation_failure": "FORCED_UNHEALTHY_TARGET",
                "automatic_rollback": "EXACT_PREDECESSOR_RESTORED",
                "rollback_intent_recovery": "EXACT_PREDECESSOR_RESTORED",
                "database_identity_unchanged": True,
                "application_probes": {"gravity": "PASS", "tg": "PASS"},
                "terminal_state": "ROLLED_BACK",
            }
            self.assertRegex(hashlib.sha256(json.dumps(proof, sort_keys=True).encode("ascii")).hexdigest(), r"^[0-9a-f]{64}$")


class HostedCiAcceptanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        loader = importlib.machinery.SourceFileLoader(
            "yoko_runtime_v10_sealer_contract",
            str(ROOT / "packaging/seal-release.py"),
        )
        spec = importlib.util.spec_from_loader(loader.name, loader)
        assert spec is not None
        cls.sealer = importlib.util.module_from_spec(spec)
        sys.modules[loader.name] = cls.sealer
        loader.exec_module(cls.sealer)
        cls.commit = "a" * 40
        cls.tree = "b" * 40
        cls.workflow_bytes = b"name: Architecture enforcement\n"
        cls.runner_bytes = b"export const controls = 52\n"
        accepted = json.loads((ROOT / "acceptance-record.template.json").read_text())
        accepted.update({
            "commit": cls.commit,
            "tree": cls.tree,
            "accepted_by": "INDEPENDENT_TEST_REVIEWER",
            "accepted_at": "2026-08-13T00:00:00Z",
        })
        hosted_ci = accepted["authoritative_ci"]
        hosted_ci["source"] = {"commit": cls.commit, "tree": cls.tree}
        hosted_ci["workflow"]["sha256"] = hashlib.sha256(cls.workflow_bytes).hexdigest()
        hosted_ci["runner"]["sha256"] = hashlib.sha256(cls.runner_bytes).hexdigest()
        hosted_ci["run"] = {
            "id": 1000000001,
            "attempt": 1,
            "url": "https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/1000000001",
            "head_sha": cls.commit,
            "conclusion": "success",
        }
        architecture_url = "https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/1000000001/job/2000000002"
        hosted_ci["check"] = {
            "id": 2000000002,
            "name": "architecture",
            "url": architecture_url,
            "head_sha": cls.commit,
            "conclusion": "success",
        }
        hosted_ci["jobs"] = [
            {
                "id": 2000000002,
                "name": "architecture",
                "url": architecture_url,
                "head_sha": cls.commit,
                "status": "completed",
                "conclusion": "success",
            },
            {
                "id": 2000000003,
                "name": "gravity-artifact",
                "url": "https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/1000000001/job/2000000003",
                "head_sha": cls.commit,
                "status": "completed",
                "conclusion": "success",
            },
        ]
        hosted_ci["artifact"] = {
            "id": 3000000004,
            "name": f"gravity-image-{cls.commit}",
            "url": "https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/1000000001/artifacts/3000000004",
            "expired": False,
            "size_in_bytes": 2048,
            "digest": "sha256:" + "d" * 64,
            "workflow_run_id": 1000000001,
            "head_sha": cls.commit,
        }
        cls.accepted = accepted

    def test_healthy_published_outbox_growth_is_accepted_fail_closed(self) -> None:
        healthy = {
            "dead_letter": 0,
            "over_attempt_limit": 0,
            "pending": 0,
            "processing": 0,
            "published": 5,
            "retry_wait": 0,
            "stale_claimed": 0,
            "total": 5,
        }
        self.assertTrue(self.sealer.accepted_outbox_counts(healthy))
        for total in (1, 4, 999):
            candidate = dict(healthy, published=total, total=total)
            self.assertTrue(self.sealer.accepted_outbox_counts(candidate))
        for candidate in (
            dict(healthy, total=0, published=0),
            dict(healthy, published=4),
            dict(healthy, pending=1),
            dict(healthy, total=True),
            {key: value for key, value in healthy.items() if key != "stale_claimed"},
        ):
            self.assertFalse(self.sealer.accepted_outbox_counts(candidate))

    def clone(self) -> dict[str, object]:
        return json.loads(json.dumps(self.accepted))

    def test_streaming_helpers_reject_overrun_before_spooling(self) -> None:
        destination = io.BytesIO()
        self.assertEqual(
            self.sealer.stream_identity_to(io.BytesIO(b"exact"), destination, 5),
            (hashlib.sha256(b"exact").hexdigest(), 5),
        )
        self.assertEqual(destination.getvalue(), b"exact")
        with self.assertRaisesRegex(SystemExit, "exact byte bound"):
            self.sealer.stream_identity(io.BytesIO(b"too-large"), 8)
        rejected = io.BytesIO()
        with self.assertRaisesRegex(SystemExit, "exact byte bound"):
            self.sealer.stream_identity_to(io.BytesIO(b"too-large"), rejected, 8)
        self.assertEqual(rejected.getvalue(), b"")

    def test_duplicate_json_keys_fail_before_semantic_acceptance(self) -> None:
        with self.assertRaisesRegex(SystemExit, "invalid acceptance record"):
            self.sealer.strict_json_bytes(
                b'{"authoritative_ci":"FAIL","authoritative_ci":"PASS"}\n',
                "acceptance record",
            )
        with tempfile.TemporaryDirectory(prefix="yoko-exact-json-") as temporary:
            path = Path(temporary) / "duplicate.json"
            path.write_bytes(b'{"schema":"first","schema":"second"}\n')
            with self.assertRaisesRegex(SystemExit, "invalid"):
                self.sealer.load_exact(path, {"schema"})

    def test_tg_predecessor_absence_is_bound_to_immutable_image_manifest_not_live_container_id(self) -> None:
        manifest = (repository_root() / self.sealer.TG_BOT_BASELINE_MANIFEST_PATH).read_bytes()
        snapshot = {
            "tg_bot_container_id": "cb801c0f404669df1dc736f3e6889b4dad93a131015389e22881c772ceb682e1",
            "tg_bot_patch_baseline_manifest_file_sha256": self.sealer.TG_BOT_BASELINE_MANIFEST_FILE_SHA256,
            "tg_bot_patch_baseline_manifest_sha256": self.sealer.TG_BOT_BASELINE_MANIFEST_SHA256,
        }
        original_git_blob = self.sealer.git_blob
        try:
            self.sealer.git_blob = lambda _repo, _commit, _path: manifest
            self.sealer.validate_tg_bot_baseline_manifest(Path("/unused"), "0" * 40, snapshot)
            self.sealer.git_blob = lambda _repo, _commit, _path: manifest + b"\n"
            with self.assertRaisesRegex(SystemExit, "filesystem manifest identity drift"):
                self.sealer.validate_tg_bot_baseline_manifest(Path("/unused"), "0" * 40, snapshot)
            self.sealer.git_blob = lambda _repo, _commit, _path: manifest
            recreated_container = dict(snapshot, tg_bot_container_id="1" * 64)
            self.sealer.validate_tg_bot_baseline_manifest(Path("/unused"), "0" * 40, recreated_container)
        finally:
            self.sealer.git_blob = original_git_blob

    def test_seal_binds_independently_accepted_predecessor_release_identity(self) -> None:
        seal = (ROOT / "packaging/seal-release.py").read_text()
        self.assertIn(
            'snapshot["predecessor_release_critical_identity_sha256"] != ACCEPTED_PREDECESSOR_RECREATION_CONFIGURATION_SHA256',
            seal,
        )
        self.assertIn(
            '"predecessor_release_critical_identity_sha256": ACCEPTED_PREDECESSOR_RELEASE_CRITICAL_IDENTITY_SHA256',
            seal,
        )
        self.assertIn('"accepted_predecessor_release_critical_identity_sha256"', seal)
        self.assertIn('"accepted_predecessor_recreation_configuration_sha256"', seal)

    def test_migration_authority_input_is_exact_accepted_commit_blob(self) -> None:
        authority_path = repository_root() / MIGRATION_AUTHORITY_PATH
        exact_bytes = authority_path.read_bytes()
        authority = json.loads(exact_bytes)
        reduced = {
            "schema": authority["schema"],
            "version": authority["version"],
            "inventory_digest": authority["inventory_digest"],
            "current_target": authority["current_target"],
            "predecessor_runtime": {
                "excluded_separate_migration": authority["predecessor_runtime"]["excluded_separate_migration"],
            },
            "migrations": [
                {key: row[key] for key in ("name", "sha256", "size", "canonical_ordinal")}
                for row in authority["migrations"]
            ],
        }
        canonical_inventory = [
            {key: row[key] for key in ("name", "sha256", "size")}
            for row in sorted(reduced["migrations"], key=lambda row: row["name"])
        ]
        self.assertEqual(len(reduced["migrations"]), 62)
        self.assertEqual(
            reduced["inventory_digest"],
            hashlib.sha256((json.dumps(canonical_inventory, separators=(",", ":")) + "\n").encode("ascii")).hexdigest(),
        )
        self.assertNotIn("provenance_evidence", reduced)
        self.assertTrue(all("provenance" not in row for row in reduced["migrations"]))

        original_git_blob = self.sealer.git_blob
        self.sealer.git_blob = lambda _repo, _commit, relative: (
            exact_bytes if relative == self.sealer.MIGRATION_AUTHORITY_PATH else b""
        )
        try:
            with tempfile.TemporaryDirectory(prefix="runtime-v10-authority-bind-") as temporary:
                root = Path(temporary)
                exact = root / "exact.json"
                whitespace_modified = root / "whitespace-modified.json"
                structurally_reduced = root / "structurally-reduced.json"
                exact.write_bytes(exact_bytes)
                whitespace_modified.write_bytes(exact_bytes + b" ")
                structurally_reduced.write_text(json.dumps(reduced), encoding="ascii")
                self.assertEqual(
                    self.sealer.exact_accepted_commit_input(
                        Path("/accepted/repository"), self.commit,
                        self.sealer.MIGRATION_AUTHORITY_PATH, exact,
                        "production migration authority",
                    ),
                    exact_bytes,
                )
                for candidate in (whitespace_modified, structurally_reduced):
                    with self.subTest(candidate=candidate.name):
                        with self.assertRaisesRegex(SystemExit, "exact accepted-commit Git blob"):
                            self.sealer.exact_accepted_commit_input(
                                Path("/accepted/repository"), self.commit,
                                self.sealer.MIGRATION_AUTHORITY_PATH, candidate,
                                "production migration authority",
                            )
        finally:
            self.sealer.git_blob = original_git_blob

    def validate(
        self,
        value: object,
        workflow_bytes: bytes | None = None,
        runner_bytes: bytes | None = None,
    ) -> dict[str, object]:
        return self.sealer.validate_acceptance_record(
            value,
            self.commit,
            self.tree,
            self.workflow_bytes if workflow_bytes is None else workflow_bytes,
            self.runner_bytes if runner_bytes is None else runner_bytes,
        )

    def execution_proof(self) -> dict[str, object]:
        controls = self.accepted["authoritative_ci"]["controls"]
        return {
            "schema": "yoko.crm.authoritative-ci-execution-proof.v1",
            "outcome": "PASS",
            "source": {"commit": self.commit, "tree": self.tree},
            "workflow": {
                "path": self.sealer.AUTHORITATIVE_WORKFLOW_PATH,
                "sha256": hashlib.sha256(self.workflow_bytes).hexdigest(),
            },
            "runner": {
                "path": self.sealer.AUTHORITATIVE_RUNNER_PATH,
                "sha256": hashlib.sha256(self.runner_bytes).hexdigest(),
            },
            "runtime": {"node": "20.20.2", "blast_base": "HEAD^", "blast_base_commit": "e" * 40},
            "controls": {
                "count": controls["count"],
                "catalog_sha256": controls["catalog_sha256"],
                "semantic_catalog_sha256": controls["semantic_catalog_sha256"],
                "executions": [
                    {"id": control, "status": "PASS"}
                    for control in controls["catalog"]
                ],
            },
        }

    def test_template_and_positive_fixture_bind_exact_full_catalog(self) -> None:
        accepted = self.validate(self.clone())
        attestation = accepted["authoritative_ci"]
        controls = attestation["controls"]
        self.assertEqual(accepted["schema"], "yoko.crm.accepted-clean-release-commit.v2")
        self.assertEqual(attestation["schema"], "yoko.crm.hosted-authoritative-ci-attestation.v1")
        self.assertEqual(controls["count"], 52)
        self.assertEqual(len(controls["catalog"]), 52)
        self.assertEqual(len(set(controls["catalog"])), 52)
        self.assertEqual(controls["catalog"], list(self.sealer.AUTHORITATIVE_CONTROL_CATALOG))
        self.assertEqual(
            controls["catalog_sha256"],
            self.sealer.authoritative_control_catalog_sha256(),
        )
        self.assertEqual(
            controls["semantic_catalog_sha256"],
            "24ad32ba5a97e617e34bd19a3bcb2109807bf946636737d02b12fd7607185483",
        )
        proof = self.sealer.validate_ci_execution_proof(
            self.execution_proof(), self.commit, self.tree, "e" * 40,
            self.workflow_bytes, self.runner_bytes, controls,
        )
        self.assertEqual(len(proof["controls"]["executions"]), 52)

    def test_runner_emitted_proof_cannot_be_replaced_by_manual_catalog_claim(self) -> None:
        candidates = []
        missing = self.execution_proof()
        missing["controls"]["executions"].pop()
        candidates.append(missing)
        reordered = self.execution_proof()
        reordered["controls"]["executions"][0:2] = reversed(
            reordered["controls"]["executions"][0:2],
        )
        candidates.append(reordered)
        failed = self.execution_proof()
        failed["controls"]["executions"][20]["status"] = "FAIL"
        candidates.append(failed)
        wrong_source = self.execution_proof()
        wrong_source["source"]["commit"] = "9" * 40
        candidates.append(wrong_source)
        wrong_runner = self.execution_proof()
        wrong_runner["runner"]["sha256"] = "8" * 64
        candidates.append(wrong_runner)
        wrong_runtime = self.execution_proof()
        wrong_runtime["runtime"]["node"] = "20.20.1"
        candidates.append(wrong_runtime)
        forged_parent = self.execution_proof()
        forged_parent["runtime"]["blast_base_commit"] = "f" * 40
        candidates.append(forged_parent)
        for candidate in candidates:
            with self.subTest(candidate=candidates.index(candidate)):
                with self.assertRaises(SystemExit):
                    self.sealer.validate_ci_execution_proof(
                        candidate, self.commit, self.tree, "e" * 40,
                        self.workflow_bytes, self.runner_bytes,
                        self.accepted["authoritative_ci"]["controls"],
                    )
        with self.assertRaisesRegex(SystemExit, "invalid CI proof fixture"):
            self.sealer.strict_json_bytes(
                b'{"outcome":"FAIL","outcome":"PASS"}\n',
                "CI proof fixture",
            )

    def test_bare_string_and_forged_commit_tree_attestations_fail_closed(self) -> None:
        candidates = []
        bare = self.clone()
        bare["authoritative_ci"] = "PASS"
        candidates.append(bare)
        wrong_acceptance_commit = self.clone()
        wrong_acceptance_commit["commit"] = "c" * 40
        candidates.append(wrong_acceptance_commit)
        wrong_source_commit = self.clone()
        wrong_source_commit["authoritative_ci"]["source"]["commit"] = "c" * 40
        candidates.append(wrong_source_commit)
        wrong_source_tree = self.clone()
        wrong_source_tree["authoritative_ci"]["source"]["tree"] = "c" * 40
        candidates.append(wrong_source_tree)
        wrong_run_head = self.clone()
        wrong_run_head["authoritative_ci"]["run"]["head_sha"] = "c" * 40
        candidates.append(wrong_run_head)
        wrong_check_head = self.clone()
        wrong_check_head["authoritative_ci"]["check"]["head_sha"] = "c" * 40
        candidates.append(wrong_check_head)
        for candidate in candidates:
            with self.subTest(candidate=candidates.index(candidate)):
                with self.assertRaises(SystemExit):
                    self.validate(candidate)

    def test_schema_sync_authority_missing_or_false_fails_closed(self) -> None:
        missing = self.clone()
        del missing["schema_sync_to_production_authority"]
        false = self.clone()
        false["schema_sync_to_production_authority"] = False
        for label, candidate in (("missing", missing), ("false", false)):
            with self.subTest(label=label):
                with self.assertRaises(SystemExit):
                    self.validate(candidate)

    def test_workflow_and_runner_hash_drift_fail_closed(self) -> None:
        wrong_workflow_hash = self.clone()
        wrong_workflow_hash["authoritative_ci"]["workflow"]["sha256"] = "0" * 64
        wrong_runner_hash = self.clone()
        wrong_runner_hash["authoritative_ci"]["runner"]["sha256"] = "0" * 64
        cases = [
            (wrong_workflow_hash, self.workflow_bytes, self.runner_bytes),
            (wrong_runner_hash, self.workflow_bytes, self.runner_bytes),
            (self.clone(), b"drifted workflow\n", self.runner_bytes),
            (self.clone(), self.workflow_bytes, b"drifted runner\n"),
        ]
        for candidate, workflow, runner in cases:
            with self.subTest(workflow=workflow, runner=runner):
                with self.assertRaises(SystemExit):
                    self.validate(candidate, workflow, runner)

    def test_missing_or_forged_github_ids_and_urls_fail_closed(self) -> None:
        candidates = []
        for section, key in (("run", "id"), ("run", "url"), ("check", "id"), ("check", "url")):
            candidate = self.clone()
            del candidate["authoritative_ci"][section][key]
            candidates.append(candidate)
        bool_id = self.clone()
        bool_id["authoritative_ci"]["run"]["id"] = True
        candidates.append(bool_id)
        wrong_run_url = self.clone()
        wrong_run_url["authoritative_ci"]["run"]["url"] = "https://github.com/example/forged/actions/runs/1000000001"
        candidates.append(wrong_run_url)
        wrong_check_url = self.clone()
        wrong_check_url["authoritative_ci"]["check"]["url"] = "https://github.com/nashavtoparkmedia-byte/CRM/runs/999"
        candidates.append(wrong_check_url)
        for candidate in candidates:
            with self.subTest(candidate=candidates.index(candidate)):
                with self.assertRaises(SystemExit):
                    self.validate(candidate)

    def test_wrong_conclusion_count_or_catalog_fail_closed(self) -> None:
        candidates = []
        for section in ("run", "check"):
            candidate = self.clone()
            candidate["authoritative_ci"][section]["conclusion"] = "neutral"
            candidates.append(candidate)
        wrong_count = self.clone()
        wrong_count["authoritative_ci"]["controls"]["count"] = 51
        candidates.append(wrong_count)
        short_catalog = self.clone()
        short_catalog["authoritative_ci"]["controls"]["catalog"] = short_catalog["authoritative_ci"]["controls"]["catalog"][:-1]
        candidates.append(short_catalog)
        reordered_catalog = self.clone()
        reordered_catalog["authoritative_ci"]["controls"]["catalog"][0:2] = reversed(
            reordered_catalog["authoritative_ci"]["controls"]["catalog"][0:2],
        )
        candidates.append(reordered_catalog)
        wrong_catalog_digest = self.clone()
        wrong_catalog_digest["authoritative_ci"]["controls"]["catalog_sha256"] = "0" * 64
        candidates.append(wrong_catalog_digest)
        wrong_semantic_catalog_digest = self.clone()
        wrong_semantic_catalog_digest["authoritative_ci"]["controls"]["semantic_catalog_sha256"] = "0" * 64
        candidates.append(wrong_semantic_catalog_digest)
        for candidate in candidates:
            with self.subTest(candidate=candidates.index(candidate)):
                with self.assertRaises(SystemExit):
                    self.validate(candidate)


class SealedFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source_repo = repository_root()
        cls.temp = tempfile.TemporaryDirectory(
            prefix="runtime-2.0.0-13-test-", ignore_cleanup_errors=True,
        )
        temp = Path(cls.temp.name)
        cls.stage = temp / "stage"
        shutil.copytree(
            ROOT,
            cls.stage,
            ignore=shutil.ignore_patterns(
                "dist", "SEALED_RELEASE.json", "manifest.json", "OWNER_COMMAND.txt",
                "__pycache__", "*.pyc", "*.pyo",
                "yoko-privileged-runtime_2.0.0-9_all.deb",
            ),
        )
        (cls.stage / "dist").mkdir()
        # The production rollback artifact is intentionally external and too
        # large for source control. Exercise the exact same hash/provenance
        # binding with a disposable valid Debian package in this isolated
        # sealer fixture, then bind those fixture hashes into its accepted Git
        # commit before the sealer inventories any source byte.
        rollback_root = temp / "rollback-package-root"
        (rollback_root / "DEBIAN").mkdir(parents=True)
        (rollback_root / "DEBIAN/control").write_text(
            "Package: yoko-privileged-runtime\nVersion: 2.0.0-13\n"
            "Architecture: all\nMaintainer: Test <test@example.invalid>\n"
            "Description: bounded direct rollback fixture\n",
            encoding="ascii",
        )
        cls.direct_rollback_package = temp / "direct-rollback.deb"
        subprocess.run(
            ["/usr/bin/dpkg-deb", "--build", "--root-owner-group", str(rollback_root), str(cls.direct_rollback_package)],
            check=True, stdout=subprocess.DEVNULL, timeout=60,
        )
        fixture_rollback_sha = hashlib.sha256(cls.direct_rollback_package.read_bytes()).hexdigest()
        rollback_provenance = {
            "schema": "yoko.crm.source-only-release-seal.v2",
            "status": "SEALED",
            "commit": "d4575d20f91e0029fdcce9669b42478bd8e34e1f",
            "tree": "bd9524d524b6144eeb071a940cdc1c3035c3f056",
            "profile_id": "crm-d4575d20f91e-gravity-source-v1",
            "package_version": "2.0.0-13",
            "runtime_abi": "2.0.0",
            "built_artifacts": {"deb": {"sha256": fixture_rollback_sha}},
        }
        cls.direct_rollback_provenance = temp / "direct-rollback-provenance.json"
        cls.direct_rollback_provenance.write_text(
            json.dumps(rollback_provenance, sort_keys=True) + "\n", encoding="ascii",
        )
        fixture_provenance_sha = hashlib.sha256(cls.direct_rollback_provenance.read_bytes()).hexdigest()
        replacements = {
            "db5a91ea3192c541defa00fe432904357ff9d900be6dc8e13a5a024dddc1fa48": fixture_rollback_sha,
            "398ea232af257e7f75848257391bcf791f77d2fd468c1bf25cdcc72356e449c9": fixture_provenance_sha,
        }
        for path in cls.stage.rglob("*"):
            if not path.is_file():
                continue
            raw = path.read_bytes()
            replaced = raw
            for source, destination in replacements.items():
                replaced = replaced.replace(source.encode("ascii"), destination.encode("ascii"))
            if replaced != raw:
                mode = stat.S_IMODE(path.stat().st_mode)
                os.chmod(path, mode | stat.S_IWUSR)
                path.write_bytes(replaced)
                os.chmod(path, mode)
        cls.repo = temp / "repo"
        subprocess.run([
            "/usr/bin/git", "-c", "gc.auto=0", "-c", "gc.autoDetach=false",
            "-c", "maintenance.auto=false", "clone", "--quiet",
            str(cls.source_repo), str(cls.repo),
        ], check=True, timeout=180)
        subprocess.run(["/usr/bin/git", "-C", str(cls.repo), "config", "user.name", "Runtime v10 test fixture"], check=True)
        subprocess.run(["/usr/bin/git", "-C", str(cls.repo), "config", "user.email", "runtime-v10-fixture@example.invalid"], check=True)
        expected_patch_sha = json.loads((cls.stage / "templates/profile.v1.json.in").read_text())["accepted_source"]["tg_bot_patch_sha256"]
        committed_patch = git_blob(cls.repo, "HEAD", TG_PATCH_PATH)
        if hashlib.sha256(committed_patch).hexdigest() != expected_patch_sha:
            # Before the accepted commit exists, use only the reviewed Git index
            # blob. Never seal arbitrary dirty working-tree bytes. Once final
            # HEAD contains the patch this branch is intentionally a no-op.
            indexed_patch = git_blob(cls.source_repo, None, TG_PATCH_PATH)
            if hashlib.sha256(indexed_patch).hexdigest() != expected_patch_sha:
                raise RuntimeError("reviewed Git index lacks the exact TG capability patch")
            (cls.repo / TG_PATCH_PATH).write_bytes(indexed_patch)
            subprocess.run(["/usr/bin/git", "-C", str(cls.repo), "add", TG_PATCH_PATH], check=True)
            subprocess.run(["/usr/bin/git", "-C", str(cls.repo), "commit", "--quiet", "-m", "fixture: exact TG capability patch"], check=True)
        # Pre-commit development runs may not yet have the reviewed migration
        # authority in HEAD. Put the exact Git-index blob in the disposable
        # accepted fixture commit so the sealer exercises its real commit bind.
        reviewed_authority = git_blob(cls.source_repo, None, MIGRATION_AUTHORITY_PATH)
        try:
            committed_authority = git_blob(cls.repo, "HEAD", MIGRATION_AUTHORITY_PATH)
        except subprocess.CalledProcessError:
            committed_authority = b""
        if committed_authority != reviewed_authority:
            authority_path = cls.repo / MIGRATION_AUTHORITY_PATH
            authority_path.parent.mkdir(parents=True, exist_ok=True)
            authority_path.write_bytes(reviewed_authority)
            subprocess.run(["/usr/bin/git", "-C", str(cls.repo), "add", MIGRATION_AUTHORITY_PATH], check=True)
            subprocess.run(["/usr/bin/git", "-C", str(cls.repo), "commit", "--quiet", "-m", "fixture: exact migration authority"], check=True)
        # The production sealer executes the external staging builder only when
        # every tracked source byte is present in the exact accepted commit.
        # During pre-commit development, materialize those reviewed working
        # bytes into this disposable accepted fixture commit.
        fixture_runtime = cls.repo / RUNTIME_SOURCE_PREFIX
        if fixture_runtime.exists():
            shutil.rmtree(fixture_runtime)
        shutil.copytree(
            cls.stage,
            fixture_runtime,
            ignore=shutil.ignore_patterns(
                "dist", "SEALED_RELEASE.json", "manifest.json", "OWNER_COMMAND.txt",
                "__pycache__", "*.pyc", "*.pyo",
                "source.tar.gz", "gravity-image.docker.tar", "sealed-inputs.v1.json",
                "payload-manifest.json", "package-manifest.json",
                "yoko-privileged-runtime_2.0.0-13_all.deb",
            ),
        )
        subprocess.run(["/usr/bin/git", "-C", str(cls.repo), "add", "--all", "--", RUNTIME_SOURCE_PREFIX], check=True)
        if subprocess.run(
            ["/usr/bin/git", "-C", str(cls.repo), "diff", "--cached", "--quiet", "--", RUNTIME_SOURCE_PREFIX],
        ).returncode != 0:
            subprocess.run(["/usr/bin/git", "-C", str(cls.repo), "commit", "--quiet", "-m", "fixture: exact Runtime v10 builder"], check=True)
        subprocess.run(["/usr/bin/git", "-C", str(cls.repo), "config", "gc.auto", "0"], check=True)
        subprocess.run(["/usr/bin/git", "-C", str(cls.repo), "config", "maintenance.auto", "false"], check=True)
        cls.commit = subprocess.check_output(["/usr/bin/git", "-C", str(cls.repo), "rev-parse", "HEAD"], text=True).strip()
        cls.tree = subprocess.check_output(["/usr/bin/git", "-C", str(cls.repo), "rev-parse", "HEAD^{tree}"], text=True).strip()
        cls.parent = subprocess.check_output(["/usr/bin/git", "-C", str(cls.repo), "rev-parse", "HEAD^"], text=True).strip()
        cls.expected_patch_sha = expected_patch_sha
        if hashlib.sha256(git_blob(cls.repo, cls.commit, TG_PATCH_PATH)).hexdigest() != expected_patch_sha:
            raise RuntimeError("clean accepted fixture commit lacks the exact TG capability patch")
        if subprocess.check_output(["/usr/bin/git", "-C", str(cls.repo), "status", "--porcelain", "--untracked-files=all"], text=True):
            raise RuntimeError("accepted fixture repository is not clean")
        acceptance = json.loads((cls.stage / "acceptance-record.template.json").read_text())
        acceptance.update({"commit": cls.commit, "tree": cls.tree, "accepted_by": "INDEPENDENT_TEST_REVIEWER", "accepted_at": "2026-08-13T00:00:00Z"})
        hosted_ci = acceptance["authoritative_ci"]
        hosted_ci["source"] = {"commit": cls.commit, "tree": cls.tree}
        hosted_ci["workflow"]["sha256"] = hashlib.sha256(
            git_blob(cls.repo, cls.commit, AUTHORITATIVE_WORKFLOW_PATH),
        ).hexdigest()
        hosted_ci["runner"]["sha256"] = hashlib.sha256(
            git_blob(cls.repo, cls.commit, AUTHORITATIVE_RUNNER_PATH),
        ).hexdigest()
        hosted_ci["run"] = {
            "id": 1000000001,
            "attempt": 1,
            "url": "https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/1000000001",
            "head_sha": cls.commit,
            "conclusion": "success",
        }
        architecture_url = "https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/1000000001/job/2000000002"
        hosted_ci["check"] = {
            "id": 2000000002,
            "name": "architecture",
            "url": architecture_url,
            "head_sha": cls.commit,
            "conclusion": "success",
        }

        loader = importlib.machinery.SourceFileLoader(
            "yoko_runtime_v10_fixture_sealer", str(cls.stage / "packaging/seal-release.py"),
        )
        spec = importlib.util.spec_from_loader(loader.name, loader)
        assert spec is not None
        fixture_sealer = importlib.util.module_from_spec(spec)
        sys.modules[loader.name] = fixture_sealer
        loader.exec_module(fixture_sealer)

        layer_archive = deterministic_tar({"fixture.txt": b"hosted gravity image fixture\n"})
        layer_digest = hashlib.sha256(layer_archive).hexdigest()
        profile_id = f"crm-{cls.commit[:12]}-gravity-source-v1"
        config = {
            "architecture": "amd64",
            "os": "linux",
            "config": {"Labels": {
                "org.opencontainers.image.revision": cls.commit,
                "yoko.activation.profile": profile_id,
            }},
            "rootfs": {"type": "layers", "diff_ids": [f"sha256:{layer_digest}"]},
        }
        config_bytes = json.dumps(config, sort_keys=True, separators=(",", ":")).encode("ascii")
        image_hex = hashlib.sha256(config_bytes).hexdigest()
        image_reference = f"yoko/crm-gravity-mvp:{cls.commit}-source-only-v1"
        manifest_bytes = json.dumps([{
            "Config": f"{image_hex}.json",
            "RepoTags": [image_reference],
            "Layers": ["fixture-layer/layer.tar"],
        }], sort_keys=True, separators=(",", ":")).encode("ascii")
        docker_archive = deterministic_tar({
            "manifest.json": manifest_bytes,
            f"{image_hex}.json": config_bytes,
            "fixture-layer/layer.tar": layer_archive,
        })
        materials = {
            "dockerfile_sha256": hashlib.sha256(git_blob(cls.repo, cls.commit, "gravity-mvp/Dockerfile")).hexdigest(),
            "package_lock_sha256": hashlib.sha256(git_blob(cls.repo, cls.commit, "gravity-mvp/package-lock.json")).hexdigest(),
            "dockerfile_frontend": fixture_sealer.GRAVITY_FRONTEND,
            "node_base": fixture_sealer.GRAVITY_NODE_BASE,
            "debian_snapshot": fixture_sealer.GRAVITY_DEBIAN_SNAPSHOT,
            "buildx_version": fixture_sealer.GRAVITY_BUILDX_VERSION,
            "buildkit_image": fixture_sealer.GRAVITY_BUILDKIT_IMAGE,
            "build_args": fixture_sealer.GRAVITY_BUILD_ARGS,
        }
        materials["semantic_sha256"] = hashlib.sha256(
            (json.dumps(materials, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii"),
        ).hexdigest()
        machine_attestation = {
            "schema": "yoko.crm.hosted-gravity-image-artifact.v1",
            "repository": "nashavtoparkmedia-byte/CRM",
            "commit": cls.commit,
            "tree": cls.tree,
            "platform": "linux/amd64",
            "image_reference": image_reference,
            "image_id": f"sha256:{image_hex}",
            "docker_archive": {
                "path": "gravity-image.docker.tar",
                "sha256": hashlib.sha256(docker_archive).hexdigest(),
                "bytes": len(docker_archive),
            },
            "materials": materials,
        }
        controls = hosted_ci["controls"]
        ci_execution_proof = {
            "schema": "yoko.crm.authoritative-ci-execution-proof.v1",
            "outcome": "PASS",
            "source": {"commit": cls.commit, "tree": cls.tree},
            "workflow": {
                "path": AUTHORITATIVE_WORKFLOW_PATH,
                "sha256": hosted_ci["workflow"]["sha256"],
            },
            "runner": {
                "path": AUTHORITATIVE_RUNNER_PATH,
                "sha256": hosted_ci["runner"]["sha256"],
            },
            "runtime": {"node": "20.20.2", "blast_base": "HEAD^", "blast_base_commit": cls.parent},
            "controls": {
                "count": controls["count"],
                "catalog_sha256": controls["catalog_sha256"],
                "semantic_catalog_sha256": controls["semantic_catalog_sha256"],
                "executions": [
                    {"id": control, "status": "PASS"}
                    for control in controls["catalog"]
                ],
            },
        }
        cls.gravity_artifact = temp / "gravity-artifact.zip"
        with zipfile.ZipFile(cls.gravity_artifact, mode="w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("authoritative-ci-execution.json", json.dumps(
                ci_execution_proof, sort_keys=True, separators=(",", ":"),
            ) + "\n")
            archive.writestr("gravity-image-attestation.json", json.dumps(
                machine_attestation, sort_keys=True, separators=(",", ":"),
            ) + "\n")
            archive.writestr("gravity-image.docker.tar", docker_archive)
        artifact_id = 3000000004
        artifact_digest = f"sha256:{hashlib.sha256(cls.gravity_artifact.read_bytes()).hexdigest()}"
        artifact_size = cls.gravity_artifact.stat().st_size
        hosted_ci["jobs"] = [
            {
                "id": 2000000002,
                "name": "architecture",
                "url": architecture_url,
                "head_sha": cls.commit,
                "status": "completed",
                "conclusion": "success",
            },
            {
                "id": 2000000003,
                "name": "gravity-artifact",
                "url": "https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/1000000001/job/2000000003",
                "head_sha": cls.commit,
                "status": "completed",
                "conclusion": "success",
            },
        ]
        hosted_ci["artifact"] = {
            "id": artifact_id,
            "name": f"gravity-image-{cls.commit}",
            "url": f"https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/1000000001/artifacts/{artifact_id}",
            "expired": False,
            "size_in_bytes": artifact_size,
            "digest": artifact_digest,
            "workflow_run_id": 1000000001,
            "head_sha": cls.commit,
        }
        cls.acceptance = temp / "acceptance.json"
        cls.acceptance.write_text(json.dumps(acceptance), encoding="ascii")
        snapshot = {
            "runtime_package_version": "2.0.0-13",
            "runtime_abi": "2.0.0",
            "profile_id": "crm-d4575d20f91e-gravity-source-v1",
            "audit_state": "VALID",
            "audit_records": 43,
            "audit_last_digest": "7d00ca9a0081858f1137939298e71ace33a36c6d436984f478284ccc6a1b3d9e",
            "source_manifest_sha256": "ecfb0a8b6dc24121fb5c9efb58af28eb1f1626711ef1a6d977b0db29d05bdda3",
            "compose_sha256": "84a9f46904a65a69afcf19d2e56162e026b29718da52c43160abfc5449f84cc1",
            "compose_config_hash": "b40621c86f1f56f76879329430086b2675b9e434dfc593fd28e8a5d60e5c269c",
            "gravity_container_id": "86f18322adbc640771849c22163d746b73cd06c72c656f1d93b5695623fcaa73",
            "gravity_image_id": fixture_sealer.PREDECESSOR_IMAGE,
            "gravity_oci_revision": fixture_sealer.PREDECESSOR_COMMIT,
            "gravity_running": True,
            "gravity_health": "healthy",
            "gravity_restart_count": 0,
            "tg_bot_container_id": "c3fae82f86726739c6e768cd524f5903a1d0a9a0e926f86d9cc559ac633c0f7a",
            "tg_bot_image_id": fixture_sealer.TG_BOT_PREDECESSOR_IMAGE,
            "tg_bot_compose_config_hash": "cd3a0c2eb46ce09667a800c8527e106919c532602b0c077399d435ebb27ee7c6",
            "tg_bot_running": True,
            "tg_bot_health": "healthy",
            "tg_bot_restart_count": 0,
            "tg_bot_entrypoint": ["/usr/bin/tini", "--", "/usr/local/bin/tg-bot-entrypoint"],
            "tg_bot_cmd": ["node", "start.js"],
            "tg_bot_declared_user": "",
            "tg_bot_working_dir": "/app",
            "tg_bot_patch_path": fixture_sealer.TG_BOT_PATCH_DESTINATION,
            "tg_bot_patch_baseline_state": fixture_sealer.TG_BOT_BASELINE_STATE,
            "tg_bot_patch_baseline_manifest_file_sha256": fixture_sealer.TG_BOT_BASELINE_MANIFEST_FILE_SHA256,
            "tg_bot_patch_baseline_manifest_sha256": fixture_sealer.TG_BOT_BASELINE_MANIFEST_SHA256,
            "postgres_container_id": "57a09acd5b407d72934ea4cb398874fec60d25a815265b018ba9dd4ab5dbddda",
            "postgres_image_id": "sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229",
            "database_identity_sha256": "ed88dfeaad2a3dc2e759590d295992cd06531d4403d896ded00b21ea667be1c9",
            "migration_ledger_sha256": "a50f1a8988f79c85059354d6b2d45e9e8ed07284fc27c78d98face6680f25dfc",
            "predecessor_release_critical_identity_sha256": fixture_sealer.ACCEPTED_PREDECESSOR_RECREATION_CONFIGURATION_SHA256,
            "outbox_catalog_state": "EXACT",
            "outbox_counts": {"dead_letter": 0, "over_attempt_limit": 0, "pending": 0, "processing": 0, "published": 5, "retry_wait": 0, "stale_claimed": 0, "total": 5},
            "outbox_catalog_sha256": "ef0bce36bca8283b491a966ff3886644a8887f4bded3deebbec7ce559ac2defe",
            "rollback_recovery_required": True,
            "gravity_runtime_semantics_status": "DRIFTED_ROLLBACK_ALIAS_COMMAND_AND_CONFIG",
            "tg_bot_runtime_semantics_status": "DRIFTED_ROLLBACK_ALIAS_CONFIG",
            "sealed_gravity_compose_config_hash": "772ba8f19dc89133ea55ce65aa2d68550594ab61060eac0e373ae7936161b9f8",
            "gravity_command": ["npm", "run", "start"],
            "sealed_tg_bot_compose_config_hash": "00952518d668126c08950de087a7c46fa368cd8879590ad9c1584bb7c39b42e2",
            "tg_bot_command": ["node", "start.js"],
            "secret_values_emitted": False,
            "production_mutated": False,
        }
        snapshot_document = {
            "schema": "yoko.crm.source-only-production-snapshot.v3",
            "status": "ACCEPTED_READ_ONLY_CAPTURE",
            "host": "jvxthcorvm",
        }
        class FixtureCaptureVerifier:
            @staticmethod
            def load_snapshot(_path: Path) -> dict[str, object]:
                return snapshot_document

            @staticmethod
            def sealing_values(_document: dict[str, object]) -> dict[str, object]:
                return snapshot

        fixture_sealer.production_capture_module = lambda: FixtureCaptureVerifier
        cls.snapshot = temp / "snapshot.json"
        cls.snapshot.write_text(json.dumps(snapshot_document), encoding="ascii")
        cls.authority = temp / "production-migration-authority.json"
        cls.attestation = temp / "predecessor-runtime-migration-inventory.json"
        for relative, destination in (
            (MIGRATION_AUTHORITY_PATH, cls.authority),
            (PREDECESSOR_ATTESTATION_PATH, cls.attestation),
        ):
            try:
                accepted_bytes = git_blob(cls.repo, cls.commit, relative)
            except subprocess.CalledProcessError:
                # Pre-commit development runs use the reviewed index. At final
                # HEAD both inputs are read from the same accepted clean commit.
                accepted_bytes = git_blob(cls.source_repo, None, relative)
            destination.write_bytes(accepted_bytes)
        live_values = {
            "actions/runs/1000000001": {
                "id": 1000000001,
                "head_sha": cls.commit,
                "run_attempt": 1,
                "status": "completed",
                "conclusion": "success",
                "path": AUTHORITATIVE_WORKFLOW_PATH,
                "html_url": "https://github.com/nashavtoparkmedia-byte/CRM/actions/runs/1000000001",
            },
            "actions/runs/1000000001/attempts/1/jobs?per_page=100": {"jobs": [
                {**hosted_ci["jobs"][0], "run_id": 1000000001, "html_url": hosted_ci["jobs"][0]["url"]},
                {**hosted_ci["jobs"][1], "run_id": 1000000001, "html_url": hosted_ci["jobs"][1]["url"]},
            ]},
            f"actions/artifacts/{artifact_id}": {
                "id": artifact_id,
                "name": hosted_ci["artifact"]["name"],
                "expired": False,
                "size_in_bytes": artifact_size,
                "digest": artifact_digest,
                "workflow_run": {"id": 1000000001, "head_sha": cls.commit},
            },
        }
        fixture_sealer.github_api = lambda path: live_values[path]
        original_argv = sys.argv
        sys.argv = [
            str(cls.stage / "packaging/seal-release.py"),
            "--source-repo", str(cls.repo),
            "--commit", cls.commit,
            "--acceptance-record", str(cls.acceptance),
            "--production-snapshot", str(cls.snapshot),
            "--migration-authority", str(cls.authority),
            "--predecessor-attestation", str(cls.attestation),
            "--gravity-artifact-zip", str(cls.gravity_artifact),
            "--direct-rollback-package", str(cls.direct_rollback_package),
            "--direct-rollback-provenance", str(cls.direct_rollback_provenance),
        ]
        try:
            fixture_sealer.main()
        finally:
            sys.argv = original_argv
        cls.deb = cls.stage / "dist/yoko-privileged-runtime_2.0.0-14_all.deb"
        cls.root = temp / "extract"
        subprocess.run(["/usr/bin/dpkg-deb", "-x", str(cls.deb), str(cls.root)], check=True)
        for relative in ("usr/sbin", "var", "var/lib"):
            directory = cls.root / relative
            directory.mkdir(parents=True, exist_ok=True)
            directory.chmod(0o755)
        shutil.copy2("/bin/true", cls.root / "usr/sbin/visudo")
        os.chmod(cls.root / "usr/sbin/visudo", 0o755)
        seal = json.loads((cls.stage / "SEALED_RELEASE.json").read_text())
        cls.seal = seal
        cls.profile_id = seal["profile_id"]
        cls.profile = json.loads((cls.root / f"usr/local/share/yoko-privileged-runtime/profiles/{cls.profile_id}/profile.v1.json").read_text())
        runtime_path = cls.root / f"usr/local/libexec/yoko-privileged-runtime/{cls.profile_id}.py"
        loader = importlib.machinery.SourceFileLoader("yoko_source_only_test_profile", str(runtime_path))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        assert spec is not None
        cls.runtime = importlib.util.module_from_spec(spec)
        sys.modules[loader.name] = cls.runtime
        loader.exec_module(cls.runtime)
        core_path = cls.root / "usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py"
        core_loader = importlib.machinery.SourceFileLoader("yoko_source_only_test_core", str(core_path))
        core_spec = importlib.util.spec_from_loader(core_loader.name, core_loader)
        assert core_spec is not None
        cls.core = importlib.util.module_from_spec(core_spec)
        sys.modules[core_loader.name] = cls.core
        core_loader.exec_module(cls.core)

    @classmethod
    def tearDownClass(cls) -> None:
        for attempt in range(20):
            try:
                cls.temp.cleanup()
                return
            except OSError:
                if attempt == 19:
                    raise
                time.sleep(0.05)

    def wrapper(self, *args: str) -> subprocess.CompletedProcess[bytes]:
        env = dict(os.environ, YOKO_PRIVILEGED_RUNTIME_TEST_ROOT=str(self.root))
        return subprocess.run(["/usr/bin/python3", "-I", str(self.root / "usr/local/sbin/yoko-privileged-runtime"), *args], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)

    def test_sealed_package_self_check_and_capabilities(self) -> None:
        self_check = self.wrapper("self-check")
        if self_check.returncode != 0:
            wrapper_path = self.root / "usr/local/sbin/yoko-privileged-runtime"
            loader = importlib.machinery.SourceFileLoader("yoko_source_only_test_wrapper", str(wrapper_path))
            spec = importlib.util.spec_from_loader(loader.name, loader)
            assert spec is not None
            wrapper = importlib.util.module_from_spec(spec)
            sys.modules[loader.name] = wrapper
            loader.exec_module(wrapper)
            old = os.environ.get("YOKO_PRIVILEGED_RUNTIME_TEST_ROOT")
            os.environ["YOKO_PRIVILEGED_RUNTIME_TEST_ROOT"] = str(self.root)
            try:
                core = wrapper._load_core(wrapper._root())
                detail = "core-ok"
                core.configure_mode()
                policy = core.load_policy()
                detail = "policy-ok"
                core.verify_caller(policy)
                invocation = core.parse_cli(["wrapper", "self-check"])
                overlay, _ = wrapper._overlay_identity(core, wrapper._root())
                detail = "overlay-ok"
                direct = wrapper._dispatch(core, self.runtime, policy, invocation, overlay)
                detail = repr(direct)
            except Exception as exc:
                profile_root = self.root / f"usr/local/share/yoko-privileged-runtime/profiles/{self.profile_id}"
                paths = [profile_root / "manifest.v1.json", profile_root / "profile.v1.json", profile_root / "source.tar.gz", profile_root / "migration.sql", self.root / f"usr/local/libexec/yoko-privileged-runtime/{self.profile_id}.py"]
                detail = detail + ":" + repr(exc) + ":" + repr([(str(path), oct(path.stat().st_mode & 0o777), path.stat().st_nlink, path.stat().st_size) for path in paths])
            finally:
                if old is None:
                    os.environ.pop("YOKO_PRIVILEGED_RUNTIME_TEST_ROOT", None)
                else:
                    os.environ["YOKO_PRIVILEGED_RUNTIME_TEST_ROOT"] = old
            self.fail(self_check.stdout.decode() + self_check.stderr.decode() + detail)
        capabilities = json.loads(self.wrapper("capabilities").stdout)["evidence"]
        self.assertEqual(capabilities["enabled_activation_profiles"], ["database-status", "release-preflight", "release-activate", "rollback"])
        self.assertIn("database-migration", capabilities["disabled_profiles"])

    def test_sealer_fixture_is_a_clean_exact_patch_commit(self) -> None:
        self.assertEqual(
            subprocess.check_output(
                ["/usr/bin/git", "-C", str(self.repo), "rev-parse", "HEAD"],
                text=True,
            ).strip(),
            self.commit,
        )
        self.assertEqual(
            subprocess.check_output(
                ["/usr/bin/git", "-C", str(self.repo), "status", "--porcelain", "--untracked-files=all"],
                text=True,
            ),
            "",
        )
        self.assertEqual(
            hashlib.sha256(git_blob(self.repo, self.commit, TG_PATCH_PATH)).hexdigest(),
            self.expected_patch_sha,
        )
        hosted_ci = self.seal["hosted_authoritative_ci"]
        self.assertEqual(hosted_ci["source"], {"commit": self.commit, "tree": self.tree})
        self.assertEqual(hosted_ci["run"]["head_sha"], self.commit)
        self.assertEqual(hosted_ci["check"]["head_sha"], self.commit)
        self.assertEqual(hosted_ci["run"]["conclusion"], "success")
        self.assertEqual(hosted_ci["check"]["conclusion"], "success")
        self.assertEqual(hosted_ci["controls"]["count"], 52)
        self.assertEqual(len(hosted_ci["controls"]["catalog"]), 52)

    def test_database_migrate_and_profile_arguments_are_denied(self) -> None:
        migrated = self.wrapper("database-migrate")
        self.assertNotEqual(migrated.returncode, 0)
        self.assertEqual(json.loads(migrated.stdout)["errors"][0]["code"], "PROFILE_DISABLED")
        extra = self.wrapper("release-preflight", "unexpected")
        self.assertNotEqual(extra.returncode, 0)

    def test_sealed_live_chronology_is_exact_attestation_order_plus_target(self) -> None:
        attestation_bytes = self.attestation.read_bytes()
        attestation = json.loads(attestation_bytes)
        excluded = "20260223211509_add_is_linear_to_survey"
        target = {
            "name": self.profile["migration"]["name"],
            "sha256": self.profile["migration"]["sha256"],
        }
        source_rows = [row for row in attestation["rows"] if row["name"] != excluded] + [target]
        expected = [
            {"ordinal": index, "migration_name": row["name"], "checksum": row["sha256"]}
            for index, row in enumerate(source_rows, 1)
        ]
        chronology = self.profile["migration"]["accepted_live_chronology"]
        authority = self.profile["migration"]["accepted_live_chronology_authority"]
        chronology_sha = hashlib.sha256(json.dumps(expected, sort_keys=True, separators=(",", ":")).encode("ascii")).hexdigest()
        self.assertEqual(chronology, expected)
        self.assertEqual(authority["predecessor_attestation_sha256"], hashlib.sha256(attestation_bytes).hexdigest())
        self.assertEqual(authority["predecessor_attestation_inventory_sha256"], attestation["inventory_sha256"])
        self.assertEqual(authority["sequence_sha256"], chronology_sha)
        self.assertEqual(self.runtime.ACCEPTED_LIVE_CHRONOLOGY_SHA256, chronology_sha)
        self.assertEqual(self.seal["accepted_live_chronology_sha256"], chronology_sha)
        self.assertEqual(self.seal["accepted_live_chronology_authority"], "PINNED_PREDECESSOR_ATTESTATION_ROW_ORDER_PLUS_CURRENT_TARGET")

    def test_uninitialized_rollback_fails_closed_without_production(self) -> None:
        rolled = self.wrapper("rollback")
        self.assertNotEqual(rolled.returncode, 0)
        self.assertEqual(json.loads(rolled.stdout)["errors"][0]["code"], "ROLLBACK_NOT_AVAILABLE_BEFORE_PREFLIGHT")

    def test_profile_tamper_breaks_self_check(self) -> None:
        path = self.root / f"usr/local/share/yoko-privileged-runtime/profiles/{self.profile_id}/profile.v1.json"
        original = path.read_bytes()
        os.chmod(path, 0o644)
        path.write_bytes(original + b" ")
        os.chmod(path, 0o444)
        try:
            result = self.wrapper("self-check")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stdout)["errors"][0]["code"], "PROFILE_ARTIFACT_IDENTITY_MISMATCH")
        finally:
            os.chmod(path, 0o644)
            path.write_bytes(original)
            os.chmod(path, 0o444)

    def canonical_observation(self) -> dict[str, object]:
        active = dict(self.profile["migration"]["accepted_predecessor_map"])
        active[self.profile["migration"]["name"]] = self.profile["migration"]["sha256"]
        rows = [
            {
                "observed_chronological_ordinal": row["ordinal"],
                "migration_name": row["migration_name"],
                "checksum": row["checksum"],
                "status": "FINISHED_ACTIVE",
            }
            for row in self.profile["migration"]["accepted_live_chronology"]
        ]
        return {"active": active, "rows": rows, "interrupted_target": 0, "rolled_back_target": 0}

    @staticmethod
    def ledger_row(name: str, checksum: str, *, row_id: str = "11111111-1111-1111-1111-111111111111", finished: bool = True, rolled_back: bool = False, logs: str | None = None) -> dict[str, object]:
        encoded_logs = None if logs is None else logs.encode()
        return {
            "id": row_id,
            "checksum": checksum,
            "finished_at": "2026-08-12T19:40:00.000000Z" if finished else None,
            "migration_name": name,
            "logs_present": logs is not None,
            "logs_bytes": None if encoded_logs is None else len(encoded_logs),
            "logs_sha256": None if encoded_logs is None else hashlib.sha256(encoded_logs).hexdigest(),
            "rolled_back_at": "2026-08-12T19:41:00.000000Z" if rolled_back else None,
            "started_at": "2026-08-12T19:39:00.000000Z",
            "applied_steps_count": 1 if finished else 0,
        }

    def test_canonical_map_accepts_exact_predecessor_and_target(self) -> None:
        shape = self.runtime._accepted_production_ledger_shape(self.canonical_observation(), self.profile)
        self.assertEqual(shape, {"baseline_exact": True, "target_absent": False, "target_active": True, "chronology_exact": True})

    def test_canonical_map_rejects_reordered_known_live_rows(self) -> None:
        observation = self.canonical_observation()
        observation["rows"][0], observation["rows"][1] = observation["rows"][1], observation["rows"][0]
        shape = self.runtime._accepted_production_ledger_shape(observation, self.profile)
        self.assertFalse(shape["baseline_exact"])
        self.assertFalse(shape["chronology_exact"])

    def test_database_status_marks_reordered_known_live_rows_drifted(self) -> None:
        observation = self.canonical_observation()
        observation["rows"][0], observation["rows"][1] = observation["rows"][1], observation["rows"][0]
        original_observation = self.runtime._migration_ledger_observation
        original_identity = self.runtime._postgres_identity
        original_expected_ledger = self.runtime._expected_production_ledger
        original_catalog = self.runtime._outbox_catalog
        original_counts = self.runtime._outbox_counts
        expected_identity = self.profile["migration"]["accepted_production_ledger"]["database_identity_sha256"]
        self.runtime._migration_ledger_observation = lambda *_args, **_kwargs: observation
        self.runtime._postgres_identity = lambda *_args, **_kwargs: {
            "database_identity_sha256": expected_identity,
            "database_name_sha256": "1" * 64,
            "database_user_sha256": "2" * 64,
            "system_identifier_sha256": "3" * 64,
            "server_version_num": "160014",
            "container_id": self.profile["transition_invariants"]["postgres_container_id"],
            "image_id": self.profile["transition_invariants"]["postgres_image_id"],
        }
        expected_ledger = dict(self.profile["migration"]["accepted_predecessor_map"])
        expected_ledger[self.profile["migration"]["name"]] = self.profile["migration"]["sha256"]
        self.runtime._expected_production_ledger = lambda *_args, **_kwargs: expected_ledger
        self.runtime._outbox_catalog = lambda *_args, **_kwargs: {"state": "EXACT"}
        self.runtime._outbox_counts = lambda *_args, **_kwargs: {"total": 1}
        try:
            evidence, _ = self.runtime._database_status(self.core, self.profile)
            self.assertEqual(evidence["migration_state"], "DRIFTED")
            self.assertFalse(evidence["canonical_live_chronology_exact"])
            self.assertTrue(evidence["canonical_active_map_exact"])
        finally:
            self.runtime._migration_ledger_observation = original_observation
            self.runtime._postgres_identity = original_identity
            self.runtime._expected_production_ledger = original_expected_ledger
            self.runtime._outbox_catalog = original_catalog
            self.runtime._outbox_counts = original_counts

    def test_canonical_map_rejects_missing_name(self) -> None:
        observation = self.canonical_observation()
        observation["active"].pop(next(iter(self.profile["migration"]["accepted_predecessor_map"])))
        self.assertFalse(self.runtime._accepted_production_ledger_shape(observation, self.profile)["baseline_exact"])

    def test_canonical_map_rejects_extra_unknown_name(self) -> None:
        observation = self.canonical_observation()
        observation["active"]["20990101000000_unknown"] = "a" * 64
        self.assertFalse(self.runtime._accepted_production_ledger_shape(observation, self.profile)["baseline_exact"])

    def test_canonical_map_rejects_wrong_checksum(self) -> None:
        observation = self.canonical_observation()
        name = next(iter(self.profile["migration"]["accepted_predecessor_map"]))
        observation["active"][name] = "b" * 64
        self.assertFalse(self.runtime._accepted_production_ledger_shape(observation, self.profile)["baseline_exact"])

    def test_canonical_map_reports_target_absent_and_wrong_target(self) -> None:
        absent = self.canonical_observation()
        absent["active"].pop(self.profile["migration"]["name"])
        absent["rows"].pop()
        self.assertEqual(self.runtime._accepted_production_ledger_shape(absent, self.profile), {"baseline_exact": True, "target_absent": True, "target_active": False, "chronology_exact": True})
        wrong = self.canonical_observation()
        wrong["active"][self.profile["migration"]["name"]] = "c" * 64
        wrong["rows"][-1]["checksum"] = "c" * 64
        self.assertEqual(self.runtime._accepted_production_ledger_shape(wrong, self.profile), {"baseline_exact": True, "target_absent": False, "target_active": False, "chronology_exact": False})

    def test_ledger_parser_rejects_duplicate_active_name(self) -> None:
        name, checksum = next(iter(self.profile["migration"]["accepted_predecessor_map"].items()))
        original = self.runtime._psql
        duplicate = [self.ledger_row(name, checksum), self.ledger_row(name, checksum, row_id="22222222-2222-2222-2222-222222222222")]
        self.runtime._psql = lambda *_args, **_kwargs: json.dumps(duplicate).encode()
        try:
            with self.assertRaisesRegex(Exception, "MIGRATION_LEDGER_INVALID"):
                self.runtime._migration_ledger_observation(self.core, {}, self.profile)
        finally:
            self.runtime._psql = original

    def test_ledger_parser_rejects_inactive_unknown_name(self) -> None:
        original = self.runtime._psql
        unknown = [self.ledger_row("20990101000000_unknown", "d" * 64, finished=False)]
        self.runtime._psql = lambda *_args, **_kwargs: json.dumps(unknown).encode()
        try:
            with self.assertRaisesRegex(Exception, "MIGRATION_LEDGER_INVALID"):
                self.runtime._migration_ledger_observation(self.core, {}, self.profile)
        finally:
            self.runtime._psql = original

    def test_ledger_parser_emits_exact_live_row_metadata_without_raw_logs(self) -> None:
        name, checksum = next(iter(self.profile["migration"]["accepted_predecessor_map"].items()))
        original = self.runtime._psql
        raw_log = "migration completed without secret output"
        self.runtime._psql = lambda *_args, **_kwargs: json.dumps([self.ledger_row(name, checksum, logs=raw_log)]).encode()
        try:
            observation = self.runtime._migration_ledger_observation(self.core, {}, self.profile)
            self.assertEqual(observation["active"], {name: checksum})
            self.assertEqual(observation["rows"][0]["observed_chronological_ordinal"], 1)
            self.assertEqual(observation["rows"][0]["migration_name"], name)
            self.assertEqual(observation["rows"][0]["status"], "FINISHED_ACTIVE")
            self.assertEqual(observation["rows"][0]["logs_bytes"], len(raw_log.encode()))
            self.assertEqual(observation["rows"][0]["logs_sha256"], hashlib.sha256(raw_log.encode()).hexdigest())
            self.assertNotIn(raw_log, json.dumps(observation))
        finally:
            self.runtime._psql = original

    def test_live_ledger_sql_hashes_logs_inside_postgres(self) -> None:
        source = (ROOT / "templates/crm-activation-profile.py.in").read_text()
        packaged = (self.root / f"usr/local/libexec/yoko-privileged-runtime/{self.profile_id}.py").read_text()
        self.assertIn("logs IS NOT NULL", source)
        self.assertIn("octet_length(logs)", source)
        self.assertIn("encode(sha256(convert_to(logs, 'UTF8')), 'hex')", source)
        self.assertIn('FROM public."_prisma_migrations"', source)
        self.assertIn("ORDER BY started_at, migration_name, id", source)
        self.assertNotIn("'logs', logs,", source)
        self.assertIn("logs IS NOT NULL", packaged)
        self.assertIn('"canonical_live_rows": observation["rows"]', packaged)

    def test_database_status_exposes_exact_62_live_rows_and_preserves_v9_digest(self) -> None:
        rows = []
        for index, expected in enumerate(self.profile["migration"]["accepted_live_chronology"], 1):
            rows.append(self.ledger_row(
                expected["migration_name"],
                expected["checksum"],
                row_id=f"00000000-0000-0000-0000-{index:012d}",
            ))
        original_psql = self.runtime._psql
        original_identity = self.runtime._postgres_identity
        original_catalog = self.runtime._outbox_catalog
        original_counts = self.runtime._outbox_counts
        original_expected = self.runtime._expected_production_ledger
        expected_identity = self.profile["migration"]["accepted_production_ledger"]["database_identity_sha256"]
        self.runtime._psql = lambda *_args, **_kwargs: json.dumps(rows).encode()
        self.runtime._postgres_identity = lambda *_args, **_kwargs: {
            "database_identity_sha256": expected_identity,
            "database_name_sha256": "1" * 64,
            "database_user_sha256": "2" * 64,
            "system_identifier_sha256": "3" * 64,
            "server_version_num": "160014",
            "container_id": self.profile["transition_invariants"]["postgres_container_id"],
            "image_id": self.profile["transition_invariants"]["postgres_image_id"],
        }
        self.runtime._outbox_catalog = lambda *_args, **_kwargs: {"state": "EXACT"}
        self.runtime._outbox_counts = lambda *_args, **_kwargs: {"total": 1}
        self.runtime._expected_production_ledger = lambda *_args, **_kwargs: dict(self.profile["migration"]["accepted_predecessor_map"] | {self.profile["migration"]["name"]: self.profile["migration"]["sha256"]})
        try:
            evidence, _ = self.runtime._database_status(self.core, self.profile)
            self.assertEqual(evidence["applied_migration_count"], 62)
            self.assertEqual(len(evidence["canonical_live_rows"]), 62)
            self.assertEqual([row["observed_chronological_ordinal"] for row in evidence["canonical_live_rows"]], list(range(1, 63)))
            self.assertTrue(evidence["canonical_active_map_exact"])
            self.assertTrue(evidence["canonical_live_chronology_exact"])
            self.assertEqual(evidence["expected_live_chronology_sha256"], self.profile["migration"]["accepted_live_chronology_authority"]["sequence_sha256"])
            self.assertEqual(evidence["canonical_active_inventory_sha256"], evidence["expected_canonical_active_inventory_sha256"])
            self.assertEqual(evidence["canonical_live_rows_sha256"], self.runtime._digest(evidence["canonical_live_rows"]))
            self.assertEqual(evidence["migration_ledger_sha256"], "a50f1a8988f79c85059354d6b2d45e9e8ed07284fc27c78d98face6680f25dfc")
        finally:
            self.runtime._psql = original_psql
            self.runtime._postgres_identity = original_identity
            self.runtime._outbox_catalog = original_catalog
            self.runtime._outbox_counts = original_counts
            self.runtime._expected_production_ledger = original_expected

    def test_ledger_parser_rejects_malformed_row_metadata(self) -> None:
        name, checksum = next(iter(self.profile["migration"]["accepted_predecessor_map"].items()))
        candidates = []
        for field, value in (
            ("id", "contains spaces"),
            ("started_at", "not-a-time"),
            ("applied_steps_count", -1),
            ("logs_bytes", 1),
        ):
            row = self.ledger_row(name, checksum)
            row[field] = value
            candidates.append(row)
        original = self.runtime._psql
        try:
            for candidate in candidates:
                self.runtime._psql = lambda *_args, candidate=candidate, **_kwargs: json.dumps([candidate]).encode()
                with self.assertRaisesRegex(Exception, "MIGRATION_LEDGER_INVALID"):
                    self.runtime._migration_ledger_observation(self.core, {}, self.profile)
        finally:
            self.runtime._psql = original

    def test_archive_member_allowlist_rejects_third_root(self) -> None:
        source = dict(self.profile["accepted_source"])
        for accepted in (
            "gravity-mvp",
            "gravity-mvp/Dockerfile",
            "tg-bot",
            "tg-bot/src",
            "tg-bot/src/public-bot-maintenance.js",
        ):
            self.assertTrue(self.runtime._archive_member_allowed(source, accepted))
        for rejected in (
            "deploy/docker-compose.production.yml",
            "tg-bot/package.json",
            "tg-bot/src/extra.js",
            "gravity-mvp-evil/Dockerfile",
        ):
            self.assertFalse(self.runtime._archive_member_allowed(source, rejected))
        source["archive_prefix"] = "yoko-crm-invalid/"
        self.assertFalse(self.runtime._archive_member_allowed(source, "gravity-mvp/Dockerfile"))

    def test_dual_service_state_vector_rejects_unknown_and_classifies_mixed(self) -> None:
        class FaultCore:
            RuntimeFault = self.core.RuntimeFault

        state = {"target_image_id": "sha256:" + "1" * 64, "tg_target_image_id": "sha256:" + "2" * 64}
        gravity_old = {"image_id": self.profile["pre_activation_live_prestate"]["gravity_image_id"]}
        gravity_target = {"image_id": state["target_image_id"]}
        tg_old = {"image_id": self.profile["pre_activation_live_prestate"]["tg_bot_image_id"]}
        tg_target = {"image_id": state["tg_target_image_id"]}
        self.assertEqual(self.runtime._dual_service_image_state(FaultCore, self.profile, state, gravity_old, tg_old), ("old", "old"))
        self.assertEqual(self.runtime._dual_service_image_state(FaultCore, self.profile, state, gravity_target, tg_target), ("target", "target"))
        self.assertEqual(self.runtime._dual_service_image_state(FaultCore, self.profile, state, gravity_target, tg_old), ("target", "old"))
        self.assertEqual(self.runtime._dual_service_image_state(FaultCore, self.profile, state, gravity_old, tg_target), ("old", "target"))
        with self.assertRaisesRegex(Exception, "DUAL_SERVICE_SOURCE_IDENTITY_DRIFT"):
            self.runtime._dual_service_image_state(FaultCore, self.profile, state, {"image_id": "sha256:" + "3" * 64}, tg_old)

    def test_tg_diff_and_patch_metadata_negative_contracts(self) -> None:
        class FaultCore:
            RuntimeFault = self.core.RuntimeFault

        exact = ["C /app", "C /app/src", f"A {self.runtime.TG_PATCH_DESTINATION}"]
        self.runtime._validate_tg_diff_lines(FaultCore, exact)
        for bad in (
            [],
            [f"A {self.runtime.TG_PATCH_DESTINATION}"],
            [f"C {self.runtime.TG_PATCH_DESTINATION}"],
            ["C /app/src", "C /app", f"A {self.runtime.TG_PATCH_DESTINATION}"],
            [*exact, "C /app/package.json"],
        ):
            with self.assertRaisesRegex(Exception, "TG_DIFF_PROOF_INVALID"):
                self.runtime._validate_tg_diff_lines(FaultCore, bad)
        expected = self.runtime._expected_tg_patch_metadata(self.profile, self.runtime.TG_PATCH_TARGET_SHA256)
        self.assertEqual(
            self.runtime._validate_tg_patch_probe(FaultCore, self.profile, expected, self.runtime.TG_PATCH_TARGET_SHA256, "BAD"),
            expected,
        )
        for field, bad_value in (("sha256", "0" * 64), ("uid", 1), ("gid", 1), ("mode", "0600"), ("size", 1)):
            tampered = dict(expected)
            tampered[field] = bad_value
            with self.assertRaisesRegex(Exception, "TG_PATCH_NEGATIVE"):
                self.runtime._validate_tg_patch_probe(FaultCore, self.profile, tampered, self.runtime.TG_PATCH_TARGET_SHA256, "TG_PATCH_NEGATIVE")
        self.assertEqual(
            self.runtime._validate_tg_patch_absent(FaultCore, {"state": "ABSENT"}, "BAD"),
            {"state": "ABSENT"},
        )
        for bad in ({"state": "PRESENT"}, {"state": "ABSENT", "sha256": "0" * 64}):
            with self.assertRaisesRegex(Exception, "TG_PATCH_ABSENCE_NEGATIVE"):
                self.runtime._validate_tg_patch_absent(FaultCore, bad, "TG_PATCH_ABSENCE_NEGATIVE")

    def test_tg_runtime_and_image_probes_distinguish_absence_from_exact_target(self) -> None:
        class FaultCore:
            RuntimeFault = self.core.RuntimeFault

        original_run = self.runtime._run
        target = self.runtime._expected_tg_patch_metadata(self.profile, self.runtime.TG_PATCH_TARGET_SHA256)
        responses = [
            json.dumps({"state": "ABSENT"}).encode("ascii"),
            json.dumps(target).encode("ascii"),
        ]
        invocations: list[list[str]] = []

        def fake_run(_core: object, argv: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
            invocations.append(argv)
            return subprocess.CompletedProcess(argv, 0, stdout=responses.pop(0), stderr=b"")

        self.runtime._run = fake_run
        try:
            self.assertEqual(
                self.runtime._tg_patch_file_probe(FaultCore, "crm-tg-bot"),
                {"state": "ABSENT"},
            )
            self.assertEqual(
                self.runtime._tg_image_file_probe(FaultCore, self.profile, self.runtime.TG_TARGET_TAG),
                target,
            )
        finally:
            self.runtime._run = original_run
        self.assertEqual(invocations[0][1:3], ["exec", "crm-tg-bot"])
        self.assertIn("--network", invocations[1])
        self.assertEqual(responses, [])

    def test_complete_provenance_rejects_any_failure_or_identity_drift(self) -> None:
        class FakeCore:
            RuntimeFault = self.core.RuntimeFault

            def __init__(self, failures, complete=True):
                self.failures = failures
                self.complete = complete

            def semantic_fingerprint(self, records):
                payload = {
                    "records": sorted(records, key=lambda item: str(item["name"])),
                    "schema": "yoko.ai-calls.production-semantic-identity.v1",
                }
                return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("ascii")).hexdigest()

            def docker_provenance(self, _policy):
                return {
                    "complete": self.complete,
                    "failures": self.failures,
                    "records": [],
                    "semantic": {
                        "schema": "yoko.ai-calls.production-semantic-identity.v1",
                        "records": [],
                        "fingerprint_sha256": None if self.failures else self.semantic_fingerprint([]),
                    },
                }

        exact = []
        self.assertEqual(self.runtime._pinned_provenance(FakeCore(exact), {}), FakeCore(exact).docker_provenance({}))
        for failures, complete in (
            ([], False),
            ([{"logical_resource": "seo.container.site", "code": "CONTAINER_NOT_FOUND"}], True),
            ([{"logical_resource": "crm.container.telegram_bot", "code": "CONTAINER_NOT_FOUND"}], False),
            ([{"logical_resource": "seo.container.site", "code": "CONTAINER_NOT_FOUND"}, {"logical_resource": "crm.container.max_scraper", "code": "CONTAINER_NOT_FOUND"}], False),
        ):
            with self.assertRaisesRegex(Exception, "PRODUCTION_PROVENANCE_FAILURE_SET_DRIFT"):
                self.runtime._pinned_provenance(FakeCore(failures, complete), {})

        semantic = {"name": "crm-gravity-mvp", "image_id": "sha256:" + "a" * 64}

        class RecordCore(FakeCore):
            def __init__(self, records, semantic_records):
                super().__init__(exact)
                self.records = records
                self.semantic_records = semantic_records

            def docker_provenance(self, _policy):
                value = super().docker_provenance(_policy)
                value["records"] = self.records
                value["semantic"]["records"] = self.semantic_records
                value["semantic"]["fingerprint_sha256"] = self.semantic_fingerprint(self.semantic_records)
                return value

        record = {"name": "crm-gravity-mvp", "image_id": semantic["image_id"], "semantic": semantic}
        self.assertEqual(self.runtime._pinned_provenance(RecordCore([record], [semantic]), {})["records"], [record])
        for records, semantics in (
            ([record, record], [semantic, semantic]),
            ([{"name": "crm-gravity-mvp", "image_id": "sha256:" + "b" * 64, "semantic": semantic}], [semantic]),
            ([record], []),
        ):
            with self.assertRaisesRegex(Exception, "PRODUCTION_PROVENANCE_RECORD_SET_DRIFT"):
                self.runtime._pinned_provenance(RecordCore(records, semantics), {})

        wrong_fingerprint = RecordCore([record], [semantic])
        original = wrong_fingerprint.docker_provenance
        wrong_fingerprint.docker_provenance = lambda policy: {**original(policy), "semantic": {**original(policy)["semantic"], "fingerprint_sha256": "0" * 64}}
        with self.assertRaisesRegex(Exception, "PRODUCTION_PROVENANCE_RECORD_SET_DRIFT"):
            self.runtime._pinned_provenance(wrong_fingerprint, {})


class ProtectedMessagesPostdeployProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        runtime_path = ROOT / "src/crm-activation-profile.py"
        loader = importlib.machinery.SourceFileLoader("yoko_protected_messages_postdeploy_probe_test", str(runtime_path))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        assert spec is not None
        cls.runtime = importlib.util.module_from_spec(spec)
        sys.modules[loader.name] = cls.runtime
        loader.exec_module(cls.runtime)
        cls.node = shutil.which("node")
        if cls.node is None:
            raise unittest.SkipTest("Node.js is required to execute the sealed HTTP probe contracts")

    @classmethod
    def tearDownClass(cls) -> None:
        sys.modules.pop("yoko_protected_messages_postdeploy_probe_test", None)

    def run_probe(
        self,
        script_factory: Any,
        expected_path: str,
        *,
        status: int,
        payload: object,
        content_type: str = "application/json; charset=utf-8",
    ) -> subprocess.CompletedProcess[bytes]:
        import http.server
        import threading

        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        seen: list[tuple[str, str]] = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(handler_self) -> None:
                seen.append(("GET", handler_self.path))
                handler_self.send_response(status)
                handler_self.send_header("Content-Type", content_type)
                handler_self.send_header("Content-Length", str(len(body)))
                handler_self.end_headers()
                handler_self.wfile.write(body)

            def log_message(self, _format: str, *_args: object) -> None:
                return

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            completed = subprocess.run(
                [self.node, "-e", script_factory(origin)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=15,
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        self.assertEqual(seen, [("GET", expected_path)])
        self.assertEqual(completed.stdout, b"")
        self.assertEqual(completed.stderr, b"")
        return completed

    @staticmethod
    def transport_fixture() -> dict[str, object]:
        def entry(connection_id: str, channel: str, instance_id: str) -> dict[str, object]:
            return {
                "id": connection_id,
                "channel": channel,
                "instanceId": instance_id,
                "state": "ready",
                "lastSeen": "2026-08-13T12:00:00.000Z",
                "lastError": None,
                "retryAttempt": 0,
                "uptimeMs": 1000,
                "reconnectInFlight": False,
            }

        return {
            "whatsapp": {"connections": []},
            "telegram": {"connections": [entry("tg-production", "telegram", "89abcdef")]},
            "timestamp": "2026-08-13T12:00:01.000Z",
        }

    @staticmethod
    def health_fixture() -> dict[str, object]:
        return {
            "status": "ok",
            "transport": {
                "whatsapp": {"connections": [], "readyCount": 0, "totalCount": 0},
                "telegram": {"connections": [{}], "readyCount": 1, "totalCount": 1},
                "degradedConnections": 0,
            },
            "pipeline": {"failedLast24h": 0, "stuckCount": 0},
            "recovery": {"lastError": None},
            "retry": {"pendingRetryable": 0, "lastError": None},
            "watchdog": {"unhealthyCount": 0},
            "integrity": {"issues": []},
        }

    def test_exact_ready_transport_and_safe_messages_route_are_accepted(self) -> None:
        transport = self.run_probe(
            self.runtime._transport_health_probe_script,
            "/api/transport/health",
            status=200,
            payload=self.transport_fixture(),
        )
        messages = self.run_probe(
            self.runtime._messages_route_contract_probe_script,
            "/api/messages",
            status=400,
            payload={"error": "chatId is required"},
        )
        health = self.run_probe(
            self.runtime._protected_messages_health_probe_script,
            "/api/health",
            status=200,
            payload=self.health_fixture(),
        )
        self.assertEqual((transport.returncode, messages.returncode, health.returncode), (0, 0, 0))

    def test_http_200_missing_sealed_telegram_inventory_is_rejected(self) -> None:
        empty = self.transport_fixture()
        empty["telegram"] = {"connections": []}
        result = self.run_probe(
            self.runtime._transport_health_probe_script,
            "/api/transport/health",
            status=200,
            payload=empty,
        )
        self.assertEqual(result.returncode, 5)

    def test_http_200_unexpected_whatsapp_inventory_is_rejected(self) -> None:
        unexpected = self.transport_fixture()
        whatsapp = dict(unexpected["telegram"]["connections"][0])
        whatsapp.update({"id": "wa-unexpected", "channel": "whatsapp"})
        unexpected["whatsapp"] = {"connections": [whatsapp]}
        result = self.run_probe(
            self.runtime._transport_health_probe_script,
            "/api/transport/health",
            status=200,
            payload=unexpected,
        )
        self.assertEqual(result.returncode, 5)

    def test_failed_degraded_or_retrying_transport_is_rejected(self) -> None:
        candidates = []
        for field, value in (
            ("state", "initializing"),
            ("state", "failed"),
            ("state", "reconnecting"),
            ("state", "stopped"),
            ("lastError", "delivery transport failed"),
            ("retryAttempt", 1),
            ("reconnectInFlight", True),
        ):
            fixture = self.transport_fixture()
            fixture["telegram"]["connections"][0][field] = value
            candidates.append((field, fixture))
        for field, fixture in candidates:
            with self.subTest(field=field):
                result = self.run_probe(
                    self.runtime._transport_health_probe_script,
                    "/api/transport/health",
                    status=200,
                    payload=fixture,
                )
                self.assertEqual(result.returncode, 6)

    def test_delivery_retry_recovery_integrity_or_watchdog_failure_is_rejected(self) -> None:
        candidates: list[tuple[str, tuple[str, str], object]] = [
            ("delivery", ("pipeline", "failedLast24h"), 1),
            ("stuck", ("pipeline", "stuckCount"), 1),
            ("retry_pending", ("retry", "pendingRetryable"), 1),
            ("retry_error", ("retry", "lastError"), "retry failed"),
            ("recovery_error", ("recovery", "lastError"), "recovery failed"),
            ("integrity", ("integrity", "issues"), [{"severity": "warning"}]),
            ("watchdog", ("watchdog", "unhealthyCount"), 1),
        ]
        for name, (section, field), value in candidates:
            fixture = self.health_fixture()
            fixture[section][field] = value
            with self.subTest(name=name):
                result = self.run_probe(
                    self.runtime._protected_messages_health_probe_script,
                    "/api/health",
                    status=200,
                    payload=fixture,
                )
                self.assertEqual(result.returncode, 5)

    def test_messages_route_status_or_shape_regression_is_rejected(self) -> None:
        for status in (200, 401, 404, 500):
            with self.subTest(status=status):
                result = self.run_probe(
                    self.runtime._messages_route_contract_probe_script,
                    "/api/messages",
                    status=status,
                    payload={"error": "chatId is required"},
                )
                self.assertEqual(result.returncode, 2)
        for name, payload, content_type in (
            ("empty", {}, "application/json"),
            ("wrong_error", {"error": "missing"}, "application/json"),
            ("extra_field", {"error": "chatId is required", "detail": "chatId"}, "application/json"),
            ("array", [{"error": "chatId is required"}], "application/json"),
            ("wrong_mime", {"error": "chatId is required"}, "text/plain"),
        ):
            with self.subTest(name=name):
                result = self.run_probe(
                    self.runtime._messages_route_contract_probe_script,
                    "/api/messages",
                    status=400,
                    payload=payload,
                    content_type=content_type,
                )
                self.assertEqual(result.returncode, 5)

    def test_application_postcheck_runs_all_proofs_and_retains_outbox(self) -> None:
        class Completed:
            def __init__(self, returncode: int = 0, stdout: bytes = b"", stderr: bytes = b"") -> None:
                self.returncode = returncode
                self.stdout = stdout
                self.stderr = stderr

        commands: list[list[str]] = []
        log_commands: list[list[str]] = []
        original_run = self.runtime._run
        original_required = self.runtime._required_success
        self.runtime._run = lambda _core, command, **_kwargs: commands.append(command) or Completed()
        self.runtime._required_success = lambda _core, command, **_kwargs: log_commands.append(command) or Completed(
            stdout=b'domain_outbox_publisher_started'
        )
        try:
            evidence = self.runtime._application_health_once(
                object(),
                {"deployment": {"gravity_container": "crm-gravity-mvp"}},
                require_outbox=True,
            )
        finally:
            self.runtime._run = original_run
            self.runtime._required_success = original_required
        scripts = "\n".join(command[-1] for command in commands)
        self.assertEqual(len(commands), 4)
        self.assertIn("/api/health", scripts)
        self.assertIn("/api/health/infra", scripts)
        self.assertIn("/api/transport/health", scripts)
        self.assertIn("/api/messages", scripts)
        self.assertEqual(log_commands, [[self.runtime.DOCKER, "logs", "--since", "10m", "crm-gravity-mvp"]])
        self.assertTrue(evidence["protected_messages_transport_inventory_exact"])
        self.assertTrue(evidence["protected_messages_route_contract_exact"])
        self.assertTrue(evidence["outbox_publisher_startup_observed"])
        self.assertFalse(evidence["response_body_emitted"])
        self.assertFalse(evidence["log_content_emitted"])

    def test_transport_or_route_failure_propagates_inside_automatic_rollback_boundary(self) -> None:
        import inspect

        class Fault(Exception):
            def __init__(self, code: str, status: int, detail: object | None = None) -> None:
                super().__init__(code)
                self.code = code
                self.status = status
                self.detail = detail

        class FakeCore:
            RuntimeFault = Fault

        class Completed:
            def __init__(self, returncode: int) -> None:
                self.returncode = returncode
                self.stdout = b""
                self.stderr = b""

        original_run = self.runtime._run
        original_required = self.runtime._required_success
        try:
            for returncodes, expected_code in (
                ([0, 0, 5], "PROTECTED_MESSAGES_TRANSPORT_INVENTORY_MISMATCH"),
                ([0, 0, 0, 2], "PROTECTED_MESSAGES_ROUTE_STATUS_REGRESSION"),
            ):
                pending = list(returncodes)
                self.runtime._run = lambda *_args, **_kwargs: Completed(pending.pop(0))
                self.runtime._required_success = lambda *_args, **_kwargs: self.fail(
                    "outbox must not be accepted after a protected Messages probe failure"
                )
                with self.assertRaises(Fault) as raised:
                    self.runtime._application_health_once(
                        FakeCore(),
                        {"deployment": {"gravity_container": "crm-gravity-mvp"}},
                        require_outbox=True,
                    )
                self.assertEqual(raised.exception.code, expected_code)
                self.assertEqual(pending, [])
        finally:
            self.runtime._run = original_run
            self.runtime._required_success = original_required

        postcheck_source = inspect.getsource(self.runtime._activation_postcheck)
        release_source = inspect.getsource(self.runtime._release_activate)
        self.assertIn("health = _application_health(core, profile)", postcheck_source)
        postcheck_at = release_source.rfind("postcheck = _activation_postcheck(")
        failure_at = release_source.find("except Exception as activation_failure:", postcheck_at)
        rollback_at = release_source.find("rollback, rolled = _complete_activation_rollback(", failure_at)
        self.assertGreater(postcheck_at, -1)
        self.assertGreater(failure_at, postcheck_at)
        self.assertGreater(rollback_at, failure_at)


INSTALLER = ROOT / "templates/install.sh.in"
ROLLBACK_NAME = "yoko-privileged-runtime_2.0.0-13_all.deb"
ROLLBACK_SHA = "db5a91ea3192c541defa00fe432904357ff9d900be6dc8e13a5a024dddc1fa48"
NEW_NAME = "yoko-privileged-runtime_2.0.0-14_all.deb"
NEW_SHA = "a" * 64
AUDIT_DIGEST = "7d00ca9a0081858f1137939298e71ace33a36c6d436984f478284ccc6a1b3d9e"
OBSERVABILITY = {
    "wrapper": "4b9a661bba3d6575a7ab2a8c05964cc02fcc51f075328e2a864a409dcd1735eb",
    "core": "0f97bafbfe5b430fa7994119b1fc76fead4bdbee26766c730d9e399551ebdffa",
    "observer": "b5ea36c50e12b0fe6c171896258ddfc00a9d2666778735cae6a9b2a8df6d4084",
    "profile_runtime": "71322ca7b67b21ef1073ee7b521f7637b7d9a5a7ac0ce0d0485f1201432b6d76",
    "profile_manifest": "42b946b9a16126123726d80c71a7eb07f8d6345a464448fc40968cb55dc4f2ff",
    "policy": "8727373b0c6ec79c9abf82f1aaaa58abc2bae67e96aa96a602ac419f308db0e0",
    "install_manifest": "8595d63f569d7367ae69647db8c2eabc19bb7beb6b214c7c5f73650bd6c55bd6",
    "sudoers": "3022dcfc323706da81e760255dd1ab43f9b8662ee699aa8b58fbe6e714cc69d7",
    "registry": "8ea5c3b7113e1dd2ad5a74b82a1fb0bf56643fd59774dccf37e8aa9eb67bd057",
}
HISTORICAL = {
    **OBSERVABILITY,
    "wrapper": "168d61b81f3defb748b69c523a3023bb983da37dbc8316d1e2a6705d88181fa1",
    "core": "0cdeeb4ba43abe50f80fed1580ad7b0729bf83358932ece2974b3faedafed57a",
    "observer": "0" * 64,
    "profile_manifest": "ba87a9e11b74167b18a9b57299c6e6c89c3718d6637eb93bcbb540c5075a838e",
    "install_manifest": "7e22328cd89c752946d44e0a9557fd59f58f509ffea41754d4f5dddd98035549",
    "sudoers": "6e6b7cb2a088cc92fa7aee747adca46c64b4b96d1224be21117be5adef488c06",
}


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("ascii")


class InstallerSandbox:
    def __init__(self, state: str = "observability", rollback_bytes: bytes = b"rollback-good\n") -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="yoko-bootstrap-transition-")
        self.base = Path(self.temporary.name)
        self.state = self.base / "state"
        self.state.write_text(state + "\n", encoding="ascii")
        self.calls = self.base / "calls.log"
        self.dpkg_calls = self.base / "dpkg.log"
        self.bad_identity = self.base / "bad-identity"
        self.force_post_failure = self.base / "force-post-failure"
        self.low_space = self.base / "low-space"
        self.bad_metadata = self.base / "bad-metadata"
        self.root_mount = self.base / "root"
        self.varlib_mount = self.base / "varlib"
        self.fake = self.base / "fake"
        self.payload = self.root_mount / "yoko-crm-bootstrap-stage.ABCDEF12/payload"
        self.review = self.payload / "review"
        self.review.mkdir(parents=True)
        (self.varlib_mount / "yoko-privileged-runtime").mkdir(parents=True)
        os.chmod(self.varlib_mount / "yoko-privileged-runtime", 0o700)
        self.fake.mkdir()
        shutil.copyfile(INSTALLER, self.payload / "install.sh")
        (self.payload / NEW_NAME).write_bytes(b"successor-package\n")
        (self.payload / ROLLBACK_NAME).write_bytes(rollback_bytes)
        for name in ("human-manifest.md", "package-manifest.json", "installation-procedure.md", "rollback-analysis.md"):
            (self.review / name).write_text(name + "\n", encoding="ascii")
        self._write_payload_manifest()
        os.chmod(self.payload, 0o700)
        os.chmod(self.review, 0o500)
        for item in self.payload.iterdir():
            if item.is_file():
                os.chmod(item, 0o500 if item.name == "install.sh" else 0o400)
        for item in self.review.iterdir():
            os.chmod(item, 0o400)
        self._write_fakes()

    def close(self) -> None:
        self.temporary.cleanup()

    def _write_payload_manifest(self) -> None:
        files: dict[str, dict[str, str]] = {}
        for path in sorted(item for item in self.payload.rglob("*") if item.is_file() and item.name != "payload-manifest.json"):
            relative = path.relative_to(self.payload).as_posix()
            mode = 0o500 if relative == "install.sh" else 0o400
            files[relative] = {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "mode": format(mode, "04o")}
        manifest = {
            "schema": "yoko.crm.owner-bootstrap-payload.v1",
            "profile_id": "@PROFILE_ID@",
            "new_package": {"name": "yoko-privileged-runtime", "version": "2.0.0-14", "architecture": "all"},
            "previous_package": {
                "name": "yoko-privileged-runtime",
                "version": "2.0.0-13",
                "profile_id": "crm-d4575d20f91e-gravity-source-v1",
                "source_commit": "d4575d20f91e0029fdcce9669b42478bd8e34e1f",
                "sha256": ROLLBACK_SHA,
                "payload_path": ROLLBACK_NAME,
                "store_path": f"/var/lib/yoko-privileged-runtime/activation-bootstraps/{ROLLBACK_SHA}/{ROLLBACK_NAME}",
            },
            "files": files,
        }
        path = self.payload / "payload-manifest.json"
        path.write_text(json.dumps(manifest, sort_keys=True) + "\n", encoding="ascii")

    def _write_executable(self, name: str, value: str) -> None:
        path = self.fake / name
        path.write_text(value, encoding="utf-8")
        os.chmod(path, 0o755)

    def _write_fakes(self) -> None:
        hashes = json.dumps({"observability": OBSERVABILITY, "historical": HISTORICAL}, sort_keys=True)
        self._write_executable("id", "#!/bin/sh\nprintf '0\\n'\n")
        self._write_executable("hostname", "#!/bin/sh\nprintf 'jvxthcorvm\\n'\n")
        shutil.copyfile("/usr/bin/stat", self.fake / "stat-real")
        os.chmod(self.fake / "stat-real", 0o755)
        self._write_executable(
            "stat",
            "#!/bin/sh\n"
            "if test \"${1:-}\" = -f; then\n"
            "  case \"$*\" in\n"
            "    *%a*) if test -e \"$YOKO_TEST_STATE_DIR/low-space\"; then printf '1\\n'; else printf '2621440\\n'; fi;;\n"
            "    *%S*) printf '4096\\n';;\n"
            "    *) exit 2;;\n"
            "  esac\n"
            "  exit 0\n"
            "fi\n"
            "exec \"$YOKO_TEST_STATE_DIR/fake/stat-real\" \"$@\"\n",
        )
        self._write_executable(
            "dpkg-query",
            "#!/bin/sh\nstate=$(cat \"$YOKO_TEST_STATE_DIR/state\")\n"
            "case \"$state\" in missing) exit 1;; esac\n"
            "version=2.0.0-13; case \"$state\" in new|new_bad) version=2.0.0-14;; esac\n"
            "case \"$*\" in *Status-Abbrev*) printf 'ii  %s' \"$version\";; *) printf '%s' \"$version\";; esac\n",
        )
        self._write_executable(
            "dpkg-deb",
            "#!/bin/sh\n"
            "test ! -e \"$YOKO_TEST_STATE_DIR/bad-metadata\" || { printf 'wrong\\n'; exit 0; }\n"
            f"version=2.0.0-13; case \"${{2:-}}\" in *{NEW_NAME}) version=2.0.0-14;; esac\n"
            "case \"${3:-}\" in Package) printf 'yoko-privileged-runtime\\n';; Version) printf '%s\\n' \"$version\";; Architecture) printf 'all\\n';; *) exit 2;; esac\n",
        )
        self._write_executable(
            "sha256sum",
            "#!/usr/bin/python3\n"
            "import json,os,pathlib,sys\n"
            f"values={hashes}\n"
            "root=pathlib.Path(os.environ['YOKO_TEST_STATE_DIR']); path=sys.argv[-1]; state=(root/'state').read_text().strip(); bad=(root/'bad-identity').read_text().strip() if (root/'bad-identity').exists() else ''\n"
            "base=pathlib.Path(path).name\n"
            f"if base=='{NEW_NAME}': digest='{NEW_SHA}'\n"
            f"elif base=='{ROLLBACK_NAME}': digest='{ROLLBACK_SHA}' if pathlib.Path(path).read_bytes()==b'rollback-good\\n' else '0'*64\n"
            "else:\n"
            " key='wrapper' if path.endswith('/yoko-privileged-runtime') else 'core' if path.endswith('/core-2.0.0.py') else 'observer' if path.endswith('/predecessor-observability-v1.py') else 'profile_runtime' if path.endswith('gravity-source-v1.py') else 'profile_manifest' if path.endswith('/manifest.v1.json') else 'policy' if path.endswith('/policy.v2.json') else 'install_manifest' if path.endswith('/install-manifest.v1.json') else 'sudoers'\n"
            " selected='historical' if state=='historical' else 'observability'; digest=values[selected][key]; digest='0'*64 if bad==key else digest\n"
            "print(digest+'  '+path)\n",
        )
        self._write_executable(
            "dpkg",
            "#!/bin/sh\n"
            "path=${2:-}; printf '%s\\n' \"$path\" >>\"$YOKO_TEST_STATE_DIR/dpkg.log\"\n"
            f"case \"$path\" in *{ROLLBACK_NAME}) printf 'observability\\n' >\"$YOKO_TEST_STATE_DIR/state\";; *) if test -e \"$YOKO_TEST_STATE_DIR/force-post-failure\"; then printf 'new_bad\\n'; else printf 'new\\n'; fi >\"$YOKO_TEST_STATE_DIR/state\";; esac\n",
        )
        self._write_executable(
            "runuser",
            "#!/usr/bin/python3\n"
            "import hashlib,json,os,pathlib,sys\n"
            "root=pathlib.Path(os.environ['YOKO_TEST_STATE_DIR']); state=(root/'state').read_text().strip(); primitive=sys.argv[-1]; (root/'calls.log').open('a').write(primitive+'\\n')\n"
            f"obs={json.dumps(OBSERVABILITY, sort_keys=True)}\n"
            "profile='@PROFILE_ID@' if state=='new' else 'wrong-new-profile' if state=='new_bad' else 'crm-d4575d20f91e-gravity-source-v1'\n"
            "if primitive=='self-check':\n"
            " installed={'/etc/sudoers.d/92-yoko-privileged-runtime':obs['sudoers'],'/usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py':obs['core'],'/usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py':obs['observer'],'/usr/local/sbin/yoko-privileged-runtime':obs['wrapper'],'/usr/local/share/yoko-privileged-runtime/policy.v2.json':obs['policy']}\n"
            " package_version='2.0.0-14' if state in {'new','new_bad'} else '2.0.0-13'\n"
            " evidence={'runtime_version':'2.0.0','package_version':package_version,'activation_profile_id':profile,'profile_argument_shape':'ZERO_ARGUMENT_ONLY','activation_profile_manifest_sha256':obs['profile_manifest'],'predecessor_observability_sha256':obs['observer'],'registry_sha256':obs['registry'],'installed_identity':installed,'generic_command_execution':False,'arbitrary_paths':False,'docker_socket_delegated':False}\n"
            "elif primitive=='capabilities': evidence={'activation_profile_id':profile,'enabled_activation_profiles':['database-status','release-preflight','release-activate','rollback'],'enabled_read_only_profiles':['predecessor-observe'],'disabled_profiles':{'config-activation':'disabled','database-migration':'disabled'},'generic_command_execution':False,'arbitrary_paths':False,'arbitrary_package_install':False,'resources':{}}\n"
            f"elif primitive=='audit-status': evidence={{'state':'VALID','record_count':43,'last_digest':'{AUDIT_DIGEST}'}}\n"
            "elif primitive=='docker-provenance':\n"
            " semantic={'name':'crm-gravity-mvp','image_id':'sha256:'+'2'*64}; body={'records':[semantic],'schema':'yoko.ai-calls.production-semantic-identity.v1'}; fingerprint=hashlib.sha256(json.dumps(body,sort_keys=True,separators=(',',':')).encode('ascii')).hexdigest(); record={'name':'crm-gravity-mvp','container_id':'1'*64,'image_id':'sha256:'+'2'*64,'status':'running','started_at':'2026-08-27T00:00:00Z','restart_count':0,'semantic':semantic}; evidence={'complete':True,'failures':[],'records':[record],'semantic':{**body,'fingerprint_sha256':fingerprint}}\n"
            "else: raise SystemExit(2)\n"
            "print(json.dumps({'ok':True,'evidence':evidence},sort_keys=True,separators=(',',':')))\n",
        )

    def run(self) -> subprocess.CompletedProcess[str]:
        environment = dict(os.environ, YOKO_TEST_STATE_DIR=str(self.base))
        inner = """
set -eu
mount --make-rprivate /
mount --bind "$1" /root
mount --bind "$2" /var/lib
mount --bind "$3/dpkg-query" /usr/bin/dpkg-query
mount --bind "$3/dpkg-deb" /usr/bin/dpkg-deb
mount --bind "$3/dpkg" /usr/bin/dpkg
mount --bind "$3/sha256sum" /usr/bin/sha256sum
mount --bind "$3/stat" /usr/bin/stat
mount --bind "$3/runuser" /usr/sbin/runuser
mount --bind "$3/id" /usr/bin/id
mount --bind "$3/hostname" /bin/hostname
cd /root/yoko-crm-bootstrap-stage.ABCDEF12/payload
./install.sh
"""
        unprivileged = subprocess.run(
            ["/usr/bin/unshare", "-Ur", "-m", "/bin/bash", "-c", inner, "sandbox", str(self.root_mount), str(self.varlib_mount), str(self.fake)],
            env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=90,
        )
        if (
            unprivileged.returncode == 0
            or "unshare: write failed /proc/self/uid_map: Operation not permitted" not in unprivileged.stderr
            or not Path("/usr/bin/sudo").is_file()
        ):
            return unprivileged
        # GitHub's hosted Ubuntu runner disables unprivileged user-namespace
        # mappings. Its documented passwordless test sudo remains bounded here
        # to one fresh mount namespace, a clean environment and fixed paths;
        # mount propagation is made private before any bind. Nothing from this
        # harness is shipped in the Runtime privilege boundary.
        privileged_inner = """
set -eu
case "$4:$5" in *[!0-9:]*|:*|*:) exit 125;; esac
fixture_root=$1
fixture_varlib=$2
fixture_base=$YOKO_TEST_STATE_DIR
fixture_uid=$4
fixture_gid=$5
test "$fixture_root" = "$fixture_base/root"
test "$fixture_varlib" = "$fixture_base/varlib"
restore_fixture_ownership() {
    rc=$?
    if ! /usr/bin/chown -R "$fixture_uid:$fixture_gid" -- "$fixture_base"; then rc=125; fi
    trap - EXIT
    exit "$rc"
}
trap restore_fixture_ownership EXIT
/usr/bin/chown -R 0:0 -- "$fixture_base"
""" + inner
        return subprocess.run(
            [
                "/usr/bin/sudo", "-n", "/usr/bin/env", "-i",
                "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
                f"YOKO_TEST_STATE_DIR={self.base}",
                "/usr/bin/unshare", "-m", "--fork", "/bin/bash", "-c", privileged_inner,
                "sandbox", str(self.root_mount), str(self.varlib_mount), str(self.fake),
                str(os.getuid()), str(os.getgid()),
            ],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=90,
        )

    def dpkg_log(self) -> list[str]:
        return self.dpkg_calls.read_text(encoding="utf-8").splitlines() if self.dpkg_calls.exists() else []

    def guard(self) -> Path:
        return self.varlib_mount / "yoko-privileged-runtime/activation-bootstrap-installing.v1"


class BootstrapTransitionTests(unittest.TestCase):
    def sandbox(self, *args: object, **kwargs: object) -> InstallerSandbox:
        value = InstallerSandbox(*args, **kwargs)
        self.addCleanup(value.close)
        return value

    def test_owner_envelope_rejects_low_space_and_cleans_exact_staging(self) -> None:
        loader = importlib.machinery.SourceFileLoader(
            "runtime_finalize_evidence",
            str(ROOT / "packaging/finalize-evidence.py"),
        )
        spec = importlib.util.spec_from_loader(loader.name, loader)
        self.assertIsNotNone(spec)
        assert spec is not None
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        digest = "a" * 64
        command = module.owner_command(digest)
        self.assertEqual(module.OWNER_MINIMUM_FREE_BYTES, 10 * 1024 * 1024 * 1024)
        self.assertIn('/root/yoko-crm-bootstrap.$expected.tar', command)
        self.assertIn('/root/yoko-crm-bootstrap-stage.$expected', command)
        self.assertIn('if [ -e "$root_tar" ] || [ -L "$root_tar" ]', command)
        self.assertIn('if [ -e "$stage" ] || [ -L "$stage" ]', command)
        self.assertIn('/usr/bin/find "$stage" -xdev -depth -delete', command)
        self.assertIn('trap on_exit EXIT', command)
        self.assertIn('test "$available_bytes" -ge 10737418240', command)
        self.assertNotIn("mktemp", command)
        self.assertNotIn("exec ./install.sh", command)
        self.assertLess(command.index('test "$available_bytes"'), command.index('/usr/bin/install -d'))
        completed = subprocess.run(
            ["/bin/bash", "-n", "-c", command],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr.decode())

    def test_exact_observability_prestate_accepted(self) -> None:
        box = self.sandbox()
        result = box.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"status":"INSTALLED"', result.stdout)
        self.assertEqual(len(box.dpkg_log()), 1)
        self.assertTrue(box.dpkg_log()[0].endswith(NEW_NAME))
        self.assertFalse(box.guard().exists())
        stored = box.varlib_mount / f"yoko-privileged-runtime/activation-bootstraps/{ROLLBACK_SHA}/{ROLLBACK_NAME}"
        self.assertEqual(stored.read_bytes(), b"rollback-good\n")
        self.assertEqual(stat.S_IMODE(stored.stat().st_mode), 0o400)

    def test_installer_rejects_low_space_before_dpkg(self) -> None:
        box = self.sandbox()
        box.low_space.touch()
        result = box.run()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(box.dpkg_log(), [])
        self.assertFalse(box.guard().exists())
        self.assertIn('"rollback_restored":false', result.stdout)
        self.assertIn('"production_mutation":false', result.stdout)
        installer = INSTALLER.read_text(encoding="utf-8")
        self.assertLess(installer.index('test "$available_bytes"'), installer.rindex("new_attempted=1"))

    def test_historical_only_prestate_rejected_without_mutation(self) -> None:
        box = self.sandbox("historical")
        result = box.run()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(box.dpkg_log(), [])
        self.assertFalse(box.guard().exists())
        self.assertIn('"production_mutation":false', result.stdout)

    def test_mixed_and_wrong_identity_prestates_rejected_without_mutation(self) -> None:
        for identity in ("wrapper", "profile_manifest", "install_manifest", "sudoers", "core", "observer"):
            with self.subTest(identity=identity):
                box = self.sandbox()
                box.bad_identity.write_text(identity + "\n", encoding="ascii")
                result = box.run()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(box.dpkg_log(), [])
                self.assertFalse(box.guard().exists())

    def test_forced_post_mutation_failure_restores_exact_observability_runtime(self) -> None:
        box = self.sandbox()
        box.force_post_failure.touch()
        result = box.run()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(box.dpkg_log()), 2)
        self.assertTrue(box.dpkg_log()[0].endswith(NEW_NAME))
        self.assertTrue(box.dpkg_log()[1].endswith(ROLLBACK_NAME))
        self.assertEqual(box.state.read_text(encoding="ascii").strip(), "observability")
        self.assertIn('"rollback_restored":true', result.stdout)
        self.assertFalse(box.guard().exists())

    def test_rollback_self_check_audit_store_and_provenance_verified(self) -> None:
        box = self.sandbox()
        box.force_post_failure.touch()
        result = box.run()
        self.assertNotEqual(result.returncode, 0)
        calls = box.calls.read_text(encoding="utf-8").splitlines()
        self.assertGreaterEqual(calls.count("self-check"), 2)
        self.assertGreaterEqual(calls.count("audit-status"), 2)
        self.assertGreaterEqual(calls.count("docker-provenance"), 2)
        self.assertIn('"production_mutation":false', result.stdout)

    def test_successor_retry_is_idempotent(self) -> None:
        box = self.sandbox()
        first = box.run()
        self.assertEqual(first.returncode, 0, first.stderr)
        second = box.run()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn('"status":"ALREADY_INSTALLED"', second.stdout)
        self.assertEqual(len(box.dpkg_log()), 1)

    def test_power_loss_guard_reconciliation_is_idempotent(self) -> None:
        box = self.sandbox()
        self.assertEqual(box.run().returncode, 0)
        # Crash after guard creation but before dpkg: exact old state retries
        # the intended install and clears the same guard.
        box.state.write_text("observability\n", encoding="ascii")
        box.guard().write_bytes(b"")
        os.chmod(box.guard(), 0o400)
        second = box.run()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertFalse(box.guard().exists())
        self.assertEqual(len(box.dpkg_log()), 2)
        # Crash after successful dpkg but before guard unlink: exact successor
        # state only reconciles the guard and never reinstalls either package.
        box.guard().write_bytes(b"")
        os.chmod(box.guard(), 0o400)
        third = box.run()
        self.assertEqual(third.returncode, 0, third.stderr)
        self.assertFalse(box.guard().exists())
        self.assertEqual(len(box.dpkg_log()), 2)

    def test_wrong_or_substituted_direct_rollback_deb_rejected(self) -> None:
        box = self.sandbox(rollback_bytes=b"rollback-substituted\n")
        result = box.run()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(box.dpkg_log(), [])
        self.assertFalse(box.guard().exists())

    def test_payload_and_successor_identity_substitution_rejected(self) -> None:
        box = self.sandbox()
        box.bad_metadata.touch()
        metadata = box.run()
        self.assertNotEqual(metadata.returncode, 0)
        self.assertEqual(box.dpkg_log(), [])
        second = self.sandbox()
        (second.payload / "unexpected").write_text("substitution\n", encoding="ascii")
        os.chmod(second.payload / "unexpected", 0o400)
        inventory = second.run()
        self.assertNotEqual(inventory.returncode, 0)
        self.assertEqual(second.dpkg_log(), [])

    def test_transition_scope_preserves_zero_argument_boundary(self) -> None:
        installer = INSTALLER.read_text(encoding="utf-8")
        self.assertIn('test "$#" -eq 0', installer)
        self.assertIn("OLD_DEB_SHA='" + ROLLBACK_SHA + "'", installer)
        self.assertIn('/usr/bin/dpkg --install "$OLD_DEB_STORED"', installer)
        self.assertNotIn("6865eab377dda757d101259e7321268998b45ea8b27f6003de0cf7e191a9b54e", installer)
        for forbidden in ("/bin/sh -c", "docker.sock", "docker ps", "curl ", "wget ", "apt-get", "git clone"):
            self.assertNotIn(forbidden, installer)




if __name__ == "__main__":
    unittest.main(verbosity=2)
