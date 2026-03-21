import { getDashboardStats } from './dashboard/actions'
import { DashboardKPI } from './dashboard/components/DashboardKPI'
import { DashboardCard } from './dashboard/components/DashboardCard'
import { dashboardCards } from '@/lib/mock/dashboardData'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
    // Only load stats for the KPI top bar, everything else is mocked for MVP
    const stats = await getDashboardStats()

    return (
        <div className="flex flex-col gap-6 animate-in fade-in duration-500">
            {/* Header */}
            <div>
                <h1 className="text-2xl font-bold text-foreground">Панель управления</h1>
                <p className="text-sm text-muted-foreground mt-0.5">Обзор парка за 10 секунд</p>
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
    )
}
