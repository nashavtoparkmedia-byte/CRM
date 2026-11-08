import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The referral screens' server actions, as the browser reaches them.
 *
 * What has to hold here is everything the browser is not allowed to decide:
 * an action refuses before any backend call unless the CRM manager session
 * admits the request, the search and the person card refuse unless the
 * integration-admin session verifies, and every write refuses unless a signed
 * staff session stands behind it. The unsigned crm_user_id cookie and the
 * role it names are never enough to write, and a write carries the authority
 * the server resolved, never one the browser sent. The ledger rules
 * themselves are proved against PostgreSQL.
 */

const queryCurrentUserV1 = vi.fn()
const getIntegrationAdminPrincipal = vi.fn()
const resolveCashStaffAuthorityV1 = vi.fn()
const revalidatePath = vi.fn()
const backend = {
    cashReferralManagerSearchV1: vi.fn(),
    cashReferralManagerPersonV1: vi.fn(),
    cashReferralManagerRecordInvitationV1: vi.fn(),
    cashReferralManagerWithdrawInvitationV1: vi.fn(),
    cashAccessManagerGrantV1: vi.fn(),
    cashAccessManagerRevokeV1: vi.fn(),
}

vi.mock('next/cache', () => ({ revalidatePath: (path: string) => revalidatePath(path) }))
vi.mock('@/modules/identity-access/public/v1/identity-actions', () => ({
    queryCurrentUserV1: (...args: unknown[]) => queryCurrentUserV1(...args),
}))
vi.mock('@/modules/identity-access/public/v1', () => ({
    getIntegrationAdminPrincipal: () => getIntegrationAdminPrincipal(),
}))
vi.mock('@/modules/fleet-operations/public/v1', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    cashReferralManagerSearchV1: (...args: unknown[]) => backend.cashReferralManagerSearchV1(...args),
    cashReferralManagerPersonV1: (...args: unknown[]) => backend.cashReferralManagerPersonV1(...args),
    cashReferralManagerRecordInvitationV1: (...args: unknown[]) => backend.cashReferralManagerRecordInvitationV1(...args),
    cashReferralManagerWithdrawInvitationV1: (...args: unknown[]) => backend.cashReferralManagerWithdrawInvitationV1(...args),
    cashAccessManagerGrantV1: (...args: unknown[]) => backend.cashAccessManagerGrantV1(...args),
    cashAccessManagerRevokeV1: (...args: unknown[]) => backend.cashAccessManagerRevokeV1(...args),
}))
vi.mock('./referral-data', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveCashStaffAuthorityV1: () => resolveCashStaffAuthorityV1(),
}))

import {
    grantCashAccess,
    loadReferralPerson,
    recordReferralInvitation,
    revokeCashAccess,
    searchReferralPeople,
    withdrawReferralInvitation,
} from './actions'

/** The resolver as it ships, not the stand-in the signed-session cases use. */
let realResolveCashStaffAuthorityV1: typeof import('./referral-data').resolveCashStaffAuthorityV1
beforeAll(async () => {
    realResolveCashStaffAuthorityV1 = (await vi.importActual<typeof import('./referral-data')>('./referral-data')).resolveCashStaffAuthorityV1
})

const MANAGER_USER = { id: 'user-1', firstName: 'Аня', lastName: 'Менеджер', role: 'Администратор', status: 'Активен' }
const ADMIN_PRINCIPAL = { id: 'identity-access:integration-admin-session', kind: 'integration_admin_session' }

/** The authority the server resolves from a verified signed session. */
const SERVER_AUTHORITY = {
    principalId: 'identity-access:integration-admin-session',
    operatorLabel: 'Администратор CRM',
    sessionId: 'sid-binding-server',
    authenticatedAt: new Date('2026-11-07T10:00:00Z'),
    capabilities: ['cash.referral.qualify', 'cash.access.manage'],
}

/** What a forged browser request might add: none of it may reach the backend. */
const FORGED = {
    authority: { ...SERVER_AUTHORITY, principalId: 'crm_user:attacker', sessionId: 'forged' },
    actorKind: 'signed_staff_session',
    capabilities: ['cash.access.manage'],
}

const writes = [
    ['recordReferralInvitation', () => recordReferralInvitation({ inviterContactId: 'contact-A', inviteeContactId: 'contact-B', comment: 'Пригласил лично', requestId: 'req-1' })],
    ['withdrawReferralInvitation', () => withdrawReferralInvitation({ attributionId: 'inv-1', expectedVersion: 1, comment: 'Ошибка менеджера', requestId: 'req-2' })],
    ['grantCashAccess', () => grantCashAccess({ contactId: 'contact-A', basis: 'manager_decision', referralAttributionId: null, comment: 'Решение менеджера', requestId: 'req-3' })],
    ['revokeCashAccess', () => revokeCashAccess({ contactId: 'contact-A', comment: 'Доступ больше не нужен', requestId: 'req-4' })],
] as const

const reads = [
    ['searchReferralPeople', () => searchReferralPeople('Иванов')],
    ['loadReferralPerson', () => loadReferralPerson('contact-A')],
] as const

function expectNoBackendCall() {
    for (const fn of Object.values(backend)) expect(fn).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
}

