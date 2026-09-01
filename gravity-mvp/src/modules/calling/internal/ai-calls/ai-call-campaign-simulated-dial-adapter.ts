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

function simulatedResult(request: AiCallCampaignDialRequest): AiCallCampaignDialResult {
    const terminalKind = disposition(request)
    const failureCode = terminalKind === 'retryable_failure'
        ? 'simulated_transient_failure'
        : terminalKind === 'permanent_failure' ? 'simulated_permanent_failure' : null
    return {
        callId: `aicsim_${digest(request.launchId)}`,
        effectRef: `simulated:${request.launchId}`,
        terminal: {
            eventId: `simulated-terminal:${digest(`${request.launchId}\0${terminalKind}`)}`,
            kind: terminalKind,
            outcomeCode: terminalKind === 'success' ? 'simulated_success' : null,
            failureCode,
        },
    }
}

async function injectCrashOnce(callId: string, receiptKey: string, errorCode: string): Promise<void> {
    const claimed = await database.$queryRawUnsafe<Array<{ id: string }>>(`
        UPDATE "Call"
        SET "metadata"=COALESCE("metadata",'{}'::jsonb) || jsonb_build_object($2,true),
            "updatedAt"=now()
        WHERE "id"=$1 AND COALESCE("metadata"->>$2,'false') <> 'true'
        RETURNING "id"
    `, callId, receiptKey)
    if (claimed[0]) throw new Error(errorCode)
}

async function completeSimulatedCall(
    request: AiCallCampaignDialRequest,
    result: AiCallCampaignDialResult,
): Promise<void> {
    const callId = result.callId!
    const terminalKind = result.terminal.kind
    const failureCode = result.terminal.failureCode ?? null
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
        const appendResult = await appendAiCallTranscriptMessage(callId, message)
        if (appendResult.kind === 'not_found') throw new Error('AI_CALL_CAMPAIGN_SIMULATED_CALL_NOT_FOUND')
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
}

/**
 * Deterministic database-only adapter for controlled proofs and local demos.
 * It never imports telephony/provider code and never touches a network.
 */
export const aiCallCampaignSimulatedDialPort: AiCallCampaignDialPort = {
    async reconcile(request): Promise<AiCallCampaignDialResult | null> {
        const result = simulatedResult(request)
        const receipts = await database.$queryRawUnsafe<Array<{ id: string; endedAt: Date | null }>>(`
            SELECT "id", "endedAt" FROM "Call"
            WHERE "id"=$1 AND "isSimulation"=true
        `, result.callId)
        if (!receipts[0]) return null
        if (request.targetRef.toLowerCase().includes('link-reconcile-flaky')) {
            await injectCrashOnce(
                result.callId!,
                'campaignSimulatedReconcileFailureOne',
                'SIMULATED_CAMPAIGN_RECONCILIATION_FAILURE_AFTER_CALL_LINK',
            )
            await injectCrashOnce(
                result.callId!,
                'campaignSimulatedReconcileFailureTwo',
                'SIMULATED_CAMPAIGN_RECONCILIATION_FAILURE_AFTER_CALL_LINK',
            )
        }
        if (!receipts[0].endedAt) await completeSimulatedCall(request, result)
        return result
    },

    async dispatch(request): Promise<AiCallCampaignDialResult> {
        const result = simulatedResult(request)
        const callId = result.callId!
        const startedAt = new Date()
        await prisma.$transaction(async (tx) => {
            await tx.call.upsert({
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
                    isSimulation: true,
                    metadata: {
                        simulated: true,
                        providerNetworkUsed: false,
                        providerBillingIngested: false,
                        campaignId: request.campaignId,
                        campaignMemberId: request.memberId,
                        launchId: request.launchId,
                        scenarioFingerprint: request.scenarioFingerprint,
                    },
                },
                update: {},
            })
            const linked = await tx.aiCallCampaignAttempt.updateMany({
                where: {
                    launchId: request.launchId,
                    OR: [{ callId: null }, { callId }],
                },
                data: { callId },
            })
            if (linked.count !== 1) {
                throw new Error('AI_CALL_CAMPAIGN_SIMULATED_ATTEMPT_LINK_CONFLICT')
            }
        })
        if (request.targetRef.toLowerCase().includes('link-reconcile-flaky')) {
            throw new Error('SIMULATED_CAMPAIGN_WORKER_EXIT_BEFORE_LINKED_CALL_FINALIZATION')
        }
        if (request.targetRef.toLowerCase().includes('link-crash')) {
            await injectCrashOnce(
                callId,
                'campaignSimulatedLinkCrashInjected',
                'SIMULATED_CAMPAIGN_WORKER_EXIT_AFTER_CALL_LINK',
            )
        }
        await completeSimulatedCall(request, result)
        if (request.targetRef.toLowerCase().includes('crash')) {
            await injectCrashOnce(
                callId,
                'campaignSimulatedCrashInjected',
                'SIMULATED_CAMPAIGN_WORKER_EXIT_AFTER_CALLBACKS',
            )
        }
        return result
    },
}
