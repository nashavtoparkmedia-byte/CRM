// Unit regression for the MinIO/S3 upload retry helper.
//
// Tests use the `_createRetryUploadRecording` factory with a
// sub-millisecond backoff policy so the whole suite runs in ~50 ms
// rather than ~20 s. Production code never sees the fast policy —
// the singleton `retryUploadRecording` is built with PRODUCTION_POLICY
// (3 attempts, [2000, 5000] ms backoffs).
//
// `uploadFn` is mocked per-test. `opsLog` is captured into an array
// so we can assert exact log shape (event name, fields, presence of
// `staleRecordingOnDiskExpected`) and count.
//
// Run: `node --test src/lib/freeswitch/__tests__/recording-upload-retry.test.js`
// Zero new dependencies.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
    _createRetryUploadRecording,
    PRODUCTION_POLICY,
    classifyError,
} = require('../recording-upload-retry')

// Fast policy: backoffs measured in ms not seconds. Real semantics
// preserved (3 attempts, 5xx retried, 4xx not, ENOENT not).
const FAST_POLICY = Object.freeze({
    ATTEMPTS: 3,
    BACKOFFS_MS: Object.freeze([5, 10]),
})
const retry = _createRetryUploadRecording(FAST_POLICY)

// ── tiny mock helpers ─────────────────────────────────────────────────

function captureLog() {
    const events = []
    const fn = (level, event, ctx) => events.push({ level, event, ctx })
    fn.events = events
    fn.of = (name) => events.filter(e => e.event === name)
    return fn
}

/** A fake uploadFn that returns the n-th element of `seq`.
 *  - `'ok'` → resolves
 *  - Error instance → rejects with that
 *  - function → invoked, returns its result (for custom behaviour) */
function sequentialUpload(seq) {
    let i = 0
    const calls = []
    const fn = async () => {
        calls.push(i)
        const item = seq[i++]
        if (typeof item === 'function') return item()
        if (item instanceof Error) throw item
        if (item === 'ok') return undefined
        throw new Error(`unexpected seq item: ${JSON.stringify(item)}`)
    }
    fn.calls = calls
    return fn
}

function s3Err(httpStatusCode, name = 'ServiceUnavailable') {
    const err = new Error(`HTTP ${httpStatusCode}`)
    err.$metadata = { httpStatusCode }
    err.name = name
    return err
}

function nodeNetErr(code) {
    const err = new Error(code)
    err.code = code
    return err
}

// ════════════════════════════════════════════════════════════════════
// classifyError — sanity table
// ════════════════════════════════════════════════════════════════════

test('classifyError: network errors are transient', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']) {
        const r = classifyError(nodeNetErr(code))
        assert.equal(r.retryable, true, code)
        assert.equal(r.category, 'network')
    }
})

test('classifyError: per-attempt timeout (from withTimeout) is transient', () => {
    const err = new Error('timeout_uploadFile_after_30000ms')
    const r = classifyError(err)
    assert.equal(r.retryable, true)
    assert.equal(r.category, 'timeout')
})

test('classifyError: S3 5xx is transient', () => {
    for (const status of [500, 502, 503, 504]) {
        const r = classifyError(s3Err(status))
        assert.equal(r.retryable, true, `${status}`)
        assert.equal(r.category, 's3_5xx')
    }
})

test('classifyError: S3 4xx is NOT transient', () => {
    for (const status of [400, 401, 403, 404]) {
        const r = classifyError(s3Err(status))
        assert.equal(r.retryable, false, `${status}`)
        assert.equal(r.category, 's3_4xx')
    }
})

test('classifyError: ENOENT (local file missing) is NOT transient', () => {
    const err = new Error('ENOENT: no such file')
    err.code = 'ENOENT'
    const r = classifyError(err)
    assert.equal(r.retryable, false)
    assert.equal(r.category, 'enoent')
})

test('classifyError: unknown error defaults to NOT transient (surface bugs)', () => {
    const err = new Error('something weird')
    const r = classifyError(err)
    assert.equal(r.retryable, false)
    assert.equal(r.category, 'unknown')
})

