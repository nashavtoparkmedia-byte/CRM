// @vitest-environment node
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// Real scrypt (64 MiB, ~100 ms each) runs many times per test; a loaded CI
// runner must not turn that into a timeout.
vi.setConfig({ testTimeout: 60_000 })

/**
 * Staff Session v1 (docs/design/staff-session-v1.md v1.3): the credential
 * primitives, the composition against a real registry file and an in-memory
 * credential store, the BR-4 resolution, the proxy and the user-management
 * guard. PostgreSQL concurrency is proven separately in
 * src/modules/identity-access/internal/staff-credential-store.postgres.test.ts.
 */

// ── An in-memory StaffCredential store with the real store's surface ─────
const fake = vi.hoisted(() => {
    interface Row {
        userId: string
        registryCreatedAt: string
        verifier: { algo: 'scrypt', n: number, r: number, p: number, maxmemBytes: number, salt: Buffer, hash: Buffer }
        sessionEpoch: number
        revokedAt: Date | null
    }
    const state = {
        rows: new Map<string, Row>(),
        events: [] as Array<{ userId: string, kind: string, actor: string, sid?: string | null }>,
        unreadable: false,
        chain: Promise.resolve() as Promise<unknown>,
    }
    const check = () => { if (state.unreadable) throw Object.assign(new Error('store down'), { name: 'PrismaClientInitializationError' }) }
    const clone = (row: Row | undefined) => (row === undefined ? null : { ...row })
    const view = {
        async find(userId: string) { check(); return clone(state.rows.get(userId)) },
        async liveUserIds() { check(); return new Set([...state.rows.values()].filter((row) => row.revokedAt === null).map((row) => row.userId)) },
        async upsertVerifier(input: { userId: string, registryCreatedAt: string, verifier: Row['verifier'] }) {
            check()
            const existing = state.rows.get(input.userId)
            const row: Row = {
                userId: input.userId,
                registryCreatedAt: input.registryCreatedAt,
                verifier: input.verifier,
                sessionEpoch: existing === undefined ? 0 : existing.sessionEpoch + 1,
                revokedAt: null,
            }
            state.rows.set(input.userId, row)
            return { ...row }
        },
        async bumpEpoch(userId: string) {
            check()
            const row = state.rows.get(userId)
            if (row === undefined) return null
            row.sessionEpoch += 1
            return { ...row }
        },
        async revoke(userId: string, _actor: string, now: Date) {
            check()
            const row = state.rows.get(userId)
            if (row === undefined) return null
            row.revokedAt ??= now
            row.sessionEpoch += 1
            return { ...row }
        },
        async record(event: { userId: string, kind: string, actor: string, sid?: string | null }) { check(); state.events.push(event) },
    }
    const store = {
        findStatus: view.find,
        async findVerifier(userId: string) {
            check()
            const row = state.rows.get(userId)
            return row === undefined ? null : { status: { ...row }, verifier: row.verifier }
        },
        async anyRow() { check(); return state.rows.size > 0 },
        async states() { check(); return [...state.rows.values()].map((row) => ({ userId: row.userId, revoked: row.revokedAt !== null })) },
        record: view.record,
        async locked<T>(work: (v: typeof view) => Promise<T>): Promise<T> {
            check()
            const run = state.chain.then(() => work(view))
            state.chain = run.catch(() => undefined)
            return run
        },
    }
    return { state, store }
})
vi.mock('@/modules/identity-access/internal/staff-credential-store', () => ({ prismaStaffCredentialStoreV1: fake.store }))
vi.mock('@/modules/identity-access/internal/mobile-session-barrier', () => ({
    prismaMobileSessionBarrierV1: { isBarred: async () => false },
}))

// ── The request: cookies and headers as next/headers would hand them over ─
const request = vi.hoisted(() => ({ cookies: new Map<string, string>(), headers: new Map<string, string>(), set: [] as Array<{ name: string, value: string, options: Record<string, unknown> }> }))
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
    headers: async () => new Headers({ 'x-real-ip': '203.0.113.7', ...Object.fromEntries(request.headers) }),
}))

const credentials = await import('@/modules/identity-access/internal/staff-session-credentials')
const operations = await import('@/modules/identity-access/application/staff-session-operations')
const publicSurface = await import('@/modules/identity-access/public/v1/staff-session')
const { resolveCookieOperatorV1 } = await import('@/modules/identity-access/public/v1/mobile-session-operator')
const { issueMobileSession, MOBILE_SESSION_COOKIE } = await import('@/modules/identity-access/public/v1/mobile-session-credentials')
const { issueIntegrationAdminSession } = await import('@/modules/identity-access/public/v1/integration-admin-credentials')
const userService = await import('@/lib/users/user-service')
const { NextRequest } = await import('next/server')
const { proxy } = await import('@/proxy')

const SECRET = 'staff-session-signing-key-for-tests-0123456789abcdef'
const ADMIN = { id: 'u2', firstName: 'Александр', lastName: 'Сидоров', role: 'Администратор', status: 'Активен', createdAt: '2026-03-24T00:00:00Z' }
const MANAGER = { id: 'u1', firstName: 'Мария', lastName: 'Иванова', role: 'Менеджер', status: 'Активен', createdAt: '2026-03-24T00:00:00Z' }
const LEAD = { id: 'u3', firstName: 'Александр', lastName: 'Ремезов', role: 'Руководитель', status: 'Активен', createdAt: '2026-03-24T00:00:00Z' }
const ADMIN_PASSWORD = 'admin pass phrase 2026'
const MANAGER_PASSWORD = 'manager pass phrase 2026'

let directory: string
let registryFile: string

function writeRegistry(records: unknown[]): void {
    writeFileSync(registryFile, JSON.stringify(records, null, 2))
}
function readRegistry(): Array<Record<string, unknown>> {
    return JSON.parse(readFileSync(registryFile, 'utf8'))
}

