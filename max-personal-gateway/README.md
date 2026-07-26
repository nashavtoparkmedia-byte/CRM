# MAX Personal Gateway — Stages 1–2

This module implements only the Raw Event Journal foundation. PostgreSQL is authoritative; Redis, browser state, and MAX authorization are not dependencies.

Each physical observation is immutable and receives a distinct `observationId` and monotonically ordered journal position, even when payload, hash, provider event ID, or timestamp are identical. Mutable processing state is stored separately and unique per `(observationId, parserVersion)`. Consumer cursors are isolated by consumer, account, and parser version.

`append` accepts an already sanitized observation and creates raw evidence plus initial processing state in one transaction. The sanitizer is deterministic, recursive, non-mutating, versioned, and records redaction categories without secret values. The sanitized canonical JSON SHA-256 is correlation evidence, never a deduplication key.

No-loss policy: sanitized payloads over the 1 MiB storage policy are replaced by a safe quarantine envelope while the physical observation, ordering, sanitized size/hash, origin, encoding, redaction evidence, and quarantine reason remain durable. Binary values (`Buffer`, typed-array views, and `ArrayBuffer`) are never persisted as credential-bearing bytes; they receive a deterministic metadata-only envelope containing type, byte length, and SHA-256 and initial processing state `quarantined`. Unsupported objects use the same fail-closed quarantine boundary. A following observation is independent and remains appendable.

Raw `UPDATE` and `DELETE` are unconditionally rejected by the Stage 1 database trigger. A caller-controlled custom PostgreSQL setting is not retention authority. Retention is deliberately not implemented; it requires a later reviewed privileged role or `SECURITY DEFINER` maintenance contract. Processing states are limited to `pending`, `processing`, `completed`, `retryable`, `quarantined`, and `dead_letter` by both the adapter and migration.

`MAX_RAW_JOURNAL_ENABLED` is account-scoped and defaults to false. Stage 1 does not connect the journal to the existing listener, sender, Chromium profile, CRM projection, or any provider action. The additive migration is not applied.

## Stage 2: durable Route Registry

The Route Registry uses `(accountId, conversationKey)` as the stable internal route anchor. Provider user IDs, protocol chat IDs, and web route IDs are exact, account-scoped, versioned evidence; none replaces `conversationKey`. Immutable route observations preserve sanitized evidence and extraction provenance, while durable conflicts make ambiguity visible. There is no last-write-wins reassignment: conflicting routes become non-sendable until an audited, expected-version conflict resolution.

`routeVersion` advances only for semantic routing changes. Exact evidence may create or attach a binding; weak web and legacy evidence stays provisional or confirms only an already exact association. Explicit supersede keeps the old identity as history and uses an optimistic version guard. A sendable snapshot is immutable and requires an active route, one unambiguous active identity of each present kind, mandatory active protocol-chat evidence, and no open conflict.

`MAX_ROUTE_REGISTRY_ENABLED` is an account allowlist and defaults to false. Route matching never uses a CRM name or phone, and Stage 2 does not perform Contact resolution. It has no Redis, Chromium, listener, sender, live MAX integration, or provider action. Migrations remain unapplied. The combined real PostgreSQL gate is pending because disposable PostgreSQL binaries are unavailable; it is mandatory before Stage 3 live/shadow integration. Stage 3 has not started.
