# CRM-ARCH-005 Internal Review 2 — Adversarial Critic

Result: `PASS_CONTINUE_SOURCE_GATE`

The critic attempted to falsify atomicity, replay safety, bounded failure and
protected behavior:

- an outbox append failure rolls the Call update back in the preview fixture;
- identical replays use one deterministic event ID and `skipDuplicates`;
- competing publishers use a compare-and-set claim on ID, state and attempts;
- a crash after claim is recovered after five minutes, while an exhausted
  stale claim becomes a visible dead letter;
- a successful enqueue followed by a persistence failure may be redelivered,
  but the stable BullMQ `transcribe-${callId}` key makes that safe;
- a hung publisher is bounded at five seconds and cannot freeze the sweep;
- unsupported event versions and unregistered event types fail visibly;
- S3 upload still precedes the database transaction, as before. Its object key
  is deterministic and the local WAV remains on transaction failure, so retry
  remains recoverable;
- no conversation-timeline or AI-finalize behavior was changed;
- no credential enters the event contract or stored error text.

An isolated PostgreSQL preview service is not available in this environment.
Therefore the source milestone passes, but production activation explicitly
does not: the exact migration must execute on preview PostgreSQL and the backup,
identity, health and rollback prerequisites must pass before deployment. This
is a deployment gate, not hidden evidence or permission to mutate production.