function configureLane(extra: Record<string, string | undefined> = {}): void {
    vi.stubEnv('STAFF_SESSION_SECRET', SECRET)
    vi.stubEnv('YOKO_USER_REGISTRY_FILE', registryFile)
    for (const [name, value] of Object.entries(extra)) vi.stubEnv(name, value as string)
}

async function seedCredential(userId: string, password: string, registryCreatedAt = '2026-03-24T00:00:00Z'): Promise<void> {
    const verifier = await credentials.createStaffPasswordVerifierV1(password)
    fake.state.rows.set(userId, { userId, registryCreatedAt, verifier, sessionEpoch: 0, revokedAt: null })
}

async function loginToken(userId: string, password: string): Promise<string> {
    const result = await operations.staffLoginV1({ userId, password, source: null })
    if (!result.ok) throw new Error(`login refused: ${result.reason}`)
    return result.token
}

function asRequest(cookies: Record<string, string>): void {
    request.cookies.clear()
    for (const [name, value] of Object.entries(cookies)) request.cookies.set(name, value)
}

beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'staff-session-'))
    registryFile = path.join(directory, 'users.json')
    writeRegistry([MANAGER, ADMIN, LEAD])
    fake.state.rows.clear()
    fake.state.events.length = 0
    fake.state.unreadable = false
    request.cookies.clear()
    request.headers.clear()
    request.set.length = 0
    operations.resetStaffLoginThrottleForTestsV1()
    for (const name of ['STAFF_SESSION_SECRET', 'YOKO_USER_REGISTRY_FILE', 'YOKO_USER_REGISTRY_SEED', 'YOKO_STAFF_SESSION_ENFORCE', 'STAFF_SESSION_REVOCATION_EPOCH', 'ADMIN_USER', 'ADMIN_PASS', 'MOBILE_ACCESS_USER', 'MOBILE_ACCESS_PASS', 'BOT_CRM_SECRET']) {
        vi.stubEnv(name, undefined as unknown as string)
    }
})

afterEach(() => {
    vi.unstubAllEnvs()
    try { chmodSync(directory, 0o700) } catch { /* already gone */ }
    rmSync(directory, { recursive: true, force: true })
})

// ── Primitives ─────────────────────────────────────────────────────────────

describe('staff session primitives', () => {
    test('one secret-validity predicate: absent, short, placeholder or another lane\'s value is no lane (C-D4b)', () => {
        expect(credentials.isStaffSessionSecretValidV1({})).toBe(false)
        expect(credentials.isStaffSessionSecretValidV1({ STAFF_SESSION_SECRET: 'short' })).toBe(false)
        expect(credentials.isStaffSessionSecretValidV1({ STAFF_SESSION_SECRET: 'replace-me-with-a-long-random-value-0000000' })).toBe(false)
        expect(credentials.isStaffSessionSecretValidV1({ STAFF_SESSION_SECRET: ` ${SECRET}` })).toBe(false)
        for (const other of ['ADMIN_PASS', 'MOBILE_ACCESS_PASS', 'BOT_CRM_SECRET'] as const) {
            expect(credentials.isStaffSessionSecretValidV1({ STAFF_SESSION_SECRET: SECRET, [other]: SECRET })).toBe(false)
        }
        expect(credentials.isStaffSessionSecretValidV1({ STAFF_SESSION_SECRET: SECRET, ADMIN_PASS: 'something else entirely' })).toBe(true)
    })

    test('tokens verify only untampered, unexpired, current-epoch and from this key', () => {
        const env = { STAFF_SESSION_SECRET: SECRET }
        const now = Date.UTC(2026, 10, 8, 12)
        const token = credentials.issueStaffSessionTokenV1({ userId: 'u1', userEpoch: 3 }, env, now)!
        const claims = credentials.readStaffSessionTokenV1(token, env, now)!
        expect(claims).toMatchObject({ userId: 'u1', userEpoch: 3, issuedAtSeconds: now / 1000 })
        expect(claims.sessionInstanceId).toMatch(/^[A-Za-z0-9_-]{22}$/)
        const [payload, signature] = token.split('.')
        expect(credentials.readStaffSessionTokenV1(`${payload.slice(0, -2)}AA.${signature}`, env, now)).toBeNull()
        expect(credentials.readStaffSessionTokenV1(`${payload}.${signature.slice(0, -2)}AA`, env, now)).toBeNull()
        expect(credentials.readStaffSessionTokenV1(token, env, now + credentials.STAFF_SESSION_TTL_SECONDS * 1000)).toBeNull()
        expect(credentials.readStaffSessionTokenV1(token, { ...env, STAFF_SESSION_REVOCATION_EPOCH: '1' }, now)).toBeNull()
        expect(credentials.readStaffSessionTokenV1(token, { STAFF_SESSION_SECRET: `${SECRET}-rotated` }, now)).toBeNull()
        expect(credentials.readStaffSessionTokenV1(token, {}, now)).toBeNull()
    })

    test('a correctly signed token with the wrong version, audience, TTL or sid is refused', () => {
        const env = { STAFF_SESSION_SECRET: SECRET }
        const now = Date.UTC(2026, 10, 8, 12)
        const forge = (patch: Record<string, unknown>) => {
            const iat = now / 1000
            const body = { v: 1, aud: 'yoko-staff-session', sub: 'u1', iat, exp: iat + 43200, epoch: '0', uepoch: 0, sid: 'A'.repeat(22), ...patch }
            const encoded = Buffer.from(JSON.stringify(body)).toString('base64url')
            const key = createHmac('sha256', SECRET).update('yoko.identity-access.staff-session-key.v1').digest()
            return `${encoded}.${createHmac('sha256', key).update(`yoko-staff-session\0${encoded}`).digest('base64url')}`
        }
        expect(credentials.readStaffSessionTokenV1(forge({}), env, now)).not.toBeNull()
        for (const patch of [{ v: 2 }, { aud: 'yoko-gravity-mobile-shell' }, { exp: now / 1000 + 99999 }, { sid: 'short' }, { sid: undefined }, { sub: '../u2' }, { uepoch: -1 }, { epoch: '7' }]) {
            expect(credentials.readStaffSessionTokenV1(forge(patch), env, now), JSON.stringify(patch)).toBeNull()
        }
    })

    test('mobile and integration-admin tokens never verify as staff tokens', () => {
        const env = { STAFF_SESSION_SECRET: SECRET, MOBILE_ACCESS_USER: 'mobile-operator', MOBILE_ACCESS_PASS: SECRET.slice(0, 30), ADMIN_USER: 'admin', ADMIN_PASS: SECRET.slice(0, 31) }
        expect(credentials.readStaffSessionTokenV1(issueMobileSession('u1', 'a1b2c3d4e5f6a7b8', env), env)).toBeNull()
        expect(credentials.readStaffSessionTokenV1(issueIntegrationAdminSession(env), env)).toBeNull()
    })

    test('sid is a labelled digest of the instance id, never the raw id or a token digest', () => {
        const env = { STAFF_SESSION_SECRET: SECRET }
        const token = credentials.issueStaffSessionTokenV1({ userId: 'u1', userEpoch: 0 }, env)!
        const instance = credentials.readStaffSessionTokenV1(token, env)!.sessionInstanceId
        const sid = credentials.staffSessionIdV1(instance)!
        expect(sid).toBe(createHash('sha256').update(`yoko.identity-access.staff-session-id.v1\0${instance}`).digest('hex'))
        expect(sid).not.toContain(instance)
        expect(sid).not.toBe(createHash('sha256').update(token).digest('hex'))
    })

    test('password rules and constant-work verification', async () => {
        expect(credentials.staffPasswordRefusalV1('short')).toBe('password_too_short')
        expect(credentials.staffPasswordRefusalV1('x'.repeat(257))).toBe('password_too_long')
        expect(credentials.staffPasswordRefusalV1('1234567890')).toBe('password_too_common')
        expect(credentials.staffPasswordRefusalV1('aaaaaaaaaaaa')).toBe('password_too_common')
        expect(credentials.staffPasswordRefusalV1(MANAGER_PASSWORD)).toBeNull()
        const verifier = await credentials.createStaffPasswordVerifierV1(MANAGER_PASSWORD)
        expect(verifier.salt).toHaveLength(16)
        expect(verifier.hash).toHaveLength(64)
        expect(await credentials.verifyStaffPasswordV1(MANAGER_PASSWORD, verifier)).toBe(true)
        expect(await credentials.verifyStaffPasswordV1('another pass phrase', verifier)).toBe(false)
        expect(await credentials.verifyStaffPasswordV1(MANAGER_PASSWORD, null)).toBe(false)
        expect(await credentials.verifyStaffPasswordV1(MANAGER_PASSWORD, { ...verifier, n: 1024 })).toBe(false)
        expect(await credentials.verifyStaffPasswordV1(undefined, verifier)).toBe(false)
    })
})

