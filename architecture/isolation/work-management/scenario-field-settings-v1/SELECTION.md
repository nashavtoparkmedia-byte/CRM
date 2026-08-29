# CRM-ARCH-007R scenario-field-settings selection

Status: `PASS_CONTINUE_SOURCE_GATE`

Base commit: `297bc2700eec77e2a06fbdfee4b57867650ba719`

Source commit: `b1f911b7b17273363df764d6e312a40c9f0fa8fc`

Selected the Architecture Lead's accepted D2 closure for
`scenario_field_settings`: reassign the table from Configuration to Work
Management, place get/upsert/reset behind a strict Work v1 public surface and
migrate the Configuration actions and client types away from Work internals.

The existing Work reader and merge policy remain intact. Owner writes use two
private fixed positional SQL statements so the fail-closed parser can prove
the table target without exposing SQL, table, predicate or transaction input.
Configuration gains exactly `work_management.public`; Work gains no reverse
edge and the graph retains zero cycles.

Fourteen findings retire directly from the migrated imports and writes. The
accepted context edge also retires twelve redundant undeclared-dependency
findings on pre-existing Configuration-to-Work imports; their twenty-four
internal/non-public protections remain. The final exact delta is 1,407→1,381,
with zero additions and zero semantic changes among shared entries.

This is a source-only gate. No database, provider, runtime, service,
deployment, production or secret-bearing path was accessed or mutated.
