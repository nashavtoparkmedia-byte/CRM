# Production immutability contract

The probe discovers production only through Docker Engine labels for Compose project `crm`. It snapshots production container IDs, service states, restart counts, production volume inventory, production network inventory, `/opt/crm` HEAD plus porcelain status, and free bytes before and after. No production container, network, volume, image, profile, or service is a mutation target.

The accepted preflight migration-ledger hash is checksum-bound as an attested baseline. The isolated probe deliberately makes zero PostgreSQL connections to production, so it cannot perform a live after-ledger read. Its before/after report repeats that attested baseline only when the no-production-DB-connection guard remains true. This resolves the stricter prohibition on production database connections without pretending that a new catalog query occurred.

Success requires all live host/Docker/Git hashes to match, all production restart counts to match, the production project to have no Stage 8B1I label, and the script-controlled safety facts `productionDDL`, `productionDML`, `productionMigration`, `restart`, `deploy`, `maxContacted`, and `providerAction` to remain false.

Allowed host mutations are limited to exact-digest image acquisition, uniquely labelled disposable resources, the no-clobber sanitized result, and ephemeral credential/log files removed by the trap.
