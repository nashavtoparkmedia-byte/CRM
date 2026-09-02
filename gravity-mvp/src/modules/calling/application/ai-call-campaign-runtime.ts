import type { AiCallCampaignJson } from './ai-call-campaign'
import { aiCallCampaignPrismaPort } from '../internal/ai-calls/ai-call-campaign-prisma-adapter'

export interface AiCallCampaignDialRequest {
    launchId: string
    campaignId: string
    memberId: string
    targetType: string
    targetRef: string
    phoneE164: string
    scenarioRef: string
    scenarioFingerprint: string
    scenarioSnapshot: Record<string, AiCallCampaignJson>
    attemptNumber: number
}

export interface AiCallCampaignDialResult {
    effectRef: string
    /** Calling-owned Call row created by production-shaped adapters. */
    callId?: string
    terminal: {
        eventId: string
        kind: 'success' | 'retryable_failure' | 'permanent_failure'
        outcomeCode?: string | null
        failureCode?: string | null
    }
}

export interface AiCallCampaignDialPort {
    /** Starts the first provider effect for a durably authorized launch. */
    dispatch(request: AiCallCampaignDialRequest): Promise<AiCallCampaignDialResult>
    /** Read-only/provider-idempotent reconciliation; it must never initiate a first effect. */
    reconcile(request: AiCallCampaignDialRequest): Promise<AiCallCampaignDialResult | null>
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

function reconciliationRetryAt(now: Date, dialExecutionCount: number): Date {
    const exponent = Math.min(6, Math.max(0, dialExecutionCount - 1))
    return new Date(now.getTime() + Math.min(30_000, 250 * (2 ** exponent)))
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

        await aiCallCampaignPrismaPort.markAttemptRunning({
            attemptId: claim.attemptId,
            claimFence: claim.claimFence,
            leaseFence: admission.grant.leaseFence,
            now: clock(),
        })
        const execution = await aiCallCampaignPrismaPort.beginDialExecution({
            attemptId: claim.attemptId,
            claimFence: claim.claimFence,
            leaseFence: admission.grant.leaseFence,
            now: clock(),
        })

        if (execution.kind === 'cancelled_before_dispatch') {
            return {
                kind: 'completed',
                attemptId: claim.attemptId,
                launchId: claim.launchId,
                memberState: 'cancelled',
                campaignState: execution.campaignState,
                startedCampaigns,
            }
        }
        if (execution.kind === 'deferred_before_dispatch') {
            return {
                kind: 'blocked',
                attemptId: claim.attemptId,
                reason: 'campaign_not_running',
                retryAt: execution.retryAt,
                startedCampaigns,
            }
        }

        const dialRequest: AiCallCampaignDialRequest = {
            launchId: claim.launchId,
            campaignId: claim.campaignId,
            memberId: claim.memberId,
            targetType: claim.targetType,
            targetRef: claim.targetRef,
            phoneE164: claim.phoneE164,
            scenarioRef: claim.scenarioRef,
            scenarioFingerprint: claim.scenarioFingerprint,
            scenarioSnapshot: claim.scenarioSnapshot,
            attemptNumber: claim.attemptNumber,
        }

        // The adapter must bind the provider effect to launchId. If this process
        // exits after the provider accepts the request, the same attempt and
        // launchId are reclaimed after lease expiry and converge at the adapter.
        let renewal: Promise<void> | null = null
        let renewalFailure: unknown = null
        const heartbeatMs = Math.max(25, Math.floor(Math.min(claimLeaseMs, admissionLeaseMs) / 3))
        const heartbeat = setInterval(() => {
            if (renewal) return
            renewal = aiCallCampaignPrismaPort.renewExecution({
                attemptId: claim.attemptId,
                claimFence: claim.claimFence,
                leaseFence: admission.grant.leaseFence,
                now: clock(),
                claimLeaseMs,
                admissionLeaseMs,
            }).then(() => undefined).catch((error: unknown) => {
                renewalFailure = error
            }).finally(() => { renewal = null })
        }, heartbeatMs)
        heartbeat.unref()
        let dialResult: AiCallCampaignDialResult | null
        let providerAccepted = true
        const deferLinkedCallReconciliation = async (
            reason: 'adapter_error' | 'missing_reconciliation_result',
        ): Promise<AiCallCampaignWorkerCycleResult> => {
            const now = clock()
            const retryAt = reconciliationRetryAt(now, execution.dialExecutionCount)
            await aiCallCampaignPrismaPort.deferLinkedCallReconciliation({
                attemptId: claim.attemptId,
                claimFence: claim.claimFence,
                leaseFence: admission.grant.leaseFence,
                retryAt,
                reason,
                now,
            })
            return {
                kind: 'blocked',
                attemptId: claim.attemptId,
                reason: 'dial_reconciliation_deferred',
                retryAt,
                startedCampaigns,
            }
        }
        try {
            dialResult = execution.kind === 'initial_dispatch_authorized'
                ? await input.dial.dispatch(dialRequest)
                : await input.dial.reconcile(dialRequest)
        } catch (error) {
            clearInterval(heartbeat)
            if (renewal) await renewal
            if (renewalFailure) throw renewalFailure
            if (execution.dialExecutionCount < 3) throw error
            if (execution.callId) return deferLinkedCallReconciliation('adapter_error')
            providerAccepted = false
            dialResult = {
                effectRef: `acceptance-unresolved:${claim.launchId}`,
                terminal: {
                    eventId: `acceptance-unresolved-terminal:${claim.launchId}`,
                    kind: 'permanent_failure',
                    failureCode: 'dial_acceptance_unresolved',
                },
            }
        }
        clearInterval(heartbeat)
        if (renewal) await renewal
        if (renewalFailure) throw renewalFailure
        if (dialResult === null) {
            if (execution.callId) return deferLinkedCallReconciliation('missing_reconciliation_result')
            providerAccepted = false
            dialResult = {
                effectRef: `not-accepted:${claim.launchId}`,
                terminal: {
                    eventId: `not-accepted-terminal:${claim.launchId}`,
                    kind: 'permanent_failure',
                    failureCode: 'dial_not_accepted_before_recovery',
                },
            }
        }
        const terminal = await aiCallCampaignPrismaPort.recordAttemptResult({
            attemptId: claim.attemptId,
            resultEventId: dialResult.terminal.eventId,
            kind: dialResult.terminal.kind,
            outcomeCode: dialResult.terminal.outcomeCode,
            failureCode: dialResult.terminal.failureCode,
            claimFence: claim.claimFence,
            leaseFence: admission.grant.leaseFence,
            dialEffectRef: dialResult.effectRef,
            callId: dialResult.callId,
            providerAccepted,
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
