export const CREATE_AI_CALL_CAMPAIGN_COMMAND_V1 =
    'calling.CreateAiCallCampaignCommand.v1' as const
export const LIST_AI_CALL_CAMPAIGNS_QUERY_V1 =
    'calling.ListAiCallCampaignsQuery.v1' as const
export const GET_AI_CALL_CAMPAIGN_QUERY_V1 =
    'calling.GetAiCallCampaignQuery.v1' as const
export const CONTROL_AI_CALL_CAMPAIGN_COMMAND_V1 =
    'calling.ControlAiCallCampaignCommand.v1' as const

export type AiCallCampaignControlActionV1 = 'pause' | 'resume' | 'cancel'

export interface AiCallCampaignAudienceMemberV1 {
    targetRef: string
    phoneE164: string
    label?: string
}

export interface CreateAiCallCampaignCommandV1 {
    contract: typeof CREATE_AI_CALL_CAMPAIGN_COMMAND_V1
    requestId: string
    name: string
    scenarioId: string
    scheduledAt: string | null
    concurrentLimit: number
    ratePerMinute: number
    maxAttempts: number
    retryBaseMs: number
    retryMaxMs: number
    audience: {
        sourceRef: string
        sourceVersion: string
        members: AiCallCampaignAudienceMemberV1[]
    }
}

export interface ListAiCallCampaignsQueryV1 {
    contract: typeof LIST_AI_CALL_CAMPAIGNS_QUERY_V1
    state?: string
    cursor?: string
    limit?: number
}

export interface GetAiCallCampaignQueryV1 {
    contract: typeof GET_AI_CALL_CAMPAIGN_QUERY_V1
    campaignId: string
    memberCursor?: string
    memberLimit?: number
}

export interface ControlAiCallCampaignCommandV1 {
    contract: typeof CONTROL_AI_CALL_CAMPAIGN_COMMAND_V1
    requestId: string
    campaignId: string
    action: AiCallCampaignControlActionV1
}

export interface AiCallCampaignProgressV1 {
    total: number
    pending: number
    waiting: number
    claimed: number
    running: number
    retryWait: number
    succeeded: number
    failed: number
    excluded: number
    cancelled: number
    completed: number
    percent: number
}

export interface AiCallCampaignCostVisibilityV1 {
    status: 'provider_billing_not_ingested'
    currency: null
    amount: null
    completedCalls: number
    connectedDurationSec: number
    basis: 'crm_answered_interval_only'
}

export interface AiCallCampaignSummaryV1 {
    id: string
    name: string
    scenarioId: string
    state: string
    scheduledAt: string | null
    startedAt: string | null
    completedAt: string | null
    cancelledAt: string | null
    createdAt: string
    updatedAt: string
    concurrentLimit: number
    ratePerMinute: number
    maxAttempts: number
    retryBaseMs: number
    retryMaxMs: number
    failureCode: string | null
    progress: AiCallCampaignProgressV1
    cost: AiCallCampaignCostVisibilityV1
}

export interface AiCallCampaignCallV1 {
    id: string
    status: string
    sessionStatus: string | null
    startedAt: string
    answeredAt: string | null
    endedAt: string | null
    durationSec: number | null
    transcript: string | null
    summary: string | null
    outcome: string | null
    outcomeReason: string | null
    qualificationScore: number | null
    followUpState: string | null
}

export interface AiCallCampaignAttemptV1 {
    id: string
    attemptNumber: number
    launchId: string
    state: string
    claimRevision: number
    providerEffectRef: string | null
    failureCode: string | null
    startedAt: string | null
    completedAt: string | null
    call: AiCallCampaignCallV1 | null
}

export interface AiCallCampaignMemberV1 {
    id: string
    targetRef: string
    phoneE164: string
    label: string | null
    state: string
    excludedReason: string | null
    attemptCount: number
    nextEligibleAt: string | null
    outcomeCode: string | null
    failureCode: string | null
    updatedAt: string
    attempts: AiCallCampaignAttemptV1[]
}

export interface AiCallCampaignAuditEventV1 {
    id: string
    action: string
    actorId: string
    details: Record<string, unknown>
    createdAt: string
}

export interface AiCallCampaignOperationalStateV1 {
    activeLeases: number
    staleClaims: number
    retryWaitMembers: number
    permanentFailures: number
    lastActivityAt: string
    runtimeMode: 'disabled' | 'simulated' | 'unsupported_live'
}

export interface AiCallCampaignDetailV1 extends AiCallCampaignSummaryV1 {
    audience: {
        sourceKind: string | null
        sourceRef: string | null
        sourceVersion: string | null
        frozenAt: string | null
    }
    members: AiCallCampaignMemberV1[]
    nextMemberCursor: string | null
    audit: AiCallCampaignAuditEventV1[]
    operations: AiCallCampaignOperationalStateV1
}

export class AiCallCampaignContractValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: AiCallCampaignContractValidationError['code'], message: string) {
        super(message)
        this.name = 'AiCallCampaignContractValidationError'
        this.code = code
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
    throw new AiCallCampaignContractValidationError('INVALID_CONTRACT', message)
}

function exactString(value: unknown, field: string, maximum = 255): string {
    if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.length > maximum) {
        invalid(`${field} must be a non-empty trimmed string of at most ${maximum} characters`)
    }
    return value
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
        invalid(`${field} must be an integer between ${minimum} and ${maximum}`)
    }
    return value as number
}

function strict(record: Record<string, unknown>, fields: readonly string[], label: string): void {
    const unsupported = Object.keys(record).filter((key) => !fields.includes(key))
    if (unsupported.length > 0) invalid(`unsupported ${label} field(s): ${unsupported.sort().join(', ')}`)
}

