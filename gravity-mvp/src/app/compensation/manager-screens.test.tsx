import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The manager screens, rendered.
 *
 * Two things have to hold whatever the markup looks like: the screen offers
 * only the actions the backend said are open, and it never shows a monetary
 * change the backend did not confirm. Everything else here is the wording a
 * manager reads before moving real money.
 */

const runCompensationManagerAction = vi.fn()
const push = vi.fn()
const refresh = vi.fn()

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push, refresh, replace: vi.fn() }),
    usePathname: () => '/compensation',
}))
vi.mock('./actions', () => ({
    runCompensationManagerAction: (...args: unknown[]) => runCompensationManagerAction(...args),
}))

import CompensationApplicationList from './CompensationApplicationList'
import CompensationBudgetPanel from './CompensationBudgetPanel'
import CompensationFilters from './CompensationFilters'
import CompensationApplicationDetail, {
    type CompensationApplicationDetailView,
} from './[applicationId]/CompensationApplicationDetail'

function detailView(over: Partial<CompensationApplicationDetailView> = {}): CompensationApplicationDetailView {
    return {
        applicationId: 'app-1',
        state: 'new',
        periodKey: '2026-09',
        submittedAt: '2026-09-19T12:00:00.000Z',
        driverName: 'Иванов Иван',
        driverPhone: '+79990000777',
        externalDriverProfileId: 'b'.repeat(32),
        telegramUserId: '777',
        parkName: 'Парк Йоко',
        externalParkId: 'park-1',
        orderId: '3982091',
        orderCompletedAt: '18.09 15:15',
        providerBookedAt: null,
        requestedKopecks: 30_000,
        orderAmountKopecks: 33_500,
        payableKopecks: 30_000,
        snapshot: { rawPrice: '335.0000', amountKopecks: 33_500, verifiedAt: '2026-09-18T11:00:00.000Z' },
        catalogue: { present: true, amountKopecks: 33_500, observedAt: '2026-09-19T08:00:00.000Z' },
        evidence: 'present',
        attachmentKind: 'photo',
        rejectionReason: null,
        authorization: null,
        reconciliation: null,
        settlement: null,
        history: [],
        allowedActions: ['approve', 'reject'],
        ...over,
    }
}

/** Element text with the non-breaking spaces Intl puts inside amounts flattened. */
const text = (element: Element | null): string =>
    (element?.textContent ?? '').replace(/[\u00a0\u202f]/gu, ' ')

const budget = (over: Record<string, unknown> = {}) => ({
    periodKey: '2026-09',
    state: 'open',
    limitKopecks: 500_000,
    reservedKopecks: 60_000,
    settledKopecks: 30_000,
    remainingKopecks: 410_000,
    awaitingPaymentKopecks: 30_000,
    applicationCount: 4,
    paidCount: 1,
    ledgerConsistent: true,
    ...over,
})

beforeEach(() => {
    vi.clearAllMocks()
    runCompensationManagerAction.mockResolvedValue({ code: 'performed', state: 'awaiting_payment' })
})
afterEach(cleanup)

describe('the month panel', () => {
    it('shows the ledger numbers as they are', () => {
        render(<CompensationBudgetPanel budget={budget()} />)
        expect(text(screen.getByTestId('budget-panel'))).toContain('5 000,00 ₽')
        expect(text(screen.getByTestId('budget-panel'))).toContain('4 100,00 ₽')
        expect(screen.queryByTestId('ledger-warning')).toBeNull()
    })

    it('says a month with no budget is not open, instead of showing a zero budget', () => {
        render(<CompensationBudgetPanel budget={budget({ state: 'missing', limitKopecks: 0, remainingKopecks: 0 })} />)
        expect(text(screen.getByTestId('budget-panel'))).toContain('не открыт')
        // Nothing here invites a decision on a budget that does not exist.
        expect(text(screen.getByTestId('budget-panel'))).not.toContain('Остаток')
    })

    it('warns when the ledger no longer matches its applications', () => {
        render(<CompensationBudgetPanel budget={budget({ ledgerConsistent: false })} />)
        expect(text(screen.getByTestId('ledger-warning'))).toContain('не сходятся')
    })
})

describe('the filters', () => {
    const parks = [{ externalParkId: 'park-1', name: 'Парк Йоко' }]

    it('puts every choice in the URL, so a filtered board can be shared', () => {
        render(<CompensationFilters periodKey="2026-09" state={null} externalParkId={null} parks={parks} />)

        fireEvent.change(screen.getByLabelText('Статус'), { target: { value: 'awaiting_payment' } })
        expect(push).toHaveBeenCalledWith('/compensation?month=2026-09&status=awaiting_payment')
    })

    it('drops the filter rather than sending an empty one', () => {
        render(<CompensationFilters periodKey="2026-09" state="paid" externalParkId="park-1" parks={parks} />)

        fireEvent.change(screen.getByLabelText('Парк'), { target: { value: '' } })
        expect(push).toHaveBeenCalledWith('/compensation?month=2026-09&status=paid')
    })

    it('offers only the states the backend knows', () => {
        render(<CompensationFilters periodKey="2026-09" state={null} externalParkId={null} parks={parks} />)
        const options = Array.from(screen.getByLabelText('Статус').querySelectorAll('option'))
            .map((option) => (option as HTMLOptionElement).value)
        expect(options).toEqual(['', 'new', 'awaiting_payment', 'reconciliation', 'paid', 'rejected'])
    })
})

