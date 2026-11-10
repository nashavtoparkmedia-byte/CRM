// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * F-1: the native mobile logout, `POST /api/mobile/session/logout`.
 *
 * The request boundary (proxy.ts), the route and the Identity Access session
 * code run for real: next/server, the signed session, the BR-4 resolver. Stand-ins
 * are limited to request plumbing and storage:
 *   - next/headers `cookies()` is served from the Cookie header the proxy
 *     forwards downstream, and records what the route sets;
 *   - the logout barrier (read) and the push revocation that writes it are an
 *     in-memory set, which a test can make unreadable or unwritable;
 *   - `@/lib/prisma` is an empty object, so any database use outside those
 *     two fails the test.
 * The barrier on real PostgreSQL is proven in
 * modules/identity-access/public/v1/mobile-session-logout.postgres.test.ts.
 */

const state = vi.hoisted(() => ({
    barred: new Set<string>(),
    barrierUnreadable: false,
    barrierUnwritable: false,
    revocations: [] as Array<{ deviceId: string, operatorId: string, sessionBindingId: string | null, barrierEntry: string | null }>,
    requestCookies: new Map<string, string>(),
    responseCookies: [] as Array<{ name: string, value: string, maxAge?: number }>,
}))

vi.mock('@/modules/identity-access/internal/mobile-session-barrier', () => ({
    prismaMobileSessionBarrierV1: {
        isBarred: vi.fn(async (deviceId: string, entry: string) => {
            if (state.barrierUnreadable) throw new Error('database unavailable')
            return state.barred.has(`${deviceId}|${entry}`)
        }),
    },
}))
vi.mock('@/modules/identity-access/application/mobile-push-registration-operations', () => ({
    revokeMobilePushDeviceForLogoutV1: vi.fn(async (input: {
        principal: { deviceId: string, runtimeOperatorId: string }
        sessionBindingId: string | null
        barrierEntry: string | null
    }) => {
        if (state.barrierUnwritable) throw new Error('database unavailable')
        state.revocations.push({
            deviceId: input.principal.deviceId,
            operatorId: input.principal.runtimeOperatorId,
            sessionBindingId: input.sessionBindingId,
            barrierEntry: input.barrierEntry,
        })
        if (input.barrierEntry) state.barred.add(`${input.principal.deviceId}|${input.barrierEntry}`)
        return { revoked: 1 }
    }),
}))
vi.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => (state.requestCookies.has(name) ? { name, value: state.requestCookies.get(name)! } : undefined),
        set: (name: string, value: string, options?: { maxAge?: number }) => {
            state.responseCookies.push({ name, value, maxAge: options?.maxAge })
        },
        delete: (name: string) => { state.responseCookies.push({ name, value: '', maxAge: 0 }) },
    }),
    headers: async () => new Headers(),
}))
vi.mock('@/lib/prisma', () => ({ prisma: {} }))

const { NextRequest } = await import('next/server')
const { proxy, MOBILE_SHELL_UA_TOKEN } = await import('@/proxy')
const route = await import('@/app/api/mobile/session/logout/route')
const {
    issueMobileSession,
    MOBILE_SESSION_COOKIE,
    mobileSessionBarrierEntryV1,
    mobileSessionBindingIdV1,
    verifyMobileSession,
} = await import('@/modules/identity-access/public/v1/mobile-session-credentials')
const { resolveCookieOperatorV1 } = await import('@/modules/identity-access/public/v1/mobile-session-operator')

const ENV = { MOBILE_ACCESS_USER: 'mobile-operator', MOBILE_ACCESS_PASS: 'correct horse battery staple' }
const SHELL_UA = `Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 ${MOBILE_SHELL_UA_TOKEN}1`
const NATIVE_UA = 'okhttp/4.12.0'
const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120'
const STAFF_COOKIE = '__Host-yoko_staff_session'
const A = 'u2'
const B = 'u1'
const DEVICE = 'a1b2c3d4e5f6a7b8'
const PATH = '/api/mobile/session/logout'

function session(operator = A, device = DEVICE, nowMs = Date.now()) {
    return issueMobileSession(operator, device, ENV, nowMs) as string
}

function logoutRequest(init: {
    ua?: string
    cookies?: Record<string, string>
    contentType?: string | null
    body?: string
    path?: string
    headers?: Record<string, string>
} = {}) {
    const headers = new Headers({ 'user-agent': init.ua ?? SHELL_UA })
    if (init.contentType !== null) headers.set('content-type', init.contentType ?? 'application/json')
    for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value)
    const pairs = Object.entries(init.cookies ?? {}).map(([name, value]) => `${name}=${value}`)
    if (pairs.length) headers.set('cookie', pairs.join('; '))
    return new NextRequest(new URL(`https://yokoone.ru${init.path ?? PATH}`), {
        method: 'POST',
        headers,
        body: init.body ?? '{}',
    })
}

