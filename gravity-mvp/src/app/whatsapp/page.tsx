import { getWhatsAppConnections } from './whatsapp-actions'
import { WhatsAppDashboard } from './WhatsAppDashboard'

export const dynamic = 'force-dynamic'

export const metadata = {
    title: 'WhatsApp — Gravity CRM',
    description: 'Connect personal WhatsApp accounts to send messages to drivers.',
}

export default async function WhatsAppPage() {
    const connections = await getWhatsAppConnections()
    return (
        <div className="flex flex-col gap-8">
            <WhatsAppDashboard initialConnections={connections as any} />
        </div>
    )
}
