// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Enforcement without a verified session: deny by default
 * (docs/design/staff-session-enforce-deny-v1.md).
 *
 * The request boundary (proxy.ts) runs for real, with next/server, the signed
 * staff and mobile sessions, the BR-4 resolver, a real registry file and a
 * real server-reference manifest on disk. Stand-ins are limited to storage:
 * the StaffCredential store and the mobile logout barrier are in memory, and
 * `@/lib/prisma` is an empty object, so any other database use fails the test.
 */

const fake = vi.hoisted(() => ({
    rows: new Map<string, { userId: string, registryCreatedAt: string, sessionEpoch: number, revokedAt: Date | null }>(),
    storeUnreadable: false,
}))

vi.mock('@/modules/identity-access/internal/staff-credential-store', () => {
    const check = () => {
        if (fake.storeUnreadable) throw Object.assign(new Error('store down'), { name: 'PrismaClientInitializationError' })
    }
    const refuse = async () => { throw new Error('not used by the request boundary') }
    return {
        prismaStaffCredentialStoreV1: {
            async findStatus(userId: string) { check(); const row = fake.rows.get(userId); return row === undefined ? null : { ...row } },
            async anyRow() { check(); return fake.rows.size > 0 },
            findVerifier: refuse,
            states: refuse,
            record: refuse,
            locked: refuse,
        },
    }
})
vi.mock('@/modules/identity-access/internal/mobile-session-barrier', () => ({
    prismaMobileSessionBarrierV1: { isBarred: async () => false },
}))
vi.mock('@/lib/prisma', () => ({ prisma: {} }))

const { NextRequest } = await import('next/server')
const proxyModule = await import('@/proxy')
const { proxy, config, ENFORCED_SESSIONLESS_ALLOWLIST, SESSIONLESS_SERVER_ACTIONS, MOBILE_SHELL_UA_TOKEN } = proxyModule
const { issueStaffSessionTokenV1 } = await import('@/modules/identity-access/internal/staff-session-credentials')
const { staffSessionCookieNameForRequestV1 } = await import('@/modules/identity-access/public/v1/staff-session')
const { issueMobileSession, MOBILE_SESSION_COOKIE } = await import('@/modules/identity-access/public/v1/mobile-session-credentials')
const { issueIntegrationAdminSession } = await import('@/modules/identity-access/public/v1/integration-admin-credentials')
const userService = await import('@/lib/users/user-service')

const SECRET = 'staff-session-signing-key-for-tests-0123456789abcdef'
const MANAGER = { id: 'u1', firstName: 'Мария', lastName: 'Иванова', role: 'Менеджер', status: 'Активен', createdAt: '2026-03-24T00:00:00Z' }
const ADMIN = { id: 'u2', firstName: 'Александр', lastName: 'Сидоров', role: 'Администратор', status: 'Активен', createdAt: '2026-03-24T00:00:00Z' }
const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120'
const SHELL_UA = `Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 ${MOBILE_SHELL_UA_TOKEN}1`
const NATIVE_UA = 'Dalvik/2.1.0 (Linux; U; Android 14)'

// Server-action ids as a build would assign them, and the manifest that maps them.
const ID = {
    getLoginMode: `00${'a1'.repeat(20)}`,
    getUsers: `00${'a2'.repeat(20)}`,
    getSignInEmployees: `00${'a6'.repeat(20)}`,
    // Same export names, another file, on the sign-in page's worker.
    shadowSignInEmployees: `00${'e1'.repeat(20)}`,
    shadowStaffLogin: `60${'e2'.repeat(20)}`,
    staffLogin: `60${'a3'.repeat(20)}`,
    login: `40${'a4'.repeat(20)}`,
    queryCurrentUserV1: `40${'a5'.repeat(20)}`,
    submitMobileLoginAction: `60${'b1'.repeat(20)}`,
    addUser: `40${'b2'.repeat(20)}`,
    sendMessage: `70${'c1'.repeat(20)}`,
}
const LOGIN_WORKER = 'app/login/page'
const MOBILE_WORKER = 'app/login/mobile/page'
const MESSAGES_WORKER = 'app/messages/page'
const USER_SERVICE = 'src/lib/users/user-service.ts'
const IDENTITY_ACTIONS = 'src/modules/identity-access/public/v1/identity-actions.ts'

