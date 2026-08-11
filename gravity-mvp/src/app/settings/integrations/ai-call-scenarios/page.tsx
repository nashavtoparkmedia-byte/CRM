import { listScenarios, listProjects } from '@/lib/ai-call/scenarios'
import { getCurrentUserIdentityV1 as getCurrentUser } from '@/modules/identity-access/public/v1/user-directory'
import { getAiCallKeysStatus } from '@/lib/ai-call/keys-status'
import { getValue } from '@/lib/ai-call/provider-settings'
import AiCallScenariosClient from './AiCallScenariosClient'

export const dynamic = 'force-dynamic'

/**
 * /settings/integrations/ai-call-scenarios
 *
 * Hub page for AI-обзвон setup. Two inner tabs:
 *   1. Проекты и сценарии — chip-tabs за проектам, скрипты разговора.
 *   2. API ключи — раньше жил отдельно в /ai-call-keys; теперь складывается
 *      сюда, чтобы не плодить sidebar-пункты. Прямой URL остался для legacy
 *      ссылок (например, из инструкции).
 *
 * Scenarios + projects load on every request (force-dynamic); seed of default
 * scenario happens lazily in listScenarios() if the table is empty.
 */
export default async function AiCallScenariosPage() {
    const user = await getCurrentUser()
    const [projects, scenarios, keysStatus, activeProjectId] = await Promise.all([
        listProjects(),
        listScenarios(),
        getAiCallKeysStatus(),
        // Which project is "live" — used by future AI-call dispatcher to pick
        // the scenario when a manager presses the button. Stored as a regular
        // AiProviderSetting row (provider=system, key=activeProjectId).
        getValue('system', 'activeProjectId'),
    ])
    const canEdit = user?.role === 'Администратор' || user?.role === 'Руководитель'

    return (
        <AiCallScenariosClient
            initialProjects={projects}
            initialScenarios={scenarios}
            initialKeysStatus={keysStatus}
            initialActiveProjectId={activeProjectId}
            canEdit={canEdit}
        />
    )
}