describe('the list', () => {
    const row = {
        applicationId: 'app-1',
        state: 'new',
        orderDate: '18.09',
        orderId: '3982091',
        driverName: 'Иванов Иван',
        parkName: 'Парк Йоко',
        requestedKopecks: 30_000,
        orderAmountKopecks: 33_500,
        payableKopecks: 30_000,
        evidence: 'present',
    }

    it('shows each claim with the person, the order and both amounts', () => {
        render(<CompensationApplicationList rows={[row]} />)
        const list = screen.getByTestId('application-list')
        expect(text(list)).toContain('Иванов Иван')
        expect(text(list)).toContain('3982091')
        expect(text(list)).toContain('300,00 ₽')
        expect(text(list)).toContain('335,00 ₽')
    })

    it('flags a claim with no screenshot before anyone opens it', () => {
        render(<CompensationApplicationList rows={[{ ...row, evidence: 'missing' }]} />)
        expect(text(screen.getByTestId('application-list'))).toContain('без скриншота')
    })

    it('says so when nothing matches, rather than showing an empty frame', () => {
        render(<CompensationApplicationList rows={[]} />)
        expect(text(screen.getByTestId('empty-list'))).toContain('Заявок по этому фильтру нет')
    })

    it('decides nothing: every action lives on the claim\'s own page', () => {
        const { container } = render(<CompensationApplicationList rows={[row]} />)
        expect(container.querySelectorAll('button')).toHaveLength(0)
        expect(container.querySelector('a')!.getAttribute('href')).toBe('/compensation/app-1')
    })
})

