# CRM-ARCH-007 Fleet scoring-threshold selection

Selected migration `migration_56494330426e3744`, the complete one-site
Configuration write into Fleet-owned `ScoringThreshold`. The source action
already presents a command-shaped `Record<string, number>` and has no transport,
credential, runtime, or database-migration coupling. The neighboring read stays
in place; this slice moves only the planned upsert boundary.

The owner manifest did not yet declare a scoring command and Configuration did
not yet depend on Fleet Operations. This slice therefore adds exactly
`UpdateScoringThresholdsCommand.v1` and
`configuration -> fleet_operations.public`. The effective dependency graph is
validated after all prior amendments and remains acyclic.
