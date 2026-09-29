# Hosted coordinated Gravity + MAX artifact — Stage A

This directory is the bounded Stage A release-builder authority for the
Messaging MAX cold-cache repair: application commit
`3efe02166accbf79cf0a44b2c688ea03d3021c17` (tree
`68ce2bb0219bd92f969d42f0f904f975e69d7081`) and coordinated profile
`crm-3efe02166acc-gravity-max-source-v1`. It was derived from the
`crm-ba90ed4b6717-gravity-max-source-v1` authority, which is not modified.

**The repair base is not an accepted release.** This candidate's pull request
base and blast base are `ba90ed4b6717efb269b5e25fdf551cd82b99f335`, the
Messaging DOM-fallback topology candidate whose production acceptance FAILED on
2026-09-26: its first real inbound arrived through the MAX scraper's DOM
fallback carrying `chatKind: unknown`, because the scraper derives that value
from a cache that is empty after the restart activation performs, the peer proof
refused it at `incoming_chat_kind` with `409 MAX_SENDER_IDENTITY_UNPROVEN`, and
the window was rolled back. That commit is used here only as the exact technical
source base of this repair delta (`REPAIR_BASE_*`,
`REPAIR_BASE_PRODUCTION_ACCEPTED = False`). The last release whose production
acceptance succeeded remains `be6b8eb8`, which stays the `BASELINE_*` authority
and supplies its own main-push proof. Trust for this candidate comes from exact
source provenance, the fresh hosted proof for `3efe0216`, the accepted
`be6b8eb8` predecessor lineage, and the repair's own verification — never from
treating `ba90ed4b` as accepted.

Unlike the repair base, this repair changes BOTH components: `MAX_SUBTREE` moves
from `44e64cdf` to `40350ce0`, because the scraper's DOM-recovery queue no longer
commits a candidate as seen before the CRM accepts it and no longer hands one
pending provider id to more than one candidate. So the coordinated MAX image is a
real rebuild here, not a relabel of the repair base's, and both halves of the pair
carry new bytes. That is also why the pair must stay coordinated: the Gravity
route change that admits `live_dom_recovery` into the bounded peer proof and the
scraper change that stops one refusal wedging a chat are only correct together.

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
| Run | `36513248121` (Architecture enforcement #240), attempt 1, workflow `334421867`, completed/success |
| Pull request | #131 (id `4671777338`), draft, same-repository |
| Head | `codex/messaging-max-dom-fallback-cold-cache-repair-20260926` at `3efe02166accbf79cf0a44b2c688ea03d3021c17`, tree `9ce54751…` |
| Base (repair base, NOT accepted) | `release/messaging-max-inbound-base-ba90ed4b-20260929` at `ba90ed4b6717efb269b5e25fdf551cd82b99f335` |
| Blast base in the proof | `ba90ed4b6717efb269b5e25fdf551cd82b99f335` |
| Architecture job | `109229813149`, completed/success |
| Proof artifact | `11014424878`, `authoritative-ci-proof-3efe0216…`, 5766 bytes, `sha256:5ba3e1af…`, bound to run `36513248121` on the head branch |
| Workflow / runner | `7acd3668…` / `e8738068…`, 53 controls, catalog `f6271d9c…`, semantic `57f68431…` |

The baseline is linked explicitly. Its own main-push authority must also verify:
run `34984925377` (push, `main`, `be6b8eb8`, success), architecture job
`104434459318`, proof artifact `10411840982` (`sha256:94c87f50…`), and a proof
for `be6b8eb8`/`8fc34b11` with blast base `016669a1`. The application checkout
must carry the exact single-parent lineage pinned in `APPLICATION_LINEAGE` —
`3efe0216` → `7d8e5f99` → `9331c290` → `fb6d34ba` → `27ef6095` → `5e36bf69` →
`94670bec` → repair base `ba90ed4b` → `a9cceca3` → … → `fb9fb30d` → … →
baseline `be6b8eb8` — so the proof's blast base is the pull request base seven
commits back, and the accepted baseline lies further below it.

The source evidence directory therefore has eight members: `run.json`,
`jobs.json`, `artifact.json`, `authoritative-ci-execution.json`, and the same
four prefixed with `baseline-`. A Stage B sealer must supply all eight. The
GitHub run documents are captured live, and a live run lists its pull request
only while that pull request is open. So PR #131 has to stay open (draft state does not affect this) and its base
branch unmoved until every consumer has verified. Any change makes verification
fail closed, never widen.

The authoritative Stage A control validates the immutable builder change from
base `ba90ed4b6717efb269b5e25fdf551cd82b99f335` to the builder commit pinned in
`tests/test_stage_a_contract.py`. That change may only add this directory and
`.github/workflows/coordinated-gravity-max-3efe0216.yml`, and point
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