// ── Lane state and the registry file (D3, C-D3a, I-1) ──────────────────────

describe('lane state and registry storage', () => {
    test('dormant without a valid secret: no password login, and the registry is today\'s', async () => {
        expect(await operations.staffLaneStateV1()).toEqual({ kind: 'dormant' })
        expect(await operations.staffLoginModeV1()).toBe('legacy')
        expect((await operations.staffLoginV1({ userId: 'u1', password: MANAGER_PASSWORD, source: null })).ok).toBe(false)
    })

    test('a configured lane without YOKO_USER_REGISTRY_FILE, or with a missing file, refuses instead of seeding', async () => {
        vi.stubEnv('STAFF_SESSION_SECRET', SECRET)
        expect(await operations.staffLaneStateV1()).toEqual({ kind: 'refused', reason: 'registry_file_unset' })
        vi.stubEnv('YOKO_USER_REGISTRY_FILE', path.join(directory, 'missing.json'))
        expect(await operations.staffLaneStateV1()).toEqual({ kind: 'refused', reason: 'registry_file_missing' })
        expect(existsSync(path.join(directory, 'missing.json'))).toBe(false)
        expect(await operations.staffLoginModeV1()).toBe('unavailable')
    })

    test('YOKO_USER_REGISTRY_SEED=once seeds only while no credential row exists (I-1)', async () => {
        const target = path.join(directory, 'seeded', 'users.json')
        vi.stubEnv('STAFF_SESSION_SECRET', SECRET)
        vi.stubEnv('YOKO_USER_REGISTRY_FILE', target)
        vi.stubEnv('YOKO_USER_REGISTRY_SEED', 'once')
        await seedCredential('u2', ADMIN_PASSWORD)
        expect(await operations.staffLaneStateV1()).toEqual({ kind: 'refused', reason: 'registry_seed_refused' })
        expect(existsSync(target)).toBe(false)
        fake.state.rows.clear()
        expect(await operations.staffLaneStateV1()).toEqual({ kind: 'ready', registryPath: target })
        expect(JSON.parse(readFileSync(target, 'utf8')).map((user: { id: string }) => user.id)).toEqual(['u1', 'u2', 'u3'])
    })

    test('dormant with a named file seeds it once from the image and never overwrites it', async () => {
        const target = path.join(directory, 'dormant.json')
        vi.stubEnv('YOKO_USER_REGISTRY_FILE', target)
        expect(await operations.registryPathForReadV1()).toBe(target)
        writeFileSync(target, JSON.stringify([LEAD]))
        expect(await operations.registryPathForReadV1()).toBe(target)
        expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual([LEAD])
    })
})

// ── Login, verification, logout ────────────────────────────────────────────

