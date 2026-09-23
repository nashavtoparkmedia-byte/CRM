import { rublesFromKopecks } from './money'

export interface CompensationBudgetPanelView {
    periodKey: string
    state: string
    limitKopecks: number
    reservedKopecks: number
    settledKopecks: number
    remainingKopecks: number
    awaitingPaymentKopecks: number
    applicationCount: number
    paidCount: number
    ledgerConsistent: boolean
}

/**
 * The month as the monetary core reports it.
 *
 * Every number here is read, never recomputed: remaining is the core's own
 * arithmetic, and a ledger that disagrees with its applications is shown as a
 * warning rather than quietly corrected.
 */
export default function CompensationBudgetPanel({ budget }: { budget: CompensationBudgetPanelView }) {
    if (budget.state === 'missing') {
        return (
            <div className="mb-6 rounded-md border border-border bg-surface px-4 py-3" data-testid="budget-panel">
                <div className="text-[15px] font-medium text-foreground">Бюджет на {budget.periodKey} не открыт</div>
                <p className="mt-1 text-[13px] text-muted">
                    Пока месяц не открыт, водители не могут подать заявку, а выплаты по нему не начисляются.
                </p>
            </div>
        )
    }

    const cells: Array<{ label: string; value: string }> = [
        { label: 'Бюджет месяца', value: rublesFromKopecks(budget.limitKopecks) },
        { label: 'Выплачено', value: rublesFromKopecks(budget.settledKopecks) },
        { label: 'Зарезервировано', value: rublesFromKopecks(budget.reservedKopecks) },
        { label: 'Ждёт выплаты', value: rublesFromKopecks(budget.awaitingPaymentKopecks) },
        { label: 'Остаток', value: rublesFromKopecks(budget.remainingKopecks) },
        { label: 'Заявок', value: String(budget.applicationCount) },
        { label: 'Выплат', value: String(budget.paidCount) },
    ]

    return (
        <div className="mb-6 rounded-md border border-border" data-testid="budget-panel">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <div className="text-[15px] font-medium text-foreground">Бюджет {budget.periodKey}</div>
                <div className="text-[13px] text-muted">{budget.state === 'open' ? 'Месяц открыт' : 'Месяц закрыт'}</div>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 sm:grid-cols-4">
                {cells.map((cell) => (
                    <div key={cell.label}>
                        <dt className="text-xs text-muted">{cell.label}</dt>
                        <dd className="text-[15px] text-foreground">{cell.value}</dd>
                    </div>
                ))}
            </dl>
            {!budget.ledgerConsistent && (
                <p className="border-t border-border px-4 py-3 text-[13px] text-destructive" data-testid="ledger-warning">
                    Счётчики бюджета не сходятся с заявками и выплатами. Не принимайте решения по этим суммам — сообщите
                    разработчикам.
                </p>
            )}
        </div>
    )
}
