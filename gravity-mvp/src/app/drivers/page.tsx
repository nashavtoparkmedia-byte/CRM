import { getDriversWithCells } from './actions'
import { listOperationalTelegramConnectionsV1 } from '@/infrastructure/telegram/operational-capabilities'
import DriversClient from './DriversClient'
import { SectionDescription } from '@/infrastructure/ui/SectionDescription'
import {
    IntegrationAdminAuthorizationError,
} from '@/modules/identity-access/public/v1'

export const dynamic = 'force-dynamic'

import { PageContainer } from '@/infrastructure/ui/PageContainer'

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
    
    let telegramConnections: Awaited<ReturnType<typeof listOperationalTelegramConnectionsV1>>
    try {
        telegramConnections = await listOperationalTelegramConnectionsV1()
    } catch (error) {
        if (!(error instanceof IntegrationAdminAuthorizationError)) throw error
        telegramConnections = []
    }

    return (
        <PageContainer>
            <div className="flex flex-col gap-6">
                <SectionDescription sectionKey="drivers" />
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
        </PageContainer>
    )
}
