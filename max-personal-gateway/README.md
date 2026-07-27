# MAX Personal Gateway — Stages 1–8A

This module implements the offline transport foundations through Stage 7: Raw Event Journal, durable Route Registry, shadow inbound normalization, durable per-conversation outbound actors, dormant Dispatch Ledger, exact provider-confirmation matcher, and shadow semantic comparison/replay. PostgreSQL is authoritative; Redis, browser state, and MAX authorization are not dependencies.

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

Independent `(accountId, conversationKey)` physical lanes preserve FIFO without a global queue or active-DOM dependency. PostgreSQL is authoritative for Dispatches, Attempts, transitions, reconciliation, restart recovery and provider identity. Redis is not required. `MAX_DISPATCH_LEDGER_ENABLED` is account-scoped and defaults false; it is not wired into existing runtime. Real PostgreSQL migration, state-machine, concurrency, load and recovery gates are required.

## Stage 6: exact provider confirmation matcher

Stage 6 persists every physical normalized confirmation observation as immutable `MaxProviderConfirmationEvidence`, keyed idempotently only by `(accountId, sourceNormalizedEventId, matcherVersion)`. History, live and reconnect copies remain separate evidence rows even when `providerMessageId`, exact correlation and payload are identical. The version labels are `max-provider-confirmation-matcher-v1` and `max-provider-confirmation-evidence-v1`. Evidence is distinct from the canonical confirmation effect: any number of physical evidence rows may link to one account-scoped Dispatch, but the Stage 5 partial unique provider identity, one append-only confirmation transition and one lane advance permit only one canonical effect.

Positive acceptance uses exact opaque identifiers only. An outbound echo or provider-acceptance receipt requires an exact `providerMessageId` plus byte-exact `attemptCorrelationId` or provider-returned `clientMessageId`. Values are never trimmed, coerced, case-folded, prefix matched or substring matched. Message text, timestamp proximity, time windows, DOM position, previous-message position, Contact name and phone are not candidate inputs. If exact keys disagree, the durable resolution is `ambiguous`; there is no priority winner. Manual resolution requires an audited actor, reason and expected optimistic version.

Matching is account-scoped. Pinned `protocolChatId` and `providerUserId` are higher-authority route guards and mismatch fails closed; `webRouteId` drift is diagnostic only after stronger exact identity agrees. The matcher never mutates Route Registry. Normal `awaiting_confirmation`, early `sent_to_provider_client`, physically marked `dispatching`, and late `reconciliation_required` confirmations all call the same transaction-scoped Stage 5 primitive. Evidence, decision audit, Dispatch/Attempt update, reconciliation closure, provider identity, transition, lane advance and matched resolution commit atomically. A duplicate links its canonical evidence without repeating any effect. Deferred evidence remains durable and may be explicitly reprocessed after its prerequisite state becomes durable.

`provider_confirmed` means accepted by MAX, never delivered or read by the recipient. Provider-acceptance receipts may confirm only with exact correlation. Delivery and read receipts are stored independently and may link to an already confirmed Dispatch, but their Stage 6 capability matrix has `impliesProviderAcceptance=false`, does not change the Dispatch state and does not introduce delivered/read states. Unknown or malformed receipts have no positive effect.

Provider absence is not inferred from timeout, missing echo, empty cache, DOM absence or text search. `ProviderAbsenceEvidenceVerifier` is a strict domain boundary whose default implementation denies everything. Only verified exact synthetic/domain evidence can call the transaction-scoped Stage 5 absence primitive; it closes reconciliation and permits `retryable_failed` without creating a retry Attempt. Stage 6 performs no provider history query.

The resolution states are `pending`, `deferred`, `matched`, `duplicate`, `unmatched`, `ambiguous`, `ignored` and `quarantined`; every automatic or manual mutation has append-only `MaxProviderConfirmationDecision` audit. `MaxProviderConfirmationCursor` orders by `(sourceJournalSequence, eventOrdinal)` and is isolated by `(consumerId, accountId, matcherVersion)` with monotonic optimistic updates. PostgreSQL remains authoritative; Redis is not imported.

`MAX_PROVIDER_CONFIRMATION_MATCHER_ENABLED` is a fail-closed exact account allowlist and defaults false. No existing runtime imports the matcher. Stage 6 contains no listener, sender, browser, Chromium, provider network call, live integration or provider action. Stage 7 remains an independent offline layer described below.

