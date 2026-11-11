import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The referral screens, rendered.
 *
 * What has to hold: the manager picks both people themselves and nothing is
 * picked for them; recording says it changed no access; a write is offered
 * only when Identity Access's Staff Session of a confirmed Администратор can
 * make it; and the screen says only what the backend answered, including why
 * it may not write.
 */

const searchReferralPeople = vi.fn()
const loadReferralPerson = vi.fn()
const recordReferralInvitation = vi.fn()
const withdrawReferralInvitation = vi.fn()
const grantCashAccess = vi.fn()
const revokeCashAccess = vi.fn()

vi.mock('./actions', () => ({
    searchReferralPeople: (...args: unknown[]) => searchReferralPeople(...args),
    loadReferralPerson: (...args: unknown[]) => loadReferralPerson(...args),
    recordReferralInvitation: (...args: unknown[]) => recordReferralInvitation(...args),
    withdrawReferralInvitation: (...args: unknown[]) => withdrawReferralInvitation(...args),
    grantCashAccess: (...args: unknown[]) => grantCashAccess(...args),
    revokeCashAccess: (...args: unknown[]) => revokeCashAccess(...args),
}))

import ReferralManager, { PersonCard } from './ReferralManager'
import type { ReferralCandidateView, ReferralPersonView } from './view'

function candidate(over: Partial<ReferralCandidateView>): ReferralCandidateView {
    return {
        selectable: true,
        personContactId: 'contact-A',
        displayName: 'Иванов Иван Иванович',
        matchedBy: ['name'],
        merged: false,
        unselectableReason: null,
        profiles: [{ driverId: 'd1', fullName: 'Иванов Иван Иванович', phone: '+79221853150', licenseNumber: '9912 345678', parkName: 'Парк 1', employment: 'СМЗ', dismissed: false }],
        ...over,
    }
}

function person(over: Partial<ReferralPersonView> = {}): ReferralPersonView {
    return {
        personContactId: 'contact-A',
        displayName: 'Иванов Иван Иванович',
        merged: false,
        profiles: candidate({}).profiles,
        cashIdentity: 'confirmed',
        access: { state: 'none', manualGrant: null, referralEntitlement: null, history: [] },
        invited: [],
        invitedBy: [],
        ...over,
    }
}

beforeEach(() => {
    for (const mock of [searchReferralPeople, loadReferralPerson, recordReferralInvitation, withdrawReferralInvitation, grantCashAccess, revokeCashAccess]) mock.mockReset()
    loadReferralPerson.mockResolvedValue({ status: 'ok', person: person() })
})
afterEach(() => cleanup())

const text = (element: Element) => (element.textContent ?? '').replace(/\s+/gu, ' ').trim()
const disabled = (element: Element) => (element as HTMLButtonElement).disabled

async function pick(label: string, query: string, name: string) {
    fireEvent.change(screen.getByLabelText(label), { target: { value: query } })
    fireEvent.keyDown(screen.getByLabelText(label), { key: 'Enter' })
    const row = await screen.findByText(name)
    fireEvent.click(row)
}

