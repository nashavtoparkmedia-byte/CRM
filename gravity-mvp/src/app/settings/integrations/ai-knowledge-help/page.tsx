import AiKnowledgeHelpClient from './AiKnowledgeHelpClient'

export const dynamic = 'force-dynamic'

/**
 * /settings/integrations/ai-knowledge-help
 *
 * Краткая операционная инструкция к AI Knowledge Core. Две вкладки:
 *   1. «Для менеджера» — как AI пользуется ядром, почему иногда
 *      передаёт менеджеру, как открыть «Почему AI так ответил?»,
 *      как ставить 👍/👎.
 *   2. «Для администратора» — операционные шаги: импорт → сбор ядра →
 *      verify → conflict → shadow → runtime (через env).
 *
 * Это НЕ архитектурная документация (та в .claude/knowledge/), а
 * operational guidance. Coverage расширяется параллельно с PR5
 * (microcopy, legacy migration, bulk actions, etc).
 *
 * Лежит внутри hub-раздела /settings/integrations/ai-call-help.
 */
export default function AiKnowledgeHelpPage() {
    return <AiKnowledgeHelpClient />
}
