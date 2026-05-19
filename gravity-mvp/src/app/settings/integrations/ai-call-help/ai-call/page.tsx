import AiCallHelpClient from './AiCallHelpClient'

export const dynamic = 'force-dynamic'

/**
 * /settings/integrations/ai-call-help
 *
 * Short, in-product help for the AI-call module. Two tabs:
 *   1. «Для менеджера» — как запустить AI-звонок, где смотреть результат
 *   2. «Для администратора» — где задать ключи, как поднять mock-режим,
 *      что делать если AI-звонок не создаётся
 *
 * This is intentionally a black-and-white draft — not final documentation.
 * Technical architecture (FreeSWITCH / mod_audio_fork / bridge) lives in
 * the repo's README and `.claude/knowledge/` knowledge base, not here.
 */
export default function AiCallHelpPage() {
    return <AiCallHelpClient />
}
