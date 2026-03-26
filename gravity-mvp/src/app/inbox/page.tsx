import { getManagerTasks } from './actions'
import InboxClient from './InboxClient'
import { SectionDescription } from '@/components/ui/SectionDescription'

export const dynamic = 'force-dynamic'

export default async function InboxPage({
    searchParams,
}: {
    searchParams: Promise<{
        page?: string
        status?: string
        priority?: string
        search?: string
    }>
}) {
    const params = await searchParams
    const page = Number(params.page) || 1
    const status = params.status || 'open'
    const priority = params.priority || 'all'
    const search = params.search || ''

    const result = await getManagerTasks(
        {
            status: status !== 'all' ? status : undefined,
            priority: priority !== 'all' ? priority : undefined,
            search: search || undefined,
        },
        page
    )

    return (
        <div className="flex flex-col gap-6 h-full">
            <SectionDescription sectionKey="tasks" />
            <InboxClient
                tasks={result.tasks}
                total={result.total}
                counts={result.counts}
                currentPage={page}
                initialStatus={status}
                initialPriority={priority}
                initialSearch={search}
            />
        </div>
    )
}
