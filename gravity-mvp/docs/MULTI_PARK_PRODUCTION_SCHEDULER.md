# Multi-Park Production Scheduler

The production DriverProfile scheduler has one canonical registration path in
`src/instrumentation.ts`.

- Job id: `multi-park-driver-profiles-nightly`
- Cron: `0 3 * * *`
- Timezone: `Asia/Yekaterinburg`
- Startup behavior: register the next run only; do not sync at startup
- Lock: database-backed lease in `SyncStatus`, owner-token guarded, four-hour stale timeout
- Identity: `(externalParkId, externalDriverProfileId)` only
- Park order: all enabled approved ParkConnection rows, processed sequentially

The legacy hourly server-time interval is not registered. Manual Yandex sync
uses the same composite DriverProfile runner and the same persistent lock.
The old `/api/cron/sync-trips` endpoint returns `410 legacy_scheduler_disabled`
and cannot act as a second external scheduler.
Contact matching, Contact merge, and automatic attachment by phone or name are
outside this job and are not performed by it.

On a failed source read, the affected park's DriverProfile rows are left as-is.
Other parks continue. `lastSuccessfulSyncAt` advances only after a complete
source read and successful writes for that park.
