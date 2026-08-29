# CRM-ARCH-005 Internal Review 1 — Executor

Result: `PASS_WITH_CORRECTIONS_APPLIED`

The implementation selected the recording-ready to transcription handoff
because the old domain-write/Redis-enqueue gap could lose material work. It
left synchronous Task creation, best-effort conversation telemetry and current
reporting reads out of the event layer.

Review corrections strengthened reliability and security:

- the publisher now imposes a five-second per-delivery timeout so a BullMQ
  offline queue cannot stall the only sweep forever;
- error persistence redacts bearer tokens, credentialed URLs and common
  token/key/secret query parameters before applying the 1000-character cap;
- exhausted stale claims and already-exhausted waiting rows move to
  `dead_letter` instead of becoming permanently unclaimable;
- the five-attempt invariant is shared between the writer, store and publisher;
- the platform composition root was separated from provider-neutral outbox
  infrastructure;
- the Calling owner exposes its atomic operation through a public facade, so
  the prior internal-import boundary check remains green.

The exact migration is expand-only and Prisma validates the schema. Sixteen
transaction/publisher preview tests, fourteen outbox controls, fourteen
contract-boundary controls and 93 protected Calling tests pass.
