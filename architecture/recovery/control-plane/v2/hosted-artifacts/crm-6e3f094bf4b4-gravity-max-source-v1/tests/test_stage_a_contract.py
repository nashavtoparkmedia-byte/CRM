from __future__ import annotations

from collections.abc import Mapping
import hashlib
import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[7]
AUTHORITY = Path(__file__).resolve().parents[1]
APPLICATION_COMMIT = "6e3f094bf4b42c1400c705843ab107dacd6d1cf8"
BUILDER_COMMIT = "80b17fbf143c3d67d786b26cae7e2b09829e52f7"
BUILDER_BASE_COMMIT = "ba94bb493cef9938b07f187faf86bc81724cc9c0"
PROFILE = "crm-6e3f094bf4b4-gravity-max-source-v1"
COMMIT_SHA = re.compile(r"^[0-9a-f]{40}$")
HOSTED_BUILDER_REF = "refs/heads/stage-a-builder"
HOSTED_BUILDER_BASE_REF = "refs/heads/stage-a-builder-base"
ALLOWED_STAGE_A_PATHS = {
    ".github/workflows/architecture-enforcement.yml",
    ".github/workflows/coordinated-gravity-max-6e3f094b.yml",
    "tools/architecture/run-authoritative-ci.mjs",
    "tools/architecture/test-authoritative-ci-inventory.mjs",
    "tools/architecture/test-executable-path-ownership.mjs",
    "tools/architecture/test-hosted-coordinated-gravity-max-stage-a.mjs",
    "tools/architecture/v2/test-original-dod-canonical-mapping.mjs",
    "tools/architecture/v2/verify-final-rereview-closure.mjs",
    "architecture/contexts/v1/SHA256SUMS",
    "architecture/contexts/v1/context-index.json",
    "architecture/contexts/v1/executable-path-ownership-coverage.json",
    "architecture/recovery/whole-project-dod/v2/EXECUTABLE_PATH_OWNERSHIP_REVIEW_20260813.json",
    "architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json",
    "architecture/recovery/whole-project-dod/v2/credential-unknown-access-resolution.json",
}
STAGE_A_AUTHORITY_PREFIX = (
    "architecture/recovery/control-plane/v2/hosted-artifacts/"
    "crm-6e3f094bf4b4-gravity-max-source-v1/"
)


def git_commit(root: Path, revision: str) -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(root), "rev-parse", "--verify", f"{revision}^{{commit}}"],
            stderr=subprocess.PIPE,
            text=True,
        ).strip()
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"unavailable Stage A git authority: {revision}") from error


def resolve_builder_authorities(
    *,
    root: Path = ROOT,
    environment: Mapping[str, str] = os.environ,
    builder_commit: str = BUILDER_COMMIT,
    builder_base_commit: str = BUILDER_BASE_COMMIT,
) -> tuple[str, str]:
    configured_builder = environment.get("YOKO_STAGE_A_BUILDER")
    expected_builder = environment.get("YOKO_STAGE_A_BUILDER_COMMIT")
    configured_base = environment.get("YOKO_STAGE_A_BUILDER_BASE")
    expected_base = environment.get("YOKO_STAGE_A_BUILDER_BASE_COMMIT")
    configured = (configured_builder, expected_builder, configured_base, expected_base)
    if any(configured) and not all(configured):
        raise RuntimeError("explicit Stage A builder authority requires both complete ref/commit pairs")

    if all(configured):
        if configured_builder != HOSTED_BUILDER_REF or configured_base != HOSTED_BUILDER_BASE_REF:
            raise RuntimeError("explicit Stage A builder authority must use the trusted hosted refs")
        if expected_builder != builder_commit or expected_base != builder_base_commit:
            raise RuntimeError("explicit Stage A builder authority must match the fixed commit identities")
        builder = git_commit(root, configured_builder)
        builder_base = git_commit(root, configured_base)
        if builder != expected_builder or builder_base != expected_base:
            raise RuntimeError("Stage A builder refs do not match their expected commit identities")
    else:
        builder = git_commit(root, builder_commit)
        builder_base = git_commit(root, builder_base_commit)

    if builder == builder_base:
        raise RuntimeError("Stage A builder and base authorities must differ")
    return builder_base, builder