function workerEntry(filename: string, exportedName: string) {
    return { moduleId: 1, async: false, exportedName, filename }
}

function manifestNode(): Record<string, { workers: Record<string, unknown>, layer: Record<string, string> }> {
    const action = (filename: string, exportedName: string, workers: string[]) => ({
        workers: Object.fromEntries(workers.map((worker) => [worker, workerEntry(filename, exportedName)])),
        layer: Object.fromEntries(workers.map((worker) => [worker, 'action-browser'])),
    })
    return {
        [ID.getLoginMode]: action(USER_SERVICE, 'getLoginMode', [LOGIN_WORKER, MOBILE_WORKER, MESSAGES_WORKER]),
        [ID.getUsers]: action(USER_SERVICE, 'getUsers', [LOGIN_WORKER, MOBILE_WORKER, MESSAGES_WORKER]),
        [ID.getSignInEmployees]: action(USER_SERVICE, 'getSignInEmployees', [LOGIN_WORKER]),
        [ID.shadowSignInEmployees]: action('src/app/login/shadow-actions.ts', 'getSignInEmployees', [LOGIN_WORKER]),
        [ID.shadowStaffLogin]: action('src/app/login/shadow-actions.ts', 'staffLogin', [LOGIN_WORKER]),
        [ID.staffLogin]: action(USER_SERVICE, 'staffLogin', [LOGIN_WORKER, MOBILE_WORKER]),
        [ID.login]: action(USER_SERVICE, 'login', [LOGIN_WORKER, MOBILE_WORKER]),
        [ID.queryCurrentUserV1]: action(IDENTITY_ACTIONS, 'queryCurrentUserV1', [LOGIN_WORKER, MOBILE_WORKER, MESSAGES_WORKER]),
        [ID.submitMobileLoginAction]: action('src/app/login/mobile/actions.ts', 'submitMobileLoginAction', [MOBILE_WORKER]),
        [ID.addUser]: action(USER_SERVICE, 'addUser', [MOBILE_WORKER, MESSAGES_WORKER]),
        [ID.sendMessage]: action('src/app/messages/actions.ts', 'sendMessage', [MESSAGES_WORKER]),
    }
}

let directory: string
let buildRoot: string

function writeManifest(distDir: string, content: string): void {
    const file = path.join(buildRoot, distDir, 'server', 'server-reference-manifest.json')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
    // A distinct mtime, so the proxy's cache sees every rewrite.
    const stamp = new Date(Date.now() + Math.floor(Math.random() * 1_000_000))
    utimesSync(file, stamp, stamp)
}

function request(pathname: string, init: {
    method?: string
    ua?: string
    cookies?: Record<string, string>
    headers?: Record<string, string>
    body?: string
} = {}) {
    const headers = new Headers({ 'user-agent': init.ua ?? DESKTOP_UA })
    for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value)
    const pairs = Object.entries(init.cookies ?? {}).map(([name, value]) => `${name}=${value}`)
    if (pairs.length) headers.set('cookie', pairs.join('; '))
    const method = init.method ?? 'GET'
    return new NextRequest(new URL(`https://yokoone.ru${pathname}`), {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : (init.body ?? '[]'),
    })
}

function action(pathname: string, actionId: string, init: { ua?: string, cookies?: Record<string, string> } = {}) {
    return request(pathname, {
        ...init,
        method: 'POST',
        headers: { 'next-action': actionId, 'content-type': 'text/plain;charset=UTF-8', accept: 'text/x-component' },
    })
}

