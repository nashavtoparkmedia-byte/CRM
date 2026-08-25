# Installation and validation procedure

The exact-SHA Owner command copies the sealed tar into a root-only temporary
file, verifies its digest, extracts it into a root-only directory and executes
`install.sh` with zero arguments on host `jvxthcorvm`.

The installer accepts only exact Runtime `2.0.0-10` profile
`crm-08b9145945b2-gravity-source-v1`, its installed identities, the valid
36-record audit ending `7f7e4d73…`, and the exact predecessor package SHA at
its fixed root-owned bootstrap-store path. It copies that package into the new
content-addressed store before mutation. A root-owned guard blocks all
release-profile calls throughout `dpkg`. Post-install checks prove Runtime
`2.0.0-10`, the new profile identity,
four enabled operations, disabled database migration, unchanged sudo boundary,
unchanged audit and unchanged Docker provenance. The provenance comparison
requires a complete inventory with an empty failure list and includes the
schema-bound semantic fingerprint plus hashes of every available record's
runtime identity; any failure, missing resource, or fingerprint drift aborts
installation. No profile is invoked.

After an explicitly authorized `release-activate`, the target postdeploy gate
uses only bounded internal HTTP GETs and a bounded recent-log read. Two
consecutive full successes must prove `/api/health` has no delivery, stuck,
retry, recovery, watchdog, or integrity failure; `/api/transport/health` has
the exact sealed inventory of one WhatsApp and one Telegram connection, both
ready with no error, retry, or reconnect in flight; and `/api/messages`
without `chatId` returns exactly HTTP 400 JSON `{"error":"chatId is required"}`.
The existing outbox publisher startup marker remains mandatory and its failure
marker remains forbidden. An empty HTTP-200 transport response, any degraded
transport, or any Messages route-contract drift fails the postcheck inside the
existing automatic rollback boundary; response bodies and log contents are
never emitted as evidence.
