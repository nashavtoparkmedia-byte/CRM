// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * BR-4: the effective Android operator is the verified signed mobile session operator.
 *
 * The legacy user service is frozen (CRM-ARCH-007 BEHAVIOR-FREEZE) and stays
 * byte-identical: its own `crm_user_id` reads become correct because the request
 * boundary forwards the signed operator, and the Identity Access owner adapter
 * carries the mobile session semantics of the public identity actions.
 *
 * The request boundary (proxy.ts) and the Identity Access code run for real:
 * next/server's NextRequest/NextResponse, the signed session, the resolver,
 * user-service, the identity Server Actions, the mobile login/logout and the
 * chat assign route. Stand-ins are limited to request plumbing and storage:
 *   - next/headers `cookies()` is served from the Cookie header the proxy
 *     forwards downstream (`x-middleware-request-cookie`), the same header Next
 *     rebuilds the downstream request from; the real-Next propagation proof
 *     lives in the BR-4 evidence package;
 *   - the logout barrier store (read and write) is an in-memory set;
 *   - the chat assignment write is a spy;
 *   - next/navigation `redirect` throws a marker carrying its destination.
 */

const state = vi.hoisted(() => ({
    barred: new Set<string>(),
    barrierUnreadable: false,
    requestCookies: new Map<string, string>(),
    responseCookies: [] as Array<{ name: string, value: string, maxAge?: number }>,
    assignments: [] as Array<{ chatId: string, userId: string }>,
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
    revokeMobilePushDeviceForLogoutV1: vi.fn(async (input: { principal: { deviceId: string }, barrierEntry: string | null }) => {
        if (input.barrierEntry) state.barred.add(`${input.principal.deviceId}|${input.barrierEntry}`)
    }),
}))
vi.mock('@/lib/ConversationWorkflowService', () => ({
    ConversationWorkflowService: {
        assignChat: vi.fn(async (chatId: string, userId: string) => { state.assignments.push({ chatId, userId }) }),
    },
}))
vi.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => (state.requestCookies.has(name) ? { name, value: state.requestCookies.get(name)! } : undefined),
        set: (name: string, value: string, options?: { maxAge?: number }) => {
            state.responseCookies.push({ name, value, maxAge: options?.maxAge })
            if (options?.maxAge === 0) state.requestCookies.delete(name)
            else state.requestCookies.set(name, value)
        },
        delete: (name: string) => {
            state.responseCookies.push({ name, value: '', maxAge: 0 })
            state.requestCookies.delete(name)
        },
    }),
    headers: async () => new Headers(),
}))
vi.mock('next/navigation', () => ({
    redirect: (url: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { redirectTo: url }) },
}))

const { NextRequest } = await import('next/server')
const { proxy, MOBILE_SHELL_UA_TOKEN } = await import('@/proxy')
const credentials = await import('@/modules/identity-access/public/v1/mobile-session-credentials')
const { issueMobileSession, MOBILE_SESSION_COOKIE, mobileSessionBarrierEntryV1, verifyMobileSession, withLegacyUiIdentityCookieV1, resolveEffectiveOperatorV1 } = credentials
const userService = await import('@/lib/users/user-service')
const { authenticateUserV1, endUserSessionV1 } = await import('@/modules/identity-access/public/v1/identity-actions')
const { getCurrentUserIdentityV1 } = await import('@/modules/identity-access/public/v1/user-directory')
const { establishMobileSessionV1, hasMobileSessionV1 } = await import('@/modules/identity-access/public/v1/mobile-session-auth')
const { default: MobileLoginPage } = await import('@/app/login/mobile/page')
const { resolveRequestOperatorV1 } = await import('@/modules/identity-access/public/v1/mobile-session-operator')
const assignRoute = await import('@/app/api/chats/[id]/assign/route')
const { AUTHENTICATE_USER_COMMAND_V1, END_USER_SESSION_COMMAND_V1 } = await import('@/contracts/identity-access/v1')

const ENV = { MOBILE_ACCESS_USER: 'mobile-operator', MOBILE_ACCESS_PASS: 'correct horse battery staple' }
const SHELL_UA = `Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 ${MOBILE_SHELL_UA_TOKEN}1`
const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120'
const A = 'u2'   // Администратор: on desktop this role may switch identity, so the mobile denial is the strict case
const B = 'u1'   // Менеджер
const DEVICE = 'a1b2c3d4e5f6a7b8'

