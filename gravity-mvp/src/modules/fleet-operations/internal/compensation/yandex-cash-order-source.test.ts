import { describe, expect, it } from 'vitest'

import { CashOrderBudgetV1, CASH_ORDER_INGESTION_TIMING_V1 as T } from './cash-order-ingestion-budget'
import {
    createYandexCashOrderPageFetcherV1,
    emptyCashOrderRequestStatsV1,
    HOT_REQUEST_PROFILE_V1,
    parseRetryAfterSecondsV1,
    RECONCILIATION_REQUEST_PROFILE_V1,
    requestCashOrderPageV1,
    sanitizedProviderFailureSummaryV1,
    YANDEX_ORDERS_LIST_URL_V1,
    type CashOrderPageRequestV1,
    type CashOrderPageResponseV1,
    type CashOrderRequestProfileV1,
} from './yandex-cash-order-source'

const CREDENTIALS = { clid: 'client-id-value', apiKey: 'secret-key-value', parkId: 'ext-yoko' }
const REQUEST = {
    credentials: CREDENTIALS,
    bookedFrom: new Date('2026-09-16T06:00:00.000Z'),
    bookedTo: new Date('2026-09-16T09:10:00.000Z'),
    cursor: null,
}

/** A clock the test advances; sleeps and provider latency move it. */
function fakeClock() {
    let now = 0
    return {
        clock: { nowMs: () => now },
        advance: (ms: number) => { now += ms },
        get now() { return now },
    }
}

function runner(
    responses: Array<CashOrderPageResponseV1 | { latencyMs: number; response: CashOrderPageResponseV1 }>,
    options: { budgetMs?: number; profile?: CashOrderRequestProfileV1; wallNowMs?: number } = {},
) {
    const time = fakeClock()
    const budget = CashOrderBudgetV1.fromNow(time.clock, options.budgetMs ?? 40_000)
    const requests: CashOrderPageRequestV1[] = []
    const sleeps: number[] = []
    const stats = emptyCashOrderRequestStatsV1()
    let index = 0
    return {
        time,
        requests,
        sleeps,
        stats,
        runner: {
            fetchPage: async (request: CashOrderPageRequestV1) => {
                requests.push(request)
                const next = responses[Math.min(index++, responses.length - 1)]
                if ('latencyMs' in next) {
                    // A timeout never outlasts the timeout the request was given.
                    const timedOut = next.response.ok === false && next.response.kind === 'timeout'
                    time.advance(timedOut ? request.timeoutMs : next.latencyMs)
                    return next.response
                }
                time.advance(50)
                return next
            },
            budget,
            profile: options.profile ?? HOT_REQUEST_PROFILE_V1,
            sleep: async (ms: number) => { sleeps.push(ms); time.advance(ms) },
            random: () => 0,
            wallNowMs: () => options.wallNowMs ?? Date.parse('2026-09-16T09:00:00.000Z'),
            stats,
        },
    }
}

const ok: CashOrderPageResponseV1 = { ok: true, orders: [{ id: 'o1' }], cursor: null }
const http = (status: number, retryAfter: string | null = null): CashOrderPageResponseV1 =>
    ({ ok: false, kind: 'http', status, retryAfter })

describe('Retry-After parsing', () => {
    const now = Date.parse('2026-09-16T09:00:00.000Z')

    it('reads delta-seconds', () => {
        expect(parseRetryAfterSecondsV1('60', now)).toBe(60)
        expect(parseRetryAfterSecondsV1(' 0 ', now)).toBe(0)
    })

    it('reads an HTTP date relative to now', () => {
        expect(parseRetryAfterSecondsV1('Wed, 16 Sep 2026 09:00:30 GMT', now)).toBe(30)
    })

    it('counts a past HTTP date as zero', () => {
        expect(parseRetryAfterSecondsV1('Wed, 16 Sep 2026 08:00:00 GMT', now)).toBe(0)
    })

    it('treats anything else as absent', () => {
        for (const value of [null, '', '-5', '1.5', 'soon', '2026-09-16T09:00:30Z', 'Wed, 16 Sep 2026 09:00:30 +0000']) {
            expect(parseRetryAfterSecondsV1(value, now)).toBeNull()
        }
    })
})

