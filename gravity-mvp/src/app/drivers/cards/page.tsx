import { getDriverCards } from '../actions'
import { getTelegramConnections } from '../../tg-actions'
import CardsClient from './CardsClient'

export const dynamic = 'force-dynamic'

export default async function CardsPage({
    searchParams,
}: {
    searchParams: Promise<{
        page?: string
        search?: string
        segment?: string
        status?: string
        dateRange?: string
        sortBy?: string
    }>
}) {
    const params = await searchParams
    const page = Number(params.page) || 1
    const search = params.search || ''
    const segment = params.segment || 'all'
    const status = params.status || 'all'
    const dateRange = Number(params.dateRange) || 14
    const sortBy = params.sortBy || 'score'

    const result = await getDriverCards(page, 20, {
        search: search || undefined,
        segment: segment !== 'all' ? segment : undefined,
        status: status !== 'all' ? status : undefined,
        dateRange,
        sortBy: sortBy as 'score' | 'name',
        sortOrder: sortBy === 'name' ? 'asc' : 'desc',
    })

    const telegramConnections = await getTelegramConnections()

    return (
        <CardsClient
            initialDrivers={result.drivers}
            total={result.total}
            currentPage={page}
            initialSearch={search}
            initialSegment={segment}
            initialStatus={status}
            initialDateRange={dateRange}
            initialSortBy={sortBy}
            telegramConnections={telegramConnections}
        />
    )
}
