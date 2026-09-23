import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The manager server action, as the browser reaches it.
 *
 * What has to hold here is everything the browser is not allowed to decide: who
 * is acting, whether the support screenshot could actually be seen, and what
 * the answer is when the monetary core refuses. The monetary rules themselves
 * are proved against PostgreSQL; these are the gates in front of them.
 */

const queryCurrentUserV1 = vi.fn()
const compensationManagerActionV1 = vi.fn()
const compensationManagerEvidenceSourceV1 = vi.fn()
const readTelegramBotFileV1 = vi.fn()
const revalidatePath = vi.fn()

vi.mock('next/cache', () => ({ revalidatePath: (path: string) => revalidatePath(path) }))
vi.mock('@/modules/identity-access/public/v1/identity-actions', () => ({
    queryCurrentUserV1: (...args: unknown[]) => queryCurrentUserV1(...args),
}))
vi.mock('@/modules/fleet-operations/public/v1', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    compensationManagerActionV1: (...args: unknown[]) => compensationManagerActionV1(...args),
    compensationManagerEvidenceSourceV1: (...args: unknown[]) => compensationManagerEvidenceSourceV1(...args),
}))
vi.mock('@/modules/telegram-channel/public/v1', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    readTelegramBotFileV1: (...args: unknown[]) => readTelegramBotFileV1(...args),
}))

import { runCompensationManagerAction } from './actions'
import { MANAGER_ROLES_V1, managerEvidence, managerSession } from './manager-data'

const MANAGER_USER = {
    id: 'user-1',
    firstName: 'Аня',
    lastName: 'Менеджер',
    role: 'Менеджер',
    status: 'Активен',
}

const ACTING = { principalId: 'crm_user:user-1', operatorLabel: 'Аня Менеджер' }

const signedInAs = (user: unknown) => queryCurrentUserV1.mockResolvedValue({ user })

beforeEach(() => {
    vi.clearAllMocks()
    signedInAs(MANAGER_USER)
    compensationManagerActionV1.mockResolvedValue({ code: 'performed', state: 'awaiting_payment' })
    compensationManagerEvidenceSourceV1.mockResolvedValue({ fileId: 'tg-file-1', kind: 'photo' })
    readTelegramBotFileV1.mockResolvedValue({
        ok: true, contentType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]),
    })
})

describe('who is allowed in', () => {
    it('resolves the acting manager from the session', async () => {
        const session = await managerSession()
        expect(session).toEqual({
            ok: true,
            role: 'Менеджер',
            principal: ACTING,
        })
    })

    it('refuses everyone who is not signed in', async () => {
        signedInAs(null)
        expect(await managerSession()).toEqual({ ok: false, refusal: 'not_authenticated' })
    })

    it('refuses a disabled account', async () => {
        signedInAs({ ...MANAGER_USER, status: 'Отключён' })
        expect(await managerSession()).toEqual({ ok: false, refusal: 'user_disabled' })
    })

    it.each(MANAGER_ROLES_V1)('admits the %s role', async (role) => {
        signedInAs({ ...MANAGER_USER, role })
        expect(await managerSession()).toMatchObject({ ok: true, role })
    })

    it('refuses a role the compensation section is not for', async () => {
        for (const role of ['Оператор', 'Водитель', '', 'manager']) {
            signedInAs({ ...MANAGER_USER, role })
            expect(await managerSession()).toEqual({ ok: false, refusal: 'role_not_allowed' })
        }
    })

    it('stops an action before the monetary core when the session is refused', async () => {
        signedInAs(null)
        expect(await runCompensationManagerAction({ applicationId: 'app-1', action: 'approve' }))
            .toEqual({ code: 'not_authenticated', state: null })
        expect(compensationManagerActionV1).not.toHaveBeenCalled()
        expect(readTelegramBotFileV1).not.toHaveBeenCalled()
    })

    it('stops an action for a role that may not act', async () => {
        signedInAs({ ...MANAGER_USER, role: 'Оператор' })
        expect(await runCompensationManagerAction({ applicationId: 'app-1', action: 'mark_paid' }))
            .toEqual({ code: 'role_not_allowed', state: null })
        expect(compensationManagerActionV1).not.toHaveBeenCalled()
    })
})

