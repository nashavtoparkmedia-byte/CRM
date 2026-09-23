'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { runCompensationManagerAction, type ManagerActionName } from '../actions'
import { MANAGER_STATE_LABELS, rublesFromKopecks } from '../money'

export interface CompensationApplicationDetailView {
    applicationId: string
    state: string
    periodKey: string
    submittedAt: string
    driverName: string | null
    driverPhone: string | null
    externalDriverProfileId: string | null
    telegramUserId: string | null
    parkName: string
    externalParkId: string
    orderId: string
    orderCompletedAt: string
    providerBookedAt: string | null
    requestedKopecks: number
    orderAmountKopecks: number
    payableKopecks: number
    snapshot: { rawPrice: string; amountKopecks: number; verifiedAt: string }
    catalogue: { present: boolean; amountKopecks: number | null; observedAt: string | null }
    evidence: string
    attachmentKind: string | null
    rejectionReason: string | null
    authorization: {
        state: string
        intendedBusinessDay: string
        openedAt: string
        openedByLabel: string | null
        beyondUnaidedRecall: boolean
        stale: boolean
    } | null
    reconciliation: { reason: string; openedAt: string } | null
    settlement: { amountKopecks: number; businessDay: string; settledAt: string; settledByLabel: string | null } | null
    history: Array<{
        occurredAt: string
        action: string
        actorLabel: string
        previousState: string | null
        nextState: string | null
        amountKopecks: number | null
        reason: string | null
    }>
    allowedActions: string[]
}

/** Result codes, in sentences that say what happened and what to do next. */
const RESULT_TEXT: Record<string, string> = {
    performed: 'Готово.',
    already_done: 'Это уже было сделано.',
    application_not_found: 'Заявка не найдена.',
    state_changed: 'Заявка изменилась, пока вы смотрели на неё. Состояние обновлено.',
    already_approved: 'Заявка уже одобрена.',
    already_paid: 'Заявка уже выплачена.',
    already_rejected: 'Заявка уже отклонена.',
    evidence_missing: 'К заявке не приложен ответ поддержки. Одобрить нельзя, можно отклонить.',
    evidence_unavailable: 'Скриншот сейчас недоступен, поэтому одобрить нельзя. Попробуйте позже.',
    reject_requires_reason: 'Укажите причину отказа.',
    payout_authorization_active: 'Выплата уже начата. Сначала отмените одобрение.',
    another_payout_in_progress: 'У этого водителя уже есть незакрытая выплата.',
    daily_limit_reached: 'У водителя уже есть выплата за этот день.',
    authorization_too_old_reconcile: 'Одобрение старше суток. Отметьте «Исход неизвестен» и закройте сверкой.',
    reconciliation_required: 'Исход прошлой выплаты неизвестен. Закройте сверку.',
    reconciliation_not_open: 'Сверка уже закрыта.',
    person_reconciliation_required: 'Монетарный профиль водителя требует проверки.',
    budget_period_missing: 'Бюджет месяца не открыт.',
    clock_skew: 'Часы сервера и базы разошлись. Повторите позже.',
    not_authenticated: 'Войдите в CRM — действие не выполнено.',
    user_disabled: 'Учётная запись отключена — действие не выполнено.',
    user_identity_incomplete: 'Не удалось определить пользователя — действие не выполнено.',
    role_not_allowed: 'Недостаточно прав для этого действия.',
    unavailable: 'Действие сейчас недоступно. Состояние заявки не изменилось.',
}

const ACTION_LABELS: Record<ManagerActionName, string> = {
    approve: 'Одобрить',
    reject: 'Отклонить',
    mark_paid: 'Отметить выплату',
    cancel_approval: 'Отменить одобрение',
    declare_outcome_unknown: 'Исход неизвестен',
    reconcile_paid: 'Сверка: выплачено',
    reconcile_not_paid: 'Сверка: не выплачено',
}

const HISTORY_LABELS: Record<string, string> = {
    submit: 'Заявка подана',
    payout_authorization_opened: 'Одобрено',
    payout_authorization_cancelled: 'Одобрение отменено',
    payout_authorization_unknown: 'Исход выплаты неизвестен',
    payout_finalized: 'Выплата отмечена',
    reject: 'Отклонено',
    reconciliation_resolved: 'Сверка закрыта',
}

