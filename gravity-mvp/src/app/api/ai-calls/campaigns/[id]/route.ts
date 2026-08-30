import { NextRequest, NextResponse } from 'next/server'
import {
    AiCallCampaignContractValidationError,
    GET_AI_CALL_CAMPAIGN_QUERY_V1,
} from '@/contracts/calling/v1'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import { getCurrentUserIdentityV1 as getCurrentUser } from '@/modules/identity-access/public/v1/user-directory'
import { aiCallCampaignManagementV1 } from '@/modules/calling/public/v1/ai-call-campaign-management-handler'
import { AiCallCampaignConflictError, AiCallCampaignInputError } from '@/modules/calling/application/ai-call-campaign'
import {
    isJsonAiCallCampaignMutation,
    isSameOriginAiCallCampaignMutation,
} from '../mutation-request-boundary'

export const dynamic = 'force-dynamic'

function responseFor(error: unknown) {
    if (error instanceof AiCallCampaignContractValidationError || error instanceof AiCallCampaignInputError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 400 })
    }
    if (error instanceof AiCallCampaignConflictError) {
        return NextResponse.json(
            { error: error.message, code: error.code },
            { status: error.code === 'campaign_not_found' ? 404 : 409 },
        )
    }
    opsLog('error', 'ai_call_campaign_api_failed', {
        operation: 'ai_call_campaign',
        error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const { id } = await params
    try {
        const campaign = await aiCallCampaignManagementV1.get({
            contract: GET_AI_CALL_CAMPAIGN_QUERY_V1,
            campaignId: id,
            ...(req.nextUrl.searchParams.get('memberCursor')
                ? { memberCursor: req.nextUrl.searchParams.get('memberCursor') }
                : {}),
            ...(req.nextUrl.searchParams.get('memberLimit')
                ? { memberLimit: Number(req.nextUrl.searchParams.get('memberLimit')) }
                : {}),
        })
        if (!campaign) return NextResponse.json({ error: 'not_found' }, { status: 404 })
        return NextResponse.json({ campaign })
    } catch (error) {
        return responseFor(error)
    }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    const { id } = await params
    let body: unknown
    try { body = await req.json() } catch {
        return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
    }
    try {
        if (body && typeof body === 'object' && 'campaignId' in body
            && (body as { campaignId?: unknown }).campaignId !== id) {
            return NextResponse.json({ error: 'campaign_id_mismatch' }, { status: 400 })
        }
        const campaign = await aiCallCampaignManagementV1.control({
            ...(body && typeof body === 'object' ? body : {}),
            campaignId: id,
        }, { id: user.id })
        opsLog('info', 'ai_call_campaign_controlled', {
            operation: 'ai_call_campaign',
            campaignId: id,
            actorId: user.id,
        })
        return NextResponse.json({ campaign })
    } catch (error) {
        return responseFor(error)
    }
}
