#!/usr/bin/env python3
"""Thirty offline cases for the Stage B PostgreSQL trust chain."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
SCRIPT = (ROOT / "production-migration.sh").read_text(encoding="utf-8")
SCHEMA = json.loads((ROOT / "report-schema.json").read_text(encoding="utf-8"))
SPEC = importlib.util.spec_from_file_location(
    "postgres_database_url", ROOT / "postgres-database-url.py"
)
assert SPEC is not None and SPEC.loader is not None
BINDING = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BINDING)


def document(*entries: object) -> list[dict[str, object]]:
    return [{"Config": {"Env": list(entries)}}]


VALID = document(
    "POSTGRES_USER=app_user",
    "POSTGRES_PASSWORD=correct horse battery staple",
    "POSTGRES_DB=crm",
    "UNRELATED=value",
)


class PostgresBindingCases(unittest.TestCase):
    def test_01_valid_exact_keys(self) -> None:
        self.assertEqual(
            BINDING.extract_credentials(VALID),
            {
                "POSTGRES_USER": "app_user",
                "POSTGRES_PASSWORD": "correct horse battery staple",
                "POSTGRES_DB": "crm",
            },
        )

    def test_02_missing_user_refused(self) -> None:
        with self.assertRaises(BINDING.BindingError):
            BINDING.extract_credentials(document("POSTGRES_PASSWORD=p", "POSTGRES_DB=d"))

    def test_03_missing_password_refused(self) -> None:
        with self.assertRaises(BINDING.BindingError):
            BINDING.extract_credentials(document("POSTGRES_USER=u", "POSTGRES_DB=d"))

    def test_04_missing_database_refused(self) -> None:
        with self.assertRaises(BINDING.BindingError):
            BINDING.extract_credentials(document("POSTGRES_USER=u", "POSTGRES_PASSWORD=p"))

    def test_05_duplicate_key_refused(self) -> None:
        with self.assertRaises(BINDING.BindingError):
            BINDING.extract_credentials(
                document("POSTGRES_USER=u", "POSTGRES_USER=v", "POSTGRES_PASSWORD=p", "POSTGRES_DB=d")
            )

    def test_06_empty_value_refused(self) -> None:
        with self.assertRaises(BINDING.BindingError):
            BINDING.extract_credentials(
                document("POSTGRES_USER=u", "POSTGRES_PASSWORD=", "POSTGRES_DB=d")
            )

    def test_07_newline_refused(self) -> None:
        with self.assertRaises(BINDING.BindingError):
            BINDING.extract_credentials(
                document("POSTGRES_USER=u", "POSTGRES_PASSWORD=p\nq", "POSTGRES_DB=d")
            )

    def test_08_carriage_return_refused(self) -> None:
        with self.assertRaises(BINDING.BindingError):
            BINDING.extract_credentials(
                document("POSTGRES_USER=u", "POSTGRES_PASSWORD=p\rq", "POSTGRES_DB=d")
            )

    def test_09_nul_refused(self) -> None:
        with self.assertRaises(BINDING.BindingError):
            BINDING.extract_credentials(
                document("POSTGRES_USER=u", "POSTGRES_PASSWORD=p\x00q", "POSTGRES_DB=d")
            )

    def test_10_non_string_environment_entry_refused(self) -> None:
        with self.assertRaises(BINDING.BindingError):
            BINDING.extract_credentials(
                document("POSTGRES_USER=u", "POSTGRES_PASSWORD=p", "POSTGRES_DB=d", 7)
            )

    def test_11_inspect_cardinality_refused(self) -> None:
        with self.assertRaises(BINDING.BindingError):
            BINDING.extract_credentials([])
        with self.assertRaises(BINDING.BindingError):
            BINDING.extract_credentials(VALID + VALID)

    def test_12_reserved_characters_percent_encoded(self) -> None:
        line = BINDING.database_url_line(
            document("POSTGRES_USER=u/@", "POSTGRES_PASSWORD=p:#?[]%", "POSTGRES_DB=d/name")
        ).decode()
        self.assertEqual(
            line,
            "DATABASE_URL=postgresql://u%2F%40:p%3A%23%3F%5B%5D%25@postgres:5432/d%2Fname?schema=public\n",
        )

    def test_13_unicode_percent_encoded(self) -> None:
        line = BINDING.database_url_line(
            document("POSTGRES_USER=юзер", "POSTGRES_PASSWORD=пароль", "POSTGRES_DB=база")
        ).decode("ascii")
        self.assertIn("%D1%8E%D0%B7%D0%B5%D1%80", line)
        self.assertNotIn("юзер", line)

    def test_14_fixed_network_authority(self) -> None:
        line = BINDING.database_url_line(VALID).decode()
        self.assertIn("@postgres:5432/crm?schema=public", line)
        self.assertNotIn("localhost", line)

    def test_15_env_file_mode_is_0600(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "migration.env"
            BINDING.write_env_file(VALID, output, os.getuid(), os.getgid())
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertEqual(output.read_bytes(), BINDING.database_url_line(VALID))

    def test_16_env_file_no_clobber(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "migration.env"
            output.write_text("sentinel", encoding="utf-8")
            with self.assertRaises(FileExistsError):
                BINDING.write_env_file(VALID, output, os.getuid(), os.getgid())
            self.assertEqual(output.read_text(encoding="utf-8"), "sentinel")

    def test_17_partial_env_file_removed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "migration.env"
            with mock.patch.object(BINDING.os, "write", return_value=0):
                with self.assertRaises(BINDING.BindingError):
                    BINDING.write_env_file(VALID, output, os.getuid(), os.getgid())
            self.assertFalse(output.exists())

    def test_18_binding_library_stdout_silent(self) -> None:
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            BINDING.database_url_line(VALID)
        self.assertEqual(stream.getvalue(), "")

    def test_19_binding_library_stderr_silent(self) -> None:
        stream = io.StringIO()
        with contextlib.redirect_stderr(stream):
            with self.assertRaises(BINDING.BindingError):
                BINDING.extract_credentials([])
        self.assertEqual(stream.getvalue(), "")

    def test_20_exact_postgres_label_discovery(self) -> None:
        self.assertIn("docker ps -aq --no-trunc", SCRIPT)
        self.assertIn('PROJECT_LABEL=\'com.docker.compose.project=crm\'', SCRIPT)
        self.assertIn('POSTGRES_LABEL=\'com.docker.compose.service=postgres\'', SCRIPT)

    def test_21_discovery_cardinality_and_state_classifications(self) -> None:
        for classification in (
            "POSTGRES_CONTAINER_MISSING",
            "POSTGRES_CONTAINER_MULTIPLE",
            "POSTGRES_CONTAINER_NOT_RUNNING",
        ):
            self.assertIn(classification, SCRIPT)

    def test_22_image_mismatch_classified(self) -> None:
        self.assertIn("POSTGRES_CONTAINER_IMAGE_MISMATCH", SCRIPT)
        self.assertIn('postgres_image != "$POSTGRES_IMAGE_ID"', SCRIPT)

    def test_23_full_inspect_is_root_only(self) -> None:
        self.assertIn('docker inspect "$POSTGRES_ID"', SCRIPT)
        self.assertIn("capture_to_new_root_file", SCRIPT)
        self.assertIn("0:0:600", SCRIPT)

    def test_24_network_labels_are_fenced(self) -> None:
        self.assertIn('.Labels["com.docker.compose.project"]=="crm"', SCRIPT)
        self.assertIn('.Labels["com.docker.compose.network"]=="crm_internal"', SCRIPT)
        self.assertIn("POSTGRES_NETWORK_IDENTITY_MISMATCH", SCRIPT)

    def test_25_postgres_alias_is_required(self) -> None:
        self.assertIn('index("postgres")', SCRIPT)
        self.assertIn("POSTGRES_NETWORK_ALIAS_MISSING", SCRIPT)

    def test_26_single_postgres_network_is_required(self) -> None:
        self.assertIn('${#networks[@]} != 1', SCRIPT)
        self.assertIn('NETWORK_NAME=${networks[0]}', SCRIPT)

    def test_27_runners_receive_only_selected_network(self) -> None:
        self.assertEqual(SCRIPT.count('--network "$NETWORK_NAME"'), 2)
        self.assertNotIn("--network host", SCRIPT)
        self.assertNotIn("--publish", SCRIPT)
        self.assertNotIn(" -p ", SCRIPT)

    def test_28_postgres_identity_is_repeatedly_fenced(self) -> None:
        self.assertGreaterEqual(SCRIPT.count("assert_postgres_identity"), 8)
        self.assertIn("POSTGRES_CONTAINER_IDENTITY_CHANGED", SCRIPT)

    def test_29_credential_workspace_cleanup_is_bounded(self) -> None:
        self.assertIn("^/var/tmp/personal-max-stage8b2a\\.[A-Za-z0-9]{8}$", SCRIPT)
        self.assertIn("rm -rf --one-file-system", SCRIPT)
        self.assertIn("timeout --signal=TERM --kill-after=5s 30s", SCRIPT)

    def test_30_old_sources_host_env_and_credential_argv_absent(self) -> None:
        forbidden = ("grav" + "ity", "tg" + "-" + "bot", "." + "env" + "." + "production")
        for path in ROOT.iterdir():
            if path.is_file() and path.name != Path(__file__).name:
                content = path.read_text(encoding="utf-8", errors="ignore").lower()
                for value in forbidden:
                    self.assertNotIn(value, content)
        invocation = 'python3 "$DATABASE_URL_HELPER" "$POSTGRES_INSPECT_JSON" "$MIGRATION_ENV"'
        self.assertIn(invocation, SCRIPT)
        self.assertNotIn('python3 "$DATABASE_URL_HELPER" "$POSTGRES_USER"', SCRIPT)
        success_schema = SCHEMA["oneOf"][0]
        self.assertIn("databaseBinding", success_schema["required"])
        self.assertNotIn("credentials", success_schema["properties"]["databaseBinding"]["required"])


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PostgresBindingCases)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.wasSuccessful() and result.testsRun == 30:
        print("STAGE_B_POSTGRES_BINDING_CASES=30")
        raise SystemExit(0)
    raise SystemExit(1)
