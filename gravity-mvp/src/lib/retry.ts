/**
 * Retry Safety Mechanism — bounded, idempotent retry wrapper.
 *
 * Retries only on transient errors (network, DB locks, timeouts).
 * All retry attempts are logged. Configurable backoff and max attempts.
 * Never retries on logic errors (validation, not found, auth).
 */

import { opsLog } from '@/lib/opsLog'

export interface RetryConfig {
    /** Maximum number of attempts (including first). Default: 3 */
    maxAttempts?: number
    /** Base delay between retries in ms. Default: 1000 */
    baseDelayMs?: number
    /** Backoff multiplier (delay × multiplier per retry). Default: 2 */
    backoffMultiplier?: number
    /** Maximum delay between retries in ms. Default: 10000 */
    maxDelayMs?: number
    /** Operation name for logging */
    operationName: string
}

export interface RetryResult<T> {
    ok: boolean
    data: T | null
    attempts: number
    totalDurationMs: number
    lastError: string | null
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 1000
const DEFAULT_BACKOFF_MULTIPLIER = 2
const DEFAULT_MAX_DELAY_MS = 10000

/**
 * Transient error detection.
 * Returns true for errors that are safe and likely to succeed on retry.
 */
function isTransientError(error: unknown): boolean {
    if (!(error instanceof Error)) return false

    const msg = error.message.toLowerCase()
    const name = error.name.toLowerCase()

    // Network errors
    if (msg.includes('econnrefused')) return true
    if (msg.includes('econnreset')) return true
    if (msg.includes('etimedout')) return true
    if (msg.includes('epipe')) return true
    if (msg.includes('enotfound')) return true
    if (msg.includes('fetch failed')) return true
    if (msg.includes('network')) return true
    if (msg.includes('socket hang up')) return true

    // Database transient errors
    if (msg.includes('deadlock')) return true
    if (msg.includes('lock timeout')) return true
    if (msg.includes('connection terminated')) return true
    if (msg.includes('connection refused')) return true
    if (msg.includes('too many connections')) return true
    if (msg.includes('prepared statement') && msg.includes('already exists')) return true

    // Prisma transient codes
    if (name.includes('prisma') && msg.includes('p1001')) return true // Can't reach DB
    if (name.includes('prisma') && msg.includes('p1002')) return true // DB timeout
    if (name.includes('prisma') && msg.includes('p1008')) return true // Operations timed out
    if (name.includes('prisma') && msg.includes('p1017')) return true // Connection closed
    if (name.includes('prisma') && msg.includes('p2034')) return true // Transaction conflict

    // HTTP transient status codes (from error messages)
    if (msg.includes('status 429')) return true // Rate limit
    if (msg.includes('status 502')) return true // Bad gateway
    if (msg.includes('status 503')) return true // Service unavailable
    if (msg.includes('status 504')) return true // Gateway timeout

    return false
}

/**
 * Execute a function with bounded retry on transient errors.
 *
 * - Only retries on transient errors (network, DB, timeout)
 * - Exponential backoff with configurable ceiling
 * - All attempts logged via opsLog
 * - Returns full result metadata for observability
 *
 * Usage:
 *   const result = await executeWithRetry(
 *       { operationName: 'sync-driver-data' },
 *       async () => await fetchDriverData(driverId)
 *   )
 */
export async function executeWithRetry<T>(
    config: RetryConfig,
    fn: () => Promise<T>
): Promise<RetryResult<T>> {
    const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const baseDelay = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
    const multiplier = config.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER
    const maxDelay = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
    const opName = config.operationName

    const start = Date.now()
    let lastError: string | null = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const data = await fn()
            const totalDurationMs = Date.now() - start

            if (attempt > 1) {
                opsLog('info', 'retry_succeeded', {
                    operation: opName,
                    count: attempt,
                    durationMs: totalDurationMs,
                })
            }

            return { ok: true, data, attempts: attempt, totalDurationMs, lastError: null }
        } catch (error: any) {
            lastError = error.message || String(error)

            // Non-transient error — fail immediately, no retry
            if (!isTransientError(error)) {
                const totalDurationMs = Date.now() - start
                opsLog('error', 'retry_permanent_failure', {
                    operation: opName,
                    error: lastError ?? undefined,
                    count: attempt,
                    durationMs: totalDurationMs,
                })
                return { ok: false, data: null, attempts: attempt, totalDurationMs, lastError }
            }

            opsLog('warn', 'retry_transient_failure', {
                operation: opName,
                error: lastError ?? undefined,
                count: attempt,
            })

            // Last attempt — don't wait, just return failure
            if (attempt === maxAttempts) break

            // Exponential backoff with ceiling
            const delay = Math.min(baseDelay * Math.pow(multiplier, attempt - 1), maxDelay)
            await sleep(delay)
        }
    }

    const totalDurationMs = Date.now() - start
    opsLog('error', 'retry_exhausted', {
        operation: opName,
        error: lastError ?? undefined,
        count: maxAttempts,
        durationMs: totalDurationMs,
    })

    return { ok: false, data: null, attempts: maxAttempts, totalDurationMs, lastError }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Check if an error is transient (exported for testing).
 */
export { isTransientError }
