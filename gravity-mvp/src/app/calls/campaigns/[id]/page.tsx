import { AiCallCampaignDetail } from '@/modules/calling/public/v1/client-ui/AiCallCampaignDetail'
import { requireIntegrationAdminPageAccess } from '@/modules/identity-access/public/v1'

export const dynamic = 'force-dynamic'

export default async function AiCallCampaignPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    await requireIntegrationAdminPageAccess(`/calls/campaigns/${id}`)
    return <AiCallCampaignDetail campaignId={id} canEdit />
}
