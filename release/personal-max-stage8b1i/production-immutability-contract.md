# Production immutability contract

The probe discovers production only through Docker Engine labels for Compose project `crm`. It snapshots production container IDs, service states, restart counts, production volume inventory, production network inventory, `/opt/crm` HEAD plus porcelain status, and free bytes before and after. No production container, network, volume, image, profile, or service is a mutation target.

Before any image inspection or acquisition, the probe requires production HEAD `e6a0a833fbb756216b058bfe326f9f9c77c4cc6d` and the raw, unsorted stdout SHA-256 of `git -C /opt/crm status --porcelain=v2 --untracked-files=all`, `2958f4cc4849e2248b73cff4d0aa779f33f0008d602bb5294326eb01ba44a60b`. The raw byte stream is hashed through a bounded temporary file so Bash trailing-newline normalization and sorting cannot change its identity. A mismatch is classified `PRODUCTION_GIT_BASELINE_MISMATCH` and stops before `image_acquisition`. The same accepted gate is applied to the after snapshot in addition to the complete before/after snapshot comparison.

The accepted preflight migration-ledger hash is checksum-bound as an attested baseline. The isolated probe deliberately makes zero PostgreSQL connections to production, so it cannot perform a live after-ledger read. Its report names the source exactly as `accepted_preflight_attestation` and records `productionDatabaseConnections=0`; it never presents this static attestation as a live query.

Success requires all live host/Docker/Git hashes to match, all production restart counts to match, the production project to have no Stage 8B1I label, and the script-controlled safety facts `productionDDL`, `productionDML`, `productionMigration`, `restart`, `deploy`, `maxContacted`, and `providerAction` to remain false.

Allowed host mutations are limited to bounded exact-digest image acquisition, uniquely labelled disposable resources, the no-clobber sanitized result, and ephemeral credential/log files removed by the bounded trap. Before and after each acquisition, and after cleanup, the probe enforces the documented storage gates. Accepted images are retained; there is no image prune or generic image removal.
