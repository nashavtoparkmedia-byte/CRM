"""Verify one exact coordinated Gravity + MAX Stage A artifact directory."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from coordinated_release_contract import ContractError, verify_artifact


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-directory", required=True, type=Path)
    parser.add_argument("--application-source", required=True, type=Path)
    parser.add_argument("--builder-source", required=True, type=Path)
    parser.add_argument("--source-authority-evidence", required=True, type=Path)
    parser.add_argument("--builder-commit", required=True)
    parser.add_argument("--builder-tree", required=True)
    args = parser.parse_args()
    result = verify_artifact(
        args.artifact_directory,
        args.application_source,
        args.builder_source,
        args.source_authority_evidence,
        args.builder_commit,
        args.builder_tree,
    )
    sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")


if __name__ == "__main__":
    try:
        main()
    except ContractError as exc:
        sys.stderr.write(f"coordinated artifact verification failed: {exc}\n")
        raise SystemExit(1)
