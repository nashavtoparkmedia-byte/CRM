// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// Real scrypt runs many times per test; a loaded runner must not time out.
vi.setConfig({ testTimeout: 60_000 })

/**
 * Personal mobile sign-in (docs/design/mobile-personal-signin-v1.md).
 *
 * The employee's own Staff Session password, the real verifier and throttle,
 * the real v2 session, the BR-4 resolver and a real registry file run for
 * real. Stand-ins are limited to storage and request plumbing: the
 * StaffCredential store and the logout barrier are in memory, and
 * next/headers serves cookies and headers from maps.
 */

const fake = vi.hoisted(() => {
    interface Row {
        userId: string
        registryCreatedAt: string
        verifier: unknown
        sessionEpoch: number
        revokedAt: Date | null
    }
    const state = {
        rows: new Map<string, Row>(),
        events: [] as Array<{ userId: string, kind: string, actor: string, sid?: string | null }>,
        unreadable: false,
        barred: new Set<string>(),
    }
    const check = () => { if (state.unreadable) throw Object.assign(new Error('store down'), { name: 'PrismaClientInitializationError' }) }
    const clone = (row: Row | undefined) => (row === undefined ? null : { userId: row.userId, registryCreatedAt: row.registryCreatedAt, sessionEpoch: row.sessionEpoch, revokedAt: row.revokedAt })
    const view = {
        async find(userId: string) { check(); return clone(state.rows.get(userId)) },
        async bumpEpoch(userId: string) {
            check()
            const row = state.rows.get(userId)
            if (row === undefined) return null
            row.sessionEpoch += 1
            return clone(row)
        },
        async record(event: { userId: string, kind: string, actor: string, sid?: string | null }) { check(); state.events.push(event) },
    }
    const store = {
        findStatus: view.find,
        async findVerifier(userId: string) {
            check()
            const row = state.rows.get(userId)
            return row === undefined ? null : { status: clone(row), verifier: row.verifier }
        },
        async anyRow() { check(); return state.rows.size > 0 },
        async states() { check(); return [...state.rows.values()].map((row) => ({ userId: row.userId, revoked: row.revokedAt !== null })) },
        record: view.record,
        async locked<T>(work: (v: typeof view) => Promise<T>): Promise<T> { check(); return work(view) },
    }
    return { state, store }
})

vi.mock('@/modules/identity-access/internal/staff-credential-store', () => ({ prismaStaffCredentialStoreV1: fake.store }))
vi.mock('@/modules/identity-access/internal/mobile-session-barrier', () => ({
    prismaMobileSessionBarrierV1: { isBarred: async (deviceId: string, entry: string) => fake.state.barred.has(`${deviceId}|${entry}`) },
}))
vi.mock('@/modules/identity-access/application/mobile-push-registration-operations', () => ({
    revokeMobilePushDeviceForLogoutV1: async (input: { principal: { deviceId: string }, barrierEntry: string | null }) => {
        if (input.barrierEntry) fake.state.barred.add(`${input.principal.deviceId}|${input.barrierEntry}`)
        return { revoked: 1 }
    },
}))
vi.mock('@/lib/prisma', () => ({ prisma: {} }))

interface RecordedCookie { name: string, value: string, options: Record<string, unknown> }
const request = vi.hoisted(() => ({
    cookies: new Map<string, string>(),
    headers: new Map<string, string>(),
    set: [] as Array<{ name: string, value: string, options: Record<string, unknown> }>,
}))
vi.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => (request.cookies.has(name) ? { name, value: request.cookies.get(name)! } : undefined),
        set: (name: string, value: string, options: Record<string, unknown>) => {
            request.set.push({ name, value, options })
            if (value === '' || options?.maxAge === 0) request.cookies.delete(name)
            else request.cookies.set(name, value)
        },
        delete: (name: string) => { request.cookies.delete(name) },
    }),
    headers: async () => new Headers(Object.fromEntries(request.headers)),
}))

const credentials = await import('@/modules/identity-access/internal/staff-session-credentials')
const operations = await import('@/modules/identity-access/application/staff-session-operations')
const {
    clearMobileSessionV1,
    establishMobileSessionV1,
    getMobileSessionPrincipalV1,
    isMobileLaneConfigured,
} = await import('@/modules/identity-access/public/v1/mobile-session-auth')
const { resolveRequestOperatorV1 } = await import('@/modules/identity-access/public/v1/mobile-session-operator')
const { mobileSessionBindingIdV1 } = await import('@/modules/identity-access/public/v1/mobile-session-credentials')

