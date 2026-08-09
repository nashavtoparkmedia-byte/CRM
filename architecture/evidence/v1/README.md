# CRM-ARCH-002 Architecture Evidence Map

This directory contains the deterministic module, dependency, Prisma access,
ownership-candidate, provider, credential, runtime-interaction and hotspot map
derived from the accepted CRM-ARCH-001 baseline.

Rebuild and validate with the sealed unprivileged Node toolchain:

```text
node tools/architecture/analyze-architecture.mjs
node tools/architecture/validate-architecture-evidence.mjs
node --test tools/architecture/__tests__/architecture-evidence.test.mjs
```

`analysis-manifest.json` records all 845 input files, byte counts and SHA-256
digests. The generated artifacts contain paths, names and structural evidence,
not credential values or source snippets.

The ownership rules are candidates for CRM-ARCH-003, not a claim that current
foreign writes are already isolated. `SHARED_AMBIGUOUS` is deliberately
retained for dynamic or multi-owner raw SQL that cannot be attributed without
guessing.
