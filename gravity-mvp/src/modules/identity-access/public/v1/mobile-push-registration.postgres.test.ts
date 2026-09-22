// @vitest-environment node
/**
 * Mobile Push v1 device registration on real PostgreSQL.
 *
 * Uniqueness, row locking and transaction rollback are the invariants here, so
 * nothing is mocked except the Next.js cookie store: sessions are real signed
 * tokens, the route is the real route, and every row is a real row.
 *
 * Runs only against a disposable database named by
 * MOBILE_PUSH_TEST_DATABASE_URL (DATABASE_URL must name the same database);
 * skipped otherwise. Run the Mobile Push PostgreSQL files with
 * --no-file-parallelism: they share one disposable database.
 */
import { createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Each request sees its own cookie, so concurrent requests in one test are
// really different sessions (a shared variable would let them all read the last).
const jar = await vi.hoisted(async () => {
    const { AsyncLocalStorage } = await import('node:async_hooks')
    return { token: undefined as string | undefined, request: new AsyncLocalStorage<{ token: string | undefined }>() }
})
vi.mock('next/headers', () => ({
    cookies: async () => {
        const request = jar.request.getStore()
        const token = request ? request.token : jar.token
        return {
            get: (name: string) => (name === 'yoko_mobile_session' && token ? { name, value: token } : undefined),
            set: () => undefined,
        }
    },
    headers: async () => new Headers(),
}))

import { prisma } from '@/lib/prisma'
import { POST } from '@/app/api/mobile/push-registration/route'
import { getMobileSessionRevocationEpoch, issueMobileSession, verifyMobileSession } from './mobile-session-credentials'
import { clearMobileSessionV1 } from './mobile-session-auth'
import {
    currentMobilePushEligibilityFactsV1,
    listPushEligibleMobileDevicesV1,
    markMobilePushTokenRejectedV1,
    revokeMobilePushSenderMismatchV1,
} from '../../application/mobile-push-registration-operations'
import {
    createMobilePushRegistrationHandlerV1,
    type MobilePushRegistrationPortV1,
    type MobilePushRegistrationWriteV1,
} from './mobile-push-registration-handler'
import { prismaMobileDeviceRegistrationPortV1 } from './prisma-mobile-device-registration-adapter'

// Send-time resolution is exercised through the owner's own handler and store.
// The exported capability is reserved for its single reviewed consumer.
async function resolveTarget(registrationId: string, sessionBindingId: string) {
    return createMobilePushRegistrationHandlerV1(prismaMobileDeviceRegistrationPortV1)
        .resolveTarget(registrationId, sessionBindingId, currentMobilePushEligibilityFactsV1(new Date())!)
}

const DATABASE = process.env.MOBILE_PUSH_TEST_DATABASE_URL
const describeWithDatabase = DATABASE ? describe.sequential : describe.skip
const RUN = `mpreg${Date.now().toString(36)}`
const device = (name: string) => `${RUN}-${name}`
const token = (name: string) => `${RUN}_tok_${name}_0123456789:ABCDEFGHIJKLMNOP`
const HOUR = 3600_000

function sessionFor(deviceId: string, operator = 'u1', nowMs = Date.now()): string {
    const issued = issueMobileSession(operator, deviceId, undefined, nowMs)
    if (!issued) throw new Error('mobile lane not provisioned for the test process')
    return issued
}

/** The binding recomputed here from the session's own verified facts, never from the token bytes. */
function expectedBinding(sessionToken: string): string {
    const principal = verifyMobileSession(sessionToken)!
    return createHash('sha256').update([
        'yoko.mobile-push.session-binding.v2',
        principal.deviceId,
        principal.credentialSubject,
        getMobileSessionRevocationEpoch(),
        String(principal.expiresAtSeconds),
    ].join('\0'), 'utf8').digest('hex')
}

/** Log out exactly the session that this token proves, in its own request scope. */
async function logout(sessionToken: string): Promise<void> {
    await jar.request.run({ token: sessionToken }, () => clearMobileSessionV1())
}

async function eligibleIds(): Promise<string[]> {
    return (await listPushEligibleMobileDevicesV1()).map((entry) => entry.registrationId)
}

async function register(sessionToken: string | undefined, body: unknown, contentType = 'application/json') {
    return jar.request.run({ token: sessionToken }, async () => {
        const response = await POST(new NextRequest('http://localhost/api/mobile/push-registration', {
            method: 'POST',
            headers: { 'content-type': contentType },
            body: typeof body === 'string' ? body : JSON.stringify(body),
        }))
        return { status: response.status, body: await response.json() as Record<string, unknown> }
    })
}

const rowOf = (deviceId: string) => prisma.mobileDeviceRegistration.findUnique({ where: { deviceId } })
const rowsForRun = () => prisma.mobileDeviceRegistration.findMany({ where: { deviceId: { startsWith: RUN } }, orderBy: { deviceId: 'asc' } })

describeWithDatabase('Mobile Push v1 registration (PostgreSQL)', () => {
    beforeAll(() => {
        if (process.env.DATABASE_URL !== DATABASE) throw new Error('DATABASE_URL must equal MOBILE_PUSH_TEST_DATABASE_URL')
        if (!process.env.MOBILE_ACCESS_USER || !process.env.MOBILE_ACCESS_PASS) throw new Error('MOBILE_ACCESS_* must be provisioned for the test process')
    })
    beforeEach(async () => {
        jar.token = undefined
        delete process.env.MOBILE_SESSION_REVOCATION_EPOCH
        await prisma.mobileDeviceRegistration.deleteMany({ where: { deviceId: { startsWith: RUN } } })
    })
    afterAll(async () => {
        await prisma.mobileDeviceRegistration.deleteMany({ where: { deviceId: { startsWith: RUN } } })
        await prisma.$disconnect()
    })

    it('1. refuses a registration without a mobile session and writes nothing', async () => {
        expect(await register(undefined, { token: token('a') })).toEqual({ status: 401, body: { error: 'MOBILE_SESSION_REQUIRED' } })
        expect(await register('forged.token', { token: token('a') })).toEqual({ status: 401, body: { error: 'MOBILE_SESSION_REQUIRED' } })
        expect(await rowsForRun()).toEqual([])
    })

    it('2. refuses a malformed body, any claimed authority, and a non-JSON request', async () => {
        const session = sessionFor(device('d2'))
        for (const body of [{}, { token: 'short' }, { token: token('a'), deviceId: device('other') }, { token: token('a'), operatorId: 'u2' }, { token: token('a'), sessionBindingId: 'f'.repeat(64) }, '{not json']) {
            expect((await register(session, body)).status).toBe(400)
        }
        expect((await register(session, { token: token('a') }, 'text/plain')).status).toBe(415)
        expect(await rowsForRun()).toEqual([])
    })

    it('3. refuses the shared fallback device id', async () => {
        expect(await register(sessionFor('ephemeral-device'), { token: token('a') })).toEqual({ status: 422, body: { error: 'PUSH_DEVICE_ID_NOT_STABLE' } })
        expect(await prisma.mobileDeviceRegistration.count({ where: { deviceId: 'ephemeral-device' } })).toBe(0)
    })

    it('4. derives every stored fact from the verified session; a repeat is idempotent', async () => {
        const session = sessionFor(device('d4'), 'u2')
        expect(await register(session, { token: token('d4') })).toEqual({ status: 200, body: { ok: true } })
        const first = await rowOf(device('d4'))
        expect(first).toMatchObject({
            deviceId: device('d4'),
            fcmToken: token('d4'),
            credentialSubject: process.env.MOBILE_ACCESS_USER,
            runtimeOperatorId: 'u2',
            sessionBindingId: expectedBinding(session),
            sessionRevocationEpoch: '0',
            revokedAt: null,
        })
        expect(first!.sessionExpiresAt.getTime() - first!.sessionIssuedAt.getTime()).toBe(12 * HOUR)
        expect(await register(session, { token: token('d4') })).toEqual({ status: 200, body: { ok: true } })
        const second = await rowOf(device('d4'))
        expect(second!.id).toBe(first!.id)
        expect(second!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first!.lastSeenAt.getTime())
        expect(await rowsForRun()).toHaveLength(1)
        // The response never echoes the token.
        expect(JSON.stringify(await register(session, { token: token('d4') }))).not.toContain(token('d4'))
    })

    it('5. concurrent registrations for one device converge on one stable row', async () => {
        const session = sessionFor(device('d5'))
        const results = await Promise.all(Array.from({ length: 8 }, (_, index) => register(session, { token: token(`d5-${index % 3}`) })))
        expect(results.every((result) => result.status === 200)).toBe(true)
        const rows = await rowsForRun()
        expect(rows).toHaveLength(1)
        expect(rows[0].fcmToken).toMatch(new RegExp(`^${RUN}_tok_d5-[012]_`))
    })

    it('5b. a device is never refused because its OWN concurrent request bound the token first', async () => {
        // Replays the interleaving deterministically: B's bind hits the token
        // on an ineligible holder; A (same device) reclaims it before B's
        // reclaim runs; B's reclaim then finds nothing to release.
        await register(sessionFor(device('holder5b')), { token: token('shared5b') })
        await prisma.mobileDeviceRegistration.update({ where: { deviceId: device('holder5b') }, data: { sessionExpiresAt: new Date(Date.now() - 1000) } })
        const facts = currentMobilePushEligibilityFactsV1(new Date())!
        const write: MobilePushRegistrationWriteV1 = {
            deviceId: device('d5b'),
            fcmToken: token('shared5b'),
            credentialSubject: facts.credentialSubject,
            runtimeOperatorId: 'u1',
            sessionBindingId: 'c'.repeat(64),
            sessionIssuedAt: new Date(Date.now() - HOUR),
            sessionExpiresAt: new Date(Date.now() + 11 * HOUR),
            sessionRevocationEpoch: facts.revocationEpoch,
            now: facts.now,
        }
        let concurrentRequestOfSameDevice: (() => Promise<unknown>) | null = () => register(sessionFor(device('d5b')), { token: token('shared5b') })
        const interleaved: MobilePushRegistrationPortV1 = {
            ...prismaMobileDeviceRegistrationPortV1,
            async bind(bindWrite) {
                const outcome = await prismaMobileDeviceRegistrationPortV1.bind(bindWrite)
                const run = concurrentRequestOfSameDevice
                concurrentRequestOfSameDevice = null
                if (run) expect(await run()).toEqual({ status: 200, body: { ok: true } })
                return outcome
            },
        }
        expect(await createMobilePushRegistrationHandlerV1(interleaved).register(write, facts)).toMatchObject({ ok: true })
        expect(await rowsForRun()).toHaveLength(2)
        expect(await rowOf(device('d5b'))).toMatchObject({ fcmToken: token('shared5b'), revokedAt: null })
        expect(await prismaMobileDeviceRegistrationPortV1.tokenIsBoundToOtherDevice(token('shared5b'), device('d5b'))).toBe(false)
        expect(await prismaMobileDeviceRegistrationPortV1.tokenIsBoundToOtherDevice(token('shared5b'), device('holder5b'))).toBe(true)
    })

    it('6. a token held by another ELIGIBLE device fails closed and changes neither row', async () => {
        await register(sessionFor(device('holder6')), { token: token('shared6') })
        await register(sessionFor(device('asker6')), { token: token('own6') })
        const before = await rowsForRun()
        expect(await register(sessionFor(device('asker6')), { token: token('shared6') }))
            .toEqual({ status: 409, body: { error: 'PUSH_TOKEN_BOUND_TO_OTHER_DEVICE' } })
        expect(await rowsForRun()).toEqual(before)
    })

    it('6b. the operator label is never an eligibility input: a live holder under another label still wins', async () => {
        await register(sessionFor(device('holder6b'), 'u3'), { token: token('shared6b') })
        expect((await register(sessionFor(device('asker6b'), 'u1'), { token: token('shared6b') })).status).toBe(409)
    })

    it('7. a token held by a server-provably INELIGIBLE device is reclaimed explicitly', async () => {
        const cases: Array<[string, (deviceId: string) => Promise<void>]> = [
            ['expired', async (id) => { await prisma.mobileDeviceRegistration.update({ where: { deviceId: id }, data: { sessionExpiresAt: new Date(Date.now() - 1000) } }) }],
            ['subjectless', async (id) => { await prisma.mobileDeviceRegistration.update({ where: { deviceId: id }, data: { credentialSubject: 'retired-credential' } }) }],
            ['subject', async (id) => { await prisma.mobileDeviceRegistration.update({ where: { deviceId: id }, data: { credentialSubject: 'rotated-away' } }) }],
        ]
        for (const [label, makeIneligible] of cases) {
            const holder = device(`holder7-${label}`)
            const asker = device(`asker7-${label}`)
            await register(sessionFor(holder), { token: token(`shared7-${label}`) })
            await makeIneligible(holder)
            expect(await register(sessionFor(asker), { token: token(`shared7-${label}`) })).toEqual({ status: 200, body: { ok: true } })
            expect(await rowOf(holder)).toMatchObject({ fcmToken: null, revokedReason: 'token_rebound' })
            expect((await rowOf(holder))!.revokedAt).not.toBeNull()
            expect(await rowOf(asker)).toMatchObject({ fcmToken: token(`shared7-${label}`), revokedAt: null })
        }
    })

    it('7b. a revocation-epoch bump makes the old holder reclaimable', async () => {
        await register(sessionFor(device('holder7e')), { token: token('shared7e') })
        process.env.MOBILE_SESSION_REVOCATION_EPOCH = '7'
        expect(await register(sessionFor(device('asker7e')), { token: token('shared7e') })).toEqual({ status: 200, body: { ok: true } })
        expect(await rowOf(device('holder7e'))).toMatchObject({ fcmToken: null, revokedReason: 'token_rebound' })
    })

    it('8. a concurrent rebind race has exactly one winner; the loser fails closed', async () => {
        await register(sessionFor(device('holder8')), { token: token('shared8') })
        await prisma.mobileDeviceRegistration.update({ where: { deviceId: device('holder8') }, data: { sessionExpiresAt: new Date(Date.now() - 1000) } })
        const askers = ['asker8-a', 'asker8-b', 'asker8-c'].map(device)
        const results = await Promise.all(askers.map((id) => register(sessionFor(id), { token: token('shared8') })))
        expect(results.filter((result) => result.status === 200)).toHaveLength(1)
        expect(results.filter((result) => result.status === 409)).toHaveLength(2)
        expect(await prisma.mobileDeviceRegistration.count({ where: { fcmToken: token('shared8') } })).toBe(1)
        expect(await rowOf(device('holder8'))).toMatchObject({ fcmToken: null, revokedReason: 'token_rebound' })
    })

    it('9. a token rotation keeps the registration id and the session binding', async () => {
        const session = sessionFor(device('d9'))
        await register(session, { token: token('d9-old') })
        const before = await rowOf(device('d9'))
        await register(session, { token: token('d9-new') })
        const after = await rowOf(device('d9'))
        expect(after!.id).toBe(before!.id)
        expect(after!.sessionBindingId).toBe(before!.sessionBindingId)
        expect(after!.fcmToken).toBe(token('d9-new'))
    })

    it('10. a new login changes the session binding but not the registration id', async () => {
        const first = sessionFor(device('d10'), 'u1', Date.now() - 60_000)
        const second = sessionFor(device('d10'), 'u1', Date.now())
        expect(first).not.toBe(second)
        await register(first, { token: token('d10') })
        const before = await rowOf(device('d10'))
        await register(second, { token: token('d10') })
        const after = await rowOf(device('d10'))
        expect(after!.id).toBe(before!.id)
        expect(before!.sessionBindingId).toBe(expectedBinding(first))
        expect(after!.sessionBindingId).toBe(expectedBinding(second))
        expect(after!.sessionBindingId).not.toBe(before!.sessionBindingId)
    })

    it('logout revokes the device registration, releases its token, and never touches Message state', async () => {
        const session = sessionFor(device('logout'))
        await register(session, { token: token('logout') })
        const messagesBefore = await prisma.$queryRawUnsafe<Array<{ count: bigint, digest: string | null }>>(
            `SELECT count(*) AS count, md5(string_agg(id || status::text || coalesce("updatedAt"::text, ''), ',' ORDER BY id)) AS digest FROM "Message"`)
        await logout(session)
        expect(await rowOf(device('logout'))).toMatchObject({ fcmToken: null, revokedReason: 'logout' })
        expect(await prisma.$queryRawUnsafe(
            `SELECT count(*) AS count, md5(string_agg(id || status::text || coalesce("updatedAt"::text, ''), ',' ORDER BY id)) AS digest FROM "Message"`)).toEqual(messagesBefore)
        // The released token can be bound again by the same device after a new login.
        expect((await register(sessionFor(device('logout'), 'u1', Date.now() + 1000), { token: token('logout') })).status).toBe(200)
        expect(await rowOf(device('logout'))).toMatchObject({ revokedAt: null, revokedReason: null, fcmToken: token('logout') })
    })

    it('eligibility honours revocation, token loss, expiry, epoch and credential subject; never the operator label', async () => {
        const names = ['ok', 'revoked', 'tokenless', 'expired', 'rotatedsubject']
        for (const name of names) await register(sessionFor(device(`el-${name}`), name === 'ok' ? 'u3' : 'u1'), { token: token(`el-${name}`) })
        await register(sessionFor(device('el-ok-u1'), 'u1'), { token: token('el-ok-u1') })
        await prisma.mobileDeviceRegistration.update({ where: { deviceId: device('el-revoked') }, data: { revokedAt: new Date(), revokedReason: 'logout', fcmToken: null } })
        await prisma.mobileDeviceRegistration.update({ where: { deviceId: device('el-tokenless') }, data: { fcmToken: null } })
        await prisma.mobileDeviceRegistration.update({ where: { deviceId: device('el-expired') }, data: { sessionExpiresAt: new Date(Date.now() - 1) } })
        await prisma.mobileDeviceRegistration.update({ where: { deviceId: device('el-rotatedsubject') }, data: { credentialSubject: 'retired-credential' } })
        const eligible = (await listPushEligibleMobileDevicesV1()).map((entry) => entry.registrationId)
        const ok = await rowOf(device('el-ok'))
        expect(eligible).toContain(ok!.id)
        // Live devices under different operator labels are both eligible.
        expect(eligible).toContain((await rowOf(device('el-ok-u1')))!.id)
        for (const name of names.slice(1)) expect(eligible).not.toContain((await rowOf(device(`el-${name}`)))!.id)
        // Every listed entry carries a session binding and nothing else.
        const listed = (await listPushEligibleMobileDevicesV1()).find((entry) => entry.registrationId === ok!.id)
        expect(Object.keys(listed!).sort()).toEqual(['registrationId', 'sessionBindingId'])

        process.env.MOBILE_SESSION_REVOCATION_EPOCH = 'bumped'
        expect((await listPushEligibleMobileDevicesV1()).map((entry) => entry.registrationId)).not.toContain(ok!.id)
    })

    it('send-time resolution follows the current token and refuses a stale session binding', async () => {
        const session = sessionFor(device('resolve'))
        await register(session, { token: token('resolve-1') })
        const row = await rowOf(device('resolve'))
        expect(await resolveTarget(row!.id, row!.sessionBindingId)).toEqual({ kind: 'send', token: token('resolve-1') })
        await register(session, { token: token('resolve-2') })
        expect(await resolveTarget(row!.id, row!.sessionBindingId)).toEqual({ kind: 'send', token: token('resolve-2') })
        expect(await resolveTarget(row!.id, 'e'.repeat(64))).toEqual({ kind: 'skip', reason: 'stale_session' })
        expect(await resolveTarget('no-such-registration', row!.sessionBindingId)).toEqual({ kind: 'skip', reason: 'not_found' })
    })

    it('a delivery fanned out before logout and re-login never reaches the new session', async () => {
        const before = sessionFor(device('relogin'), 'u1', Date.now() - 60_000)
        await register(before, { token: token('relogin') })
        const pending = await rowOf(device('relogin'))
        await logout(before)
        await register(sessionFor(device('relogin'), 'u1', Date.now()), { token: token('relogin') })
        expect(await resolveTarget(pending!.id, pending!.sessionBindingId)).toEqual({ kind: 'skip', reason: 'stale_session' })
    })

    it('the send-time token read is ONE query conditioned on the binding and every eligibility fact', async () => {
        const session = sessionFor(device('one-read'))
        await register(session, { token: token('one-read') })
        const row = (await rowOf(device('one-read')))!
        const facts = currentMobilePushEligibilityFactsV1(new Date())!
        const read = (sessionBindingId: string, overrides: Partial<typeof facts> = {}) =>
            prismaMobileDeviceRegistrationPortV1.sendableToken(row.id, sessionBindingId, { ...facts, ...overrides })
        expect(await read(row.sessionBindingId)).toEqual({ sendable: true, token: token('one-read') })
        expect(await read('e'.repeat(64))).toEqual({ sendable: false })
        expect(await read(row.sessionBindingId, { now: new Date(row.sessionExpiresAt.getTime()) })).toEqual({ sendable: false })
        expect(await read(row.sessionBindingId, { revocationEpoch: 'bumped' })).toEqual({ sendable: false })
        expect(await read(row.sessionBindingId, { credentialSubject: 'rotated-away' })).toEqual({ sendable: false })
        await prisma.mobileDeviceRegistration.update({ where: { id: row.id }, data: { revokedAt: new Date(), revokedReason: 'logout' } })
        expect(await read(row.sessionBindingId)).toEqual({ sendable: false })
    })

    it('14. a rejected-token clear is compare-and-set: a rotated token survives', async () => {
        const session = sessionFor(device('cas'))
        await register(session, { token: token('cas-1') })
        const row = await rowOf(device('cas'))
        await register(session, { token: token('cas-2') })
        expect(await markMobilePushTokenRejectedV1(row!.id, token('cas-1'))).toEqual({ result: 'already_rotated' })
        expect((await rowOf(device('cas')))!.fcmToken).toBe(token('cas-2'))
        expect(await markMobilePushTokenRejectedV1(row!.id, token('cas-2'))).toEqual({ result: 'cleared' })
        expect(await rowOf(device('cas'))).toMatchObject({ fcmToken: null, revokedAt: null })
        expect(await resolveTarget(row!.id, row!.sessionBindingId)).toEqual({ kind: 'await_token' })
    })

    // ── The logout barrier ──────────────────────────────────────────────────
    // A logged-out session must never be able to register again, however late
    // its request lands. The barrier is durable and per (device, session), so
    // a genuinely new login still may.

    it('A. an existing registration racing its own session logout never stays eligible', async () => {
        for (const round of [1, 2, 3, 4, 5]) {
            const id = device(`raceA-${round}`)
            const session = sessionFor(id)
            await register(session, { token: token(`raceA-${round}-first`) })
            const [registration] = await Promise.all([
                register(session, { token: token(`raceA-${round}-second`) }),
                logout(session),
            ])
            const row = (await rowOf(id))!
            expect(row.revokedAt, `round ${round} left an active row after logout`).not.toBeNull()
            expect(row.revokedReason).toBe('logout')
            expect(row.fcmToken).toBeNull()
            expect(await eligibleIds()).not.toContain(row.id)
            expect([200, 401]).toContain(registration.status)
        }
    })

    it('A2. a registration authorized before the logout is refused when it lands after it', async () => {
        // The request was proven by S1 before logout; only the write is late.
        const id = device('raceA2')
        const session = sessionFor(id)
        await register(session, { token: token('raceA2-first') })
        await logout(session)
        expect(await register(session, { token: token('raceA2-late') }))
            .toEqual({ status: 401, body: { error: 'MOBILE_SESSION_REVOKED' } })
        const row = (await rowOf(id))!
        expect(row).toMatchObject({ fcmToken: null, revokedReason: 'logout' })
        expect(row.revokedAt).not.toBeNull()
        expect(await eligibleIds()).not.toContain(row.id)
    })

    it('B. a logout for a device that never registered still blocks that session', async () => {
        for (const round of [1, 2, 3, 4, 5]) {
            const id = device(`raceB-${round}`)
            const session = sessionFor(id)
            const [registration] = await Promise.all([
                register(session, { token: token(`raceB-${round}`) }),
                logout(session),
            ])
            const row = await rowOf(id)
            expect(row, `round ${round} lost the tombstone`).not.toBeNull()
            expect(row!.revokedAt, `round ${round} left an active row after logout`).not.toBeNull()
            expect(row!.fcmToken).toBeNull()
            expect(await eligibleIds()).not.toContain(row!.id)
            expect([200, 401]).toContain(registration.status)
        }
    })

    it('B2. the logout tombstone refuses a later registration from the same session', async () => {
        const id = device('raceB2')
        const session = sessionFor(id)
        await logout(session)
        const tombstone = (await rowOf(id))!
        expect(tombstone).toMatchObject({ fcmToken: null, revokedReason: 'logout' })
        expect(await register(session, { token: token('raceB2') }))
            .toEqual({ status: 401, body: { error: 'MOBILE_SESSION_REVOKED' } })
        expect((await rowOf(id))!.id).toBe(tombstone.id)
        expect(await eligibleIds()).not.toContain(tombstone.id)
    })

    it('C. a genuinely new login for the same device registers again on the same row', async () => {
        const id = device('raceC')
        const first = sessionFor(id, 'u1', Date.now() - 120_000)
        await register(first, { token: token('raceC-1') })
        const before = (await rowOf(id))!
        await logout(first)
        const second = sessionFor(id, 'u1', Date.now())
        expect(await register(second, { token: token('raceC-2') })).toEqual({ status: 200, body: { ok: true } })
        const after = (await rowOf(id))!
        expect(after.id).toBe(before.id)
        expect(after).toMatchObject({ revokedAt: null, revokedReason: null, fcmToken: token('raceC-2') })
        expect(after.sessionBindingId).toBe(expectedBinding(second))
        expect(await eligibleIds()).toContain(after.id)
        // The first session stays barred for good.
        expect((await register(first, { token: token('raceC-1') })).status).toBe(401)
        expect(await eligibleIds()).toContain(after.id)
    })

    it('D. a token rotation inside one live session is untouched by the barrier', async () => {
        const id = device('raceD')
        const session = sessionFor(id)
        await register(session, { token: token('raceD-1') })
        const before = (await rowOf(id))!
        expect(await register(session, { token: token('raceD-2') })).toEqual({ status: 200, body: { ok: true } })
        const after = (await rowOf(id))!
        expect(after.id).toBe(before.id)
        expect(after).toMatchObject({ fcmToken: token('raceD-2'), revokedAt: null })
        expect(after.revokedSessionBindings).toEqual([])
        expect(await eligibleIds()).toContain(after.id)
    })

    it('25. a sender mismatch revokes exactly the registration that carried the rejected token', async () => {
        await register(sessionFor(device('sm-a')), { token: token('sm-a') })
        await register(sessionFor(device('sm-b')), { token: token('sm-b') })
        const a = await rowOf(device('sm-a'))
        expect(await revokeMobilePushSenderMismatchV1(a!.id, token('sm-b'))).toEqual({ result: 'already_rotated' })
        expect(await revokeMobilePushSenderMismatchV1(a!.id, token('sm-a'))).toEqual({ result: 'revoked' })
        expect(await rowOf(device('sm-a'))).toMatchObject({ fcmToken: null, revokedReason: 'sender_mismatch' })
        expect(await rowOf(device('sm-b'))).toMatchObject({ fcmToken: token('sm-b'), revokedAt: null })
    })
})