const SECRET = 'staff-session-signing-key-for-tests-0123456789abcdef'
const MANAGER = { id: 'u1', firstName: 'Мария', lastName: 'Иванова', role: 'Менеджер', status: 'Активен', createdAt: '2026-03-24T00:00:00Z' }
const ADMIN = { id: 'u2', firstName: 'Александр', lastName: 'Сидоров', role: 'Администратор', status: 'Активен', createdAt: '2026-03-24T00:00:00Z' }
const DISABLED = { id: 'u9', firstName: 'Отключённый', lastName: 'Сотрудник', role: 'Менеджер', status: 'Отключен', createdAt: '2026-03-24T00:00:00Z' }
const MANAGER_PASSWORD = 'manager pass phrase 2026'
const ADMIN_PASSWORD = 'admin pass phrase 2026'
const SHARED = { MOBILE_ACCESS_USER: 'mobile-operator', MOBILE_ACCESS_PASS: 'correct horse battery staple' }
const DEVICE = 'a1b2c3d4e5f6a7b8'

let directory: string
let registryFile: string

function writeRegistry(records: unknown[]): void {
    writeFileSync(registryFile, JSON.stringify(records, null, 2))
}
function patchRegistry(id: string, patch: Record<string, unknown>): void {
    writeRegistry((JSON.parse(readFileSync(registryFile, 'utf8')) as Array<Record<string, unknown>>).map((r) => (r.id === id ? { ...r, ...patch } : r)))
}
async function seedCredential(userId: string, password: string, registryCreatedAt = '2026-03-24T00:00:00Z'): Promise<void> {
    const verifier = await credentials.createStaffPasswordVerifierV1(password)
    fake.state.rows.set(userId, { userId, registryCreatedAt, verifier, sessionEpoch: 0, revokedAt: null })
}
function lastCookie(name: string) {
    return [...request.set].reverse().find((entry) => entry.name === name)
}
function newRequest(cookies: Record<string, string> = {}): void {
    request.cookies.clear()
    request.set.length = 0
    for (const [name, value] of Object.entries(cookies)) request.cookies.set(name, value)
}
async function signIn(userId = 'u1', password = MANAGER_PASSWORD) {
    newRequest()
    const result = await establishMobileSessionV1(userId, password, DEVICE)
    const token = request.cookies.get('yoko_mobile_session')
    return { result, token }
}
/** The next request of the phone, carrying only its session cookie. */
async function phoneRequest(token: string) {
    newRequest({ yoko_mobile_session: token })
    return resolveRequestOperatorV1()
}

const consoleLines: string[] = []

beforeEach(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'mobile-signin-'))
    registryFile = path.join(directory, 'users.json')
    writeRegistry([MANAGER, ADMIN, DISABLED])
    vi.stubEnv('STAFF_SESSION_SECRET', SECRET)
    vi.stubEnv('YOKO_USER_REGISTRY_FILE', registryFile)
    vi.stubEnv('MOBILE_ACCESS_USER', '')
    vi.stubEnv('MOBILE_ACCESS_PASS', '')
    fake.state.rows.clear()
    fake.state.events.length = 0
    fake.state.unreadable = false
    fake.state.barred.clear()
    request.headers.clear()
    request.headers.set('x-real-ip', '203.0.113.7')
    operations.resetStaffLoginThrottleForTestsV1()
    await seedCredential('u1', MANAGER_PASSWORD)
    await seedCredential('u2', ADMIN_PASSWORD)
    await seedCredential('u9', MANAGER_PASSWORD)
    consoleLines.length = 0
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')) })
    }
})

afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
})

