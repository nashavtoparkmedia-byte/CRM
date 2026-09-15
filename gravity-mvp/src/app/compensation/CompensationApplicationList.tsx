'use client'

import { useState, useTransition } from 'react'

import {
    approveCompensationApplication,
    markCompensationApplicationPaid,
    rejectCompensationApplication,
    type CompensationApplicationView,
} from './actions'

const STATUS_LABELS: Record<string, string> = {
    submitted: 'Новая',
    awaiting_payment: 'Ждёт выплаты',
    paid: 'Выплачено',
    rejected: 'Отклонено',
}

/** Refusals come back as codes; the manager needs a sentence. */
const REFUSAL_LABELS: Record<string, string> = {
    approve_requires_pending: 'Заявку уже одобрили или закрыли.',
    not_authenticated: 'Войдите в CRM — действие не выполнено.',
    user_disabled: 'Учётная запись отключена — действие не выполнено.',
    user_identity_incomplete: 'Не удалось определить пользователя — действие не выполнено.',
    reject_requires_no_live_authorization: 'Выплата уже начата — сначала закройте её.',
    mark_paid_requires_authorization: 'Сначала одобрите заявку.',
    reject_requires_reason: 'Укажите причину отказа.',
    authorization_evidence_missing: 'Нет данных авторизации выплаты.',
    application_not_found: 'Заявка не найдена.',
}

function rubles(kopecks: number): string {
    return `${(kopecks / 100).toFixed(2)} ₽`
}

export default function CompensationApplicationList({
    applications,
}: {
    applications: CompensationApplicationView[]
}) {
    const [pending, startTransition] = useTransition()
    const [message, setMessage] = useState<string | null>(null)
    const [rejecting, setRejecting] = useState<string | null>(null)
    const [reason, setReason] = useState('')


    function run(action: () => Promise<{ ok: boolean; refusal?: string }>) {
        startTransition(async () => {
            const result = await action()
            setMessage(result.ok
                ? null
                : REFUSAL_LABELS[result.refusal ?? ''] ?? `Действие отклонено: ${result.refusal}`)
        })
    }

    if (applications.length === 0) {
        return <p className="text-sm text-muted">Заявок пока нет.</p>
    }

    return (
        <div>
            {message && (
                <div className="mb-4 rounded-md border border-border bg-surface px-4 py-3 text-sm text-foreground">
                    {message}
                </div>
            )}
            <ul className="divide-y divide-border rounded-md border border-border">
                {applications.map((application) => (
                    <li key={application.applicationId} className="p-4">
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                                <div className="text-[15px] font-medium text-foreground">
                                    Заказ {application.shortOrderId ?? application.externalOrderId.slice(0, 8)}
                                    <span className="ml-2 text-xs text-muted">{STATUS_LABELS[application.status] ?? application.status}</span>
                                </div>
                                <div className="mt-1 text-[13px] text-muted">
                                    Парк {application.externalParkId} · Контакт {application.boundContactIds.join(', ') || '—'}
                                    {application.telegramUserId ? ` · Telegram ${application.telegramUserId}` : ''}
                                </div>
                                <div className="mt-1 text-[13px] text-muted">
                                    Запрошено {rubles(application.requestedKopecks)} · Заказ {rubles(application.verifiedKopecks)} · К выплате {rubles(application.payableKopecks)}
                                </div>
                                {application.attachmentFileId && (
                                    <div className="mt-1 text-[13px] text-muted">
                                        Ответ Яндекса: {application.attachmentKind} {application.attachmentFileId}
                                    </div>
                                )}
                                {application.rejectionReason && (
                                    <div className="mt-1 text-[13px] text-destructive">
                                        Причина отказа: {application.rejectionReason}
                                    </div>
                                )}
                                {application.hasOpenReconciliation && (
                                    <div className="mt-1 text-[13px] text-destructive">
                                        Требуется сверка: исход выплаты неизвестен.
                                    </div>
                                )}
                            </div>
                            <div className="flex shrink-0 flex-col gap-2">
                                {application.status === 'submitted' && (
                                    <button
                                        type="button"
                                        disabled={pending}
                                        onClick={() => run(() => approveCompensationApplication(application.applicationId))}
                                        className="h-11 rounded-lg bg-primary px-4 text-[15px] font-semibold text-white disabled:opacity-50"
                                    >
                                        Одобрить
                                    </button>
                                )}
                                {(application.status === 'awaiting_payment' || application.hasOpenReconciliation) && (
                                    <button
                                        type="button"
                                        disabled={pending}
                                        onClick={() => run(() => markCompensationApplicationPaid(application.applicationId))}
                                        className="h-11 rounded-lg bg-accent px-4 text-[15px] font-semibold text-white disabled:opacity-50"
                                    >
                                        Выплачено
                                    </button>
                                )}
                                {application.status === 'submitted' && !application.hasLiveAuthorization && (
                                    <button
                                        type="button"
                                        disabled={pending}
                                        onClick={() => setRejecting(application.applicationId)}
                                        className="h-11 rounded-lg border border-border px-4 text-[15px] text-foreground disabled:opacity-50"
                                    >
                                        Отклонить
                                    </button>
                                )}
                            </div>
                        </div>

                        {rejecting === application.applicationId && (
                            <div className="mt-3 flex gap-2">
                                <input
                                    value={reason}
                                    onChange={(event) => setReason(event.target.value)}
                                    placeholder="Причина отказа"
                                    className="h-11 flex-1 rounded-lg border border-border px-3 text-[15px]"
                                />
                                <button
                                    type="button"
                                    disabled={pending || reason.trim() === ''}
                                    onClick={() => {
                                        run(() => rejectCompensationApplication(application.applicationId, reason))
                                        setRejecting(null)
                                        setReason('')
                                    }}
                                    className="h-11 rounded-lg bg-destructive px-4 text-[15px] font-semibold text-white disabled:opacity-50"
                                >
                                    Отклонить
                                </button>
                            </div>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    )
}
