"""Verify the external GitHub identities of all bounded transport artifacts."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from coordinated_release_contract import strict_json_file  # noqa: E402
from hosted_artifact_transport import validate_hosted_transport_registry  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-inventory", required=True, type=Path)
    parser.add_argument("--source-identity", required=True, type=Path)
    parser.add_argument("--builder-commit", required=True)
    parser.add_argument("--run-id", required=True, type=int)
    args = parser.parse_args()
    inventory, _ = strict_json_file(args.artifact_inventory, "hosted transport artifact registry")
    source, _ = strict_json_file(args.source_identity, "hosted artifact identity")
    identities = validate_hosted_transport_registry(
        inventory,
        source,
        args.builder_commit,
        args.run_id,
    )
    sys.stdout.write(json.dumps({
        "status": "PASS",
        "builder_commit": args.builder_commit,
        "workflow_run_id": args.run_id,
        "artifacts": identities,
    }, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
