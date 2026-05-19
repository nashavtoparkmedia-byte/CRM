// Pure orchestration helpers for the /api/health endpoint.
//
// Lives in plain `.js` (CommonJS) — deliberately not coupled to
// Next.js / Prisma / @aws-sdk — so a `node:test` unit-test can `require()`
// it directly without a tsx loader and without any live infra.
//
// The matching `health.ts` sibling provides the actual per-dependency
// pings (Postgres / Redis / MinIO / FS-ESL). Everything in THIS file is
// pure: status composition + per-check timeout wrapper.

'use strict'

/**
 * Compose the response body from a list of per-dependency check results.
 *
 * Status policy (frozen — drives monitor alerts):
 *   - all checks ok    → "ok"
 *   - 0 < failed < N   → "degraded"
 *   - all checks failed → "down"
 *
 * `ts` is injected via the `now` argument so tests can pin it.
 *
 * @param {Array<{name: string, ok: boolean, ms: number, error?: string}>} checks
 * @param {Date} [now] — defaults to `new Date()` at call time
 * @returns {{status: 'ok'|'degraded'|'down', checks: Array, ts: string}}
 */
function composeHealthResponse(checks, now) {
    const ts = (now ?? new Date()).toISOString()
    const total = checks.length
    const failed = checks.filter(c => !c.ok).length

    let status
    if (total === 0) {
        // Empty check set is treated as "down" — a misconfigured endpoint
        // shouldn't masquerade as healthy.
        status = 'down'
    } else if (failed === 0) {
        status = 'ok'
    } else if (failed >= total) {
        status = 'down'
    } else {
        status = 'degraded'
    }

    return { status, checks, ts }
}

/**
 * Run a single check function with its own timeout and exception net.
 * Guarantees the returned Check object always has a numeric `ms`, never
 * throws, never leaks a rejected promise to the caller.
 *
 * Why a custom wrapper instead of `Promise.race`:
 *   - We need the timeout branch to also report `ms` (= the actual
 *     wall-clock spent waiting), not a magic number.
 *   - We want a consistent `error` field shape on both timeout AND
 *     thrown exceptions.
 *   - `Promise.race` would leave the slow promise dangling — `setTimeout`
 *     is cleared on success below.
 *
 * @param {string} name — dependency name (e.g. "redis"); used in the
 *                        Check object when the wrapper has to synthesise
 *                        a failure (timeout / thrown exception).
 * @param {() => Promise<{name: string, ok: boolean, ms: number, error?: string}>} fn
 *                      — async factory producing the check. Called once.
 * @param {number} timeoutMs
 * @param {() => number} [nowFn] — injected for deterministic tests
 * @returns {Promise<{name: string, ok: boolean, ms: number, error?: string}>}
 */
function withCheckTimeout(name, fn, timeoutMs, nowFn) {
    const now = nowFn ?? Date.now
    return new Promise((resolve) => {
        const start = now()
        let settled = false
        const finish = (check) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(check)
        }
        const timer = setTimeout(() => {
            finish({ name, ok: false, ms: now() - start, error: 'timeout' })
        }, timeoutMs)

        // Wrap fn() in Promise.resolve(fn()) so both synchronous throws
        // and async rejections land in the same catch.
        Promise.resolve()
            .then(() => fn())
            .then(check => finish(check))
            .catch(err => finish({
                name,
                ok: false,
                ms: now() - start,
                error: err?.message ?? String(err),
            }))
    })
}

module.exports = { composeHealthResponse, withCheckTimeout }