describe('the mobile sign-in is the employee\'s own password', () => {
    test('configured only when the staff lane is ready; the shared credential configures nothing', async () => {
        expect(await isMobileLaneConfigured()).toBe(true)
        vi.stubEnv('STAFF_SESSION_SECRET', '')
        vi.stubEnv('MOBILE_ACCESS_USER', SHARED.MOBILE_ACCESS_USER)
        vi.stubEnv('MOBILE_ACCESS_PASS', SHARED.MOBILE_ACCESS_PASS)
        expect(await isMobileLaneConfigured()).toBe(false)
        // No fallback: a staff lane that is not ready answers unavailable, whatever MOBILE_ACCESS_* says.
        newRequest()
        expect(await establishMobileSessionV1('u1', SHARED.MOBILE_ACCESS_PASS, DEVICE)).toEqual({ ok: false, reason: 'unavailable' })
        expect(request.set).toHaveLength(0)
    })

    test('the own password signs in as that employee, bound to their credential epoch', async () => {
        fake.state.rows.get('u1')!.sessionEpoch = 5
        const { result, token } = await signIn()
        expect(result.ok).toBe(true)
        expect(lastCookie('yoko_mobile_session')?.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 12 * 60 * 60 })
        expect(lastCookie('crm_user_id')?.value).toBe('u1')
        const principal = await getMobileSessionPrincipalV1()
        expect(principal).toMatchObject({ runtimeOperatorId: 'u1', staffEpoch: 5, credentialSubject: 'staff-v2:5', deviceId: DEVICE })
        expect(await phoneRequest(token!)).toEqual({ kind: 'mobile_session', operatorId: 'u1' })
    })

    test('audit: kind login with actor mobile:<id> and the labelled sid, never the token; the browser keeps staff:<id>', async () => {
        const { token } = await signIn()
        const principal = await getMobileSessionPrincipalV1()
        const login = fake.state.events.filter((event) => event.kind === 'login')
        expect(login).toEqual([{ userId: 'u1', kind: 'login', actor: 'mobile:u1', sid: mobileSessionBindingIdV1(principal!) }])
        expect(login[0].sid).toMatch(/^[0-9a-f]{64}$/)
        expect(JSON.stringify(fake.state.events)).not.toContain(token!)
        const browser = await operations.staffLoginV1({ userId: 'u2', password: ADMIN_PASSWORD, source: null })
        expect(browser.ok).toBe(true)
        expect(fake.state.events.filter((event) => event.kind === 'login').map((event) => event.actor)).toEqual(['mobile:u1', 'staff:u2'])
    })

    test('every credential failure is the same refusal, with no cookie and no login record', async () => {
        for (const [userId, password] of [
            ['u1', 'wrong password value'],
            ['u404', MANAGER_PASSWORD],
            ['u9', MANAGER_PASSWORD],
            ['u1', ''],
            ['../u1', MANAGER_PASSWORD],
            [42, MANAGER_PASSWORD],
        ] as Array<[unknown, string]>) {
            operations.resetStaffLoginThrottleForTestsV1()
            newRequest()
            expect(await establishMobileSessionV1(userId, password, DEVICE), String(userId)).toEqual({ ok: false, reason: 'refused' })
            expect(request.set).toHaveLength(0)
        }
        fake.state.rows.delete('u1')
        newRequest()
        expect(await establishMobileSessionV1('u1', MANAGER_PASSWORD, DEVICE)).toEqual({ ok: false, reason: 'refused' })
        expect(fake.state.events.filter((event) => event.kind === 'login')).toEqual([])
    })

    test('the chosen employee is only the id the password is checked against: another employee\'s password is refused', async () => {
        newRequest()
        expect(await establishMobileSessionV1('u1', ADMIN_PASSWORD, DEVICE)).toEqual({ ok: false, reason: 'refused' })
        newRequest()
        expect(await establishMobileSessionV1('u2', MANAGER_PASSWORD, DEVICE)).toEqual({ ok: false, reason: 'refused' })
    })

    test('the shared MOBILE_ACCESS password is refused, also while it is still set', async () => {
        vi.stubEnv('MOBILE_ACCESS_USER', SHARED.MOBILE_ACCESS_USER)
        vi.stubEnv('MOBILE_ACCESS_PASS', SHARED.MOBILE_ACCESS_PASS)
        for (const userId of ['u1', 'u2', SHARED.MOBILE_ACCESS_USER]) {
            newRequest()
            expect(await establishMobileSessionV1(userId, SHARED.MOBILE_ACCESS_PASS, DEVICE)).toEqual({ ok: false, reason: 'refused' })
        }
    })

    test('the throttle applies, and it is shared with the browser sign-in', async () => {
        let throttled = false
        for (let attempt = 0; attempt < 8 && !throttled; attempt += 1) {
            newRequest()
            const result = await establishMobileSessionV1('u1', 'wrong password value', DEVICE)
            throttled = !result.ok && result.reason === 'throttled'
        }
        expect(throttled).toBe(true)
        // The right password is throttled too, in either lane.
        newRequest()
        expect(await establishMobileSessionV1('u1', MANAGER_PASSWORD, DEVICE)).toEqual({ ok: false, reason: 'throttled' })
        expect(await operations.staffLoginV1({ userId: 'u1', password: MANAGER_PASSWORD, source: '203.0.113.7' })).toEqual({ ok: false, reason: 'throttled' })
    })

    test('a bad device id is refused first; a second sign-in on a live session is refused', async () => {
        newRequest()
        expect(await establishMobileSessionV1('u1', MANAGER_PASSWORD, 'a b c')).toEqual({ ok: false, reason: 'invalid_device' })
        newRequest()
        expect(await establishMobileSessionV1('u1', MANAGER_PASSWORD, 'ephemeral-device')).toEqual({ ok: false, reason: 'invalid_device' })
        const { token } = await signIn()
        newRequest({ yoko_mobile_session: token! })
        expect(await establishMobileSessionV1('u2', ADMIN_PASSWORD, DEVICE)).toEqual({ ok: false, reason: 'session_active' })
    })

    test('no password, and no password field, in any log line', async () => {
        await signIn('u1', 'wrong password value')
        for (let attempt = 0; attempt < 6; attempt += 1) await signIn('u1', 'another wrong one 123')
        fake.state.unreadable = true
        await signIn()
        fake.state.unreadable = false
        await signIn()
        const logged = consoleLines.join('\n')
        expect(consoleLines.length).toBeGreaterThan(0)
        for (const forbidden of ['wrong password value', 'another wrong one 123', MANAGER_PASSWORD, 'password=', '"password"']) {
            expect(logged).not.toContain(forbidden)
        }
    })
})

