// @vitest-environment node
/**
 * F-1 native mobile logout (`POST /api/mobile/session/logout`) on real PostgreSQL.
 *
 * The barrier row is the invariant, so nothing is mocked except the Next.js
 * cookie store: sessions are real signed tokens, the logout and registration
 * routes are the real routes, and every row is a real row.
 *
 * Runs only against a disposable database named by
 * MOBILE_PUSH_TEST_DATABASE_URL (DATABASE_URL must name the same database);
 * skipped otherwise. Run with --no-file-parallelism beside the other Mobile
 * Push PostgreSQL files: they share one disposable database.
 */
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const jar = await vi.hoisted(async () => {
    const { AsyncLocalStorage } = await import('node:async_hooks')
    return {
        request: new AsyncLocalStorage<{ token: string | undefined, set: Array<{ name: string, value: string, maxAge?: number }> }>(),
    }
})
vi.mock('next/headers', () => ({
    cookies: async () => {
        const request = jar.request.getStore()
        return {
            get: (name: string) => (name === 'yoko_mobile_session' && request?.token ? { name, value: request.token } : undefined),
            set: (name: string, value: string, options?: { maxAge?: number }) => { request?.set.push({ name, value, maxAge: options?.maxAge }) },
        }
    },
    headers: async () => new Headers(),
}))

import { prisma } from '@/lib/prisma'
import { POST as logoutRoute } from '@/app/api/mobile/session/logout/route'
import { POST as registerRoute } from '@/app/api/mobile/push-registration/route'
import { issueMobileSession, mobileSessionBarrierEntryV1, verifyMobileSession } from './mobile-session-credentials'
import { resolveCookieOperatorV1 } from './mobile-session-operator'

const DATABASE = process.env.MOBILE_PUSH_TEST_DATABASE_URL
const describeWithDatabase = DATABASE ? describe.sequential : describe.skip
const RUN = `mplo${Date.now().toString(36)}`
const device = (name: string) => `${RUN}-${name}`
const token = (name: string) => `${RUN}_tok_${name}_0123456789:ABCDEFGHIJKLMNOP`
const HOUR = 3600_000

function sessionFor(deviceId: string, operator = 'u1', nowMs = Date.now()): string {
    const issued = issueMobileSession(operator, deviceId, undefined, nowMs)
    if (!issued) throw new Error('mobile lane not provisioned for the test process')
    return issued
}

const entryOf = (sessionToken: string) => mobileSessionBarrierEntryV1(verifyMobileSession(sessionToken)!)!

async function logout(sessionToken: string | undefined, body = '{}') {
    const scope = { token: sessionToken, set: [] as Array<{ name: string, value: string, maxAge?: number }> }
    return jar.request.run(scope, async () => {
        const response = await logoutRoute(new NextRequest('http://localhost/api/mobile/session/logout', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
        }))
        return { status: response.status, body: await response.text(), cookies: scope.set }
    })
}

async function register(sessionToken: string, pushToken: string) {
    return jar.request.run({ token: sessionToken, set: [] }, async () => {
        const response = await registerRoute(new NextRequest('http://localhost/api/mobile/push-registration', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: pushToken }),
        }))
        return { status: response.status, body: await response.json() as Record<string, unknown> }
    })
}

const rowOf = (deviceId: string) => prisma.mobileDeviceRegistration.findUnique({ where: { deviceId } })
const rowsForRun = () => prisma.mobileDeviceRegistration.findMany({ where: { deviceId: { startsWith: RUN } }, orderBy: { deviceId: 'asc' } })

