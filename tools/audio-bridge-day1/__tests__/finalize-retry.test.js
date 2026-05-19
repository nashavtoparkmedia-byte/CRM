// Unit regression for the finalize-only retry policy.
//
// Tests use the `_createRetryFinalize` factory with a sub-millisecond
// policy so the whole suite runs in a few hundred ms rather than ~30 s.
// Production code never sees this — the singleton `retryFinalizeRequest`
// is built with PRODUCTION_POLICY (5 s / 500 / 1500 ms).
//
// We mock `fetchImpl` per-test. Each mock returns a `Response`-like
// object compatible with what fetch normally returns: `{ok, status,
// json(), text()}`. Network errors are thrown directly.
//
// Run: `node --test __tests__/finalize-retry.test.js`
// Zero new dependencies.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { _createRetryFinalize, PRODUCTION_POLICY } = require('../retry-helpers')

// Fast policy: timers measured in ms not seconds. Real semantics
// preserved (3 attempts, 5xx retried, 4xx not).
const FAST_POLICY = Object.freeze({
    ATTEMPT_TIMEOUT_MS: 100,
    BACKOFFS_MS: Object.freeze([5, 10]),
    ATTEMPTS: 3,
})
const retry = _createRetryFinalize(FAST_POLICY)

// ── tiny mock helpers ─────────────────────────────────────────────────

function okResponse(body = { ok: true, callId: 'cmpd-test' }) {
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}
function httpResponse(status, body = '') {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({}),
        text: async () => body,
    }
}
function networkThrow(message = 'ECONNREFUSED') {
    return async () => { throw new Error(message) }
}

/** Builds a fetchImpl whose nth call returns the nth element of `seq`.
 *  Element can be a Response-like object OR a function that runs (for throw). */
function sequentialFetch(seq) {
    let i = 0
    const calls = []
    const impl = async (url, init) => {
        calls.push({ url, init })
        const item = seq[i++]
        if (typeof item === 'function') return item(url, init)
        return item
    }
    impl.calls = calls
    return impl
}

// ── 1. happy path — first attempt succeeds ────────────────────────────

test('first attempt 200 → succeeds, attempts=1', async () => {
    const fetchImpl = sequentialFetch([okResponse({ ok: true })])
    const r = await retry({ url: 'http://crm/finalize', payload: {}, callId: 'c1', fetchImpl })
    assert.equal(r.ok, true)
    assert.equal(r.attempts, 1)
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(r.body.ok, true)
})

// ── 2. network throw → success on retry ───────────────────────────────

test('network throw then 200 → succeeds, attempts=2', async () => {
    const fetchImpl = sequentialFetch([
        networkThrow('ECONNREFUSED'),
        okResponse(),
    ])
    const r = await retry({ url: 'http://crm/finalize', payload: {}, callId: 'c2', fetchImpl })
    assert.equal(r.ok, true)
    assert.equal(r.attempts, 2)
    assert.equal(fetchImpl.calls.length, 2)
})

// ── 3. 5xx then 5xx then 200 → success after 2 retries ────────────────
// Explicit 5xx case the architect asked for.

test('503 → 503 → 200 → succeeds, attempts=3', async () => {
    const fetchImpl = sequentialFetch([
        httpResponse(503, 'maintenance'),
        httpResponse(503, 'maintenance'),
        okResponse(),
    ])
    const r = await retry({ url: 'http://crm/finalize', payload: {}, callId: 'c3', fetchImpl })
    assert.equal(r.ok, true)
    assert.equal(r.attempts, 3)
    assert.equal(fetchImpl.calls.length, 3)
})

// ── 4. all 3 attempts fail (network) → throws ─────────────────────────

test('3× network throw → throws, attempts=3', async () => {
    const fetchImpl = sequentialFetch([
        networkThrow(),
        networkThrow(),
        networkThrow(),
    ])
    await assert.rejects(
        () => retry({ url: 'http://crm/finalize', payload: {}, callId: 'c4', fetchImpl }),
        /ECONNREFUSED/,
    )
    assert.equal(fetchImpl.calls.length, 3)
})

// ── 5. all 3 attempts 5xx → throws ────────────────────────────────────

test('3× HTTP 503 → throws, attempts=3', async () => {
    const fetchImpl = sequentialFetch([
        httpResponse(503),
        httpResponse(503),
        httpResponse(503),
    ])
    await assert.rejects(
        () => retry({ url: 'http://crm/finalize', payload: {}, callId: 'c5', fetchImpl }),
        /HTTP 503/,
    )
    assert.equal(fetchImpl.calls.length, 3)
})

// ── 6. 4xx → no retry, fail immediately ───────────────────────────────

test('HTTP 400 → throws on first attempt, NO retry', async () => {
    const fetchImpl = sequentialFetch([
        httpResponse(400, 'invalid_json'),
        // These should never be called.
        okResponse(),
        okResponse(),
    ])
    await assert.rejects(
        () => retry({ url: 'http://crm/finalize', payload: {}, callId: 'c6', fetchImpl }),
        /HTTP 400/,
    )
    // Critical: only one fetch was made — 4xx isn't retried.
    assert.equal(fetchImpl.calls.length, 1)
})

test('HTTP 404 → throws on first attempt, NO retry', async () => {
    const fetchImpl = sequentialFetch([
        httpResponse(404, 'not_found'),
        okResponse(),
        okResponse(),
    ])
    await assert.rejects(
        () => retry({ url: 'http://crm/finalize', payload: {}, callId: 'c7', fetchImpl }),
        /HTTP 404/,
    )
    assert.equal(fetchImpl.calls.length, 1)
})

// ── 7. timeout per attempt (AbortController) ──────────────────────────
// fetchImpl returns a Promise that never resolves — fetchOnce should
// timeout-via-Abort, retry, then second attempt succeeds.

test('per-attempt timeout → AbortError → retry → next succeeds', async () => {
    let calls = 0
    const fetchImpl = async (url, init) => {
        calls++
        if (calls === 1) {
            // Hang until aborted.
            return new Promise((_, reject) => {
                init.signal.addEventListener('abort', () => reject(new Error('aborted')))
            })
        }
        return okResponse()
    }
    const r = await retry({ url: 'http://crm/finalize', payload: {}, callId: 'c8', fetchImpl })
    assert.equal(r.ok, true)
    assert.equal(r.attempts, 2)
    assert.equal(calls, 2)
})

// ── 8. empty body on success doesn't blow up ──────────────────────────

test('200 with non-JSON body → success with body={}', async () => {
    const fetchImpl = sequentialFetch([{
        ok: true,
        status: 200,
        json: async () => { throw new Error('not JSON') },
        text: async () => '',
    }])
    const r = await retry({ url: 'http://crm/finalize', payload: {}, callId: 'c9', fetchImpl })
    assert.equal(r.ok, true)
    assert.equal(r.attempts, 1)
    assert.deepEqual(r.body, {})
})

// ── 9. production policy is what we promise ───────────────────────────
// Belt-and-suspenders: a refactor that accidentally widens the policy
// (e.g. someone bumps ATTEMPTS to 5 «just to be safe») fails this test
// and goes through PR review.

test('PRODUCTION_POLICY matches the documented contract', () => {
    assert.equal(PRODUCTION_POLICY.ATTEMPT_TIMEOUT_MS, 5000)
    assert.deepEqual([...PRODUCTION_POLICY.BACKOFFS_MS], [500, 1500])
    assert.equal(PRODUCTION_POLICY.ATTEMPTS, 3)
})
