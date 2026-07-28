# Bounded rollback contract

Rollback is never automatic because an unexpected failure first requires evidence review. The separate checksum-bound script verifies the exact Stage 8B2B labels, records only a hash of dormant logs, snapshots production `crm` containers before and after, and runs Compose down only for project `personal-max-stage8b2b`. It removes no image, volume, production network, scraper, database, or profile; it performs no prune and preserves root-owned lifecycle configuration plus sanitized reports.
