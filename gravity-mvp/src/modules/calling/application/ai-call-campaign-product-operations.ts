import { createHash } from 'node:crypto'
import type {
    AiCallCampaignDetailV1,
    AiCallCampaignSummaryV1,
    ControlAiCallCampaignCommandV1,
    CreateAiCallCampaignCommandV1,
    GetAiCallCampaignQueryV1,
    ListAiCallCampaignsQueryV1,
} from '@/contracts/calling/v1'
import {
    AiCallCampaignConflictError,
    aiCallCampaignSha256,
    freezeAiCallCampaignScenarioSnapshot,
    normalizeAiCallAudienceSnapshot,
    type AiCallCampaignJson,
} from './ai-call-campaign'
import { aiCallCampaignPrismaPort } from '../internal/ai-calls/ai-call-campaign-prisma-adapter'
import { aiCallCampaignProductPrismaPort } from '../internal/ai-calls/ai-call-campaign-product-prisma-adapter'

export interface AiCallCampaignActorV1 {
    id: string
}

function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

function campaignIdentity(actorId: string, requestId: string) {
    const identityKey = `ai-call-campaign:v1:${actorId}:${requestId}`
    return { identityKey, campaignId: `aic_${digest(identityKey)}` }
}

function auditId(campaignId: string, requestId: string, action: string): string {
    return `aicau_${digest(`${campaignId}\0${requestId}\0${action}`)}`
}

function controlAuditId(campaignId: string, requestId: string): string {
    return `aicau_${digest(`${campaignId}\0${requestId}\0control`)}`
}

export function prepareAiCallCampaignCreateV1(
    command: CreateAiCallCampaignCommandV1,
    actor: AiCallCampaignActorV1,
) {
    const { identityKey, campaignId } = campaignIdentity(actor.id, command.requestId)
    const audienceInput = {
        sourceKind: 'explicit_external_snapshot',
        sourceRef: command.audience.sourceRef,
        sourceVersion: command.audience.sourceVersion,
        members: command.audience.members.map((member) => ({
            targetType: 'external' as const,
            targetRef: member.targetRef,
            phoneE164: member.phoneE164,
            provenance: {
                source: 'campaign_product_manual_entry',
                ...(member.label ? { label: member.label } : {}),
            },
        })),
    }
    const audience = normalizeAiCallAudienceSnapshot(campaignId, audienceInput)
    const scheduledAt = command.scheduledAt === null ? null : new Date(command.scheduledAt).toISOString()
    const commandFingerprint = aiCallCampaignSha256({
        version: 1,
        actorId: actor.id,
        requestId: command.requestId,
        campaignId,
        name: command.name,
        scenarioId: command.scenarioId,
        scheduledAt,
        concurrentLimit: command.concurrentLimit,
        ratePerMinute: command.ratePerMinute,
        maxAttempts: command.maxAttempts,
        retryBaseMs: command.retryBaseMs,
        retryMaxMs: command.retryMaxMs,
        audienceFingerprint: audience.fingerprint,
    } as AiCallCampaignJson)
    return { identityKey, campaignId, audienceInput, scheduledAt, commandFingerprint }
}

export function prepareAiCallCampaignScenarioSnapshotV1(
    scenario: Awaited<ReturnType<typeof aiCallCampaignProductPrismaPort.getActiveScenario>>,
) {
    if (!scenario) throw new AiCallCampaignConflictError('scenario_not_found', 'AI call scenario not found')
    return freezeAiCallCampaignScenarioSnapshot(scenario.id, {
        version: 1,
        scenarioId: scenario.id,
        name: scenario.name,
        description: scenario.description ?? null,
        systemPrompt: scenario.systemPrompt,
        questions: scenario.questions,
        targetDurationSec: scenario.targetDurationSec ?? null,
        outcomeSchema: scenario.outcomeSchema ?? null,
        greetingVariants: scenario.greetingVariants ?? null,
        fragments: scenario.fragments ?? null,
        projectId: scenario.projectId,
        projectName: scenario.projectName,
    })
}

async function requireDetail(campaignId: string): Promise<AiCallCampaignDetailV1> {
    const detail = await aiCallCampaignProductPrismaPort.detail({ campaignId, memberLimit: 50 })
    if (!detail) throw new AiCallCampaignConflictError('campaign_not_found', 'campaign not found')
    return detail
}

async function requireExactCreateIdentity(prepared: ReturnType<typeof prepareAiCallCampaignCreateV1>) {
    const identity = await aiCallCampaignPrismaPort.findCreateIdentity({
        campaignId: prepared.campaignId,
        identityKey: prepared.identityKey,
        commandFingerprint: prepared.commandFingerprint,
    })
    if (!identity) {
        throw new AiCallCampaignConflictError('campaign_not_found', 'campaign create identity disappeared')
    }
    return identity
}

