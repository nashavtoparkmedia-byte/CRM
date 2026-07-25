from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import tarfile


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_blob(archive: tarfile.TarFile, digest: str) -> bytes:
    algorithm, value = digest.split(":", 1)
    if algorithm != "sha256":
        raise RuntimeError(f"unsupported OCI digest: {digest}")
    member = archive.getmember(f"blobs/sha256/{value}")
    source = archive.extractfile(member)
    if source is None:
        raise RuntimeError(f"OCI blob is not a regular file: {digest}")
    data = source.read()
    if sha256(data) != value:
        raise RuntimeError(f"OCI blob checksum mismatch: {digest}")
    return data


def load_json_blob(archive: tarfile.TarFile, digest: str) -> dict:
    return json.loads(read_blob(archive, digest))


def main(archive_path: str, output_directory: str) -> int:
    output = Path(output_directory)
    output.mkdir(parents=True, exist_ok=True)
    written: dict[str, dict[str, object]] = {}

    with tarfile.open(archive_path, "r") as archive:
        index_file = archive.extractfile("index.json")
        if index_file is None:
            raise RuntimeError("OCI archive has no index.json")
        root_index = json.load(index_file)
        root_descriptor = root_index["manifests"][0]
        image_index_digest = root_descriptor["digest"]
        image_index = load_json_blob(archive, image_index_digest)

        attestation_descriptors = [
            descriptor
            for descriptor in image_index.get("manifests", [])
            if descriptor.get("annotations", {}).get("vnd.docker.reference.type")
            == "attestation-manifest"
        ]
        if len(attestation_descriptors) != 1:
            raise RuntimeError(f"expected one attestation manifest, got {len(attestation_descriptors)}")

        attestation_manifest = load_json_blob(archive, attestation_descriptors[0]["digest"])
        for layer in attestation_manifest.get("layers", []):
            predicate_type = layer.get("annotations", {}).get("in-toto.io/predicate-type")
            filename = {
                "https://spdx.dev/Document": "sbom.spdx.in-toto.json",
                "https://slsa.dev/provenance/v1": "slsa-provenance.in-toto.json",
            }.get(predicate_type)
            if not filename:
                continue
            data = read_blob(archive, layer["digest"])
            destination = output / filename
            destination.write_bytes(data)
            written[filename] = {
                "bytes": len(data),
                "sha256": sha256(data),
                "oci_digest": layer["digest"],
            }

    expected = {"sbom.spdx.in-toto.json", "slsa-provenance.in-toto.json"}
    if set(written) != expected:
        raise RuntimeError(f"missing attestations: {sorted(expected - set(written))}")

    result = {
        "image_index_digest": image_index_digest,
        "attestations": written,
    }
    print(f"YOKO_OCI_ATTESTATIONS {json.dumps(result, sort_keys=True)}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: extract-oci-attestations.py OCI_ARCHIVE OUTPUT_DIRECTORY")
    raise SystemExit(main(sys.argv[1], sys.argv[2]))
