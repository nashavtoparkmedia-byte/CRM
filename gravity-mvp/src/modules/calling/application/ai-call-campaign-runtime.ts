import { aiCallCampaignPrismaPort } from '../internal/ai-calls/ai-call-campaign-prisma-adapter'

export interface AiCallCampaignDialRequest {
    launchId: string
    campaignId: string
    memberId: string
    targetType: string
    targetRef: string
    phoneE164: string
    scenarioRef: string
    attemptNumber: number
}

export interface AiCallCampaignDialResult {
    effectRef: string
    terminal: {
        eventId: string
        kind: 'success' | 'retryable_failure' | 'permanent_failure'
        outcomeCode?: string | null
        failureCode?: string | null
    }
}

export interface AiCallCampaignDialPort {
    dial(request: AiCallCampaignDialRequest): Promise<AiCallCampaignDialResult>
}

export type AiCallCampaignWorkerCycleResult =
    | { kind: 'idle'; startedCampaigns: readonly string[] }
    | { kind: 'blocked'; attemptId: string; reason: string; retryAt: Date; startedCampaigns: readonly string[] }
    | {
        kind: 'completed'
        attemptId: string
        launchId: string
        memberState: string
        campaignState: string
        startedCampaigns: readonly string[]
    }

export function createAiCallCampaignWorkerRuntime(input: {
    dial: AiCallCampaignDialPort
    workerId: string
    clock?: () => Date
    claimLeaseMs?: number
    admissionLeaseMs?: number
}) {
    const clock = input.clock ?? (() => new Date())
    const claimLeaseMs = input.claimLeaseMs ?? 30_000
    const admissionLeaseMs = input.admissionLeaseMs ?? 60_000

    return async function runCycle(): Promise<AiCallCampaignWorkerCycleResult> {
        const cycleStartedAt = clock()
        const startedCampaigns = await aiCallCampaignPrismaPort.startDueCampaigns(cycleStartedAt)
        const claim = await aiCallCampaignPrismaPort.claimNextLaunch({
            workerId: input.workerId,
            now: cycleStartedAt,
            leaseMs: claimLeaseMs,
        })
        if (!claim) return { kind: 'idle', startedCampaigns }

        const admission = await aiCallCampaignPrismaPort.acquireAdmission({
            claim,
            now: clock(),
            leaseMs: admissionLeaseMs,
        })
        if (admission.kind !== 'acquired') {
            const retryAt = admission.kind === 'blocked'
                ? admission.retryAt
                : new Date(clock().getTime() + 250)
            await aiCallCampaignPrismaPort.deferClaim({
                attemptId: claim.attemptId,
                claimFence: claim.claimFence,
                retryAt,
                now: clock(),
            })
            return {
                kind: 'blocked',
                attemptId: claim.attemptId,
                reason: admission.kind === 'blocked' ? admission.reason : 'campaign_not_running',
                retryAt,
                startedCampaigns,
            }
        }

        // The adapter must bind the provider effect to launchId. If this process
        // exits after the provider accepts the request, the same attempt and
        // launchId are reclaimed after lease expiry and converge at the adapter.
        const dialResult = await input.dial.dial({
            launchId: claim.launchId,
            campaignId: claim.campaignId,
            memberId: claim.memberId,
            targetType: claim.targetType,
            targetRef: claim.targetRef,
            phoneE164: claim.phoneE164,
            scenarioRef: claim.scenarioRef,
            attemptNumber: claim.attemptNumber,
        })
        const terminal = await aiCallCampaignPrismaPort.recordAttemptResult({
            attemptId: claim.attemptId,
            resultEventId: dialResult.terminal.eventId,
            kind: dialResult.terminal.kind,
            outcomeCode: dialResult.terminal.outcomeCode,
            failureCode: dialResult.terminal.failureCode,
            claimFence: claim.claimFence,
            leaseFence: admission.grant.leaseFence,
            dialEffectRef: dialResult.effectRef,
            now: clock(),
        })
        if (terminal.status !== 'applied') {
            throw new Error(`AI_CALL_CAMPAIGN_TERMINAL_REPLAY:${terminal.status}`)
        }
        return {
            kind: 'completed',
            attemptId: claim.attemptId,
            launchId: claim.launchId,
            memberState: terminal.memberState,
            campaignState: terminal.campaignState,
            startedCampaigns,
        }
    }
}
