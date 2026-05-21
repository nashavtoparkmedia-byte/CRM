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

// Spy on opsLog by replacing the module's exports in require.cache
// BEFORE retry-helpers loads. Lets us assert exact log shape (event
// name, field names, presence of `staleCleanupExpected` etc.) and —
// critically — the COUNT of `crm_finalize_retry` events: there must be
// at most N-1 retry events for N attempts, because there's no backoff
// (and therefore no retry log) after the final attempt.
const opsLogPath = require.resolve('../opsLog')
const _capturedEvents = []
require.cache[opsLogPath] = {
    id: opsLogPath,
    filename: opsLogPath,
    loaded: true,
    exports: {
        opsLog: (level, event, ctx) => _capturedEvents.push({ level, event, ctx }),
    },
    children: [],
    paths: [],
}
function resetEvents() { _capturedEvents.length = 0 }
function eventsOfType(name) { return _capturedEvents.filter(e => e.event === name) }

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
    resetEvents()
    const fetchImpl = sequentialFetch([okResponse({ ok: true })])
    const r = await retry({ url: 'http://crm/finalize', payload: {}, callId: 'c1', fetchImpl })
    assert.equal(r.ok, true)
    assert.equal(r.attempts, 1)
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(r.body.ok, true)
    // No retry events on first-attempt success, exactly one success event.
    assert.equal(eventsOfType('crm_finalize_retry').length, 0)
    const ok = eventsOfType('crm_finalize_succeeded')
    assert.equal(ok.length, 1)
    assert.equal(ok[0].ctx.attemptCount, 1)
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

// ── 9. NO backoff sleep after final attempt (architectural invariant) ─
// 3 attempts, all fail. We must emit exactly 2 `crm_finalize_retry`
// events (before sleeping between attempts 1→2 and 2→3) and exactly 1
// `crm_finalize_failed` event. Anything else means either a missing
// retry log OR an erroneous post-final sleep.

test('exhausted retries: exactly 2 retry events + 1 failed event (no post-final sleep)', async () => {
    resetEvents()
    const fetchImpl = sequentialFetch([
        networkThrow('blip-1'),
        networkThrow('blip-2'),
        networkThrow('blip-3'),
    ])
    await assert.rejects(
        () => retry({ url: 'http://crm/finalize', payload: {}, callId: 'no-extra-sleep', fetchImpl }),
        /blip-3/,
    )
    const retryEvents = eventsOfType('crm_finalize_retry')
    const failedEvents = eventsOfType('crm_finalize_failed')
    assert.equal(retryEvents.length, 2,
        'must NOT log retry after the final attempt; expected exactly N-1 retry events')
    assert.equal(failedEvents.length, 1)
    // Retry events fire only at the boundary between attempts:
    // after #1 (attempt=1) and after #2 (attempt=2). Never after #3.
    assert.equal(retryEvents[0].ctx.attempt, 1)
    assert.equal(retryEvents[1].ctx.attempt, 2)
})

// ── 10. final failure log contract (forensic field set) ───────────────
// Required-on-final-failure:
//   attemptCount, category, staleCleanupExpected
//   statusCode — present only when the LAST failure was a 5xx response;
//                absent on network/timeout exhaustion.

test('final failure log on network exhaustion: required forensic fields, no statusCode', async () => {
    resetEvents()
    const fetchImpl = sequentialFetch([
        networkThrow('ECONNREFUSED'),
        networkThrow('ECONNREFUSED'),
        networkThrow('ECONNREFUSED'),
    ])
    await assert.rejects(() => retry({
        url: 'http://crm/finalize', payload: {}, callId: 'fc1', fetchImpl,
    }))
    const failed = eventsOfType('crm_finalize_failed')[0]
    assert.ok(failed, 'failure event emitted')
    assert.equal(failed.ctx.attemptCount, 3)
    assert.equal(failed.ctx.category, 'attempts_exhausted')
    assert.equal(failed.ctx.staleCleanupExpected, true)
    assert.equal(failed.ctx.callId, 'fc1')
    assert.equal(failed.ctx.statusCode, undefined,
        'network-throw exhaustion has no HTTP status to report')
    assert.equal(typeof failed.ctx.totalMs, 'number')
})

test('final failure log on 5xx exhaustion: statusCode populated from last attempt', async () => {
    resetEvents()
    const fetchImpl = sequentialFetch([
        httpResponse(503),
        httpResponse(502),
        httpResponse(504),
    ])
    await assert.rejects(() => retry({
        url: 'http://crm/finalize', payload: {}, callId: 'fc2', fetchImpl,
    }))
    const failed = eventsOfType('crm_finalize_failed')[0]
    assert.ok(failed)
    assert.equal(failed.ctx.attemptCount, 3)
    assert.equal(failed.ctx.category, 'attempts_exhausted')
    assert.equal(failed.ctx.staleCleanupExpected, true)
    assert.equal(failed.ctx.statusCode, 504,
        'statusCode reflects the LAST 5xx response (504), not earlier ones')
})

test('4xx failure log: staleCleanupExpected=false, statusCode required', async () => {
    resetEvents()
    const fetchImpl = sequentialFetch([httpResponse(400)])
    await assert.rejects(() => retry({
        url: 'http://crm/finalize', payload: {}, callId: 'fc3', fetchImpl,
    }))
    const failed = eventsOfType('crm_finalize_failed')[0]
    assert.ok(failed)
    assert.equal(failed.ctx.attemptCount, 1)
    assert.equal(failed.ctx.category, '4xx_no_retry')
    assert.equal(failed.ctx.statusCode, 400)
    assert.equal(failed.ctx.staleCleanupExpected, false,
        '4xx is a caller bug, NOT a consistency case — operator must investigate, not wait for the reaper')
})

// ── 11. production policy is what we promise ──────────────────────────
// Belt-and-suspenders: a refactor that accidentally widens the policy
// (e.g. someone bumps ATTEMPTS to 5 «just to be safe») fails this test
// and goes through PR review.

test('PRODUCTION_POLICY matches the documented contract', () => {
    assert.equal(PRODUCTION_POLICY.ATTEMPT_TIMEOUT_MS, 5000)
    assert.deepEqual([...PRODUCTION_POLICY.BACKOFFS_MS], [500, 1500])
    assert.equal(PRODUCTION_POLICY.ATTEMPTS, 3)
})
