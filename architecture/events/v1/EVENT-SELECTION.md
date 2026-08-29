# CRM-ARCH-005 event selection

Only one new asynchronous integration flow is justified in this milestone:

`Calling recording persisted -> calling.RecordingReady.v1 -> transcription queue`

The existing implementation first committed `Call.recordingPath`, then made a
separate best-effort Redis enqueue. A crash, timeout or Redis outage in that
gap left a durable recording with no automatic transcription. The operation is
intrinsically asynchronous, replay is safe, and losing it materially degrades
call review and downstream analysis. It therefore benefits from a
transactional outbox.

The domain update and outbox append now share one database transaction. The
publisher uses compare-and-set claims, a 25-event batch cap, a five-second
delivery timeout, five bounded attempts, stale-claim recovery and visible
`dead_letter` state. The consumer validates `RecordingReady.v1`; BullMQ's
stable `transcribe-${callId}` job ID makes redelivery idempotent.

Flows deliberately not eventified:

- CreateTask remains a synchronous owner command because the producer needs
  the created task ID and title immediately.
- AI-call conversation timeline events remain best-effort observability; they
  are not an integration dependency and their protected behavior is unchanged.
- Reporting continues to read current models until a measured projection need
  justifies asynchronous staleness and operational cost.
- The AI-call fallback analysis enqueue remains unchanged in this slice; the
  recording-to-transcription gap is smaller, independently recoverable and
  sufficient to prove the pattern without broad protected-module rewiring.

This prevents CRM-ARCH-005 from turning the modular monolith into an accidental
distributed system.