function session(operator = A, device = DEVICE) {
    return issueMobileSession(operator, device, ENV) as string
}

function request(pathname: string, init: { ua?: string, cookies?: Record<string, string>, method?: string } = {}) {
    const headers = new Headers({ 'user-agent': init.ua ?? SHELL_UA })
    const pairs = Object.entries(init.cookies ?? {}).map(([name, value]) => `${name}=${value}`)
    if (pairs.length) headers.set('cookie', pairs.join('; '))
    return new NextRequest(new URL(`https://yokoone.ru${pathname}`), { headers, method: init.method ?? 'GET' })
}

/** What the application sees for this request: Next rebuilds it from the proxy's override headers. */
function downstreamCookieHeader(response: Response, original: Request): string | null {
    const overridden = (response.headers.get('x-middleware-override-headers') ?? '').split(',').map(h => h.trim())
    if (!overridden.includes('cookie')) return original.headers.get('cookie')
    return response.headers.get('x-middleware-request-cookie')
}

/** Run the proxy and load the downstream request's cookies into next/headers for the handler under test. */
async function through(req: InstanceType<typeof NextRequest>) {
    const response = await proxy(req)
    const header = downstreamCookieHeader(response, req)
    state.requestCookies = new Map((header ?? '').split(';').map(p => p.trim()).filter(Boolean).map(p => {
        const i = p.indexOf('=')
        return [p.slice(0, i), p.slice(i + 1)] as [string, string]
    }))
    state.responseCookies = []
    return { response, header, passed: response.headers.get('x-middleware-next') === '1' }
}

function legacyCookies(header: string | null) {
    return (header ?? '').split(';').map(p => p.trim()).filter(p => p.startsWith('crm_user_id='))
}

async function assign(userId: string) {
    const req = new NextRequest(new URL('https://yokoone.ru/api/chats/chat-1/assign'), {
        method: 'POST', body: JSON.stringify({ userId }), headers: { 'content-type': 'application/json' },
    })
    return assignRoute.POST(req, { params: Promise.resolve({ id: 'chat-1' }) })
}

