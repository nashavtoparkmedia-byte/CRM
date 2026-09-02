import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import {
    AiCallCampaignConflictError,
    aiCallCampaignAttemptId,
    aiCallCampaignBackoffMs,
    aiCallCampaignLaunchId,
    aiCallCampaignRateIntervalMs,
    aiCallCampaignSha256,
    freezeAiCallCampaignScenarioSnapshot,
    normalizeAiCallAudienceSnapshot,
    normalizeAiCallCampaignDraft,
    type AiCallAudienceSnapshotInput,
    type AiCallCampaignDraftInput,
    type AiCallCampaignJson,
} from '../../application/ai-call-campaign'

interface CampaignRow {
    id: string
    identityKey: string
    payloadFingerprint: string
    name: string
    scenarioRef: string
    scenarioSnapshot: unknown
    scenarioFingerprint: string
    state: string
    audienceSourceKind: string | null
    audienceSourceRef: string | null
    audienceSourceVersion: string | null
    audienceFingerprint: string | null
    audienceFrozenAt: Date | null
    scheduledAt: Date | null
    startedAt: Date | null
    completedAt: Date | null
    cancelledAt: Date | null
    concurrentLimit: number
    ratePerMinute: number
    maxAttempts: number
    retryBaseMs: number
    retryMaxMs: number
    nextAdmitAt: Date | null
    failureCode: string | null
    createdAt: Date
    updatedAt: Date
}

interface MemberRow {
    id: string
    campaignId: string
    memberKey: string
    targetType: string
    targetRef: string
    phoneE164: string
    provenance: unknown
    snapshotFingerprint: string
    excludedReason: string | null
    state: string
    attemptCount: number
    nextEligibleAt: Date | null
    activeAttemptId: string | null
    terminalEventId: string | null
    terminalPayloadFingerprint: string | null
    outcomeCode: string | null
    failureCode: string | null
    createdAt: Date
    updatedAt: Date
}

interface AttemptRow {
    id: string
    campaignId: string
    memberId: string
    attemptNumber: number
    launchId: string
    state: string
    claimRevision: number
    dialExecutionCount: number
    dispatchState: 'not_dispatched' | 'acceptance_unknown' | 'accepted'
    dispatchAuthorizedAt: Date | null
    dispatchAcceptedAt: Date | null
    dispatchReceiptRef: string | null
    claimFence: string | null
    claimedBy: string | null
    claimUntil: Date | null
    admissionLeaseId: string | null
    dialEffectRef: string | null
    callId: string | null
    resultEventId: string | null
    resultFingerprint: string | null
    failureCode: string | null
    startedAt: Date | null
    completedAt: Date | null
    createdAt: Date
    updatedAt: Date
}

interface RawSqlExecutor {
    $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
}

interface RawSqlDatabase extends RawSqlExecutor {
    $transaction<T>(operation: (tx: RawSqlExecutor) => Promise<T>): Promise<T>
}

const database = prisma as unknown as RawSqlDatabase
const AUDIENCE_INSERT_BATCH_SIZE = 500

interface ClaimCandidate extends AttemptRow {
    campaignState: string
    scenarioRef: string
    scenarioSnapshot: unknown
    scenarioFingerprint: string
    concurrentLimit: number
    ratePerMinute: number
    maxAttempts: number
    retryBaseMs: number
    retryMaxMs: number
    memberKey: string
    targetType: string
    targetRef: string
    phoneE164: string
    memberState: string
}

export interface AiCallCampaignLaunchClaim {
    attemptId: string
    launchId: string
    campaignId: string
    memberId: string
    memberKey: string
    targetType: string
    targetRef: string
    phoneE164: string
    scenarioRef: string
    scenarioSnapshot: Record<string, AiCallCampaignJson>
    scenarioFingerprint: string
    attemptNumber: number
    claimRevision: number
    claimFence: string
    claimUntil: Date
    workerId: string
}

export interface AiCallAdmissionGrant {
    leaseId: string
    leaseFence: string
    leaseUntil: Date
    replayed: boolean
}

export type AiCallAdmissionDecision =
    | { kind: 'acquired'; grant: AiCallAdmissionGrant }
    | { kind: 'blocked'; reason: 'global_concurrency' | 'campaign_concurrency' | 'rate'; retryAt: Date }
    | { kind: 'campaign_not_running' }

export type AiCallCampaignAttemptResultInput = {
    attemptId: string
    resultEventId: string
    kind: 'success' | 'retryable_failure' | 'permanent_failure'
    outcomeCode?: string | null
    failureCode?: string | null
    claimFence?: string
    leaseFence?: string
    dialEffectRef?: string
    callId?: string
    providerAccepted?: boolean
    now: Date
}

export interface AiCallCampaignAuditInput {
    eventId: string
    actorId: string
    action: 'created' | 'audience_frozen' | 'scheduled' | 'paused' | 'resumed' | 'cancel_requested'
    commandFingerprint?: string
    details?: Record<string, AiCallCampaignJson>
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

function bounded(value: unknown, name: string, maximum = 255): string {
    if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.length > maximum) {
        throw new AiCallCampaignConflictError('invalid_runtime_input', `${name} is invalid`)
    }
    return value
}

function claimFence(attemptId: string, revision: number, workerId: string, claimUntil: Date): string {
    return sha256(`${attemptId}\0${revision}\0${workerId}\0${claimUntil.toISOString()}`)
}

function leaseIdentity(attemptId: string): string {
    return `aicl_${sha256(attemptId)}`
}

function scenarioForLaunch(input: {
    scenarioRef: string
    scenarioSnapshot: unknown
    scenarioFingerprint: string
}): Pick<AiCallCampaignLaunchClaim, 'scenarioRef' | 'scenarioSnapshot' | 'scenarioFingerprint'> {
    const frozen = freezeAiCallCampaignScenarioSnapshot(input.scenarioRef, input.scenarioSnapshot)
    if (frozen.scenarioFingerprint !== input.scenarioFingerprint) {
        throw new AiCallCampaignConflictError(
            'scenario_snapshot_invalid',
            'campaign scenario snapshot fingerprint does not match stored bytes',
        )
    }
    return frozen
}

async function appendAudit(
    tx: RawSqlExecutor,
    campaignId: string,
    audit: AiCallCampaignAuditInput | {
        eventId: string
        actorId: string
        action:
            | 'started'
            | 'cancelled'
            | 'completed'
            | 'failed'
            | 'admission_blocked'
            | 'claim_recovered'
            | 'retry_scheduled'
            | 'dispatch_authorized'
            | 'dispatch_reconcile_started'
            | 'attempt_succeeded'
            | 'attempt_failed'
        details?: Record<string, AiCallCampaignJson>
    },
    now: Date,
): Promise<void> {
    await tx.$executeRawUnsafe(`
        INSERT INTO "AiCallCampaignAuditEvent" (
            "id", "campaignId", "actorId", "action", "details", "createdAt"
        ) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
        ON CONFLICT ("id") DO NOTHING
    `,
    bounded(audit.eventId, 'audit.eventId'),
    campaignId,
    bounded(audit.actorId, 'audit.actorId'),
    audit.action,
    JSON.stringify(audit.details ?? {}),
    now)
}

async function reserveControlAudit(
    tx: RawSqlExecutor,
    campaignId: string,
    audit: AiCallCampaignAuditInput,
    now: Date,
): Promise<'reserved' | 'duplicate'> {
    const fingerprint = bounded(audit.commandFingerprint, 'audit.commandFingerprint', 64)
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
        throw new AiCallCampaignConflictError('invalid_runtime_input', 'audit.commandFingerprint is invalid')
    }
    const existing = await tx.$queryRawUnsafe<Array<{
        actorId: string
        action: string
        details: unknown
    }>>(`
        SELECT "actorId", "action", "details"
        FROM "AiCallCampaignAuditEvent" WHERE "id"=$1 FOR UPDATE
    `, bounded(audit.eventId, 'audit.eventId'))
    if (existing[0]) {
        const details = existing[0].details && typeof existing[0].details === 'object'
            && !Array.isArray(existing[0].details)
            ? existing[0].details as Record<string, unknown>
            : {}
        if (existing[0].actorId === audit.actorId
            && existing[0].action === audit.action
            && details.commandFingerprint === fingerprint) {
            return 'duplicate'
        }
        throw new AiCallCampaignConflictError(
            'campaign_command_identity_collision',
            'campaign command identity is already bound to a different payload',
        )
    }
    await appendAudit(tx, campaignId, {
        ...audit,
        details: { ...(audit.details ?? {}), commandFingerprint: fingerprint },
    }, now)
    return 'reserved'
}

