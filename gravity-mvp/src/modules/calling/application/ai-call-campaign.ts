import { createHash } from 'node:crypto'

export const AI_CALL_CAMPAIGN_STATES = [
    'draft',
    'ready',
    'scheduled',
    'running',
    'paused',
    'cancelling',
    'completed',
    'cancelled',
    'failed',
] as const

export const AI_CALL_CAMPAIGN_MEMBER_TERMINAL_STATES = [
    'succeeded',
    'failed',
    'excluded',
    'cancelled',
] as const

export type AiCallCampaignState = typeof AI_CALL_CAMPAIGN_STATES[number]
export type AiCallCampaignMemberState =
    | 'pending'
    | 'waiting'
    | 'claimed'
    | 'running'
    | 'retry_wait'
    | typeof AI_CALL_CAMPAIGN_MEMBER_TERMINAL_STATES[number]

export type AiCallCampaignTargetType = 'contact' | 'driver' | 'external'

type JsonPrimitive = string | number | boolean | null
export type AiCallCampaignJson = JsonPrimitive | AiCallCampaignJson[] | { [key: string]: AiCallCampaignJson }

export interface AiCallCampaignDraftInput {
    campaignId: string
    identityKey: string
    /** Optional complete-command fingerprint supplied by a product application service. */
    commandFingerprint?: string
    name: string
    scenarioRef: string
    concurrentLimit: number
    ratePerMinute: number
    maxAttempts: number
    retryBaseMs: number
    retryMaxMs: number
}

export interface AiCallAudienceMemberInput {
    targetType: AiCallCampaignTargetType
    targetRef: string
    phoneE164: string
    provenance: Record<string, AiCallCampaignJson>
    excludedReason?: string | null
}

export interface AiCallAudienceSnapshotInput {
    sourceKind: string
    sourceRef: string
    sourceVersion: string
    members: readonly AiCallAudienceMemberInput[]
}

export interface NormalizedAiCallAudienceMember {
    memberId: string
    memberKey: string
    targetType: AiCallCampaignTargetType
    targetRef: string
    phoneE164: string
    provenance: Record<string, AiCallCampaignJson>
    excludedReason: string | null
    snapshotFingerprint: string
}

export interface NormalizedAiCallAudienceSnapshot {
    campaignId: string
    sourceKind: string
    sourceRef: string
    sourceVersion: string
    fingerprint: string
    members: readonly NormalizedAiCallAudienceMember[]
}

export class AiCallCampaignInputError extends Error {
    readonly code = 'INVALID_AI_CALL_CAMPAIGN_INPUT' as const

    constructor(message: string) {
        super(message)
        this.name = 'AiCallCampaignInputError'
    }
}

export class AiCallCampaignConflictError extends Error {
    constructor(readonly code: string, message: string) {
        super(message)
        this.name = 'AiCallCampaignConflictError'
    }
}

function invalid(message: string): never {
    throw new AiCallCampaignInputError(message)
}

function exact(value: unknown, name: string, maximum = 255): string {
    if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.length > maximum) {
        invalid(`${name} must be a non-empty trimmed string of at most ${maximum} characters`)
    }
    return value
}

function positiveInteger(value: unknown, name: string, maximum = 1_000_000): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
        invalid(`${name} must be an integer between 1 and ${maximum}`)
    }
    return value as number
}

function isJson(value: unknown, depth = 0): value is AiCallCampaignJson {
    if (depth > 8) return false
    if (value === null || ['string', 'boolean'].includes(typeof value)) return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (Array.isArray(value)) return value.length <= 100 && value.every((item) => isJson(item, depth + 1))
    return typeof value === 'object' && value !== null
        && Object.keys(value as Record<string, unknown>).length <= 100
        && Object.values(value as Record<string, unknown>).every((item) => isJson(item, depth + 1))
}

