// Unit regression for the AiCallEvent persistence helper.
//
// Tests use a tiny stub Prisma client so the suite runs without a DB.
// The architect's core guarantees:
//   - Append-only insert
//   - Best-effort emission (NEVER throws)
//   - No transaction coupling (helper runs independently)
//   - Event layer must NOT break the call
//
// Each guarantee is locked by at least one test below.
//
// Run: `node --test src/lib/ai-call/__tests__/event-emitter.test.js`

'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
    _createPersistEvents,
    ALLOWED_TYPES,
    validateEvent,
} = require('../event-emitter')

// ── tiny stub Prisma client ─────────────────────────────────────────

function makeStubPrisma({ throwOnInsert = null, recordInsert = null, existingSeqs = [] } = {}) {
    return {
        aiCallEvent: {
            async findMany() {
                return existingSeqs.map(seq => ({ seq }))
            },
            async createMany({ data, skipDuplicates }) {
                if (throwOnInsert) throw throwOnInsert
                if (recordInsert) recordInsert(data, skipDuplicates)
                return { count: data.length }
            },
        },
    }
}

function captureLog() {
    const events = []
    const fn = (level, event, ctx) => events.push({ level, event, ctx })
    fn.events = events
    fn.of = (name) => events.filter(e => e.event === name)
    return fn
}

// ════════════════════════════════════════════════════════════════════
// ALLOWED_TYPES surface
// ════════════════════════════════════════════════════════════════════

test('ALLOWED_TYPES is frozen and matches v1+v2+v3 enum (6 types)', () => {
    assert.equal(Object.isFrozen(ALLOWED_TYPES), true)
    assert.deepEqual([...ALLOWED_TYPES].sort(), [
        'call_completed',
        'first_real_user_speech',
        'greeting_started',
        'recovery_attempted',
        'silence_strike',
        'stt_suspicious_pattern',
    ])
})

// ════════════════════════════════════════════════════════════════════
// validateEvent — per-row guards
// ════════════════════════════════════════════════════════════════════

test('validateEvent: valid event passes', () => {
    const r = validateEvent({
        type: 'greeting_started',
        seq: 1,
        payload: { scenario_id: 's1' },
    }, 'call-1')
    assert.equal(r.ok, true)
    assert.equal(r.row.callId, 'call-1')
    assert.equal(r.row.type, 'greeting_started')
    assert.equal(r.row.seq, 1)
    assert.ok(r.row.occurredAt instanceof Date)
    assert.deepEqual(r.row.payload, { scenario_id: 's1' })
})

test('validateEvent: unknown type → skipped', () => {
    const r = validateEvent({ type: 'objection_detected', seq: 1 }, 'c')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'unknown_type')
    assert.equal(r.got, 'objection_detected')
})

test('validateEvent: missing/non-integer seq → skipped', () => {
    assert.equal(validateEvent({ type: 'silence_strike' }, 'c').ok, false)
    assert.equal(validateEvent({ type: 'silence_strike', seq: 'abc' }, 'c').code, 'invalid_seq')
    assert.equal(validateEvent({ type: 'silence_strike', seq: 1.5 }, 'c').code, 'invalid_seq')
    assert.equal(validateEvent({ type: 'silence_strike', seq: -1 }, 'c').code, 'invalid_seq')
})

test('validateEvent: invalid occurredAt string → skipped', () => {
    const r = validateEvent({ type: 'silence_strike', seq: 1, occurredAt: 'not a date' }, 'c')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'invalid_occurredAt')
})

test('validateEvent: payload must be object — array rejected', () => {
    const r = validateEvent({ type: 'silence_strike', seq: 1, payload: [1, 2] }, 'c')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'invalid_payload_shape')
})

test('validateEvent: payload must be object — primitive rejected', () => {
    const r = validateEvent({ type: 'silence_strike', seq: 1, payload: 'hi' }, 'c')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'invalid_payload_shape')
})

test('validateEvent: null payload OK', () => {
    const r = validateEvent({ type: 'silence_strike', seq: 1, payload: null }, 'c')
    assert.equal(r.ok, true)
    assert.equal(r.row.payload, null)
})

test('validateEvent: occurredAt as Date OK', () => {
    const d = new Date('2026-05-20T10:00:00Z')
    const r = validateEvent({ type: 'silence_strike', seq: 1, occurredAt: d }, 'c')
    assert.equal(r.ok, true)
    assert.equal(r.row.occurredAt.toISOString(), d.toISOString())
})

// ════════════════════════════════════════════════════════════════════
// persistEvents — happy path
// ════════════════════════════════════════════════════════════════════

test('persistEvents: empty array → no insert, no error', async () => {
    const recordedCalls = []
    const prisma = makeStubPrisma({ recordInsert: (data) => recordedCalls.push(data) })
    const persistEvents = _createPersistEvents(prisma)
    const r = await persistEvents({ events: [], callId: 'c', opsLog: captureLog() })
    assert.deepEqual(r, { inserted: 0, skipped: 0, errored: false, issues: [] })
    assert.equal(recordedCalls.length, 0)
})

test('persistEvents: 3 valid events → all inserted', async () => {
    let inserted = null
    const prisma = makeStubPrisma({ recordInsert: (data) => { inserted = data } })
    const persistEvents = _createPersistEvents(prisma)
    const r = await persistEvents({
        events: [
            { type: 'greeting_started', seq: 1, payload: { scenario_id: 's' } },
            { type: 'first_real_user_speech', seq: 2, payload: { delay_ms_since_greeting: 1200 } },
            { type: 'call_completed', seq: 3, payload: { outcome: 'qualified' } },
        ],
        callId: 'call-A',
        opsLog: captureLog(),
    })
    assert.equal(r.inserted, 3)
    assert.equal(r.errored, false)
    assert.equal(r.skipped, 0)
    assert.equal(inserted.length, 3)
    assert.equal(inserted[0].callId, 'call-A')
})

