import { listScenarios } from '@/lib/ai-call/scenarios'
import { getCurrentUser } from '@/lib/users/user-service'
import AiCallScenariosClient from './AiCallScenariosClient'

export const dynamic = 'force-dynamic'

/**
 * /settings/integrations/ai-call-scenarios
 *
 * Admin page for managing AI-call scenarios — the scripts a voice agent
 * follows when a manager presses "Call with AI" in the lead card. Each
 * scenario has a system prompt + ordered questions + objection handling.
 * On first visit, the page auto-seeds a default scenario for driver leads.
 */
export default async function AiCallScenariosPage() {
    const user = await getCurrentUser()
    const scenarios = await listScenarios()
    const canEdit = user?.role === 'Администратор' || user?.role === 'Руководитель'

    return <AiCallScenariosClient initialScenarios={scenarios} canEdit={canEdit} />
}
