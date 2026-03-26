import { PageContainer } from '@/components/ui/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Settings as SettingsIcon } from 'lucide-react'

export const dynamic = 'force-dynamic'

export default function SettingsPage() {
    return (
        <PageContainer>
            <PageHeader
                title="Общие настройки"
                description="Управление параметрами проекта"
            />
            
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed bg-card p-12 text-center mt-6">
                <div className="mb-4 rounded-full bg-secondary p-4">
                    <SettingsIcon size={32} className="text-muted-foreground" />
                </div>
                <h3 className="mb-2 text-xl font-bold text-foreground">Общие настройки в разработке</h3>
                <p className="mb-6 max-w-sm text-sm text-muted-foreground">
                    Скоро здесь появятся системные настройки CRM. Для настройки интеграций (API, Telegram, WhatsApp) перейдите в соответствующие разделы в боковом меню.
                </p>
            </div>
        </PageContainer>
    )
}