describe('one claim', () => {
    it('offers exactly the actions the backend allowed', () => {
        render(<CompensationApplicationDetail application={detailView()} />)
        const actions = screen.getByTestId('actions')
        expect(text(actions)).toContain('Одобрить')
        expect(text(actions)).toContain('Отклонить')
        expect(text(actions)).not.toContain('Отметить выплату')
    })

    it('offers nothing on a settled claim, and says why there is nothing to do', () => {
        render(<CompensationApplicationDetail application={detailView({ state: 'paid', allowedActions: [] })} />)
        expect(text(screen.getByTestId('actions'))).toContain('Заявка закрыта')
    })

    it('asks for confirmation naming the amount before authorising money', async () => {
        render(<CompensationApplicationDetail application={detailView()} />)
        fireEvent.click(screen.getByText('Одобрить'))

        expect(text(screen.getByTestId('confirmation'))).toContain('Одобрить 300,00 ₽')
        expect(runCompensationManagerAction).not.toHaveBeenCalled()

        fireEvent.click(screen.getByText('Подтвердить'))
        await waitFor(() => expect(runCompensationManagerAction).toHaveBeenCalledWith({
            applicationId: 'app-1', action: 'approve',
        }))
    })

    it('lets a confirmation be called off without touching anything', () => {
        render(<CompensationApplicationDetail application={detailView()} />)
        fireEvent.click(screen.getByText('Одобрить'))
        fireEvent.click(screen.getByText('Отмена'))
        expect(screen.queryByTestId('confirmation')).toBeNull()
        expect(runCompensationManagerAction).not.toHaveBeenCalled()
    })

    it('will not reject without a typed reason', async () => {
        render(<CompensationApplicationDetail application={detailView()} />)
        fireEvent.click(screen.getByText('Отклонить'))

        const submit = screen.getByTestId('reject-form').querySelector('button')!
        expect(submit.disabled).toBe(true)
        fireEvent.change(screen.getByLabelText('Причина отказа'), { target: { value: '   ' } })
        expect(submit.disabled).toBe(true)

        fireEvent.change(screen.getByLabelText('Причина отказа'), { target: { value: 'Нет чека' } })
        fireEvent.click(submit)
        await waitFor(() => expect(runCompensationManagerAction).toHaveBeenCalledWith({
            applicationId: 'app-1', action: 'reject', reason: 'Нет чека',
        }))
    })

    it('shows the backend\'s answer and re-reads the page, never its own guess', async () => {
        runCompensationManagerAction.mockResolvedValue({ code: 'already_paid', state: 'paid' })
        render(<CompensationApplicationDetail application={detailView()} />)

        fireEvent.click(screen.getByText('Одобрить'))
        fireEvent.click(screen.getByText('Подтвердить'))

        await waitFor(() => expect(text(screen.getByRole('status'))).toContain('уже выплачена'))
        // The heading still shows the state the server rendered; the refresh is
        // what changes it, so nothing is ever shown as done on hope.
        expect(text(screen.getByTestId('application-detail'))).toContain('Новая')
        expect(refresh).toHaveBeenCalled()
    })

    it('names an unknown refusal rather than pretending the action worked', async () => {
        runCompensationManagerAction.mockResolvedValue({ code: 'some_new_code', state: 'new' })
        render(<CompensationApplicationDetail application={detailView()} />)
        fireEvent.click(screen.getByText('Одобрить'))
        fireEvent.click(screen.getByText('Подтвердить'))
        await waitFor(() => expect(text(screen.getByRole('status'))).toContain('some_new_code'))
    })

    it('shows the screenshot through the application, never through a file id', () => {
        const { container } = render(<CompensationApplicationDetail application={detailView()} />)
        expect(container.querySelector('[data-testid="evidence-image"]')!.getAttribute('src'))
            .toBe('/compensation/app-1/evidence')
        expect(container.innerHTML).not.toContain('tg-file')
    })

    it('says when the screenshot was never attached, and that approval is closed', () => {
        render(<CompensationApplicationDetail application={detailView({
            evidence: 'missing', allowedActions: ['reject'],
        })} />)
        expect(text(screen.getByTestId('evidence-missing'))).toContain('Одобрить заявку нельзя')
        expect(text(screen.getByTestId('actions'))).not.toContain('Одобрить')
    })

    it('warns that an approval older than a day needs reconciliation', () => {
        render(<CompensationApplicationDetail application={detailView({
            state: 'awaiting_payment',
            allowedActions: ['mark_paid', 'cancel_approval', 'declare_outcome_unknown'],
            authorization: {
                state: 'active',
                intendedBusinessDay: '2026-09-19',
                openedAt: '2026-09-19T08:00:00.000Z',
                openedByLabel: 'Менеджер Аня',
                beyondUnaidedRecall: true,
                stale: true,
            },
        })} />)
        expect(text(screen.getByTestId('authorization-block'))).toContain('нужна сверка')
    })

    it('shows an open reconciliation with the reason it was opened', () => {
        render(<CompensationApplicationDetail application={detailView({
            state: 'reconciliation',
            allowedActions: ['reconcile_paid', 'reconcile_not_paid'],
            reconciliation: { reason: 'Перевод не виден в банке', openedAt: '2026-09-20T08:40:00.000Z' },
        })} />)
        expect(text(screen.getByTestId('reconciliation-block'))).toContain('Перевод не виден в банке')
        expect(text(screen.getByTestId('actions'))).toContain('Сверка: выплачено')
    })

    it('says when the order has left the catalogue since the claim was verified', () => {
        render(<CompensationApplicationDetail application={detailView({
            catalogue: { present: false, amountKopecks: null, observedAt: null },
        })} />)
        expect(text(screen.getByTestId('catalogue-state'))).toContain('больше нет в каталоге')
    })

    it('shows the payout once it is settled, with who recorded it', () => {
        render(<CompensationApplicationDetail application={detailView({
            state: 'paid',
            allowedActions: [],
            settlement: {
                amountKopecks: 30_000,
                businessDay: '2026-09-20',
                settledAt: '2026-09-20T09:00:00.000Z',
                settledByLabel: 'Менеджер Аня',
            },
        })} />)
        expect(text(screen.getByTestId('settlement-block'))).toContain('300,00 ₽')
        expect(text(screen.getByTestId('settlement-block'))).toContain('Менеджер Аня')
    })

    it('reads the audit trail back in the words a manager uses', () => {
        render(<CompensationApplicationDetail application={detailView({
            history: [
                {
                    occurredAt: '2026-09-19T12:00:00.000Z', action: 'submit', actorLabel: 'Водитель',
                    previousState: null, nextState: 'PENDING', amountKopecks: 30_000, reason: null,
                },
                {
                    occurredAt: '2026-09-20T08:00:00.000Z', action: 'payout_authorization_opened',
                    actorLabel: 'Менеджер Аня', previousState: null, nextState: 'active',
                    amountKopecks: 30_000, reason: null,
                },
            ],
        })} />)
        const history = screen.getByTestId('history')
        expect(text(history)).toContain('Заявка подана')
        expect(text(history)).toContain('Одобрено')
        expect(text(history)).toContain('Менеджер Аня')
    })

    it('has an empty history rather than a missing section', () => {
        render(<CompensationApplicationDetail application={detailView()} />)
        expect(text(screen.getByTestId('history'))).toContain('Событий пока нет')
    })
})