beforeEach(() => {
    process.env.MOBILE_ACCESS_USER = ENV.MOBILE_ACCESS_USER
    process.env.MOBILE_ACCESS_PASS = ENV.MOBILE_ACCESS_PASS
    delete process.env.MOBILE_SESSION_REVOCATION_EPOCH
    state.barred.clear()
    state.barrierUnreadable = false
    state.requestCookies = new Map()
    state.responseCookies = []
    state.assignments = []
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('pure primitives', () => {
    test('the Cookie header carries exactly one crm_user_id after the rewrite, other pairs unchanged', () => {
        expect(withLegacyUiIdentityCookieV1('a=1; crm_user_id=u1; b=2; crm_user_id=u3', 'u2')).toBe('a=1; b=2; crm_user_id=u2')
        expect(withLegacyUiIdentityCookieV1('a=1; crm_user_id=u1', null)).toBe('a=1')
        expect(withLegacyUiIdentityCookieV1(null, 'u2')).toBe('crm_user_id=u2')
        expect(() => withLegacyUiIdentityCookieV1('a=1', 'u2; admin=1')).toThrow(TypeError)
    })

    test('resolution: valid session wins, a present-but-invalid session grants nothing, no session is legacy', () => {
        expect(resolveEffectiveOperatorV1({ sessionCookie: session(), legacyCookie: B })).toMatchObject({ kind: 'mobile_session', operatorId: A })
        expect(resolveEffectiveOperatorV1({ sessionCookie: 'junk', legacyCookie: B })).toEqual({ kind: 'mobile_session_refused' })
        expect(resolveEffectiveOperatorV1({ sessionCookie: '', legacyCookie: B })).toEqual({ kind: 'mobile_session_refused' })
        expect(resolveEffectiveOperatorV1({ sessionCookie: undefined, legacyCookie: B })).toEqual({ kind: 'legacy', operatorId: B })
    })
})

describe('1, 4, 6, 8: signed session A with crm_user_id=B acts as A downstream', () => {
    test('1: the downstream request carries crm_user_id=A only; getCurrentUser and a direct cookie reader see A', async () => {
        const { header, passed } = await through(request('/messages', { cookies: { [MOBILE_SESSION_COOKIE]: session(), crm_user_id: B } }))
        expect(passed).toBe(true)
        expect(legacyCookies(header)).toEqual([`crm_user_id=${A}`])
        expect((await userService.getCurrentUser())?.id).toBe(A)
        expect((await getCurrentUserIdentityV1())?.id).toBe(A)
        expect(state.requestCookies.get('crm_user_id')).toBe(A)
    })

    test('4: a Server Action (POST, Next-Action) with a mismatched cookie runs as A, and the proxy adds no Set-Cookie to it', async () => {
        const req = request('/messages', { method: 'POST', cookies: { [MOBILE_SESSION_COOKIE]: session(), crm_user_id: B } })
        req.headers.set('next-action', 'abc123')
        const { response, header } = await through(req)
        expect(legacyCookies(header)).toEqual([`crm_user_id=${A}`])
        expect(response.headers.get('set-cookie')).toBeNull()
        expect((await getCurrentUserIdentityV1())?.id).toBe(A)
    })

    test('6: crm_user_id edited client-side before the next request is corrected on that request and re-synced on reads', async () => {
        const { response, header } = await through(request('/messages', { cookies: { [MOBILE_SESSION_COOKIE]: session(), crm_user_id: B } }))
        expect(legacyCookies(header)).toEqual([`crm_user_id=${A}`])
        expect(response.headers.get('set-cookie')).toContain(`crm_user_id=${A}`)
        const same = await through(request('/messages', { cookies: { [MOBILE_SESSION_COOKIE]: session(), crm_user_id: A } }))
        expect(same.response.headers.get('set-cookie')).toBeNull()
    })

    test('8: cookies restored after process death (valid session, any crm_user_id or none) still resolve to A', async () => {
        for (const restored of [B, A, undefined]) {
            const cookies: Record<string, string> = { [MOBILE_SESSION_COOKIE]: session() }
            if (restored) cookies.crm_user_id = restored
            const { header } = await through(request('/api/messages', { cookies }))
            expect(legacyCookies(header)).toEqual([`crm_user_id=${A}`])
        }
    })

    test('defense in depth: Identity Access resolves A from the signed session even if crm_user_id=B reached it unrewritten', async () => {
        state.requestCookies = new Map([[MOBILE_SESSION_COOKIE, session()], ['crm_user_id', B]])
        expect((await getCurrentUserIdentityV1())?.id).toBe(A)
        expect(await resolveRequestOperatorV1()).toEqual({ kind: 'mobile_session', operatorId: A })
    })

    test('a valid session cannot be made to use the legacy path by dropping the shell User-Agent marker', async () => {
        const { header, passed } = await through(request('/messages', { ua: DESKTOP_UA, cookies: { [MOBILE_SESSION_COOKIE]: session(), crm_user_id: B } }))
        expect(passed).toBe(true)
        expect(legacyCookies(header)).toEqual([`crm_user_id=${A}`])
        expect((await userService.getCurrentUser())?.id).toBe(A)
    })
})

describe('2, 3: no operator switch under a mobile session', () => {
    test('3: authenticateUserV1(B) invoked directly under session A is denied and writes nothing', async () => {
        await through(request('/messages', { method: 'POST', cookies: { [MOBILE_SESSION_COOKIE]: session(), crm_user_id: A } }))
        await expect(authenticateUserV1({ contract: AUTHENTICATE_USER_COMMAND_V1, targetUserId: B })).rejects.toThrow('forbidden')
        expect(state.responseCookies).toEqual([])
    })

    test('3b: the frozen user-service login, if invoked directly as a Server Action, cannot change the effective operator', async () => {
        await through(request('/messages', { method: 'POST', cookies: { [MOBILE_SESSION_COOKIE]: session(), crm_user_id: A } }))
        await userService.login(B)   // legacy semantics: writes crm_user_id=B for an Администратор
        const written = state.requestCookies.get('crm_user_id')
        expect(written).toBe(B)
        // the very next request — any request — is A again, downstream and in Identity Access
        const next = await through(request('/messages', { method: 'POST', cookies: { [MOBILE_SESSION_COOKIE]: session(), crm_user_id: written! } }))
        expect(legacyCookies(next.header)).toEqual([`crm_user_id=${A}`])
        expect((await userService.getCurrentUser())?.id).toBe(A)
        expect((await getCurrentUserIdentityV1())?.id).toBe(A)
    })

    test('2: the TopBar path (authenticateUserV1 → reload) cannot change the operator: after the reload the request is still A', async () => {
        await through(request('/messages', { method: 'POST', cookies: { [MOBILE_SESSION_COOKIE]: session(), crm_user_id: A } }))
        await authenticateUserV1({ contract: AUTHENTICATE_USER_COMMAND_V1, targetUserId: B }).catch(() => undefined)
        // even a client that writes crm_user_id=B itself before reloading
        const reload = await through(request('/messages', { cookies: { [MOBILE_SESSION_COOKIE]: session(), crm_user_id: B } }))
        expect(legacyCookies(reload.header)).toEqual([`crm_user_id=${A}`])
        expect((await getCurrentUserIdentityV1())?.id).toBe(A)
    })

    test('re-picking the signed operator itself is a no-op, not an error', async () => {
        await through(request('/messages', { method: 'POST', cookies: { [MOBILE_SESSION_COOKIE]: session(), crm_user_id: A } }))
        await expect(authenticateUserV1({ contract: AUTHENTICATE_USER_COMMAND_V1, targetUserId: A })).resolves.toBeDefined()
        expect(state.responseCookies).toEqual([])
    })

    test('a second mobile login on top of a live session is refused: changing operator needs a logout first', async () => {
        await through(request('/login/mobile', { method: 'POST', cookies: { [MOBILE_SESSION_COOKIE]: session() } }))
        const result = await establishMobileSessionV1(ENV.MOBILE_ACCESS_USER, ENV.MOBILE_ACCESS_PASS, B, 'b2c3d4e5f6a7b8c9')
        expect(result).toEqual({ ok: false, reason: 'session_active' })
        expect(state.responseCookies).toEqual([])
    })
})

describe('5, 11: client-supplied actor cannot impersonate', () => {
    test('5: forged userId=B to the assign route under session A → 403, nothing assigned; userId=A → assigned to A', async () => {
        await through(request('/api/chats/chat-1/assign', { method: 'POST', cookies: { [MOBILE_SESSION_COOKIE]: session(), crm_user_id: B } }))
        const forged = await assign(B)
        expect(forged.status).toBe(403)
        expect(state.assignments).toEqual([])
        const own = await assign(A)
        expect(own.status).toBe(200)
        expect(state.assignments).toEqual([{ chatId: 'chat-1', userId: A }])
    })

    test('11: auto-assign on first reply with the client-side cookie tampered to B cannot attribute the chat to B', async () => {
        // ChatWorkspace reads crm_user_id from document.cookie and posts it as userId
        await through(request('/api/chats/chat-1/assign', { method: 'POST', cookies: { [MOBILE_SESSION_COOKIE]: session(), crm_user_id: B } }))
        expect((await assign(B)).status).toBe(403)
        expect(state.assignments).toEqual([])
        // every server-side actor read (proposed replies, tasks, my-day …) gets A from the forwarded cookie
        expect(state.requestCookies.get('crm_user_id')).toBe(A)
    })
})

describe('7, 8, 9: logout and dead sessions fail closed', () => {
    test('7: endUserSessionV1 under session A ends the mobile session: cookies cleared, barrier written, the token is refused afterwards', async () => {
        const token = session()
        await through(request('/messages', { method: 'POST', cookies: { [MOBILE_SESSION_COOKIE]: token, crm_user_id: A } }))
        await endUserSessionV1({ contract: END_USER_SESSION_COMMAND_V1 })
        expect(state.responseCookies).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: MOBILE_SESSION_COOKIE, value: '', maxAge: 0 }),
            expect.objectContaining({ name: 'crm_user_id', value: '', maxAge: 0 }),
        ]))
        const principal = verifyMobileSession(token)!
        expect(state.barred.has(`${principal.deviceId}|${mobileSessionBarrierEntryV1(principal)}`)).toBe(true)

        // 8: the same token from a restored cookie jar, or an in-flight request, after logout
        expect((await proxy(request('/api/messages', { cookies: { [MOBILE_SESSION_COOKIE]: token, crm_user_id: A } }))).status).toBe(401)
        expect((await proxy(request('/messages', { cookies: { [MOBILE_SESSION_COOKIE]: token, crm_user_id: A } }))).status).toBe(303)
        const desktop = await through(request('/messages', { ua: DESKTOP_UA, cookies: { [MOBILE_SESSION_COOKIE]: token, crm_user_id: A } }))
        expect(legacyCookies(desktop.header)).toEqual([])
        expect(await userService.getCurrentUser()).toBeNull()
        expect(await assign(A)).toHaveProperty('status', 401)
    })

    test('9: invalid, expired and epoch-revoked sessions fail closed in both lanes and in Identity Access', async () => {
        const live = session()
        const cases: Array<[string, string, () => void]> = [
            ['tampered', `${live.slice(0, -3)}AAA`, () => {}],
            ['empty', '', () => {}],
            ['epoch bumped', live, () => { process.env.MOBILE_SESSION_REVOCATION_EPOCH = '7' }],
        ]
        for (const [, cookie, arrange] of cases) {
            arrange()
            expect((await proxy(request('/api/messages', { cookies: { [MOBILE_SESSION_COOKIE]: cookie, crm_user_id: B } }))).status).toBe(401)
            const desktop = await through(request('/messages', { ua: DESKTOP_UA, cookies: { [MOBILE_SESSION_COOKIE]: cookie, crm_user_id: B } }))
            expect(legacyCookies(desktop.header)).toEqual([])
            expect(await userService.getCurrentUser()).toBeNull()
            expect(await getCurrentUserIdentityV1()).toBeNull()
            await expect(authenticateUserV1({ contract: AUTHENTICATE_USER_COMMAND_V1, targetUserId: B })).rejects.toThrow('forbidden')
            // Identity Access refuses even if the boundary were bypassed and crm_user_id=B reached it
            state.requestCookies.set('crm_user_id', B)
            expect(await getCurrentUserIdentityV1()).toBeNull()
            delete process.env.MOBILE_SESSION_REVOCATION_EPOCH
        }
        vi.useFakeTimers()
        vi.setSystemTime(Date.now() + 13 * 60 * 60 * 1000)
        expect((await proxy(request('/api/messages', { cookies: { [MOBILE_SESSION_COOKIE]: live, crm_user_id: B } }))).status).toBe(401)
        vi.useRealTimers()
    })

    test('an unreadable logout barrier refuses the session (fail closed)', async () => {
        state.barrierUnreadable = true
        expect((await proxy(request('/api/messages', { cookies: { [MOBILE_SESSION_COOKIE]: session(), crm_user_id: A } }))).status).toBe(401)
        expect((await resolveRequestOperatorV1())).toEqual({ kind: 'legacy', operatorId: null })
        state.requestCookies.set(MOBILE_SESSION_COOKIE, session())
        expect(await resolveRequestOperatorV1()).toEqual({ kind: 'mobile_session_refused' })
    })

    test('a session on the shared unstable device id can never be barred, so it is refused and cannot be issued', async () => {
        const unstable = issueMobileSession(A, 'ephemeral-device', ENV) as string
        expect((await proxy(request('/api/messages', { cookies: { [MOBILE_SESSION_COOKIE]: unstable } }))).status).toBe(401)
        state.requestCookies = new Map()
        expect(await establishMobileSessionV1(ENV.MOBILE_ACCESS_USER, ENV.MOBILE_ACCESS_PASS, A, 'ephemeral-device'))
            .toEqual({ ok: false, reason: 'invalid_device' })
    })

    test('the login screen agrees with the boundary: a refused session gets the form, not a redirect back (no loop)', async () => {
        const loggedOut = session()
        const principal = verifyMobileSession(loggedOut)!
        state.barred.add(`${principal.deviceId}|${mobileSessionBarrierEntryV1(principal)}`)
        const refusals: Array<[string, () => void]> = [
            [loggedOut, () => {}],
            [session(), () => { state.barrierUnreadable = true }],
            [issueMobileSession(A, 'ephemeral-device', ENV) as string, () => { state.barrierUnreadable = false }],
        ]
        for (const [cookie, arrange] of refusals) {
            arrange()
            const cookies = { [MOBILE_SESSION_COOKIE]: cookie, crm_user_id: A }
            const refused = await proxy(request('/messages', { cookies }))
            expect(refused.status).toBe(303)
            // Follow the 303 once, as the WebView does, with the same cookie jar.
            const login = new URL(refused.headers.get('location')!)
            expect((await through(request(`${login.pathname}${login.search}`, { cookies }))).passed).toBe(true)
            expect(await hasMobileSessionV1()).toBe(false)
            await expect(MobileLoginPage({ searchParams: Promise.resolve(Object.fromEntries(login.searchParams)) })).resolves.toBeTruthy()
        }

        // The form then works over the dead cookie: a logged-out token is not a live session.
        await through(request('/login/mobile', { method: 'POST', cookies: { [MOBILE_SESSION_COOKIE]: loggedOut } }))
        expect(await establishMobileSessionV1(ENV.MOBILE_ACCESS_USER, ENV.MOBILE_ACCESS_PASS, A, DEVICE)).toMatchObject({ ok: true })

        // A live session is still sent on to its destination.
        await through(request('/login/mobile?next=%2Fmessages', { cookies: { [MOBILE_SESSION_COOKIE]: session() } }))
        await expect(MobileLoginPage({ searchParams: Promise.resolve({ next: '/messages' }) })).rejects.toMatchObject({ redirectTo: '/messages' })
    })
})

