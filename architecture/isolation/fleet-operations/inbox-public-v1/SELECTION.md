# CRM-ARCH-007 Fleet Inbox public-surface selection

Selected the two remaining Inbox-to-Fleet internal imports, represented by four
exact `internal_module_import` and `non_public_cross_context_import`
exceptions. The preceding daily-activity slice already approved the acyclic
Messaging-to-Fleet dependency; this slice changes only the target surfaces.

`SegmentBadge` becomes canonical versioned public UI with the legacy path as a
thin re-export. Manager-call invocation gets a versioned, validated public
compatibility action. The underlying `drivers/actions.ts` implementation stays
byte-identical because its Fleet/CommunicationEvent persistence decomposition
is a separate multi-owner migration. The compatibility status is explicit and
does not claim that persistence has moved.
