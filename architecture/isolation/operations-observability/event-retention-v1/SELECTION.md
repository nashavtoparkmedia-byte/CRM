# CRM-ARCH-007R event retention selection

Selected the complete fixed-policy event-retention slice represented by the one remaining generic dynamic write site in `RetentionCleanup`: `DriverEvent` 180 days/100 rows moves to Fleet Operations, `CommunicationEvent` 180 days/100 rows moves to Messaging, and `ApiLog` 30 days/100 rows moves to Fleet Operations. Operations and Observability retains scheduling, timeout sequencing, aggregation and logging. The owner commands expose only `dryRun`; table, age, predicate and batch policy cannot cross the public boundary.
