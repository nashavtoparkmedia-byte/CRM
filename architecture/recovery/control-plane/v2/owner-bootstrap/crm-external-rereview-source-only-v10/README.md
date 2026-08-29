# Runtime 2.0.0-14 source-only release builder

This external staging tree prepares a deterministic next-revision, same-ABI
replacement for the installed `yoko-privileged-runtime` `2.0.0-13` package.
It is not an authorization to install or deploy anything. The exact installed
`d4575d20f91e0029fdcce9669b42478bd8e34e1f` Runtime, package SHA-256
`db5a91ea3192c541defa00fe432904357ff9d900be6dc8e13a5a024dddc1fa48`,
is the direct
control-plane rollback state. Its application profile remains
`crm-d4575d20f91e-gravity-source-v1`.

The successor preserves the installed core, observer, policy, and sudoers
boundary byte-for-byte. The existing integrity-pinned, zero-argument
`predecessor-observe` operation remains fixed and read-only; it accepts no path,
Docker command, socket, shell, or other caller input.

It installs a new content-specific profile with fresh state. The enabled
zero-argument release operations are `database-status`, `release-preflight`,
`release-activate`, and `rollback`; the separate enabled read-only operation is
`predecessor-observe`. `database-migrate` and `config-activate` are disabled.
The historical outbox migration artifact remains installed only as immutable
database compatibility evidence; the wrapper cannot dispatch its mutation
implementation.

## Seal after final acceptance

The exact installed `d4575d20…` DEB is supplied to the sealer as an external
hash-pinned input, copied into the sealed bootstrap tar, and validated against
its exact prior release seal. Before any `dpkg`, the Owner installer
atomically places it at the fixed root-private content-addressed store keyed by
`db5a91ea…a48`. A later bootstrap failure reinstalls and verifies that exact
immediate Runtime state. Historical Runtime packages remain recovery ancestry,
not this bootstrap's direct rollback target.

The Owner envelope rejects less than 10 GiB of available filesystem space
before creating any root staging object. Its staging tar and directory use
deterministic exact-SHA paths and are validated and removed on both entry and
exit, so successful, failed, and retry executions cannot accumulate copies.
Immediately before the `dpkg` mutation boundary the installer independently
requires at least 5 GiB free; a shortfall leaves the installed Runtime untouched.

Use a clean worktree whose `HEAD` is the already accepted final commit. Fill an
exact v2 acceptance record and a newly recaptured read-only production snapshot,
then run:

```sh
python3 -I packaging/capture-production-snapshot.py > /absolute/production-snapshot.json
python3 -I packaging/seal-release.py \
  --source-repo /absolute/clean/worktree \
  --commit FULL_COMMIT_SHA \
  --acceptance-record /absolute/acceptance.json \
  --production-snapshot /absolute/production-snapshot.json \
  --migration-authority /absolute/production-migration-authority.json \
  --predecessor-attestation /absolute/independent-predecessor-attestation.json \
  --gravity-artifact-zip /absolute/gravity-image-COMMIT.zip \
  --direct-rollback-package /absolute/yoko-privileged-runtime_2.0.0-13_all.deb \
  --direct-rollback-provenance /absolute/d4575d20-SEALED_RELEASE.json
./packaging/build-package.sh
./packaging/build-bootstrap-bundle.sh
python3 -I -B -m unittest discover -s tests -v
python3 -I packaging/finalize-evidence.py --bootstrap-review PENDING
```

The acceptance record cannot use a bare `authoritative_ci: PASS` assertion. It
must carry one exact structured GitHub Actions attestation for repository
`nashavtoparkmedia-byte/CRM`: the accepted commit and tree, the fixed workflow
path and its accepted-commit SHA-256, the authoritative runner path and SHA-256,
positive hosted run/job/artifact IDs, their canonical GitHub URLs, the exact
head SHA, and `success` conclusions for both exact jobs. The sealer fetches the
public GitHub API and independently matches those identities before accepting
the downloaded artifact ZIP. It must also carry the complete
ordered 52-control catalog, count `52`, ID catalog SHA-256 `7268cb0b…7680`, and
semantic catalog SHA-256 `24ad32ba…5483` over the reviewed command, argument,
working-directory, and order tuples. The architecture runner itself emits a
success-only execution proof containing all 52 ordered PASS records; the
architecture job uploads that proof, and the dependent Gravity job downloads
and embeds it in the final three-member artifact ZIP beside the image
attestation and Docker archive. The sealer validates the proof's commit/tree,
workflow/runner hashes, exact Node version, both catalog digests, and every PASS
record against the acceptance record. Missing fields, extra fields, a different
commit/tree, hash drift, forged URLs, non-success conclusions, or an ID or
semantic catalog mismatch all fail closed. The validated attestation is copied
into `SEALED_RELEASE.json` and remains transitively bound by the
acceptance-record digest.

