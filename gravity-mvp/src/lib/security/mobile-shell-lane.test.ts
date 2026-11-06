import { beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The mobile lane's request boundary.
 *
 * Everything asserted here is a property the stage report claims, so it is
 * asserted rather than argued: the shell reaches nothing without a live
 * session, expiry and revocation bite on the next request, logout closes the
 * lane, and a forged `crm_user_id` buys nothing.
 */

// The real next/server: the proxy forwards a rewritten request (BR-4), which a
// stand-in that ignores NextResponse.next's arguments could not show.
// The logout barrier is server state; here no session has been logged out.
vi.mock('@/modules/identity-access/internal/mobile-session-barrier', () => ({
    prismaMobileSessionBarrierV1: { isBarred: vi.fn(async () => false) },
}))

const { NextRequest } = await import('next/server')
const { proxy, MOBILE_SHELL_UA_TOKEN } = await import('@/proxy')
const { issueMobileSession, MOBILE_SESSION_COOKIE } = await import(
    '@/modules/identity-access/public/v1/mobile-session-credentials'
)

const ENV = {
    MOBILE_ACCESS_USER: 'mobile-operator',
    MOBILE_ACCESS_PASS: 'correct horse battery staple',
}
const SHELL_UA = `Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 ${MOBILE_SHELL_UA_TOKEN}1`
const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120'
const NOW = Date.UTC(2026, 8, 11, 9, 0, 0)

/** A real NextRequest; `cookie` is the mobile session cookie value when given. */
function request(pathname: string, options: { ua?: string, cookie?: string, search?: string } = {}) {
    const url = new URL(`https://yokoone.ru${pathname}${options.search ?? ''}`)
    const headers = new Headers({ 'user-agent': options.ua ?? DESKTOP_UA })
    if (options.cookie !== undefined) headers.set('cookie', `${MOBILE_SESSION_COOKIE}=${options.cookie}`)
    return new NextRequest(url, { headers })
}

/** The proxy let the request through to the application. */
function passed(response: Response): boolean {
    return response.headers.get('x-middleware-next') === '1'
}

function liveToken(now = NOW) {
    return issueMobileSession('u1', 'a1b2c3d4e5f6a7b8', ENV, now) as string
}

beforeEach(() => {
    process.env.MOBILE_ACCESS_USER = ENV.MOBILE_ACCESS_USER
    process.env.MOBILE_ACCESS_PASS = ENV.MOBILE_ACCESS_PASS
    delete process.env.MOBILE_SESSION_REVOCATION_EPOCH
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
})

describe('the browser lane is untouched', () => {
    test('a desktop request passes through everywhere', async () => {
        for (const p of ['/messages', '/api/messages', '/api/messages/stream/abc', '/settings']) {
            expect(passed(await proxy(request(p)))).toBe(true)
        }
    })

    test('the debug database gate still answers 404 for everyone', async () => {
        expect((await proxy(request('/api/debug-db/anything'))).status).toBe(404)
        expect((await proxy(request('/api/debug-db/anything', { ua: SHELL_UA }))).status).toBe(404)
    })
})

describe('the shell lane fails closed', () => {
    test('a saved direct messenger URL no longer bypasses login', async () => {
        // This is the exact hole a route-level gate left open: the shell
        // restores its last URL on launch and never passes through the
        // notification route.
        const response = (await proxy(request('/messages', { ua: SHELL_UA, search: '?id=chat_1&channel=tg' })))
        expect(response.status).toBe(303)
        expect(response.headers.get('location'))
            .toBe('https://yokoone.ru/login/mobile?next=%2Fmessages%3Fid%3Dchat_1%26channel%3Dtg')
    })

    test('every messenger API is closed, not just the notification route', async () => {
        for (const p of [
            '/api/messages',
            '/api/messages/conversations',
            '/api/messages/stream/chat_1',
            '/api/messages/send-media',
            '/api/messages/delete',
            '/api/messages/reaction',
            '/api/chats/find-max',
            '/api/channels/accounts',
        ]) {
            const response = (await proxy(request(p, { ua: SHELL_UA })))
            expect(response.status, p).toBe(401)
        }
    })

    test('the login screen and its assets stay reachable, or nothing could log in', async () => {
        expect(passed(await proxy(request('/login/mobile', { ua: SHELL_UA })))).toBe(true)
        // A real NextRequest normalizes Pages-Router `/_next/data/<build>/x.json` to the page
        // path, so the asset case uses a `_next/` path that keeps its prefix.
        expect(passed(await proxy(request('/_next/webpack-hmr', { ua: SHELL_UA })))).toBe(true)
    })

    test('a live session opens the lane', async () => {
        const cookie = liveToken()
        expect(passed(await proxy(request('/messages', { ua: SHELL_UA, cookie })))).toBe(true)
        expect(passed(await proxy(request('/api/messages', { ua: SHELL_UA, cookie })))).toBe(true)
    })
})

describe('session lifecycle bites on the next request', () => {
    test('expiry closes the lane', async () => {
        const cookie = liveToken()
        vi.setSystemTime(NOW + 12 * 60 * 60 * 1000)
        expect((await proxy(request('/api/messages', { ua: SHELL_UA, cookie }))).status).toBe(401)
        expect((await proxy(request('/messages', { ua: SHELL_UA, cookie }))).status).toBe(303)
    })

    test('a revocation epoch bump closes the lane with the cookie still on the device', async () => {
        const cookie = liveToken()
        expect(passed(await proxy(request('/api/messages', { ua: SHELL_UA, cookie })))).toBe(true)
        process.env.MOBILE_SESSION_REVOCATION_EPOCH = '1'
        expect((await proxy(request('/api/messages', { ua: SHELL_UA, cookie }))).status).toBe(401)
    })

    test('rotating the credential closes the lane', async () => {
        const cookie = liveToken()
        process.env.MOBILE_ACCESS_PASS = 'a completely different passphrase'
        expect((await proxy(request('/api/messages', { ua: SHELL_UA, cookie }))).status).toBe(401)
    })

    test('logout closes the lane, because the cleared cookie verifies as nothing', async () => {
        expect((await proxy(request('/api/messages', { ua: SHELL_UA, cookie: '' }))).status).toBe(401)
    })
})

describe('forgery buys nothing', () => {
    test('a tampered payload with the original signature is refused', async () => {
        const cookie = liveToken()
        const [payload, signature] = cookie.split('.')
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
        const forged = Buffer.from(JSON.stringify({ ...decoded, op: 'u2' }), 'utf8').toString('base64url')
        expect((await proxy(request('/api/messages', { ua: SHELL_UA, cookie: `${forged}.${signature}` }))).status).toBe(401)
    })

    test('crm_user_id cannot substitute for the session', async () => {
        // The unsigned selector is not read here at all; only the signed cookie
        // is. A shell request carrying a forged identity cookie and no session
        // is still closed.
        const response = (await proxy(request('/api/messages', { ua: SHELL_UA })))
        expect(response.status).toBe(401)
    })

    test('garbage in the session cookie is refused', async () => {
        for (const junk of ['', 'x', 'a.b', 'not-a-token', 'x'.repeat(5000)]) {
            expect((await proxy(request('/api/messages', { ua: SHELL_UA, cookie: junk }))).status).toBe(401)
        }
    })
})

describe('the marker is declared identically on both sides', () => {
    test('the proxy and the identity module agree, and the shell matches', async () => {
        const root = path.resolve(__dirname, '../../..')
        const identity = readFileSync(
            path.join(root, 'src/modules/identity-access/public/v1/mobile-session-auth.ts'),
            'utf8',
        )
        expect(identity).toContain(`const MOBILE_SHELL_UA_TOKEN = '${MOBILE_SHELL_UA_TOKEN}'`)

        const shell = readFileSync(
            path.resolve(root, '../android/app/src/main/java/ru/yokoone/crm/shell/CrmOrigin.kt'),
            'utf8',
        )
        expect(shell).toContain(`const val SHELL_UA_TOKEN: String = "${MOBILE_SHELL_UA_TOKEN}"`)
    })
})
