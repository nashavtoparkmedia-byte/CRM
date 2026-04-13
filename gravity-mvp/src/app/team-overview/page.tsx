import { getTeamOverview } from './actions'
import { PageContainer } from '@/components/ui/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import TeamOverviewContent from './TeamOverviewContent'

export const dynamic = 'force-dynamic'

export default async function TeamOverviewPage() {
    const overview = await getTeamOverview()

    return (
        <PageContainer>
            <div className="flex flex-col gap-5 animate-in fade-in duration-300">
                <PageHeader
                    title="Команда"
                    description="Контроль загрузки и эффективности менеджеров"
                />
                <TeamOverviewContent overview={overview} />
            </div>
        </PageContainer>
    )
}
