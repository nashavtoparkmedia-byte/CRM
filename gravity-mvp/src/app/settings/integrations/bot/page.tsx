import { SectionDescription } from '@/components/ui/SectionDescription'
import { PageContainer } from '@/components/ui/PageContainer'

export const dynamic = 'force-dynamic'

export default function BotAdminPage() {
    // SSO-lite: the user is already authenticated in the CRM, so we inject the
    // bot-admin Basic Auth credentials into the iframe via a URL hash. The
    // bot-admin's AuthContext reads `#auth=<base64(user:pass)>` on load, stores
    // it as crm_token (overwriting any stale token), then strips the hash.
    // Hash (not query) keeps the secret out of server logs / referrers; it's
    // only visible to this already-authenticated CRM user in their own DOM.
    const botAdminUrl = process.env.BOT_ADMIN_URL ?? 'http://localhost:3004'
    const adminUser = process.env.ADMIN_USER ?? 'admin'
    const adminPass = process.env.ADMIN_PASS ?? ''
    const authHash = adminPass
        ? `#auth=${Buffer.from(`${adminUser}:${adminPass}`).toString('base64')}`
        : ''
    const iframeSrc = `${botAdminUrl}${authHash}`

    return (
        <PageContainer>
            <div className="flex flex-col gap-6 animate-in fade-in duration-500 h-[calc(100vh-theme(spacing.16))] pb-6 mt-[4px]">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-[4px]">
                    <div>
                        <h1 className="text-3xl font-bold text-foreground">Панель Телеграм Бота</h1>
                        <p className="text-muted-foreground mt-[2px] max-w-lg text-sm mb-[4px]">
                            Управление опросами, рассылками и аналитикой активности бота.
                        </p>
                        <SectionDescription sectionKey="settings_bot" />
                    </div>
                </div>

                <div className="flex-1 bg-black/5 rounded-xl border shadow-inner overflow-hidden relative">
                    <iframe
                        src={iframeSrc}
                        className="w-full h-full border-0 absolute top-0 left-0"
                        title="Telegram Bot Admin Panel"
                        allow="clipboard-write"
                    />
                </div>
            </div>
        </PageContainer>
    )
}
