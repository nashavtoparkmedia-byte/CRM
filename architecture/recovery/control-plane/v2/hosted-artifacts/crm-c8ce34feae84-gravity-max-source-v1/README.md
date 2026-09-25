# Hosted coordinated Gravity + MAX artifact — Stage A

This directory is the bounded Stage A release-builder authority for the
Messaging MAX DOM-fallback inbound repair: application commit
`c8ce34feae84e5674357df496be37d0cd8a457bb` (tree
`6a1051c3fff1147090b7c3e37310e149a811ac80`) and coordinated profile
`crm-c8ce34feae84-gravity-max-source-v1`. It was derived from the
`crm-fb9fb30d9eb2-gravity-max-source-v1` authority, which is not modified.

**The repair base is not an accepted release.** This candidate's pull request
base and blast base are `fb9fb30d9eb221a04342fe0ef7324f78d8ff7576`, the
Messaging outbound-chatType candidate whose production acceptance FAILED on
2026-09-22: its first real inbound arrived through the MAX scraper's DOM
fallback, which carries no `senderId`, the per-event sender guard rejected it
with `409 sender_identity_unproven`, and the window was rolled back. That commit
is used here only as the exact technical source base of this repair delta
(`REPAIR_BASE_*`, `REPAIR_BASE_PRODUCTION_ACCEPTED = False`). The last release
whose production acceptance succeeded remains `be6b8eb8`, which stays the
`BASELINE_*` authority and supplies its own main-push proof. Trust for this
candidate comes from exact source provenance, the fresh hosted proof for
`c8ce34fe`, the accepted `be6b8eb8` predecessor lineage, and the repair's own
verification — never from treating `fb9fb30d` as accepted.

This repair changes both components, so it is a coordinated pair release by
necessity: Gravity alone still rejects every DOM-fallback inbound, because it
only accepts one that carries the MAX scraper's new page attestation.

It can build, attest, and verify one hosted artifact containing the accepted
Gravity and MAX scraper images. It is not a Runtime package, installer,
activation profile, rollback implementation, production snapshot, or deploy
capability. The application checkout is fixed independently from the release
builder checkout; there is no application-ref input.

## Bounded pull_request source authority

Every predecessor authority requires its source run to be a `push` of
`architecture-enforcement.yml`, which only happens on `main`. This repair is
intentionally released from its exact repair base instead of the moving `main`,
so its source run is a `pull_request` run. The Orchestrator authorized exactly
one such tuple, and this contract trusts nothing else:

| Member | Exact value |
|---|---|
| Repository | `nashavtoparkmedia-byte/CRM` (id `1183669136`), head repository the same, not a fork |
| Event | `pull_request` |
| Run | `36112089398` (Architecture enforcement #204), attempt 1, workflow `334421867`, completed/success |
| Pull request | #121 (id `4635810301`), draft, same-repository |
| Head | `codex/messaging-max-dom-fallback-topology-repair-20260924` at `c8ce34feae84e5674357df496be37d0cd8a457bb`, tree `a5a86806…` |
| Base (repair base, NOT accepted) | `release/messaging-topology-repair-base-fb9fb30d-20260925` at `fb9fb30d9eb221a04342fe0ef7324f78d8ff7576` |
| Blast base in the proof | `fb9fb30d9eb221a04342fe0ef7324f78d8ff7576` |
| Architecture job | `107997632832`, completed/success |
| Proof artifact | `10861950505`, `authoritative-ci-proof-fb9fb30d…`, 5766 bytes, `sha256:a59e2830…`, bound to run `36112089398` on the head branch |
| Workflow / runner | `7acd3668…` / `e8738068…`, 53 controls, catalog `f6271d9c…`, semantic `57f68431…` |

The baseline is linked explicitly. Its own main-push authority must also verify:
run `34984925377` (push, `main`, `be6b8eb8`, success), architecture job
`104434459318`, proof artifact `10411840982` (`sha256:94c87f50…`), and a proof
for `be6b8eb8`/`8fc34b11` with blast base `016669a1`. The application checkout
must carry the exact single-parent lineage pinned in `APPLICATION_LINEAGE` —
`c8ce34fe` → `a9cceca3` → `606dcbea` → `7e5fb75f` → `0fb7421c` → `7b215676` →
`427fae16` → repair base `fb9fb30d` → `cf070e98` → … → `c7e29a24` → `738496cd` →
baseline `be6b8eb8` — so the proof's blast base is the pull request base seven
commits back, and the accepted baseline is nine further commits below it.

The source evidence directory therefore has eight members: `run.json`,
`jobs.json`, `artifact.json`, `authoritative-ci-execution.json`, and the same
four prefixed with `baseline-`. A Stage B sealer must supply all eight. The
GitHub run documents are captured live, and a live run lists its pull request
only while that pull request is open. So PR #121 has to stay open (draft state does not affect this) and its base
branch unmoved until every consumer has verified. Any change makes verification
fail closed, never widen.

The authoritative Stage A control validates the immutable builder change from
base `c8ce34feae84e5674357df496be37d0cd8a457bb` to the builder commit pinned in
`tests/test_stage_a_contract.py`. That change may only add this directory and
`.github/workflows/coordinated-gravity-max-c8ce34fe.yml`, and point
`tools/architecture/test-hosted-coordinated-gravity-max-stage-a.mjs` at them.

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
in both fields. Layer inspection accepts POSIX filenames for the fixed
`linux/amd64` image, including literal backslashes used by systemd unit
filenames, while continuing to reject absolute paths, parent traversal, and
normalized duplicates. It also accepts only the canonical zero-byte `.`
directory marker emitted by the pinned base image for a layer root and rejects
that marker as any other member type. Outer Docker archive path validation
remains cross-platform and rejects backslashes fail-closed.

The post-upload GitHub artifact ID, digest, and byte size are an external
transport identity recorded by the workflow after upload; they cannot be
embedded in the artifact without creating a circular digest. A later Stage B
sealer must authenticate that external identity before invoking this content
verifier. The authenticated client has a fixed 512 MiB download limit, so the
hosted job also downloads that exact ZIP through its ephemeral read-only
`GITHUB_TOKEN`, verifies its recorded byte size and SHA-256 digest, and emits
ten fixed 500 MiB-or-smaller transport shards plus a canonical chunk manifest.
The transport runs in a fresh dependent runner job, and a fail-closed capacity
preflight requires the exact source byte count plus a fixed 4 GiB reserve
before any shard is written. An independent verifier reconstructs the original
ZIP digest before the shards are uploaded. Uploads use explicit replacement so
a failed partial run can be rerun without retaining a mixed shard inventory;
the final exact registry check has a bounded consistency retry. Each shard is a
short-lived Actions artifact whose external identity and size are checked after
upload. These shards are authenticated transport only: they are not another
release artifact and grant no release or production authority. This Stage A
capability does not implement the Stage B sealer.

Stage A creates exactly these artifact members:

- `gravity-image.docker.tar`
- `gravity-image-attestation.json`
- `max-scraper-image.docker.tar`
- `max-scraper-image-attestation.json`
- `coordinated-release-manifest.json`
- `authoritative-ci-execution.json`

No file in this directory authorizes production mutation or live MAX traffic.
