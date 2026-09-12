"""Independently verify exact chunk reconstruction for hosted handoff."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from coordinated_release_contract import strict_json_file  # noqa: E402
from hosted_artifact_transport import verify_transport  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--identity", required=True, type=Path)
    parser.add_argument("--transport-directory", required=True, type=Path)
    parser.add_argument("--builder-commit", required=True)
    parser.add_argument("--run-id", required=True, type=int)
    args = parser.parse_args()
    identity, _ = strict_json_file(args.identity, "hosted artifact identity")
    manifest = verify_transport(
        identity,
        args.transport_directory,
        args.builder_commit,
        args.run_id,
    )
    sys.stdout.write(json.dumps({
        "status": "PASS",
        "schema": manifest["schema"],
        "builder_commit": manifest["builder_commit"],
        "source_artifact": manifest["source_artifact"],
        "chunk_count": manifest["chunking"]["chunk_count"],
    }, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
