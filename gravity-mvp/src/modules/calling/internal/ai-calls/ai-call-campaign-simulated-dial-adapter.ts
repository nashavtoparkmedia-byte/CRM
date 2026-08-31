import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { appendAiCallTranscriptMessage } from '../../application/ai-call-callback-runtime'
import { finalizeAiCall } from '../../application/ai-call-finalization-runtime'
import type {
    AiCallCampaignDialPort,
    AiCallCampaignDialRequest,
    AiCallCampaignDialResult,
} from '../../application/ai-call-campaign-runtime'

function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

interface SimulatedRawDatabase {
    $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
}

const database = prisma as unknown as SimulatedRawDatabase

function disposition(request: AiCallCampaignDialRequest): AiCallCampaignDialResult['terminal']['kind'] {
    if (request.targetRef.toLowerCase().includes('permanent')) return 'permanent_failure'
    if (request.targetRef.toLowerCase().includes('retry') && request.attemptNumber === 1) {
        return 'retryable_failure'
    }
    return 'success'
}

/**
 * Deterministic database-only adapter for controlled proofs and local demos.
 * It never imports telephony/provider code and never touches a network.
 */
export const aiCallCampaignSimulatedDialPort: AiCallCampaignDialPort = {
    async dial(request): Promise<AiCallCampaignDialResult> {
        const callId = `aicsim_${digest(request.launchId)}`
        const terminalKind = disposition(request)
        const failureCode = terminalKind === 'retryable_failure'
            ? 'simulated_transient_failure'
            : terminalKind === 'permanent_failure' ? 'simulated_permanent_failure' : null
        const startedAt = new Date()
        await prisma.call.upsert({
            where: { id: callId },
            create: {
                id: callId,
                direction: 'outbound',
                status: 'active',
                fromNumber: '+70000000000',
                toNumber: request.phoneE164,
                managerId: 'system:ai-call-campaign-simulator',
                fsUuid: `sim-${digest(request.launchId).slice(0, 48)}`,
                startedAt,
                answeredAt: startedAt,
                isAi: true,
                aiScenarioId: request.scenarioRef,
                aiSessionStatus: 'active',
                metadata: {
                    simulated: true,
                    providerNetworkUsed: false,
                    providerBillingIngested: false,
                    campaignId: request.campaignId,
                    campaignMemberId: request.memberId,
                    launchId: request.launchId,
                },
            },
            update: {},
        })
        const transcriptItems = [
            {
                messageId: `${request.launchId}:user:1`,
                ordinal: 1,
                segmentRevision: 1,
                role: 'user' as const,
                content: 'Controlled simulated campaign response.',
                final: true,
                source: 'calling_mock' as const,
            },
            {
                messageId: `${request.launchId}:assistant:2`,
                ordinal: 2,
                segmentRevision: 1,
                role: 'assistant' as const,
                content: terminalKind === 'success'
                    ? 'Controlled simulation completed successfully.'
                    : 'Controlled simulation recorded a failure.',
                final: true,
                source: 'calling_mock' as const,
            },
        ]
        for (const message of transcriptItems) {
            const result = await appendAiCallTranscriptMessage(callId, message)
            if (result.kind === 'not_found') throw new Error('AI_CALL_CAMPAIGN_SIMULATED_CALL_NOT_FOUND')
        }
        const finalization = await finalizeAiCall(callId, {
            callUuid: `sim-${digest(request.launchId).slice(0, 48)}`,
            reason: terminalKind === 'success' ? 'completed' : 'simulated_failure',
            result: {
                qualification_status: terminalKind === 'success' ? 'qualified' : 'unclear',
                lead_summary: terminalKind === 'success'
                    ? 'Controlled simulated campaign call succeeded.'
                    : 'Controlled simulated campaign call failed.',
                reason: failureCode,
                qualification_score: terminalKind === 'success' ? 80 : null,
                transfer_reason: null,
                manager_task: { should_create: false, summary: null, priority: 'normal' },
                lead_data: { simulation: true, terminalKind },
            },
            realUserUtterances: 1,
            events: [],
        })
        if (!['success', 'retryable'].includes(finalization.kind)) {
            throw new Error(`AI_CALL_CAMPAIGN_SIMULATED_FINALIZATION_${finalization.kind.toUpperCase()}`)
        }
        if (request.targetRef.toLowerCase().includes('crash')) {
            const claimed = await database.$queryRawUnsafe<Array<{ id: string }>>(`
                UPDATE "Call"
                SET "metadata"=COALESCE("metadata",'{}'::jsonb)
                    || '{"campaignSimulatedCrashInjected":true}'::jsonb,
                    "updatedAt"=now()
                WHERE "id"=$1
                  AND COALESCE("metadata"->>'campaignSimulatedCrashInjected','false') <> 'true'
                RETURNING "id"
            `, callId)
            if (claimed[0]) throw new Error('SIMULATED_CAMPAIGN_WORKER_EXIT_AFTER_CALLBACKS')
        }
        return {
            callId,
            effectRef: `simulated:${request.launchId}`,
            terminal: {
                eventId: `simulated-terminal:${digest(`${request.launchId}\0${terminalKind}`)}`,
                kind: terminalKind,
                outcomeCode: terminalKind === 'success' ? 'simulated_success' : null,
                failureCode,
            },
        }
    },
}
