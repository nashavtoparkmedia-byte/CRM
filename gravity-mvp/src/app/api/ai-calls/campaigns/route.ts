import { NextRequest, NextResponse } from 'next/server'
import {
    AiCallCampaignContractValidationError,
    LIST_AI_CALL_CAMPAIGNS_QUERY_V1,
} from '@/contracts/calling/v1'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import { getCurrentUserIdentityV1 as getCurrentUser } from '@/modules/identity-access/public/v1/user-directory'
import { aiCallCampaignManagementV1 } from '@/modules/calling/public/v1/ai-call-campaign-management-handler'
import { AiCallCampaignConflictError, AiCallCampaignInputError } from '@/modules/calling/application/ai-call-campaign'
import {
    isJsonAiCallCampaignMutation,
    isSameOriginAiCallCampaignMutation,
} from './mutation-request-boundary'

export const dynamic = 'force-dynamic'

function responseFor(error: unknown) {
    if (error instanceof AiCallCampaignContractValidationError || error instanceof AiCallCampaignInputError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 400 })
    }
    if (error instanceof AiCallCampaignConflictError) {
        const status = ['campaign_not_found', 'scenario_not_found'].includes(error.code) ? 404 : 409
        return NextResponse.json({ error: error.message, code: error.code }, { status })
    }
    opsLog('error', 'ai_call_campaign_api_failed', {
        operation: 'ai_call_campaigns',
        error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
}

export async function GET(req: NextRequest) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    try {
        const query = req.nextUrl.searchParams
        const result = await aiCallCampaignManagementV1.list({
            contract: LIST_AI_CALL_CAMPAIGNS_QUERY_V1,
            ...(query.get('state') ? { state: query.get('state') } : {}),
            ...(query.get('cursor') ? { cursor: query.get('cursor') } : {}),
            ...(query.get('limit') ? { limit: Number(query.get('limit')) } : {}),
        })
        return NextResponse.json(result)
    } catch (error) {
        return responseFor(error)
    }
}

export async function POST(req: NextRequest) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    if (user.role !== 'Администратор' && user.role !== 'Руководитель') {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    if (!isSameOriginAiCallCampaignMutation(req)) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    if (!isJsonAiCallCampaignMutation(req)) {
        return NextResponse.json({ error: 'unsupported_media_type' }, { status: 415 })
    }
    let body: unknown
    try { body = await req.json() } catch {
        return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
    }
    try {
        const campaign = await aiCallCampaignManagementV1.create(body, { id: user.id })
        opsLog('info', 'ai_call_campaign_created', {
            operation: 'ai_call_campaigns',
            campaignId: campaign.id,
            actorId: user.id,
        })
        return NextResponse.json({ campaign }, { status: 201 })
    } catch (error) {
        return responseFor(error)
    }
}
