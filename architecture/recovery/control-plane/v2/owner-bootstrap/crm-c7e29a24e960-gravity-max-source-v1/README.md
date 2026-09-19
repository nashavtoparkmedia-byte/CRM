# Runtime 2.0.0-18 coordinated Gravity + MAX release builder

This directory is the content-specific Stage B authority for exactly one
coordinated application pair:

- application commit `c7e29a24e960ddd75e6701d71e06405777e58d1e`;
- coordinated profile `crm-c7e29a24e960-gravity-max-source-v1`;
- Stage A builder `f32ee22a1e8967e92f1828075d7650eb8d0f8dea`;
- hosted artifact run `35395889864`, artifact `10567922654`;
- Gravity image `sha256:49c8434bdb0c87f881560946bdefaa040ceb5602dafd4bc6d4a6f8ac09c6d898`;
- MAX scraper image `sha256:d6c9f0f9c7b800c08fb6366a0b223f607d6aae2502efb86b865e4118abf5e668`.

It does not rebuild application images and does not authorize an arbitrary
revision, image, service, path, Docker command, shell, database migration, or
configuration mutation. The installed Runtime exposes only the fixed
zero-argument `database-status`, `release-preflight`, `release-activate`, and
`rollback` operations plus the existing read-only `predecessor-observe`.

The trusted Runtime core, predecessor observer, base policy, and sudoers file
are byte-identical to the current Runtime v10 authority. Runtime 2.0.0-17,
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

## Release environment addition

Activation may add exactly one environment variable name,
`MAX_SCRAPER_WEBHOOK_SECRET`, and only to `gravity-mvp` and `max-web-scraper`.
The name, the two services, and the two source paths are sealed constants in
the profile code and in `profile.v1.json` (`release_environment`); nothing is
read from runtime input and there is no list to extend.

- The value is never written to the shared `/opt/crm/.env.production`, so no
  other Compose service can receive it. The generated activation overlay
  attaches one fixed source per service:
  `/var/lib/crm/release-staging/messaging-be6b8eb8/{gravity-mvp,max-web-scraper}.env`.
  The directory keeps the name it was staged under for the be6b8eb8 Messaging
  release. The c7e29a24 hotfix is that release plus the outbound fix and needs
  the same single secret, so re-staging the material under a new name would be
  a production write with no benefit. It is a secret source path, not an
  artifact or image binding.
- The source directory must be root-owned `0700` with every ancestor
  root-owned and not group- or other-writable. Each source must be a
  single-link root-owned `0600` file containing exactly
  `MAX_SCRAPER_WEBHOOK_SECRET=<64 lowercase hex>` plus a newline, and both must
  carry identical material. Preflight reads them once and binds a digest into
  state; activation refuses before its intent write, and again at the Compose
  boundary, if they changed. The render is compared with that bound value, not
  a fresh read. No fault or state record carries the value.
- The rendered activation projection must equal the base projection except for
  the image, the Gravity command, and that one name with the bound value.
  Unrelated services must render identically.
- The target postcheck expects each pair container's environment names to be
  the predecessor's names plus exactly that one name, which must not already
  be present. Any other added, removed or renamed variable still fails closed.
- Rollback never reads or attaches these sources, and its postcheck still
  requires the unchanged predecessor semantic. The predecessor images do not
  reference the variable, so they are recreated exactly as they ran before.

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

The installer also requires the already-installed 2.0.0-17 DEB at its exact
root-owned content-addressed rollback path and validates it against SHA-256
`490a242bd89c5dc5c8377c9d47cf6602fef73bdfa879388080170507eaff8a34`.
Any successor installation failure restores that exact package automatically.

Generated material under `generated/` and `dist/` is untracked. Sealing must
start from a clean exact builder commit, a fresh read-only production snapshot,
clean sparse checkouts of the accepted application and Stage A builder, and
the authenticated Stage A handoff. Independent configured reviewers must bind
the final commit/tree, package, seal, bootstrap, Stage A artifact, and the
2.0.0-17 rollback before installation.
