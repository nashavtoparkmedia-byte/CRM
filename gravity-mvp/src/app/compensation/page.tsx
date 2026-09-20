import Link from 'next/link'

import CompensationApplicationList from './CompensationApplicationList'
import CompensationBudgetPanel from './CompensationBudgetPanel'
import CompensationFilters from './CompensationFilters'
import { managerBoard, managerSession } from './manager-data'

export const dynamic = 'force-dynamic'

const SESSION_REFUSALS: Record<string, string> = {
    not_authenticated: 'Войдите в CRM, чтобы открыть компенсации.',
    user_disabled: 'Учётная запись отключена.',
    user_identity_incomplete: 'Не удалось определить пользователя.',
    role_not_allowed: 'Раздел доступен менеджерам, руководителям и администраторам.',
}

export default async function CompensationPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
    const session = await managerSession()
    if (!session.ok) {
        return (
            <div className="p-6 max-w-5xl">
                <h1 className="text-lg font-semibold text-foreground mb-1">Компенсации наличными</h1>
                <p className="text-sm text-muted">{SESSION_REFUSALS[session.refusal] ?? 'Доступ закрыт.'}</p>
            </div>
        )
    }

    const params = await searchParams
    const single = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? null
    const board = await managerBoard({
        periodKey: single(params.month),
        state: single(params.status),
        externalParkId: single(params.park),
        cursor: single(params.cursor),
    })

    return (
        <div className="p-6 max-w-5xl">
            <h1 className="text-lg font-semibold text-foreground mb-1">Компенсации наличными</h1>
            <p className="text-sm text-muted mb-6">
                Заявки водителей на компенсацию наличных заказов. Выплата ручная.
            </p>

            <CompensationBudgetPanel budget={board.budget} />
            <CompensationFilters
                periodKey={board.periodKey}
                state={board.list.filter.state}
                externalParkId={board.list.filter.externalParkId}
                parks={board.parks}
            />
            <CompensationApplicationList rows={board.list.rows.map((row) => ({
                applicationId: row.applicationId,
                state: row.state,
                orderDate: `${row.order.localDate} ${row.order.localTime}`,
                orderId: row.order.shortOrderIdDisplay ?? row.order.externalOrderId.slice(0, 8),
                driverName: row.driverName,
                parkName: row.parkName ?? row.externalParkId,
                requestedKopecks: row.requestedKopecks,
                orderAmountKopecks: row.orderAmountKopecks,
                payableKopecks: row.payableKopecks,
                evidence: row.evidence,
            }))} />

            {board.list.nextCursor && (
                <div className="mt-4">
                    <Link
                        href={{
                            pathname: '/compensation',
                            query: {
                                month: board.periodKey,
                                ...(board.list.filter.state ? { status: board.list.filter.state } : {}),
                                ...(board.list.filter.externalParkId ? { park: board.list.filter.externalParkId } : {}),
                                cursor: board.list.nextCursor,
                            },
                        }}
                        className="inline-flex h-11 items-center rounded-lg border border-border px-4 text-[15px] text-foreground"
                    >
                        Показать ещё
                    </Link>
                </div>
            )}
        </div>
    )
}
