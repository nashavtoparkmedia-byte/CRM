# Pre-seal status

Runtime 2.0.0-10 source-only builder prepared. No final commit, source archive,
package, bootstrap tar, critic decision, or Owner authorization is sealed yet.
See `README.md` and the two input templates.

Sealing requires a structured hosted GitHub Actions attestation, not a bare
PASS string. It cross-binds the exact accepted commit/tree, workflow and runner
SHA-256 identities, live canonical run, two job and Gravity artifact IDs/URLs,
exact head SHA, two `success` conclusions, and the full ordered catalog of
exactly 52 authoritative controls. The catalog is bound both by ordered IDs and
by the reviewed semantic command/argument/cwd/order digest. A runner-emitted
success-only proof of all 52 ordered executions is embedded in the final
Gravity artifact and validated independently by the sealer. The hosted Gravity
image is built by digest-pinned BuildKit, inspected by immutable image ID and
labels, packaged into Runtime and loaded offline. A pre-existing target tag is
adopted only when its identity and exact source/profile labels match the sealed
artifact; every foreign identity is rejected. A newly loaded tag that fails
output or identity verification is removed and proved absent before Runtime
returns the failure. The complete external Runtime builder subtree is also byte-bound
to the accepted commit before rendering or execution, and its Git inventory is
sealed. Every transitive build input and both deterministic output identities
are sealed. Any identity, hash, conclusion, count, catalog, staging entry or
post-seal mutation drift fails closed.

For the curator-approved release-transition repair, the executor can emit only
non-authorizing evidence for the bounded ten-test bootstrap catalog. A separate
bootstrap Runtime reviewer authors the exact review artifact with explicit
separation, no-mutation, no-predecessor-reopen and no-full-replay assertions.
Finalization mechanically reruns only that catalog and binds the decision to
the repaired source/tree, seal, successor Debian package, bootstrap tar and
embedded direct rollback package `b97642ff…` from source `2b881128…`.

The builder pins both the exact 62-row active migration name/checksum map and
its semantic order. `database-status` exposes live timestamp-ordered rows; any
known-row reorder is `DRIFTED` and blocks preflight pending a separate review.
No historical timestamp is synthesized.

The complete production migration authority supplied to the sealer must be
byte-for-byte identical to its Git blob in the exact accepted commit. Its
SHA-256 is carried into the release seal; a reduced or separately rewritten
62-row authority is not admissible.

The release archive has exact roots `gravity-mvp/` and the single accepted
`tg-bot/src/public-bot-maintenance.js` path. Preflight derives the Telegram
candidate from the hash-pinned live image after proving the destination absent,
with an exact one-file addition; rollback proves the path absent again;
activation and every rollback/recovery path transact `gravity-mvp` and
`tg-bot` together. A mixed image state can never be accepted as terminal.