describe('bounded request retries', () => {
    it('returns a page on the first success', async () => {
        const fixture = runner([ok])
        expect(await requestCashOrderPageV1(REQUEST, fixture.runner)).toEqual(ok)
        expect(fixture.requests[0].timeoutMs).toBe(T.HOT_REQUEST_TIMEOUT_MAX_MS)
    })

    it('backs off 2 s then 4 s on 429 without Retry-After and stops after three attempts', async () => {
        const fixture = runner([http(429), http(429), http(429)])
        const outcome = await requestCashOrderPageV1(REQUEST, fixture.runner)
        expect(outcome).toEqual({ ok: false, code: 'provider_rate_limited', httpStatus: 429, deferSeconds: null })
        expect(fixture.sleeps).toEqual([2_000, 4_000])
        expect(fixture.stats).toMatchObject({ attempts: 3, retries429: 2 })
    })

    it('adds at most twenty percent jitter to a backoff', async () => {
        const fixture = runner([http(429), ok])
        fixture.runner.random = () => 0.999
        await requestCashOrderPageV1(REQUEST, fixture.runner)
        expect(fixture.sleeps[0]).toBeGreaterThan(2_000)
        expect(fixture.sleeps[0]).toBeLessThanOrEqual(2_400)
    })

    it('sleeps a Retry-After in seconds that fits, then retries', async () => {
        const fixture = runner([http(429, '5'), ok])
        expect(await requestCashOrderPageV1(REQUEST, fixture.runner)).toEqual(ok)
        expect(fixture.sleeps).toEqual([5_000])
    })

    it('stops on a Retry-After that does not fit and hands back the deferral', async () => {
        const fixture = runner([http(429, '60')])
        expect(await requestCashOrderPageV1(REQUEST, fixture.runner))
            .toEqual({ ok: false, code: 'provider_rate_limited', httpStatus: 429, deferSeconds: 60 })
        expect(fixture.sleeps).toEqual([])
    })

    it('honours an HTTP-date Retry-After on 503', async () => {
        const fixture = runner([http(503, 'Wed, 16 Sep 2026 09:02:00 GMT')])
        expect(await requestCashOrderPageV1(REQUEST, fixture.runner))
            .toEqual({ ok: false, code: 'provider_unavailable', httpStatus: 503, deferSeconds: 120 })
    })

    it('caps a deferral at one hour', async () => {
        const fixture = runner([http(429, '86400')])
        expect(await requestCashOrderPageV1(REQUEST, fixture.runner)).toMatchObject({ deferSeconds: 3_600 })
    })

    it('treats an invalid Retry-After as absent', async () => {
        const fixture = runner([http(429, 'later'), ok])
        expect(await requestCashOrderPageV1(REQUEST, fixture.runner)).toEqual(ok)
        expect(fixture.sleeps).toEqual([2_000])
    })

    it('retries 5xx and network errors with 1 s and 3 s backoff', async () => {
        const fixture = runner([http(500), { ok: false, kind: 'network' }, http(502)])
        expect(await requestCashOrderPageV1(REQUEST, fixture.runner))
            .toEqual({ ok: false, code: 'provider_server_error', httpStatus: 502, deferSeconds: null })
        expect(fixture.sleeps).toEqual([1_000, 3_000])
        expect(fixture.stats.retries5xx).toBe(1)
    })

    it('does not retry 401, 403, other 4xx or a malformed body', async () => {
        for (const [response, code] of [
            [http(401), 'provider_auth_failed'],
            [http(403), 'provider_auth_failed'],
            [http(400), 'provider_request_rejected'],
            [{ ok: false, kind: 'malformed' }, 'provider_response_malformed'],
        ] as const) {
            const fixture = runner([response, ok])
            expect(await requestCashOrderPageV1(REQUEST, fixture.runner)).toMatchObject({ ok: false, code })
            expect(fixture.stats.attempts).toBe(1)
        }
    })

    it('retries a full-length hot timeout once at most', async () => {
        const timeout = { latencyMs: 0, response: { ok: false, kind: 'timeout' } as CashOrderPageResponseV1 }
        const fixture = runner([timeout, timeout, timeout], { budgetMs: 60_000 })
        expect(await requestCashOrderPageV1(REQUEST, fixture.runner))
            .toEqual({ ok: false, code: 'provider_timeout', httpStatus: null, deferSeconds: null })
        expect(fixture.stats.attempts).toBe(2)
    })

    it('allows reconciliation up to three timeout attempts', async () => {
        const timeout = { latencyMs: 0, response: { ok: false, kind: 'timeout' } as CashOrderPageResponseV1 }
        const fixture = runner([timeout, timeout, timeout], { budgetMs: 200_000, profile: RECONCILIATION_REQUEST_PROFILE_V1 })
        await requestCashOrderPageV1(REQUEST, fixture.runner)
        expect(fixture.stats.attempts).toBe(3)
        expect(fixture.requests.every((request) => request.timeoutMs === T.RECONCILIATION_REQUEST_TIMEOUT_MAX_MS)).toBe(true)
    })

    it('reports budget exhaustion, not a provider fault, for a request whose timeout was cut', async () => {
        const timeout = { latencyMs: 0, response: { ok: false, kind: 'timeout' } as CashOrderPageResponseV1 }
        const fixture = runner([timeout], { budgetMs: 25_000 })
        expect(await requestCashOrderPageV1(REQUEST, fixture.runner))
            .toEqual({ ok: false, code: 'park_time_budget_exhausted', httpStatus: null, deferSeconds: null })
        expect(fixture.requests[0].timeoutMs).toBe(7_000)
        expect(fixture.stats.shortenedAborts).toBe(1)
    })

    it('keeps the provider code of an earlier full-length failure over a later cut request', async () => {
        const timeout = { latencyMs: 0, response: { ok: false, kind: 'timeout' } as CashOrderPageResponseV1 }
        // The first attempt times out at the full 10 s; after a 1 s backoff 25 s
        // remain, so the retry gets 7 s and is cut short.
        const fixture = runner([timeout, timeout], { budgetMs: 36_000 })
        expect(await requestCashOrderPageV1(REQUEST, fixture.runner)).toMatchObject({ code: 'provider_timeout' })
        expect(fixture.requests.map((request) => request.timeoutMs)).toEqual([10_000, 7_000])
        expect(fixture.stats.shortenedAborts).toBe(1)
    })

    it('starts no request below the admission floor', async () => {
        const fixture = runner([ok], { budgetMs: T.ADMISSION_FLOOR_MS - 1 })
        expect(await requestCashOrderPageV1(REQUEST, fixture.runner)).toMatchObject({ code: 'park_time_budget_exhausted' })
        expect(fixture.requests).toEqual([])
    })

    it('starts no sleep that would leave less than the admission floor', async () => {
        const fixture = runner([http(429), ok], { budgetMs: 24_000 })
        expect(await requestCashOrderPageV1(REQUEST, fixture.runner)).toMatchObject({ code: 'provider_rate_limited' })
        expect(fixture.sleeps).toEqual([])
    })
})

