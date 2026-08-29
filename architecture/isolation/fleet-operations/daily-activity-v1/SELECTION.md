# CRM-ARCH-007 Fleet daily-activity selection

Selected `migration_0f4314be5092e299`, the complete one-site Messaging write
to Fleet-owned `DriverDaySummary`. The source first persists its owned
`CommunicationEvent`, classifies four domain activities, and conditionally
upserts the driver's local-day summary. The new contract carries the domain
activity and exact day-start instant; Prisma field names remain owner-side.

Messaging did not previously declare Fleet Operations. The exact
`messaging -> fleet_operations.public` amendment is acyclic. It also makes two
old Inbox `undeclared_dependency` exceptions stale; those exact exceptions are
retired, while all four separate `internal_module_import` and
`non_public_cross_context_import` exceptions for the same legacy Inbox imports
remain active. This slice does not claim those imports have migrated.
