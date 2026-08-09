# CRM-ARCH-007 Contacts Fleet ContactPhone selection

Selected complete 4/4 plan `migration_3a25fc02145eb8cf`. Contacts gains
deactivate and create ContactPhone commands through the existing acyclic
`fleet_operations -> contacts.public` dependency. Fleet matching, ambiguity,
race recovery, counters and Contact orchestration remain caller-owned.
