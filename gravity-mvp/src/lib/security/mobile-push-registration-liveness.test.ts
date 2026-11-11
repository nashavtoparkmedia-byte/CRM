// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Push registration follows the employee (docs/design/mobile-personal-signin-v1.md
 * §2.4): the real route, the real v2 session and the real liveness rule. The
 * StaffCredential store and the device registration port are stand-ins, so a
 * refusal is proven to happen before any registration write.
 */

const fake = vi.hoisted(() => ({
    rows: new Map<string, { userId: string, registryCreatedAt: string, sessionEpoch: number, revokedAt: Date | null }>(),
    unreadable: false,
    cookie: undefined as string | undefined,
    binds: 0,
}))

vi.mock('@/modules/identity-access/internal/staff-credential-store', () => ({
    prismaStaffCredentialStoreV1: {
        async findStatus(userId: string) {
            if (fake.unreadable) throw Object.assign(new Error('store down'), { name: 'PrismaClientInitializationError' })
            const row = fake.rows.get(userId)
            return row === undefined ? null : { ...row }
        },
        async anyRow() { return fake.rows.size > 0 },
    },
}))
vi.mock('@/modules/identity-access/public/v1/prisma-mobile-device-registration-adapter', () => ({
    prismaMobileDeviceRegistrationPortV1: {
        async bind() { fake.binds += 1; return { outcome: 'bound', registrationId: 'reg_1' } },
        async reclaimFromIneligibleHolderAndBind() { return { outcome: 'holder_not_reclaimable' } },
        async tokenIsBoundToOtherDevice() { return false },
        async revokeDevice() { return 0 },
        async listEligible() { return [] },
        async status() { return null },
        async sendableToken() { return { sendable: false } },
        async clearTokenIfCurrent() { return false },
        async revokeIfTokenCurrent() { return false },
    },
}))
vi.mock('@/modules/identity-access/internal/mobile-session-barrier', () => ({
    prismaMobileSessionBarrierV1: { isBarred: async () => false },
}))
vi.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => (name === 'yoko_mobile_session' && fake.cookie ? { name, value: fake.cookie } : undefined),
        set: () => undefined,
    }),
    headers: async () => new Headers(),
}))
vi.mock('@/lib/prisma', () => ({ prisma: {} }))

const { NextRequest } = await import('next/server')
const { POST } = await import('@/app/api/mobile/push-registration/route')
const { issueMobileSession } = await import('@/modules/identity-access/public/v1/mobile-session-credentials')

const SECRET = 'staff-session-signing-key-for-tests-0123456789abcdef'
const MANAGER = { id: 'u1', firstName: 'Мария', lastName: 'Иванова', role: 'Менеджер', status: 'Активен', createdAt: '2026-03-24T00:00:00Z' }
const PUSH_TOKEN = 'liveness-token_0123456789:ABCDEFGHIJKLMNOP'

let directory: string
let registryFile: string

async function register() {
    const response = await POST(new NextRequest('https://yokoone.ru/api/mobile/push-registration', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: PUSH_TOKEN }),
    }))
    return { status: response.status, body: await response.json(), retryAfter: response.headers.get('retry-after') }
}

beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'push-liveness-'))
    registryFile = path.join(directory, 'users.json')
    writeFileSync(registryFile, JSON.stringify([MANAGER]))
    vi.stubEnv('STAFF_SESSION_SECRET', SECRET)
    vi.stubEnv('YOKO_USER_REGISTRY_FILE', registryFile)
    fake.rows.clear()
    fake.rows.set('u1', { userId: 'u1', registryCreatedAt: MANAGER.createdAt, sessionEpoch: 2, revokedAt: null })
    fake.unreadable = false
    fake.binds = 0
    fake.cookie = issueMobileSession('u1', 'a1b2c3d4e5f6a7b8', 2) as string
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
})

describe('push registration follows the employee', () => {
    test('a live employee registers', async () => {
        expect(await register()).toMatchObject({ status: 200, body: { ok: true } })
        expect(fake.binds).toBe(1)
    })

    test.each([
        ['password reset (epoch moved)', () => { fake.rows.get('u1')!.sessionEpoch = 3 }],
        ['credential revoked', () => { fake.rows.get('u1')!.revokedAt = new Date() }],
        ['no credential', () => { fake.rows.delete('u1') }],
        ['disabled in the registry', () => { writeFileSync(registryFile, JSON.stringify([{ ...MANAGER, status: 'Отключен' }])) }],
        ['re-created in the registry', () => { writeFileSync(registryFile, JSON.stringify([{ ...MANAGER, createdAt: '2026-11-11T00:00:00Z' }])) }],
    ])('%s: 401 MOBILE_SESSION_REVOKED, the same answer as a logout, and nothing is written', async (_name, change) => {
        change()
        expect(await register()).toEqual({ status: 401, body: { error: 'MOBILE_SESSION_REVOKED' }, retryAfter: null })
        expect(fake.binds).toBe(0)
        expect(JSON.parse(readFileSync(registryFile, 'utf8'))).toHaveLength(1)
    })

    test('an unreadable credential store: 503 MOBILE_SESSION_UNVERIFIABLE with Retry-After, never a refusal, nothing written', async () => {
        fake.unreadable = true
        expect(await register()).toEqual({ status: 503, body: { error: 'MOBILE_SESSION_UNVERIFIABLE' }, retryAfter: '5' })
        expect(fake.binds).toBe(0)
    })
})
