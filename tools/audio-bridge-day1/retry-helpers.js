// Retry-with-backoff for ONE specific operation: the bridge → CRM
// `finalize` POST. Deliberately not a generic retry framework — the
// policy here is hardcoded, audited at PR review, and frozen at ship.
//
// Why this exists
// ───────────────
// Before this helper, a transient blip between bridge and CRM at the
// moment of finalize (CRM restart, brief network hiccup, GC pause)
// would leave the Call row stuck in `active`/`greeting` until the
// stale-session reaper from PR #43 swept it 30 minutes later. UI was
// lying about the call's state for that whole window. Three short
// retries close ~95% of those incidents — anything beyond is a real
// outage and falls through to the existing reaper.
//
// Policy (FIXED, not configurable in production)
// ──────────────────────────────────────────────
//   attempt | per-attempt timeout | backoff before next
//      1    |        5 s          |       500 ms
//      2    |        5 s          |      1500 ms
//      3    |        5 s          |        —
//   total worst-case: 3×5 s + 0.5 s + 1.5 s ≈ 17 s
//
//   Retried errors (transient):
//     - fetch throw (ECONNREFUSED / ECONNRESET / DNS / network)
//     - per-attempt timeout (AbortController fires)
//     - HTTP 5xx (server temporarily unhealthy)
//
//   NOT retried (caller-error, retry won't help):
//     - HTTP 4xx (validation error / bad payload / not_found)
//
// Out of scope
// ────────────
// This helper is ONLY for finalize. It does NOT retry `postState`
// (PR #51 — soft telemetry, idempotent server-side) or
// `appendTranscript` (per-utterance, lossy by design). Different
// reliability requirements; different scope.

'use strict'

const { opsLog } = require('./opsLog')

// Hardcoded production policy. The `_createRetryFinalize` factory below
// exists ONLY so unit tests can shrink the timers to make the suite
// run in milliseconds; production code uses the frozen object below.
const PRODUCTION_POLICY = Object.freeze({
    ATTEMPT_TIMEOUT_MS: 5000,
    BACKOFFS_MS: Object.freeze([500, 1500]),  // before attempt 2, 3
    ATTEMPTS: 3,
})

function isRetryable5xx(status) {
    return status >= 500 && status < 600
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchOnce(url, init, timeoutMs, fetchImpl) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fetchImpl(url, { ...init, signal: controller.signal })
    } finally {
        clearTimeout(timer)
    }
}

/**
 * Factory wrapping a policy. Production calls this once with the frozen
 * `PRODUCTION_POLICY`. Tests can pass a sub-millisecond policy so the
 * suite runs in 200 ms total instead of half a minute.
 *
 * Returned function:
 *   retryFinalizeRequest({ url, payload, init, callId, fetchImpl })
 *     → { ok: true, status, body, attempts, totalMs }   on success
 *     → throws Error                                    on final failure
 *
 *  `init` is passed to fetch as-is (headers, dispatcher, etc.); we add
 *  `method: 'POST'`, the JSON body and the AbortSignal. `fetchImpl`
 *  defaults to the global `fetch`; tests inject a mock.
 *
 *  `callId` is included verbatim in every opsLog line so a tail
 *  observer can correlate retries to a specific Call row.
 */
function _createRetryFinalize(policy) {
    return async function retryFinalizeRequest({ url, payload, init, callId, fetchImpl }) {
        const _fetch = fetchImpl ?? fetch
        const start = Date.now()
        let lastError = null

        for (let attempt = 1; attempt <= policy.ATTEMPTS; attempt++) {
            let res
            try {
                res = await fetchOnce(
                    url,
                    {
                        ...init,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
                        body: JSON.stringify(payload),
                    },
                    policy.ATTEMPT_TIMEOUT_MS,
                    _fetch,
                )
            } catch (err) {
                // Network failure or AbortController timeout.
                lastError = err
                if (attempt < policy.ATTEMPTS) {
                    opsLog('warn', 'crm_finalize_retry', {
                        callId,
                        attempt,
                        reason: 'network_or_timeout',
                        error: err?.message ?? String(err),
                    })
                    await sleep(policy.BACKOFFS_MS[attempt - 1])
                    continue
                }
                break
            }

            // 2xx — done.
            if (res.ok) {
                let body = {}
                try { body = await res.json() } catch { /* may be empty */ }
                opsLog('info', 'crm_finalize_succeeded', {
                    callId,
                    attempts: attempt,
                    totalMs: Date.now() - start,
                    status: res.status,
                })
                return {
                    ok: true,
                    status: res.status,
                    body,
                    attempts: attempt,
                    totalMs: Date.now() - start,
                }
            }

            // 5xx — transient, retry.
            if (isRetryable5xx(res.status)) {
                lastError = new Error(`HTTP ${res.status}`)
                if (attempt < policy.ATTEMPTS) {
                    opsLog('warn', 'crm_finalize_retry', {
                        callId,
                        attempt,
                        reason: '5xx',
                        status: res.status,
                    })
                    await sleep(policy.BACKOFFS_MS[attempt - 1])
                    continue
                }
                break
            }

            // 4xx — caller-side rejection. No retry — the next attempt
            // would just hit the same validation error. Surface
            // immediately so the bug is visible, not masked by 3-tap
            // retries.
            const errText = await res.text().catch(() => '')
            const err4xx = new Error(`HTTP ${res.status} ${errText.slice(0, 200)}`)
            opsLog('error', 'crm_finalize_failed', {
                callId,
                attempts: attempt,
                totalMs: Date.now() - start,
                reason: '4xx_no_retry',
                status: res.status,
                // 4xx isn't a stale-cleanup case — the row WILL be
                // updated by finalize-route if at all; bridge sent
                // something the route rejected. Operator should look
                // at this manually, not wait for the reaper.
                staleCleanupExpected: false,
            })
            throw err4xx
        }

        // All attempts exhausted on transient failures.
        opsLog('error', 'crm_finalize_failed', {
            callId,
            attempts: policy.ATTEMPTS,
            totalMs: Date.now() - start,
            reason: 'attempts_exhausted',
            error: lastError?.message ?? 'unknown',
            // Existing stale-session reaper (PR #43) sweeps records
            // stuck > 30 min. After all 3 retries fail the Call row
            // is still in `active`/`greeting`/`starting` and will be
            // marked `failed` by the reaper. This flag tells the
            // operator «degraded, but eventual consistency will
            // self-heal».
            staleCleanupExpected: true,
        })
        throw lastError ?? new Error('finalize failed (no diagnostic)')
    }
}

// Production singleton.
const retryFinalizeRequest = _createRetryFinalize(PRODUCTION_POLICY)

module.exports = {
    retryFinalizeRequest,
    // Test seam — tests inject a faster policy to keep the suite snappy.
    // NOT for production use.
    _createRetryFinalize,
    PRODUCTION_POLICY,
}
