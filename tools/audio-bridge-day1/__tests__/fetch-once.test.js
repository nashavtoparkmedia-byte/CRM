// Unit regression for the standalone `fetchOnce` export.
//
// Previously `fetchOnce` was an internal helper inside retry-helpers.js
// used only by `retryFinalizeRequest` (timeout coverage came indirectly
// through case «per-attempt timeout → AbortError → retry → next
// succeeds»). This PR exposes it as a public export so non-finalize
// bridge → CRM callers can wrap their own fetches with bounded waits
// without re-implementing the AbortController dance. Locking the
// public contract with explicit tests so a future refactor that
// changes the signature or behavior trips here.
//
// Run: `node --test __tests__/fetch-once.test.js`
// Zero new dependencies.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { fetchOnce } = require('../retry-helpers')

// ── 1. happy path — fast response passes through ──────────────────────

test('fetchOnce: resolves when fetchImpl resolves before timeout', async () => {
    const fakeResponse = { ok: true, status: 200 }
    const fetchImpl = async () => fakeResponse
    const r = await fetchOnce('http://x/', {}, 1000, fetchImpl)
    assert.equal(r, fakeResponse)
})

// ── 2. timeout aborts the in-flight fetch ─────────────────────────────

test('fetchOnce: aborts after timeoutMs, fetchImpl rejects with AbortError', async () => {
    const fetchImpl = (_url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
    const start = Date.now()
    await assert.rejects(
        () => fetchOnce('http://x/', {}, 30, fetchImpl),
        /aborted/,
    )
    const elapsed = Date.now() - start
    assert.ok(elapsed >= 30, `must wait the full timeout, got ${elapsed} ms`)
    assert.ok(elapsed < 200, `must abort promptly, got ${elapsed} ms`)
})

// ── 3. AbortSignal is threaded into init ──────────────────────────────
// Important: fetchOnce constructs the AbortController itself; callers
// just pass `init` without a signal. The helper must inject `signal`
// without dropping any caller-provided init fields (headers,
// dispatcher, body, etc.).

test('fetchOnce: preserves caller init fields and adds AbortSignal', async () => {
    let observedInit = null
    const fetchImpl = async (_url, init) => {
        observedInit = init
        return { ok: true, status: 200 }
    }
    const callerInit = {
        method: 'POST',
        headers: { 'X-Caller': 'yes' },
        body: '{}',
    }
    await fetchOnce('http://x/', callerInit, 100, fetchImpl)
    assert.equal(observedInit.method, 'POST')
    assert.equal(observedInit.headers['X-Caller'], 'yes')
    assert.equal(observedInit.body, '{}')
    assert.ok(observedInit.signal, 'must add AbortSignal')
    assert.equal(typeof observedInit.signal.addEventListener, 'function',
        'signal must be a real AbortSignal-like')
})

// ── 4. default fetchImpl falls back to global fetch ──────────────────
// Sanity: the default exists, so callers can drop the 4th arg in
// production code without breaking anything.

test('fetchOnce: fetchImpl defaults to global fetch (signature check)', () => {
    // We can't actually run a real network fetch in this suite, but we
    // can confirm fetchOnce.length is 3 (4th param has a default).
    assert.equal(fetchOnce.length, 3,
        'fetchImpl must have a default; arity should be 3 not 4')
})