describe('10: concurrent protected effect and operator-switch attempt', () => {
    test('the switch is denied and every concurrent effect is attributed to A', async () => {
        await through(request('/api/chats/chat-1/assign', { method: 'POST', cookies: { [MOBILE_SESSION_COOKIE]: session(), crm_user_id: A } }))
        const [switched, current, assigned, forged] = await Promise.allSettled([
            authenticateUserV1({ contract: AUTHENTICATE_USER_COMMAND_V1, targetUserId: B }), getCurrentUserIdentityV1(), assign(A), assign(B),
        ])
        expect(switched.status).toBe('rejected')
        expect(current.status === 'fulfilled' && current.value?.id).toBe(A)
        expect(assigned.status === 'fulfilled' && assigned.value.status).toBe(200)
        expect(forged.status === 'fulfilled' && forged.value.status).toBe(403)
        expect(state.assignments).toEqual([{ chatId: 'chat-1', userId: A }])
        expect(state.requestCookies.get('crm_user_id')).toBe(A)
    })
})

describe('12: the browser lane without a mobile session is unchanged', () => {
    test('the proxy passes a desktop request through untouched: no override headers, no Set-Cookie', async () => {
        const req = request('/messages', { ua: DESKTOP_UA, cookies: { crm_user_id: B } })
        const response = await proxy(req)
        expect(response.headers.get('x-middleware-next')).toBe('1')
        expect(response.headers.get('x-middleware-override-headers')).toBeNull()
        expect(response.headers.get('set-cookie')).toBeNull()
    })

    test('getCurrentUser, login, logout and assign keep their crm_user_id semantics', async () => {
        await through(request('/messages', { ua: DESKTOP_UA, method: 'POST', cookies: { crm_user_id: A } }))
        expect((await userService.getCurrentUser())?.id).toBe(A)
        expect((await getCurrentUserIdentityV1())?.id).toBe(A)
        await authenticateUserV1({ contract: AUTHENTICATE_USER_COMMAND_V1, targetUserId: B })   // Администратор may pick any identity on desktop
        expect(state.requestCookies.get('crm_user_id')).toBe(B)
        await expect(authenticateUserV1({ contract: AUTHENTICATE_USER_COMMAND_V1, targetUserId: A })).rejects.toThrow('forbidden')   // Менеджер may not escalate
        expect((await assign(A)).status).toBe(200)      // the desktop route still assigns the body's userId
        await endUserSessionV1({ contract: END_USER_SESSION_COMMAND_V1 })
        expect(state.requestCookies.has('crm_user_id')).toBe(false)
        expect(state.responseCookies).toEqual(expect.arrayContaining([{ name: 'crm_user_id', value: '', maxAge: 0 }]))
    })
})