async function campaignForUpdate(tx: RawSqlExecutor, campaignId: string): Promise<CampaignRow | null> {
    const rows = await tx.$queryRawUnsafe<CampaignRow[]>(`
        SELECT "id", "identityKey", "payloadFingerprint", "name", "scenarioRef",
               "scenarioSnapshot", "scenarioFingerprint", "state",
               "audienceSourceKind", "audienceSourceRef", "audienceSourceVersion", "audienceFingerprint",
               "audienceFrozenAt", "scheduledAt", "startedAt", "completedAt", "cancelledAt",
               "concurrentLimit", "ratePerMinute", "maxAttempts", "retryBaseMs", "retryMaxMs",
               "nextAdmitAt", "failureCode", "createdAt", "updatedAt"
        FROM "AiCallCampaign"
        WHERE "id" = $1 FOR UPDATE
    `, campaignId)
    return rows[0] ?? null
}

async function updateCampaignTerminalState(tx: RawSqlExecutor, campaign: CampaignRow, now: Date): Promise<string> {
    const counts = await tx.$queryRawUnsafe<Array<{ remaining: number }>>(`
        SELECT COUNT(*)::int AS "remaining"
        FROM "AiCallCampaignMember"
        WHERE "campaignId" = $1
          AND "state" NOT IN ('succeeded', 'failed', 'excluded', 'cancelled')
    `, campaign.id)
    if ((counts[0]?.remaining ?? 0) !== 0) return campaign.state
    const terminal = campaign.state === 'cancelling' ? 'cancelled' : 'completed'
    const updated = await tx.$executeRawUnsafe(`
        UPDATE "AiCallCampaign"
        SET "state" = $2,
            "completedAt" = CASE WHEN $2 = 'completed' THEN $3 ELSE "completedAt" END,
            "cancelledAt" = CASE WHEN $2 = 'cancelled' THEN $3 ELSE "cancelledAt" END,
            "updatedAt" = $3
        WHERE "id" = $1 AND "state" IN ('running', 'paused', 'cancelling')
    `, campaign.id, terminal, now)
    if (updated === 1) {
        await appendAudit(tx, campaign.id, {
            eventId: `aicau_${sha256(`${campaign.id}\0${terminal}`)}`,
            actorId: 'system:ai-call-campaign-runtime',
            action: terminal,
            details: { source: 'terminal_settlement' },
        }, now)
    }
    return terminal
}