// ════════════════════════════════════════════════════════════════════
// retryUploadRecording — success paths
// ════════════════════════════════════════════════════════════════════

test('first attempt succeeds: 1 call, opsLog success only, no retry events', async () => {
    const opsLog = captureLog()
    const uploadFn = sequentialUpload(['ok'])
    const r = await retry({ uploadFn, callId: 'c1', opsLog })
    assert.equal(r.ok, true)
    assert.equal(r.attempts, 1)
    assert.equal(uploadFn.calls.length, 1)
    assert.equal(opsLog.of('recording_upload_retry').length, 0)
    const succ = opsLog.of('recording_upload_succeeded')
    assert.equal(succ.length, 1)
    assert.equal(succ[0].ctx.callId, 'c1')
    assert.equal(succ[0].ctx.attempt, 1)
})

test('first attempt 5xx → second attempt succeeds, attempts=2', async () => {
    const opsLog = captureLog()
    const uploadFn = sequentialUpload([s3Err(503), 'ok'])
    const r = await retry({ uploadFn, callId: 'c2', opsLog })
    assert.equal(r.ok, true)
    assert.equal(r.attempts, 2)
    assert.equal(uploadFn.calls.length, 2)
    const retries = opsLog.of('recording_upload_retry')
    assert.equal(retries.length, 1)
    assert.equal(retries[0].ctx.category, 's3_5xx')
    assert.equal(retries[0].ctx.retryable, true)
    assert.equal(opsLog.of('recording_upload_succeeded').length, 1)
})

test('network throw then timeout then success: attempts=3, no extra sleep', async () => {
    const opsLog = captureLog()
    const uploadFn = sequentialUpload([
        nodeNetErr('ECONNREFUSED'),
        new Error('timeout_uploadFile_after_100ms'),
        'ok',
    ])
    const r = await retry({ uploadFn, callId: 'c3', opsLog })
    assert.equal(r.attempts, 3)
    assert.equal(uploadFn.calls.length, 3)
    // Two retries (between attempts 1→2 and 2→3), no retry after 3rd.
    assert.equal(opsLog.of('recording_upload_retry').length, 2)
    assert.equal(opsLog.of('recording_upload_succeeded').length, 1)
    assert.equal(opsLog.of('recording_upload_failed').length, 0)
})

// ════════════════════════════════════════════════════════════════════
// retryUploadRecording — exhaustion paths
// ════════════════════════════════════════════════════════════════════

test('3× network throw → throws, opsLog failed with staleRecordingOnDiskExpected=true', async () => {
    const opsLog = captureLog()
    const uploadFn = sequentialUpload([
        nodeNetErr('ECONNRESET'),
        nodeNetErr('ECONNRESET'),
        nodeNetErr('ECONNRESET'),
    ])
    await assert.rejects(
        () => retry({ uploadFn, callId: 'c4', opsLog }),
        /ECONNRESET/,
    )
    assert.equal(uploadFn.calls.length, 3)
    // Exactly 2 retry events (after attempts 1, 2), not 3 — no sleep
    // after the final attempt.
    assert.equal(opsLog.of('recording_upload_retry').length, 2)
    const failed = opsLog.of('recording_upload_failed')[0]
    assert.ok(failed)
    assert.equal(failed.ctx.callId, 'c4')
    assert.equal(failed.ctx.attempt, 3)
    assert.equal(failed.ctx.retryable, true)
    assert.equal(failed.ctx.category, 'network')
    assert.equal(failed.ctx.staleRecordingOnDiskExpected, true,
        'operator runbook signal: WAV still on disk, manual replay possible')
})

test('3× 503 → throws, staleRecordingOnDiskExpected=true', async () => {
    const opsLog = captureLog()
    const uploadFn = sequentialUpload([
        s3Err(503),
        s3Err(502),
        s3Err(504),
    ])
    await assert.rejects(() => retry({ uploadFn, callId: 'c5', opsLog }))
    const failed = opsLog.of('recording_upload_failed')[0]
    assert.equal(failed.ctx.staleRecordingOnDiskExpected, true)
    assert.equal(failed.ctx.category, 's3_5xx')
})

