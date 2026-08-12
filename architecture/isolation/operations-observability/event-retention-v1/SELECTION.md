# CRM-ARCH-007R event retention selection

Selected the complete fixed-policy event-retention slice represented by the one remaining generic dynamic write site in `RetentionCleanup`: `DriverEvent` and `CommunicationEvent` at 180 days/100 rows and `ApiLog` at 30 days/100 rows move to Fleet Operations. Operations and Observability retains scheduling, timeout sequencing, aggregation and logging. The owner commands expose only `dryRun`; table, age, predicate and batch policy cannot cross the public boundary.
