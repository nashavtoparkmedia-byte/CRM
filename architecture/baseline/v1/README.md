# CRM-ARCH-001 Authoritative Baseline

This baseline is a machine-readable index of accepted source and artifact
authorities. It deliberately does not claim that one Git commit represents all
of production.

The architecture branch starts at `ee93f8e2…` because it is a clean integration
substrate. Production authority remains composite and is represented by:

* production HEAD `e6a0a833…`;
* the exact 81-modified/4-deleted production working-set evidence;
* the immutable 28-entry production-only snapshot (27 exact contents and one
  secret-safe metadata-only Compose record);
* module-specific release lineages;
* current immutable runtime/image identities;
* protected Messages and AI Calls lifecycle records.

The production-only snapshot is not overlaid onto this branch. It remains an
immutable checksummed preservation source and must be imported file-by-file by
the owning migration slice. This keeps preservation distinct from acceptance
or activation.

Validate with:

```text
node tools/architecture/validate-baseline.mjs
node --test tools/architecture/__tests__/baseline.test.mjs
```