describe('recording an invitation', () => {
    it('records only the two people the manager picked, and says access did not change', async () => {
        searchReferralPeople
            .mockResolvedValueOnce({ status: 'ok', truncated: false, candidates: [candidate({}), candidate({ personContactId: 'contact-N', displayName: 'Иванов Иван Сергеевич' })] })
            .mockResolvedValueOnce({ status: 'ok', truncated: false, candidates: [candidate({ personContactId: 'contact-B', displayName: 'Сидоров Сергей Петрович' })] })
        recordReferralInvitation.mockResolvedValue({ status: 'done', code: 'recorded', attributionId: 'att-1' })
        render(<ReferralManager writesAvailable />)

        const button = screen.getByRole('button', { name: 'Закрепить приглашение' })
        expect(disabled(button)).toBe(true)
        await pick('Кто пригласил', 'Иванов', 'Иванов Иван Иванович')
        expect(disabled(button)).toBe(true)
        await pick('Кого пригласил', 'Сидоров', 'Сидоров Сергей Петрович')
        expect(disabled(button)).toBe(false)
        fireEvent.click(button)

        await waitFor(() => expect(recordReferralInvitation).toHaveBeenCalledTimes(1))
        expect(recordReferralInvitation.mock.calls[0][0]).toMatchObject({ inviterContactId: 'contact-A', inviteeContactId: 'contact-B' })
        expect(recordReferralInvitation.mock.calls[0][0].requestId).toMatch(/^[0-9a-f-]{36}$/)
        expect(await screen.findByText('Приглашение закреплено. Доступ к компенсации не изменился.')).toBeTruthy()
        // The inviter's card opens so the manager sees the new invitation.
        await waitFor(() => expect(loadReferralPerson).toHaveBeenCalledWith('contact-A'))
        expect(grantCashAccess).not.toHaveBeenCalled()
    })

    it('shows a profile without a person but does not let it be picked, and says when nobody matched', async () => {
        searchReferralPeople
            .mockResolvedValueOnce({ status: 'ok', truncated: false, candidates: [candidate({ selectable: false, personContactId: null, unselectableReason: 'no_contact', displayName: 'Петров Пётр' })] })
            .mockResolvedValueOnce({ status: 'ok', truncated: false, candidates: [] })
        render(<ReferralManager writesAvailable />)
        fireEvent.change(screen.getByLabelText('Кто пригласил'), { target: { value: 'Петров' } })
        fireEvent.keyDown(screen.getByLabelText('Кто пригласил'), { key: 'Enter' })
        const row = (await screen.findByText('Петров Пётр')).closest('button')!
        expect(disabled(row)).toBe(true)
        expect(screen.getByText('Профиль не привязан к контакту — выбрать нельзя')).toBeTruthy()

        fireEvent.change(screen.getByLabelText('Кого пригласил'), { target: { value: 'Кузьмин' } })
        fireEvent.keyDown(screen.getByLabelText('Кого пригласил'), { key: 'Enter' })
        expect(await screen.findByTestId('no-results')).toBeTruthy()
    })

    it('says who already holds an invitee when the backend refuses', async () => {
        searchReferralPeople
            .mockResolvedValueOnce({ status: 'ok', truncated: false, candidates: [candidate({ personContactId: 'contact-P', displayName: 'Петров Алексей' })] })
            .mockResolvedValueOnce({ status: 'ok', truncated: false, candidates: [candidate({ personContactId: 'contact-B', displayName: 'Сидоров Сергей Петрович' })] })
        recordReferralInvitation.mockResolvedValue({ status: 'refused', reason: 'invitee_already_attributed', detail: 'Иванов Иван Иванович' })
        render(<ReferralManager writesAvailable />)
        await pick('Кто пригласил', 'Петров', 'Петров Алексей')
        await pick('Кого пригласил', 'Сидоров', 'Сидоров Сергей Петрович')
        fireEvent.click(screen.getByRole('button', { name: 'Закрепить приглашение' }))
        expect(await screen.findByText('Этот водитель уже закреплён за другим пригласившим. Пригласивший: Иванов Иван Иванович.')).toBeTruthy()
    })

    it('offers no write while there is no signed staff session, says why, and leads to the staff sign-in', () => {
        render(<ReferralManager writesAvailable={false} />)
        expect(text(screen.getByTestId('writes-unavailable'))).toContain('нужен подписанный вход сотрудника')
        expect(screen.getByRole('link', { name: 'Войти' }).getAttribute('href')).toBe('/login')
        expect(disabled(screen.getByRole('button', { name: 'Закрепить приглашение' }))).toBe(true)
    })

    it('tells a verified employee without the Cash role that only an administrator writes, with no sign-in to offer', () => {
        render(<ReferralManager writesAvailable={false} writesRefusal="staff_role_not_allowed" />)
        expect(text(screen.getByTestId('writes-unavailable'))).toBe('Закреплять приглашения и выдавать доступ может только администратор.')
        expect(screen.queryByRole('link', { name: 'Войти' })).toBeNull()
        expect(disabled(screen.getByRole('button', { name: 'Закрепить приглашение' }))).toBe(true)
    })
})

describe('a search hit where not every word matched', () => {
    it('says so for a person found only by a partial name, and still lets the manager pick them', async () => {
        searchReferralPeople.mockResolvedValue({ status: 'ok', truncated: false, candidates: [
            candidate({ personContactId: 'contact-T', displayName: 'Тарасов Олег', matchedBy: ['partial'] }),
            candidate({ personContactId: 'contact-F', displayName: 'Тарасов Олег Петрович', matchedBy: ['name'] }),
            candidate({ personContactId: 'contact-P', displayName: 'Тарасов Олег', matchedBy: ['partial', 'phone'] }),
        ] })
        render(<ReferralManager writesAvailable />)
        fireEvent.change(screen.getByLabelText('Найти водителя'), { target: { value: 'Тарасов Олег Петрович' } })
        fireEvent.keyDown(screen.getByLabelText('Найти водителя'), { key: 'Enter' })
        const rows = await screen.findAllByRole('listitem')
        const warned = rows.map((row) => row.querySelector('[data-testid="partial-name-match"]') !== null)
        expect(warned).toEqual([true, false, false])
        expect(text(rows[0])).toContain('Совпали не все слова')
        expect(text(rows[0])).toContain('совпало: ФИО не полностью')
        expect(disabled(rows[0].querySelector('button')!)).toBe(false)
    })
})