function contract(
    value: Record<string, unknown>,
    expected: string,
    prefix: string,
): void {
    if (value.contract === expected) return
    if (typeof value.contract === 'string' && value.contract.startsWith(prefix)) {
        throw new AiCallCampaignContractValidationError(
            'UNSUPPORTED_CONTRACT_VERSION',
            `unsupported contract version: ${value.contract}`,
        )
    }
    invalid(`contract must equal ${expected}`)
}

export function parseCreateAiCallCampaignCommandV1(input: unknown): CreateAiCallCampaignCommandV1 {
    if (!isRecord(input)) invalid('campaign command must be an object')
    strict(input, [
        'contract', 'requestId', 'name', 'scenarioId', 'scheduledAt', 'concurrentLimit',
        'ratePerMinute', 'maxAttempts', 'retryBaseMs', 'retryMaxMs', 'audience',
    ], 'campaign command')
    contract(input, CREATE_AI_CALL_CAMPAIGN_COMMAND_V1, 'calling.CreateAiCallCampaignCommand.')
    exactString(input.requestId, 'requestId', 200)
    exactString(input.name, 'name', 200)
    exactString(input.scenarioId, 'scenarioId')
    if (input.scheduledAt !== null) {
        const scheduledAt = exactString(input.scheduledAt, 'scheduledAt', 64)
        if (!Number.isFinite(Date.parse(scheduledAt))) invalid('scheduledAt must be a valid ISO date or null')
    }
    integer(input.concurrentLimit, 'concurrentLimit', 1, 1_000)
    integer(input.ratePerMinute, 'ratePerMinute', 1, 10_000)
    integer(input.maxAttempts, 'maxAttempts', 1, 20)
    const retryBaseMs = integer(input.retryBaseMs, 'retryBaseMs', 1, 86_400_000)
    const retryMaxMs = integer(input.retryMaxMs, 'retryMaxMs', 1, 604_800_000)
    if (retryMaxMs < retryBaseMs) invalid('retryMaxMs must be at least retryBaseMs')
    if (!isRecord(input.audience)) invalid('audience must be an object')
    strict(input.audience, ['sourceRef', 'sourceVersion', 'members'], 'audience')
    exactString(input.audience.sourceRef, 'audience.sourceRef')
    exactString(input.audience.sourceVersion, 'audience.sourceVersion')
    if (!Array.isArray(input.audience.members)
        || input.audience.members.length < 1
        || input.audience.members.length > 10_000) {
        invalid('audience.members must contain between 1 and 10000 entries')
    }
    const targets = new Set<string>()
    for (const [index, member] of input.audience.members.entries()) {
        if (!isRecord(member)) invalid(`audience.members[${index}] must be an object`)
        strict(member, ['targetRef', 'phoneE164', 'label'], `audience.members[${index}]`)
        const targetRef = exactString(member.targetRef, `audience.members[${index}].targetRef`)
        if (targets.has(targetRef)) invalid(`audience.members[${index}].targetRef is duplicated`)
        targets.add(targetRef)
        const phone = exactString(member.phoneE164, `audience.members[${index}].phoneE164`, 32)
        if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) {
            invalid(`audience.members[${index}].phoneE164 must be E.164`)
        }
        if (member.label !== undefined) exactString(member.label, `audience.members[${index}].label`, 200)
    }
    return input as unknown as CreateAiCallCampaignCommandV1
}

export function parseListAiCallCampaignsQueryV1(input: unknown): ListAiCallCampaignsQueryV1 {
    if (!isRecord(input)) invalid('campaign list query must be an object')
    strict(input, ['contract', 'state', 'cursor', 'limit'], 'campaign list query')
    contract(input, LIST_AI_CALL_CAMPAIGNS_QUERY_V1, 'calling.ListAiCallCampaignsQuery.')
    if (input.state !== undefined) {
        const state = exactString(input.state, 'state', 32)
        if (!['draft', 'ready', 'scheduled', 'running', 'paused', 'cancelling', 'completed', 'cancelled', 'failed'].includes(state)) {
            invalid('state is invalid')
        }
    }
    if (input.cursor !== undefined) exactString(input.cursor, 'cursor', 500)
    if (input.limit !== undefined) integer(input.limit, 'limit', 1, 100)
    return input as unknown as ListAiCallCampaignsQueryV1
}

export function parseGetAiCallCampaignQueryV1(input: unknown): GetAiCallCampaignQueryV1 {
    if (!isRecord(input)) invalid('campaign detail query must be an object')
    strict(input, ['contract', 'campaignId', 'memberCursor', 'memberLimit'], 'campaign detail query')
    contract(input, GET_AI_CALL_CAMPAIGN_QUERY_V1, 'calling.GetAiCallCampaignQuery.')
    exactString(input.campaignId, 'campaignId')
    if (input.memberCursor !== undefined) exactString(input.memberCursor, 'memberCursor', 500)
    if (input.memberLimit !== undefined) integer(input.memberLimit, 'memberLimit', 1, 200)
    return input as unknown as GetAiCallCampaignQueryV1
}

export function parseControlAiCallCampaignCommandV1(input: unknown): ControlAiCallCampaignCommandV1 {
    if (!isRecord(input)) invalid('campaign control command must be an object')
    strict(input, ['contract', 'requestId', 'campaignId', 'action'], 'campaign control command')
    contract(input, CONTROL_AI_CALL_CAMPAIGN_COMMAND_V1, 'calling.ControlAiCallCampaignCommand.')
    exactString(input.requestId, 'requestId', 200)
    exactString(input.campaignId, 'campaignId')
    if (!['pause', 'resume', 'cancel'].includes(String(input.action))) invalid('action is invalid')
    return input as unknown as ControlAiCallCampaignCommandV1
}