const passed = (response: Response) => response.headers.get('x-middleware-next') === '1'

/** What the request carries downstream as its Cookie header after the proxy. */
function downstreamCookie(response: Response, original: Request): string | null {
    const override = response.headers.get('x-middleware-override-headers')
    // No rewrite: the request goes on with its own Cookie header.
    if (override === null) return original.headers.get('cookie')
    // A rewrite that does not list `cookie` removed the header altogether.
    if (!override.split(',').map((h) => h.trim()).includes('cookie')) return null
    return response.headers.get('x-middleware-request-cookie')
}

async function expectRefusedJson(response: Response, error = 'staff_session_required') {
    expect(passed(response)).toBe(false)
    expect(response.status).toBe(401)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.json()).toEqual({ error })
}

function expectLoginRedirect(response: Response, next: string) {
    expect(passed(response)).toBe(false)
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.origin).toBe('https://yokoone.ru')
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('next')).toBe(next)
    expect(response.headers.get('cache-control')).toContain('no-store')
}

function expectForwardedWithoutIdentity(response: Response, original: Request) {
    expect(passed(response), `${original.method} ${new URL(original.url).pathname} → ${response.status}`).toBe(true)
    expect(downstreamCookie(response, original) ?? '').not.toContain('crm_user_id')
}

const staffCookie = () => staffSessionCookieNameForRequestV1()

/** An allowlist template with each `[name]` segment filled by a realistic id. */
function concrete(template: string): string {
    return template.replace(/\[[A-Za-z]+\]/g, 'cmh3k2x9a0001qz8f')
}

function staffToken(userId = MANAGER.id, userEpoch = 0, nowMs = Date.now()): string {
    const token = issueStaffSessionTokenV1({ userId, userEpoch }, undefined, nowMs)
    if (token === null) throw new Error('staff lane not configured')
    return token
}

function enforce(on = true): void {
    vi.stubEnv('YOKO_STAFF_SESSION_ENFORCE', on ? 'on' : '')
}

beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'enforce-deny-'))
    buildRoot = path.join(directory, 'app')
    mkdirSync(buildRoot)
    vi.spyOn(process, 'cwd').mockReturnValue(buildRoot)
    const registryFile = path.join(directory, 'users.json')
    writeFileSync(registryFile, JSON.stringify([MANAGER, ADMIN], null, 2))
    vi.stubEnv('STAFF_SESSION_SECRET', SECRET)
    vi.stubEnv('YOKO_USER_REGISTRY_FILE', registryFile)
    vi.stubEnv('YOKO_STAFF_SESSION_ENFORCE', '')
    fake.rows.clear()
    fake.storeUnreadable = false
    fake.rows.set(MANAGER.id, { userId: MANAGER.id, registryCreatedAt: MANAGER.createdAt, sessionEpoch: 0, revokedAt: null })
    // `next dev` writes its manifest under .next/dev; vitest is not production.
    writeManifest(path.join('.next', 'dev'), JSON.stringify({ node: manifestNode(), edge: {} }))
})

afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
})

describe('enforcement off: the browser lane is exactly as before', () => {
    test('a session-less page, API call, write and server action all pass untouched', async () => {
        for (const req of [
            request('/messages'),
            request('/api/contacts/search?q=1', { cookies: { crm_user_id: 'u2' } }),
            request('/api/chats/1/assign', { method: 'POST', cookies: { crm_user_id: 'u2' } }),
            action('/messages', ID.sendMessage, { cookies: { crm_user_id: 'u2' } }),
        ]) {
            const response = await proxy(req)
            expect(passed(response)).toBe(true)
            expect(response.headers.get('x-middleware-override-headers')).toBeNull()
            expect(downstreamCookie(response, req)).toBe(req.headers.get('cookie'))
        }
    })

    test('the shell lane still lets a session-less action reach its public sign-in page', async () => {
        const req = action('/login/mobile', ID.addUser, { ua: SHELL_UA })
        expectForwardedWithoutIdentity(await proxy(req), req)
    })
})

