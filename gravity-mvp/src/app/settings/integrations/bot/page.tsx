import { PageContainer } from '@/infrastructure/ui/PageContainer'
import { requireIntegrationAdminPageAccess } from '@/modules/identity-access/public/v1'
import BotPageClient from './BotPageClient'

export const dynamic = 'force-dynamic'

export default async function BotAdminPage() {
    await requireIntegrationAdminPageAccess('/settings/integrations/bot')

    // The embedded admin owns its HttpOnly authenticated session. Never place
    // Basic credentials in a URL fragment, browser storage, or iframe props.
    const iframeSrc = process.env.BOT_ADMIN_URL ?? 'http://localhost:3004'

    return (
        <PageContainer>
            <BotPageClient iframeSrc={iframeSrc} />
        </PageContainer>
    )
}