function downstreamCookieHeader(response: Response, original: Request): string | null {
    const overridden = (response.headers.get('x-middleware-override-headers') ?? '').split(',').map(h => h.trim())
    if (!overridden.includes('cookie')) return original.headers.get('cookie')
    return response.headers.get('x-middleware-request-cookie')
}

/** The proxy, then — if it lets the request through — the real route with the downstream cookies. */
async function call(req: InstanceType<typeof NextRequest>) {
    const gate = await proxy(req)
    const passed = gate.headers.get('x-middleware-next') === '1'
    const header = downstreamCookieHeader(gate, req)
    state.requestCookies = new Map((header ?? '').split(';').map(p => p.trim()).filter(Boolean).map(p => {
        const i = p.indexOf('=')
        return [p.slice(0, i), p.slice(i + 1)] as [string, string]
    }))
    state.responseCookies = []
    if (!passed) return { passed, header, status: gate.status, body: await gate.text(), response: gate }
    const response = await route.POST(req)
    return { passed, header, status: response.status, body: await response.text(), response }
}

function revocationsBefore() {
    return state.revocations.length
}

beforeEach(() => {
    process.env.MOBILE_ACCESS_USER = ENV.MOBILE_ACCESS_USER
    process.env.MOBILE_ACCESS_PASS = ENV.MOBILE_ACCESS_PASS
    delete process.env.MOBILE_SESSION_REVOCATION_EPOCH
    delete process.env.STAFF_SESSION_SECRET
    delete process.env.YOKO_STAFF_SESSION_ENFORCE
    state.barred.clear()
    state.barrierUnreadable = false
    state.barrierUnwritable = false
    state.revocations = []
    state.requestCookies = new Map()
    state.responseCookies = []
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('a live session is ended, exactly that session', () => {
    test('shell lane: 204 with no body and no-store; the barrier entry written is the presented session\'s own; both cookies cleared', async () => {
        const token = session()
        const principal = verifyMobileSession(token, ENV)!
        const result = await call(logoutRequest({ cookies: { [MOBILE_SESSION_COOKIE]: token, crm_user_id: A } }))

        expect(result.passed).toBe(true)
        expect(result.status).toBe(204)
        expect(result.body).toBe('')
        expect(result.response.headers.get('cache-control')).toBe('no-store')
        expect(result.response.headers.get('location')).toBeNull()
        expect(state.revocations).toEqual([{
            deviceId: DEVICE,
            operatorId: A,
            sessionBindingId: mobileSessionBindingIdV1(principal),
            barrierEntry: mobileSessionBarrierEntryV1(principal),
        }])
        expect(state.responseCookies).toEqual([
            { name: MOBILE_SESSION_COOKIE, value: '', maxAge: 0 },
            { name: 'crm_user_id', value: '', maxAge: 0 },
        ])
    })

    test('after it, the same token is refused everywhere: the resolver, a shell page and a shell API call', async () => {
        const token = session()
        expect((await call(logoutRequest({ cookies: { [MOBILE_SESSION_COOKIE]: token } }))).status).toBe(204)

        expect(await resolveCookieOperatorV1(token, A)).toEqual({ kind: 'mobile_session_refused' })
        const page = await proxy(new NextRequest(new URL('https://yokoone.ru/messages'), {
            headers: { 'user-agent': SHELL_UA, cookie: `${MOBILE_SESSION_COOKIE}=${token}` },
        }))
        expect(page.status).toBe(303)
        const api = await proxy(new NextRequest(new URL('https://yokoone.ru/api/mobile/push-registration'), {
            method: 'POST',
            headers: { 'user-agent': SHELL_UA, 'content-type': 'application/json', cookie: `${MOBILE_SESSION_COOKIE}=${token}` },
            body: '{}',
        }))
        expect(api.status).toBe(401)
    })

    test('a native client without the shell marker, and the browser lane, end it the same way', async () => {
        for (const ua of [NATIVE_UA, DESKTOP_UA]) {
            const token = session(A, ua === NATIVE_UA ? 'n1n2n3n4n5n6n7n8' : 'd1d2d3d4d5d6d7d8')
            const result = await call(logoutRequest({ ua, cookies: { [MOBILE_SESSION_COOKIE]: token } }))
            expect(result.status).toBe(204)
            expect(state.revocations.at(-1)?.barrierEntry).toBe(mobileSessionBarrierEntryV1(verifyMobileSession(token, ENV)!))
        }
        expect(state.revocations).toHaveLength(2)
    })

    test('nothing in the body or headers selects a device, operator or session; crm_user_id is never believed', async () => {
        const token = session(A)
        const other = verifyMobileSession(session(B, 'f0f1f2f3f4f5f6f7'), ENV)!
        const result = await call(logoutRequest({
            cookies: { [MOBILE_SESSION_COOKIE]: token, crm_user_id: B },
            headers: { 'x-yoko-operator': B, 'x-yoko-device': 'f0f1f2f3f4f5f6f7' },
            body: JSON.stringify({
                deviceId: 'f0f1f2f3f4f5f6f7',
                operatorId: B,
                sessionBindingId: mobileSessionBindingIdV1(other),
                barrierEntry: mobileSessionBarrierEntryV1(other),
            }),
        }))
        expect(result.status).toBe(204)
        expect(state.revocations).toHaveLength(1)
        expect(state.revocations[0]).toMatchObject({ deviceId: DEVICE, operatorId: A })
        expect(state.revocations[0].barrierEntry).toBe(mobileSessionBarrierEntryV1(verifyMobileSession(token, ENV)!))
    })

    test('a co-present staff cookie neither blocks the mobile logout nor is touched by it', async () => {
        const token = session()
        const result = await call(logoutRequest({
            ua: DESKTOP_UA,
            cookies: { [MOBILE_SESSION_COOKIE]: token, [STAFF_COOKIE]: 'v1.payload.signature' },
        }))
        expect(result.status).toBe(204)
        expect(state.revocations).toHaveLength(1)
        expect(state.responseCookies.map(c => c.name)).not.toContain(STAFF_COOKIE)
    })
})

describe('nothing to end: 204, and no side effect at all', () => {
    const dead: Array<[string, () => string]> = [
        ['a forged signature', () => { const [payload] = session().split('.'); return `${payload}.${Buffer.alloc(32, 1).toString('base64url')}` }],
        ['an edited payload', () => {
            const [payload, signature] = session().split('.')
            const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
            return `${Buffer.from(JSON.stringify({ ...claims, op: B })).toString('base64url')}.${signature}`
        }],
        ['junk', () => 'junk'],
        ['an empty value', () => ''],
        ['an expired session', () => session(A, DEVICE, Date.now() - 13 * 3600_000)],
    ]

    test.each(dead)('%s', async (_name, make) => {
        for (const ua of [SHELL_UA, NATIVE_UA, DESKTOP_UA]) {
            const result = await call(logoutRequest({ ua, cookies: { [MOBILE_SESSION_COOKIE]: make(), crm_user_id: A } }))
            expect(result.passed, ua).toBe(true)
            expect(result.status, ua).toBe(204)
            expect(result.body).toBe('')
            expect(state.responseCookies).toEqual([])
        }
        expect(state.revocations).toEqual([])
    })

    test('no session cookie at all', async () => {
        for (const ua of [SHELL_UA, NATIVE_UA, DESKTOP_UA]) {
            const result = await call(logoutRequest({ ua, cookies: { crm_user_id: A } }))
            expect(result.status).toBe(204)
            expect(state.responseCookies).toEqual([])
        }
        expect(state.revocations).toEqual([])
    })

    test('a session of an older revocation epoch', async () => {
        const token = session()
        process.env.MOBILE_SESSION_REVOCATION_EPOCH = '7'
        const result = await call(logoutRequest({ cookies: { [MOBILE_SESSION_COOKIE]: token } }))
        expect(result.status).toBe(204)
        expect(state.revocations).toEqual([])
        expect(state.responseCookies).toEqual([])
    })

    test('an already logged-out session: a repeat is idempotent and writes nothing more', async () => {
        const token = session()
        expect((await call(logoutRequest({ cookies: { [MOBILE_SESSION_COOKIE]: token } }))).status).toBe(204)
        const written = revocationsBefore()
        for (const ua of [SHELL_UA, NATIVE_UA]) {
            const again = await call(logoutRequest({ ua, cookies: { [MOBILE_SESSION_COOKIE]: token } }))
            expect(again.status).toBe(204)
            expect(state.responseCookies).toEqual([])
        }
        expect(state.revocations).toHaveLength(written)
    })

    test('a session logout could never bar (the shared unstable device id) is not ended either', async () => {
        const shared = issueMobileSession(A, 'ephemeral-device', ENV)
        if (shared) {
            const result = await call(logoutRequest({ cookies: { [MOBILE_SESSION_COOKIE]: shared } }))
            expect(result.status).toBe(204)
        }
        expect(state.revocations).toEqual([])
    })

    test('the mobile lane not provisioned: nothing verifies, nothing is written', async () => {
        const token = session()
        delete process.env.MOBILE_ACCESS_USER
        delete process.env.MOBILE_ACCESS_PASS
        const result = await call(logoutRequest({ ua: NATIVE_UA, cookies: { [MOBILE_SESSION_COOKIE]: token } }))
        expect(result.status).toBe(204)
        expect(state.revocations).toEqual([])
        expect(state.responseCookies).toEqual([])
    })
})

describe('the session may still be live: 503', () => {
    test('the barrier cannot be read: 503 retryable, nothing written, no cookie set', async () => {
        const token = session()
        state.barrierUnreadable = true
        const result = await call(logoutRequest({ cookies: { [MOBILE_SESSION_COOKIE]: token } }))
        expect(result.passed).toBe(true)
        expect(result.status).toBe(503)
        expect(JSON.parse(result.body)).toEqual({ error: 'MOBILE_SESSION_LOGOUT_UNAVAILABLE' })
        expect(result.response.headers.get('cache-control')).toBe('no-store')
        expect(result.response.headers.get('retry-after')).toBe('5')
        expect(state.revocations).toEqual([])
        expect(state.responseCookies).toEqual([])
    })

    test('the barrier write fails: 503, and the cookies are still cleared (logout never depends on it)', async () => {
        const token = session()
        state.barrierUnwritable = true
        const result = await call(logoutRequest({ cookies: { [MOBILE_SESSION_COOKIE]: token } }))
        expect(result.status).toBe(503)
        expect(JSON.parse(result.body)).toEqual({ error: 'MOBILE_SESSION_LOGOUT_UNAVAILABLE' })
        expect(state.responseCookies).toEqual([
            { name: MOBILE_SESSION_COOKIE, value: '', maxAge: 0 },
            { name: 'crm_user_id', value: '', maxAge: 0 },
        ])
        // The session was not barred, so the caller was right to be told it may live.
        expect(await resolveCookieOperatorV1(token, undefined)).toEqual({ kind: 'mobile_session', operatorId: A })
    })
})

describe('the request shape', () => {
    test('only application/json: a form, text or missing type gets 415 and changes nothing', async () => {
        const token = session()
        for (const contentType of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain', null]) {
            const result = await call(logoutRequest({ contentType, cookies: { [MOBILE_SESSION_COOKIE]: token } }))
            expect(result.status, String(contentType)).toBe(415)
            expect(JSON.parse(result.body)).toEqual({ error: 'JSON_REQUIRED' })
        }
        expect(state.revocations).toEqual([])
        expect(state.responseCookies).toEqual([])
        expect((await call(logoutRequest({ contentType: 'application/json; charset=utf-8', cookies: { [MOBILE_SESSION_COOKIE]: token } }))).status).toBe(204)
    })

    test('the route answers POST only and never authenticates: no response sets a non-empty session or identity cookie', async () => {
        expect(Object.keys(route).sort()).toEqual(['POST', 'dynamic', 'runtime'])
        const token = session()
        const cases = [
            logoutRequest({ cookies: { [MOBILE_SESSION_COOKIE]: token, crm_user_id: B } }),
            logoutRequest({ cookies: { [MOBILE_SESSION_COOKIE]: token } }),
            logoutRequest({ cookies: { crm_user_id: B } }),
            logoutRequest({ ua: DESKTOP_UA, cookies: { [STAFF_COOKIE]: 'x' } }),
        ]
        for (const req of cases) {
            const result = await call(req)
            expect(result.response.headers.get('set-cookie')).toBeNull()
            expect(state.responseCookies.every(c => c.value === '' && c.maxAge === 0)).toBe(true)
        }
    })
})

describe('the request boundary lets the shell reach this exact path only', () => {
    test('a dead session in the shell lane reaches the route, with no crm_user_id downstream', async () => {
        const token = session()
        state.barred.add(`${DEVICE}|${mobileSessionBarrierEntryV1(verifyMobileSession(token, ENV)!)}`)
        const result = await call(logoutRequest({ cookies: { [MOBILE_SESSION_COOKIE]: token, crm_user_id: B } }))
        expect(result.passed).toBe(true)
        expect((result.header ?? '').split(';').map(p => p.trim()).filter(p => p.startsWith('crm_user_id='))).toEqual([])
        expect(result.status).toBe(204)
    })

    test.each([
        '/api/mobile/session/logout/x',
        '/api/mobile/session/logoutx',
        '/api/mobile/session',
        '/api/mobile/session/logou',
        '/api/mobile/push-registration',
    ])('%s without a live session still gets the boundary\'s 401', async (path) => {
        const result = await call(logoutRequest({ path, cookies: { [MOBILE_SESSION_COOKIE]: 'junk' } }))
        expect(result.passed).toBe(false)
        expect(result.status).toBe(401)
    })

    test('in the shell lane an unreadable barrier on any other API path is still the boundary\'s 503', async () => {
        state.barrierUnreadable = true
        const gate = await proxy(new NextRequest(new URL('https://yokoone.ru/api/chats'), {
            headers: { 'user-agent': SHELL_UA, cookie: `${MOBILE_SESSION_COOKIE}=${session()}` },
        }))
        expect(gate.status).toBe(503)
    })
})
