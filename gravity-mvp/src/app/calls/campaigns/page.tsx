import { AiCallCampaignWorkspace } from '@/modules/calling/public/v1/client-ui/AiCallCampaignWorkspace'
import { requireIntegrationAdminPageAccess } from '@/modules/identity-access/public/v1'

export const dynamic = 'force-dynamic'

export default async function AiCallCampaignsPage() {
    const principal = await requireIntegrationAdminPageAccess('/calls/campaigns')
    return <AiCallCampaignWorkspace canEdit actorId={principal.id} />
}
