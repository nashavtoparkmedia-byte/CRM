import { AiCallCampaignDetail } from '@/modules/calling/public/v1/client-ui/AiCallCampaignDetail'

export default async function AiCallCampaignPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    return <AiCallCampaignDetail campaignId={id} />
}
