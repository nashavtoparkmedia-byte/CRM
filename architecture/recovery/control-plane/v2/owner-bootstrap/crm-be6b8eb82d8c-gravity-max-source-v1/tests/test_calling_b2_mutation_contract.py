#!/usr/bin/python3
"""Weakening mutants of the Calling B2 capability must each be caught by the contract suites.

Every mutant is one exact textual change to a private copy of the builder. The copy's own tests
run in a subprocess and must fail; the unmutated copy must pass, so a failure is attributable to
the mutant alone. Nothing here touches the real builder tree, Docker or any production path.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROFILE = "templates/crm-activation-profile.py.in"
SUITES = ("test_calling_b2_environment_contract", "test_release_environment_contract")

# (identifier, relative file, exact original text, weakened text)
MUTANTS = (
    (
        "allow-arbitrary-env-name-in-source", PROFILE,
        '        if name not in CALLING_B2_ENVIRONMENT_NAMES:\n            raise invalid("UNKNOWN_NAME")\n',
        '        if False:\n            raise invalid("UNKNOWN_NAME")\n',
    ),
    (
        "allow-arbitrary-env-name-in-render", PROFILE,
        "    remainder = {key: item for key, item in candidate.items() if key not in admitted}\n",
        '    remainder = {key: item for key, item in candidate.items() if key not in admitted and not key.startswith("AI_CALL_")}\n',
    ),
    (
        "allow-second-service-admission", PROFILE,
        "    if service == CALLING_B2_SERVICE:\n        return (RELEASE_ENVIRONMENT_NAME, *CALLING_B2_ENVIRONMENT_NAMES)\n",
        "    if service in RELEASE_ENVIRONMENT_SOURCES:\n        return (RELEASE_ENVIRONMENT_NAME, *CALLING_B2_ENVIRONMENT_NAMES)\n",
    ),
    (
        "allow-second-service-overlay", PROFILE,
        "        if service == CALLING_B2_SERVICE:\n            sources.append(CALLING_B2_ENVIRONMENT_SOURCE)\n",
        "        if True:\n            sources.append(CALLING_B2_ENVIRONMENT_SOURCE)\n",
    ),
    (
        "drop-root-ownership-and-mode", PROFILE,
        "        expected = _fixed_production_file(core, CALLING_B2_ENVIRONMENT_SOURCE, 0o600, CALLING_B2_ENVIRONMENT_SOURCE_MAXIMUM)\n",
        "        expected = core.mapped(CALLING_B2_ENVIRONMENT_SOURCE).stat()\n",
    ),
    (
        "drop-root-only-directory", PROFILE,
        "        core.secure_directory(CALLING_B2_ENVIRONMENT_DIRECTORY, 0o700)\n",
        "        core.mapped(CALLING_B2_ENVIRONMENT_DIRECTORY)\n",
    ),
    (
        "drop-inode-binding", PROFILE,
        "        if (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino):\n            raise core.RuntimeFault(\"CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE\", 74, {\"source\": \"file\"})\n",
        "        if False:\n            raise core.RuntimeFault(\"CALLING_B2_ENVIRONMENT_SOURCE_UNSAFE\", 74, {\"source\": \"file\"})\n",
    ),
    (
        "allow-duplicate-name", PROFILE,
        '        if name in values:\n            raise invalid("DUPLICATE_NAME", name=name)\n',
        '        if False:\n            raise invalid("DUPLICATE_NAME", name=name)\n',
    ),
    (
        "allow-missing-name", PROFILE,
        '    if missing:\n        raise invalid("MISSING_NAME", names=missing)\n',
        '    if False:\n        raise invalid("MISSING_NAME", names=missing)\n',
    ),
    (
        "allow-any-kill-switch-value", PROFILE,
        "        if values[name] not in CALLING_B2_KILL_SWITCH_VALUES:\n",
        "        if False:\n",
    ),
    (
        "allow-source-mutation-after-preflight", PROFILE,
        '        raise core.RuntimeFault("CALLING_B2_ENVIRONMENT_IDENTITY_DRIFT", 74)\n',
        "        pass\n",
    ),
    (
        "compose-boundary-reads-unbound-source", PROFILE,
        '        calling_values = _validate_calling_b2_environment(core, state)["values"]\n',
        '        calling_values = _calling_b2_environment(core)["values"]\n',
    ),
    (
        "log-secret-in-fault", PROFILE,
        "            raise core.RuntimeFault(code, 74, {\"service\": service})\n",
        "            raise core.RuntimeFault(code, 74, {\"service\": service, \"expected\": bound})\n",
    ),
    (
        "log-secret-in-state", PROFILE,
        '            "calling_b2_environment_sha256": calling_environment["sha256"],\n',
        '            "calling_b2_environment_sha256": calling_environment["sha256"],\n            "calling_b2_environment_values": dict(calling_environment["values"]),\n',
    ),
    (
        "skip-rollback-disarm-guard", PROFILE,
        "    armed = [switch for switch, values in observed.items() if values not in ([], [CALLING_B2_DISARMED_VALUE])]\n",
        "    armed = []\n",
    ),
    (
        "skip-guard-in-rollback-transaction", PROFILE,
        '    _assert_calling_b2_disarmed(core, gravity)\n    mutated = kind != "PREDECESSOR_PAIR"\n',
        '    mutated = kind != "PREDECESSOR_PAIR"\n',
    ),
    (
        "skip-guard-before-rollback-intent", PROFILE,
        "        # release state is left exactly as found until a separate disarm is authorized.\n        _assert_calling_b2_disarmed(core, gravity)\n",
        "        # release state is left exactly as found until a separate disarm is authorized.\n",
    ),
    (
        "skip-guard-before-mixed-preflight-intent", PROFILE,
        "            # Refused before any intent is written, so an armed state is left exactly as found.\n            _assert_calling_b2_disarmed(core, gravity)\n",
        "            # Refused before any intent is written, so an armed state is left exactly as found.\n",
    ),
    (
        "skip-guard-before-mixed-activate-intent", PROFILE,
        '        if pair_state == "MIXED_KNOWN":\n            _assert_calling_b2_disarmed(core, gravity)\n',
        '        if pair_state == "MIXED_KNOWN":\n',
    ),
    (
        "guard-unbound-from-container-id", PROFILE,
        "    if raw.get(\"Id\") != container_id or not isinstance(environment, list):\n",
        "    if not isinstance(environment, list):\n",
    ),
    (
        "guard-only-as-strict-as-exact-true", PROFILE,
        "    armed = [switch for switch, values in observed.items() if values not in ([], [CALLING_B2_DISARMED_VALUE])]\n",
        '    armed = [switch for switch, values in observed.items() if "true" in values]\n',
    ),
    (
        "accept-live-mode-true", PROFILE,
        "        if normalized in observed:\n",
        '        if normalized in observed and normalized != "AI_CALL_LIVE_MODE":\n',
    ),
    (
        "accept-controlled-real-call-true", PROFILE,
        "        if normalized in observed:\n",
        '        if normalized in observed and normalized != "AI_CALL_CONTROLLED_REAL_CALL_ENABLED":\n',
    ),
    (
        "attach-env-on-rollback", PROFILE,
        '        if not activate:\n            return ""\n        sources = [RELEASE_ENVIRONMENT_SOURCES[service]]\n',
        "        sources = [RELEASE_ENVIRONMENT_SOURCES[service]]\n",
    ),
    (
        "accept-calling-names-after-rollback", PROFILE,
        '        raise core.RuntimeFault("ROLLBACK_CALLING_B2_ENVIRONMENT_PRESENT", 74)\n',
        "        pass\n",
    ),
    (
        "allow-migration-command-in-render", PROFILE,
        '            if actual.get("command") != ["npm", "run", "start"]:\n',
        '            if actual.get("command") not in (["npm", "run", "start"], ["sh", "-c", "npx prisma migrate deploy && npm run start"]):\n',
    ),
    (
        "allow-migration-command-after-activation", PROFILE,
        '        if gravity["semantic"].get("command") != ["npm", "run", "start"] or',
        '        if gravity["semantic"].get("command") not in (["npm", "run", "start"], ["sh", "-c", "npx prisma migrate deploy && npm run start"]) or',
    ),
    (
        "overlay-runs-migration-command", PROFILE,
        '    command = "    command: [\\"npm\\", \\"run\\", \\"start\\"]\\n" if activate else ""\n',
        '    command = "    command: [\\"sh\\", \\"-c\\", \\"npx prisma migrate deploy && npm run start\\"]\\n" if activate else ""\n',
    ),
    (
        "enable-database-migrate", PROFILE,
        '    if invocation.primitive == "rollback":\n        return _rollback(core, policy, profile, invocation)\n',
        '    if invocation.primitive == "rollback":\n        return _rollback(core, policy, profile, invocation)\n    if invocation.primitive == "database-migrate":\n        return {"migrated": True}\n',
    ),
    (
        "sealer-accepts-unbound-capability", "packaging/seal-release.py",
        "    assert_calling_b2_bound()\n    parser = argparse.ArgumentParser()\n",
        "    parser = argparse.ArgumentParser()\n",
    ),
    (
        "sealer-accepts-v17-application", "packaging/seal-release.py",
        '        or APPLICATION_COMMIT == CALLING_B2_UNBOUND_IDENTITIES["application_commit"]\n',
        "",
    ),
    (
        "sealer-accepts-v17-package-version", "packaging/seal-release.py",
        '        or versions[0] == CALLING_B2_UNBOUND_IDENTITIES["package_version"]\n',
        "",
    ),
    (
        "verifier-accepts-unbound-capability", "packaging/verify-sealed-inputs.py",
        '    assert_calling_b2_bound(sealed, load(GENERATED / "profile.v1.json"))\n',
        "",
    ),
    (
        "verifier-ignores-generated-profile-identity", "packaging/verify-sealed-inputs.py",
        "        declared[0] != declared[1]\n        or any(",
        "        any(",
    ),
    (
        "verifier-accepts-omitted-identity", "packaging/verify-sealed-inputs.py",
        "        or any(not isinstance(value, str) or not value for value in declared[0])\n",
        "",
    ),
    (
        "target-recovery-refusal-audited-as-plain-failure", PROFILE,
        '"target_postcheck_failed" if refusal is None else "target_postcheck_failed_rollback_refused_calling_b2",',
        '"target_postcheck_failed",',
    ),
    (
        "automatic-rollback-intent-despite-armed-guard", PROFILE,
        '            if refusal is not None:\n                _audit(core, invocation, state, "failed_rollback_refused_calling_b2", failed_state)\n',
        '            if False:\n                _audit(core, invocation, state, "failed_rollback_refused_calling_b2", failed_state)\n',
    ),
    (
        "target-recovery-rollback-intent-despite-armed-guard", PROFILE,
        "                    failed_state,\n                )\n                if refusal is not None:\n",
        "                    failed_state,\n                )\n                if False:\n",
    ),
    (
        "armed-activated-recheck-downgrades-state", PROFILE,
        '                if refusal is not None and state.get("phase") == "ACTIVATED":\n',
        '                if False:\n',
    ),
)


def copy_builder(destination: Path) -> None:
    for name in ("templates", "src", "tests", "packaging"):
        shutil.copytree(ROOT / name, destination / name, ignore=shutil.ignore_patterns("__pycache__"))


def run_suites(builder: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-B", "-m", "unittest", *SUITES],
        cwd=builder / "tests",
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )


def run_mutant(mutant: tuple[str, str, str, str]) -> tuple[str, int, int]:
    """Return (identifier, occurrences of the mutation site, suite exit status)."""
    identifier, relative, original, weakened = mutant
    with tempfile.TemporaryDirectory() as raw:
        builder = Path(raw)
        copy_builder(builder)
        target = builder / relative
        text = target.read_text(encoding="ascii")
        occurrences = text.count(original)
        if occurrences != 1:
            return identifier, occurrences, 0
        target.write_text(text.replace(original, weakened), encoding="ascii")
        return identifier, occurrences, run_suites(builder).returncode


class CallingB2MutationTests(unittest.TestCase):
    def test_unmutated_copy_passes_so_every_failure_is_the_mutant(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            builder = Path(raw)
            copy_builder(builder)
            completed = run_suites(builder)
        self.assertEqual(completed.returncode, 0, completed.stderr[-2000:])

    def test_every_weakening_mutant_is_caught(self) -> None:
        identifiers = [mutant[0] for mutant in MUTANTS]
        self.assertEqual(len(identifiers), len(set(identifiers)))
        with ThreadPoolExecutor(max_workers=max(1, min(4, os.cpu_count() or 1))) as pool:
            results = list(pool.map(run_mutant, MUTANTS))
        survived = []
        for identifier, occurrences, status in results:
            with self.subTest(mutant=identifier):
                self.assertEqual(occurrences, 1, f"{identifier}: mutation site is not unique")
                self.assertNotEqual(status, 0, f"{identifier} survived")
            if occurrences == 1 and status == 0:
                survived.append(identifier)
        self.assertEqual(survived, [])

if __name__ == "__main__":
    unittest.main()
