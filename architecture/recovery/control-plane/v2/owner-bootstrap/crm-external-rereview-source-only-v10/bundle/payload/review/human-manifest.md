# YOKO CRM one-time source-only Owner bootstrap

This payload replaces installed Runtime package `2.0.0-10` with revision
`2.0.0-11` without changing ABI `2.0.0`, the Runtime core, observer, policy, or
sudoers semantics. It installs one new checksum-pinned source-only Gravity
profile with fresh transaction state; historical profile state is never
imported as current prestate.

Bootstrap itself does not invoke a profile, build or deploy an image, access
PostgreSQL, restart a service, or mutate `/opt/crm`. `database-migrate` is
disabled. Package installation is the sole Owner/root action.

The release seal is admitted only after an exact structured hosted GitHub
Actions attestation cross-binds the accepted commit/tree, workflow and runner
hashes, live run/two-job/Gravity-artifact IDs and URLs, exact head SHA,
successful conclusions, and the complete ordered 52-control authoritative
catalog, including its reviewed command/argument/cwd/order semantic digest.
The final Gravity artifact also embeds the runner-emitted proof that all 52
ordered controls actually completed with PASS; the sealer binds that proof to
the accepted source, workflow, runner, and Node runtime identities.
Gravity is built by digest-pinned hosted BuildKit and shipped as an exact Docker
archive. Production adopts a pre-existing target tag only when its identity and
exact source/profile labels match the sealed artifact, and rejects every foreign
identity. If a newly loaded tag fails output or identity verification, Runtime
removes that tag and proves it absent before returning the failure.
The seal also binds the complete Runtime builder subtree to exact accepted Git
blobs, all package/bootstrap inputs, and both deterministic output identities.
A bare PASS assertion or any missing, forged, partial, drifted, extra-staging,
or post-seal-mutated identity is rejected.

Owner authorization additionally requires a review artifact authored by a
separate bootstrap Runtime reviewer and a fresh mechanical run of the bounded
24-test transition-identity strategy catalog against the clean repaired checkout, with exact
seal, successor package, bootstrap tar and embedded direct rollback package
bindings. The builder itself emits only non-authorizing evidence and cannot
create the review decision. This narrow gate does not reopen the accepted
application predecessor or start the historical full replay.

The bootstrap accepts only the installed Runtime from source `ae2082d…` and
carries exact package `9c23ae1a…` as its direct
rollback artifact. It places that DEB in the root-private content-addressed
store before `dpkg`; any later failure restores and verifies that exact state.
Historical packages are recovery ancestry, not direct bootstrap rollback.

The application predecessor is the accepted `7aea2823…` image
`sha256:baf442f8…`. Release preflight must seal that image as rollback before
activation. Failure restores that exact image and proves bounded health.

The separately deployed Telegram bot is equally part of the transaction: its
exact predecessor is sealed under a distinct rollback tag, its accepted change
is a one-file derived image, and activation/rollback always recreate both
services through the same fixed two-service overlay. Mixed states trigger pair
rollback and cannot be reported as success.

The installed profile binds the complete 62-row active migration
name/checksum map and a source-attested semantic order. `database-status`
reports the actual live timestamp-ordered rows; a reorder of known rows is
`DRIFTED` and blocks preflight rather than being auto-authorized. No historical
timestamp is fabricated by the package.

That production migration authority is accepted only as the complete exact Git
blob from the sealed source commit, with its SHA-256 bound into the release
seal. A modified or structurally reduced 62-row substitute is rejected before
packaging.
