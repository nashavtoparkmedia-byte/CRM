import { prisma } from '@/lib/prisma'

export async function DriverActionDiagnostics({ driverId }: { driverId: string }) {
    const actions = await prisma.driverAction.findMany({
        where: { driverId, kind: 'CANCEL_ORDER' },
        orderBy: { requestedAt: 'desc' },
        take: 10,
        select: { id: true, status: true, shortOrderId: true, requestedAt: true, errorMessage: true, result: true },
    })
    const rows = actions.flatMap(action => {
        const result = action.result && typeof action.result === 'object' ? action.result as Record<string, any> : {}
        return Array.isArray(result.diagnostics) ? result.diagnostics.map((diagnostic: any, index: number) => ({ action, diagnostic, index, delivery: result.diagnosticDelivery })) : []
    })
    if (!rows.length) return null
    return <div className="mt-6 rounded-xl border p-5 bg-secondary/20">
        <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">Диагностика действий с заказами</h3>
        <div className="space-y-2">{rows.map(({ action, diagnostic, index, delivery }) =>
            <a key={`${action.id}-${index}`} href={`/api/driver-actions/diagnostics/${action.id}/${index}`} target="_blank" rel="noreferrer" className="block rounded-lg border bg-white p-3 text-sm hover:bg-secondary/40">
                <span className="font-semibold">Заказ {action.shortOrderId || '—'} · {diagnostic.step || `этап ${index + 1}`}</span>
                <span className="ml-2 text-muted-foreground">{new Date(diagnostic.capturedAt || action.requestedAt).toLocaleString('ru-RU')}</span>
                <div className="text-xs text-muted-foreground">{action.status}{action.errorMessage ? ` · ${action.errorMessage}` : ''}{delivery ? ' · уведомление зафиксировано' : ''}</div>
            </a>)}</div>
    </div>
}
