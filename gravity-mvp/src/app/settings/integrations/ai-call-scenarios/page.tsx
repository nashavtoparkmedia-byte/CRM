import { listScenarios, listProjects } from '@/lib/ai-call/scenarios'
import { getCurrentUser } from '@/lib/users/user-service'
import AiCallScenariosClient from './AiCallScenariosClient'

export const dynamic = 'force-dynamic'

/**
 * /settings/integrations/ai-call-scenarios
 *
 * Admin page for managing AI-call scenarios — the scripts a voice agent
 * follows when a manager presses "Call with AI" in the lead card. Scenarios
 * are grouped by AiCallProject (lead qualification / churn winback /
 * NPS survey). On first visit, the page auto-seeds a default driver-lead
 * scenario into the "Квалификация лида" project.
 */
export default async function AiCallScenariosPage() {
    const user = await getCurrentUser()
    const [projects, scenarios] = await Promise.all([listProjects(), listScenarios()])
    const canEdit = user?.role === 'Администратор' || user?.role === 'Руководитель'

    return <AiCallScenariosClient initialProjects={projects} initialScenarios={scenarios} canEdit={canEdit} />
}