describe('acting on an application', () => {
    it('never takes the acting principal from the caller', async () => {
        await runCompensationManagerAction({
            applicationId: 'app-1',
            action: 'mark_paid',
            // A crafted post cannot put another name on a payout: the action
            // takes an application, an action and a reason, nothing else.
            ...({ principal: { principalId: 'someone-else', operatorLabel: 'Чужое имя' } } as object),
        })
        expect(compensationManagerActionV1).toHaveBeenCalledWith(expect.objectContaining({
            principal: ACTING,
        }))
    })

    it('fetches the screenshot before approving and says it is proven', async () => {
        await runCompensationManagerAction({ applicationId: 'app-1', action: 'approve' })
        expect(readTelegramBotFileV1).toHaveBeenCalledWith({ fileId: 'tg-file-1' })
        expect(compensationManagerActionV1).toHaveBeenCalledWith(expect.objectContaining({
            action: 'approve', evidenceProven: true,
        }))
    })

    it('refuses an approval when the screenshot cannot be fetched, and does not approve', async () => {
        readTelegramBotFileV1.mockResolvedValue({ ok: false, reason: 'unavailable' })
        expect(await runCompensationManagerAction({ applicationId: 'app-1', action: 'approve' }))
            .toEqual({ code: 'evidence_unavailable', state: null })
        expect(compensationManagerActionV1).not.toHaveBeenCalled()
    })

    it('says plainly when there is no screenshot at all', async () => {
        compensationManagerEvidenceSourceV1.mockResolvedValue(null)
        expect(await runCompensationManagerAction({ applicationId: 'app-1', action: 'approve' }))
            .toEqual({ code: 'evidence_missing', state: null })
        expect(compensationManagerActionV1).not.toHaveBeenCalled()
    })

    it.each([
        'reject', 'mark_paid', 'cancel_approval', 'declare_outcome_unknown',
        'reconcile_paid', 'reconcile_not_paid',
    ] as const)('never waits on Telegram to %s', async (action) => {
        readTelegramBotFileV1.mockResolvedValue({ ok: false, reason: 'unavailable' })
        await runCompensationManagerAction({ applicationId: 'app-1', action, reason: 'причина' })
        // A Telegram outage must not strand money that is already authorised.
        expect(readTelegramBotFileV1).not.toHaveBeenCalled()
        expect(compensationManagerActionV1).toHaveBeenCalledWith(expect.objectContaining({
            action, evidenceProven: false,
        }))
    })

    it('passes the typed reason through and nothing else', async () => {
        await runCompensationManagerAction({ applicationId: 'app-1', action: 'reject', reason: 'Нет чека' })
        expect(compensationManagerActionV1).toHaveBeenCalledWith({
            applicationId: 'app-1',
            action: 'reject',
            reason: 'Нет чека',
            principal: ACTING,
            evidenceProven: false,
        })
    })

    it('reports the code and state the backend confirmed, never a guess', async () => {
        compensationManagerActionV1.mockResolvedValue({ code: 'already_paid', state: 'paid' })
        expect(await runCompensationManagerAction({ applicationId: 'app-1', action: 'mark_paid' }))
            .toEqual({ code: 'already_paid', state: 'paid' })
    })

    it('makes both screens re-read storage after every attempt', async () => {
        compensationManagerActionV1.mockResolvedValue({ code: 'state_changed', state: 'rejected' })
        await runCompensationManagerAction({ applicationId: 'app-7', action: 'mark_paid' })
        expect(revalidatePath).toHaveBeenCalledWith('/compensation')
        expect(revalidatePath).toHaveBeenCalledWith('/compensation/app-7')
    })
})

describe('the screenshot itself', () => {
    it('hands the stored file id straight to the channel that holds it', async () => {
        expect(await managerEvidence('app-1')).toEqual({
            ok: true, contentType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]),
        })
        expect(compensationManagerEvidenceSourceV1).toHaveBeenCalledWith('app-1')
        expect(readTelegramBotFileV1).toHaveBeenCalledWith({ fileId: 'tg-file-1' })
    })

    it('reports a claim with no screenshot as missing', async () => {
        compensationManagerEvidenceSourceV1.mockResolvedValue(null)
        expect(await managerEvidence('app-1')).toEqual({ ok: false, reason: 'missing' })
        expect(readTelegramBotFileV1).not.toHaveBeenCalled()
    })

    it.each([
        ['invalid_file_id', 'not_found'],
        ['not_found', 'not_found'],
        ['unsupported_media', 'unsupported_media'],
        ['too_large', 'too_large'],
        ['unavailable', 'unavailable'],
    ] as const)('passes the %s failure on as %s', async (reason, expected) => {
        readTelegramBotFileV1.mockResolvedValue({ ok: false, reason })
        expect(await managerEvidence('app-1')).toEqual({ ok: false, reason: expected })
    })
})