def changed_paths(root: Path, base: str, head: str) -> list[str]:
    return subprocess.check_output(
        ["git", "-C", str(root), "diff", "--name-only", base, head], text=True,
    ).splitlines()


def unexpected_stage_a_paths(root: Path, base: str, builder: str) -> list[str]:
    return [
        name for name in changed_paths(root, base, builder)
        if name not in ALLOWED_STAGE_A_PATHS and not name.startswith(STAGE_A_AUTHORITY_PREFIX)
    ]


BUILDER_BASE, BUILDER = resolve_builder_authorities()


class StageAContractTests(unittest.TestCase):
    def test_explicit_builder_authorities_require_fixed_complete_identity(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "trusted hosted ref"):
            resolve_builder_authorities(
                root=ROOT,
                environment={
                    "YOKO_STAGE_A_BUILDER": "HEAD",
                    "YOKO_STAGE_A_BUILDER_COMMIT": BUILDER_COMMIT,
                    "YOKO_STAGE_A_BUILDER_BASE": HOSTED_BUILDER_BASE_REF,
                    "YOKO_STAGE_A_BUILDER_BASE_COMMIT": BUILDER_BASE_COMMIT,
                },
            )
        with self.assertRaisesRegex(RuntimeError, "both complete"):
            resolve_builder_authorities(
                root=ROOT,
                environment={"YOKO_STAGE_A_BUILDER": HOSTED_BUILDER_REF},
            )
        with self.assertRaisesRegex(RuntimeError, "fixed commit identities"):
            resolve_builder_authorities(
                root=ROOT,
                environment={
                    "YOKO_STAGE_A_BUILDER": HOSTED_BUILDER_REF,
                    "YOKO_STAGE_A_BUILDER_COMMIT": "f" * 40,
                    "YOKO_STAGE_A_BUILDER_BASE": HOSTED_BUILDER_BASE_REF,
                    "YOKO_STAGE_A_BUILDER_BASE_COMMIT": BUILDER_BASE_COMMIT,
                },
            )

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.name", "Stage A test"], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.email", "stage-a@example.invalid"], check=True)
            (root / "fixture").write_text("base\n")
            subprocess.run(["git", "-C", str(root), "add", "fixture"], check=True)
            subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "base"], check=True)
            base = git_commit(root, "HEAD")
            (root / "fixture").write_text("head\n")
            subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-am", "head"], check=True)
            head = git_commit(root, "HEAD")
            subprocess.run(["git", "-C", str(root), "update-ref", HOSTED_BUILDER_REF, base], check=True)
            subprocess.run(["git", "-C", str(root), "update-ref", HOSTED_BUILDER_BASE_REF, base], check=True)

            with self.assertRaisesRegex(RuntimeError, "do not match"):
                resolve_builder_authorities(
                    root=root,
                    environment={
                        "YOKO_STAGE_A_BUILDER": HOSTED_BUILDER_REF,
                        "YOKO_STAGE_A_BUILDER_COMMIT": head,
                        "YOKO_STAGE_A_BUILDER_BASE": HOSTED_BUILDER_BASE_REF,
                        "YOKO_STAGE_A_BUILDER_BASE_COMMIT": base,
                    },
                    builder_commit=head,
                    builder_base_commit=base,
                )

    def test_missing_fixed_builder_authority_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.name", "Stage A test"], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.email", "stage-a@example.invalid"], check=True)
            (root / "fixture").write_text("fixture\n")
            subprocess.run(["git", "-C", str(root), "add", "fixture"], check=True)
            subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "fixture"], check=True)
            with self.assertRaisesRegex(RuntimeError, "unavailable Stage A git authority"):
                resolve_builder_authorities(root=root, environment={})

    def test_stage_a_builder_does_not_modify_application_or_runtime_surfaces(self) -> None:
        protected = [
            "gravity-mvp",
            "max-web-scraper",
            "deploy/docker-compose.production.yml",
        ]
        result = subprocess.run(
            ["git", "-C", str(ROOT), "diff", "--exit-code", BUILDER_BASE, BUILDER, "--", *protected],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.assertEqual(result.returncode, 0, result.stdout.decode() + result.stderr.decode())

    def test_fixed_builder_change_set_is_stage_a_control_plane_only(self) -> None:
        names = changed_paths(ROOT, BUILDER_BASE, BUILDER)
        self.assertEqual(unexpected_stage_a_paths(ROOT, BUILDER_BASE, BUILDER), [])
        self.assertFalse(any("2.0.0-15" in name or "runtime-v15" in name.lower() for name in names))

    def test_later_application_changes_do_not_redefine_fixed_builder_scope(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.name", "Stage A test"], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.email", "stage-a@example.invalid"], check=True)
            (root / "fixture").write_text("base\n")
            subprocess.run(["git", "-C", str(root), "add", "fixture"], check=True)
            subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "base"], check=True)
            base = git_commit(root, "HEAD")

            workflow = root / ".github/workflows/architecture-enforcement.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text("fixed Stage A builder\n")
            subprocess.run(["git", "-C", str(root), "add", str(workflow.relative_to(root))], check=True)
            subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "builder"], check=True)
            builder = git_commit(root, "HEAD")

            application = root / "gravity-mvp/src/future-fix.ts"
            application.parent.mkdir(parents=True)
            application.write_text("export const fixed = true\n")
            subprocess.run(["git", "-C", str(root), "add", str(application.relative_to(root))], check=True)
            subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "future application fix"], check=True)

            self.assertEqual(unexpected_stage_a_paths(root, base, builder), [])
            self.assertEqual(
                unexpected_stage_a_paths(root, base, git_commit(root, "HEAD")),
                ["gravity-mvp/src/future-fix.ts"],
            )

    def test_workflow_is_content_specific_and_has_minimal_permissions(self) -> None:
        workflow = (ROOT / ".github/workflows/coordinated-gravity-max-6e3f094b.yml").read_text()
        self.assertIn("codex/prepare-max-coordinated-release-20260901", workflow)
        self.assertNotIn("workflow_dispatch", workflow)
        self.assertNotIn("pull_request:", workflow)
        self.assertNotIn("inputs:", workflow)
        self.assertRegex(workflow, r"permissions:\n  contents: read\n  actions: read")
        self.assertNotIn("secrets.", workflow)
        self.assertNotIn("docker/login-action", workflow)
        self.assertNotIn("packages: write", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertEqual(workflow.count("docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f"), 1)
        self.assertIn("actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683", workflow)
        self.assertIn("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093", workflow)
        self.assertEqual(
            workflow.count("uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"),
            12,
        )
        self.assertIn("artifact-ids: '9786032152'", workflow)
        self.assertIn("run-id: '33461902086'", workflow)

    def test_application_and_builder_authorities_are_separate_and_fixed(self) -> None:
        workflow = (ROOT / ".github/workflows/coordinated-gravity-max-6e3f094b.yml").read_text()
        for value in (
            APPLICATION_COMMIT,
            "8d3e507cda69a2862db946b2e34c5ea329c425ac",
            "abbe37034aa88c478eb8e44b6be5b047e9bcd574",
            "e9c3c0ce56c744de1843547276e70d8f2d970197",
        ):
            self.assertIn(value, workflow)
        self.assertIn("path: release-authority", workflow)
        self.assertIn("path: application-source", workflow)
        self.assertIn("EXPECTED_BUILDER_COMMIT: ${{ github.sha }}", workflow)
        self.assertNotRegex(workflow, r"application[^\n]*\$\{\{")

    def test_source_authority_artifact_is_flattened_to_verified_path(self) -> None:
        workflow = (ROOT / ".github/workflows/coordinated-gravity-max-6e3f094b.yml").read_text()
        download = workflow.split("- name: Download exact accepted source execution proof", 1)[1].split(
            "- name: Capture exact public source authority identities", 1
        )[0]
        capture = workflow.split("- name: Capture exact public source authority identities", 1)[1].split(
            "- name: Set up one exact Buildx and BuildKit authority", 1
        )[0]
        self.assertIn("artifact-ids: '9786032152'", download)
        self.assertIn("path: source-authority", download)
        self.assertIn("merge-multiple: true", download)
        self.assertIn("test -f source-authority/authoritative-ci-execution.json", capture)

    def test_both_images_use_one_build_authority_and_coordinated_labels(self) -> None:
        workflow = (ROOT / ".github/workflows/coordinated-gravity-max-6e3f094b.yml").read_text()
        self.assertEqual(workflow.count("--platform linux/amd64"), 2)
        self.assertEqual(workflow.count("--provenance=false"), 2)
        self.assertEqual(workflow.count("--sbom=false"), 2)
        self.assertEqual(workflow.count(f"--label yoko.activation.profile={PROFILE}"), 2)
        self.assertEqual(workflow.count(f"--label org.opencontainers.image.revision={APPLICATION_COMMIT}"), 2)
        self.assertIn("moby/buildkit:v0.25.2@sha256:72bda77240181301a0d5ee57d39fa58e4aabd7eff26f81bbf108088caf810f05", workflow)

    def test_authenticated_transport_is_exact_and_connector_bounded(self) -> None:
        workflow = (ROOT / ".github/workflows/coordinated-gravity-max-6e3f094b.yml").read_text()
        self.assertIn("authenticated-transport:\n    needs: coordinated-artifact", workflow)
        self.assertEqual(workflow.count("runs-on: ubuntu-24.04"), 2)
        self.assertIn("actions/artifacts/$ARTIFACT_ID/zip", workflow)
        self.assertIn('| python3 -I -B "$authority/build/chunk-hosted-artifact.py"', workflow)
        self.assertIn('python3 -I -B "$authority/verify-artifact-transport.py"', workflow)
        self.assertIn('python3 -I -B "$authority/build/verify-hosted-transport-registry.py"', workflow)
        self.assertEqual(workflow.count("compression-level: 0"), 12)
        self.assertEqual(workflow.count("retention-days: 1"), 11)
        self.assertEqual(workflow.count("overwrite: true"), 12)
        self.assertIn("for attempt in 1 2 3 4 5 6; do", workflow)
        self.assertIn('test "$attempt" -lt 6', workflow)
        for index in range(10):
            suffix = f"part-{index:03d}"
            self.assertIn(f"coordinated-transport-6e3f094bf4b4-${{{{ github.sha }}}}-{suffix}", workflow)
            self.assertIn(f"coordinated-transport/coordinated-artifact.zip.{suffix}", workflow)
        self.assertIn("coordinated-artifact-transport-manifest.json", workflow)
        self.assertIn("actions/runs/$GITHUB_RUN_ID/artifacts?per_page=100", workflow)
        self.assertNotIn("secrets.", workflow)

        transport_contract = (AUTHORITY / "hosted_artifact_transport.py").read_text()
        for binding in (
            'CHUNK_BYTES = 500 * 1024 * 1024',
            'CHUNK_COUNT = 10',
            'CONNECTOR_MAX_BYTES = 512 * 1024 * 1024',
            'MINIMUM_FREE_RESERVE_BYTES = 4 * 1024 * 1024 * 1024',
            'ensure_transport_capacity(output_directory.parent, source["bytes"])',
            'combined.hexdigest() != source["digest"].removeprefix("sha256:")',
            'artifact.get("expired") is not False',
            'workflow_run.get("head_sha") != builder_commit',
        ):
            self.assertIn(binding, transport_contract)

    def test_max_release_dockerfile_uses_exact_materials_without_mutable_apt(self) -> None:
        dockerfile = (AUTHORITY / "build/max-scraper.Dockerfile").read_text()
        self.assertTrue(dockerfile.startswith("# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e\n"))
        pinned_base = "mcr.microsoft.com/playwright:v1.58.2-jammy@sha256:02627380acd41aa17ec78d3fb554be2fffd1f3c603d659aadafbdd6fb34289b0"
        self.assertEqual(dockerfile.count(f"FROM {pinned_base}"), 2)
        self.assertNotIn("apt-get", dockerfile)
        self.assertIn("ADD --checksum=sha256:91119fce795e668bb4db2c94d1416127688242e1856f2fcf8cf2112dde8da57d", dockerfile)
        self.assertIn("tini_0.19.0-1_amd64.deb", dockerfile)
        self.assertNotIn("COPY --chown=pwuser:pwuser . .", dockerfile)
        self.assertNotIn("COPY . .", dockerfile)
        self.assertNotRegex(dockerfile, r"(?m)^COPY .*\bmaxBrowser\.js\b")
        verifier = (AUTHORITY / "coordinated_release_contract.py").read_text()
        for authority in (
            "sha256:9da6b4e352d0d5c94963eba1832408f5b7b08839cd8be9b6610c05de5118c704",
            "sha256:303ea68e088c4f9ca529764ddeef3ba1e5364f6df6a63d54c3795307a9c513bc",
            "274f2bed211788a4fcb52d14f93ab6e7c44528493b56af5812a1cfe8ae1d2064",
            "Docker rootfs base layer authority mismatch",
        ):
            self.assertIn(authority, verifier)

    def test_max_runtime_process_and_health_contract_is_preserved(self) -> None:
        dockerfile = (AUTHORITY / "build/max-scraper.Dockerfile").read_text()
        for exact in (
            "WORKDIR /app",
            "ENV NODE_ENV=production",
            "ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
            "ENV TZ=Europe/Moscow",
            "USER pwuser",
            'ENTRYPOINT ["/usr/bin/tini", "--"]',
            'CMD ["node", "index.js"]',
            'CMD pgrep -f "node.*index" >/dev/null || exit 1',
            "RUN mkdir -p /app/user_data",
        ):
            self.assertIn(exact, dockerfile)
        workflow = (ROOT / ".github/workflows/coordinated-gravity-max-6e3f094b.yml").read_text()
        for guard in ("--network none", "--read-only", "--tmpfs /tmp:", "--cap-drop ALL", "--security-opt no-new-privileges"):
            self.assertIn(guard, workflow)
        probe = (AUTHORITY / "build/max-runtime-probe.js").read_text()
        for proof in ("chromium.launchPersistentContext", "browser_launch: 'PASS'", "writable_by_runtime_identity", "'/app/maxBrowser.js'"):
            self.assertIn(proof, probe)

    def test_release_copy_set_covers_exact_relative_runtime_module_graph(self) -> None:
        dockerfile = (AUTHORITY / "build/max-scraper.Dockerfile").read_text()
        copied_roots = {"index.js", "contacts", "lib", "media", "parser", "session", "sync", "transport"}
        for root in copied_roots:
            self.assertRegex(dockerfile, rf"(?m)^COPY .*\b{re.escape(root)}\b")
        runtime_files = [ROOT / "max-web-scraper/index.js"] + [
            path for directory in ("contacts", "lib", "media", "parser", "session", "sync", "transport")
            for path in (ROOT / "max-web-scraper" / directory).glob("*.js")
        ]
        for source in runtime_files:
            executable = re.sub(r"/\*.*?\*/", "", source.read_text(), flags=re.DOTALL)
            executable = re.sub(r"(?m)^\s*//.*$", "", executable)
            for relative in re.findall(r"require\(['\"](\.{1,2}/[^'\"]+)['\"]\)", executable):
                target = (source.parent / relative).resolve()
                candidates = [target, target.with_suffix(".js"), target / "index.js"]
                self.assertTrue(any(candidate.is_file() for candidate in candidates), f"unresolved runtime require in {source}: {relative}")
                resolved = next(candidate for candidate in candidates if candidate.is_file())
                self.assertIn(resolved.relative_to(ROOT / "max-web-scraper").parts[0], copied_roots)

    def test_artifact_upload_is_one_exact_six_member_authority(self) -> None:
        workflow = (ROOT / ".github/workflows/coordinated-gravity-max-6e3f094b.yml").read_text()
        members = [
            "gravity-image.docker.tar",
            "gravity-image-attestation.json",
            "max-scraper-image.docker.tar",
            "max-scraper-image-attestation.json",
            "coordinated-release-manifest.json",
            "authoritative-ci-execution.json",
        ]
        upload = workflow.split("- name: Upload one exact coordinated artifact", 1)[1].split("- name: Record hosted coordinated artifact identity", 1)[0]
        for member in members:
            self.assertEqual(upload.count(f"release-output/{member}"), 1)
        self.assertIn("compression-level: 0", upload)
        self.assertIn("if-no-files-found: error", upload)

    def test_schema_identity_and_fail_closed_additional_properties(self) -> None:
        schema = json.loads((AUTHORITY / "schemas/coordinated-release-manifest.v1.schema.json").read_text())
        self.assertEqual(schema["$id"], "yoko.crm.coordinated-gravity-max-release.v1")
        self.assertIs(schema["additionalProperties"], False)
        self.assertEqual(len(schema["properties"]["artifact_members"]["const"]), 6)


if __name__ == "__main__":
    unittest.main()
