import AiControlCenterHelpClient from './AiControlCenterHelpClient'

export const dynamic = 'force-dynamic'

/**
 * /settings/integrations/ai-call-help/ai-control-center
 *
 * Краткая встроенная инструкция к AI Control Center. Две вкладки:
 *   1. «Для менеджера» — как AI помогает в чатах, что делать с ошибками,
 *      как ставить 👍/👎 в журнале.
 *   2. «Для администратора» — пошаговая настройка: провайдер → правила →
 *      база знаний → импорт → включить.
 *
 * Лежит внутри hub-раздела /settings/integrations/ai-call-help, который
 * собирает инструкции по всем AI-функциям CRM (AI-обзвон, AI Control
 * Center и т.д.). Компонент-помощник — `AiControlCenterHelpClient`.
 * Архитектурная документация — в .claude/knowledge/, не здесь.
 */
export default function AiControlCenterHelpPage() {
    return <AiControlCenterHelpClient />
}
