import { getTelegramConnections } from '../../../tg-actions'
import TelegramLoginClient from './TelegramLoginClient'
import TelegramManualLinkClient from './TelegramManualLinkClient'
import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionDescription } from '@/components/ui/SectionDescription'
import { PageContainer } from '@/components/ui/PageContainer'

export const dynamic = 'force-dynamic'

export default async function TelegramSettingsPage() {
    const connections = await getTelegramConnections()
    
    return (
        <PageContainer>
            <div className="flex flex-col gap-8 animate-in fade-in duration-500 pb-12 mt-4">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b pb-6">
                    <div>
                        <h1 className="text-3xl font-bold text-foreground">Интеграция Telegram</h1>
                        <p className="text-muted-foreground mt-2 max-w-lg text-sm mb-4">
                            Подключите ваш личный аккаунт Telegram для отправки сообщений напрямую водителям.
                        </p>
                        <SectionDescription sectionKey="settings_telegram" />
                    </div>
                    <Button variant="outline" asChild>
                        <Link
                            href="https://my.telegram.org"
                            target="_blank"
                            className="flex items-center gap-2"
                        >
                            Получить API Ключи <ExternalLink size={14} />
                        </Link>
                    </Button>
                </div>

                <TelegramLoginClient initialConnections={connections} />

                <div className="border-t pt-8 mt-4">
                    <h2 className="text-2xl font-bold text-foreground mb-6">Инструменты Телеграм Бота</h2>
                    <TelegramManualLinkClient />
                </div>
            </div>
        </PageContainer>
    )
}
