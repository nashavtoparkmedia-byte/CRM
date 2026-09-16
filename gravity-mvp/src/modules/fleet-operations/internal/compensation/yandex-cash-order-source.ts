/**
 * Yandex Fleet order source for cash-order ingestion.
 *
 * One page of POST /v1/parks/orders/list, filtered by park and booked_at, with
 * an explicit timeout on every request and a retry policy that asks the run
 * budget before every attempt and every sleep. The provider cursor lives only
 * inside a slice and is never stored.
 *
 * Nothing the provider returns on failure leaves this module: errors are
 * reduced to a code and an HTTP status, so neither a response body nor a
 * credential can reach a log line, a checkpoint row or an order row.
 */

import { CASH_ORDER_INGESTION_TIMING_V1 as T, type CashOrderBudgetV1 } from './cash-order-ingestion-budget'

export const YANDEX_ORDERS_LIST_URL_V1 = 'https://fleet-api.taxi.yandex.net/v1/parks/orders/list' as const

export const CASH_ORDER_PROVIDER_FAILURES_V1 = [
    'provider_rate_limited',
    'provider_unavailable',
    'provider_server_error',
    'provider_timeout',
    'provider_network_error',
    'provider_auth_failed',
    'provider_request_rejected',
    'provider_response_malformed',
] as const

export type CashOrderProviderFailureV1 = typeof CASH_ORDER_PROVIDER_FAILURES_V1[number]

/** The request-shaping values of one connection. Never logged, never stored. */
export interface CashOrderProviderCredentialV1 {
    clid: string
    apiKey: string
    parkId: string
}

export interface CashOrderPageRequestV1 {
    credentials: CashOrderProviderCredentialV1
    bookedFrom: Date
    bookedTo: Date
    cursor: string | null
    timeoutMs: number
}

export type CashOrderPageResponseV1 =
    | { ok: true; orders: unknown[]; cursor: string | null }
    | { ok: false; kind: 'http'; status: number; retryAfter: string | null }
    | { ok: false; kind: 'timeout' }
    | { ok: false; kind: 'network' }
    | { ok: false; kind: 'malformed' }

export type CashOrderPageFetcherV1 = (request: CashOrderPageRequestV1) => Promise<CashOrderPageResponseV1>

const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/

/**
 * Retry-After as seconds from now: delta-seconds or an HTTP date. A date in the
 * past counts as zero. Anything else counts as absent, never as a guess.
 */
export function parseRetryAfterSecondsV1(value: string | null, wallNowMs: number): number | null {
    if (value === null) return null
    const trimmed = value.trim()
    if (/^\d{1,10}$/.test(trimmed)) return Number(trimmed)
    if (!IMF_FIXDATE.test(trimmed)) return null
    const at = Date.parse(trimmed)
    if (Number.isNaN(at)) return null
    return Math.max(0, Math.ceil((at - wallNowMs) / 1000))
}

/** Reads one provider page. Every outcome is data; this never throws. */
export function createYandexCashOrderPageFetcherV1(fetchImpl: typeof fetch = fetch): CashOrderPageFetcherV1 {
    return async (request) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), request.timeoutMs)
        try {
            let response: Response
            try {
                response = await fetchImpl(YANDEX_ORDERS_LIST_URL_V1, {
                    method: 'POST',
                    cache: 'no-store',
                    signal: controller.signal,
                    headers: {
                        'X-Client-ID': request.credentials.clid,
                        'X-Api-Key': request.credentials.apiKey,
                        'Accept-Language': 'ru',
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        query: {
                            park: {
                                id: request.credentials.parkId,
                                order: {
                                    booked_at: {
                                        from: request.bookedFrom.toISOString(),
                                        to: request.bookedTo.toISOString(),
                                    },
                                },
                            },
                        },
                        limit: T.PAGE_LIMIT,
                        ...(request.cursor === null ? {} : { cursor: request.cursor }),
                    }),
                })
            } catch {
                return controller.signal.aborted ? { ok: false, kind: 'timeout' } : { ok: false, kind: 'network' }
            }

            if (!response.ok) {
                const retryAfter = response.headers.get('retry-after')
                // The body is discarded unread: an upstream error text is not
                // evidence and must not be able to reach a log.
                await response.body?.cancel().catch(() => undefined)
                return { ok: false, kind: 'http', status: response.status, retryAfter }
            }

            let body: unknown
            try {
                body = await response.json()
            } catch {
                return controller.signal.aborted ? { ok: false, kind: 'timeout' } : { ok: false, kind: 'malformed' }
            }
            return readOrdersPage(body)
        } finally {
            clearTimeout(timer)
        }
    }
}

