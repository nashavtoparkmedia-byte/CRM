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

## Mobile Push v1 (second flow family, MOBILE-PUSH-V1-P1)

The text above records the CRM-ARCH-005 decision and stays as written. Mobile
Push v1 adds one more asynchronous flow family because it meets the same
criteria the recording flow did:

`Messaging inbound Message persisted -> messaging.InboundMessageNotificationRequested.v1 -> fan-out -> messaging.MobilePushDeliveryRequested.v1 -> FCM`

- **A durable write followed by a lossy side effect.** Today a new inbound
  message is announced by `emitMessageReceived`, a fire-and-forget call made
  after the Message commits and skipped by most inbound paths. A restart in
  that gap loses the announcement. A phone notification built on it would be
  silently lost the same way.
- **Intrinsically asynchronous and replay-safe.** A notification is sent after
  the message is stored and has deterministic identities: one intent per
  Message, one delivery per Message and stable device registration. A retried
  or duplicated event adds no second intent or delivery event. The send itself
  is at-least-once: a relay publish timeout, or a crash after the provider
  accepted the push and before the row is marked published, can send the same
  delivery again. The device therefore deduplicates by message id (the P2
  Android contract).
- **Losing it materially degrades operations.** An operator away from the
  desktop misses a customer message.

The intent is appended in the same transaction as the Message by Messaging's
own three persistence seams. It is not appended by provider adapters or by the
in-process emitter. Per-device delivery reuses the outbox, which already gives
each event its own retry, backoff and dead-letter state, rather than adding a
second queue or a delivery ledger. The provider token is resolved when the
push is sent and is never stored in the event.

Both flows are declared in `outbox-manifest.json` (v2 `flows[]`). They are off
unless `MOBILE_PUSH_ENABLED=true`. The Calling recording flow is unchanged.
The AI-call finalization flow stays under its own recovery authority.