describe('login and verification', () => {
    test('a manager signs in once; the principal is the registry\'s employee and role', async () => {
        configureLane()
        await seedCredential('u1', MANAGER_PASSWORD)
        const token = await loginToken('u1', MANAGER_PASSWORD)
        const verified = await operations.verifyStaffSessionTokenV1(token)
        expect(verified.kind).toBe('valid')
        if (verified.kind !== 'valid') return
        expect(verified.principal).toMatchObject({ kind: 'staff_session', userId: 'u1', role: 'Менеджер' })
        expect(verified.principal.sid).toMatch(/^[0-9a-f]{64}$/)
        expect(verified.principal.expiresAt.getTime() - verified.principal.issuedAt.getTime()).toBe(12 * 3600 * 1000)
        expect(fake.state.events.at(-1)).toMatchObject({ userId: 'u1', kind: 'login', sid: verified.principal.sid })
    })

    test('every credential failure is the same refusal: wrong password, unknown, disabled, revoked, re-created id, no credential', async () => {
        configureLane()
        await seedCredential('u1', MANAGER_PASSWORD)
        await seedCredential('u3', MANAGER_PASSWORD, '2025-01-01T00:00:00Z')
        await seedCredential('u2', ADMIN_PASSWORD)
        fake.state.rows.get('u2')!.revokedAt = new Date()
        writeRegistry([MANAGER, { ...ADMIN }, LEAD, { ...MANAGER, id: 'u4', status: 'Отключен' }])
        await seedCredential('u4', MANAGER_PASSWORD)
        const attempts: Array<[string, string]> = [
            ['u1', 'wrong pass phrase 2026'],
            ['nobody', MANAGER_PASSWORD],
            ['u4', MANAGER_PASSWORD],
            ['u2', ADMIN_PASSWORD],
            ['u3', MANAGER_PASSWORD],
        ]
        for (const [userId, password] of attempts) {
            expect(await operations.staffLoginV1({ userId, password, source: null }), userId).toEqual({ ok: false, reason: 'refused' })
        }
        writeRegistry([MANAGER, ADMIN, LEAD, { ...MANAGER, id: 'u5' }])
        expect(await operations.staffLoginV1({ userId: 'u5', password: MANAGER_PASSWORD, source: null })).toEqual({ ok: false, reason: 'refused' })
    })

    test('repeated failures back off per employee and per source', async () => {
        configureLane()
        await seedCredential('u1', MANAGER_PASSWORD)
        for (let attempt = 0; attempt < 3; attempt++) {
            expect((await operations.staffLoginV1({ userId: 'u1', password: 'wrong pass phrase 2026', source: '198.51.100.1' })).ok).toBe(false)
        }
        expect(await operations.staffLoginV1({ userId: 'u1', password: MANAGER_PASSWORD, source: '198.51.100.2' })).toEqual({ ok: false, reason: 'throttled' })
        expect(await operations.staffLoginV1({ userId: 'u3', password: MANAGER_PASSWORD, source: '198.51.100.1' })).toEqual({ ok: false, reason: 'throttled' })
    })

    test('the role is read from the registry at every verification; disabling there ends the session', async () => {
        configureLane()
        await seedCredential('u1', MANAGER_PASSWORD)
        const token = await loginToken('u1', MANAGER_PASSWORD)
        writeRegistry([{ ...MANAGER, role: 'Руководитель' }, ADMIN, LEAD])
        const promoted = await operations.verifyStaffSessionTokenV1(token)
        expect(promoted.kind === 'valid' && promoted.principal.role).toBe('Руководитель')
        writeRegistry([{ ...MANAGER, status: 'Отключен' }, ADMIN, LEAD])
        expect((await operations.verifyStaffSessionTokenV1(token)).kind).toBe('refused')
    })

    test('an unreadable credential store or registry is unverifiable, never a logout (R3, C-D1a)', async () => {
        configureLane()
        await seedCredential('u1', MANAGER_PASSWORD)
        const token = await loginToken('u1', MANAGER_PASSWORD)
        fake.state.unreadable = true
        expect((await operations.verifyStaffSessionTokenV1(token)).kind).toBe('unverifiable')
        fake.state.unreadable = false
        writeFileSync(registryFile, '[{"id":"u1",')
        expect((await operations.verifyStaffSessionTokenV1(token)).kind).toBe('unverifiable')
        rmSync(registryFile)
        expect((await operations.verifyStaffSessionTokenV1(token)).kind).toBe('unverifiable')
    })

    test('logout ends every session of the employee server-side', async () => {
        configureLane()
        await seedCredential('u1', MANAGER_PASSWORD)
        const first = await loginToken('u1', MANAGER_PASSWORD)
        const second = await loginToken('u1', MANAGER_PASSWORD)
        expect(await operations.staffLogoutV1(first)).toBe('ended')
        expect((await operations.verifyStaffSessionTokenV1(first)).kind).toBe('refused')
        expect((await operations.verifyStaffSessionTokenV1(second)).kind).toBe('refused')
        expect(fake.state.events.at(-1)).toMatchObject({ kind: 'logout', userId: 'u1' })
    })

    test('the public principal: cookie only, never with a mobile session, never from crm_user_id', async () => {
        configureLane()
        await seedCredential('u1', MANAGER_PASSWORD)
        const token = await loginToken('u1', MANAGER_PASSWORD)
        asRequest({ ['__Host-yoko_staff_session']: token, crm_user_id: 'u2' })
        expect(await publicSurface.getStaffSessionPrincipalV1()).toMatchObject({ kind: 'staff_session', userId: 'u1', role: 'Менеджер' })
        asRequest({ crm_user_id: 'u2' })
        expect(await publicSurface.getStaffSessionPrincipalV1()).toBeNull()
        asRequest({ ['__Host-yoko_staff_session']: token, [MOBILE_SESSION_COOKIE]: 'anything' })
        expect(await publicSurface.getStaffSessionPrincipalV1()).toBeNull()
        asRequest({ crm_user_id: token })
        expect(await publicSurface.getStaffSessionPrincipalV1()).toBeNull()
    })

    test('the Android shell lane never yields a staff principal or a staff login (N3)', async () => {
        configureLane()
        await seedCredential('u1', MANAGER_PASSWORD)
        const token = await loginToken('u1', MANAGER_PASSWORD)
        asRequest({ '__Host-yoko_staff_session': token })
        expect(await publicSurface.getStaffSessionPrincipalV1()).not.toBeNull()
        request.headers.set('user-agent', 'Mozilla/5.0 (Linux; Android 14) YokoShell/1')
        expect(await publicSurface.getStaffSessionPrincipalV1()).toBeNull()
        asRequest({})
        expect(await publicSurface.establishStaffSessionV1('u1', MANAGER_PASSWORD)).toEqual({ ok: false, reason: 'unavailable' })
        expect(request.set.some((entry) => entry.name === '__Host-yoko_staff_session')).toBe(false)
    })

    test('a duplicated registry id is absent for verification and login (N2)', async () => {
        configureLane()
        await seedCredential('u1', MANAGER_PASSWORD)
        const token = await loginToken('u1', MANAGER_PASSWORD)
        writeRegistry([MANAGER, ADMIN, LEAD, { ...MANAGER, firstName: 'Двойник' }])
        expect((await operations.verifyStaffSessionTokenV1(token)).kind).toBe('refused')
        expect(await operations.staffLoginV1({ userId: 'u1', password: MANAGER_PASSWORD, source: null })).toEqual({ ok: false, reason: 'refused' })
    })

    test('establishing a session sets the __Host- cookie hardened and derives crm_user_id', async () => {
        configureLane()
        await seedCredential('u1', MANAGER_PASSWORD)
        asRequest({})
        expect(await publicSurface.establishStaffSessionV1('u1', MANAGER_PASSWORD)).toEqual({ ok: true })
        const staff = request.set.find((entry) => entry.name === '__Host-yoko_staff_session')!
        expect(staff.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
        expect(staff.options).not.toHaveProperty('domain')
        expect(request.cookies.get('crm_user_id')).toBe('u1')
        expect(await publicSurface.endStaffSessionV1()).toBe('ended')
        expect(request.cookies.has('__Host-yoko_staff_session')).toBe(false)
        expect(request.cookies.has('crm_user_id')).toBe(false)
    })
})

// ── Credential administration (R2, C-D2a, C-D2b) ───────────────────────────

describe('credential administration', () => {
    test('bootstrap: the integration-admin session sets a first credential for an Администратор, once', async () => {
        configureLane()
        const actor = { kind: 'integration_admin' as const }
        expect(await operations.setStaffPasswordV1({ actor, targetUserId: 'u1', newPassword: MANAGER_PASSWORD })).toEqual({ ok: false, reason: 'forbidden' })
        expect(await operations.setStaffPasswordV1({ actor, targetUserId: 'u2', newPassword: ADMIN_PASSWORD })).toEqual({ ok: true })
        expect(fake.state.events.at(-1)).toMatchObject({ userId: 'u2', kind: 'password_set', actor: 'integration-admin' })
        // Never a reset, and the window closes once an Администратор holds a live credential.
        expect(await operations.setStaffPasswordV1({ actor, targetUserId: 'u2', newPassword: 'another admin phrase' })).toEqual({ ok: false, reason: 'bootstrap_closed' })
        writeRegistry([MANAGER, ADMIN, LEAD, { ...ADMIN, id: 'u9', createdAt: '2026-11-08T00:00:00Z' }])
        expect(await operations.setStaffPasswordV1({ actor, targetUserId: 'u9', newPassword: ADMIN_PASSWORD })).toEqual({ ok: false, reason: 'bootstrap_closed' })
    })

    test('a revoked row counts as a credential: bootstrap cannot revive it (C-D2a)', async () => {
        configureLane()
        await seedCredential('u2', ADMIN_PASSWORD)
        fake.state.rows.get('u2')!.revokedAt = new Date()
        expect(await operations.setStaffPasswordV1({ actor: { kind: 'integration_admin' }, targetUserId: 'u2', newPassword: 'revived admin phrase' })).toEqual({ ok: false, reason: 'bootstrap_closed' })
    })

    test('without a valid secret no credential row is created, bootstrap included (C-D4b)', async () => {
        vi.stubEnv('YOKO_USER_REGISTRY_FILE', registryFile)
        expect(await operations.setStaffPasswordV1({ actor: { kind: 'integration_admin' }, targetUserId: 'u2', newPassword: ADMIN_PASSWORD })).toEqual({ ok: false, reason: 'unavailable' })
        expect(fake.state.rows.size).toBe(0)
    })

    test('an Администратор sets others\' passwords; the old sessions die; a Менеджер cannot', async () => {
        configureLane()
        await seedCredential('u2', ADMIN_PASSWORD)
        await seedCredential('u1', MANAGER_PASSWORD)
        const admin = (await operations.verifyStaffSessionTokenV1(await loginToken('u2', ADMIN_PASSWORD)))
        const managerToken = await loginToken('u1', MANAGER_PASSWORD)
        const manager = await operations.verifyStaffSessionTokenV1(managerToken)
        if (admin.kind !== 'valid' || manager.kind !== 'valid') throw new Error('setup')
        expect(await operations.setStaffPasswordV1({ actor: { kind: 'staff', principal: manager.principal }, targetUserId: 'u3', newPassword: MANAGER_PASSWORD })).toEqual({ ok: false, reason: 'forbidden' })
        expect(await operations.setStaffPasswordV1({ actor: { kind: 'staff', principal: admin.principal }, targetUserId: 'u1', newPassword: 'reset by the admin 2026' })).toEqual({ ok: true })
        expect((await operations.verifyStaffSessionTokenV1(managerToken)).kind).toBe('refused')
        expect(fake.state.events.at(-1)).toMatchObject({ userId: 'u1', kind: 'password_reset', actor: 'staff:u2' })
    })

    test('a password change racing a disable cannot revive the employee (N1)', async () => {
        configureLane()
        await seedCredential('u2', ADMIN_PASSWORD)
        await seedCredential('u1', MANAGER_PASSWORD)
        const admin = await operations.verifyStaffSessionTokenV1(await loginToken('u2', ADMIN_PASSWORD))
        if (admin.kind !== 'valid') throw new Error('setup')
        const asAdmin = async () => admin.principal
        // Both start together; whichever order the registry turn gives them,
        // the end state is a disabled employee whose credential is revoked.
        const [, changed] = await Promise.all([
            operations.strictUpdateUserV1(asAdmin, 'u1', { status: 'Отключен' }),
            operations.setStaffPasswordV1({ actor: { kind: 'staff', principal: admin.principal }, targetUserId: 'u1', newPassword: 'racing manager phrase' }),
        ])
        expect(readRegistry().find((user) => user.id === 'u1')!.status).toBe('Отключен')
        expect(fake.state.rows.get('u1')!.revokedAt).not.toBeNull()
        expect(changed).toEqual({ ok: false, reason: 'unknown_or_inactive_user' })
    })

    test('the employee\'s own change always needs the current password, an Администратор included', async () => {
        configureLane()
        await seedCredential('u2', ADMIN_PASSWORD)
        const admin = await operations.verifyStaffSessionTokenV1(await loginToken('u2', ADMIN_PASSWORD))
        if (admin.kind !== 'valid') throw new Error('setup')
        const actor = { kind: 'staff' as const, principal: admin.principal }
        expect(await operations.setStaffPasswordV1({ actor, targetUserId: 'u2', newPassword: 'new admin phrase 2026' })).toEqual({ ok: false, reason: 'current_password_refused' })
        expect(await operations.setStaffPasswordV1({ actor, targetUserId: 'u2', newPassword: 'new admin phrase 2026', currentPassword: ADMIN_PASSWORD })).toEqual({ ok: true })
    })

    test('the request actor: a staff cookie that does not verify never falls back to the integration-admin bootstrap', async () => {
        configureLane({ ADMIN_USER: 'project-operator', ADMIN_PASS: 'correct horse battery staple' })
        asRequest({ '__Host-yoko_staff_session': 'forged.token', yoko_integration_admin_session: issueIntegrationAdminSession()! })
        expect(await publicSurface.setStaffPasswordForRequestV1('u2', ADMIN_PASSWORD)).toEqual({ ok: false, reason: 'forbidden' })
        asRequest({ yoko_integration_admin_session: issueIntegrationAdminSession()! })
        expect(await publicSurface.setStaffPasswordForRequestV1('u2', ADMIN_PASSWORD)).toEqual({ ok: true })
        asRequest({})
        expect(await publicSurface.setStaffPasswordForRequestV1('u2', ADMIN_PASSWORD)).toEqual({ ok: false, reason: 'forbidden' })
    })
})

// ── User management: the guard (D4, C-D4a) and the write order (D2) ────────

describe('user management', () => {
    test('legacy while dormant with no credential row; strict with a valid secret, any row, or an unreadable store', async () => {
        expect(await operations.userManagementModeV1()).toBe('legacy')
        await seedCredential('u2', ADMIN_PASSWORD)
        fake.state.rows.get('u2')!.revokedAt = new Date()
        expect(await operations.userManagementModeV1()).toBe('strict')
        fake.state.rows.clear()
        fake.state.unreadable = true
        expect(await operations.userManagementModeV1()).toBe('strict')
        fake.state.unreadable = false
        vi.stubEnv('STAFF_SESSION_SECRET', SECRET)
        expect(await operations.userManagementModeV1()).toBe('strict')
    })

    test('the field allowlist: id, createdAt and unknown fields are never written (C-D1b)', () => {
        expect(operations.allowlistedUserPatchV1({ id: 'u2', createdAt: 'x', role: 'Менеджер', extra: 1, firstName: 'A' })).toEqual({ role: 'Менеджер', firstName: 'A' })
        expect(() => operations.allowlistedUserPatchV1({ role: '__proto__' })).toThrow('invalid_role')
        expect(() => operations.allowlistedUserPatchV1({ status: 'Удалён' })).toThrow('invalid_status')
    })

    async function principalOf(userId: string, password: string) {
        const verified = await operations.verifyStaffSessionTokenV1(await loginToken(userId, password))
        if (verified.kind !== 'valid') throw new Error('setup')
        return verified.principal
    }

    test('strict: only an Администратор changes roles and status; a Руководитель edits names of employees without a credential', async () => {
        configureLane()
        await seedCredential('u2', ADMIN_PASSWORD)
        await seedCredential('u3', MANAGER_PASSWORD)
        const lead = await principalOf('u3', MANAGER_PASSWORD)
        const asLead = async () => lead
        await expect(operations.strictUpdateUserV1(asLead, 'u1', { role: 'Администратор' })).rejects.toThrow('forbidden')
        await expect(operations.strictUpdateUserV1(asLead, 'u1', { status: 'Отключен' })).rejects.toThrow('forbidden')
        await expect(operations.strictUpdateUserV1(asLead, 'u2', { firstName: 'X' })).rejects.toThrow('forbidden')
        await operations.strictUpdateUserV1(asLead, 'u1', { firstName: 'Мария-Анна' })
        expect(readRegistry().find((user) => user.id === 'u1')!.firstName).toBe('Мария-Анна')
        await expect(operations.strictUpdateUserV1(async () => null, 'u1', { firstName: 'Z' })).rejects.toThrow('forbidden')
        await expect(operations.strictAddUserV1(asLead, { firstName: 'N', lastName: 'N', role: 'Менеджер' })).rejects.toThrow('forbidden')
    })

    test('strict disable: the credential is revoked first; a lost registry write cannot re-enable sign-in (D2)', async () => {
        configureLane()
        await seedCredential('u2', ADMIN_PASSWORD)
        await seedCredential('u1', MANAGER_PASSWORD)
        const admin = await principalOf('u2', ADMIN_PASSWORD)
        const managerToken = await loginToken('u1', MANAGER_PASSWORD)
        chmodSync(directory, 0o500) // the registry write will fail
        await expect(operations.strictUpdateUserV1(async () => admin, 'u1', { status: 'Отключен' })).rejects.toThrow()
        chmodSync(directory, 0o700)
        expect(readRegistry().find((user) => user.id === 'u1')!.status).toBe('Активен')
        expect(fake.state.rows.get('u1')!.revokedAt).not.toBeNull()
        expect((await operations.verifyStaffSessionTokenV1(managerToken)).kind).toBe('refused')
        expect(await operations.staffLoginV1({ userId: 'u1', password: MANAGER_PASSWORD, source: null })).toEqual({ ok: false, reason: 'refused' })
        // Re-enabling is the registry only; only an Администратор's new password revives the credential (C-D2b).
        await operations.strictUpdateUserV1(async () => admin, 'u1', { status: 'Отключен' })
        await operations.strictUpdateUserV1(async () => admin, 'u1', { status: 'Активен' })
        expect(await operations.staffLoginV1({ userId: 'u1', password: MANAGER_PASSWORD, source: null })).toEqual({ ok: false, reason: 'refused' })
        expect(await operations.setStaffPasswordV1({ actor: { kind: 'staff', principal: admin }, targetUserId: 'u1', newPassword: 'fresh manager phrase' })).toEqual({ ok: true })
        expect((await operations.staffLoginV1({ userId: 'u1', password: 'fresh manager phrase', source: null })).ok).toBe(true)
    })

    test('strict role change bumps the epoch first; the old session is refused', async () => {
        configureLane()
        await seedCredential('u2', ADMIN_PASSWORD)
        await seedCredential('u1', MANAGER_PASSWORD)
        const admin = await principalOf('u2', ADMIN_PASSWORD)
        const managerToken = await loginToken('u1', MANAGER_PASSWORD)
        await operations.strictUpdateUserV1(async () => admin, 'u1', { role: 'Руководитель' })
        expect((await operations.verifyStaffSessionTokenV1(managerToken)).kind).toBe('refused')
        expect(fake.state.events.at(-1)).toMatchObject({ userId: 'u1', kind: 'epoch_bump' })
        expect(readRegistry().find((user) => user.id === 'u1')!.role).toBe('Руководитель')
    })

    test('strict delete keeps the row revoked; the last credentialed Администратор cannot be removed or disabled', async () => {
        configureLane()
        await seedCredential('u2', ADMIN_PASSWORD)
        await seedCredential('u1', MANAGER_PASSWORD)
        const admin = await principalOf('u2', ADMIN_PASSWORD)
        await expect(operations.strictUpdateUserV1(async () => admin, 'u2', { status: 'Отключен' })).rejects.toThrow('last_credentialed_administrator')
        await expect(operations.strictUpdateUserV1(async () => admin, 'u2', { role: 'Менеджер' })).rejects.toThrow('last_credentialed_administrator')
        await expect(operations.strictDeleteUserV1(async () => admin, 'u2')).rejects.toThrow('last_credentialed_administrator')
        await operations.strictDeleteUserV1(async () => admin, 'u1')
        expect(readRegistry().map((user) => user.id)).toEqual(['u2', 'u3'])
        expect(fake.state.rows.get('u1')!.revokedAt).not.toBeNull()
    })

    test('strict writes keep registry entries they do not understand', async () => {
        configureLane()
        await seedCredential('u2', ADMIN_PASSWORD)
        const admin = await principalOf('u2', ADMIN_PASSWORD)
        const foreign = { id: 'legacy-x', firstName: 'Old', lastName: 'Entry', role: 'Стажёр', status: 'Архив', createdAt: '2020-01-01T00:00:00Z', note: 'kept' }
        writeRegistry([MANAGER, ADMIN, LEAD, foreign])
        await operations.strictUpdateUserV1(async () => admin, 'u1', { firstName: 'Мария' })
        await operations.strictDeleteUserV1(async () => admin, 'u3')
        await operations.strictAddUserV1(async () => admin, { firstName: 'Н', lastName: 'С', role: 'Менеджер' })
        const after = readRegistry()
        expect(after.find((user) => user.id === 'legacy-x')).toEqual(foreign)
        expect(after.map((user) => user.id).slice(0, 3)).toEqual(['u1', 'u2', 'legacy-x'])
    })

    test('strict add mints a random immutable id', async () => {
        configureLane()
        await seedCredential('u2', ADMIN_PASSWORD)
        const admin = await principalOf('u2', ADMIN_PASSWORD)
        const added = await operations.strictAddUserV1(async () => admin, { firstName: 'Новый', lastName: 'Сотрудник', role: 'Менеджер', id: 'u1', createdAt: 'x' })
        expect(added.id).toMatch(/^[0-9a-f-]{36}$/)
        expect(added.createdAt).not.toBe('x')
    })

    test('the legacy password-less login is closed for any id with a credential row, and under enforcement (N-D2)', async () => {
        await seedCredential('u1', MANAGER_PASSWORD)
        fake.state.rows.get('u1')!.revokedAt = new Date()
        expect(await operations.legacyLoginAllowedForV1('u1')).toBe(false)
        expect(await operations.legacyLoginAllowedForV1('u3')).toBe(true)
        vi.stubEnv('YOKO_STAFF_SESSION_ENFORCE', 'on')
        expect(await operations.legacyLoginAllowedForV1('u3')).toBe(false)
        vi.stubEnv('YOKO_STAFF_SESSION_ENFORCE', '')
        fake.state.unreadable = true
        // Dormant: an outage keeps the legacy trusted-app behaviour; configured: refused.
        expect(await operations.legacyLoginAllowedForV1('u3')).toBe(true)
        vi.stubEnv('STAFF_SESSION_SECRET', SECRET)
        expect(await operations.legacyLoginAllowedForV1('u3')).toBe(false)
    })

    test('the user-service actions route to strict mode and refuse an unsigned crm_user_id', async () => {
        configureLane()
        await seedCredential('u2', ADMIN_PASSWORD)
        asRequest({ crm_user_id: 'u2' })
        await expect(userService.updateUser('u1', { role: 'Администратор' })).rejects.toThrow('forbidden')
        await expect(userService.deleteUser('u1')).rejects.toThrow('forbidden')
        await expect(userService.addUser({ firstName: 'A', lastName: 'B', role: 'Администратор', status: 'Активен' })).rejects.toThrow('forbidden')
        await expect(userService.login('u2')).rejects.toThrow('forbidden')
        expect(readRegistry().find((user) => user.id === 'u1')!.role).toBe('Менеджер')
    })

    test('dormant user-service actions keep the legacy semantics, now with atomic writes and the allowlist', async () => {
        vi.stubEnv('YOKO_USER_REGISTRY_FILE', registryFile)
        asRequest({ crm_user_id: 'u2' })
        await userService.updateUser('u1', { role: 'Руководитель', id: 'zzz', createdAt: 'x' } as never)
        const updated = readRegistry().find((user) => user.id === 'u1')!
        expect(updated).toMatchObject({ role: 'Руководитель', createdAt: '2026-03-24T00:00:00Z' })
        asRequest({ crm_user_id: 'u1' })
        // u1 is a Руководитель now; a Менеджер would be refused as before.
        writeRegistry([MANAGER, ADMIN, LEAD])
        await expect(userService.deleteUser('u3')).rejects.toThrow('forbidden')
    })
})

// ── BR-4 resolution and the proxy ──────────────────────────────────────────

describe('one operator resolution (BR-4) and the request boundary', () => {
    test('a staff session is the operator; a refused one has none; mobile + staff has none', async () => {
        configureLane()
        await seedCredential('u1', MANAGER_PASSWORD)
        const token = await loginToken('u1', MANAGER_PASSWORD)
        expect(await resolveCookieOperatorV1(undefined, 'u2', token)).toEqual({ kind: 'staff_session', operatorId: 'u1' })
        expect(await resolveCookieOperatorV1(undefined, 'u2', 'forged.token')).toEqual({ kind: 'staff_session_refused' })
        expect(await resolveCookieOperatorV1('mobile', 'u2', token)).toEqual({ kind: 'mobile_session_refused' })
        fake.state.unreadable = true
        expect(await resolveCookieOperatorV1(undefined, 'u2', token)).toEqual({ kind: 'staff_session_refused', unverifiable: true })
        expect(await resolveCookieOperatorV1(undefined, 'u2', undefined)).toEqual({ kind: 'legacy', operatorId: 'u2' })
    })

    function browser(pathname: string, cookie?: string, method = 'GET') {
        const headers = new Headers({ 'user-agent': 'Mozilla/5.0 Chrome/120' })
        if (cookie) headers.set('cookie', cookie)
        return new NextRequest(new URL(`https://yokoone.ru${pathname}`), { headers, method })
    }
    const downstreamCookie = (response: Response) => response.headers.get('x-middleware-request-cookie')

    test('browser lane: the staff employee replaces any crm_user_id; refused → none; unverifiable → 503', async () => {
        configureLane()
        await seedCredential('u1', MANAGER_PASSWORD)
        const token = await loginToken('u1', MANAGER_PASSWORD)
        const valid = await proxy(browser('/contacts', `crm_user_id=u2; __Host-yoko_staff_session=${token}`))
        expect(downstreamCookie(valid)).toContain('crm_user_id=u1')
        expect(downstreamCookie(valid)).not.toContain('crm_user_id=u2')
        const refused = await proxy(browser('/contacts', 'crm_user_id=u2; __Host-yoko_staff_session=forged.token'))
        expect(downstreamCookie(refused) ?? '').not.toContain('crm_user_id')
        fake.state.unreadable = true
        const down = await proxy(browser('/api/contacts/lookup', `__Host-yoko_staff_session=${token}`))
        expect(down.status).toBe(503)
    })

    test('browser lane without a session: unchanged while enforcement is off; crm_user_id removed when it is on (R1)', async () => {
        const untouched = await proxy(browser('/messages', 'crm_user_id=u2'))
        expect(untouched.headers.get('x-middleware-next')).toBe('1')
        expect(downstreamCookie(untouched)).toBeNull()
        vi.stubEnv('YOKO_STAFF_SESSION_ENFORCE', 'on')
        const enforced = await proxy(browser('/messages', 'crm_user_id=u2; theme=dark'))
        // The request goes on, rewritten: every other cookie kept, crm_user_id gone.
        expect(enforced.headers.get('x-middleware-next')).toBe('1')
        expect(downstreamCookie(enforced)).toBe('theme=dark')
        const onlyIdentity = await proxy(browser('/api/chats/1/assign', 'crm_user_id=u2', 'POST'))
        expect(onlyIdentity.headers.get('x-middleware-next')).toBe('1')
        // Only crm_user_id was sent, so the rewritten request carries no Cookie header at all.
        expect(onlyIdentity.headers.get('x-middleware-override-headers')).not.toBeNull()
        expect(onlyIdentity.headers.get('x-middleware-override-headers')).not.toContain('cookie')
        expect(downstreamCookie(onlyIdentity)).toBeNull()
    })

    test('enforcement does not touch the shell lane', async () => {
        vi.stubEnv('YOKO_STAFF_SESSION_ENFORCE', 'on')
        const shell = new NextRequest(new URL('https://yokoone.ru/messages'), {
            headers: new Headers({ 'user-agent': 'Mozilla/5.0 (Linux; Android 14) YokoShell/1', cookie: 'crm_user_id=u2' }),
        })
        const response = await proxy(shell)
        expect(response.status).toBe(303)
        expect(response.headers.get('location')).toContain('/login/mobile')
    })
})