beforeEach(() => {
    vi.clearAllMocks()
    queryCurrentUserV1.mockResolvedValue({ user: MANAGER_USER })
    getIntegrationAdminPrincipal.mockResolvedValue(ADMIN_PRINCIPAL)
    resolveCashStaffAuthorityV1.mockImplementation(() => realResolveCashStaffAuthorityV1())
    backend.cashReferralManagerSearchV1.mockResolvedValue({ status: 'ok', candidates: [], truncated: false })
    backend.cashReferralManagerRecordInvitationV1.mockResolvedValue({ status: 'recorded', attributionId: 'inv-1' })
    backend.cashReferralManagerWithdrawInvitationV1.mockResolvedValue({ status: 'withdrawn' })
    backend.cashAccessManagerGrantV1.mockResolvedValue({ status: 'granted' })
    backend.cashAccessManagerRevokeV1.mockResolvedValue({ status: 'revoked' })
})

describe('without the CRM manager session', () => {
    it.each([...reads, ...writes])('%s refuses before any backend call', async (_name, call) => {
        queryCurrentUserV1.mockResolvedValue({ user: null })
        expect(await call()).toEqual({ status: 'refused', reason: 'not_authenticated' })
        expectNoBackendCall()
    })

    it.each([...reads, ...writes])('%s refuses a role outside the compensation managers', async (_name, call) => {
        queryCurrentUserV1.mockResolvedValue({ user: { ...MANAGER_USER, role: 'Водитель' } })
        expect(await call()).toEqual({ status: 'refused', reason: 'role_not_allowed' })
        expectNoBackendCall()
    })
})

describe('without a verified integration-admin session', () => {
    it.each(reads)('%s refuses: Contacts names people only to that principal', async (_name, call) => {
        getIntegrationAdminPrincipal.mockResolvedValue(null)
        expect(await call()).toEqual({ status: 'refused', reason: 'admin_session_required' })
        expectNoBackendCall()
    })
})

describe('while no signed staff session exists', () => {
    it('the resolver refuses, whatever the cookie and the role say', async () => {
        expect(await realResolveCashStaffAuthorityV1()).toEqual({ ok: false, refusal: 'staff_session_unavailable' })
    })

    it.each(writes)('%s refuses for a signed-in administrator with a verified admin principal', async (_name, call) => {
        expect(await call()).toEqual({ status: 'refused', reason: 'staff_session_unavailable' })
        expectNoBackendCall()
    })
})

describe('with a signed staff session', () => {
    beforeEach(() => {
        resolveCashStaffAuthorityV1.mockResolvedValue({ ok: true, authority: SERVER_AUTHORITY })
    })

    it('records with the server-resolved authority, never one the browser sent', async () => {
        const forged = { inviterContactId: 'contact-A', inviteeContactId: 'contact-B', comment: 'Пригласил лично', requestId: 'req-1', ...FORGED }
        expect(await recordReferralInvitation(forged)).toEqual({ status: 'done', code: 'recorded', attributionId: 'inv-1' })
        expect(backend.cashReferralManagerRecordInvitationV1).toHaveBeenCalledTimes(1)
        expect(backend.cashReferralManagerRecordInvitationV1.mock.calls[0][0].authority).toBe(SERVER_AUTHORITY)
    })

    it('grants, revokes and withdraws with the server-resolved authority', async () => {
        await grantCashAccess({ contactId: 'contact-A', basis: 'manager_decision', referralAttributionId: null, comment: 'Решение менеджера', requestId: 'req-3', ...FORGED })
        await revokeCashAccess({ contactId: 'contact-A', comment: 'Доступ больше не нужен', requestId: 'req-4', ...FORGED })
        await withdrawReferralInvitation({ attributionId: 'inv-1', expectedVersion: 1, comment: 'Ошибка менеджера', requestId: 'req-2', ...FORGED })
        expect(backend.cashAccessManagerGrantV1.mock.calls[0][0].authority).toBe(SERVER_AUTHORITY)
        expect(backend.cashAccessManagerRevokeV1.mock.calls[0][0].authority).toBe(SERVER_AUTHORITY)
        expect(backend.cashReferralManagerWithdrawInvitationV1.mock.calls[0][0].authority).toBe(SERVER_AUTHORITY)
    })

    it('still refuses a write when the manager session does not admit the request', async () => {
        queryCurrentUserV1.mockResolvedValue({ user: { ...MANAGER_USER, status: 'Отключён' } })
        expect(await grantCashAccess({ contactId: 'contact-A', basis: 'manager_decision', referralAttributionId: null, comment: 'Решение менеджера', requestId: 'req-3' }))
            .toEqual({ status: 'refused', reason: 'user_disabled' })
        expectNoBackendCall()
    })

    it('answers only what the backend answered', async () => {
        backend.cashAccessManagerGrantV1.mockResolvedValue({ status: 'refused', reason: 'capability_missing' })
        expect(await grantCashAccess({ contactId: 'contact-A', basis: 'manager_decision', referralAttributionId: null, comment: 'Решение менеджера', requestId: 'req-3' }))
            .toEqual({ status: 'refused', reason: 'capability_missing' })
        backend.cashAccessManagerRevokeV1.mockResolvedValue({ status: 'disabled' })
        expect(await revokeCashAccess({ contactId: 'contact-A', comment: 'Доступ больше не нужен', requestId: 'req-4' }))
            .toEqual({ status: 'refused', reason: 'disabled' })
        backend.cashReferralManagerRecordInvitationV1.mockResolvedValue({ status: 'refused', reason: 'invitee_already_attributed', inviterContactId: 'contact-C', inviterName: 'Петров Пётр' })
        expect(await recordReferralInvitation({ inviterContactId: 'contact-A', inviteeContactId: 'contact-B', comment: 'Пригласил лично', requestId: 'req-1' }))
            .toEqual({ status: 'refused', reason: 'invitee_already_attributed', detail: 'Петров Пётр' })
    })
})
