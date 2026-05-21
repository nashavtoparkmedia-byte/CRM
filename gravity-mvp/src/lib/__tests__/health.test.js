// Unit regression for the pure orchestration helpers behind
// /api/health. Live probes (Postgres / Redis / MinIO / FS-ESL) are
// integration concerns and not tested here — they're tested implicitly
// when `runHealthChecks()` runs against the live dev stack via the
// post-implementation curl probe in the PR verification.
//
// What this suite covers:
//   1. status='ok' / 'degraded' / 'down' policy
//   2. timeout handling in `withCheckTimeout`
//   3. thrown-exception handling in `withCheckTimeout`
//   4. successful check passes through verbatim
//   5. `ms` is mandatory on every Check (success + timeout + throw)
//   6. empty check set is NOT silently healthy
//
// Run: `node --test src/lib/__tests__/health.test.js`
// Zero new dependencies.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { composeHealthResponse, withCheckTimeout } = require('../health-helpers')

const FROZEN_TS = new Date('2026-05-20T12:00:00.000Z')

// ────────────────────────────────────────────────────────────────────
// composeHealthResponse — status policy
// ────────────────────────────────────────────────────────────────────

test('all ok → status=ok', () => {
    const r = composeHealthResponse([
        { name: 'postgres', ok: true,  ms: 12 },
        { name: 'redis',    ok: true,  ms: 3  },
        { name: 'minio',    ok: true,  ms: 18 },
        { name: 'fs_esl',   ok: true,  ms: 1  },
    ], FROZEN_TS)
    assert.equal(r.status, 'ok')
    assert.equal(r.checks.length, 4)
    assert.equal(r.ts, FROZEN_TS.toISOString())
})

test('one failed (with three ok) → status=degraded', () => {
    const r = composeHealthResponse([
        { name: 'postgres', ok: true,  ms: 12 },
        { name: 'redis',    ok: false, ms: 2001, error: 'timeout' },
        { name: 'minio',    ok: true,  ms: 18 },
        { name: 'fs_esl',   ok: true,  ms: 1  },
    ], FROZEN_TS)
    assert.equal(r.status, 'degraded')
})

test('all failed → status=down', () => {
    const r = composeHealthResponse([
        { name: 'postgres', ok: false, ms: 2001, error: 'timeout' },
        { name: 'redis',    ok: false, ms: 5,    error: 'ECONNREFUSED' },
        { name: 'minio',    ok: false, ms: 1500, error: 'NoSuchBucket' },
        { name: 'fs_esl',   ok: false, ms: 0,    error: 'ECONNREFUSED' },
    ], FROZEN_TS)
    assert.equal(r.status, 'down')
})

test('empty check set is NOT silently healthy (status=down)', () => {
    // A misconfigured endpoint that produced zero checks must not be
    // interpreted as "all good" by a status-code monitor.
    const r = composeHealthResponse([], FROZEN_TS)
    assert.equal(r.status, 'down')
})

test('composeHealthResponse: ms is always present on every check', () => {
    const r = composeHealthResponse([
        { name: 'postgres', ok: true,  ms: 0    },          // edge: 0 ms
        { name: 'redis',    ok: false, ms: 2001, error: 'timeout' },
    ], FROZEN_TS)
    for (const c of r.checks) {
        assert.equal(typeof c.ms, 'number', `ms missing on ${c.name}`)
    }
})

// ────────────────────────────────────────────────────────────────────
// withCheckTimeout — wrapper guarantees
// ────────────────────────────────────────────────────────────────────

test('withCheckTimeout: successful check passes through unchanged', async () => {
    const r = await withCheckTimeout(
        'fast',
        async () => ({ name: 'fast', ok: true, ms: 5 }),
        100,
    )
    assert.equal(r.name, 'fast')
    assert.equal(r.ok, true)
    assert.equal(r.ms, 5)
    assert.equal(r.error, undefined)
})

test('withCheckTimeout: timeout produces ok=false with error="timeout"', async () => {
    const r = await withCheckTimeout(
        'slow',
        () => new Promise(() => { /* never resolves */ }),
        30,
    )
    assert.equal(r.name, 'slow')
    assert.equal(r.ok, false)
    assert.equal(r.error, 'timeout')
    assert.equal(typeof r.ms, 'number')
    assert.ok(r.ms >= 30, `ms should reflect wall-clock waited, got ${r.ms}`)
})

test('withCheckTimeout: thrown error inside fn is caught and reported', async () => {
    const r = await withCheckTimeout(
        'broken',
        async () => { throw new Error('connection refused') },
        100,
    )
    assert.equal(r.name, 'broken')
    assert.equal(r.ok, false)
    assert.equal(r.error, 'connection refused')
    assert.equal(typeof r.ms, 'number')
})

test('withCheckTimeout: synchronous throw inside fn is caught', async () => {
    const r = await withCheckTimeout(
        'sync-throw',
        () => { throw new Error('sync boom') },
        100,
    )
    assert.equal(r.ok, false)
    assert.equal(r.error, 'sync boom')
})

test('withCheckTimeout: no exception ever escapes — the promise always resolves', async () => {
    // Bombard the wrapper with a mix of pathological cases and ensure
    // every one of them produces a Check object (never a rejected
    // promise). This is the contract the endpoint relies on.
    const cases = [
        () => Promise.reject(new Error('rejected')),
        () => Promise.reject('string-rejection'),
        () => { throw 42 },
        () => { throw null },
        () => new Promise(() => {}),               // hangs → timeout
        async () => ({ name: 'good', ok: true, ms: 1 }),
    ]
    const results = await Promise.all(
        cases.map((fn, i) => withCheckTimeout(`case-${i}`, fn, 30)),
    )
    for (const r of results) {
        // Either a passthrough success or one of the synthesised
        // failure shapes — never an undefined / rejected value.
        assert.equal(typeof r.name, 'string')
        assert.equal(typeof r.ok, 'boolean')
        assert.equal(typeof r.ms, 'number')
    }
})