describe('enforcement on: a browser request without a verified session is refused', () => {
    beforeEach(() => enforce())

    test('a page read gets 303 to /login with a same-origin `next`: the path only, never the query', async () => {
        expectLoginRedirect(await proxy(request('/messages?id=7')), '/messages')
        expectLoginRedirect(await proxy(request('/contacts?q=%D0%98%D0%B2%D0%B0%D0%BD%D0%BE%D0%B2%201234567890')), '/contacts')
        expectLoginRedirect(await proxy(request('/contacts/abc', { method: 'HEAD' })), '/contacts/abc')
        expectLoginRedirect(await proxy(request('/')), '/')
    })

    test('`next` never names another origin', async () => {
        expectLoginRedirect(await proxy(request('//evil.example/x')), '/')
        expectLoginRedirect(await proxy(request('/\\evil.example/x')), '/')
    })

    test('the API gets 401 JSON, never a redirect', async () => {
        await expectRefusedJson(await proxy(request('/api/contacts/search?q=1')))
        await expectRefusedJson(await proxy(request('/api')))
        await expectRefusedJson(await proxy(request('/api/calls/stream')))
    })

    test('a direct route call does not reach the route, whatever crm_user_id says', async () => {
        await expectRefusedJson(await proxy(request('/api/chats/1/assign', { method: 'POST', cookies: { crm_user_id: 'u2' } })))
        await expectRefusedJson(await proxy(request('/api/whatsapp/delete', { method: 'DELETE', cookies: { crm_user_id: 'u2' } })))
    })

    test('a server action is refused with 401, never redirected', async () => {
        await expectRefusedJson(await proxy(action('/messages', ID.sendMessage, { cookies: { crm_user_id: 'u2' } })))
        // Posted to the sign-in page, an action that page merely carries is still refused.
        await expectRefusedJson(await proxy(action('/login', ID.queryCurrentUserV1)))
        await expectRefusedJson(await proxy(action('/login', ID.login)))
        await expectRefusedJson(await proxy(action('/login', ID.addUser)))
        // A pinned sign-in action posted to another page is refused there.
        await expectRefusedJson(await proxy(action('/messages', ID.staffLogin)))
        // The full registry read is no sign-in action: it carries contact data.
        await expectRefusedJson(await proxy(action('/login', ID.getUsers)))
        // A pin is file#export: the same export name from another file is refused.
        await expectRefusedJson(await proxy(action('/login', ID.shadowSignInEmployees)))
        await expectRefusedJson(await proxy(action('/login', ID.shadowStaffLogin)))
        // An action header is never a pass to a listed route: any Next-Action needs its pin.
        for (const id of [ID.staffLogin, ID.getSignInEmployees, ID.sendMessage]) {
            await expectRefusedJson(await proxy(action('/api/webhooks/bot', id)))
            await expectRefusedJson(await proxy(action('/api/mobile/session/logout', id, { ua: NATIVE_UA })))
        }
        // The mobile sign-in is pinned for its own page and the shell lane only.
        await expectRefusedJson(await proxy(action('/login', ID.submitMobileLoginAction)))
        await expectRefusedJson(await proxy(action('/login/mobile', ID.submitMobileLoginAction)))
    })

    test('a write without an action header, such as a no-JS form post, is 401', async () => {
        await expectRefusedJson(await proxy(request('/messages', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' } })))
        await expectRefusedJson(await proxy(request('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } })))
    })

    test('unknown, malformed and prototype-named action ids are refused', async () => {
        for (const id of [`60${'ff'.repeat(20)}`, 'not-an-id', '', '__proto__', 'constructor', 'toString', ID.staffLogin.toUpperCase()]) {
            await expectRefusedJson(await proxy(action('/login', id)))
        }
    })

    test('the pinned sign-in actions of /login pass, with no identity downstream', async () => {
        for (const id of [ID.getLoginMode, ID.getSignInEmployees, ID.staffLogin]) {
            const req = action('/login', id, { cookies: { crm_user_id: 'u2', theme: 'dark' } })
            const response = await proxy(req)
            expectForwardedWithoutIdentity(response, req)
            expect(downstreamCookie(response, req)).toBe('theme=dark')
        }
    })

    test('without a readable manifest no session-less action runs', async () => {
        rmSync(path.join(buildRoot, '.next'), { recursive: true, force: true })
        await expectRefusedJson(await proxy(action('/login', ID.staffLogin)))
        writeManifest(path.join('.next', 'dev'), '{not json')
        await expectRefusedJson(await proxy(action('/login', ID.staffLogin)))
        writeManifest(path.join('.next', 'dev'), JSON.stringify({ edge: {} }))
        await expectRefusedJson(await proxy(action('/login', ID.staffLogin)))
    })

    test('the manifest is re-read when the build changes it', async () => {
        const rebuilt = `60${'d4'.repeat(20)}`
        await expectRefusedJson(await proxy(action('/login', rebuilt)))
        const node = manifestNode()
        node[rebuilt] = node[ID.staffLogin]
        delete node[ID.staffLogin]
        writeManifest(path.join('.next', 'dev'), JSON.stringify({ node, edge: {} }))
        expect(passed(await proxy(action('/login', rebuilt)))).toBe(true)
        await expectRefusedJson(await proxy(action('/login', ID.staffLogin)))
    })

    test('`next start` reads the production manifest, not the dev one', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        await expectRefusedJson(await proxy(action('/login', ID.staffLogin)))
        writeManifest('.next', JSON.stringify({ node: manifestNode(), edge: {} }))
        expect(passed(await proxy(action('/login', ID.staffLogin)))).toBe(true)
    })

    test('every allowlist entry passes with each of its methods and no identity; any other method is refused', async () => {
        for (const entry of ENFORCED_SESSIONLESS_ALLOWLIST) {
            const pathname = concrete(entry.path)
            for (const method of entry.methods) {
                const req = request(pathname, { method, ua: NATIVE_UA, cookies: { crm_user_id: 'u2' } })
                expectForwardedWithoutIdentity(await proxy(req), req)
            }
            for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].filter((m) => !entry.methods.includes(m))) {
                const response = await proxy(request(pathname, { method }))
                expect(passed(response), `${method} ${pathname}`).toBe(false)
            }
        }
    })

    test('a `[name]` segment is exactly one plain segment, never a prefix', async () => {
        const ok = request('/api/ai-calls/sessions/cmh3k2x9a0001qz8f-Ab_9/state', { method: 'POST' })
        expectForwardedWithoutIdentity(await proxy(ok), ok)
        for (const pathname of [
            '/api/ai-calls/sessions/[id]/state',
            '/api/ai-calls/sessions//state',
            '/api/ai-calls/sessions/a/b/state',
            '/api/ai-calls/sessions/a%2Fb/state',
            '/api/ai-calls/sessions/a.b/state',
            `/api/ai-calls/sessions/${'a'.repeat(129)}/state`,
            '/api/ai-calls/sessions/state',
            '/api/ai-calls/sessions/x/state/extra',
            '/api/ai-calls/sessions/x/other',
            '/api/ai-calls/sessions/by-fs-uuid/x/y',
        ]) {
            const response = await proxy(request(pathname, { method: pathname.includes('by-fs-uuid') ? 'GET' : 'POST' }))
            expect(passed(response), pathname).toBe(false)
            expect(response.status, pathname).toBe(401)
        }
    })

    test('only the exact path is listed: neighbours, case variants and sub-paths are refused', async () => {
        for (const pathname of ['/login/', '/loginx', '/login/x', '/LOGIN', '/login/mobile', '/settings/integrations/access']) {
            const response = await proxy(request(pathname))
            expect(passed(response), pathname).toBe(false)
            expect(response.status, pathname).toBe(303)
        }
        for (const entry of ENFORCED_SESSIONLESS_ALLOWLIST) {
            const pathname = concrete(entry.path)
            // A trailing `[name]` segment takes any plain id, so `…x` is not a neighbour there.
            const endsInParameter = /\]$/.test(entry.path)
            const neighbours = [`${pathname}/`, `${pathname}/x`, pathname.toUpperCase(), pathname.slice(0, pathname.lastIndexOf('/'))]
            if (!endsInParameter) neighbours.push(`${pathname}x`)
            for (const neighbour of neighbours) {
                const method = entry.methods[0]
                const response = await proxy(request(neighbour, { method }))
                expect(passed(response), `${method} ${neighbour}`).toBe(false)
            }
        }
    })

    test('a forged, expired or revoked staff cookie counts as no session', async () => {
        const forged = `${staffToken().split('.')[0]}.${Buffer.alloc(32, 7).toString('base64url')}`
        const expired = staffToken(MANAGER.id, 0, Date.now() - 13 * 60 * 60 * 1000)
        const revokedToken = staffToken(ADMIN.id)
        fake.rows.set(ADMIN.id, { userId: ADMIN.id, registryCreatedAt: ADMIN.createdAt, sessionEpoch: 0, revokedAt: new Date() })
        const epochMoved = staffToken(MANAGER.id, 5)
        for (const token of [forged, expired, revokedToken, epochMoved, 'junk']) {
            const cookies = { [staffCookie()]: token, crm_user_id: 'u2' }
            expectLoginRedirect(await proxy(request('/messages', { cookies })), '/messages')
            await expectRefusedJson(await proxy(request('/api/contacts/search', { cookies })))
            await expectRefusedJson(await proxy(action('/messages', ID.sendMessage, { cookies })))
            const listed = action('/login', ID.staffLogin, { cookies })
            expectForwardedWithoutIdentity(await proxy(listed), listed)
        }
    })

    test('a bare crm_user_id, an integration-admin cookie, a refused mobile cookie or two sessions are no session', async () => {
        vi.stubEnv('ADMIN_USER', 'integration-admin')
        vi.stubEnv('ADMIN_PASS', 'integration admin pass phrase')
        const integrationAdmin = issueIntegrationAdminSession()
        expect(integrationAdmin).toBeTruthy()
        const mobile = issueMobileSession('u1', 'a1b2c3d4e5f6a7b8', 0) as string
        const cookieSets: Array<Record<string, string>> = [
            { crm_user_id: 'u2' },
            { yoko_integration_admin_session: integrationAdmin as string, crm_user_id: 'u2' },
            { [MOBILE_SESSION_COOKIE]: 'junk', crm_user_id: 'u2' },
            { [MOBILE_SESSION_COOKIE]: mobile, [staffCookie()]: staffToken() },
        ]
        for (const cookies of cookieSets) {
            expectLoginRedirect(await proxy(request('/settings/integrations/telegram', { cookies })), '/settings/integrations/telegram')
            await expectRefusedJson(await proxy(request('/api/settings/telephony-connection', { cookies })))
        }
    })
})

describe('enforcement on: everything with a verified session is unchanged', () => {
    beforeEach(() => enforce())

    test('a live staff session goes on as its employee: pages, API, any action', async () => {
        const cookies = { [staffCookie()]: staffToken(), crm_user_id: 'u2' }
        for (const req of [request('/messages', { cookies }), request('/api/contacts/search', { cookies }), action('/messages', ID.sendMessage, { cookies })]) {
            const response = await proxy(req)
            expect(passed(response)).toBe(true)
            expect(downstreamCookie(response, req)).toContain('crm_user_id=u1')
            expect(downstreamCookie(response, req)).not.toContain('crm_user_id=u2')
        }
    })

    test('an unreadable credential store is still 503 (R3), not a sign-in redirect', async () => {
        fake.storeUnreadable = true
        const cookies = { [staffCookie()]: staffToken() }
        const api = await proxy(request('/api/contacts/search', { cookies }))
        expect(api.status).toBe(503)
        expect(await api.json()).toEqual({ error: 'staff_session_unverifiable' })
        expect((await proxy(request('/messages', { cookies }))).status).toBe(503)
    })

    test('a live mobile session from a native client goes on as its operator', async () => {
        const req = request('/api/mobile/push-registration', {
            method: 'POST',
            ua: NATIVE_UA,
            cookies: { [MOBILE_SESSION_COOKIE]: issueMobileSession('u1', 'a1b2c3d4e5f6a7b8', 0) as string },
        })
        const response = await proxy(req)
        expect(passed(response)).toBe(true)
        expect(downstreamCookie(response, req)).toContain('crm_user_id=u1')
    })

    test('the shell lane answers as before: 303 to the mobile sign-in, 401 for its API, the native logout passes', async () => {
        const page = await proxy(request('/messages', { ua: SHELL_UA }))
        expect(page.status).toBe(303)
        expect(new URL(page.headers.get('location') ?? '').pathname).toBe('/login/mobile')
        const api = await proxy(request('/api/messages', { ua: SHELL_UA }))
        expect(api.status).toBe(401)
        expect(await api.json()).toEqual({ error: 'mobile_session_required' })
        for (const req of [
            request('/login/mobile', { ua: SHELL_UA }),
            request('/_next/static/chunks/main.js', { ua: SHELL_UA }),
            request('/favicon.ico', { ua: SHELL_UA }),
            request('/api/mobile/session/logout', { method: 'POST', ua: SHELL_UA, headers: { 'content-type': 'application/json' } }),
        ]) {
            expectForwardedWithoutIdentity(await proxy(req), req)
        }
    })
})

describe('enforcement on: a forged shell marker opens no more than the enforced browser lane', () => {
    beforeEach(() => enforce())

    test('only the pinned mobile sign-in action runs session-less on /login/mobile', async () => {
        const signIn = action('/login/mobile', ID.submitMobileLoginAction, { ua: SHELL_UA, cookies: { crm_user_id: 'u2' } })
        expectForwardedWithoutIdentity(await proxy(signIn), signIn)
        for (const id of [ID.addUser, ID.staffLogin, ID.queryCurrentUserV1, ID.sendMessage, `60${'ff'.repeat(20)}`]) {
            await expectRefusedJson(await proxy(action('/login/mobile', id, { ua: SHELL_UA })), 'mobile_session_required')
        }
        await expectRefusedJson(await proxy(action('/_next/x', ID.submitMobileLoginAction, { ua: SHELL_UA })), 'mobile_session_required')
        // The browser sign-in is no shell action: /login is no shell public path, so the
        // shell's own, unchanged answer applies (303 to the mobile sign-in), and nothing runs.
        const browserSignIn = await proxy(action('/login', ID.staffLogin, { ua: SHELL_UA }))
        expect(passed(browserSignIn)).toBe(false)
        expect(browserSignIn.status).toBe(303)
    })

    test('a no-JS form post to the shell sign-in page is refused', async () => {
        await expectRefusedJson(
            await proxy(request('/login/mobile', { method: 'POST', ua: SHELL_UA, headers: { 'content-type': 'multipart/form-data; boundary=x' } })),
            'mobile_session_required',
        )
    })
})

describe('the session-less sign-in list carries no contact data', () => {
    test('getSignInEmployees: active employees only, id, name and role only', async () => {
        writeFileSync(process.env.YOKO_USER_REGISTRY_FILE as string, JSON.stringify([
            { ...MANAGER, email: 'maria.ivanova@example.test', phone: '+79990001122' },
            { ...ADMIN, email: 'a.sidorov@example.test', phone: '+79990003344' },
            { id: 'u9', firstName: 'Отключённый', lastName: 'Сотрудник', role: 'Менеджер', status: 'Отключен', createdAt: '2026-03-24T00:00:00Z', email: 'off@example.test', phone: '+79990005566' },
        ], null, 2))
        const list = await userService.getSignInEmployees()
        expect(list).toEqual([
            { id: 'u1', firstName: 'Мария', lastName: 'Иванова', role: 'Менеджер' },
            { id: 'u2', firstName: 'Александр', lastName: 'Сидоров', role: 'Администратор' },
        ])
        const bytes = JSON.stringify(list)
        for (const forbidden of ['@', '+7999', '7999000', 'email', 'phone', 'status', 'createdAt', 'Активен', 'Отключ', 'u9', '2026-03-24']) {
            expect(bytes, forbidden).not.toContain(forbidden)
        }
    })

    test('the sign-in page asks for that list, not the full registry read', () => {
        const page = readFileSync(path.join(__dirname, '../../app/login/page.tsx'), 'utf8')
        expect(page).toContain('getSignInEmployees()')
        expect(page).not.toMatch(/\bgetUsers\b/)
    })
})

describe('the reviewed surface is pinned', () => {
    test('the session-less allowlist is exactly these exact paths, methods and reasons', () => {
        expect(ENFORCED_SESSIONLESS_ALLOWLIST.map(({ path, methods }) => ({ path, methods }))).toEqual([
            { path: '/login', methods: ['GET', 'HEAD'] },
            { path: '/api/mobile/push-registration', methods: ['POST'] },
            { path: '/api/mobile/session/logout', methods: ['POST'] },
            { path: '/api/webhooks/bot', methods: ['POST'] },
            { path: '/api/webhook/telegram', methods: ['POST'] },
            { path: '/api/webhooks/max', methods: ['POST'] },
            { path: '/api/webhook/max/reaction', methods: ['POST'] },
            { path: '/api/ai-calls/sessions/[id]/state', methods: ['POST'] },
            { path: '/api/ai-calls/sessions/[id]/transcript-item', methods: ['POST'] },
            { path: '/api/ai-calls/sessions/[id]/finalize', methods: ['POST'] },
            { path: '/api/ai-calls/sessions/by-fs-uuid/[fsUuid]', methods: ['GET'] },
            { path: '/api/internal/ai-call-keys', methods: ['GET'] },
        ])
        for (const entry of ENFORCED_SESSIONLESS_ALLOWLIST) {
            expect(entry.path).toMatch(/^(\/([a-z0-9-]+|\[[A-Za-z]+\]))+$/)
            expect(entry.reason.length).toBeGreaterThan(20)
        }
        expect(new Set(ENFORCED_SESSIONLESS_ALLOWLIST.map((entry) => entry.path)).size).toBe(ENFORCED_SESSIONLESS_ALLOWLIST.length)
    })

    test('the session-less server actions are exactly the sign-in actions', () => {
        expect(SESSIONLESS_SERVER_ACTIONS).toEqual({
            '/login': {
                lane: 'browser',
                worker: 'app/login/page',
                actions: [
                    'src/lib/users/user-service.ts#getLoginMode',
                    'src/lib/users/user-service.ts#getSignInEmployees',
                    'src/lib/users/user-service.ts#staffLogin',
                ],
            },
            '/login/mobile': {
                lane: 'shell',
                worker: 'app/login/mobile/page',
                actions: ['src/app/login/mobile/actions.ts#submitMobileLoginAction'],
            },
        })
    })

    test('the proxy matcher is the catch-all minus the build output', () => {
        expect(config.matcher).toEqual(['/((?!_next/static|_next/image|favicon.ico).*)'])
    })
})
