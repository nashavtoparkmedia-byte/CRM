export const dynamic = 'force-dynamic'

export default function BotAdminPage() {
    return (
        <div className="flex flex-col gap-6 animate-in fade-in duration-500 h-[calc(100vh-theme(spacing.16))] pb-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-foreground">Панель Телеграм Бота</h1>
                    <p className="text-muted-foreground mt-2 max-w-lg text-sm">
                        Управление опросами, рассылками и аналитикой активности бота.
                    </p>
                </div>
            </div>

            <div className="flex-1 bg-black/5 rounded-xl border shadow-inner overflow-hidden relative">
                <iframe
                    src="http://localhost:3004"
                    className="w-full h-full border-0 absolute top-0 left-0"
                    title="Telegram Bot Admin Panel"
                    allow="clipboard-write"
                />
            </div>
        </div>
    )
}