Before it reads templates or runs any package helper, the sealer enumerates the
complete Runtime v10 subtree in that same accepted commit. Every tracked staging
file must be a regular single-link file with the accepted Git mode and exact Git
blob bytes, and every extra staging file is rejected. The complete Git blob/SHA-256
inventory is copied into `SEALED_RELEASE.json`. Thus a clean accepted application
checkout cannot be combined with an unreviewed builder, template, validator, or
package source tree.

`seal-release.py` refuses a dirty/non-HEAD commit, a commit without that exact
hosted-CI acceptance record, any migration SQL delta from `7aea2823…`, or a
production snapshot that is not the installed Runtime 2.0.0-13
`crm-d4575d20f91e-gravity-source-v1` control plane
over the healthy `baf442f8…` image at revision `7aea2823…`. The capture CLI
accepts no arguments and invokes
only the exact finite `sudo -n yoko-privileged-runtime` read-only plan: version,
self-check, the bounded predecessor recreation observation, audit status, exact
Gravity/TG/Postgres inspections, the production repository snapshot manifest,
and database status. The predecessor observation binds category-A recreation
configuration, records category-C container/endpoint facts separately, and
preserves category-B named-volume contents without hashing them. Its
duplicate-key-safe v2
transcript retains every bounded canonical Runtime response and its SHA-256,
derives a separate secret-minimized projection, cross-checks container/database/
audit identities, and is accepted by the sealer only within 15 minutes of the
capture end. Live observations are structurally separate from sealed predecessor
authority fields that the Runtime cannot observe (the existing TG file baseline
and activation-profile catalog digest); those authority fields are never claimed
as capture output. It builds the source archive twice and compares
bytes, validates and embeds the hosted Gravity Docker archive, seals every
transitive package/bootstrap input, double-builds both outputs, records their
exact identities, and rebuilds them against the final seal. Any post-seal input
or output mutation fails closed.

Gravity is not built on the production host. The hosted job uses Buildx
`v0.30.1` with a digest-pinned BuildKit `v0.25.2` container and digest-pinned
Dockerfile/base materials. Runtime admits the exact image ID, source commit,
tree, profile label, archive digest, platform, materials and GitHub artifact,
then loads the installed archive offline with `docker image load`. A
pre-existing target tag is adopted only when its image identity and exact
source/profile labels match the sealed artifact; every foreign identity is a
collision. If a newly loaded tag fails output or identity verification, Runtime
removes only that just-loaded target tag and proves it absent before returning
the original failure. Cleanup failure is a separate fail-closed error.

For this curator-approved transition-identity strategy repair, the builder emits only
non-authorizing bounded evidence for the 28 transition and Runtime-bootstrap tests. It cannot author
the independent bootstrap Runtime review decision or assign itself an
independent identity:

```sh
python3 -I packaging/verify-independent-critic.py --bootstrap-review-evidence \
  --source-repo /absolute/clean/accepted/worktree \
  --seal "$PWD/SEALED_RELEASE.json" \
  --tar "$PWD/dist/yoko-crm-source-only-runtime-2.0.0-14.tar" \
  --deb "$PWD/dist/yoko-privileged-runtime_2.0.0-14_all.deb" \
  > /absolute/bootstrap-transition-review-evidence.json
```

A separate reviewer must inspect that exact evidence and author an exact
`yoko.crm.transition-identity-strategy-independent-runtime-review.v1` artifact. It
binds the repaired source/tree, seal, final DEB, bootstrap tar, exact direct
rollback DEB, validator and 28-test catalog, with an empty residual-finding
list and explicit no-mutation/no-predecessor-reopen/no-full-replay assertions.
Finalization requires the review to be no more than 24 hours old, reruns only
that bounded test catalog, and consumes—but never creates—the artifact:

```sh
python3 -I packaging/finalize-evidence.py \
  --bootstrap-review PASS \
  --source-repo /absolute/clean/accepted/worktree \
  --review-artifact /absolute/transition-identity-strategy-independent-runtime-review.v1.json
```

This is the bootstrap-specific independent Runtime gate required before
presenting the repaired exact-SHA install boundary for final Owner acceptance.
It neither reopens predecessor acceptance nor triggers the historical full
architecture/boundary replay.

The embedded archive has no synthetic common prefix. Its only roots are the
exact `gravity-mvp/` tree and the parent directories plus exact
`tg-bot/src/public-bot-maintenance.js` selected from the accepted commit.
Runtime independently enforces that same two-root allowlist before extraction;
the Gravity BuildKit context therefore resolves directly to `gravity-mvp/`.
The accepted full commit/tree and archive inventory remain pinned in the seal.

The Telegram change is not a rebuild of the drifting repository Dockerfile.
Preflight derives a one-file image from the exact live predecessor image
`sha256:0849c4…35f6`. The exact-container sanitized filesystem manifest proves
that the destination is absent in that predecessor; preflight re-probes that
absence before mutation. It then creates a network-disabled `FROM` + `COPY`
addition for only
`/app/src/public-bot-maintenance.js`, checks the exact `docker diff`, layer
ancestry, preserved image configuration and read-back hash. Rollback proves the
path is absent again and seals separate Gravity and Telegram rollback tags.
Activation and recovery always use a fixed
two-service overlay and one bounded Compose call; any partial/mixed state is
rolled back as a pair.

The production provenance gate requires a complete inventory with an empty
failure list. Its schema-bound semantic fingerprint and every available
record's runtime identity are part of the preflight identity and must remain
unchanged; any missing resource, failure, or fingerprint drift fails closed.

An accepted `schema.prisma` synchronization to the canonical production model
is allowed and its exact hash is pinned. This does not authorize SQL or a
database change; the migration directory must remain byte-identical to 7aea and
preflight still requires the exact live canonical 62-row map and pinned
semantic order.

The sealer also requires the canonical 62-row production migration authority
and the independent sanitized predecessor-image inventory. It verifies the
pinned source-runtime and inventory digests, excludes only the exact known TG
row, and requires the remaining 61 name/checksum pairs to equal the authority.
It embeds that exact map and the separate outbox target; the opaque historical
normalized digest is evidence, not the live semantic gate.
The `--migration-authority` path is transport only: its complete bytes must be
identical to
`architecture/migrations/v1/production-migration-authority.json` in the exact
accepted commit. The seal records the SHA-256 of that accepted Git blob. A
modified, reduced, or separately self-consistent 62-row JSON document cannot
substitute for the commit's provenance-bearing authority.
The sealer additionally derives a 62-row semantic-order authority from the
exact byte-pinned predecessor attestation row order, removes the physically
separate TG migration, and appends the outbox target. It binds that sequence
by SHA-256 in both the profile and release seal. This does not invent
historical timestamps: Runtime v9 did not expose them.

The existing finite `database-status` operation queries the live
`_prisma_migrations` ledger read-only. In this successor it emits the exact
ordered row identities, names, Prisma checksums, status, start/finish/rollback
timestamps, applied-step count, and secret-safe log length/hash metadata. The
`observed_chronological_ordinal` is the live `started_at,migration_name,id`
order and is deliberately distinct from the artifact authority's name-sorted
`canonical_ordinal`. Raw
logs are never returned. The live row list and its digest are separate from the
legacy v9 compatibility digest used to bind the preflight predecessor state.
The sealed semantic order is an authorization predicate alongside the complete
active name/checksum map. A live reorder of otherwise known rows is reported
as `DRIFTED` and preflight fails closed; it is never auto-accepted. Live
timestamps remain observation evidence, and the row parser separately rejects
duplicate, malformed, or inactive rows. If the first real v10 observation
differs from the pinned semantic order, it requires a separate independent
review and a new explicitly accepted authority.

The Owner command remains explicitly unauthorized until the separately
authored transition-identity strategy independent Runtime review verifies as PASS for
the exact repaired seal, successor package, embedded `db5a91ea…` rollback
package, bootstrap tar, hosted-CI attestation, commit, and tree. This bounded
gate does not reopen the already accepted predecessor baseline.
