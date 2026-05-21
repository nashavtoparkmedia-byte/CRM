// Regression harness for the stale-AI-session reaper.
//
// We never touch a real Postgres here. A fake prisma stub mimics the
// two methods the SUT actually calls — `call.findMany` and `call.update` —
// over an in-memory array. That keeps the test loop sub-100 ms and
// makes the suite runnable on a box with no DB at all.
//
// Run: `node --test scripts/__tests__/stale_ai_session_cleanup.test.js`

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
    markStaleSessions,
    STALE_HANGUP_CAUSE,
    STALE_REASON_TAG,
} = require('../cleanup_stale_ai_sessions.js')

// ── fake prisma ────────────────────────────────────────────────────────
// Implements just enough of the Prisma client surface the SUT touches.
// `findMany` honours the same WHERE shape; `update` mutates the in-memory
// row in place and records the patch so tests can assert atomically.

function makePrismaStub(initialRows) {
    const db = initialRows.map(r => ({
        ...r,
        metadata: r.metadata ? { ...r.metadata } : {},
    }))
    const updateLog = []

    return {
        db,
        updateLog,
        call: {
            findMany: async ({ where, select }) => {
                const rows = db.filter(r => {
                    if (where.isAi !== undefined && r.isAi !== where.isAi) return false
                    if (where.aiSessionStatus?.in
                        && !where.aiSessionStatus.in.includes(r.aiSessionStatus)) return false
                    if (where.startedAt?.lt && !(r.startedAt < where.startedAt.lt)) return false
                    return true
                })
                if (!select) return rows.map(r => ({ ...r }))
                return rows.map(r => {
                    const out = {}
                    for (const k of Object.keys(select)) {
                        if (select[k]) out[k] = r[k]
                    }
                    return out
                })
            },
            update: async ({ where, data }) => {
                const i = db.findIndex(r => r.id === where.id)
                assert.notEqual(i, -1, `update target not found: ${where.id}`)
                db[i] = { ...db[i], ...data }
                updateLog.push({ id: where.id, data })
                return db[i]
            },
        },
    }
}

// ── helpers ────────────────────────────────────────────────────────────

const NOW = new Date('2026-05-20T12:00:00.000Z')
const STALE_AT = new Date(NOW.getTime() - 31 * 60_000) // 31 min ago (> TTL=30)
const FRESH_AT = new Date(NOW.getTime() - 5 * 60_000)  // 5 min ago

function row(overrides) {
    return {
        id: `c-${Math.random().toString(36).slice(2, 8)}`,
        isAi: true,
        aiSessionStatus: 'active',
        startedAt: STALE_AT,
        metadata: {},
        ...overrides,
    }
}

async function runUnderConfig(rows, { dryRun = false } = {}) {
    const stub = makePrismaStub(rows)
    const result = await markStaleSessions({
        prisma: stub,
        now: NOW,
        ttlMin: 30,
        dryRun,
    })
    return { stub, result }
}

// ── 1. stale active → failed ───────────────────────────────────────────

test('stale active AI session is marked failed with full forensic trace', async () => {
    const target = row({ id: 'call-stale-active', aiSessionStatus: 'active' })
    const { stub, result } = await runUnderConfig([target])

    assert.equal(result.scanned, 1)
    assert.equal(result.updated, 1)
    assert.equal(result.dryRun, false)

    const updated = stub.db.find(r => r.id === 'call-stale-active')
    assert.equal(updated.aiSessionStatus, 'failed')
    assert.equal(updated.endedAt.getTime(), NOW.getTime())
    assert.equal(updated.hangupCause, STALE_HANGUP_CAUSE)
    assert.equal(updated.metadata.staleCleanupPreviousStatus, 'active')
    assert.equal(updated.metadata.staleCleanupReason, STALE_REASON_TAG)
    assert.equal(updated.metadata.staleCleanupAt, NOW.toISOString())
})

// ── 2. fresh active untouched ──────────────────────────────────────────

test('fresh active AI session under TTL is not touched', async () => {
    const fresh = row({ id: 'call-fresh', aiSessionStatus: 'active', startedAt: FRESH_AT })
    const { stub, result } = await runUnderConfig([fresh])

    assert.equal(result.scanned, 0)
    assert.equal(result.updated, 0)
    assert.equal(stub.updateLog.length, 0)
    assert.equal(stub.db[0].aiSessionStatus, 'active')
})

// ── 3. starting stale → failed ─────────────────────────────────────────

test('stale starting session is also reaped', async () => {
    const target = row({ id: 'call-starting', aiSessionStatus: 'starting' })
    const { stub, result } = await runUnderConfig([target])

    assert.equal(result.updated, 1)
    assert.equal(stub.db[0].aiSessionStatus, 'failed')
    assert.equal(stub.db[0].metadata.staleCleanupPreviousStatus, 'starting')
})

// ── 4. greeting stale → failed ─────────────────────────────────────────