describe('the provider page fetcher', () => {
    function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
        const calls: Array<{ url: string; init: RequestInit }> = []
        const impl = (async (url: string, init: RequestInit) => {
            calls.push({ url, init })
            return handler(url, init)
        }) as unknown as typeof fetch
        return { impl, calls }
    }
    const request: CashOrderPageRequestV1 = { ...REQUEST, cursor: 'cursor-2', timeoutMs: 5_000 }

    it('sends the park, the booked_at window, the page limit and the cursor', async () => {
        const stub = stubFetch(async () => new Response(JSON.stringify({ orders: [], cursor: '' }), { status: 200 }))
        const response = await createYandexCashOrderPageFetcherV1(stub.impl)(request)
        expect(response).toEqual({ ok: true, orders: [], cursor: null })
        expect(stub.calls[0].url).toBe(YANDEX_ORDERS_LIST_URL_V1)
        expect(stub.calls[0].init.method).toBe('POST')
        expect(stub.calls[0].init.signal).toBeInstanceOf(AbortSignal)
        expect(stub.calls[0].init.headers).toMatchObject({ 'X-Client-ID': 'client-id-value', 'X-Api-Key': 'secret-key-value' })
        expect(JSON.parse(String(stub.calls[0].init.body))).toEqual({
            query: {
                park: {
                    id: 'ext-yoko',
                    order: { booked_at: { from: '2026-09-16T06:00:00.000Z', to: '2026-09-16T09:10:00.000Z' } },
                },
            },
            limit: 500,
            cursor: 'cursor-2',
        })
    })

    it('reads a continuation cursor', async () => {
        const stub = stubFetch(async () => new Response(JSON.stringify({ orders: [{ id: 'o1' }], cursor: 'next' }), { status: 200 }))
        expect(await createYandexCashOrderPageFetcherV1(stub.impl)(request))
            .toEqual({ ok: true, orders: [{ id: 'o1' }], cursor: 'next' })
    })

    it('returns the status and Retry-After of a failure, never its body', async () => {
        const stub = stubFetch(async () => new Response('upstream said secret-key-value', {
            status: 429, headers: { 'Retry-After': '30' },
        }))
        const response = await createYandexCashOrderPageFetcherV1(stub.impl)(request)
        expect(response).toEqual({ ok: false, kind: 'http', status: 429, retryAfter: '30' })
        expect(JSON.stringify(response)).not.toContain('secret')
    })

    it('fails a malformed body safely', async () => {
        for (const body of ['not json', '[]', '{"orders":{}}', '{"cursor":"x"}', '{"orders":[],"cursor":5}']) {
            const stub = stubFetch(async () => new Response(body, { status: 200 }))
            expect(await createYandexCashOrderPageFetcherV1(stub.impl)(request)).toEqual({ ok: false, kind: 'malformed' })
        }
    })

    it('aborts at the timeout', async () => {
        const stub = stubFetch((_url, init) => new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }))
        const response = await createYandexCashOrderPageFetcherV1(stub.impl)({ ...request, timeoutMs: 20 })
        expect(response).toEqual({ ok: false, kind: 'timeout' })
    })

    it('reports a network failure without its message', async () => {
        const stub = stubFetch(async () => { throw new Error('connect ECONNREFUSED with secret-key-value') })
        const response = await createYandexCashOrderPageFetcherV1(stub.impl)(request)
        expect(response).toEqual({ ok: false, kind: 'network' })
    })

    it('keeps stored failure text to a code and a status', () => {
        expect(sanitizedProviderFailureSummaryV1('provider_auth_failed', 401)).toBe('provider_auth_failed (HTTP 401)')
        expect(sanitizedProviderFailureSummaryV1('provider_timeout', null)).toBe('provider_timeout')
    })
})