// ════════════════════════════════════════════════════════════════════
// retryUploadRecording — non-retryable paths (NO retry, immediate fail)
// ════════════════════════════════════════════════════════════════════

test('HTTP 403 → throws on first attempt, NO retry, staleRecordingOnDiskExpected=false', async () => {
    const opsLog = captureLog()
    const uploadFn = sequentialUpload([
        s3Err(403, 'AccessDenied'),
        'ok',  // never reached
        'ok',
    ])
    await assert.rejects(() => retry({ uploadFn, callId: 'c6', opsLog }))
    assert.equal(uploadFn.calls.length, 1, '4xx must not retry')
    assert.equal(opsLog.of('recording_upload_retry').length, 0)
    const failed = opsLog.of('recording_upload_failed')[0]
    assert.equal(failed.ctx.attempt, 1)
    assert.equal(failed.ctx.retryable, false)
    assert.equal(failed.ctx.category, 's3_4xx')
    assert.equal(failed.ctx.staleRecordingOnDiskExpected, false,
        '4xx is a bug, operator must investigate — not a cleanup case')
})

test('ENOENT (missing local MP3) → throws on first attempt, NO retry', async () => {
    const opsLog = captureLog()
    const enoentErr = new Error('ENOENT: open /tmp/x.mp3')
    enoentErr.code = 'ENOENT'
    const uploadFn = sequentialUpload([enoentErr, 'ok', 'ok'])
    await assert.rejects(() => retry({ uploadFn, callId: 'c7', opsLog }))
    assert.equal(uploadFn.calls.length, 1)
    const failed = opsLog.of('recording_upload_failed')[0]
    assert.equal(failed.ctx.retryable, false)
    assert.equal(failed.ctx.category, 'enoent')
    assert.equal(failed.ctx.staleRecordingOnDiskExpected, false)
})

test('unknown error → throws on first attempt, NO retry', async () => {
    const opsLog = captureLog()
    const uploadFn = sequentialUpload([new Error('mystery error'), 'ok', 'ok'])
    await assert.rejects(() => retry({ uploadFn, callId: 'c8', opsLog }))
    assert.equal(uploadFn.calls.length, 1)
    const failed = opsLog.of('recording_upload_failed')[0]
    assert.equal(failed.ctx.retryable, false)
    assert.equal(failed.ctx.category, 'unknown')
})

// ════════════════════════════════════════════════════════════════════
// Defensive invariants
// ════════════════════════════════════════════════════════════════════

test('opsLog is optional — missing logger does not crash', async () => {
    const uploadFn = sequentialUpload(['ok'])
    const r = await retry({ uploadFn, callId: 'c9' })  // no opsLog
    assert.equal(r.ok, true)
})

test('PRODUCTION_POLICY pinned: 3 attempts, [2000, 5000] backoffs', () => {
    assert.equal(PRODUCTION_POLICY.ATTEMPTS, 3)
    assert.deepEqual([...PRODUCTION_POLICY.BACKOFFS_MS], [2000, 5000])
})

test('exhausted retries: exactly 2 retry events (no post-final sleep)', async () => {
    const opsLog = captureLog()
    const uploadFn = sequentialUpload([
        nodeNetErr('ECONNREFUSED'),
        nodeNetErr('ECONNREFUSED'),
        nodeNetErr('ECONNREFUSED'),
    ])
    await assert.rejects(() => retry({ uploadFn, callId: 'no-extra-sleep', opsLog }))
    const retries = opsLog.of('recording_upload_retry')
    assert.equal(retries.length, 2, 'must NOT log retry after the final attempt')
    assert.equal(retries[0].ctx.attempt, 1)
    assert.equal(retries[1].ctx.attempt, 2)
})