describe('the phone session follows the employee, on its next request', () => {
    test.each([
        ['disabled in the registry', () => patchRegistry('u1', { status: 'Отключен' })],
        ['re-created (createdAt changed)', () => patchRegistry('u1', { createdAt: '2026-11-11T00:00:00Z' })],
        ['removed from the registry', () => writeRegistry([ADMIN, DISABLED])],
        ['password reset (epoch bump)', () => { fake.state.rows.get('u1')!.sessionEpoch += 1 }],
        ['credential revoked', () => { fake.state.rows.get('u1')!.revokedAt = new Date() }],
    ])('ends when the employee is %s, however long the phone was offline', async (_name, change) => {
        const { token } = await signIn()
        expect(await phoneRequest(token!)).toEqual({ kind: 'mobile_session', operatorId: 'u1' })
        change()
        vi.useFakeTimers({ now: Date.now() + 6 * 60 * 60 * 1000 })
        try {
            expect(await phoneRequest(token!)).toEqual({ kind: 'mobile_session_refused' })
        } finally {
            vi.useRealTimers()
        }
    })

    test('a browser logout of the same employee ends the phone session', async () => {
        const { token } = await signIn()
        const browser = await operations.staffLoginV1({ userId: 'u1', password: MANAGER_PASSWORD, source: null })
        expect(browser.ok).toBe(true)
        expect(await operations.staffLogoutV1(browser.ok ? browser.token : undefined)).toBe('ended')
        expect(await phoneRequest(token!)).toEqual({ kind: 'mobile_session_refused' })
    })

    test('an unreadable store is unverifiable (503 in the shell lane), never live', async () => {
        const { token } = await signIn()
        fake.state.unreadable = true
        expect(await phoneRequest(token!)).toEqual({ kind: 'mobile_session_refused', unverifiable: true })
    })

    test('a demote between two requests: the session stays and the next read sees the lower role', async () => {
        const { token } = await signIn('u2', ADMIN_PASSWORD)
        expect(await phoneRequest(token!)).toEqual({ kind: 'mobile_session', operatorId: 'u2' })
        patchRegistry('u2', { role: 'Менеджер' })
        expect(await phoneRequest(token!)).toEqual({ kind: 'mobile_session', operatorId: 'u2' })
        const roles = (await operations.readRegistryForDisplayV1()).filter((record) => record.id === 'u2').map((record) => record.role)
        expect(roles).toEqual(['Менеджер'])
    })

    test('a phone logout ends only that phone: the desktop session stays, and the logout is audited as mobile', async () => {
        const browser = await operations.staffLoginV1({ userId: 'u1', password: MANAGER_PASSWORD, source: null })
        expect(browser.ok).toBe(true)
        const { token } = await signIn()
        newRequest({ yoko_mobile_session: token! })
        await clearMobileSessionV1()
        expect(await phoneRequest(token!)).toEqual({ kind: 'mobile_session_refused' })
        expect((await operations.verifyStaffSessionTokenV1(browser.ok ? browser.token : undefined)).kind).toBe('valid')
        expect(fake.state.events.filter((event) => event.kind === 'logout')).toEqual([
            { userId: 'u1', kind: 'logout', actor: 'mobile:u1', sid: expect.stringMatching(/^[0-9a-f]{64}$/) },
        ])
    })
})
