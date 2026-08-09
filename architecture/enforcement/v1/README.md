# Architecture enforcement v1

CRM-ARCH-006 turns the accepted module manifests and transition plans into a fail-closed source gate. It observes production source only; it does not deploy, migrate data, restart services, or change runtime configuration.

## Gate

Run from the repository root with Node.js 20 or newer:

```sh
node tools/architecture/validate-context-manifests.mjs
node tools/architecture/enforce-architecture.mjs
node tools/architecture/test-architecture-enforcement.mjs
node tools/architecture/check-contract-boundaries.mjs
node tools/architecture/check-outbox-architecture.mjs
```

The enforcement command scans the configured production roots and fails when it finds:

- an unresolved or non-public cross-context import;
- an import of another context's internal module;
- an undeclared context dependency or dependency cycle;
- a contract reference without an explicit `vN` segment;
- a direct foreign Prisma/raw-SQL write;
- provider transport outside the provider-owning context;
- sensitive environment access outside declared credential ownership;
- an unclassified production source file;
- manifest/index identity or checksum drift.

Manifest inconsistency, dependency cycles, contract-version violations, unresolved imports, and unclassified production files cannot be excepted.

## Legacy exception model

The registry contains one entry per exact finding fingerprint. The fingerprint binds rule, file, source context, target context, subject, and same-subject ordinal. No path, context, rule, or glob wildcard is accepted.

The evaluator also fails for an uncovered finding, expired or malformed exception, exception identity mismatch, duplicate fingerprint, or stale exception. Stale failure is intentional: removing debt must remove its exception in the same change, so the old allowance cannot silently admit a later reintroduction.

All entries are owned by the calling context, carry a concrete retirement action, and expire for review on 2026-12-31. The generated registry is reproducible with:

```sh
node tools/architecture/generate-architecture-exceptions.mjs \
  --output architecture/enforcement/v1/exceptions.json
```

Generation refuses any unexceptionable finding or finding type without a reviewed exception policy. The registry baselines 1,535 findings from CRM-ARCH-005: 187 foreign writes, 38 provider transports, 385 internal imports, 542 non-public imports, and 383 undeclared dependencies. Five stricter-scanner write findings absent from the earlier migration-plan extractor are preserved separately in `legacy-write-supplement.json`.

## False-positive controls

Test paths, build output, coverage, and dependencies are excluded from production findings. Imports are resolved to repository files before context comparison. Provider-module enforcement uses provider path evidence only; broad content mentions are not treated as transport access. Direct external SDK imports remain independently enforced. Sensitive names are checked against the calling context's declared environment-name inventory; values are never read or emitted.

The fixture suite mutates every enforced boundary class and proves that new findings cannot pass with the frozen registry. It separately proves expiration, staleness, duplicate, malformed, identity-mismatch, finding-digest, unexceptionable-rule, manifest checksum, and dependency-cycle failures.
