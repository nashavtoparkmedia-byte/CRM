# Replacement Release Threat Model

Status: frozen governance v1, 2026-08-26.

## Trust boundary

Repository source and committed release tooling are reviewed same-trust source.
Candidate identity is made immutable by commit SHA, tree SHA, artifact checksums,
and release seals. Process-internal authority APIs are not a security sandbox
against deliberately malicious same-trust code that reads arbitrary repository
files.

Acceptance therefore proves finite ownership, deterministic evidence, and exact
artifact identity. It does not attempt to defend reviewed repository code from
itself. Previously accepted loader/import grammar, Node identity, and
single-authority executable decisions stay closed unless their exact dependency
changes.

## Privileged boundary

The installed `yoko-privileged-runtime` and its root-owned policy, registry,
profile, state, and audit ledger form the privileged boundary. The unprivileged
caller may select only enumerated primitives and logical resources with the exact
argument shapes declared by policy.

Forbidden capabilities include:

- generic command or Docker execution;
- shell execution;
- raw Docker socket delegation;
- arbitrary resource names or filesystem paths;
- caller-controlled Compose files, environment files, images, containers,
  networks, volumes, or output paths;
- production mutation through an observation primitive.

## Predecessor observation

The predecessor observation capability is finite, project-scoped, and read-only.
It may invoke only fixed inspection/config-rendering commands against policy-bound
production resources. It does not start, stop, restart, recreate, pull, build,
tag, remove, connect, disconnect, or modify Docker resources and does not write
production files or volumes.

## Secret handling

Raw secret values never cross the privileged boundary. Environment key names and
bounded non-secret configuration may be emitted. Effective values are checked
internally for exact equality with the fully resolved Compose service; the result
is emitted as a boolean binding together with the already existing Compose
config-hash and secret-free canonical projection identity.

No new unsalted per-value digest is emitted. In particular, low-entropy values
must not become offline guessing oracles. No new persistent HMAC key or secret
design is introduced without an explicit curator decision.

## Availability and volatility

Container IDs and creation timestamps are observational facts used to identify
the captured current predecessor. Volatile counters and mutable application data
are not promoted to release-critical identity unless rollback promises to restore
them. Freshness is checked immediately before sealing and activation preparation.

## Adversarial tests

Tests must reject mutation verbs, unknown resources, non-zero-argument or
path-bearing invocations, raw secret projection, caller-selected Docker objects,
and any command other than the fixed allowlist. Package and installed-file hashes
must fail closed on drift.
