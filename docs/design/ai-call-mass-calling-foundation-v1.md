# AI call mass-calling foundation v1

## Status and boundary

This design extends the existing `calling` context. It does not create a new
bounded context, public product API, UI, provider integration, or generic job
framework.

The persistence migration is source/isolated-only at
`architecture/isolation/calling/ai-call-mass-calling-v1/migration.sql`.
It is deliberately not in the production Prisma migration directory and the
runtime is not bound into production startup. The sealed production migration
authority remains unchanged. A later production stage must authorize and apply
an equivalent expand-only migration before wiring this runtime.

## Durable model

- `AiCallCampaign` owns lifecycle, schedule, retry/admission policy, the frozen
  audience fingerprint, and campaign-level rate state.
- `AiCallCampaignMember` is the immutable bounded target snapshot plus current
  durable progress. `(campaignId, targetType, targetRef)` prevents duplicate
  logical membership.
- `AiCallCampaignAttempt` owns a deterministic attempt and provider-neutral
  `launchId`. A reclaimed worker reuses the same attempt/launch identity.
- `AiCallAdmissionControl` serializes the global concurrency and rate decision.
- `AiCallAdmissionLease` owns recoverable global/campaign capacity. Unique
  `attemptId` prevents one attempt from holding two slots.

Essential selection state is typed and indexed. JSON is used only for bounded
snapshot provenance, never for scheduling, claims, admission, retries, or
terminal progress.

## Execution sequence

1. Create a deterministic draft.
2. Materialize and freeze a bounded audience snapshot.
3. Schedule in UTC.
4. Concurrent schedulers use `FOR UPDATE SKIP LOCKED` to start due campaigns.
5. Concurrent workers claim a fresh/due member or reclaim the same stale
   attempt with a higher claim revision.
6. Admission locks the global controller and campaign row in a fixed order,
   removes expired leases, checks global/campaign capacity, and advances the
   independent global/campaign rate gates atomically with the lease.
7. A provider-neutral dial adapter receives the deterministic `launchId`.
8. For the controlled synchronous adapter, recording provider acceptance and
   its terminal result is one database transaction; there is no committed
   `running`-without-result crash gap.
9. The attempt result releases capacity and moves the member to success,
   bounded retry, permanent failure, or cancellation.
10. Campaign progress is derived from durable member state and the campaign
   becomes completed/cancelled only after all members are terminal.

## Recovery and fencing

- Scheduler replay is a conditional state transition.
- Claim tokens contain the monotonic claim revision and fence stale workers.
- A crash before provider execution reclaims the same attempt.
- A crash after provider acceptance also reclaims the same attempt and reuses
  the same `launchId`; provider adapters must make that identity idempotent.
- Expired admission leases are recovered while holding the global admission
  lock.
- Exact terminal result replay is accepted; a conflicting result identity or
  payload is rejected.
- Pause prevents new claim/admission. Cancellation cancels pending, waiting,
  claimed, and retrying work and fences new launches; already-running work
  settles the cancelling campaign.

## Cross-domain boundary

The foundation accepts already-bounded, provider-neutral target snapshot data.
It does not query Contacts or Fleet tables and does not write foreign business
data. Existing single-recipient public queries remain unchanged. A future
product-surface goal must resolve how users select large dynamic audiences; it
must not bypass an absent owner contract with Prisma or raw SQL.