export async function createAiCallCampaignV1(
    command: CreateAiCallCampaignCommandV1,
    actor: AiCallCampaignActorV1,
    now = new Date(),
): Promise<AiCallCampaignDetailV1> {
    const prepared = prepareAiCallCampaignCreateV1(command, actor)
    const { identityKey, campaignId } = prepared
    const existing = await aiCallCampaignPrismaPort.findCreateIdentity({
        campaignId,
        identityKey,
        commandFingerprint: prepared.commandFingerprint,
    })
    let state = existing?.state
    if (!existing) {
        const scenario = await aiCallCampaignProductPrismaPort.getActiveScenario(command.scenarioId)
        const frozenScenario = prepareAiCallCampaignScenarioSnapshotV1(scenario)
        const draft = await aiCallCampaignPrismaPort.createDraft({
            campaignId,
            identityKey,
            commandFingerprint: prepared.commandFingerprint,
            name: command.name,
            ...frozenScenario,
            concurrentLimit: command.concurrentLimit,
            ratePerMinute: command.ratePerMinute,
            maxAttempts: command.maxAttempts,
            retryBaseMs: command.retryBaseMs,
            retryMaxMs: command.retryMaxMs,
        }, now, {
            eventId: auditId(campaignId, command.requestId, 'created'),
            actorId: actor.id,
            action: 'created',
            details: {
                requestId: command.requestId,
                scenarioFingerprint: frozenScenario.scenarioFingerprint,
            },
        })
        state = draft.campaign.state
    }

    if (state === 'draft') {
        await aiCallCampaignPrismaPort.freezeAudience(campaignId, prepared.audienceInput, now, {
            eventId: auditId(campaignId, command.requestId, 'audience_frozen'),
            actorId: actor.id,
            action: 'audience_frozen',
            details: { memberCount: command.audience.members.length },
        })
        // freezeAudience can report an exact duplicate when a concurrent
        // create already advanced draft -> ready. Always resume from the
        // authoritative persisted state instead of the stale pre-freeze read.
        state = (await requireExactCreateIdentity(prepared)).state
    }
    if (state === 'ready') {
        try {
            await aiCallCampaignPrismaPort.schedule(
                campaignId,
                prepared.scheduledAt ? new Date(prepared.scheduledAt) : now,
                now,
                {
                    eventId: auditId(campaignId, command.requestId, 'scheduled'),
                    actorId: actor.id,
                    action: 'scheduled',
                    details: { requestedScheduledAt: command.scheduledAt },
                },
            )
        } catch (error) {
            if (!(error instanceof AiCallCampaignConflictError) || error.code !== 'campaign_not_ready') throw error
            const resumed = await requireExactCreateIdentity(prepared)
            // A concurrent exact replay may already have scheduled or even
            // started the campaign. Accept only that proven forward progress;
            // draft/ready still means the schedule operation genuinely failed.
            if (resumed.state === 'draft' || resumed.state === 'ready') throw error
        }
    }
    return requireDetail(campaignId)
}

export async function listAiCallCampaignsV1(query: ListAiCallCampaignsQueryV1): Promise<{
    campaigns: AiCallCampaignSummaryV1[]
    nextCursor: string | null
}> {
    return aiCallCampaignProductPrismaPort.list({
        state: query.state,
        cursor: query.cursor,
        limit: query.limit ?? 25,
    })
}

export async function listActiveAiCallCampaignScenarioOptionsV1(): Promise<Array<{
    id: string
    name: string
}>> {
    return aiCallCampaignProductPrismaPort.listActiveScenarioOptions()
}

export async function getAiCallCampaignV1(query: GetAiCallCampaignQueryV1): Promise<AiCallCampaignDetailV1 | null> {
    return aiCallCampaignProductPrismaPort.detail({
        campaignId: query.campaignId,
        memberCursor: query.memberCursor,
        memberLimit: query.memberLimit ?? 50,
    })
}

export async function controlAiCallCampaignV1(
    command: ControlAiCallCampaignCommandV1,
    actor: AiCallCampaignActorV1,
    now = new Date(),
): Promise<AiCallCampaignDetailV1> {
    const common = {
        eventId: controlAuditId(command.campaignId, command.requestId),
        actorId: actor.id,
        commandFingerprint: aiCallCampaignSha256({
            campaignId: command.campaignId,
            requestId: command.requestId,
            action: command.action,
            actorId: actor.id,
        }),
        details: { requestId: command.requestId },
    }
    if (command.action === 'pause') {
        await aiCallCampaignPrismaPort.pause(command.campaignId, now, { ...common, action: 'paused' })
    } else if (command.action === 'resume') {
        await aiCallCampaignPrismaPort.resume(command.campaignId, now, { ...common, action: 'resumed' })
    } else {
        await aiCallCampaignPrismaPort.cancel(command.campaignId, now, { ...common, action: 'cancel_requested' })
    }
    return requireDetail(command.campaignId)
}
