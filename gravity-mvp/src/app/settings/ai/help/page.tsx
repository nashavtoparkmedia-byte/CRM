import AiHelpClient from './AiHelpClient'

export const dynamic = 'force-dynamic'

/**
 * /settings/ai/help
 *
 * Краткая встроенная инструкция к AI Control Center. Две вкладки:
 *   1. «Для менеджера» — как AI помогает в чатах, что делать с ошибками,
 *      как ставить 👍/👎 в журнале.
 *   2. «Для администратора» — пошаговая настройка: провайдер → правила →
 *      база знаний → импорт → включить.
 *
 * По образцу /settings/integrations/ai-call-help: compact header,
 * сегмент-табы, QuickNav-якоря, короткие карточки-шаги. Не help-center,
 * не архитектурная документация (та живёт в .claude/knowledge/).
 */
export default function AiHelpPage() {
    return <AiHelpClient />
}