function readOrdersPage(body: unknown): CashOrderPageResponseV1 {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, kind: 'malformed' }
    const page = body as Record<string, unknown>
    if (!Array.isArray(page.orders)) return { ok: false, kind: 'malformed' }
    const cursor = page.cursor
    if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') return { ok: false, kind: 'malformed' }
    return { ok: true, orders: page.orders, cursor: typeof cursor === 'string' && cursor !== '' ? cursor : null }
}

export interface CashOrderRequestProfileV1 {
    /** Longest timeout a request of this profile may use. */
    maxTimeoutMs: number
    /** Attempts allowed when a full-length request times out. */
    maxTimeoutAttempts: number
}

/** Hot passes and targeted refreshes: short requests, at most one timeout retry. */
export const HOT_REQUEST_PROFILE_V1: CashOrderRequestProfileV1 = Object.freeze({
    maxTimeoutMs: T.HOT_REQUEST_TIMEOUT_MAX_MS,
    maxTimeoutAttempts: 2,
})

export const RECONCILIATION_REQUEST_PROFILE_V1: CashOrderRequestProfileV1 = Object.freeze({
    maxTimeoutMs: T.RECONCILIATION_REQUEST_TIMEOUT_MAX_MS,
    maxTimeoutAttempts: 3,
})

export interface CashOrderRequestStatsV1 {
    attempts: number
    /** Every 429 response, retried or not. */
    http429: number
    retries429: number
    retries5xx: number
    timeouts: number
    shortenedAborts: number
}

export function emptyCashOrderRequestStatsV1(): CashOrderRequestStatsV1 {
    return { attempts: 0, http429: 0, retries429: 0, retries5xx: 0, timeouts: 0, shortenedAborts: 0 }
}

export type CashOrderRequestOutcomeV1 =
    | { ok: true; orders: unknown[]; cursor: string | null }
    | {
        ok: false
        code: CashOrderProviderFailureV1 | 'park_time_budget_exhausted'
        httpStatus: number | null
        /** Set only when the provider named a wait that did not fit: persist it as a deferral. */
        deferSeconds: number | null
    }

export interface CashOrderRequestRunnerV1 {
    fetchPage: CashOrderPageFetcherV1
    budget: CashOrderBudgetV1
    profile: CashOrderRequestProfileV1
    sleep: (durationMs: number) => Promise<void>
    /** Uniform in [0, 1), for backoff jitter. */
    random: () => number
    wallNowMs: () => number
    stats: CashOrderRequestStatsV1
}

const MAX_ATTEMPTS = 3
const RATE_LIMIT_BACKOFF_MS = [2_000, 4_000]
const FAST_FAILURE_BACKOFF_MS = [1_000, 3_000]

/**
 * One page with the bounded retry policy.
 *
 * - 429 without Retry-After: back off 2 s, then 4 s (+0-20 %), three attempts.
 * - 429 or 503 with Retry-After: sleep when it fits, otherwise stop and hand
 *   the wait back for a deferral (capped at an hour).
 * - Other 5xx and network errors: back off 1 s, then 3 s (+0-20 %), three attempts.
 * - A full-length timeout retries within the profile's limit. A request whose
 *   timeout the budget had to cut is budget exhaustion, not a provider fault.
 * - 401, 403, any other 4xx and a malformed body are not retried.
 *
 * The code reported is the provider's from an attempt that was not cut short;
 * budget exhaustion is reported only when no such attempt failed first.
 */
