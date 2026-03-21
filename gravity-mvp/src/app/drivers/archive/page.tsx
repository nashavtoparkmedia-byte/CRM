import { getDriversWithCells } from '../actions'
import ArchiveClient from './ArchiveClient'

export const dynamic = 'force-dynamic'

export default async function ArchivePage({
    searchParams,
}: {
    searchParams: Promise<{
        page?: string
        search?: string
    }>
}) {
    const params = await searchParams
    const page = Number(params.page) || 1
    const search = params.search || ''

    // Only fetch drivers that have status 'gone' to simulate the archive
    const result = await getDriversWithCells(page, 50, {
        search: search || undefined,
        status: 'gone', // Force only archived ('gone') drivers
        dateRange: 30, // For archive, often helpful to see a bit more history
    })

    return (
        <div className="flex flex-col gap-8 animate-in fade-in duration-500">
            <div className="flex flex-col gap-2">
                <h1 className="text-3xl font-bold text-foreground">Архив / Ушедшие водители</h1>
                <p className="text-sm text-muted-foreground w-full max-w-2xl">
                    Список водителей, которые давно не работали или были переведены в статус оттока. 
                </p>
            </div>
            
            <ArchiveClient
                initialDrivers={result.drivers}
                total={result.total}
                currentPage={page}
                initialSearch={search}
            />
        </div>
    )
}