describeWithDatabase('F-1 mobile logout endpoint (PostgreSQL)', () => {
    beforeAll(() => {
        if (process.env.DATABASE_URL !== DATABASE) throw new Error('DATABASE_URL must equal MOBILE_PUSH_TEST_DATABASE_URL')
        if (!process.env.MOBILE_ACCESS_USER || !process.env.MOBILE_ACCESS_PASS) throw new Error('MOBILE_ACCESS_* must be provisioned for the test process')
    })
    beforeEach(async () => {
        delete process.env.MOBILE_SESSION_REVOCATION_EPOCH
        await prisma.mobileDeviceRegistration.deleteMany({ where: { deviceId: { startsWith: RUN } } })
    })
    afterAll(async () => {
        await prisma.mobileDeviceRegistration.deleteMany({ where: { deviceId: { startsWith: RUN } } })
        await prisma.$disconnect()
    })

    it('1. a registered device: 204, the row is revoked and bars exactly the presented session; that session is refused afterwards', async () => {
        const session = sessionFor(device('reg'))
        expect((await register(session, token('reg'))).status).toBe(200)

        const result = await logout(session)
        expect(result).toMatchObject({ status: 204, body: '' })
        expect(result.cookies).toEqual([
            { name: 'yoko_mobile_session', value: '', maxAge: 0 },
            { name: 'crm_user_id', value: '', maxAge: 0 },
        ])
        const row = await rowOf(device('reg'))
        expect(row).toMatchObject({ fcmToken: null, revokedReason: 'logout' })
        expect(row!.revokedAt).not.toBeNull()
        expect(row!.revokedSessionBindings).toEqual([entryOf(session)])

        expect(await resolveCookieOperatorV1(session, undefined)).toEqual({ kind: 'mobile_session_refused' })
        expect(await register(session, token('reg'))).toEqual({ status: 401, body: { error: 'MOBILE_SESSION_REVOKED' } })
    })

    it('2. a device that never registered gets a tombstone carrying the barrier; a late registration from that session is refused', async () => {
        const session = sessionFor(device('tomb'))
        expect((await logout(session)).status).toBe(204)
        const tombstone = await rowOf(device('tomb'))
        expect(tombstone).toMatchObject({ fcmToken: null, revokedReason: 'logout' })
        expect(tombstone!.revokedSessionBindings).toEqual([entryOf(session)])
        expect(await register(session, token('tomb'))).toEqual({ status: 401, body: { error: 'MOBILE_SESSION_REVOKED' } })
        expect(await rowOf(device('tomb'))).toMatchObject({ fcmToken: null, revokedReason: 'logout' })
    })

    it('3. a repeat is idempotent: 204, and the row is byte-for-byte unchanged', async () => {
        const session = sessionFor(device('again'))
        await register(session, token('again'))
        expect((await logout(session)).status).toBe(204)
        const before = await rowOf(device('again'))
        const again = await logout(session)
        expect(again).toMatchObject({ status: 204, body: '' })
        expect(again.cookies).toEqual([])
        expect(await rowOf(device('again'))).toEqual(before)
    })

    it('4. only the presented session is barred: a newer login on the same device stays live and can register', async () => {
        const first = sessionFor(device('two'))
        await register(first, token('two'))
        expect((await logout(first)).status).toBe(204)

        const second = sessionFor(device('two'), 'u1', Date.now() + 1000)
        expect(await resolveCookieOperatorV1(second, undefined)).toEqual({ kind: 'mobile_session', operatorId: 'u1' })
        expect((await register(second, token('two'))).status).toBe(200)
        expect(await rowOf(device('two'))).toMatchObject({ revokedAt: null, fcmToken: token('two') })
        expect((await rowOf(device('two')))!.revokedSessionBindings).toEqual([entryOf(first)])

        expect((await logout(second)).status).toBe(204)
        expect(new Set((await rowOf(device('two')))!.revokedSessionBindings)).toEqual(new Set([entryOf(first), entryOf(second)]))
    })

    it('5. a body naming another device or session changes nothing but the presented session', async () => {
        const mine = sessionFor(device('mine'))
        const theirs = sessionFor(device('theirs'), 'u2')
        await register(theirs, token('theirs'))
        const result = await logout(mine, JSON.stringify({ deviceId: device('theirs'), operatorId: 'u2', barrierEntry: entryOf(theirs) }))
        expect(result.status).toBe(204)
        expect(await rowOf(device('theirs'))).toMatchObject({ revokedAt: null, fcmToken: token('theirs'), revokedSessionBindings: [] })
        expect((await rowOf(device('mine')))!.revokedSessionBindings).toEqual([entryOf(mine)])
    })

    it('6. no session, a forged one, an expired one and one of an older epoch: 204 and not a single row', async () => {
        const forged = (() => { const [payload] = sessionFor(device('forged')).split('.'); return `${payload}.${Buffer.alloc(32, 7).toString('base64url')}` })()
        const expired = sessionFor(device('expired'), 'u1', Date.now() - 13 * HOUR)
        const oldEpoch = sessionFor(device('epoch'))
        for (const presented of [undefined, forged, expired, 'junk']) {
            expect(await logout(presented)).toEqual({ status: 204, body: '', cookies: [] })
        }
        process.env.MOBILE_SESSION_REVOCATION_EPOCH = '3'
        expect(await logout(oldEpoch)).toEqual({ status: 204, body: '', cookies: [] })
        expect(await rowsForRun()).toEqual([])
    })

    it('7. concurrent logouts of one session converge: every answer is 204 and the barrier holds the entry once', async () => {
        const session = sessionFor(device('race'))
        await register(session, token('race'))
        const results = await Promise.all(Array.from({ length: 6 }, () => logout(session)))
        expect(results.map((result) => result.status)).toEqual([204, 204, 204, 204, 204, 204])
        const row = await rowOf(device('race'))
        expect(row).toMatchObject({ fcmToken: null, revokedReason: 'logout' })
        expect(row!.revokedSessionBindings).toEqual([entryOf(session)])
    })

    it('8. the endpoint authenticates nobody: no logout response ever sets a non-empty cookie', async () => {
        const session = sessionFor(device('noauth'))
        const answers = [await logout(session), await logout(session), await logout(undefined)]
        for (const answer of answers) {
            expect(answer.cookies.every((cookie) => cookie.value === '' && cookie.maxAge === 0)).toBe(true)
        }
    })
})
