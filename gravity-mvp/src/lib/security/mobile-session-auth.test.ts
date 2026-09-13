import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Login, logout and the cookie flags they set.
 *
 * The flags are the part a report cannot be trusted on, so they are asserted
 * against the values actually handed to the cookie store.
 */

interface RecordedCookie { name: string, value: string, options: Record<string, unknown> }

const recorded: RecordedCookie[] = []
const store = new Map<string, string>()

const cookieStore = {
    get: (name: string) => (store.has(name) ? { name, value: store.get(name) } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
        recorded.push({ name, value, options })
        store.set(name, value)
    },
}

vi.mock('next/headers', () => ({ cookies: async () => cookieStore }))

const listUsers = vi.fn()
vi.mock('@/modules/identity-access/public/v1/user-directory', () => ({
    listUserIdentitiesV1: () => listUsers(),
}))

const {
    clearMobileSessionV1,
    establishMobileSessionV1,
    getMobileSessionPrincipalV1,
    isMobileLaneConfigured,
} = await import('@/modules/identity-access/public/v1/mobile-session-auth')

const USERNAME = 'mobile-operator'
const PASSWORD = 'correct horse battery staple'
const DEVICE = 'a1b2c3d4e5f6a7b8'

const ACTIVE_OPERATOR = {
    id: 'u1', firstName: 'Мария', lastName: 'Иванова',
    role: 'Менеджер', status: 'Активен', createdAt: '2026-03-24T00:00:00Z',
}
const DISABLED_OPERATOR = { ...ACTIVE_OPERATOR, id: 'u9', status: 'Отключен' }

function lastCookie(name: string): RecordedCookie | undefined {
    return [...recorded].reverse().find((entry) => entry.name === name)
}

beforeEach(() => {
    recorded.length = 0
    store.clear()
    listUsers.mockReset()
    listUsers.mockResolvedValue([ACTIVE_OPERATOR, DISABLED_OPERATOR])
    process.env.MOBILE_ACCESS_USER = USERNAME
    process.env.MOBILE_ACCESS_PASS = PASSWORD
    delete process.env.MOBILE_SESSION_REVOCATION_EPOCH
})

describe('mobile login', () => {
    test('is configured only when a credential is provisioned', () => {
        expect(isMobileLaneConfigured()).toBe(true)
        delete process.env.MOBILE_ACCESS_USER
        delete process.env.MOBILE_ACCESS_PASS
        expect(isMobileLaneConfigured()).toBe(false)
    })

    test('an unproven identity gets no session at all', async () => {
        const result = await establishMobileSessionV1(USERNAME, 'wrong password value', 'u1', DEVICE)
        expect(result).toEqual({ ok: false, reason: 'invalid_credentials' })
        expect(recorded).toHaveLength(0)
        expect(await getMobileSessionPrincipalV1()).toBeNull()
    })

    test('a disabled operator cannot be selected even with the right credential', async () => {
        const result = await establishMobileSessionV1(USERNAME, PASSWORD, 'u9', DEVICE)
        expect(result).toEqual({ ok: false, reason: 'inactive_operator' })
        expect(recorded).toHaveLength(0)
    })

    test('an operator who is not in the directory is refused', async () => {
        const result = await establishMobileSessionV1(USERNAME, PASSWORD, 'u404', DEVICE)
        expect(result).toEqual({ ok: false, reason: 'unknown_operator' })
    })

    test('a malformed device identifier is refused before the credential is even checked', async () => {
        const result = await establishMobileSessionV1(USERNAME, PASSWORD, 'u1', 'a b c')
        expect(result).toEqual({ ok: false, reason: 'invalid_device' })
    })

    test('a proven credential issues a session and the UI value derived from it', async () => {
        const result = await establishMobileSessionV1(USERNAME, PASSWORD, 'u1', DEVICE)
        expect(result.ok).toBe(true)

        const session = lastCookie('yoko_mobile_session')
        expect(session?.options).toMatchObject({
            httpOnly: true,
            sameSite: 'lax',
            path: '/',
            maxAge: 12 * 60 * 60,
        })
        // `secure` follows NODE_ENV exactly as the proven integration-admin
        // session does; under test that resolves to false.
        expect(session?.options.secure).toBe(process.env.NODE_ENV === 'production')

        const derived = lastCookie('crm_user_id')
        expect(derived?.value).toBe('u1')
        // Readable from JS on purpose: the existing Messenger reads it, and it
        // carries no authority.
        expect(derived?.options.httpOnly).toBe(false)
        expect(derived?.options.maxAge as number).toBeLessThanOrEqual(12 * 60 * 60)

        const principal = await getMobileSessionPrincipalV1()
        expect(principal?.runtimeOperatorId).toBe('u1')
        expect(principal?.deviceId).toBe(DEVICE)
    })

    test('logout clears the session and the value derived from it', async () => {
        await establishMobileSessionV1(USERNAME, PASSWORD, 'u1', DEVICE)
        expect(await getMobileSessionPrincipalV1()).not.toBeNull()

        await clearMobileSessionV1()

        expect(lastCookie('yoko_mobile_session')).toMatchObject({ value: '', options: { maxAge: 0 } })
        expect(lastCookie('crm_user_id')).toMatchObject({ value: '', options: { maxAge: 0 } })
        expect(await getMobileSessionPrincipalV1()).toBeNull()
    })

    test('raising the revocation epoch invalidates a session already on the device', async () => {
        await establishMobileSessionV1(USERNAME, PASSWORD, 'u1', DEVICE)
        expect(await getMobileSessionPrincipalV1()).not.toBeNull()

        // Server-side revocation: nothing on the device changes, and the next
        // request it makes is unauthenticated.
        process.env.MOBILE_SESSION_REVOCATION_EPOCH = '1'
        expect(await getMobileSessionPrincipalV1()).toBeNull()
    })

    test('rotating the credential invalidates a session already on the device', async () => {
        await establishMobileSessionV1(USERNAME, PASSWORD, 'u1', DEVICE)
        process.env.MOBILE_ACCESS_PASS = 'a completely different passphrase'
        expect(await getMobileSessionPrincipalV1()).toBeNull()
    })
})