export const aiCallCampaignPrismaPort = {
    async findCreateIdentity(input: {
        campaignId: string
        identityKey: string
        commandFingerprint: string
    }): Promise<{ campaignId: string; state: string } | null> {
        const rows = await database.$queryRawUnsafe<CampaignRow[]>(`
            SELECT "id", "identityKey", "payloadFingerprint", "name", "scenarioRef",
                   "scenarioSnapshot", "scenarioFingerprint", "state",
                   "audienceSourceKind", "audienceSourceRef", "audienceSourceVersion", "audienceFingerprint",
                   "audienceFrozenAt", "scheduledAt", "startedAt", "completedAt", "cancelledAt",
                   "concurrentLimit", "ratePerMinute", "maxAttempts", "retryBaseMs", "retryMaxMs",
                   "nextAdmitAt", "failureCode", "createdAt", "updatedAt"
            FROM "AiCallCampaign"
            WHERE "id"=$1 OR "identityKey"=$2
            ORDER BY CASE WHEN "id"=$1 THEN 0 ELSE 1 END
            LIMIT 1
        `, bounded(input.campaignId, 'campaignId'), bounded(input.identityKey, 'identityKey'))
        const stored = rows[0]
        if (!stored) return null
        if (stored.id !== input.campaignId || stored.identityKey !== input.identityKey
            || stored.payloadFingerprint !== input.commandFingerprint) {
            throw new AiCallCampaignConflictError(
                'campaign_identity_collision',
                'campaign identity is already bound to a different payload',
            )
        }
        return { campaignId: stored.id, state: stored.state }
    },

    async createDraft(input: AiCallCampaignDraftInput, now = new Date(), audit?: AiCallCampaignAuditInput) {
        const draft = normalizeAiCallCampaignDraft(input)
        return database.$transaction(async (tx) => {
            const inserted = await tx.$executeRawUnsafe(`
                INSERT INTO "AiCallCampaign" (
                    "id", "identityKey", "payloadFingerprint", "name", "scenarioRef",
                    "scenarioSnapshot", "scenarioFingerprint", "state",
                    "concurrentLimit", "ratePerMinute", "maxAttempts", "retryBaseMs", "retryMaxMs",
                    "createdAt", "updatedAt"
                ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'draft', $8, $9, $10, $11, $12, $13, $13)
                ON CONFLICT DO NOTHING
            `,
            draft.campaignId,
            draft.identityKey,
            draft.payloadFingerprint,
            draft.name,
            draft.scenarioRef,
            JSON.stringify(draft.scenarioSnapshot),
            draft.scenarioFingerprint,
            draft.concurrentLimit,
            draft.ratePerMinute,
            draft.maxAttempts,
            draft.retryBaseMs,
            draft.retryMaxMs,
            now)
            const rows = await tx.$queryRawUnsafe<CampaignRow[]>(`
                SELECT "id", "identityKey", "payloadFingerprint", "name", "scenarioRef",
                       "scenarioSnapshot", "scenarioFingerprint", "state",
                       "audienceSourceKind", "audienceSourceRef", "audienceSourceVersion", "audienceFingerprint",
                       "audienceFrozenAt", "scheduledAt", "startedAt", "completedAt", "cancelledAt",
                       "concurrentLimit", "ratePerMinute", "maxAttempts", "retryBaseMs", "retryMaxMs",
                       "nextAdmitAt", "failureCode", "createdAt", "updatedAt"
                FROM "AiCallCampaign"
                WHERE "id" = $1 OR "identityKey" = $2
                ORDER BY CASE WHEN "id" = $1 THEN 0 ELSE 1 END
                LIMIT 1
            `, draft.campaignId, draft.identityKey)
            const stored = rows[0]
            if (!stored || stored.id !== draft.campaignId || stored.identityKey !== draft.identityKey
                || stored.payloadFingerprint !== draft.payloadFingerprint) {
                throw new AiCallCampaignConflictError(
                    'campaign_identity_collision',
                    'campaign identity is already bound to a different payload',
                )
            }
            if (inserted === 1 && audit) await appendAudit(tx, stored.id, audit, now)
            return { status: inserted === 1 ? 'created' as const : 'duplicate' as const, campaign: stored }
        })
    },

    async freezeAudience(campaignIdInput: string, input: AiCallAudienceSnapshotInput, now = new Date(), audit?: AiCallCampaignAuditInput) {
        const campaignId = bounded(campaignIdInput, 'campaignId')
        const snapshot = normalizeAiCallAudienceSnapshot(campaignId, input)
        return database.$transaction(async (tx) => {
            const campaign = await campaignForUpdate(tx, campaignId)
            if (!campaign) throw new AiCallCampaignConflictError('campaign_not_found', 'campaign not found')
            if (campaign.state !== 'draft') {
                if (campaign.audienceFingerprint === snapshot.fingerprint) {
                    return { status: 'duplicate' as const, snapshot }
                }
                throw new AiCallCampaignConflictError('audience_frozen', 'campaign audience is already frozen')
            }
            for (let offset = 0; offset < snapshot.members.length; offset += AUDIENCE_INSERT_BATCH_SIZE) {
                const batch = snapshot.members.slice(offset, offset + AUDIENCE_INSERT_BATCH_SIZE).map((member) => ({
                    memberId: member.memberId,
                    memberKey: member.memberKey,
                    targetType: member.targetType,
                    targetRef: member.targetRef,
                    phoneE164: member.phoneE164,
                    provenance: member.provenance,
                    snapshotFingerprint: member.snapshotFingerprint,
                    excludedReason: member.excludedReason,
                    state: member.excludedReason ? 'excluded' : 'pending',
                    nextEligibleAt: member.excludedReason ? null : now.toISOString(),
                }))
                await tx.$executeRawUnsafe(`
                    INSERT INTO "AiCallCampaignMember" (
                        "id", "campaignId", "memberKey", "targetType", "targetRef", "phoneE164",
                        "provenance", "snapshotFingerprint", "excludedReason", "state", "nextEligibleAt",
                        "createdAt", "updatedAt"
                    )
                    SELECT member."memberId", $1, member."memberKey", member."targetType",
                           member."targetRef", member."phoneE164", member."provenance",
                           member."snapshotFingerprint", member."excludedReason", member."state",
                           member."nextEligibleAt", $3, $3
                    FROM jsonb_to_recordset($2::jsonb) AS member(
                        "memberId" text,
                        "memberKey" text,
                        "targetType" text,
                        "targetRef" text,
                        "phoneE164" text,
                        "provenance" jsonb,
                        "snapshotFingerprint" text,
                        "excludedReason" text,
                        "state" text,
                        "nextEligibleAt" timestamptz
                    )
                `,
                campaignId,
                JSON.stringify(batch),
                now)
            }
            await tx.$executeRawUnsafe(`
                UPDATE "AiCallCampaign"
                SET "state" = 'ready',
                    "audienceSourceKind" = $2,
                    "audienceSourceRef" = $3,
                    "audienceSourceVersion" = $4,
                    "audienceFingerprint" = $5,
                    "audienceFrozenAt" = $6,
                    "updatedAt" = $6
                WHERE "id" = $1
            `,
            campaignId,
            snapshot.sourceKind,
            snapshot.sourceRef,
            snapshot.sourceVersion,
            snapshot.fingerprint,
            now)
            if (audit) await appendAudit(tx, campaignId, audit, now)
            return { status: 'frozen' as const, snapshot }
        })
    },

    async schedule(campaignIdInput: string, scheduledAt: Date, now = new Date(), audit?: AiCallCampaignAuditInput) {
        const campaignId = bounded(campaignIdInput, 'campaignId')
        if (!(scheduledAt instanceof Date) || !Number.isFinite(scheduledAt.getTime())) {
            throw new AiCallCampaignConflictError('invalid_schedule', 'scheduledAt is invalid')
        }
        return database.$transaction(async (tx) => {
            const campaign = await campaignForUpdate(tx, campaignId)
            if (!campaign) throw new AiCallCampaignConflictError('campaign_not_found', 'campaign not found')
            if (campaign.state === 'scheduled' && campaign.scheduledAt?.getTime() === scheduledAt.getTime()) {
                return { status: 'duplicate' as const, campaign }
            }
            if (campaign.state !== 'ready') throw new AiCallCampaignConflictError('campaign_not_ready', 'campaign is not ready')
            const rows = await tx.$queryRawUnsafe<CampaignRow[]>(`
                UPDATE "AiCallCampaign"
                SET "state" = 'scheduled', "scheduledAt" = $2, "updatedAt" = $3
                WHERE "id" = $1
                RETURNING *
            `, campaignId, scheduledAt, now)
            if (audit) await appendAudit(tx, campaignId, audit, now)
            return { status: 'scheduled' as const, campaign: rows[0] }
        })
    },

    async startDueCampaigns(now: Date, limit = 25): Promise<string[]> {
        const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
        return database.$transaction(async (tx) => {
            const candidates = await tx.$queryRawUnsafe<Array<{ id: string }>>(`
                SELECT "id"
                FROM "AiCallCampaign"
                WHERE "state" = 'scheduled' AND "scheduledAt" <= $1
                ORDER BY "scheduledAt" ASC, "createdAt" ASC, "id" ASC
                FOR UPDATE SKIP LOCKED
                LIMIT $2
            `, now, boundedLimit)
            const started: string[] = []
            for (const candidate of candidates) {
                const count = await tx.$executeRawUnsafe(`
                    UPDATE "AiCallCampaign"
                    SET "state" = 'running', "startedAt" = COALESCE("startedAt", $2), "updatedAt" = $2
                    WHERE "id" = $1 AND "state" = 'scheduled'
                `, candidate.id, now)
                if (count === 1) {
                    started.push(candidate.id)
                    await appendAudit(tx, candidate.id, {
                        eventId: `aicau_${sha256(`${candidate.id}\0started`)}`,
                        actorId: 'system:ai-call-campaign-runtime',
                        action: 'started',
                        details: { source: 'due_scheduler' },
                    }, now)
                    const campaign = await campaignForUpdate(tx, candidate.id)
                    if (campaign) await updateCampaignTerminalState(tx, campaign, now)
                }
            }
            return started
        })
    },

    async pause(campaignIdInput: string, now = new Date(), audit?: AiCallCampaignAuditInput) {
        const campaignId = bounded(campaignIdInput, 'campaignId')
        return database.$transaction(async (tx) => {
            const campaign = await campaignForUpdate(tx, campaignId)
            if (!campaign) throw new AiCallCampaignConflictError('campaign_not_found', 'campaign not found')
            if (audit && await reserveControlAudit(tx, campaignId, audit, now) === 'duplicate') {
                return { status: 'duplicate' as const }
            }
            if (campaign.state === 'paused') return { status: 'duplicate' as const }
            if (campaign.state !== 'running') throw new AiCallCampaignConflictError('campaign_not_running', 'campaign is not running')
            await tx.$executeRawUnsafe(`UPDATE "AiCallCampaign" SET "state"='paused', "updatedAt"=$2 WHERE "id"=$1`, campaignId, now)
            return { status: 'paused' as const }
        })
    },

    async resume(campaignIdInput: string, now = new Date(), audit?: AiCallCampaignAuditInput) {
        const campaignId = bounded(campaignIdInput, 'campaignId')
        return database.$transaction(async (tx) => {
            const campaign = await campaignForUpdate(tx, campaignId)
            if (!campaign) throw new AiCallCampaignConflictError('campaign_not_found', 'campaign not found')
            if (audit && await reserveControlAudit(tx, campaignId, audit, now) === 'duplicate') {
                return { status: 'duplicate' as const }
            }
            if (campaign.state === 'running') return { status: 'duplicate' as const }
            if (campaign.state !== 'paused') throw new AiCallCampaignConflictError('campaign_not_paused', 'campaign is not paused')
            await tx.$executeRawUnsafe(`UPDATE "AiCallCampaign" SET "state"='running', "updatedAt"=$2 WHERE "id"=$1`, campaignId, now)
            return { status: 'running' as const }
        })
    },

    async cancel(campaignIdInput: string, now = new Date(), audit?: AiCallCampaignAuditInput) {
        const campaignId = bounded(campaignIdInput, 'campaignId')
        return database.$transaction(async (tx) => {
            const campaign = await campaignForUpdate(tx, campaignId)
            if (!campaign) throw new AiCallCampaignConflictError('campaign_not_found', 'campaign not found')
            if (audit && await reserveControlAudit(tx, campaignId, audit, now) === 'duplicate') {
                return { status: 'duplicate' as const }
            }
            if (campaign.state === 'cancelled') return { status: 'duplicate' as const }
            if (['completed', 'failed'].includes(campaign.state)) {
                throw new AiCallCampaignConflictError('campaign_terminal', 'campaign is terminal')
            }
            await tx.$executeRawUnsafe(`
                UPDATE "AiCallCampaignMember"
                SET "state"='cancelled', "activeAttemptId"=NULL, "nextEligibleAt"=NULL, "updatedAt"=$2
                WHERE "campaignId"=$1 AND "state" IN ('pending','waiting','claimed','running','retry_wait')
                  AND NOT EXISTS (
                    SELECT 1 FROM "AiCallCampaignAttempt" attempt
                    WHERE attempt."id"="AiCallCampaignMember"."activeAttemptId"
                      AND attempt."dispatchState" <> 'not_dispatched'
                  )
            `, campaignId, now)
            await tx.$executeRawUnsafe(`
                UPDATE "AiCallCampaignAttempt"
                SET "state"='cancelled', "claimFence"=NULL, "claimedBy"=NULL, "claimUntil"=NULL,
                    "completedAt"=$2, "updatedAt"=$2
                WHERE "campaignId"=$1 AND "state" IN ('waiting','claimed','running')
                  AND "dispatchState"='not_dispatched'
            `, campaignId, now)
            await tx.$executeRawUnsafe(`
                UPDATE "AiCallAdmissionLease"
                SET "releasedAt"=$2, "releaseReason"='campaign_cancelled', "updatedAt"=$2
                WHERE "campaignId"=$1 AND "releasedAt" IS NULL
                  AND "attemptId" IN (
                    SELECT "id" FROM "AiCallCampaignAttempt" WHERE "campaignId"=$1 AND "state"='cancelled'
                  )
            `, campaignId, now)
            const active = await tx.$queryRawUnsafe<Array<{ count: number }>>(`
                SELECT COUNT(*)::int AS "count" FROM "AiCallCampaignMember"
                WHERE "campaignId"=$1 AND "state" IN ('claimed','running')
                  AND EXISTS (
                    SELECT 1 FROM "AiCallCampaignAttempt" attempt
                    WHERE attempt."id"="AiCallCampaignMember"."activeAttemptId"
                      AND attempt."dispatchState" <> 'not_dispatched'
                  )
            `, campaignId)
            const state = (active[0]?.count ?? 0) > 0 ? 'cancelling' : 'cancelled'
            await tx.$executeRawUnsafe(`
                UPDATE "AiCallCampaign"
                SET "state"=$2, "cancelledAt"=CASE WHEN $2='cancelled' THEN $3 ELSE NULL END, "updatedAt"=$3
                WHERE "id"=$1
            `, campaignId, state, now)
            if (state === 'cancelled') {
                await appendAudit(tx, campaignId, {
                    eventId: `aicau_${sha256(`${campaignId}\0cancelled`)}`,
                    actorId: 'system:ai-call-campaign-runtime',
                    action: 'cancelled',
                    details: { source: 'command_settlement' },
                }, now)
            }
            return { status: state as 'cancelling' | 'cancelled' }
        })
    },

    async claimNextLaunch(input: { workerId: string; now: Date; leaseMs: number }): Promise<AiCallCampaignLaunchClaim | null> {
        const workerId = bounded(input.workerId, 'workerId')
        const leaseMs = Math.max(1, Math.min(300_000, Math.trunc(input.leaseMs)))
        const claimUntil = new Date(input.now.getTime() + leaseMs)
        return database.$transaction(async (tx) => {
            // Cancellation and every attempt transition take the campaign lock
            // before member/attempt locks. Select and lock one eligible campaign
            // first so a claimant can never hold a child row while waiting for
            // the campaign FK lock.
            const eligibleCampaigns = await tx.$queryRawUnsafe<Array<{ id: string }>>(`
                SELECT c."id"
                FROM "AiCallCampaign" c
                WHERE (
                    EXISTS (
                        SELECT 1
                        FROM "AiCallCampaignAttempt" a
                        JOIN "AiCallCampaignMember" m ON m."id"=a."memberId"
                        WHERE a."campaignId"=c."id"
                          AND (
                            (c."state"='running'
                             AND a."state"='waiting' AND m."state"='waiting'
                             AND m."nextEligibleAt" <= $1)
                            OR
                            (c."state" IN ('running','paused','cancelling')
                             AND (c."state"='running' OR a."dispatchState" <> 'not_dispatched')
                             AND (
                               (a."state"='claimed' AND m."state"='claimed' AND a."claimUntil" <= $1)
                               OR (a."state"='running' AND m."state"='running' AND a."claimUntil" <= $1)
                             )
                             AND NOT EXISTS (
                               SELECT 1 FROM "AiCallAdmissionLease" lease
                               WHERE lease."attemptId"=a."id" AND lease."releasedAt" IS NULL
                                 AND lease."leaseUntil">$1
                             ))
                          )
                    )
                    OR (
                        c."state"='running'
                        AND EXISTS (
                            SELECT 1 FROM "AiCallCampaignMember" m
                            WHERE m."campaignId"=c."id"
                              AND m."state" IN ('pending','retry_wait')
                              AND (m."nextEligibleAt" IS NULL OR m."nextEligibleAt" <= $1)
                              AND m."attemptCount" < c."maxAttempts"
                        )
                    )
                )
                ORDER BY COALESCE(c."scheduledAt", c."createdAt") ASC, c."id" ASC
                FOR UPDATE OF c
                LIMIT 1
            `, input.now)
            const eligibleCampaign = eligibleCampaigns[0]
            if (!eligibleCampaign) return null
            const campaign = await campaignForUpdate(tx, eligibleCampaign.id)
            if (!campaign) return null

            const rows = await tx.$queryRawUnsafe<ClaimCandidate[]>(`
                SELECT a.*, c."state" AS "campaignState", c."scenarioRef",
                       c."scenarioSnapshot", c."scenarioFingerprint", c."concurrentLimit",
                       c."ratePerMinute", c."maxAttempts", c."retryBaseMs", c."retryMaxMs",
                       m."memberKey", m."targetType", m."targetRef", m."phoneE164", m."state" AS "memberState"
                FROM "AiCallCampaignAttempt" a
                JOIN "AiCallCampaignMember" m ON m."id"=a."memberId"
                JOIN "AiCallCampaign" c ON c."id"=a."campaignId"
                WHERE a."campaignId"=$2
                  AND (
                    (c."state"='running'
                     AND a."state"='waiting' AND m."state"='waiting' AND m."nextEligibleAt" <= $1)
                    OR
                    (c."state" IN ('running','paused','cancelling')
                     AND (c."state"='running' OR a."dispatchState" <> 'not_dispatched')
                     AND (
                       (a."state"='claimed' AND m."state"='claimed' AND a."claimUntil" <= $1)
                       OR (a."state"='running' AND m."state"='running' AND a."claimUntil" <= $1)
                     )
                     AND NOT EXISTS (
                       SELECT 1 FROM "AiCallAdmissionLease" lease
                       WHERE lease."attemptId"=a."id" AND lease."releasedAt" IS NULL
                         AND lease."leaseUntil">$1
                     ))
                  )
                ORDER BY COALESCE(m."nextEligibleAt", a."claimUntil") ASC, a."createdAt" ASC, a."id" ASC
                FOR UPDATE OF a, m SKIP LOCKED
                LIMIT 1
            `, input.now, campaign.id)

            if (rows[0]) {
                const candidate = rows[0]
                const scenario = scenarioForLaunch(candidate)
                const recovered = candidate.state === 'claimed' || candidate.state === 'running'
                const revision = candidate.claimRevision + 1
                const fence = claimFence(candidate.id, revision, workerId, claimUntil)
                await tx.$executeRawUnsafe(`
                    UPDATE "AiCallCampaignAttempt"
                    SET "state"='claimed', "claimRevision"=$2, "claimFence"=$3,
                        "claimedBy"=$4, "claimUntil"=$5, "updatedAt"=$6
                    WHERE "id"=$1
                `, candidate.id, revision, fence, workerId, claimUntil, input.now)
                await tx.$executeRawUnsafe(`
                    UPDATE "AiCallCampaignMember"
                    SET "state"='claimed', "nextEligibleAt"=NULL, "updatedAt"=$2
                    WHERE "id"=$1
                `, candidate.memberId, input.now)
                if (recovered) {
                    await appendAudit(tx, candidate.campaignId, {
                        eventId: `aicau_${sha256(`${candidate.id}\0claim-recovered\0${revision}`)}`,
                        actorId: 'system:ai-call-campaign-runtime',
                        action: 'claim_recovered',
                        details: {
                            attemptId: candidate.id,
                            claimRevision: revision,
                            priorState: candidate.state,
                        },
                    }, input.now)
                }
                return {
                    attemptId: candidate.id,
                    launchId: candidate.launchId,
                    campaignId: candidate.campaignId,
                    memberId: candidate.memberId,
                    memberKey: candidate.memberKey,
                    targetType: candidate.targetType,
                    targetRef: candidate.targetRef,
                    phoneE164: candidate.phoneE164,
                    ...scenario,
                    attemptNumber: candidate.attemptNumber,
                    claimRevision: revision,
                    claimFence: fence,
                    claimUntil,
                    workerId,
                }
            }

            const members = await tx.$queryRawUnsafe<Array<MemberRow & {
                scenarioRef: string
                scenarioSnapshot: unknown
                scenarioFingerprint: string
                maxAttempts: number
            }>>(`
                SELECT m.*, c."scenarioRef", c."scenarioSnapshot", c."scenarioFingerprint", c."maxAttempts"
                FROM "AiCallCampaignMember" m
                JOIN "AiCallCampaign" c ON c."id"=m."campaignId"
                WHERE c."id"=$2 AND c."state"='running'
                  AND m."state" IN ('pending','retry_wait')
                  AND (m."nextEligibleAt" IS NULL OR m."nextEligibleAt" <= $1)
                  AND m."attemptCount" < c."maxAttempts"
                ORDER BY COALESCE(m."nextEligibleAt", m."createdAt") ASC, m."id" ASC
                FOR UPDATE OF m SKIP LOCKED
                LIMIT 1
            `, input.now, campaign.id)
            const member = members[0]
            if (!member) return null
            const scenario = scenarioForLaunch(member)
            const attemptNumber = member.attemptCount + 1
            const attemptId = aiCallCampaignAttemptId(member.id, attemptNumber)
            const launchId = aiCallCampaignLaunchId(member.id, attemptNumber)
            const fence = claimFence(attemptId, 1, workerId, claimUntil)
            await tx.$executeRawUnsafe(`
                INSERT INTO "AiCallCampaignAttempt" (
                    "id", "campaignId", "memberId", "attemptNumber", "launchId", "state",
                    "claimRevision", "claimFence", "claimedBy", "claimUntil", "createdAt", "updatedAt"
                ) VALUES ($1,$2,$3,$4,$5,'claimed',1,$6,$7,$8,$9,$9)
            `,
            attemptId,
            member.campaignId,
            member.id,
            attemptNumber,
            launchId,
            fence,
            workerId,
            claimUntil,
            input.now)
            await tx.$executeRawUnsafe(`
                UPDATE "AiCallCampaignMember"
                SET "state"='claimed', "attemptCount"=$2, "activeAttemptId"=$3,
                    "nextEligibleAt"=NULL, "updatedAt"=$4
                WHERE "id"=$1
            `, member.id, attemptNumber, attemptId, input.now)
            return {
                attemptId,
                launchId,
                campaignId: member.campaignId,
                memberId: member.id,
                memberKey: member.memberKey,
                targetType: member.targetType,
                targetRef: member.targetRef,
                phoneE164: member.phoneE164,
                ...scenario,
                attemptNumber,
                claimRevision: 1,
                claimFence: fence,
                claimUntil,
                workerId,
            }
        })
    },

    async deferClaim(input: { attemptId: string; claimFence: string; retryAt: Date; now: Date }) {
        return database.$transaction(async (tx) => {
            const identities = await tx.$queryRawUnsafe<Array<{ campaignId: string }>>(`
                SELECT "campaignId" FROM "AiCallCampaignAttempt" WHERE "id"=$1
            `, input.attemptId)
            const identity = identities[0]
            if (!identity) throw new AiCallCampaignConflictError('claim_fenced', 'campaign launch claim is stale')
            const campaign = await campaignForUpdate(tx, identity.campaignId)
            if (!campaign) throw new AiCallCampaignConflictError('campaign_not_found', 'campaign not found')
            const rows = await tx.$queryRawUnsafe<AttemptRow[]>(`
                SELECT * FROM "AiCallCampaignAttempt" WHERE "id"=$1 FOR UPDATE
            `, input.attemptId)
            const attempt = rows[0]
            if (!attempt || attempt.state !== 'claimed' || attempt.claimFence !== input.claimFence) {
                throw new AiCallCampaignConflictError('claim_fenced', 'campaign launch claim is stale')
            }
            if (attempt.dispatchState !== 'not_dispatched') {
                // Admission throttling must never demote a provider-accepted or
                // acceptance-unknown launch to the generic waiting lane. Keep
                // its durable Call/effect identity recoverable through running,
                // paused, and cancelling campaign states without authorizing a
                // second dispatch.
                await tx.$executeRawUnsafe(`
                    UPDATE "AiCallCampaignAttempt"
                    SET "state"='running', "claimFence"=NULL, "claimedBy"=NULL,
                        "claimUntil"=$2, "updatedAt"=$3
                    WHERE "id"=$1
                `, attempt.id, input.retryAt, input.now)
                const memberUpdated = await tx.$executeRawUnsafe(`
                    UPDATE "AiCallCampaignMember"
                    SET "state"='running', "nextEligibleAt"=$2, "updatedAt"=$3
                    WHERE "id"=$1 AND "activeAttemptId"=$4
                `, attempt.memberId, input.retryAt, input.now, attempt.id)
                if (memberUpdated !== 1) {
                    throw new AiCallCampaignConflictError('member_fenced', 'campaign member recovery is stale')
                }
                await tx.$executeRawUnsafe(`
                    UPDATE "AiCallAdmissionLease"
                    SET "releasedAt"=$2, "releaseReason"='admission_deferred_recovery', "updatedAt"=$2
                    WHERE "attemptId"=$1 AND "releasedAt" IS NULL
                `, attempt.id, input.now)
                return {
                    status: campaign.state === 'cancelling'
                        ? 'deferred_cancelling_recovery' as const
                        : campaign.state === 'paused'
                            ? 'deferred_paused_recovery' as const
                            : 'deferred_running_recovery' as const,
                }
            }
            if (campaign.state === 'cancelling') {
                await tx.$executeRawUnsafe(`
                    UPDATE "AiCallCampaignAttempt"
                    SET "state"='cancelled', "claimFence"=NULL, "claimedBy"=NULL,
                        "claimUntil"=NULL, "completedAt"=$2, "updatedAt"=$2
                    WHERE "id"=$1
                `, attempt.id, input.now)
                await tx.$executeRawUnsafe(`
                    UPDATE "AiCallCampaignMember"
                    SET "state"='cancelled', "activeAttemptId"=NULL, "nextEligibleAt"=NULL, "updatedAt"=$2
                    WHERE "id"=$1 AND "activeAttemptId"=$3
                `, attempt.memberId, input.now, attempt.id)
                await tx.$executeRawUnsafe(`
                    UPDATE "AiCallAdmissionLease"
                    SET "releasedAt"=$2, "releaseReason"='campaign_cancelled_before_dispatch', "updatedAt"=$2
                    WHERE "attemptId"=$1 AND "releasedAt" IS NULL
                `, attempt.id, input.now)
                await updateCampaignTerminalState(tx, campaign, input.now)
                return { status: 'cancelled_before_dispatch' as const }
            }
            await tx.$executeRawUnsafe(`
                UPDATE "AiCallCampaignAttempt"
                SET "state"='waiting', "claimFence"=NULL, "claimedBy"=NULL, "claimUntil"=NULL, "updatedAt"=$2
                WHERE "id"=$1
            `, attempt.id, input.now)
            await tx.$executeRawUnsafe(`
                UPDATE "AiCallCampaignMember"
                SET "state"='waiting', "nextEligibleAt"=$2, "updatedAt"=$3
                WHERE "id"=$1 AND "activeAttemptId"=$4
            `, attempt.memberId, input.retryAt, input.now, attempt.id)
            return { status: 'deferred' as const }
        })
    },

    async configureGlobalAdmission(input: { concurrentLimit: number; ratePerMinute: number; now?: Date }) {
        const concurrentLimit = Math.max(1, Math.min(10_000, Math.trunc(input.concurrentLimit)))
        const ratePerMinute = Math.max(1, Math.min(60_000, Math.trunc(input.ratePerMinute)))
        const now = input.now ?? new Date()
        await database.$executeRawUnsafe(`
            INSERT INTO "AiCallAdmissionControl" (
                "id", "concurrentLimit", "ratePerMinute", "createdAt", "updatedAt"
            ) VALUES ('global',$1,$2,$3,$3)
            ON CONFLICT ("id") DO UPDATE SET
                "concurrentLimit"=EXCLUDED."concurrentLimit",
                "ratePerMinute"=EXCLUDED."ratePerMinute",
                "updatedAt"=EXCLUDED."updatedAt"
        `, concurrentLimit, ratePerMinute, now)
    },

    async acquireAdmission(input: {
        claim: AiCallCampaignLaunchClaim
        now: Date
        leaseMs: number
    }): Promise<AiCallAdmissionDecision> {
        const leaseMs = Math.max(1, Math.min(300_000, Math.trunc(input.leaseMs)))
        const leaseUntil = new Date(input.now.getTime() + leaseMs)
        return database.$transaction(async (tx) => {
            const controls = await tx.$queryRawUnsafe<Array<{
                concurrentLimit: number
                ratePerMinute: number
                nextAdmitAt: Date | null
            }>>(`
                SELECT "concurrentLimit", "ratePerMinute", "nextAdmitAt"
                FROM "AiCallAdmissionControl" WHERE "id"='global' FOR UPDATE
            `)
            const control = controls[0]
            if (!control) throw new AiCallCampaignConflictError('admission_not_configured', 'global admission is not configured')
            const campaign = await campaignForUpdate(tx, input.claim.campaignId)
            const attempts = await tx.$queryRawUnsafe<AttemptRow[]>(`
                SELECT * FROM "AiCallCampaignAttempt" WHERE "id"=$1 FOR UPDATE
            `, input.claim.attemptId)
            const attempt = attempts[0]
            if (!campaign || !['running', 'paused', 'cancelling'].includes(campaign.state)
                || (campaign.state !== 'running' && attempt?.dispatchState === 'not_dispatched')) {
                return { kind: 'campaign_not_running' as const }
            }
            if (!attempt || attempt.state !== 'claimed' || attempt.claimFence !== input.claim.claimFence) {
                throw new AiCallCampaignConflictError('claim_fenced', 'campaign launch claim is stale')
            }

            await tx.$executeRawUnsafe(`
                UPDATE "AiCallAdmissionLease"
                SET "releasedAt"=$1, "releaseReason"='stale_lease', "updatedAt"=$1
                WHERE "releasedAt" IS NULL AND "leaseUntil" <= $1
            `, input.now)

            const existing = await tx.$queryRawUnsafe<Array<{
                id: string
                leaseFence: string
                leaseUntil: Date
            }>>(`
                SELECT "id", "leaseFence", "leaseUntil"
                FROM "AiCallAdmissionLease"
                WHERE "attemptId"=$1 AND "releasedAt" IS NULL
                FOR UPDATE
            `, attempt.id)
            if (existing[0]) {
                return {
                    kind: 'acquired' as const,
                    grant: {
                        leaseId: existing[0].id,
                        leaseFence: existing[0].leaseFence,
                        leaseUntil: existing[0].leaseUntil,
                        replayed: true,
                    },
                }
            }

            const globalCounts = await tx.$queryRawUnsafe<Array<{ count: number; retryAt: Date | null }>>(`
                SELECT COUNT(*)::int AS "count", MIN("leaseUntil") AS "retryAt"
                FROM "AiCallAdmissionLease" WHERE "releasedAt" IS NULL
            `)
            if ((globalCounts[0]?.count ?? 0) >= control.concurrentLimit) {
                const retryAt = globalCounts[0]?.retryAt ?? leaseUntil
                await appendAudit(tx, campaign.id, {
                    eventId: `aicau_${sha256(`${attempt.id}\0${attempt.claimRevision}\0global-concurrency`)}`,
                    actorId: 'system:ai-call-campaign-runtime',
                    action: 'admission_blocked',
                    details: { attemptId: attempt.id, reason: 'global_concurrency', retryAt: retryAt.toISOString() },
                }, input.now)
                return {
                    kind: 'blocked' as const,
                    reason: 'global_concurrency' as const,
                    retryAt,
                }
            }
            const campaignCounts = await tx.$queryRawUnsafe<Array<{ count: number; retryAt: Date | null }>>(`
                SELECT COUNT(*)::int AS "count", MIN("leaseUntil") AS "retryAt"
                FROM "AiCallAdmissionLease" WHERE "releasedAt" IS NULL AND "campaignId"=$1
            `, campaign.id)
            if ((campaignCounts[0]?.count ?? 0) >= campaign.concurrentLimit) {
                const retryAt = campaignCounts[0]?.retryAt ?? leaseUntil
                await appendAudit(tx, campaign.id, {
                    eventId: `aicau_${sha256(`${attempt.id}\0${attempt.claimRevision}\0campaign-concurrency`)}`,
                    actorId: 'system:ai-call-campaign-runtime',
                    action: 'admission_blocked',
                    details: { attemptId: attempt.id, reason: 'campaign_concurrency', retryAt: retryAt.toISOString() },
                }, input.now)
                return {
                    kind: 'blocked' as const,
                    reason: 'campaign_concurrency' as const,
                    retryAt,
                }
            }

            const rateReady = [control.nextAdmitAt, campaign.nextAdmitAt]
                .filter((value): value is Date => value instanceof Date)
                .reduce((maximum, value) => value.getTime() > maximum.getTime() ? value : maximum, input.now)
            if (rateReady.getTime() > input.now.getTime()) {
                await appendAudit(tx, campaign.id, {
                    eventId: `aicau_${sha256(`${attempt.id}\0${attempt.claimRevision}\0rate`)}`,
                    actorId: 'system:ai-call-campaign-runtime',
                    action: 'admission_blocked',
                    details: { attemptId: attempt.id, reason: 'rate', retryAt: rateReady.toISOString() },
                }, input.now)
                return { kind: 'blocked' as const, reason: 'rate' as const, retryAt: rateReady }
            }

            const leaseId = leaseIdentity(attempt.id)
            const leaseFence = sha256(`${leaseId}\0${input.claim.workerId}\0${input.now.toISOString()}\0${leaseUntil.toISOString()}`)
            await tx.$executeRawUnsafe(`
                INSERT INTO "AiCallAdmissionLease" (
                    "id", "attemptId", "campaignId", "memberId", "workerId", "leaseFence",
                    "acquiredAt", "leaseUntil", "releasedAt", "releaseReason", "createdAt", "updatedAt"
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,$7,$7)
                ON CONFLICT ("attemptId") DO UPDATE SET
                    "workerId"=EXCLUDED."workerId", "leaseFence"=EXCLUDED."leaseFence",
                    "acquiredAt"=EXCLUDED."acquiredAt", "leaseUntil"=EXCLUDED."leaseUntil",
                    "releasedAt"=NULL, "releaseReason"=NULL, "updatedAt"=EXCLUDED."updatedAt"
            `,
            leaseId,
            attempt.id,
            campaign.id,
            attempt.memberId,
            input.claim.workerId,
            leaseFence,
            input.now,
            leaseUntil)
            await tx.$executeRawUnsafe(`
                UPDATE "AiCallCampaignAttempt" SET "admissionLeaseId"=$2, "updatedAt"=$3 WHERE "id"=$1
            `, attempt.id, leaseId, input.now)
            const globalNext = new Date(input.now.getTime() + aiCallCampaignRateIntervalMs(control.ratePerMinute))
            const campaignNext = new Date(input.now.getTime() + aiCallCampaignRateIntervalMs(campaign.ratePerMinute))
            await tx.$executeRawUnsafe(`
                UPDATE "AiCallAdmissionControl" SET "nextAdmitAt"=$1, "updatedAt"=$2 WHERE "id"='global'
            `, globalNext, input.now)
            await tx.$executeRawUnsafe(`
                UPDATE "AiCallCampaign" SET "nextAdmitAt"=$2, "updatedAt"=$3 WHERE "id"=$1
            `, campaign.id, campaignNext, input.now)
            return {
                kind: 'acquired' as const,
                grant: { leaseId, leaseFence, leaseUntil, replayed: false },
            }
        })
    },

    async markAttemptRunning(input: {
        attemptId: string
        claimFence: string
        leaseFence: string
        now: Date
    }) {
        return database.$transaction(async (tx) => {
            const identities = await tx.$queryRawUnsafe<Array<{ campaignId: string }>>(`
                SELECT "campaignId" FROM "AiCallCampaignAttempt" WHERE "id"=$1
            `, input.attemptId)
            const identity = identities[0]
            if (!identity) throw new AiCallCampaignConflictError('claim_fenced', 'campaign dial execution is stale')
            const campaign = await campaignForUpdate(tx, identity.campaignId)
            if (!campaign) throw new AiCallCampaignConflictError('campaign_not_found', 'campaign not found')
            const attempts = await tx.$queryRawUnsafe<AttemptRow[]>(`
                SELECT * FROM "AiCallCampaignAttempt" WHERE "id"=$1 FOR UPDATE
            `, input.attemptId)
            const attempt = attempts[0]
            if (!attempt || attempt.state !== 'claimed' || attempt.claimFence !== input.claimFence) {
                throw new AiCallCampaignConflictError('claim_fenced', 'campaign launch claim is stale')
            }
            const leases = await tx.$queryRawUnsafe<Array<{ id: string }>>(`
                SELECT "id" FROM "AiCallAdmissionLease"
                WHERE "attemptId"=$1 AND "leaseFence"=$2 AND "releasedAt" IS NULL AND "leaseUntil">$3
                FOR UPDATE
            `, attempt.id, input.leaseFence, input.now)
            if (!leases[0]) throw new AiCallCampaignConflictError('admission_fenced', 'admission lease is stale')
            await tx.$executeRawUnsafe(`
                UPDATE "AiCallCampaignAttempt"
                SET "state"='running', "startedAt"=COALESCE("startedAt",$2), "updatedAt"=$2
                WHERE "id"=$1
            `, attempt.id, input.now)
            const memberUpdated = await tx.$executeRawUnsafe(`
                UPDATE "AiCallCampaignMember"
                SET "state"='running', "updatedAt"=$2
                WHERE "id"=$1 AND "activeAttemptId"=$3 AND "state"='claimed'
            `, attempt.memberId, input.now, attempt.id)
            if (memberUpdated !== 1) {
                throw new AiCallCampaignConflictError('member_fenced', 'campaign member claim is stale')
            }
            return { status: 'running' as const }
        })
    },

    async beginDialExecution(input: {
        attemptId: string
        claimFence: string
        leaseFence: string
        now: Date
    }) {
        return database.$transaction(async (tx) => {
            const identities = await tx.$queryRawUnsafe<Array<{ campaignId: string }>>(`
                SELECT "campaignId" FROM "AiCallCampaignAttempt" WHERE "id"=$1
            `, input.attemptId)
            const identity = identities[0]
            if (!identity) throw new AiCallCampaignConflictError('claim_fenced', 'campaign dial execution is stale')
            const campaign = await campaignForUpdate(tx, identity.campaignId)
            if (!campaign) throw new AiCallCampaignConflictError('campaign_not_found', 'campaign not found')
            const attempts = await tx.$queryRawUnsafe<AttemptRow[]>(`
                SELECT * FROM "AiCallCampaignAttempt" WHERE "id"=$1 FOR UPDATE
            `, input.attemptId)
            const attempt = attempts[0]
            if (!attempt || attempt.state !== 'running' || attempt.claimFence !== input.claimFence) {
                throw new AiCallCampaignConflictError('claim_fenced', 'campaign dial execution is stale')
            }
            const leases = await tx.$queryRawUnsafe<Array<{ id: string }>>(`
                SELECT "id" FROM "AiCallAdmissionLease"
                WHERE "attemptId"=$1 AND "leaseFence"=$2 AND "releasedAt" IS NULL AND "leaseUntil">$3
                FOR UPDATE
            `, attempt.id, input.leaseFence, input.now)
            if (!leases[0]) throw new AiCallCampaignConflictError('admission_fenced', 'admission lease is stale')
            if (attempt.dispatchState === 'not_dispatched' && campaign.state === 'cancelling') {
                await tx.$executeRawUnsafe(`
                    UPDATE "AiCallCampaignAttempt"
                    SET "state"='cancelled', "claimFence"=NULL, "claimedBy"=NULL,
                        "claimUntil"=NULL, "completedAt"=$2, "updatedAt"=$2
                    WHERE "id"=$1
                `, attempt.id, input.now)
                await tx.$executeRawUnsafe(`
                    UPDATE "AiCallCampaignMember"
                    SET "state"='cancelled', "activeAttemptId"=NULL, "nextEligibleAt"=NULL, "updatedAt"=$2
                    WHERE "id"=$1 AND "activeAttemptId"=$3
                `, attempt.memberId, input.now, attempt.id)
                await tx.$executeRawUnsafe(`
                    UPDATE "AiCallAdmissionLease"
                    SET "releasedAt"=$2, "releaseReason"='campaign_cancelled_before_dispatch', "updatedAt"=$2
                    WHERE "attemptId"=$1 AND "releasedAt" IS NULL
                `, attempt.id, input.now)
                const campaignState = await updateCampaignTerminalState(tx, campaign, input.now)
                return { kind: 'cancelled_before_dispatch' as const, campaignState }
            }
            if (attempt.dispatchState === 'not_dispatched' && campaign.state !== 'running') {
                const retryAt = new Date(input.now.getTime() + 250)
                await tx.$executeRawUnsafe(`
                    UPDATE "AiCallCampaignAttempt"
                    SET "state"='waiting', "claimFence"=NULL, "claimedBy"=NULL,
                        "claimUntil"=NULL, "updatedAt"=$2
                    WHERE "id"=$1
                `, attempt.id, input.now)
                await tx.$executeRawUnsafe(`
                    UPDATE "AiCallCampaignMember"
                    SET "state"='waiting', "nextEligibleAt"=$2, "updatedAt"=$3
                    WHERE "id"=$1 AND "activeAttemptId"=$4
                `, attempt.memberId, retryAt, input.now, attempt.id)
                await tx.$executeRawUnsafe(`
                    UPDATE "AiCallAdmissionLease"
                    SET "releasedAt"=$2, "releaseReason"='campaign_not_running_before_dispatch', "updatedAt"=$2
                    WHERE "attemptId"=$1 AND "releasedAt" IS NULL
                `, attempt.id, input.now)
                return { kind: 'deferred_before_dispatch' as const, retryAt }
            }
            const executionKind = attempt.dispatchState === 'not_dispatched'
                ? 'initial_dispatch_authorized' as const
                : 'reconcile_only' as const
            const updated = await tx.$queryRawUnsafe<Array<{ dialExecutionCount: number }>>(`
                UPDATE "AiCallCampaignAttempt"
                SET "dialExecutionCount"="dialExecutionCount"+1,
                    "dispatchState"=CASE WHEN "dispatchState"='not_dispatched'
                      THEN 'acceptance_unknown' ELSE "dispatchState" END,
                    "dispatchAuthorizedAt"=COALESCE("dispatchAuthorizedAt",$2),
                    "updatedAt"=$2
                WHERE "id"=$1
                RETURNING "dialExecutionCount"
            `, attempt.id, input.now)
            await appendAudit(tx, attempt.campaignId, {
                eventId: `aicau_${sha256(`${attempt.id}\0${executionKind}\0${updated[0].dialExecutionCount}`)}`,
                actorId: 'system:ai-call-campaign-runtime',
                action: executionKind === 'initial_dispatch_authorized'
                    ? 'dispatch_authorized'
                    : 'dispatch_reconcile_started',
                details: {
                    attemptId: attempt.id,
                    launchId: attempt.launchId,
                    dialExecutionCount: updated[0].dialExecutionCount,
                },
            }, input.now)
            return {
                kind: executionKind,
                dialExecutionCount: updated[0].dialExecutionCount,
                callId: attempt.callId,
            }
        })
    },

    async deferLinkedCallReconciliation(input: {
        attemptId: string
        claimFence: string
        leaseFence: string
        retryAt: Date
        reason: 'adapter_error' | 'missing_reconciliation_result'
        now: Date
    }) {
        return database.$transaction(async (tx) => {
            const identities = await tx.$queryRawUnsafe<Array<{ campaignId: string }>>(`
                SELECT "campaignId" FROM "AiCallCampaignAttempt" WHERE "id"=$1
            `, input.attemptId)
            const identity = identities[0]
            if (!identity) throw new AiCallCampaignConflictError('claim_fenced', 'campaign reconciliation is stale')
            const campaign = await campaignForUpdate(tx, identity.campaignId)
            if (!campaign) throw new AiCallCampaignConflictError('campaign_not_found', 'campaign not found')
            const attempts = await tx.$queryRawUnsafe<AttemptRow[]>(`
                SELECT * FROM "AiCallCampaignAttempt" WHERE "id"=$1 FOR UPDATE
            `, input.attemptId)
            const attempt = attempts[0]
            if (!attempt || attempt.state !== 'running' || attempt.claimFence !== input.claimFence) {
                throw new AiCallCampaignConflictError('claim_fenced', 'campaign reconciliation is stale')
            }
            if (attempt.dispatchState === 'not_dispatched' || !attempt.callId) {
                throw new AiCallCampaignConflictError(
                    'reconciliation_not_linked',
                    'campaign reconciliation deferral requires a durable linked Call',
                )
            }
            const leases = await tx.$queryRawUnsafe<Array<{ id: string }>>(`
                SELECT "id" FROM "AiCallAdmissionLease"
                WHERE "attemptId"=$1 AND "leaseFence"=$2 AND "releasedAt" IS NULL
                FOR UPDATE
            `, attempt.id, input.leaseFence)
            if (!leases[0]) throw new AiCallCampaignConflictError('admission_fenced', 'admission lease is stale')
            await tx.$executeRawUnsafe(`
                UPDATE "AiCallCampaignAttempt"
                SET "state"='running', "failureCode"='dial_reconciliation_error',
                    "claimFence"=NULL, "claimedBy"=NULL, "claimUntil"=$2, "updatedAt"=$3
                WHERE "id"=$1
            `, attempt.id, input.retryAt, input.now)
            const memberUpdated = await tx.$executeRawUnsafe(`
                UPDATE "AiCallCampaignMember"
                SET "state"='running', "failureCode"='dial_reconciliation_error',
                    "nextEligibleAt"=$2, "updatedAt"=$3
                WHERE "id"=$1 AND "activeAttemptId"=$4
            `, attempt.memberId, input.retryAt, input.now, attempt.id)
            if (memberUpdated !== 1) {
                throw new AiCallCampaignConflictError('member_fenced', 'campaign member reconciliation is stale')
            }
            const leaseReleased = await tx.$executeRawUnsafe(`
                UPDATE "AiCallAdmissionLease"
                SET "releasedAt"=$3, "releaseReason"='dial_reconciliation_deferred', "updatedAt"=$3
                WHERE "attemptId"=$1 AND "leaseFence"=$2 AND "releasedAt" IS NULL
            `, attempt.id, input.leaseFence, input.now)
            if (leaseReleased !== 1) {
                throw new AiCallCampaignConflictError('admission_fenced', 'admission lease is stale')
            }
            await appendAudit(tx, campaign.id, {
                eventId: `aicau_${sha256(`${attempt.id}\0dispatch_reconcile_deferred\0${attempt.dialExecutionCount}`)}`,
                actorId: 'system:ai-call-campaign-runtime',
                action: 'retry_scheduled',
                details: {
                    attemptId: attempt.id,
                    launchId: attempt.launchId,
                    callId: attempt.callId,
                    dialExecutionCount: attempt.dialExecutionCount,
                    reason: input.reason,
                    retryAt: input.retryAt.toISOString(),
                },
            }, input.now)
            return { status: 'deferred' as const, retryAt: input.retryAt, callId: attempt.callId }
        })
    },

    async renewExecution(input: {
        attemptId: string
        claimFence: string
        leaseFence: string
        now: Date
        claimLeaseMs: number
        admissionLeaseMs: number
    }) {
        const claimUntil = new Date(input.now.getTime()
            + Math.max(1, Math.min(300_000, Math.trunc(input.claimLeaseMs))))
        const leaseUntil = new Date(input.now.getTime()
            + Math.max(1, Math.min(300_000, Math.trunc(input.admissionLeaseMs))))
        return database.$transaction(async (tx) => {
            const attempts = await tx.$queryRawUnsafe<AttemptRow[]>(`
                SELECT * FROM "AiCallCampaignAttempt" WHERE "id"=$1 FOR UPDATE
            `, input.attemptId)
            const attempt = attempts[0]
            if (!attempt || attempt.state !== 'running' || attempt.claimFence !== input.claimFence) {
                throw new AiCallCampaignConflictError('claim_fenced', 'campaign launch claim is stale')
            }
            const renewedLease = await tx.$executeRawUnsafe(`
                UPDATE "AiCallAdmissionLease"
                SET "leaseUntil"=GREATEST("leaseUntil",$3), "updatedAt"=$4
                WHERE "attemptId"=$1 AND "leaseFence"=$2 AND "releasedAt" IS NULL
            `, attempt.id, input.leaseFence, leaseUntil, input.now)
            if (renewedLease !== 1) {
                throw new AiCallCampaignConflictError('admission_fenced', 'admission lease is stale')
            }
            await tx.$executeRawUnsafe(`
                UPDATE "AiCallCampaignAttempt"
                SET "claimUntil"=GREATEST("claimUntil",$2), "updatedAt"=$3
                WHERE "id"=$1
            `, attempt.id, claimUntil, input.now)
            return { status: 'renewed' as const, claimUntil, leaseUntil }
        })
    },

    async recordAttemptResult(input: AiCallCampaignAttemptResultInput) {
        const resultEventId = bounded(input.resultEventId, 'resultEventId')
        const outcomeCode = input.outcomeCode == null ? null : bounded(input.outcomeCode, 'outcomeCode', 128)
        const failureCode = input.failureCode == null ? null : bounded(input.failureCode, 'failureCode', 128)
        const callId = input.callId == null ? null : bounded(input.callId, 'callId')
        const resultFingerprint = aiCallCampaignSha256({
            resultEventId,
            kind: input.kind,
            outcomeCode,
            failureCode,
            callId,
            providerAccepted: input.providerAccepted !== false,
        } as AiCallCampaignJson)
        return database.$transaction(async (tx) => {
            const identities = await tx.$queryRawUnsafe<Array<{ campaignId: string }>>(`
                SELECT "campaignId" FROM "AiCallCampaignAttempt" WHERE "id"=$1
            `, input.attemptId)
            const identity = identities[0]
            if (!identity) throw new AiCallCampaignConflictError('attempt_not_found', 'attempt not found')
            const campaign = await campaignForUpdate(tx, identity.campaignId)
            if (!campaign) throw new AiCallCampaignConflictError('campaign_not_found', 'campaign not found')
            const attempts = await tx.$queryRawUnsafe<AttemptRow[]>(`
                SELECT * FROM "AiCallCampaignAttempt" WHERE "id"=$1 FOR UPDATE
            `, input.attemptId)
            const attempt = attempts[0]
            if (!attempt) throw new AiCallCampaignConflictError('attempt_not_found', 'attempt not found')
            if (attempt.resultEventId) {
                if (attempt.resultEventId === resultEventId && attempt.resultFingerprint === resultFingerprint) {
                    return { status: 'duplicate' as const, memberState: null, campaignState: null }
                }
                throw new AiCallCampaignConflictError('attempt_terminal_conflict', 'attempt already has another terminal result')
            }
            let dialEffectRef = attempt.dialEffectRef
            if (attempt.state === 'claimed' || attempt.state === 'running') {
                if (attempt.claimFence !== input.claimFence) {
                    throw new AiCallCampaignConflictError('claim_fenced', 'campaign launch claim is stale')
                }
                dialEffectRef = bounded(input.dialEffectRef, 'dialEffectRef')
                const leaseFence = bounded(input.leaseFence, 'leaseFence')
                const leases = await tx.$queryRawUnsafe<Array<{ id: string }>>(`
                    SELECT "id" FROM "AiCallAdmissionLease"
                    WHERE "attemptId"=$1 AND "leaseFence"=$2 AND "releasedAt" IS NULL
                    FOR UPDATE
                `, attempt.id, leaseFence)
                if (!leases[0]) throw new AiCallCampaignConflictError('admission_fenced', 'admission lease is stale')
            } else {
                throw new AiCallCampaignConflictError('attempt_not_running', 'attempt is not running')
            }
            const attemptState = input.kind === 'success'
                ? 'succeeded'
                : input.kind === 'retryable_failure' ? 'retryable_failure' : 'permanent_failure'
            await tx.$executeRawUnsafe(`
                UPDATE "AiCallCampaignAttempt"
                SET "state"=$2, "resultEventId"=$3, "resultFingerprint"=$4, "failureCode"=$5,
                    "dialEffectRef"=COALESCE("dialEffectRef",$7), "startedAt"=COALESCE("startedAt",$6),
                    "callId"=COALESCE("callId",$8), "completedAt"=$6,
                    "dispatchState"=CASE WHEN $9 THEN 'accepted' ELSE "dispatchState" END,
                    "dispatchAuthorizedAt"=CASE WHEN $9 THEN COALESCE("dispatchAuthorizedAt",$6) ELSE "dispatchAuthorizedAt" END,
                    "dispatchAcceptedAt"=CASE WHEN $9 THEN COALESCE("dispatchAcceptedAt",$6) ELSE "dispatchAcceptedAt" END,
                    "dispatchReceiptRef"=CASE WHEN $9 THEN COALESCE("dispatchReceiptRef",$7) ELSE "dispatchReceiptRef" END,
                    "claimFence"=NULL, "claimedBy"=NULL, "claimUntil"=NULL, "updatedAt"=$6
                WHERE "id"=$1
            `, attempt.id, attemptState, resultEventId, resultFingerprint, failureCode, input.now, dialEffectRef, callId,
            input.providerAccepted !== false)
            await tx.$executeRawUnsafe(`
                UPDATE "AiCallAdmissionLease"
                SET "releasedAt"=$2, "releaseReason"=$3, "updatedAt"=$2
                WHERE "attemptId"=$1 AND "releasedAt" IS NULL
            `, attempt.id, input.now, attemptState)

            let memberState: string
            let nextEligibleAt: Date | null = null
            if (campaign.state === 'cancelling') memberState = 'cancelled'
            else if (input.kind === 'success') memberState = 'succeeded'
            else if (input.kind === 'retryable_failure' && attempt.attemptNumber < campaign.maxAttempts) {
                memberState = 'retry_wait'
                nextEligibleAt = new Date(input.now.getTime() + aiCallCampaignBackoffMs({
                    attemptNumber: attempt.attemptNumber,
                    retryBaseMs: campaign.retryBaseMs,
                    retryMaxMs: campaign.retryMaxMs,
                }))
            } else memberState = 'failed'

            const terminal = ['succeeded', 'failed', 'cancelled'].includes(memberState)
            await tx.$executeRawUnsafe(`
                UPDATE "AiCallCampaignMember"
                SET "state"=$2,
                    "nextEligibleAt"=$3,
                    "activeAttemptId"=NULL,
                    "terminalEventId"=CASE WHEN $4 THEN $5 ELSE NULL END,
                    "terminalPayloadFingerprint"=CASE WHEN $4 THEN $6 ELSE NULL END,
                    "outcomeCode"=CASE WHEN $4 THEN $7 ELSE NULL END,
                    "failureCode"=CASE WHEN $4 THEN $8 ELSE NULL END,
                    "updatedAt"=$9
                WHERE "id"=$1 AND "activeAttemptId"=$10
            `,
            attempt.memberId,
            memberState,
            nextEligibleAt,
            terminal,
            resultEventId,
            resultFingerprint,
            outcomeCode,
            failureCode,
            input.now,
            attempt.id)
            await appendAudit(tx, campaign.id, {
                eventId: `aicau_${sha256(`${attempt.id}\0${resultEventId}\0operational-result`)}`,
                actorId: 'system:ai-call-campaign-runtime',
                action: memberState === 'retry_wait'
                    ? 'retry_scheduled'
                    : memberState === 'succeeded' ? 'attempt_succeeded' : 'attempt_failed',
                details: {
                    attemptId: attempt.id,
                    attemptNumber: attempt.attemptNumber,
                    resultEventId,
                    memberState,
                    nextEligibleAt: nextEligibleAt?.toISOString() ?? null,
                    failureCode,
                    providerAccepted: input.providerAccepted !== false,
                },
            }, input.now)
            const campaignState = await updateCampaignTerminalState(tx, campaign, input.now)
            return { status: 'applied' as const, memberState, campaignState, nextEligibleAt }
        })
    },

    async getCampaign(campaignIdInput: string) {
        const campaignId = bounded(campaignIdInput, 'campaignId')
        const campaigns = await database.$queryRawUnsafe<CampaignRow[]>(`
            SELECT "id", "identityKey", "payloadFingerprint", "name", "scenarioRef", "state",
                   "audienceSourceKind", "audienceSourceRef", "audienceSourceVersion", "audienceFingerprint",
                   "audienceFrozenAt", "scheduledAt", "startedAt", "completedAt", "cancelledAt",
                   "concurrentLimit", "ratePerMinute", "maxAttempts", "retryBaseMs", "retryMaxMs",
                   "nextAdmitAt", "failureCode", "createdAt", "updatedAt"
            FROM "AiCallCampaign"
            WHERE "id"=$1
        `, campaignId)
        const campaign = campaigns[0]
        if (!campaign) return null
        const members = await database.$queryRawUnsafe<MemberRow[]>(`
            SELECT * FROM "AiCallCampaignMember" WHERE "campaignId"=$1 ORDER BY "memberKey" ASC
        `, campaignId)
        const attempts = await database.$queryRawUnsafe<AttemptRow[]>(`
            SELECT * FROM "AiCallCampaignAttempt" WHERE "campaignId"=$1 ORDER BY "createdAt" ASC, "id" ASC
        `, campaignId)
        const progress: Record<string, number> = { total: members.length }
        for (const member of members) progress[member.state] = (progress[member.state] ?? 0) + 1
        return { campaign, members, attempts, progress }
    },
}
