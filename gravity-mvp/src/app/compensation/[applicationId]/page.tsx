import Link from 'next/link'

import { managerApplication, managerSession } from '../manager-data'
import CompensationApplicationDetail from './CompensationApplicationDetail'

export const dynamic = 'force-dynamic'

const SESSION_REFUSALS: Record<string, string> = {
    not_authenticated: 'Войдите в CRM, чтобы открыть заявку.',
    user_disabled: 'Учётная запись отключена.',
    user_identity_incomplete: 'Не удалось определить пользователя.',
    role_not_allowed: 'Раздел доступен менеджерам, руководителям и администраторам.',
}

export default async function CompensationApplicationPage({
    params,
}: {
    params: Promise<{ applicationId: string }>
}) {
    const session = await managerSession()
    if (!session.ok) {
        return (
            <div className="p-6 max-w-3xl">
                <h1 className="text-lg font-semibold text-foreground mb-1">Заявка на компенсацию</h1>
                <p className="text-sm text-muted">{SESSION_REFUSALS[session.refusal] ?? 'Доступ закрыт.'}</p>
            </div>
        )
    }

    const { applicationId } = await params
    const application = await managerApplication(applicationId)
    if (application === null) {
        return (
            <div className="p-6 max-w-3xl">
                <h1 className="text-lg font-semibold text-foreground mb-1">Заявка не найдена</h1>
                <Link href="/compensation" className="text-sm text-primary">К списку заявок</Link>
            </div>
        )
    }

    return (
        <div className="p-6 max-w-3xl">
            <Link href="/compensation" className="text-[13px] text-primary">← К списку заявок</Link>
            <CompensationApplicationDetail
                application={{
                    applicationId: application.applicationId,
                    state: application.state,
                    periodKey: application.periodKey,
                    submittedAt: application.submittedAt.toISOString(),
                    driverName: application.driverName,
                    driverPhone: application.driverPhone,
                    externalDriverProfileId: application.externalDriverProfileId,
                    telegramUserId: application.telegramUserId,
                    parkName: application.parkName ?? application.externalParkId,
                    externalParkId: application.externalParkId,
                    orderId: application.order.shortOrderIdDisplay ?? application.order.externalOrderId.slice(0, 8),
                    orderCompletedAt: `${application.order.localDate} ${application.order.localTime}`,
                    providerBookedAt: application.catalogue.providerBookedAt === null
                        ? null
                        : application.catalogue.providerBookedAt.toISOString(),
                    requestedKopecks: application.requestedKopecks,
                    orderAmountKopecks: application.orderAmountKopecks,
                    payableKopecks: application.payableKopecks,
                    snapshot: {
                        rawPrice: application.snapshot.rawPrice,
                        amountKopecks: application.snapshot.amountKopecks,
                        verifiedAt: application.snapshot.verifiedAt.toISOString(),
                    },
                    catalogue: {
                        present: application.catalogue.present,
                        amountKopecks: application.catalogue.amountKopecks,
                        observedAt: application.catalogue.observedAt === null
                            ? null
                            : application.catalogue.observedAt.toISOString(),
                    },
                    evidence: application.evidence,
                    attachmentKind: application.attachmentKind,
                    rejectionReason: application.rejectionReason,
                    authorization: application.authorization === null ? null : {
                        state: application.authorization.state,
                        intendedBusinessDay: application.authorization.intendedBusinessDay,
                        openedAt: application.authorization.openedAt.toISOString(),
                        openedByLabel: application.authorization.openedByLabel,
                        beyondUnaidedRecall: application.authorization.age.beyondUnaidedRecall,
                        stale: application.authorization.age.stale,
                    },
                    reconciliation: application.reconciliation === null ? null : {
                        reason: application.reconciliation.reason,
                        openedAt: application.reconciliation.openedAt.toISOString(),
                    },
                    settlement: application.settlement === null ? null : {
                        amountKopecks: application.settlement.amountKopecks,
                        businessDay: application.settlement.businessDay,
                        settledAt: application.settlement.settledAt.toISOString(),
                        settledByLabel: application.settlement.settledByLabel,
                    },
                    history: application.history.map((entry) => ({
                        occurredAt: entry.occurredAt.toISOString(),
                        action: entry.action,
                        actorLabel: entry.actorLabel,
                        previousState: entry.previousState,
                        nextState: entry.nextState,
                        amountKopecks: entry.amountKopecks,
                        reason: entry.reason,
                    })),
                    allowedActions: application.allowedActions,
                }}
            />
        </div>
    )
}
