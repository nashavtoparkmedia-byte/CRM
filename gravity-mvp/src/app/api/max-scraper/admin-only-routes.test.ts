import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// /api/max-scraper/{qr,restart,status,import-progress} proxy the MAX scraper:
// the live login QR, its restart and its state. They admit only the signed
// integration-administrator session. The real identity-access check runs
// here over a cookie jar; only next/headers and the scraper fetch are faked.

const ADMIN_USER = 'integration-admin-test'
const ADMIN_PASS = 'integration-admin-test-password'

const jar = vi.hoisted(() => new Map<string, string>())
vi.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    }),
}))

import { GET as qr } from './qr/route'
import { POST as restart } from './restart/route'
import { GET as status } from './status/route'
import { GET as importProgress } from './import-progress/route'
import {
    INTEGRATION_ADMIN_SESSION_COOKIE,
    issueIntegrationAdminSession,
} from '@/modules/identity-access/public/v1/integration-admin-credentials'
import { MOBILE_SESSION_COOKIE } from '@/modules/identity-access/public/v1/mobile-session-credentials'

const ROUTES = [
    ['qr', qr],
    ['restart', restart],
    ['status', status],
    ['import-progress', importProgress],
] as const

const fetchMock = vi.fn()

function adminToken(env = { ADMIN_USER, ADMIN_PASS }, nowMs = Date.now()) {
    const token = issueIntegrationAdminSession(env, nowMs)
    if (!token) throw new Error('test admin token not issued')
    return token
}

const REFUSED_PRINCIPALS: Array<[string, () => void]> = [
    ['no session', () => {}],
    ['the unsigned crm_user_id selector', () => { jar.set('crm_user_id', 'user-admin-1') }],
    ['a staff session', () => { jar.set('__Host-yoko_staff_session', 'staff-session-token-of-a-verified-employee') }],
    ['a mobile session', () => { jar.set(MOBILE_SESSION_COOKIE, 'mobile-session-token-of-a-signed-operator') }],
    ['a forged admin cookie', () => { jar.set(INTEGRATION_ADMIN_SESSION_COOKIE, 'eyJ2IjoxfQ.forged-signature') }],
    ['an admin cookie signed with another password', () => {
        jar.set(INTEGRATION_ADMIN_SESSION_COOKIE, adminToken({ ADMIN_USER, ADMIN_PASS: 'another-admin-password-entirely' }))
    }],
    ['an expired admin session', () => {
        jar.set(INTEGRATION_ADMIN_SESSION_COOKIE, adminToken(undefined, Date.now() - 9 * 60 * 60 * 1000))
    }],
]

describe('MAX scraper proxy routes are integration-administrator only', () => {
    beforeEach(() => {
        jar.clear()
        fetchMock.mockReset()
        fetchMock.mockResolvedValue(new Response('{"isReady":true}', { status: 200, headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)
        vi.stubEnv('ADMIN_USER', ADMIN_USER)
        vi.stubEnv('ADMIN_PASS', ADMIN_PASS)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
    })

    for (const [principal, arrange] of REFUSED_PRINCIPALS) {
        it.each(ROUTES)(`/api/max-scraper/%s refuses ${principal} before reaching the scraper`, async (_name, handler) => {
            arrange()
            const response = await handler()

            expect(response.status).toBe(403)
            await expect(response.json()).resolves.toEqual({ error: 'MAX_SCRAPER_ADMIN_REQUIRED' })
            expect(fetchMock).not.toHaveBeenCalled()
        })
    }

    it.each(ROUTES)('/api/max-scraper/%s refuses everyone when no administrator is configured', async (_name, handler) => {
        jar.set(INTEGRATION_ADMIN_SESSION_COOKIE, adminToken())
        vi.stubEnv('ADMIN_PASS', '')
        const response = await handler()

        expect(response.status).toBe(403)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it.each(ROUTES)('/api/max-scraper/%s serves the integration administrator as before', async (name, handler) => {
        jar.set(INTEGRATION_ADMIN_SESSION_COOKIE, adminToken())
        const response = await handler()

        expect(response.status).toBe(200)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(String(fetchMock.mock.calls[0][0])).toMatch(new RegExp(`/${name}$`))
    })
})
