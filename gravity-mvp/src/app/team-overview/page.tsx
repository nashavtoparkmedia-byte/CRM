import { getTeamOverview } from './actions'
import { PageContainer } from '@/components/ui/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { DashboardTabs } from '@/components/ui/DashboardTabs'
import TeamOverviewContent from './TeamOverviewContent'

export const dynamic = 'force-dynamic'

export default async function TeamOverviewPage() {
    const overview = await getTeamOverview()

    return (
        <PageContainer>
            <div className="flex flex-col gap-5 animate-in fade-in duration-300">
                <PageHeader
                    title="Главная"
                    description="Контроль загрузки и эффективности менеджеров"
                />
                <DashboardTabs />
                <TeamOverviewContent overview={overview} />
            </div>
        </PageContainer>
    )
}
