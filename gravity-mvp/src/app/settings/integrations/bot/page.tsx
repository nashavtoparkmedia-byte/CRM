import { PageContainer } from '@/components/ui/PageContainer'
import BotPageClient from './BotPageClient'

export const dynamic = 'force-dynamic'

export default function BotAdminPage() {
    const botAdminUrl = process.env.BOT_ADMIN_URL ?? 'http://localhost:3004'
    const adminUser = process.env.ADMIN_USER ?? 'admin'
    const adminPass = process.env.ADMIN_PASS ?? ''
    const authHash = adminPass
        ? `#auth=${Buffer.from(`${adminUser}:${adminPass}`).toString('base64')}`
        : ''
    const iframeSrc = `${botAdminUrl}${authHash}`

    return (
        <PageContainer>
            <BotPageClient iframeSrc={iframeSrc} />
        </PageContainer>
    )
}
