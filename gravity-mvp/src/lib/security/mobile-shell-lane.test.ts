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

vi.mock('next/server', async () => {
    class FakeNextResponse extends Response {
        static next() {
            return new Response(null, { status: 200, headers: { 'x-proxy': 'next' } })
        }

        static json(body: unknown, init?: ResponseInit) {
            return new Response(JSON.stringify(body), {
                ...init,
                headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
            })
        }

        static redirect(url: URL | string, init?: number | ResponseInit) {
            const status = typeof init === 'number' ? init : (init as ResponseInit | undefined)?.status ?? 307
            return new Response(null, { status, headers: { location: url.toString() } })
        }
    }
    return { NextResponse: FakeNextResponse }
})

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

/** Minimal stand-in for the NextRequest surface the proxy actually uses. */
function request(pathname: string, options: { ua?: string, cookie?: string, search?: string } = {}) {
    const url = new URL(`https://yokoone.ru${pathname}${options.search ?? ''}`)
    const cookies = new Map<string, { value: string }>()
    if (options.cookie) cookies.set(MOBILE_SESSION_COOKIE, { value: options.cookie })
    return {
        nextUrl: url,
        url: url.toString(),
        headers: new Headers({ 'user-agent': options.ua ?? DESKTOP_UA }),
        cookies: { get: (name: string) => cookies.get(name) },
    } as never
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
    test('a desktop request passes through everywhere', () => {
        for (const p of ['/messages', '/api/messages', '/api/messages/stream/abc', '/settings']) {
            expect(proxy(request(p)).headers.get('x-proxy')).toBe('next')
        }
    })

    test('the debug database gate still answers 404 for everyone', () => {
        expect(proxy(request('/api/debug-db/anything')).status).toBe(404)
        expect(proxy(request('/api/debug-db/anything', { ua: SHELL_UA })).status).toBe(404)
    })
})

describe('the shell lane fails closed', () => {
    test('a saved direct messenger URL no longer bypasses login', () => {
        // This is the exact hole a route-level gate left open: the shell
        // restores its last URL on launch and never passes through the
        // notification route.
        const response = proxy(request('/messages', { ua: SHELL_UA, search: '?id=chat_1&channel=tg' }))
        expect(response.status).toBe(303)
        expect(response.headers.get('location'))
            .toBe('https://yokoone.ru/login/mobile?next=%2Fmessages%3Fid%3Dchat_1%26channel%3Dtg')
    })

    test('every messenger API is closed, not just the notification route', () => {
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
            const response = proxy(request(p, { ua: SHELL_UA }))
            expect(response.status, p).toBe(401)
        }
    })

    test('the login screen and its assets stay reachable, or nothing could log in', () => {
        expect(proxy(request('/login/mobile', { ua: SHELL_UA })).headers.get('x-proxy')).toBe('next')
        expect(proxy(request('/_next/data/x.json', { ua: SHELL_UA })).headers.get('x-proxy')).toBe('next')
    })

    test('a live session opens the lane', () => {
        const cookie = liveToken()
        expect(proxy(request('/messages', { ua: SHELL_UA, cookie })).headers.get('x-proxy')).toBe('next')
        expect(proxy(request('/api/messages', { ua: SHELL_UA, cookie })).headers.get('x-proxy')).toBe('next')
    })
})

describe('session lifecycle bites on the next request', () => {
    test('expiry closes the lane', () => {
        const cookie = liveToken()
        vi.setSystemTime(NOW + 12 * 60 * 60 * 1000)
        expect(proxy(request('/api/messages', { ua: SHELL_UA, cookie })).status).toBe(401)
        expect(proxy(request('/messages', { ua: SHELL_UA, cookie })).status).toBe(303)
    })

    test('a revocation epoch bump closes the lane with the cookie still on the device', () => {
        const cookie = liveToken()
        expect(proxy(request('/api/messages', { ua: SHELL_UA, cookie })).headers.get('x-proxy')).toBe('next')
        process.env.MOBILE_SESSION_REVOCATION_EPOCH = '1'
        expect(proxy(request('/api/messages', { ua: SHELL_UA, cookie })).status).toBe(401)
    })

    test('rotating the credential closes the lane', () => {
        const cookie = liveToken()
        process.env.MOBILE_ACCESS_PASS = 'a completely different passphrase'
        expect(proxy(request('/api/messages', { ua: SHELL_UA, cookie })).status).toBe(401)
    })

    test('logout closes the lane, because the cleared cookie verifies as nothing', () => {
        expect(proxy(request('/api/messages', { ua: SHELL_UA, cookie: '' })).status).toBe(401)
    })
})

describe('forgery buys nothing', () => {
    test('a tampered payload with the original signature is refused', () => {
        const cookie = liveToken()
        const [payload, signature] = cookie.split('.')
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
        const forged = Buffer.from(JSON.stringify({ ...decoded, op: 'u2' }), 'utf8').toString('base64url')
        expect(proxy(request('/api/messages', { ua: SHELL_UA, cookie: `${forged}.${signature}` })).status).toBe(401)
    })

    test('crm_user_id cannot substitute for the session', () => {
        // The unsigned selector is not read here at all; only the signed cookie
        // is. A shell request carrying a forged identity cookie and no session
        // is still closed.
        const response = proxy(request('/api/messages', { ua: SHELL_UA }))
        expect(response.status).toBe(401)
    })

    test('garbage in the session cookie is refused', () => {
        for (const junk of ['', 'x', 'a.b', 'not-a-token', 'x'.repeat(5000)]) {
            expect(proxy(request('/api/messages', { ua: SHELL_UA, cookie: junk })).status).toBe(401)
        }
    })
})

describe('the marker is declared identically on both sides', () => {
    test('the proxy and the identity module agree, and the shell matches', () => {
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
