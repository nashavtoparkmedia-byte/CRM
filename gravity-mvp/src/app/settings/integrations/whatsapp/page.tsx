import { getWhatsAppConnections } from './whatsapp-actions'
import { WhatsAppDashboard } from './WhatsAppDashboard'
import { SectionDescription } from '@/components/ui/SectionDescription'

export const dynamic = 'force-dynamic'

export const metadata = {
    title: 'WhatsApp — Yoko CRM',
    description: 'Connect personal WhatsApp accounts to send messages to drivers.',
}

import { PageContainer } from '@/components/ui/PageContainer'

export default async function WhatsAppPage() {
    const connections = await getWhatsAppConnections()
    return (
        <PageContainer>
            <div className="flex flex-col gap-6">
                <SectionDescription sectionKey="settings_whatsapp" />
                <WhatsAppDashboard initialConnections={connections as any} />
            </div>
        </PageContainer>
    )
}
