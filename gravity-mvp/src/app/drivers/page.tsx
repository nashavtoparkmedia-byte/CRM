import { getDriversWithCells } from './actions'
import { getTelegramConnections } from '../tg-actions'
import DriversClient from './DriversClient'

export const dynamic = 'force-dynamic'

export default async function DriversPage({
    searchParams,
}: {
    searchParams: Promise<{
        page?: string
        search?: string
        segment?: string
        status?: string
        dateRange?: string
        from?: string
        to?: string
        pageSize?: string
        excludeInactive?: string
    }>
}) {
    const params = await searchParams
    const page = Number(params.page) || 1
    const search = params.search || ''
    const segment = params.segment || 'all'
    const status = params.status || 'all'
    const dateRange = Number(params.dateRange) || 14
    const fromDate = params.from
    const toDate = params.to
    const pageSize = Number(params.pageSize) || 50
    const excludeInactive = params.excludeInactive === 'true'

    const result = await getDriversWithCells(page, pageSize, {
        search: search || undefined,
        segment: segment !== 'all' ? segment : undefined,
        status: status !== 'all' ? status : undefined,
        dateRange,
        fromDate,
        toDate,
        excludeGone: true,
        excludeInactive,
    })
    
    const telegramConnections = await getTelegramConnections()

    return (
        <div className="flex flex-col gap-8">
            <DriversClient
                initialDrivers={result.drivers}
                total={result.total}
                currentPage={page}
                segmentCounts={result.segmentCounts}
                initialSearch={search}
                initialSegment={segment}
                initialStatus={status}
                initialDateRange={dateRange}
                fromDate={fromDate}
                toDate={toDate}
                initialPageSize={pageSize}
                initialExcludeInactive={excludeInactive}
                telegramConnections={telegramConnections}
            />
        </div>
    )
}
