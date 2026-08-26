# Replacement Release Acceptance Charter

Status: frozen governance v1, 2026-08-26.

## Objective

Prepare the qualified YOKO CRM replacement release through immutable source,
evidence, CI, Gravity, predecessor, seal, Runtime, and recovery qualification,
while keeping PR #70 unmerged and production services and data unchanged. The
implementation agent stops at the Owner privileged installation/activation
boundary and never self-certifies an independent review.

## Frozen scope

Acceptance covers the qualified replacement candidate, its exact required
artifacts, deterministic recreation of the current predecessor for rollback,
the finite privileged Runtime/profile, and recovery qualification. It does not
cover unrelated product architecture, general host hardening, or redesign of
already accepted evidence semantics.

## Release-critical blockers

The release is blocked by any of the following:

1. Candidate commit/tree or predecessor/base identity is not exact.
2. Required authoritative CI or its execution proof is absent, stale, or failing.
3. Required Gravity artifact is absent, expired when needed, malformed, or not
   bound to the exact candidate and Docker build inputs.
4. Current predecessor release-critical recreation configuration is unobservable,
   stale, or insufficient to reconstruct rollback semantics deterministically.
5. Secret-safe configuration identity cannot be established without inventing an
   unapproved persistent secret/key design.
6. Seal inputs, Runtime package, policy, registry, profile, recovery proof, or
   rollback qualification are incomplete, inconsistent, or non-reproducible.
7. The required fresh independent review is missing or rejects an in-scope property.
8. Production or its release-critical configuration changes after freshness proof.
9. Required progress needs privileged Owner action that has not been authorized.

## Explicitly non-blocking classes

The following do not block unless they mechanically invalidate a frozen contract:

- alternative same-trust import, loader, or `createRequire` spellings already
  closed by the single-authority executable boundary;
- malicious same-trust repository code intentionally reading repository files;
- acceptance-tool formatting, naming, or presentation preferences;
- speculative hardening and generalized capabilities outside this release;
- unrelated application architecture and production-product improvements;
- volatile runtime counters not required to recreate the predecessor.

## Candidate/review rule

Each candidate receives one genuinely fresh independent review. A concrete
in-scope defect may cause no more than one narrow repair. That repair may update
only the defect and exact evidence mechanically invalidated by it. Review cannot
drive repeated candidates or unbounded expansion of acceptance scope.

Independent reviewers consume immutable artifacts and derived summaries. They do
not receive raw authority-reader APIs. The implementation agent may test and
perform hostile self-review, but its results are not independent acceptance.

## Predecessor state model

Predecessor state is partitioned into:

- A — release-critical recreation configuration: deterministically sealed;
- B — mutable application/runtime state: sealed only where rollback explicitly
  promises content restoration;
- C — observational/ephemeral metadata: recorded only when diagnostically useful.

The rollback contract force-recreates Gravity and Telegram through the unchanged
production Compose service definitions plus fixed image overlays. It preserves
and reuses the named Telegram data volume. Therefore the seal binds the volume's
identity and mount configuration, not all mutable content stored inside it.

## Production freeze

Until explicit Owner activation authorization:

- PR #70 stays open and unmerged;
- `main` stays unchanged;
- no production service restart, recreate, activation, or rollback occurs;
- no Docker image, volume, network, Compose, secret, file, DB, migration, or
  application-data mutation occurs;
- no generic Docker/root delegation, shell, or arbitrary-path primitive is added.

## Owner boundary

Source design, implementation, tests, hostile review, deterministic package
build, checksums, policy/registry binding, idempotency, uninstall path, and exact
diff audit are unprivileged preparation. Installing or changing
`/usr/local/sbin/yoko-privileged-runtime` is a privileged control-plane mutation
and requires one checksum-pinned Owner command. Production activation requires a
later, separately authorized checksum-pinned Owner Runtime command.

## Terminal gates

The process stops only at one of these exact gates:

1. `PREDECESSOR OBSERVABILITY CAPABILITY READY — OWNER INSTALLATION REQUIRED`
2. `CURRENT PREDECESSOR BASELINE EVIDENCE READY — INDEPENDENT RE-ACCEPTANCE REQUIRED`
3. `REPLACEMENT CANDIDATE READY — WAITING FOR CURATOR OWNER-RUNTIME AUTHORIZATION`
4. A concrete blocker enumerated above, reported with exact evidence.
