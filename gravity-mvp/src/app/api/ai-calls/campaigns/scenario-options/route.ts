import { NextResponse } from 'next/server'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'
import { aiCallCampaignManagementV1 as campaigns } from '@/modules/calling/public/v1/ai-call-campaign-management-handler'

export const dynamic = 'force-dynamic'

export async function GET() {
    const principal = await getIntegrationAdminPrincipal()
    if (!principal) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    try {
        return NextResponse.json({ scenarios: await campaigns.scenarioOptions() })
    } catch (error) {
        opsLog('error', 'ai_call_campaign_scenario_options_failed', {
            operation: 'ai_call_campaigns',
            error: error instanceof Error ? error.message : String(error),
        })
        return NextResponse.json({ error: 'internal_error' }, { status: 500 })
    }
}
