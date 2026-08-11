import { PageContainer } from '@/infrastructure/ui/PageContainer'
import BotPageClient from './BotPageClient'

export const dynamic = 'force-dynamic'

export default function BotAdminPage() {
    // The embedded admin owns its HttpOnly authenticated session. Never place
    // Basic credentials in a URL fragment, browser storage, or iframe props.
    const iframeSrc = process.env.BOT_ADMIN_URL ?? 'http://localhost:3004'

    return (
        <PageContainer>
            <BotPageClient iframeSrc={iframeSrc} />
        </PageContainer>
    )
}
