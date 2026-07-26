# MAX Personal Gateway — Stages 1–5

This module implements the offline transport foundations through Stage 5: Raw Event Journal, durable Route Registry, shadow inbound normalization, durable per-conversation outbound actors, and the dormant Dispatch Ledger. PostgreSQL is authoritative; Redis, browser state, and MAX authorization are not dependencies.

Each physical observation is immutable and receives a distinct `observationId` and monotonically ordered journal position, even when payload, hash, provider event ID, or timestamp are identical. Mutable processing state is stored separately and unique per `(observationId, parserVersion)`. Consumer cursors are isolated by consumer, account, and parser version.

`append` accepts an already sanitized observation and creates raw evidence plus initial processing state in one transaction. The sanitizer is deterministic, recursive, non-mutating, versioned, and records redaction categories without secret values. The sanitized canonical JSON SHA-256 is correlation evidence, never a deduplication key.

No-loss policy: sanitized payloads over the 1 MiB storage policy are replaced by a safe quarantine envelope while the physical observation, ordering, sanitized size/hash, origin, encoding, redaction evidence, and quarantine reason remain durable. Binary values (`Buffer`, typed-array views, and `ArrayBuffer`) are never persisted as credential-bearing bytes; they receive a deterministic metadata-only envelope containing type, byte length, and SHA-256 and initial processing state `quarantined`. Unsupported objects use the same fail-closed quarantine boundary. A following observation is independent and remains appendable.

Raw `UPDATE` and `DELETE` are unconditionally rejected by the Stage 1 database trigger. A caller-controlled custom PostgreSQL setting is not retention authority. Retention is deliberately not implemented; it requires a later reviewed privileged role or `SECURITY DEFINER` maintenance contract. Processing states are limited to `pending`, `processing`, `completed`, `retryable`, `quarantined`, and `dead_letter` by both the adapter and migration.

`MAX_RAW_JOURNAL_ENABLED` is account-scoped and defaults to false. Stage 1 does not connect the journal to the existing listener, sender, Chromium profile, CRM projection, or any provider action. The additive migration is not applied.

## Stage 2: durable Route Registry

The Route Registry uses `(accountId, conversationKey)` as the stable internal route anchor. Provider user IDs, protocol chat IDs, and web route IDs are exact, account-scoped, versioned evidence; none replaces `conversationKey`. Immutable route observations preserve sanitized evidence and extraction provenance, while durable conflicts make ambiguity visible. There is no last-write-wins reassignment: conflicting routes become non-sendable until an audited, expected-version conflict resolution.

`routeVersion` advances only for semantic routing changes. Exact evidence may create or attach a binding; weak web and legacy evidence stays provisional or confirms only an already exact association. Explicit supersede keeps the old identity as history and uses an optimistic version guard. A sendable snapshot is immutable and requires an active route, one unambiguous active identity of each present kind, mandatory active protocol-chat evidence, and no open conflict.

`MAX_ROUTE_REGISTRY_ENABLED` is an account allowlist and defaults to false. Route matching never uses a CRM name or phone, and Stage 2 does not perform Contact resolution. It has no Redis, Chromium, listener, sender, live MAX integration, or provider action. Migrations remain unapplied.

## Stage 3: shadow inbound normalization

Stage 3 keeps immutable raw observations distinct from immutable semantic output. `MaxInboundNormalizationResult` records one terminal outcome for `(accountId, sourceObservationId, parserVersion)`; `MaxInboundNormalizedEvent` stores zero or more events ordered by `(sourceJournalSequence, eventOrdinal)`. `MAX_INBOUND_NORMALIZER_VERSION` and `NORMALIZED_ENVELOPE_VERSION` are explicit immutable lineage labels. Reprocessing the same observation/version returns the existing result, while another parser version or another physical observation creates independent rows. Provider IDs, payload hashes, semantic hashes, timestamps, and history/live overlap are deliberately non-unique.

The pure normalizer supports text and outbound echoes; JPEG, PDF, MP4, OGG/voice, captions, and multiple attachment descriptors; exact replies; reaction add/remove; honest provider-acceptance, delivery, read, and unknown receipts; exact/weak route evidence; unknown events; and safe malformed quarantine. Attachment fetch references are metadata-only or redacted, media is never downloaded, and one bad attachment does not discard text or other descriptors. Reply and reaction targets use only exact provider message IDs—never text, time, DOM position, names, phone numbers, or an implicit previous message.

The shadow processor claims the existing parser-versioned raw processing state, then atomically inserts the terminal result/events and terminal processing state in PostgreSQL. It reuses the Stage 1 account/parser consumer cursor and advances only after a durable normalized, unsupported, or quarantined result. PostgreSQL remains authoritative; Redis is not a dependency. There is no Contact resolution, CRM projection, Route Registry mutation, media worker, browser navigation, listener/sender wiring, or provider action.

