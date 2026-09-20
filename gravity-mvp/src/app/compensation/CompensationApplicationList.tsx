import Link from 'next/link'

import { MANAGER_STATE_LABELS, rublesFromKopecks } from './money'

export interface CompensationApplicationRowView {
    applicationId: string
    state: string
    orderDate: string
    orderId: string
    driverName: string | null
    parkName: string
    requestedKopecks: number
    orderAmountKopecks: number
    payableKopecks: number
    evidence: string
}

/**
 * The list, as rows a manager scans: when the order finished, who filed it,
 * what they asked for and what the order was worth. Every decision lives on the
 * application's own page, so nothing monetary happens from here.
 */
export default function CompensationApplicationList({ rows }: { rows: CompensationApplicationRowView[] }) {
    if (rows.length === 0) {
        return <p className="text-sm text-muted" data-testid="empty-list">Заявок по этому фильтру нет.</p>
    }

    return (
        <ul className="divide-y divide-border rounded-md border border-border" data-testid="application-list">
            {rows.map((row) => (
                <li key={row.applicationId}>
                    <Link
                        href={`/compensation/${row.applicationId}`}
                        className="flex items-start justify-between gap-4 p-4 hover:bg-surface"
                    >
                        <div className="min-w-0">
                            <div className="text-[15px] font-medium text-foreground">
                                {row.orderDate} · Заказ {row.orderId}
                                <span className="ml-2 text-xs text-muted">
                                    {MANAGER_STATE_LABELS[row.state] ?? row.state}
                                </span>
                            </div>
                            <div className="mt-1 text-[13px] text-muted">
                                {row.driverName ?? 'Водитель не определён'} · {row.parkName}
                                {row.evidence === 'missing' ? ' · без скриншота' : ''}
                            </div>
                        </div>
                        <div className="shrink-0 text-right text-[13px] text-muted">
                            <div className="text-[15px] text-foreground">{rublesFromKopecks(row.payableKopecks)}</div>
                            <div>запрошено {rublesFromKopecks(row.requestedKopecks)}</div>
                            <div>заказ {rublesFromKopecks(row.orderAmountKopecks)}</div>
                        </div>
                    </Link>
                </li>
            ))}
        </ul>
    )
}