test('stale greeting session is also reaped', async () => {
    const target = row({ id: 'call-greeting', aiSessionStatus: 'greeting' })
    const { stub, result } = await runUnderConfig([target])

    assert.equal(result.updated, 1)
    assert.equal(stub.db[0].aiSessionStatus, 'failed')
    assert.equal(stub.db[0].metadata.staleCleanupPreviousStatus, 'greeting')
})

// ── 5. transferring untouched (semi-terminal, scope-excluded) ──────────

test('transferring session is NOT reaped even if past TTL', async () => {
    // Critical invariant: SIP REFER + human pickup can legitimately
    // hold a call in `transferring` for minutes. Cleanup v1 must not
    // false-positive these.
    const target = row({ id: 'call-transferring', aiSessionStatus: 'transferring' })
    const { stub, result } = await runUnderConfig([target])

    assert.equal(result.scanned, 0)
    assert.equal(result.updated, 0)
    assert.equal(stub.updateLog.length, 0)
    assert.equal(stub.db[0].aiSessionStatus, 'transferring')
})

// ── 6. already failed untouched ────────────────────────────────────────

test('already failed session is not touched again', async () => {
    const target = row({ id: 'call-failed', aiSessionStatus: 'failed' })
    const { stub, result } = await runUnderConfig([target])

    assert.equal(result.scanned, 0)
    assert.equal(result.updated, 0)
    assert.equal(stub.updateLog.length, 0)
})

// ── 7. ended untouched ─────────────────────────────────────────────────

test('ended session is not touched', async () => {
    const target = row({ id: 'call-ended', aiSessionStatus: 'ended' })
    const { stub, result } = await runUnderConfig([target])

    assert.equal(result.scanned, 0)
    assert.equal(result.updated, 0)
    assert.equal(stub.updateLog.length, 0)
})

// ── 8. non-AI call untouched ───────────────────────────────────────────

test('non-AI call with stale-looking state is not touched', async () => {
    // An ordinary SIP call has isAi=false and aiSessionStatus=null. Even
    // if it somehow lingered in `active` (shouldn't, but defence-in-depth)
    // the WHERE clause must exclude it.
    const ordinary = row({
        id: 'call-non-ai',
        isAi: false,
        aiSessionStatus: 'active', // hypothetical noise
    })
    const { stub, result } = await runUnderConfig([ordinary])

    assert.equal(result.scanned, 0)
    assert.equal(result.updated, 0)
    assert.equal(stub.updateLog.length, 0)
})

// ── 9. rerun is idempotent ─────────────────────────────────────────────

test('rerun against same dataset performs no further updates', async () => {
    const target = row({ id: 'call-rerun', aiSessionStatus: 'active' })
    const stub = makePrismaStub([target])

    const first = await markStaleSessions({
        prisma: stub, now: NOW, ttlMin: 30, dryRun: false,
    })
    assert.equal(first.updated, 1)

    // Second run sees the row now at `failed` → not eligible.
    const second = await markStaleSessions({
        prisma: stub, now: NOW, ttlMin: 30, dryRun: false,
    })
    assert.equal(second.scanned, 0)
    assert.equal(second.updated, 0)
    // Only one write in total — the first pass.
    assert.equal(stub.updateLog.length, 1)
})

// ── 10. dry-run performs no writes ─────────────────────────────────────

test('dry-run reports stale rows but does not write to the DB', async () => {
    const a = row({ id: 'call-dry-1', aiSessionStatus: 'active' })
    const b = row({ id: 'call-dry-2', aiSessionStatus: 'greeting' })
    const { stub, result } = await runUnderConfig([a, b], { dryRun: true })

    assert.equal(result.scanned, 2)
    assert.equal(result.updated, 0)
    assert.equal(result.dryRun, true)
    assert.equal(stub.updateLog.length, 0)
    // Original rows untouched.
    assert.equal(stub.db[0].aiSessionStatus, 'active')
    assert.equal(stub.db[1].aiSessionStatus, 'greeting')
})

// ── bonus: existing metadata is preserved on cleanup ───────────────────
// Not in the explicit 10-acceptance list but a regression-worthy
// invariant: the merge-append rule promises we don't clobber forensic
// data written by other code paths (e.g. start/route.ts writes
// `metadata.originateError`).

test('existing metadata keys are preserved alongside forensic trace', async () => {
    const target = row({
        id: 'call-meta-merge',
        aiSessionStatus: 'active',
        metadata: { originateError: 'busy', customField: 42 },
    })
    const { stub, result } = await runUnderConfig([target])

    assert.equal(result.updated, 1)
    const meta = stub.db[0].metadata
    assert.equal(meta.originateError, 'busy', 'pre-existing key kept')
    assert.equal(meta.customField, 42, 'pre-existing key kept')
    assert.equal(meta.staleCleanupPreviousStatus, 'active', 'forensic added')
    assert.equal(meta.staleCleanupReason, STALE_REASON_TAG, 'forensic added')
})