`MAX_INBOUND_NORMALIZER_ENABLED` is a fail-closed account allowlist and defaults to false. The flag is not imported by the existing MAX listener and Stage 3 is shadow/offline only by absence of runtime wiring. The additive migration is exercised only by the disposable real PostgreSQL gate; it is not applied to production.

## Stage 4: durable per-conversation outbound actors

An immutable outbound text command is addressed only by `(accountId, conversationKey)`. PostgreSQL allocates `commandSequence` transactionally on that conversation's actor row, preserving an independent FIFO for every conversation. Exact `commandId` and account-scoped `clientMessageId` retries are idempotent; text, payload hashes, timestamps, names, phones, and route identifiers are never deduplication keys. Consequently identical text with different command/client IDs remains a distinct physical command and its whitespace and Unicode are preserved exactly.

Each actor has an account/conversation-scoped lease, monotonic `leaseEpoch`, optimistic version and durable reservation of only `nextHandoffSequence`. Release or expiry keeps the same FIFO head retryable. Preparation reads the current sendable Route Registry snapshot and returns `physicalSendAuthorized: false`; unresolved, conflicted, retired, missing-protocol, open-conflict, or cross-account routes fail closed. The actor never mutates Route Registry state and never uses an active DOM dialog, global promise tail, global queue, Redis counter, provider identity supplied by a caller, or text/time matching.

Actor lease is not SessionOwner fencing and never authorizes physical provider action. Stage 5 replaces the old standalone `handed_off` boundary with an atomic Dispatch creation/linkage transaction; it remains neither a send nor evidence of MAX acceptance, provider identity, delivery, or read. Stage 4 contains no browser/provider operation, runtime sender/listener integration, retry after physical action, or CRM projection. `MAX_PER_CHAT_OUTBOUND_ACTOR_ENABLED` is a fail-closed account allowlist and defaults to false. PostgreSQL is authoritative and the additive migration is exercised only by the disposable real PostgreSQL gate.

## Stage 5: dormant Dispatch Ledger

Stage 5 separates immutable command intent, one durable Dispatch, and its individually fenced Attempts. The only reservation handoff path is the atomic PostgreSQL `createDispatchFromReservation` transaction: it creates the Dispatch, initial `queued` transition and per-conversation physical FIFO lane, links the reservation by `dispatchId`, and advances the Stage 4 handoff head together. Standalone handoff now fails closed with `DISPATCH_LEDGER_REQUIRED`.

The Dispatch preserves an immutable initial account-scoped route snapshot; every Attempt revalidates Route Registry and pins its own current route and verified sender owner/fencing epoch. Actor lease is not SessionOwner fencing. The default sender-authority verifier denies every Attempt, and even a test-verified prepared Attempt reports `physicalSendAuthorized=false` because this stage has no sender or provider action.

The durable state machine distinguishes queued work, physical dispatch preparation, local-client acceptance, provider-confirmation waiting, reconciliation, exact MAX acceptance, safe retry, hard failure and dead letter. The append-only transition journal and reconciliation tasks contain bounded synthetic identifiers/evidence only, never command text. Unknown or timed-out post-action outcomes require reconciliation and cannot be blindly retried; a late exact provider confirmation updates the same Dispatch. `provider_confirmed` maps to `accepted_by_max`, not recipient delivery or read.

Independent `(accountId, conversationKey)` physical lanes preserve FIFO without a global queue or active-DOM dependency. PostgreSQL is authoritative for Dispatches, Attempts, transitions, reconciliation, restart recovery and provider identity. Redis is not required. `MAX_DISPATCH_LEDGER_ENABLED` is account-scoped and defaults false; it is not wired into existing runtime. Real PostgreSQL migration, state-machine, concurrency, load and recovery gates are required. Stage 6 confirmation matching has not started.

## Disposable real PostgreSQL gate

The opt-in integration suite never reads generic `DATABASE_URL`. It requires
`PERSONAL_MAX_REAL_POSTGRES_URL`, rejects non-local hosts and the default
PostgreSQL port, and requires a database name containing the
`personal_max_...gate` disposable marker. The database must already contain the
Stage 1 through Stage 5 migrations. A normal unit run therefore never opens a
database connection.

When the generated client is not installed at the normal Gravity package
location, an isolated gate harness may also set
`PERSONAL_MAX_REAL_PRISMA_CLIENT` to an absolute generated-client entry point.
All test data uses unique account/run identifiers. Immutable evidence rows are
removed by deleting the disposable database or cluster; the suite never weakens
append-only triggers or drops shared schemas.

```sh
PERSONAL_MAX_REAL_POSTGRES_URL='postgresql://local-user@127.0.0.1:high-port/personal_max_integration_gate' \
  npm run test:real-postgres
```
