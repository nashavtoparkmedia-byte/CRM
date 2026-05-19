import Link from 'next/link'
import { Sparkles, Bot, ArrowRight } from 'lucide-react'

export const dynamic = 'force-dynamic'

/**
 * /settings/integrations/ai-call-help
 *
 * Hub-индекс инструкций к AI-функциям CRM. Каждая карточка ведёт на
 * отдельную инструкцию в подпапке:
 *   - /ai-call             — AI-обзвон (звонки лидам по сценариям)
 *   - /ai-control-center   — AI-агент в чатах MAX/TG/WA
 *
 * Раздел расширяется: новые инструкции добавляются как подпапки рядом.
 * URL `/settings/integrations/ai-call-help` исторически назван по
 * первому подразделу (AI-обзвон), но сейчас работает как общий хаб —
 * sidebar-ссылка ведёт сюда.
 */

interface GuideCard {
    href: string
    title: string
    description: string
    icon: React.ReactNode
    iconBg: string
}

const GUIDES: GuideCard[] = [
    {
        href: '/settings/integrations/ai-call-help/ai-call',
        title: 'Инструкция по AI-обзвону',
        description: 'AI-звонки лидам по сценариям: запуск из карточки водителя, результат во вкладке «AI-анализ», типичные ошибки.',
        icon: <Sparkles className="h-5 w-5 text-primary" />,
        iconBg: 'bg-primary/10',
    },
    {
        href: '/settings/integrations/ai-call-help/ai-control-center',
        title: 'Инструкция по AI Control Center',
        description: 'AI-агент в чатах MAX, Telegram и WhatsApp: настройка провайдера и правил, база знаний, журнал решений.',
        icon: <Bot className="h-5 w-5 text-violet-600" />,
        iconBg: 'bg-violet-100/60',
    },
]

export default function HelpHubPage() {
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 animate-in fade-in duration-300">
            <header className="flex flex-col gap-1">
                <h1 className="text-[20px] font-semibold leading-tight text-foreground">Инструкции</h1>
                <p className="text-[13px] text-muted-foreground">
                    Справочники по AI-функциям CRM. Каждый раздел — отдельная инструкция для менеджеров и администраторов.
                </p>
            </header>

            <div className="flex flex-col gap-2">
                {GUIDES.map((g) => (
                    <Link
                        key={g.href}
                        href={g.href}
                        className="group flex items-center gap-4 rounded-md border border-border bg-card p-5 transition-colors hover:bg-surface"
                    >
                        <div className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full ${g.iconBg}`}>
                            {g.icon}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-[15px] font-semibold text-foreground">{g.title}</div>
                            <p className="mt-0.5 text-[13px] text-muted-foreground">{g.description}</p>
                        </div>
                        <ArrowRight className="h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                    </Link>
                ))}
            </div>
        </div>
    )
}
