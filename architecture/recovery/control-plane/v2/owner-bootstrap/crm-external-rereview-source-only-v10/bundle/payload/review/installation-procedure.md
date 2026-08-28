# Installation and validation procedure

The exact-SHA Owner command copies the sealed tar into a root-only temporary
file, verifies its digest, extracts it into a root-only directory and executes
`install.sh` with zero arguments on host `jvxthcorvm`.

Before staging, the Owner envelope requires at least 10 GiB free. The root tar
and directory have deterministic exact-SHA paths and are securely reconciled
on entry and removed on every normal or error exit. Immediately before `dpkg`,
the installer rechecks a 5 GiB reserve; failure occurs before `new_attempted`
and before package mutation.

The installer accepts only the exact installed Runtime from source
`ae2082d…`: package `9c23ae1a…`, profile
`crm-ae2082d852e3-gravity-source-v1`, wrapper/core/observer/profile/install
manifest/sudoers identities, exact self-check and capabilities, and the valid
36-record audit ending `7f7e4d73…`. The exact `9c23ae1a…` DEB is embedded in
the sealed payload and atomically installed into its fixed root-private
content-addressed store before any `dpkg`. A root-owned guard blocks all
release-profile calls throughout `dpkg`. Post-install checks prove Runtime
`2.0.0-12`, the new profile identity,
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
