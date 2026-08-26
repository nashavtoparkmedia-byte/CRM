# Replacement Release Decisions

Status: curator governance v1, 2026-08-26.

## D-001 — Acceptance remains finite

The release keeps the accepted single-authority executable boundary and existing
evidence semantics. Import grammar, Node loader identity, `createRequire`, and
same-trust arbitrary repository reads are closed. A reviewer may block only on a
frozen release-critical property. One independent review permits at most one
narrow repair for an in-scope defect.

## D-002 — Governance is isolated from PR #70

Governance files live on `codex/release-governance-v1`, created from exact
unchanged `main` at `66b1d37c6adf94dd501b586f3eea6422339c8fcb`.
They are committed and pushed separately and do not change qualified candidate
`50d095f639c6a70e72508f8de87c7308986c828d` or PR #70.

## D-003 — Predecessor state partition

Category A is release-critical recreation configuration and must be sealed:
container/image execution identity, effective configuration binding, mounts,
networks, published ports, relevant HostConfig/lifecycle settings, and Compose
project/service/source/resolved-service identity.

Category B is mutable application/runtime state. It is not byte-bound unless the
rollback implementation explicitly restores it. Database identities already
required by the expand-only rollback contract remain governed by that contract.

Category C is observational/ephemeral metadata such as current timestamps,
health, runtime counters, and endpoint state. It may support freshness and
diagnostics but is not recreation identity unless explicitly named by rollback.

## D-004 — Telegram named volume is preserved, not restored

The actual Runtime rollback writes a fixed image-only overlay and invokes:

`docker compose ... up -d --no-deps --no-build --pull never --force-recreate ...`

The base production Compose definition is validated byte-for-byte and the overlay
is rejected if it changes non-image service semantics. No rollback source copies,
restores, or rewrites `/app/data`. Docker Compose therefore reuses the existing
named volume `crm_tg_bot_data` while recreating the container.

The predecessor seal must bind exact volume identity/name, type, `/app/data`
target, read/write semantics, driver, and release-relevant options. It must not
hash all mutable application data inside the volume. Only a future explicit
rollback promise to restore named paths could add those paths to content identity.

## D-005 — One narrow observation primitive

The existing project-scoped `/usr/local/sbin/yoko-privileged-runtime` is extended
with one zero-argument read-only predecessor-observation primitive. It uses fixed
logical resources and fixed inspection/config-rendering commands. It cannot
accept Docker objects, paths, Compose files, environment files, or shell text from
the caller. No generic root or Docker mechanism is added.

## D-006 — Secret-safe effective configuration binding

The installed Runtime has root-private state and an existing Compose config-hash,
but no approved persistent keyed-digest/HMAC secret design. The observation
primitive therefore does not emit plaintext, per-value hashes, or a new unsalted
aggregate of secret values.

Instead it renders the fully resolved production Compose service internally,
compares the effective container environment exactly against that service, and
emits only:

- the exact environment key set;
- an equality result;
- the existing Compose config-hash already attached to the container;
- a canonical digest of a secret-free resolved-service projection.

This binds effective values to the existing recreation source without creating a
new offline guessing oracle. A new persistent HMAC key remains out of scope and
would require a separate curator decision.

## D-007 — Production and Owner boundaries

All source, tests, hostile review, deterministic builds, checksums, policy and
registry binding, idempotency, uninstall, and exact diff checks run before Owner
installation. Installing the Runtime package is a privileged mutation and is not
performed by Codex. Production activation remains separately authorized and is
never implied by package installation.
