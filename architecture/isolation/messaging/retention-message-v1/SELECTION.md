# CRM-ARCH-007 Messaging Retention Message selection

Selected the complete 3/3 plan `migration_9fd5889e5d1307c9`. Messaging gains
bounded message deletion and retry-metadata purge commands. Operations &
Observability retains candidate selection, limits, dry-run behavior, ordering,
timeouts and result aggregation through the validated acyclic
`operations_observability -> messaging.public` dependency.
