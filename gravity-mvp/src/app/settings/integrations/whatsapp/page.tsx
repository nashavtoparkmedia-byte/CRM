import { getWhatsAppConnections } from './whatsapp-actions'
import { WhatsAppDashboard } from './WhatsAppDashboard'
import { SectionDescription } from '@/components/ui/SectionDescription'
import { MessageCircle } from 'lucide-react'
import { PageContainer } from '@/components/ui/PageContainer'

export const dynamic = 'force-dynamic'

export const metadata = {
    title: 'WhatsApp — Yoko CRM',
    description: 'Connect personal WhatsApp accounts to send messages to drivers.',
}

export default async function WhatsAppPage() {
    const connections = await getWhatsAppConnections()
    return (
        <PageContainer>
            <div className="flex flex-col gap-8 animate-in fade-in duration-500 pb-12">
                <div className="flex items-start gap-3 border-b pb-6">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-100 text-green-600 mt-0.5">
                        <MessageCircle size={18} />
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold text-foreground">WhatsApp</h1>
                        <p className="text-muted-foreground mt-1 max-w-lg text-sm">
                            Подключите личные аккаунты WhatsApp для отправки сообщений водителям прямо из CRM.
                        </p>
                        <SectionDescription sectionKey="settings_whatsapp" />
                    </div>
                </div>
                <WhatsAppDashboard initialConnections={connections as any} />
            </div>
        </PageContainer>
    )
}
