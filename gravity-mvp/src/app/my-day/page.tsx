import { getDailySummary } from './actions'
import { PageContainer } from '@/components/ui/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import MyDayContent from './MyDayContent'

export const dynamic = 'force-dynamic'

export default async function MyDayPage() {
    const summary = await getDailySummary()

    return (
        <PageContainer>
            <div className="flex flex-col gap-5 animate-in fade-in duration-300">
                <PageHeader
                    title="Мой день"
                    description="Задачи на сегодня и требующие внимания"
                />
                <MyDayContent summary={summary} />
            </div>
        </PageContainer>
    )
}
