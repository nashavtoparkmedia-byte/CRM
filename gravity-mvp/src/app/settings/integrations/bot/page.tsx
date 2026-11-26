import { PageContainer } from '@/infrastructure/ui/PageContainer'
import { requireIntegrationAdminPageAccess } from '@/modules/identity-access/public/v1'
import BotPageClient from './BotPageClient'

export const dynamic = 'force-dynamic'

export default async function BotAdminPage() {
    await requireIntegrationAdminPageAccess('/settings/integrations/bot')

    // The embedded admin owns its HttpOnly authenticated session. Never place
    // Basic credentials in a URL fragment, browser storage, or iframe props.
    // Keep the admin same-origin when BOT_ADMIN_DOMAIN is intentionally
    // disabled. The embedded app retains its own HttpOnly staff session.
    const iframeSrc = process.env.BOT_ADMIN_URL ?? '/bot-admin'

    return (
        <PageContainer>
            <BotPageClient iframeSrc={iframeSrc} />
        </PageContainer>
    )
}
