import { getDashboardStats } from './dashboard/actions'
import { DashboardKPI } from './dashboard/components/DashboardKPI'
import { DashboardCard } from './dashboard/components/DashboardCard'
import { dashboardCards } from '@/lib/mock/dashboardData'
import { SectionDescription } from '@/components/ui/SectionDescription'
import { PageContainer } from '@/components/ui/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { DashboardTabs } from '@/components/ui/DashboardTabs'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
    // Only load stats for the KPI top bar, everything else is mocked for MVP
    const stats = await getDashboardStats()

    return (
        <PageContainer>
            <div className="flex flex-col gap-6 animate-in fade-in duration-500">
                {/* Header */}
                <div>
                    <PageHeader
                        title="Главная"
                        description="Общий обзор состояния парка"
                    />
                    <DashboardTabs />
                    <div className="mt-2 mb-4">
                        <SectionDescription sectionKey="dashboard" />
                    </div>
                </div>

                {/* Top KPI Cards (Kept as requested) */}
                <DashboardKPI stats={stats} />

                {/* New 4x2 Dashboard Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
                    {dashboardCards.map((card, index) => (
                        <DashboardCard
                            key={index}
                            title={card.title}
                            description={card.description}
                            metric={card.metric}
                            trend={(card as any).trend}
                            icon={card.icon}
                            href={card.href}
                            breakdown={card.breakdown}
                        />
                    ))}
                </div>
            </div>
        </PageContainer>
    )
}
