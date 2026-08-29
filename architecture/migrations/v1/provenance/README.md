# Repository-contained migration provenance

This directory contains immutable byte captures required to validate production
migration authority from a default single-branch checkout. Validation must not
fetch historical branches or read operator-host evidence paths.

- `raw/runtime-20260808T205042Z.json.gz.b64` is deterministic
  `base64(gzip -n)` of the exact predecessor runtime content manifest. The
  manifest contains file metadata (path, size, mode, ownership and digest), not
  file contents; its producer excluded sensitive roots. The validator pins both
  encoded and decoded bytes and derives the 61 Gravity migration records plus
  the physically separate TG migration record from the identified images.
- `schema/*.prisma.gz.b64` contains deterministic compressed captures of the
  three historical schema inputs.
- `git/production-migration-lineage-v1.json` preserves raw commit, tree and
  blob payloads as canonical Base64 plus the exact fetched-ref snapshot. The
  validator recomputes every Git SHA-1 object ID (`type SP size NUL payload`),
  parses commits and binary trees, proves each commit/root-tree-to-path-to-blob
  chain, proves the `introduced_by`/`later_present_at` ancestry claims, and
  compares each terminal blob with its canonical repository SQL capture. This
  is self-contained and does not require historical refs or Git objects in a
  clean checkout. A bare root-tree object is not accepted as authorizing
  provenance. The prior bot-registry root-tree identities remain in each row
  only as supplemental `SUPPLEMENTAL_NON_AUTHORIZING` metadata; their objects
  and claims are no longer part of the authorizing Git-lineage package.
- `root-broker/20260808T122923Z` is the complete original 37-file, secret-safe
  root-broker evidence package. Validation checks the exact package file set,
  its 35-member `SHA256SUMS`, manifest identity, secret-safety report, exact
  broker command/package/hash/host, `/opt/crm` repository and production HEAD,
  and the raw `production-git-state` SHA-256. The three 20260805 migrations
  must be the exact path/mode/SHA-256/size/working-blob rows in its 102-row
  untracked denominator. `root-broker/patches` durably preserves the three
  original patch files; validation extracts each exact addition-only new-file
  migration hunk and requires byte equality with the canonical archived SQL.
- `snapshot/20260808T070726Z` is the complete original secret-safe snapshot
  package. The potential credential-bearing production compose file remains
  excluded exactly as the package manifest declares; its safe metadata record
  is preserved. Validation proves the package file set, canonical sorted
  `PACKAGE_CONTENTS.tsv`, every member hash and size, `PACKAGE_SHA256`, manifest
  continuity records, secret exclusion, and the migration-member-to-row byte
  relationship.

Canonical migration SQL bytes remain in the active Prisma migration directory
or `archive/pre-outbox`; every authority row names and hashes its repository
capture.

`tools/architecture/materialize-production-migration-provenance.mjs` records
these inputs explicitly from a repository that still has the historical Git
objects, the original snapshot root, the independently captured root-broker
package, and the three original patches. It refuses to overwrite different
repository evidence. It is a materialization utility, not a validation
dependency; normal validation is entirely offline from a clean checkout.