describe('the person card', () => {
    it('shows whom the person invited and that they hold no access yet', () => {
        render(<PersonCard writesAvailable onChanged={() => {}} person={person({
            invited: [
                { attributionId: 'att-1', source: 'manager', state: 'recorded', otherContactId: 'contact-B', otherName: 'Сидоров Сергей', at: '2026-11-06T10:00:00.000Z', recordedBy: 'Мария Иванова', reason: 'Приглашение закреплено менеджером', withdrawnAt: null, withdrawnBy: null, withdrawable: true, version: 0 },
                { attributionId: 'att-2', source: 'telegram', state: 'qualified', otherContactId: 'contact-K', otherName: 'Кузнецов Андрей', at: '2026-11-01T10:00:00.000Z', recordedBy: null, reason: null, withdrawnAt: null, withdrawnBy: null, withdrawable: false, version: 2 },
            ],
        })} />)
        expect(text(screen.getByTestId('access-state'))).toContain('Бессрочного доступа нет')
        const invited = screen.getAllByTestId('invitation')
        expect(text(invited[0])).toContain('Сидоров Сергей')
        expect(text(invited[0])).toContain('закреплён менеджером · Мария Иванова')
        expect(text(invited[1])).toContain('Кузнецов Андрей')
        expect(text(invited[1])).toContain('засчитан по ссылке в Telegram')
        // Only a manager's own record can be withdrawn.
        expect(screen.getAllByRole('button', { name: 'Снять закрепление' })).toHaveLength(1)
    })

    it('grants for the referral programme naming an invitation, and needs words for another decision', async () => {
        grantCashAccess.mockResolvedValue({ status: 'done', code: 'granted' })
        const onChanged = vi.fn()
        render(<PersonCard writesAvailable onChanged={onChanged} person={person({
            invited: [{ attributionId: 'att-1', source: 'manager', state: 'recorded', otherContactId: 'contact-B', otherName: 'Сидоров Сергей', at: '2026-11-06T10:00:00.000Z', recordedBy: null, reason: null, withdrawnAt: null, withdrawnBy: null, withdrawable: true, version: 0 }],
        })} />)
        fireEvent.click(screen.getByRole('button', { name: 'Предоставить бессрочный доступ' }))
        fireEvent.click(screen.getByLabelText('Другое решение менеджера'))
        fireEvent.change(screen.getByLabelText('Комментарий к доступу'), { target: { value: 'коротко' } })
        expect(disabled(screen.getByRole('button', { name: 'Предоставить' }))).toBe(true)
        fireEvent.click(screen.getByLabelText('Реферальная программа'))
        expect((screen.getByLabelText('За приглашение') as HTMLSelectElement).value).toBe('att-1')
        fireEvent.click(screen.getByRole('button', { name: 'Предоставить' }))
        await waitFor(() => expect(grantCashAccess).toHaveBeenCalledTimes(1))
        expect(grantCashAccess.mock.calls[0][0]).toMatchObject({ contactId: 'contact-A', basis: 'referral_program', referralAttributionId: 'att-1' })
        await waitFor(() => expect(onChanged).toHaveBeenCalled())
    })

    it('shows a standing grant with its basis and offers only a revoke', async () => {
        revokeCashAccess.mockResolvedValue({ status: 'done', code: 'revoked' })
        render(<PersonCard writesAvailable onChanged={() => {}} person={person({
            invited: [{ attributionId: 'att-1', source: 'manager', state: 'recorded', otherContactId: 'contact-B', otherName: 'Сидоров Сергей', at: '2026-11-06T10:00:00.000Z', recordedBy: null, reason: null, withdrawnAt: null, withdrawnBy: null, withdrawable: true, version: 0 }],
            access: {
                state: 'granted',
                manualGrant: { since: '2026-11-06T11:00:00.000Z', basis: 'referral_program', referralAttributionId: 'att-1', operatorLabel: 'Мария Иванова' },
                referralEntitlement: null,
                history: [{ kind: 'manual_granted', occurredAt: '2026-11-06T11:00:00.000Z', operatorLabel: 'Мария Иванова', system: false, reason: 'Реферальная программа', basis: 'referral_program', referralAttributionId: 'att-1', stale: false }],
            },
        })} />)
        expect(text(screen.getByTestId('access-basis'))).toContain('Реферальная программа — за приглашение: Сидоров Сергей')
        expect(text(screen.getByTestId('access-basis'))).toContain('Мария Иванова')
        expect(screen.queryByRole('button', { name: 'Предоставить бессрочный доступ' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Отозвать доступ' }))
        fireEvent.click(screen.getAllByRole('button', { name: 'Отозвать доступ' }).at(-1)!)
        await waitFor(() => expect(revokeCashAccess).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'contact-A' })))
    })

    it('offers no grant for a person whose contacts were merged, and no write without a signed session', () => {
        const { unmount } = render(<PersonCard writesAvailable onChanged={() => {}} person={person({ merged: true, cashIdentity: 'merged' })} />)
        expect(disabled(screen.getByRole('button', { name: 'Предоставить бессрочный доступ' }))).toBe(true)
        unmount()
        render(<PersonCard writesAvailable={false} onChanged={() => {}} person={person()} />)
        expect(disabled(screen.getByRole('button', { name: 'Предоставить бессрочный доступ' }))).toBe(true)
    })
})
