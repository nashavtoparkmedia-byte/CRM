# Hosted coordinated Gravity + MAX artifact — Stage A (MAIN_FIRST_PARENT, TARGET LOCK)

This directory is the bounded Stage A release-builder authority for a
current-main target: application commit
`4f3b6c0a9f19ded2d7867c8a11da396f6dc61543` (tree
`4d4d8193a78a894880a0d30415de07b3f72c1069`) and coordinated profile
`crm-4f3b6c0a9f19-gravity-max-source-v1`. It was derived from the
`crm-0829ae02f4cb-gravity-max-source-v1` authority (Runtime 2.0.0-24), which is
not modified, and it keeps the `MAIN_FIRST_PARENT` source-lineage model. It is
the Stage A candidate authority for Runtime 2.0.0-25 (Cash LIVE, MAIN `4f3b6c0a`
= PRs #173–#176 on top of the production release `0829ae02`), derived
mechanically from the accepted authority `a0b48412` and re-anchored on the
production-accepted `0829ae02`.

**The target is a normal main landing, not a PR repair delta.** `4f3b6c0a` is
the GitHub merge of PR #176 onto main. Its first parent `d7be4883` is the main
tip the landing merged onto, which is also the blast base the main push run
recorded in its execution proof. The accepted predecessor authority
(`a0b48412`, profile `crm-0829ae02f4cb-…`) binds its own application
`0829ae02`, the Runtime 2.0.0-24 release, which landed on main: it is at once
the predecessor application, the `MAIN_ANCHOR_*` of the chain and the
`BASELINE_*` authority, and the contract requires the single merge base of
`4f3b6c0a` and `0829ae02` to be exactly `0829ae02`. The baseline is the
predecessor authority's own accepted source tuple (run `39900558961`, proof
`12487917640`), which the contract cross-checks against the predecessor's
declared application commit, tree and proof-artifact digest. The predecessor's own
baseline (`effcbf6d`) is not referenced. Trust for this candidate comes from exact
source provenance, the fresh hosted proof for `4f3b6c0a`, the accepted
`0829ae02` anchor, the accepted predecessor authority by digest, and the
explicitly pinned first-parent chain — never from treating any intermediate
main commit as accepted.

Relative to the predecessor only Gravity source changed: `GRAVITY_SUBTREE` is
`d449f9b0`, while `MAX_SUBTREE` `9fde27e1` and every pinned Gravity/MAX build
material (Dockerfiles, lockfiles, MAX `index.js`, `.dockerignore`) are
byte-identical to `0829ae02`. The MAX image is still rebuilt, because each
image binds the target revision and this profile in its labels.

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
| Run | `40168317994` (Architecture enforcement #327), attempt 1, workflow `334421867`, completed/success |
| Head | `main` at `4f3b6c0a9f19ded2d7867c8a11da396f6dc61543`, tree `4d4d8193…` |
| First parent / blast base in the proof | `d7be4883494e37365bfb94d88ad7a4d8d33141e3` |
| Architecture job | `121093807326`, completed/success |
| Proof artifact | `12595132035`, `authoritative-ci-proof-4f3b6c0a…`, 5766 bytes, `sha256:3d10d636…`, bound to run `40168317994` on `main` |
| Workflow / runner | `7acd3668…` / `e8738068…`, 53 controls, catalog `f6271d9c…`, semantic `57f68431…` |

The baseline is linked explicitly. Its own main-push authority must also verify:
run `39900558961` (push, `main`, `0829ae02`, success), architecture job
`120240929000`, proof artifact `12487917640` (`sha256:433c9585…`), and a proof
for `0829ae02`/`7290f6f5` with blast base `93b2b228`.

The application checkout must carry the exact first-parent chain pinned in
`APPLICATION_LINEAGE`: 4 commits from `4f3b6c0a` down to `bbc350a1`, whose
first parent is the anchor `0829ae02`. Every chain entry is pinned explicitly,
must be a one- or two-parent commit (octopus merges are rejected), and its
FIRST parent must be the next pinned entry, so a moving main tip, a skipped or
substituted commit, or a chain of equal length cannot stand in for the target.
The chain is the first-parent walk `HEAD~1 … HEAD~4` the workflow re-asserts;
the application checkout stays a full clone, so the merge-base guard and the
anchor walk never depend on a bounded fetch depth. Any other value of
`SOURCE_LINEAGE_MODEL` fails closed. The accepted predecessor is itself a
`MAIN_FIRST_PARENT` push authority, proved here by exact commit and content
digest; the older PR-model authorities are untouched.

The source evidence directory therefore has eight members: `run.json`,
`jobs.json`, `artifact.json`, `authoritative-ci-execution.json`, and the same
four prefixed with `baseline-`. A Stage B sealer must supply all eight. The
GitHub run documents are captured live; a main push run carries no pull
request, so nothing has to stay open for the capture to reproduce. Any change
makes verification fail closed, never widen.

The authoritative Stage A control validates the immutable builder change from
base `4f3b6c0a9f19ded2d7867c8a11da396f6dc61543` to the builder commit pinned in
`tests/test_stage_a_contract.py`. That change may only add this directory and
`.github/workflows/coordinated-gravity-max-4f3b6c0a.yml`, and point
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
