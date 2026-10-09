# Hosted coordinated Gravity + MAX artifact — Stage A (MAIN_FIRST_PARENT, TARGET LOCK)

This directory is the bounded Stage A release-builder authority for a
current-main target: application commit
`effcbf6da378dd95515a19c5e0fa48703cdb4348` (tree
`7ce42906256d8e240d43e0d3b6dff9ec165ccbfe`) and coordinated profile
`crm-effcbf6da378-gravity-max-source-v1`. It was derived from the
`crm-10318827e484-gravity-max-source-v1` authority, which is not modified, and
it is the first authority that uses the `MAIN_FIRST_PARENT` source-lineage
model. It is the binding Stage A authority for PRODUCTION CONVERGENCE 2.0.0-23
TARGET LOCK `effcbf6d` (final authoritative release sweep CLEAN 2026-10-09), derived
mechanically from the locally verified and adversarially reviewed MAIN_FIRST_PARENT
rehearsal commit `2ff8bbfd` (preserved on origin).

**The target is a normal main landing, not a PR repair delta.** `effcbf6d` is
the GitHub merge of PR #166 onto main. Its first parent `8a7946b0` is the main
tip the landing merged onto, which is also the blast base the main push run
recorded in its execution proof. The accepted predecessor authority
(`46e61071`, profile `crm-10318827e484-…`) is bound separately to its own
application `10318827` on the production repair lineage; that commit is NOT an
ancestor of this target, and the contract requires the single merge base of
`effcbf6d` and `10318827` to be exactly the accepted main anchor `be6b8eb8`.
The last release whose production acceptance succeeded remains `be6b8eb8`,
which stays the `BASELINE_*` authority, is the `MAIN_ANCHOR_*` of the chain,
and supplies its own main-push proof. Trust for this candidate comes from exact
source provenance, the fresh hosted proof for `effcbf6d`, the accepted
`be6b8eb8` anchor, the accepted predecessor authority by digest, and the
explicitly pinned first-parent chain — never from treating any intermediate
main commit as accepted.

Unlike the predecessor, this target changes BOTH components relative to it:
`GRAVITY_SUBTREE` is `33ddcb75` and `MAX_SUBTREE` is `9fde27e1`, so both halves
of the pair carry new bytes and the coordinated MAX image is a real rebuild.

It can build, attest, and verify one hosted artifact containing the accepted
Gravity and MAX scraper images. It is not a Runtime package, installer,
activation profile, rollback implementation, production snapshot, or deploy
capability. The application checkout is fixed independently from the release
builder checkout; there is no application-ref input.

## Bounded main-push source authority (`SOURCE_LINEAGE_MODEL = "MAIN_FIRST_PARENT"`)

Every push-model predecessor authority requires its source run to be a `push`
of `architecture-enforcement.yml` on `main`. This authority returns to that
rule for a target that is itself a main commit, and it trusts exactly one such
tuple:

| Member | Exact value |
|---|---|
| Repository | `nashavtoparkmedia-byte/CRM` (id `1183669136`), head repository the same, not a fork |
| Event | `push` on `main`; `pull_requests` must be present and empty |
| Run | `37954364517` (Architecture enforcement #306), attempt 1, workflow `334421867`, completed/success |
| Head | `main` at `effcbf6da378dd95515a19c5e0fa48703cdb4348`, tree `7ce42906…` |
| First parent / blast base in the proof | `8a7946b01427df42a26cf586ab008f533dfffa38` |
| Architecture job | `113900982427`, completed/success |
| Proof artifact | `11635047196`, `authoritative-ci-proof-effcbf6d…`, 5766 bytes, `sha256:b7322faf…`, bound to run `37954364517` on `main` |
| Workflow / runner | `7acd3668…` / `e8738068…`, 53 controls, catalog `f6271d9c…`, semantic `57f68431…` |

The baseline is linked explicitly. Its own main-push authority must also verify:
run `34984925377` (push, `main`, `be6b8eb8`, success), architecture job
`104434459318`, proof artifact `10411840982` (`sha256:94c87f50…`), and a proof
for `be6b8eb8`/`8fc34b11` with blast base `016669a1`.

The application checkout must carry the exact first-parent chain pinned in
`APPLICATION_LINEAGE`: 36 commits from `effcbf6d` down to `4abc73f2`, whose
first parent is the anchor `be6b8eb8`. Every chain entry is pinned explicitly,
must be a one- or two-parent commit (octopus merges are rejected), and its
FIRST parent must be the next pinned entry, so a moving main tip, a skipped or
substituted commit, or a chain of equal length cannot stand in for the target.
The chain is the first-parent walk `HEAD~1 … HEAD~36` the workflow re-asserts;
the application checkout is a full clone because the merge-base guard against
`10318827` needs the production repair lineage in the same checkout. Any other
value of `SOURCE_LINEAGE_MODEL` fails closed, and the PR-model authorities are
untouched: the accepted predecessor keeps its own pull_request tuple, proved
here only by exact commit and content digest.

The source evidence directory therefore has eight members: `run.json`,
`jobs.json`, `artifact.json`, `authoritative-ci-execution.json`, and the same
four prefixed with `baseline-`. A Stage B sealer must supply all eight. The
GitHub run documents are captured live; a main push run carries no pull
request, so nothing has to stay open for the capture to reproduce. Any change
makes verification fail closed, never widen.

The authoritative Stage A control validates the immutable builder change from
base `effcbf6da378dd95515a19c5e0fa48703cdb4348` to the builder commit pinned in
`tests/test_stage_a_contract.py`. That change may only add this directory and
`.github/workflows/coordinated-gravity-max-effcbf6d.yml`, and point
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
