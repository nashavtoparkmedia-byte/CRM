import { getTelegramConnections } from '../../../tg-actions'
import TelegramLoginClient from './TelegramLoginClient'
import TelegramManualLinkClient from './TelegramManualLinkClient'
import Link from 'next/link'
import { ExternalLink, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionDescription } from '@/components/ui/SectionDescription'
import { PageContainer } from '@/components/ui/PageContainer'

export const dynamic = 'force-dynamic'

export default async function TelegramSettingsPage() {
    const connections = await getTelegramConnections()

    return (
        <PageContainer>
            <div className="flex flex-col gap-8 animate-in fade-in duration-500 pb-12">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b pb-6">
                    <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-500 mt-0.5">
                            <Send size={18} />
                        </div>
                        <div>
                            <h1 className="text-2xl font-bold text-foreground">Telegram</h1>
                            <p className="text-muted-foreground mt-1 max-w-lg text-sm">
                                Подключите личный аккаунт Telegram для отправки сообщений напрямую водителям.
                            </p>
                            <SectionDescription sectionKey="settings_telegram" />
                        </div>
                    </div>
                    <Button variant="outline" size="sm" asChild className="shrink-0">
                        <Link
                            href="https://my.telegram.org"
                            target="_blank"
                            className="flex items-center gap-2"
                        >
                            Получить API Ключи <ExternalLink size={13} />
                        </Link>
                    </Button>
                </div>

                <TelegramLoginClient initialConnections={connections} />

                <div className="border-t pt-6">
                    <h2 className="text-base font-semibold text-foreground mb-4">Инструменты Телеграм Бота</h2>
                    <TelegramManualLinkClient />
                </div>
            </div>
        </PageContainer>
    )
}