export async function requestCashOrderPageV1(
    request: Omit<CashOrderPageRequestV1, 'timeoutMs'>,
    runner: CashOrderRequestRunnerV1,
): Promise<CashOrderRequestOutcomeV1> {
    let attempt = 0
    let lastFailure: { code: CashOrderProviderFailureV1; httpStatus: number | null } | null = null
    const stop = (deferSeconds: number | null = null): CashOrderRequestOutcomeV1 => ({
        ok: false,
        code: lastFailure?.code ?? 'park_time_budget_exhausted',
        httpStatus: lastFailure?.httpStatus ?? null,
        deferSeconds,
    })
    const jittered = (base: number) => Math.round(base * (1 + 0.2 * runner.random()))

    for (;;) {
        if (!runner.budget.admitsRequest()) return stop()
        const timeoutMs = runner.budget.requestTimeoutMs(runner.profile.maxTimeoutMs)
        const shortened = timeoutMs < runner.profile.maxTimeoutMs
        attempt += 1
        runner.stats.attempts += 1
        const response = await runner.fetchPage({ ...request, timeoutMs })
        if (response.ok) return response

        let delayMs: number | null = null
        if (response.kind === 'timeout') {
            runner.stats.timeouts += 1
            if (shortened) {
                runner.stats.shortenedAborts += 1
                return stop()
            }
            lastFailure = { code: 'provider_timeout', httpStatus: null }
            if (attempt < runner.profile.maxTimeoutAttempts) delayMs = jittered(FAST_FAILURE_BACKOFF_MS[attempt - 1])
        } else if (response.kind === 'network') {
            lastFailure = { code: 'provider_network_error', httpStatus: null }
            if (attempt < MAX_ATTEMPTS) delayMs = jittered(FAST_FAILURE_BACKOFF_MS[attempt - 1])
        } else if (response.kind === 'malformed') {
            lastFailure = { code: 'provider_response_malformed', httpStatus: null }
        } else if (response.status === 429 || response.status === 503) {
            if (response.status === 429) runner.stats.http429 += 1
            const code = response.status === 429 ? 'provider_rate_limited' : 'provider_unavailable'
            lastFailure = { code, httpStatus: response.status }
            const retryAfter = parseRetryAfterSecondsV1(response.retryAfter, runner.wallNowMs())
            if (retryAfter !== null) {
                const waitMs = retryAfter * 1000
                if (attempt >= MAX_ATTEMPTS || !runner.budget.admitsSleep(waitMs)) {
                    return stop(Math.min(retryAfter, T.MAX_DEFERRAL_SECONDS))
                }
                delayMs = waitMs
            } else if (attempt < MAX_ATTEMPTS) {
                delayMs = jittered(response.status === 429 ? RATE_LIMIT_BACKOFF_MS[attempt - 1] : FAST_FAILURE_BACKOFF_MS[attempt - 1])
            }
        } else if (response.status >= 500) {
            lastFailure = { code: 'provider_server_error', httpStatus: response.status }
            if (attempt < MAX_ATTEMPTS) delayMs = jittered(FAST_FAILURE_BACKOFF_MS[attempt - 1])
        } else if (response.status === 401 || response.status === 403) {
            lastFailure = { code: 'provider_auth_failed', httpStatus: response.status }
        } else {
            lastFailure = { code: 'provider_request_rejected', httpStatus: response.status }
        }

        if (delayMs === null || !runner.budget.admitsSleep(delayMs)) return stop()
        if (lastFailure.httpStatus === 429) runner.stats.retries429 += 1
        else if (lastFailure.httpStatus !== null && lastFailure.httpStatus >= 500) runner.stats.retries5xx += 1
        await runner.sleep(delayMs)
    }
}

/** The only failure text that may be stored or logged: a code and a status. */
export function sanitizedProviderFailureSummaryV1(code: string, httpStatus: number | null): string {
    return httpStatus === null ? code : `${code} (HTTP ${httpStatus})`
}