Stage 6 acceptance semantics 1–131 are explicitly mapped to executable proof: evidence preservation 1–9 → `S6-DB-02`, `S6-DB-03`, `S6-DB-11`, `S6-DB-13`; eligibility 10–20 → `confirmationEvidence.test.ts`; exact correlation 21–31 → `S6-DB-01`, `S6-DB-05`, `S6-LOAD-02`; account/route isolation 32–42 → `S6-DB-06`, `S6-CONC-04`, `S6-LOAD-03`; normal/late/early/terminal effects 43–70 → `S6-DB-01`, `S6-DB-04`, `S6-DB-15`, `S6-CONC-02`, `S6-CONC-03`; duplicate evidence 71–75 → `S6-DB-03`; deferred processing 76–81 → `S6-DB-07`; ambiguity 82–88 → `S6-DB-05`, `S6-DB-14`, `S6-CONC-01`; absence 89–98 → absence unit proof and `S6-DB-09`; receipts 99–104 → receipt unit proof, `S6-DB-08`, `S6-DB-18`; transaction safety 105–112 → `S6-DB-16` plus Stage 5 transaction regression; cursor/restart 113–121 → `S6-DB-10`, `S6-DB-17`, `S6-CONC-05`; feature/independence 122–131 → feature and source-contract unit proofs. The load gates are `S6-LOAD-01` through `S6-LOAD-04`.

## Stage 7: shadow semantic comparison and deterministic replay

Stage 7 is an offline harness over immutable Raw Event Journal observations. A side-effect-free legacy semantic adapter and the exact Stage 3 `max-inbound-normalizer-v1` process the same sanitized observation independently. Their outputs are converted into `max-shadow-comparison-v1`, a comparison-only canonical form containing exact semantic identities, presence flags, ordered media descriptors, and SHA-256 values for text/caption—never the text, caption, signed URL, cookie, token, or authorization value itself.

Alignment is deterministic by source `eventOrdinal` and exact ordered attachment/route ordinals. Text similarity, timestamp proximity, DOM position, previous-event fallback, identifier coercion, and missing-ID approximation are forbidden. Ambiguous alignment remains an explicit regression. Physical history/live/reconnect duplicates remain separate results because the durable key uses the raw `sourceObservationId`.

The versioned expected-difference policy contains narrow rules with exact path, input predicate, legacy value, new value, rationale, and severity downgrade. It covers arbitrary ACK correction, unresolved reply targets, null missing provider IDs, secret-reference redaction, metadata-only media, durable unsupported/quarantine outcomes, and rejection of name/phone route authority. Unknown value pairs are regressions; the policy cannot auto-accept a false provider confirmation.

PostgreSQL stores `MaxShadowComparisonRun`, one immutable `MaxShadowComparisonResult` per run/version/observation, append-only `MaxShadowSemanticDiff` rows, and a run/account/version-scoped monotonic cursor. Result, all diffs, and exact run counters commit in one transaction. Cursor progress follows only a durable result. Restart uses PostgreSQL without Redis or process-global state. Readiness metrics expose coverage, classification counts, critical routing/provider/reply/reaction/media mismatches and deterministic replay, but never claim production readiness.

`MAX_SHADOW_COMPARISON_ENABLED` is an exact account allowlist and defaults false. No existing runtime imports the flag or comparison module. Stage 7 performs no listener wiring, browser/profile action, provider request/send, Route Registry mutation, CRM projection, media download, deploy, or production database access.

## Stage 8A: durable live raw capture bridge foundation

The authoritative physical boundary is the existing `TransportInterceptor._handleFrame` call reached from the one existing `window.__maxWsReceive` bridge. Capture runs once there, before msgpack/JSON semantic handling. Internal bridge diagnostics are excluded; binary, malformed, unknown, history, and live frames are still represented. `onRawFrame`, `MessageSync`, and `InitialHistorySync` are downstream and are deliberately not capture hooks. The existing CDP incoming listener remains disabled, no second WebSocket listener or browser context is added, and the gateway never opens MAX Web.

Every physical observation receives a random `captureEnvelopeId` at that boundary. It is persisted unchanged through retry and is not derived from content, `payloadSha256`, provider ID, frame ID, sequence, or time. The envelope is immutable and versioned (`captureEnvelopeVersion=1`, `max-live-capture-adapter-v1`). Session generation is created at enabled adapter startup; socket generation advances on the existing bridge's `ws_created` diagnostic. Opcode 49/71 is classified as history, known other opcodes as live, and malformed frames as unknown.

