# Runtime 2.0.0-22 coordinated Gravity + MAX release builder

This directory is the content-specific Stage B authority for exactly one
coordinated application pair:

- application commit `10318827e484fec466ba994a2a7b7ffe070f7336`;
- coordinated profile `crm-10318827e484-gravity-max-source-v1`;
- Stage A builder `46e6107187776929db52ca127061b0c99a21ce71`;
- hosted artifact run `36978099367`, artifact `11215210912`;
- Gravity image `sha256:0247864ab320fa86498da0d69610ce9a910a46d92ded420091b7c4d6b0aa6152`;
- MAX scraper image `sha256:f9e09bd8c2dcc98c309e440b82f7e8586aac406f2510bbaf9be90d98908b252a`.

It does not rebuild application images and does not authorize an arbitrary
revision, image, service, path, Docker command, shell, database migration, or
configuration mutation. The installed Runtime exposes only the fixed
zero-argument `database-status`, `release-preflight`, `release-activate`, and
`rollback` operations plus the existing read-only `predecessor-observe`.

The trusted Runtime core, base policy, and sudoers file are byte-identical to
the current Runtime v10 authority. The predecessor observer is version 2
(`yoko.crm.predecessor-recreation-observation.v2`, see below); it keeps the
v1 install slot because the pinned core fixes the install-manifest file set. Runtime 2.0.0-21,
the installed predecessor, is the exact direct control-plane rollback and is not
modified by this builder.

## Predecessor observation v2

`predecessor-observe` reconstructs each predecessor container (Gravity,
tg-bot and, since v2, the MAX scraper) from the Compose layer stack that the
container itself recorded at creation
(`com.docker.compose.project.config_files`) and requires every
release-critical semantic to equal that reconstruction: image reference and
image id, entrypoint, command, container name, extra hosts, logging,
healthcheck, user, working directory, privileged/read-only, capabilities,
security options, init, stop signal and grace period, published ports and
tmpfs, restart policy, mounts, networks, and the environment (names and
values, compared internally, never emitted). The comparison is closed-world:
any resolved service field outside that set (other than `build` and
`depends_on`) is refused rather than ignored, and so is any per-network
configuration (aliases, addresses) and any mount sub-key beyond `type`,
`source`, `target`, `read_only`, an empty `volume` and the default `bind`. The
environment is compared last, so a reported name condition means every other
semantic already reconstructed.

- The base compose and `.env.production` keep the v1 fixed-file checks.
- A Runtime profile overlay (`/var/lib/yoko-privileged-runtime/profiles/
  crm-<12 hex>-gravity-max-source-v1/{activate,rollback}.compose.yml`) must be
  a root-owned `0400` file in the root-only store. It is passed to Compose
  and its digest is bound. At most one, and it precedes every image pin.
- Any other recorded layer is untrusted input. It is read once (bounded,
  regular file, no final-component symlink), never handed to Compose, and
  admitted only if it matches the strict image-pin grammar
  (`services:` / `  <service>:` / `    image: <reference>`, plus comments).
  Every line must be a single line under Python's and YAML's line-break rules
  (no NEL, LS, PS, VT or FF anywhere), so a comment cannot hide a key from
  this parser that Compose would apply. Its pins override the resolved image;
  its digest is bound, and the layer records whether its path chain is
  caller-writable (its digest is then evidence, not authority: the pins are
  re-proven against the running container).
- No other file can enter the reconstruction: a candidate overlay that the
  running container did not record is never read, and substituting one
  resolves the candidate's image, which the predecessor does not run.
- The Compose config hash is recorded but not recomputed: Compose 5.1.4's
  `config --hash` does not reproduce the `up` label for these stacks
  (measured on production Gravity), so it cannot bind anything.

Every layer path, role and digest is part of `compose_source.overlay_layers`
and therefore of `release_critical_identity_sha256`.

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
  release. The cold-cache repair 10318827 is that release plus the outbound
  chatType fix plus the inbound DOM-fallback repair plus the topology repair
  plus this cold-cache repair, and needs the same single secret, so
  re-staging the material under a new name would be a production write with no
  benefit. It is a secret source path, not an
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
  the predecessor's names plus exactly that one name. The name may already be
  present only where the predecessor's OWN sealed profile attached it (an
  activated predecessor); then the names stay unchanged. Any other added,
  removed or renamed variable still fails closed.
- Rollback reproduces the predecessor exactly as it ran, from two authorities
  only (Owner ruling, predecessor sealed authority): the production snapshot's
  recorded semantic (command, environment names) and the predecessor's own
  sealed profile, read at seal time from inside its digest-verified package.
  The sealer binds that projection into `predecessor.rollback_semantic` -- the
  recorded command per service and the predecessor's own source path where it
  consumed the name; paths and digests only, never a value. Sealing fails closed
  if the predecessor consumed the name but its sealed profile has no source for
  it; a successor source is never substituted. A bare predecessor resolves to
  its recorded command and no source, so its rollback reads nothing; an
  activated predecessor's rollback re-attaches its own source, bound by digest
  at preflight. Preflight refuses if the live predecessor no longer matches the
  sealed projection, and the rollback postcheck requires the unchanged
  predecessor semantic, command included.

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

The installer also requires the already-installed 2.0.0-21 interim package
(`packaging/predecessor-observability-v2/`: the byte-identical
`crm-ba90ed4b6717` profile plus predecessor observation v2) at its exact
root-owned content-addressed rollback path and validates it against SHA-256
`619f4ebe43dfca98942d9557e0d2fb28aa4b7f819079a7baa28f7ea2eb5cd283`; the
installed predecessor must report observer
`1d430cb9797e31a0236213e9e2c69ad2951b0f343ae6eabe5b014e664a27604a`.
Any successor installation failure restores that exact package automatically.
The original 2.0.0-21 DEB `17b97c40…` stays in the store as that interim
package's own rollback.

The predecessor is the MAX-normalized live pair proven by the Phase 3 authority
snapshot `17b8ead7543c3cf54ab58976b65c9e6d480fee0a077a3eaf2d396649bfabacf7`
(predecessor identity `f48c638e…`). The sealer pins every semantic identity of
that snapshot's `sealing` block (images, container ids, config hashes, volume,
database, ledger, audit and unrelated-service fingerprint) and still requires a
capture younger than 15 minutes, so a seal uses a fresh recapture that must
reproduce Phase 3 exactly; only capture timestamps may differ.

Generated material under `generated/` and `dist/` is untracked. Sealing must
start from a clean exact builder commit, a fresh read-only production snapshot,
clean sparse checkouts of the accepted application and Stage A builder, and
the authenticated Stage A handoff. Independent configured reviewers must bind
the final commit/tree, package, seal, bootstrap, Stage A artifact, and the
2.0.0-21 rollback before installation.