function canonicalJson(value: AiCallCampaignJson): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    return `{${Object.keys(value).sort().map((key) => (
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
}

export function aiCallCampaignSha256(value: AiCallCampaignJson): string {
    return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function normalizeAiCallCampaignDraft(input: AiCallCampaignDraftInput): AiCallCampaignDraftInput & {
    payloadFingerprint: string
} {
    const normalized: AiCallCampaignDraftInput = {
        campaignId: exact(input?.campaignId, 'campaignId'),
        identityKey: exact(input?.identityKey, 'identityKey'),
        name: exact(input?.name, 'name', 200),
        scenarioRef: exact(input?.scenarioRef, 'scenarioRef'),
        concurrentLimit: positiveInteger(input?.concurrentLimit, 'concurrentLimit', 10_000),
        ratePerMinute: positiveInteger(input?.ratePerMinute, 'ratePerMinute', 60_000),
        maxAttempts: positiveInteger(input?.maxAttempts, 'maxAttempts', 20),
        retryBaseMs: positiveInteger(input?.retryBaseMs, 'retryBaseMs', 86_400_000),
        retryMaxMs: positiveInteger(input?.retryMaxMs, 'retryMaxMs', 604_800_000),
    }
    if (normalized.retryMaxMs < normalized.retryBaseMs) invalid('retryMaxMs must be at least retryBaseMs')
    const commandFingerprint = input.commandFingerprint
    if (commandFingerprint !== undefined && !/^[0-9a-f]{64}$/.test(commandFingerprint)) {
        invalid('commandFingerprint must be a lowercase SHA-256 digest')
    }
    return {
        ...normalized,
        ...(commandFingerprint === undefined ? {} : { commandFingerprint }),
        payloadFingerprint: commandFingerprint
            ?? aiCallCampaignSha256(normalized as unknown as AiCallCampaignJson),
    }
}

export function aiCallCampaignMemberId(
    campaignId: string,
    targetType: AiCallCampaignTargetType,
    targetRef: string,
): string {
    return `aicm_${createHash('sha256').update(`${campaignId}\0${targetType}\0${targetRef}`).digest('hex')}`
}

export function normalizeAiCallAudienceSnapshot(
    campaignIdInput: string,
    input: AiCallAudienceSnapshotInput,
): NormalizedAiCallAudienceSnapshot {
    const campaignId = exact(campaignIdInput, 'campaignId')
    const sourceKind = exact(input?.sourceKind, 'sourceKind', 64)
    const sourceRef = exact(input?.sourceRef, 'sourceRef')
    const sourceVersion = exact(input?.sourceVersion, 'sourceVersion')
    if (!Array.isArray(input?.members) || input.members.length === 0 || input.members.length > 100_000) {
        invalid('members must contain between 1 and 100000 entries')
    }

    const identities = new Set<string>()
    const members = input.members.map((member, index): NormalizedAiCallAudienceMember => {
        if (!['contact', 'driver', 'external'].includes(String(member?.targetType))) {
            invalid(`members[${index}].targetType is invalid`)
        }
        const targetType = member.targetType
        const targetRef = exact(member.targetRef, `members[${index}].targetRef`)
        const phoneE164 = exact(member.phoneE164, `members[${index}].phoneE164`, 32)
        if (!/^\+[1-9][0-9]{7,14}$/.test(phoneE164)) invalid(`members[${index}].phoneE164 must be E.164`)
        if (!isJson(member.provenance) || Array.isArray(member.provenance) || member.provenance === null) {
            invalid(`members[${index}].provenance must be a JSON object`)
        }
        if (new TextEncoder().encode(canonicalJson(member.provenance)).length > 4_096) {
            invalid(`members[${index}].provenance exceeds 4096 bytes`)
        }
        const excludedReason = member.excludedReason == null
            ? null
            : exact(member.excludedReason, `members[${index}].excludedReason`, 128)
        const memberKey = `${targetType}:${targetRef}`
        if (identities.has(memberKey)) throw new AiCallCampaignConflictError(
            'duplicate_audience_member',
            `audience contains duplicate target ${memberKey}`,
        )
        identities.add(memberKey)
        const bounded = {
            targetType,
            targetRef,
            phoneE164,
            provenance: structuredClone(member.provenance),
            excludedReason,
        }
        return {
            memberId: aiCallCampaignMemberId(campaignId, targetType, targetRef),
            memberKey,
            ...bounded,
            snapshotFingerprint: aiCallCampaignSha256(bounded),
        }
    }).sort((left, right) => left.memberKey.localeCompare(right.memberKey))

    const snapshotPayload = {
        campaignId,
        sourceKind,
        sourceRef,
        sourceVersion,
        members: members.map((member) => ({
            memberId: member.memberId,
            memberKey: member.memberKey,
            targetType: member.targetType,
            targetRef: member.targetRef,
            phoneE164: member.phoneE164,
            provenance: member.provenance,
            excludedReason: member.excludedReason,
            snapshotFingerprint: member.snapshotFingerprint,
        })),
    }
    return Object.freeze({
        ...snapshotPayload,
        fingerprint: aiCallCampaignSha256(snapshotPayload),
        members: Object.freeze(members.map((member) => Object.freeze(member))),
    })
}

export function aiCallCampaignAttemptId(memberId: string, attemptNumber: number): string {
    exact(memberId, 'memberId')
    positiveInteger(attemptNumber, 'attemptNumber', 20)
    return `aica_${createHash('sha256').update(`${memberId}\0${attemptNumber}`).digest('hex')}`
}

export function aiCallCampaignLaunchId(memberId: string, attemptNumber: number): string {
    exact(memberId, 'memberId')
    positiveInteger(attemptNumber, 'attemptNumber', 20)
    return `ai-call-launch:v1:${createHash('sha256').update(`${memberId}\0${attemptNumber}`).digest('hex')}`
}

export function aiCallCampaignBackoffMs(input: {
    attemptNumber: number
    retryBaseMs: number
    retryMaxMs: number
}): number {
    const attemptNumber = positiveInteger(input.attemptNumber, 'attemptNumber', 20)
    const retryBaseMs = positiveInteger(input.retryBaseMs, 'retryBaseMs', 86_400_000)
    const retryMaxMs = positiveInteger(input.retryMaxMs, 'retryMaxMs', 604_800_000)
    return Math.min(retryMaxMs, retryBaseMs * (2 ** Math.max(0, attemptNumber - 1)))
}

export function aiCallCampaignRateIntervalMs(ratePerMinute: number): number {
    return Math.max(1, Math.ceil(60_000 / positiveInteger(ratePerMinute, 'ratePerMinute', 60_000)))
}

export function isAiCallCampaignMemberTerminal(state: string): boolean {
    return (AI_CALL_CAMPAIGN_MEMBER_TERMINAL_STATES as readonly string[]).includes(state)
}
