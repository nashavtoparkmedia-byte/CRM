// Append-only AiCallEvent inserter — Conversation Intelligence Layer v1.
//
// Why this exists
// ───────────────
// The Conversation Intelligence Layer design (docs/design/conversation-
// intelligence-layer.md) makes the trajectory of an AI-call observable
// by emitting structured events at signal-bearing moments. This module
// is the WRITE PATH for those events. Reads happen via raw Prisma /
// SQL — no read API surface here.
//
// Architectural constraints (architect-mandated, "keep it boring")
// ────────────────────────────────────────────────────────────────
//   - Append-only insert. No update, no upsert, no delete.
//   - Best-effort emission. Insert failure NEVER throws to the caller.
//   - No transaction coupling. The Call.update in finalize completes
//     FIRST and commits; this helper runs AFTER, in its own transaction.
//     Event-insert failure cannot roll back the outcome write.
//   - Event layer must NOT break the call. A Postgres outage, schema
//     drift, or invalid event payload must surface as a logged warning
//     and a returned `errored: true` flag — never as a thrown exception.
//
// Out of scope
// ────────────
//   - Derived event computation (e.g., `pre_greeting_hangup`): later PR
//   - Real-time fan-out / SSE: no
//   - Event-sourced rebuild of `Call` state: no
//   - Bulk export / replay tooling: no
//
// Mirror of PR #54's recording-upload-retry.js shape: pure CommonJS,
// DI'd Prisma client + opsLog, single-purpose, test-seam factory.

'use strict'

// Allowed event types. Every type added needs (a) the enum extended
// via an ALTER TYPE migration, (b) a documented payload shape in
// docs/design/conversation-intelligence-layer.md.
//
//   v1 (PR #59):  greeting_started / first_real_user_speech /
//                 silence_strike / call_completed
//   v2 (PR #60):  + stt_suspicious_pattern
//   v3 (PR #61):  + recovery_attempted
const ALLOWED_TYPES = Object.freeze(new Set([
    'greeting_started',
    'first_real_user_speech',
    'silence_strike',
    'call_completed',
    'stt_suspicious_pattern',
    'recovery_attempted',
]))

/**
 * Validate one event row's shape. Returns either { ok: true, row }
 * (ready for createMany) or { ok: false, code, got } (skipped).
 */
function validateEvent(e, callId) {
    if (!e || typeof e !== 'object') {
        return { ok: false, code: 'not_an_object', got: e }
    }
    if (!ALLOWED_TYPES.has(e.type)) {
        return { ok: false, code: 'unknown_type', got: e.type }
    }
    if (typeof e.seq !== 'number' || !Number.isInteger(e.seq) || e.seq < 0) {
        return { ok: false, code: 'invalid_seq', got: e.seq }
    }
    // occurredAt is optional — defaults to NOW in the DB. If provided
    // as a string, coerce to Date; reject if unparseable.
    let occurredAt
    if (e.occurredAt) {
        const d = new Date(e.occurredAt)
        if (Number.isNaN(d.getTime())) {
            return { ok: false, code: 'invalid_occurredAt', got: e.occurredAt }
        }
        occurredAt = d
    } else {
        occurredAt = new Date()
    }
    // Payload must be a plain object or null. Arrays and primitives
    // are rejected — they don't fit the per-type payload schemas.
    let payload = null
    if (e.payload !== undefined && e.payload !== null) {
        if (typeof e.payload !== 'object' || Array.isArray(e.payload)) {
            return { ok: false, code: 'invalid_payload_shape', got: typeof e.payload }
        }
        payload = e.payload
    }
    return {
        ok: true,
        row: {
            callId,
            type: e.type,
            seq: e.seq,
            occurredAt,
            payload,
        },
    }
}

/**
 * Factory wrapping a Prisma client. Production calls this once with
 * the singleton `prisma` import; unit tests pass a stub client so the
 * suite runs without a DB.
 *
 * Returned function:
 *   persistEvents({ events, callId, opsLog })
 *     → { inserted, skipped, errored, issues }
 *     ALWAYS resolves. NEVER throws.
 *
 *   `events` is an array of { type, seq, occurredAt?, payload? }.
 *   `callId` is the parent Call.id (FK enforced at the DB level).
 *   `opsLog` is dependency-injected; signature (level, event, ctx) => void.
 *
 *   On success: returns `{ inserted: N, skipped: 0, errored: false }`.
 *   On partial validity: returns `{ inserted, skipped, ..., issues: [...] }`.
 *   On Postgres failure: returns `{ inserted: 0, errored: true }` and
 *     logs `ai_call_event_insert_failed` (warn) — caller continues.
 */
function _createPersistEvents(prismaClient) {
    return async function persistEvents({ events, callId, opsLog }) {
        const log = opsLog ?? (() => {})

        if (!Array.isArray(events) || events.length === 0) {
            return { inserted: 0, skipped: 0, errored: false, issues: [] }
        }
        if (typeof callId !== 'string' || callId.length === 0) {
            log('warn', 'ai_call_event_insert_skipped', { reason: 'missing_callId' })
            return { inserted: 0, skipped: events.length, errored: false, issues: [{ code: 'missing_callId' }] }
        }

        const validRows = []
        const issues = []
        for (const e of events) {
            const v = validateEvent(e, callId)
            if (v.ok) {
                validRows.push(v.row)
            } else {
                issues.push({ code: v.code, got: v.got, type: e?.type })
            }
        }

        if (validRows.length === 0) {
            if (issues.length > 0) {
                log('warn', 'ai_call_event_all_skipped', { callId, issuesCount: issues.length, issues: issues.slice(0, 5) })
            }
            return { inserted: 0, skipped: issues.length, errored: false, issues }
        }

        try {
            // createMany is a single round-trip and atomic. skipDuplicates
            // future-proofs against accidental seq collision (won't happen
            // in normal bridge emission since seq is monotonic per-session,
            // but harmless safety net).
            //
            // The `(prismaClient as any).aiCallEvent` access path matches
            // the existing pattern in scenarios.ts — Prisma client types
            // may lag the migration on dev boxes.
            const result = await prismaClient.aiCallEvent.createMany({
                data: validRows,
                skipDuplicates: true,
            })
            return {
                inserted: result.count,
                skipped: issues.length,
                errored: false,
                issues,
            }
        } catch (err) {
            // SWALLOW. Best-effort emission per architect contract: the
            // call has already succeeded (Call.update committed first);
            // losing the event sidecar is acceptable.
            log('warn', 'ai_call_event_insert_failed', {
                callId,
                attempted: validRows.length,
                error: err?.message ?? String(err),
            })
            return {
                inserted: 0,
                skipped: issues.length,
                errored: true,
                issues,
            }
        }
    }
}

module.exports = {
    _createPersistEvents,
    ALLOWED_TYPES,
    validateEvent,
}
