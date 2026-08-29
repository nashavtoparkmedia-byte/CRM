# CRM-ARCH-000R continuation evidence

Observation window: `2026-08-08T12:29:23.745165602Z` through
`2026-08-08T12:59:12.762814381Z` on `jvxthcorvm`, executed by `codexbot`.

Verdict: `BLOCKED_PRIVILEGE`. The installed `1.0.2-1` broker self-checks but
cannot provide acceptance-safe current Docker/runtime origin evidence or an
FD-bound production-index identity. A narrowed `1.2.0-1` successor was built,
tested, independently reviewed, reproducibly rebuilt, and mode-sealed without
installation. Its package SHA-256 is
`af6512b446a662734f292fda3f3f861500dd9610657bfd7f9cbfcca4551a9e47`.

Start with:

- `reports/CRM-ARCH-000R-FINAL.md` for the required 20-section report;
- `capability/OWNER_PRIVILEGE_ACTION_REQUIRED.md` for the one exact action;
- `AUTHORITATIVE_SOURCE_MAP.json` and `SOURCE_CLASSIFICATIONS.json` for source conclusions;
- `SHA256SUMS` and `MANIFEST.json` for artifact integrity;
- `MUTATION_LEDGER.md` for authorized writes and confirmed non-mutations.

The checksum file uses a non-circular policy: it includes every regular file in
this continuation tree except `SHA256SUMS` and `MANIFEST.json`. The manifest
records the checksum-file hash and this exclusion explicitly.

The v1 FreeSWITCH component is not present in usable evidence. All 444 records
were quarantined; the sanitized runtime derivative contains zero retained
FreeSWITCH records. No secret value is included in this tree.