function confirmationFor(action: ManagerActionName, view: CompensationApplicationDetailView): string | null {
    switch (action) {
        case 'approve':
            return `Одобрить ${rublesFromKopecks(view.payableKopecks)}? Деньги вы переводите вручную после одобрения.`
        case 'mark_paid':
            return `Отметить выплату ${rublesFromKopecks(view.payableKopecks)} — деньги уже переданы?`
        case 'cancel_approval':
            return 'Отменить одобрение? Заявка вернётся в «Новые», выплата не будет отмечена.'
        case 'declare_outcome_unknown':
            return 'Отметить, что исход выплаты неизвестен? Заявка уйдёт в сверку.'
        case 'reconcile_paid':
            return `Сверка: подтвердить, что ${rublesFromKopecks(view.payableKopecks)} дошли до водителя?`
        case 'reconcile_not_paid':
            return 'Сверка: подтвердить, что выплата не состоялась? Заявка вернётся в «Новые».'
        default:
            return null
    }
}

export default function CompensationApplicationDetail({
    application,
}: {
    application: CompensationApplicationDetailView
}) {
    const router = useRouter()
    const [pending, startTransition] = useTransition()
    const [message, setMessage] = useState<string | null>(null)
    const [confirming, setConfirming] = useState<ManagerActionName | null>(null)
    const [reason, setReason] = useState('')

    function run(action: ManagerActionName, actionReason?: string) {
        setConfirming(null)
        startTransition(async () => {
            // Nothing is shown as done before the server says so: the result is
            // the authoritative code, and the page is re-read either way.
            const result = await runCompensationManagerAction({
                applicationId: application.applicationId,
                action,
                ...(actionReason === undefined ? {} : { reason: actionReason }),
            })
            setMessage(RESULT_TEXT[result.code] ?? `Действие отклонено: ${result.code}`)
            setReason('')
            router.refresh()
        })
    }

    const facts: Array<{ label: string; value: string }> = [
        { label: 'Статус', value: MANAGER_STATE_LABELS[application.state] ?? application.state },
        { label: 'Водитель', value: application.driverName ?? 'не определён' },
        { label: 'Телефон', value: application.driverPhone ?? '—' },
        { label: 'Парк', value: application.parkName },
        { label: 'Заказ', value: `${application.orderId} · завершён ${application.orderCompletedAt}` },
        { label: 'Запрошено', value: rublesFromKopecks(application.requestedKopecks) },
        { label: 'Стоимость заказа', value: rublesFromKopecks(application.orderAmountKopecks) },
        { label: 'К выплате', value: rublesFromKopecks(application.payableKopecks) },
        { label: 'Бюджетный месяц', value: application.periodKey },
    ]

    return (
        <div className="mt-4" data-testid="application-detail">
            <h1 className="text-lg font-semibold text-foreground mb-4">
                Заявка {application.orderId} · {MANAGER_STATE_LABELS[application.state] ?? application.state}
            </h1>

            {message && (
                <div className="mb-4 rounded-md border border-border bg-surface px-4 py-3 text-sm text-foreground" role="status">
                    {message}
                </div>
            )}

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-md border border-border p-4">
                {facts.map((fact) => (
                    <div key={fact.label}>
                        <dt className="text-xs text-muted">{fact.label}</dt>
                        <dd className="text-[15px] text-foreground">{fact.value}</dd>
                    </div>
                ))}
            </dl>

            <section className="mt-4 rounded-md border border-border p-4">
                <h2 className="text-[15px] font-medium text-foreground">Ответ поддержки Яндекса</h2>
                {application.evidence === 'present' ? (
                    <img
                        src={`/compensation/${application.applicationId}/evidence`}
                        alt="Ответ поддержки Яндекса"
                        data-testid="evidence-image"
                        className="mt-3 max-h-96 rounded-md border border-border"
                    />
                ) : (
                    <p className="mt-2 text-[13px] text-destructive" data-testid="evidence-missing">
                        Скриншот не приложен. Одобрить заявку нельзя.
                    </p>
                )}
            </section>

            <section className="mt-4 rounded-md border border-border p-4">
                <h2 className="text-[15px] font-medium text-foreground">Заказ в каталоге</h2>
                <p className="mt-2 text-[13px] text-muted">
                    Снимок при проверке: {rublesFromKopecks(application.snapshot.amountKopecks)} ({application.snapshot.rawPrice}).
                </p>
                <p className="mt-1 text-[13px] text-muted" data-testid="catalogue-state">
                    {application.catalogue.present && application.catalogue.amountKopecks !== null
                        ? `Сейчас в каталоге: ${rublesFromKopecks(application.catalogue.amountKopecks)}.`
                        : 'Заказа больше нет в каталоге Яндекса.'}
                </p>
            </section>

            {application.authorization && (
                <section className="mt-4 rounded-md border border-border p-4" data-testid="authorization-block">
                    <h2 className="text-[15px] font-medium text-foreground">Выплата</h2>
                    <p className="mt-2 text-[13px] text-muted">
                        Одобрил {application.authorization.openedByLabel ?? '—'} · день выплаты {application.authorization.intendedBusinessDay}
                    </p>
                    {application.authorization.beyondUnaidedRecall && (
                        <p className="mt-1 text-[13px] text-destructive">
                            Одобрению больше суток: отметить выплату напрямую уже нельзя, нужна сверка.
                        </p>
                    )}
                </section>
            )}

            {application.reconciliation && (
                <section className="mt-4 rounded-md border border-border p-4" data-testid="reconciliation-block">
                    <h2 className="text-[15px] font-medium text-foreground">Сверка</h2>
                    <p className="mt-2 text-[13px] text-destructive">
                        Исход выплаты неизвестен: {application.reconciliation.reason}
                    </p>
                </section>
            )}

            {application.settlement && (
                <section className="mt-4 rounded-md border border-border p-4" data-testid="settlement-block">
                    <h2 className="text-[15px] font-medium text-foreground">Выплачено</h2>
                    <p className="mt-2 text-[13px] text-muted">
                        {rublesFromKopecks(application.settlement.amountKopecks)} · {application.settlement.businessDay} ·
                        {' '}{application.settlement.settledByLabel ?? '—'}
                    </p>
                </section>
            )}

            {application.rejectionReason && (
                <p className="mt-4 text-[13px] text-destructive">Причина отказа: {application.rejectionReason}</p>
            )}

            <section className="mt-4" data-testid="actions">
                <div className="flex flex-wrap gap-2">
                    {application.allowedActions.map((action) => (
                        <button
                            key={action}
                            type="button"
                            disabled={pending}
                            onClick={() => setConfirming(action as ManagerActionName)}
                            className={`h-11 rounded-lg px-4 text-[15px] font-semibold disabled:opacity-50 ${
                                action === 'reject' || action === 'reconcile_not_paid'
                                    ? 'border border-border text-foreground'
                                    : 'bg-primary text-white'
                            }`}
                        >
                            {ACTION_LABELS[action as ManagerActionName] ?? action}
                        </button>
                    ))}
                    {application.allowedActions.length === 0 && (
                        <p className="text-[13px] text-muted">Заявка закрыта: действий нет.</p>
                    )}
                </div>

                {confirming === 'reject' && (
                    <div className="mt-3 flex gap-2" data-testid="reject-form">
                        <input
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                            placeholder="Причина отказа"
                            aria-label="Причина отказа"
                            className="h-11 flex-1 rounded-lg border border-border px-3 text-[15px]"
                        />
                        <button
                            type="button"
                            disabled={pending || reason.trim() === ''}
                            onClick={() => run('reject', reason)}
                            className="h-11 rounded-lg bg-destructive px-4 text-[15px] font-semibold text-white disabled:opacity-50"
                        >
                            Отклонить
                        </button>
                        <button
                            type="button"
                            onClick={() => setConfirming(null)}
                            className="h-11 rounded-lg border border-border px-4 text-[15px] text-foreground"
                        >
                            Отмена
                        </button>
                    </div>
                )}

                {confirming !== null && confirming !== 'reject' && (
                    <div className="mt-3 rounded-md border border-border p-4" data-testid="confirmation">
                        <p className="text-[15px] text-foreground">{confirmationFor(confirming, application)}</p>
                        <div className="mt-3 flex gap-2">
                            <button
                                type="button"
                                disabled={pending}
                                onClick={() => run(confirming)}
                                className="h-11 rounded-lg bg-primary px-4 text-[15px] font-semibold text-white disabled:opacity-50"
                            >
                                Подтвердить
                            </button>
                            <button
                                type="button"
                                onClick={() => setConfirming(null)}
                                className="h-11 rounded-lg border border-border px-4 text-[15px] text-foreground"
                            >
                                Отмена
                            </button>
                        </div>
                    </div>
                )}
            </section>

            <section className="mt-6" data-testid="history">
                <h2 className="text-[15px] font-medium text-foreground mb-2">История</h2>
                <ul className="divide-y divide-border rounded-md border border-border">
                    {application.history.map((entry, index) => (
                        <li key={`${entry.occurredAt}-${index}`} className="px-4 py-3 text-[13px] text-muted">
                            <span className="text-foreground">{HISTORY_LABELS[entry.action] ?? entry.action}</span>
                            {' · '}{new Date(entry.occurredAt).toLocaleString('ru-RU')}
                            {' · '}{entry.actorLabel}
                            {entry.amountKopecks === null ? '' : ` · ${rublesFromKopecks(entry.amountKopecks)}`}
                            {entry.reason ? ` · ${entry.reason}` : ''}
                        </li>
                    ))}
                    {application.history.length === 0 && (
                        <li className="px-4 py-3 text-[13px] text-muted">Событий пока нет.</li>
                    )}
                </ul>
            </section>
        </div>
    )
}
