# Hosted coordinated Gravity + MAX artifact — Stage A

This directory is the bounded Stage A release-builder authority for application
commit `6e3f094bf4b42c1400c705843ab107dacd6d1cf8` and coordinated profile
`crm-6e3f094bf4b4-gravity-max-source-v1`.

It can build, attest, and verify one hosted artifact containing the accepted
Gravity and MAX scraper images. It is not a Runtime package, installer,
activation profile, rollback implementation, production snapshot, or deploy
capability. The application checkout is fixed independently from the release
builder checkout; there is no application-ref input.

The MAX release Dockerfile preserves the accepted `pwuser`, `/app`, Playwright,
`tini`, `node index.js`, healthcheck, environment, and `/app/user_data`
contracts. It copies only the runtime module graph. Accepted test, diagnostic,
screenshot, and other debug-only source remains outside the image. The pinned
Playwright linux/amd64 manifest is resolved from Microsoft Container Registry.
The only added OS package is the checksum-bound Ubuntu snapshot package
`tini_0.19.0-1_amd64.deb`; no mutable apt index is used.

The verifier requires the exact builder commit/tree/workflow identity plus the
fixed public GitHub run/job/artifact evidence. It rejects extra artifact
members, duplicate JSON keys, mixed component identities, and altered source,
builder, archive, label, platform, or build-material bindings. It parses each
Docker archive from the same no-follow descriptor used for hashing, validates
the complete layer/diff-ID graph and inner member allowlist, binds the rootfs
prefix to the pinned Node or Playwright config, checks the installed MAX Tini
binary extracted from the checksum-bound package, and proves the fixed runtime
source/filesystem contract from the merged image layers. For modern Docker
OCI-blob save archives it binds both the config image ID and the
runtime-visible containerd manifest ID; legacy archives bind the same config ID
in both fields. Layer inspection accepts only the canonical zero-byte `.`
directory marker emitted by the pinned base image for a layer root; it rejects
that marker as any other member type, rejects duplicates, and keeps traversal
and outer-archive path validation fail-closed.

The post-upload GitHub artifact ID, digest, and byte size are an external
transport identity recorded by the workflow after upload; they cannot be
embedded in the artifact without creating a circular digest. A later Stage B
sealer must authenticate that external identity before invoking this content
verifier. This Stage A capability does not implement that sealer.

Stage A creates exactly these artifact members:

- `gravity-image.docker.tar`
- `gravity-image-attestation.json`
- `max-scraper-image.docker.tar`
- `max-scraper-image-attestation.json`
- `coordinated-release-manifest.json`
- `authoritative-ci-execution.json`

No file in this directory authorizes production mutation or live MAX traffic.
