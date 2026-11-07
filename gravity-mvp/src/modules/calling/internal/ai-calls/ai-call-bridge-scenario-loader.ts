import { prisma } from '@/lib/prisma'
import { aiCallCampaignSha256, type AiCallCampaignJson } from '../../application/ai-call-campaign'

/**
 * The scenario an in-flight Call must execute.
 *
 * A campaign freezes its scenario when it is created: `scenarioRef`,
 * `scenarioSnapshot` and `scenarioFingerprint` are written together and never move.
 * Resolving the live dialog from the mutable `AiCallScenario` row would quietly break
 * that promise — an operator edit between freeze and launch would change what a
 * launched member hears. So a Call that belongs to a campaign attempt executes the
 * snapshot, verified under exactly the invariants finalization already enforces, and
 * a corrupt or mismatched snapshot fails closed instead of silently falling back.
 *
 * A Call with no campaign attempt keeps the existing resolution unchanged.
 */

export interface BridgeScenarioV1 {
    id: string
    name: string
    systemPrompt: string
    questions: unknown
    targetDurationSec: number | null
}

export interface BridgeCallScenarioResolutionV1 {
    call: {
        id: string
        isAi: boolean
        aiScenarioId: string | null
        driverId: string | null
        contactId: string | null
        managerId: string | null
    }
    /** Present only for a campaign Call whose frozen snapshot verified. */
    frozenScenario: BridgeScenarioV1 | null
}

export class AiCallFrozenScenarioError extends Error {
    constructor(readonly code: string) {
        super(code)
        this.name = 'AiCallFrozenScenarioError'
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Verifies a frozen campaign snapshot against the Call it is about to drive.
 *
 * The four invariants are the ones `ai-call-finalization-prisma-adapter` already
 * applies to the same snapshot: it exists, it names its own scenario, that scenario
 * is the one the Call was created for, and its content hashes to the recorded
 * fingerprint. Anything else is corruption, not a reason to use live data.
 */
export function verifiedFrozenScenario(input: {
    callAiScenarioId: string | null
    scenarioRef: string
    scenarioSnapshot: unknown
    scenarioFingerprint: string
}): BridgeScenarioV1 {
    const snapshot = input.scenarioSnapshot
    if (!isRecord(snapshot)) throw new AiCallFrozenScenarioError('frozen_scenario_snapshot_missing')
    if (snapshot.scenarioId !== input.scenarioRef) {
        throw new AiCallFrozenScenarioError('frozen_scenario_identity_mismatch')
    }
    if (input.scenarioRef !== input.callAiScenarioId) {
        throw new AiCallFrozenScenarioError('frozen_scenario_call_mismatch')
    }
    if (aiCallCampaignSha256(snapshot as AiCallCampaignJson) !== input.scenarioFingerprint) {
        throw new AiCallFrozenScenarioError('frozen_scenario_fingerprint_mismatch')
    }
    if (typeof snapshot.systemPrompt !== 'string' || snapshot.systemPrompt === '') {
        throw new AiCallFrozenScenarioError('frozen_scenario_prompt_missing')
    }
    return {
        id: input.scenarioRef,
        name: typeof snapshot.name === 'string' ? snapshot.name : input.scenarioRef,
        systemPrompt: snapshot.systemPrompt,
        questions: snapshot.questions ?? [],
        targetDurationSec: typeof snapshot.targetDurationSec === 'number' ? snapshot.targetDurationSec : null,
    }
}

/** Reads the Call the bridge asked about, plus its frozen scenario when it has one. */
export async function resolveBridgeCallScenarioV1(
    fsUuid: string,
): Promise<BridgeCallScenarioResolutionV1 | null> {
    const call = await (prisma as unknown as {
        call: {
            findUnique(args: unknown): Promise<{
                id: string
                isAi: boolean
                aiScenarioId: string | null
                driverId: string | null
                contactId: string | null
                managerId: string | null
                campaignAttempt: {
                    campaign: { scenarioRef: string; scenarioSnapshot: unknown; scenarioFingerprint: string }
                } | null
            } | null>
        }
    }).call.findUnique({
        where: { fsUuid },
        select: {
            id: true,
            isAi: true,
            aiScenarioId: true,
            driverId: true,
            contactId: true,
            managerId: true,
            campaignAttempt: {
                select: {
                    campaign: {
                        select: { scenarioRef: true, scenarioSnapshot: true, scenarioFingerprint: true },
                    },
                },
            },
        },
    })
    if (!call) return null
    const campaign = call.campaignAttempt?.campaign ?? null
    const resolution: BridgeCallScenarioResolutionV1 = {
        call: {
            id: call.id,
            isAi: call.isAi,
            aiScenarioId: call.aiScenarioId,
            driverId: call.driverId,
            contactId: call.contactId,
            managerId: call.managerId,
        },
        frozenScenario: campaign === null ? null : verifiedFrozenScenario({
            callAiScenarioId: call.aiScenarioId,
            scenarioRef: campaign.scenarioRef,
            scenarioSnapshot: campaign.scenarioSnapshot,
            scenarioFingerprint: campaign.scenarioFingerprint,
        }),
    }
    return resolution
}