Sanitization precedes every durable append and follows the Stage 1 `max-raw-sanitizer-v1` contract. JSON payloads retain deterministic sanitized content; Authorization, Cookie, credential keys, bearer values, private keys, and signed URL query secrets are redacted. Binary/msgpack bytes are never written: the spool stores metadata-only quarantine evidence with byte length and SHA-256. A sanitizer/shape failure becomes a quarantine envelope rather than silently destroying the observation.

The local spool uses owner-only directories (`0700`) and files (`0600`), append-only JSONL segments, per-record SHA-256 checksums, bounded records/total bytes, synchronous write plus `fsync` before return, deterministic sequence order, an atomically replaced acknowledged watermark, corrupt-segment quarantine, and compaction only after contiguous journal ACK. Restart scans the segments and resumes unacknowledged records. PostgreSQL becomes authoritative only after ingress ACK; the spool is temporary delivery state, not a second permanent journal.

`PrismaRawCaptureIngress` writes the raw row and initial parser processing row transactionally. The additive nullable `captureEnvelopeId` field has a partial unique index on `(accountId, captureEnvelopeId)` only. A retry returns the existing `observationId`; a distinct envelope with identical content/provider identity creates another raw row. Historical Stage 1 rows remain valid. No uniqueness exists on payload hash, provider ID, frame ID, sequence, timestamp, or text.

`CaptureDrainWorker` has bounded batches/concurrency, exponential retry with bounded jitter, no busy loop, and contiguous ACK ordering. Later successes behind a failed record may be retried; ingress idempotency makes that safe. Health reports disabled/healthy/degraded/critical plus pending count/bytes/age, ACKs, retries, rejects, quarantines, loss before spool, last ACK/error, envelope collisions, and idempotent retries without message text or provider-ID labels.

Legacy behavior is intentionally fail-open: a capture exception never blocks or reorders existing message processing. The honest boundary is that a full or failed disk can lose a physical observation while legacy processing continues. That failure increments `lostBeforeSpoolCount`, marks capture critical, and must fail a Stage 8B canary. No implementation may claim absolute no-loss under total disk failure. Stage 8B acceptance requires this counter to remain zero.

`MAX_PERSONAL_LIVE_CAPTURE_ENABLED` is an exact account allowlist and defaults false; boolean values, wildcard, malformed lists, missing account, or invalid configuration remain disabled. Disabled construction is a Noop adapter with no directory, filesystem write, timer, network, database connection, or log. Stage 8A does not enable the flag, apply the migration, build an image, deploy, restart, launch Chromium, contact MAX, send a provider action, or modify CRM projection.

### Stage 8B deployment contract (not executed)

Stage 8B requires reviewed immutable image digests, the 53-migration chain including `20260727154647_add_max_capture_ingress`, a dedicated owner-readable spool mount, authenticated internal ingress wiring, and explicit user approval. Required environment names (values are never committed) are:

- `MAX_PERSONAL_ACCOUNT_ID`
- `MAX_PERSONAL_LIVE_CAPTURE_ENABLED`
- `MAX_PERSONAL_CAPTURE_SPOOL_PATH`
- `MAX_PERSONAL_CAPTURE_SPOOL_MAX_BYTES`
- the separately reviewed internal ingress address and authentication-secret variables selected by Stage 8B

The spool path must be absolute, owned by the runtime account, directory mode `0700`, files `0600`, capacity-monitored, and preserved across capture-owner restart. The ingress must be internal-only and authenticated; Stage 8A deliberately chooses an injected direct-DB interface for isolated tests and contains no generic database URL fallback or production secret. Stage 8B must bind that interface through the reviewed deployment topology without opening an external unauthenticated endpoint.

Readiness gates are: exactly one browser/profile owner and receive listener; migration present; disabled zero-side-effect proof; capture/journal loss and collision counters zero; spool below warning threshold; recent journal ACK; no drain error; synthetic hook-to-comparison pass; and rollback rehearsal. Rollback is `disable flag → stop drain → preserve spool → existing runtime continues`; it must not delete pending segments. A second browser owner is prohibited. No Stage 8B deploy occurs without a separate approval.

## Disposable real PostgreSQL gate

The opt-in integration suite never reads generic `DATABASE_URL`. It requires
`PERSONAL_MAX_REAL_POSTGRES_URL`, rejects non-local hosts and the default
PostgreSQL port, and requires a database name containing the
`personal_max_...gate` disposable marker. The database must already contain the
Stage 1 through Stage 8A migrations. A normal unit run therefore never opens a
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
