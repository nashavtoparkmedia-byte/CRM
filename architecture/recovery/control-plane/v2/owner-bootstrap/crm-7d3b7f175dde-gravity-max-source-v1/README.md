# Runtime 2.0.0-16 coordinated Gravity + MAX release builder

This directory is the content-specific Stage B authority for exactly one
coordinated application pair:

- application commit `7d3b7f175ddebc7db3a9a3fbced24957f1be7c16`;
- coordinated profile `crm-7d3b7f175dde-gravity-max-source-v1`;
- Stage A builder `7867840d7da7ee371039e414a9f25c566a8eca36`;
- hosted artifact run `34687594677`, artifact `10296346283`;
- Gravity image `sha256:f6732139285613d808fced423b8dff91a0ffcab6497012a995e7270b6d686e0a`;
- MAX scraper image `sha256:8ccce836055fae5e9dfe0ef5bc9f0bc7f33b949331d84bef1b749b1c5df4a325`.

It does not rebuild application images and does not authorize an arbitrary
revision, image, service, path, Docker command, shell, database migration, or
configuration mutation. The installed Runtime exposes only the fixed
zero-argument `database-status`, `release-preflight`, `release-activate`, and
`rollback` operations plus the existing read-only `predecessor-observe`.

The trusted Runtime core, predecessor observer, base policy, and sudoers file
are byte-identical to the current Runtime v10 authority. Runtime 2.0.0-15,
the installed predecessor, is the exact direct control-plane rollback and is not
modified by this builder.

## Pair state model

The only accepted application terminal states are `PREDECESSOR_PAIR` and
`TARGET_PAIR`. A known mixed Gravity/MAX pair is rolled back with one fixed
two-service Compose transaction. An unknown image identity fails closed and is
never overwritten. Activation overrides the Gravity command to `npm run start`
so the release performs no database migration. PostgreSQL identity and the
exact migration ledger are checked read-only before and after activation.
Postcheck and rollback failures are durably fenced as failure phases before a
later activation can proceed; returning from a failure requires a fresh full
preflight.

The exact named volume `crm_max_user_data` must remain mounted read-write at
`/app/user_data`; neither installer nor Runtime can create, delete, rename, or
replace it. Other service semantics are digest-bound before activation and
must remain unchanged after activation and rollback.

## Large artifact admission

The 4.8 GB Stage A image archives are deliberately not duplicated inside the
DEB or bootstrap tar. The sealed zero-argument Owner installer admits the six
exact files from one fixed local handoff directory into a root-owned,
content-addressed store before installing the package. It verifies the fixed
member allowlist, byte sizes, SHA-256 digests, Stage A manifest, and local
content verifier result. Admission streams each source descriptor into a new
root-created exclusive inode, fsyncs and verifies the copy, and atomically
publishes only the root-created directory; caller-owned handoff inodes never
enter the trusted store. Runtime rehashes both archives during preflight before
the only fixed `docker image load` operations. A lifetime-held exclusive lock
serializes bootstrap installers and binds guard cleanup to the owning inode.
This is not a generic artifact or path capability.

The installer also requires the already-installed 2.0.0-15 DEB at its exact
root-owned content-addressed rollback path and validates it against SHA-256
`4ef91178abffd61981d60a661c3b0cb0c2dc3b423b29d994fff33309aec8b246`.
Any successor installation failure restores that exact package automatically.

Generated material under `generated/` and `dist/` is untracked. Sealing must
start from a clean exact builder commit, a fresh read-only production snapshot,
clean sparse checkouts of the accepted application and Stage A builder, and
the authenticated Stage A handoff. Independent configured reviewers must bind
the final commit/tree, package, seal, bootstrap, Stage A artifact, and the
2.0.0-15 rollback before installation.
