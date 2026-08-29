# CRM-ARCH-007 Contacts Fleet Contact selection

Selected complete 6/6 plan `migration_1920130eec2c7506`. Contacts gains narrow
Fleet-specific patch/create commands through the existing acyclic
`fleet_operations -> contacts.public` dependency. The monitoring decision table,
reads, phone ownership, race recovery and counters remain caller-owned.