test('persistEvents: mixed valid + invalid → only valid inserted, issues tracked', async () => {
    const prisma = makeStubPrisma()
    const persistEvents = _createPersistEvents(prisma)
    const log = captureLog()
    const r = await persistEvents({
        events: [
            { type: 'greeting_started', seq: 1 },        // valid
            { type: 'unknown_type', seq: 2 },            // invalid: type
            { type: 'silence_strike', seq: 'abc' },      // invalid: seq
            null,                                        // invalid: not object
        ],
        callId: 'c',
        opsLog: log,
    })
    assert.equal(r.inserted, 1)
    assert.equal(r.skipped, 3)
    assert.equal(r.errored, false)
    assert.equal(r.issues.length, 3)
})

// ════════════════════════════════════════════════════════════════════
// persistEvents — never throws on DB failure (core architect guarantee)
// ════════════════════════════════════════════════════════════════════

test('persistEvents: Postgres error → returns errored=true, NEVER throws', async () => {
    const prisma = makeStubPrisma({
        throwOnInsert: new Error('connection refused'),
    })
    const persistEvents = _createPersistEvents(prisma)
    const log = captureLog()
    // The test passes if .resolves at all (doesn't throw):
    const r = await persistEvents({
        events: [{ type: 'greeting_started', seq: 1 }],
        callId: 'c',
        opsLog: log,
    })
    assert.equal(r.errored, true)
    assert.equal(r.inserted, 0)
    // Logged for operator visibility.
    assert.equal(log.of('ai_call_event_insert_failed').length, 1)
})

test('persistEvents: opsLog is optional — missing logger does not crash', async () => {
    const prisma = makeStubPrisma({ throwOnInsert: new Error('boom') })
    const persistEvents = _createPersistEvents(prisma)
    // Intentionally no opsLog passed. Architect: best-effort, never throws.
    const r = await persistEvents({
        events: [{ type: 'greeting_started', seq: 1 }],
        callId: 'c',
    })
    assert.equal(r.errored, true)
})

test('persistEvents: missing callId → skipped, no exception', async () => {
    const prisma = makeStubPrisma()
    const persistEvents = _createPersistEvents(prisma)
    const log = captureLog()
    const r = await persistEvents({
        events: [{ type: 'greeting_started', seq: 1 }],
        callId: undefined,
        opsLog: log,
    })
    assert.equal(r.inserted, 0)
    assert.equal(r.skipped, 1)
    assert.equal(r.errored, false)
    assert.ok(log.of('ai_call_event_insert_skipped').length >= 1)
})

// ════════════════════════════════════════════════════════════════════
// Defensive: append-only contract (no update/delete surface)
// ════════════════════════════════════════════════════════════════════

test('persistEvents: only reads existing keys then appends — no update / upsert / delete', async () => {
    // The stub client only exposes `findMany` + `createMany`. If the helper
    // ever tried to mutate existing rows, the test would crash here.
    // This lock is intentional: any future refactor that introduces
    // mutation API has to update this test, surfacing the contract change.
    const prisma = {
        aiCallEvent: {
            findMany: async () => [],
            createMany: async ({ data }) => ({ count: data.length }),
        },
    }
    const persistEvents = _createPersistEvents(prisma)
    const r = await persistEvents({
        events: [{ type: 'silence_strike', seq: 1 }],
        callId: 'c',
    })
    assert.equal(r.inserted, 1)
})

test('persistEvents: repeated retry skips an existing (callId, seq)', async () => {
    let createCalls = 0
    const prisma = makeStubPrisma({
        existingSeqs: [1],
        recordInsert: () => { createCalls += 1 },
    })
    const persistEvents = _createPersistEvents(prisma)
    const result = await persistEvents({
        events: [{ type: 'greeting_started', seq: 1 }],
        callId: 'call-retry',
        opsLog: captureLog(),
    })
    assert.equal(result.inserted, 0)
    assert.equal(result.skipped, 1)
    assert.equal(result.issues[0].code, 'duplicate_existing_seq')
    assert.equal(createCalls, 0)
})

test('persistEvents: duplicate seq inside one payload inserts once', async () => {
    let inserted = null
    const prisma = makeStubPrisma({ recordInsert: data => { inserted = data } })
    const persistEvents = _createPersistEvents(prisma)
    const result = await persistEvents({
        events: [
            { type: 'greeting_started', seq: 1 },
            { type: 'silence_strike', seq: 1 },
        ],
        callId: 'call-batch',
    })
    assert.equal(result.inserted, 1)
    assert.equal(result.skipped, 1)
    assert.equal(inserted.length, 1)
    assert.equal(result.issues[0].code, 'duplicate_input_seq')
})

test('persistEvents: createMany called with skipDuplicates=true (idempotency safety)', async () => {
    let opts = null
    const prisma = {
        aiCallEvent: {
            createMany: async (o) => { opts = o; return { count: o.data.length } },
        },
    }
    const persistEvents = _createPersistEvents(prisma)
    await persistEvents({
        events: [{ type: 'greeting_started', seq: 1 }],
        callId: 'c',
    })
    assert.equal(opts.skipDuplicates, true)
})
