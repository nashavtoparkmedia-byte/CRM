# CRM-ARCH-006 Delegated Technical Gate

Status: `CRM-ARCH-006 PASS_CONTINUE`

Architecture rules are executable and fail closed for production source. The machine-readable policy enforces context import surfaces, dependency declarations and cycles, contract versions, foreign persistence writes, provider transport ownership, credential ownership, manifest identity and source classification.

Verification at `2026-08-09T14:47:31Z`:

- 766 production files and 16 context manifests scanned;
- 1,535 legacy findings bound to 1,535 exact, owned exceptions;
- zero wildcard, uncovered, stale, expired, duplicate or unexceptionable exceptions;
- exact finding digest: `fd80a8a62af89261b3efba431994fadcb0778e10d986088a8f1f06a1ba2e43de`;
- reproducible registry SHA-256: `a4c8d9852e389d4cff01e696832ab3049296832e3e4e26b246fb928fe27ef8b7`;
- five stricter-scanner foreign writes preserved by an exact supplemental ledger;
- 16/16 enforcement tests PASS, including all negative exception paths and mutation classes;
- 16 manifests, eight controls and two transition outputs pass checksum validation;
- 14/14 contract-boundary controls and 11/11 contract tests PASS;
- 14/14 outbox controls and 16/16 outbox tests PASS;
- 93/93 protected Calling tests PASS;
- TypeScript diagnostic parity: 28 inherited, 28 candidate, zero new signatures;
- node syntax, JSON, workflow YAML, secret-pattern and diff checks PASS;
- executor and adversarial critic reviews PASS;
- production/runtime/database/deployment/protected-worktree mutations: NONE.

The pull-request and main-push workflow runs the fail-closed manifest, enforcement, mutation, contract and outbox controls with read-only repository permission.

Delegated source decision: continue automatically to CRM-ARCH-007 incremental context isolation. CRM-ARCH-005 production outbox activation remains separately `NOT_AUTHORIZED_YET`; this gate does not deploy or authorize it.
