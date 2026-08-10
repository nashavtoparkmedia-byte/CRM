# CRM-ARCH-007R static SQL fragment hardening selection

Status: `PASS_CONTINUE_SOURCE_GATE`

Base evidence commit: `1b949555b92c1202e01b1e55aa10089e7a7e73e7`

Source commit: `024680591c188a34ae79594d92d47854648c73c8`

This final enforcement slice selected all 48 remaining
`direct_foreign_prisma_write` findings. Twenty-one owner-adapter sites were
converted to direct fixed owner-table statements. The other 27 findings were
dynamic fragment builders in nine legacy caller/service files and were
replaced by 35 fixed literal calls covering every closed semantic branch.

The hardening preserves positional bind order, JSONB, array and enum casts,
database timestamps, zero-row results, read-before-write ordering and each
path's existing failure policy. Exhaustive controls cover all 2047 non-empty
retrieval-policy masks and all 1023 non-empty history-job patch masks. The
owner adapters expose no tagged SQL, transaction, arbitrary query or model
delegate capability. Conversation grouping now accepts only contact, driver
or chat selectors.

No context manifest, dependency amendment, schema or production configuration
changes. Strict findings decrease from 1,343 to 1,295. Exactly 48 reviewed
fingerprints retire with zero additions, zero shared semantic changes, zero
line-metadata rebases and zero dependency cycles. The canonical summary
correctly omits the zero-count direct-write key.

This selection was verified through offline source analysis, deterministic
adapter probes and unit/static harnesses only. No database, provider, server
action, deployed runtime, production or real-secret path was executed.
