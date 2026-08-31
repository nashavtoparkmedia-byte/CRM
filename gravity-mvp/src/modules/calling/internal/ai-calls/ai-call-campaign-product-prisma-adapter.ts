import { Prisma } from '@prisma/client'
import type {
    AiCallCampaignAuditEventV1,
    AiCallCampaignCallV1,
    AiCallCampaignDetailV1,
    AiCallCampaignMemberV1,
    AiCallCampaignProgressV1,
    AiCallCampaignSummaryV1,
} from '@/contracts/calling/v1'
import { prisma } from '@/lib/prisma'
import { readAiCallFinalizationJournal } from '../../application/ai-call-finalization'
import { readAiCallCampaignRuntimeMode } from '../../application/ai-call-campaign-runtime-mode'

interface RawSqlDatabase {
    $queryRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Promise<T>
    $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
}

const database = prisma as unknown as RawSqlDatabase

interface CampaignProjectionRow {
    id: string
    name: string
    scenarioRef: string
    state: string
    audienceSourceKind: string | null
    audienceSourceRef: string | null
    audienceSourceVersion: string | null
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
    failureCode: string | null
    createdAt: Date
    updatedAt: Date
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
    completedCalls: number
    connectedDurationSec: number
}

interface MemberRow {
    id: string
    targetRef: string
    phoneE164: string
    provenance: unknown
    state: string
    excludedReason: string | null
    attemptCount: number
    nextEligibleAt: Date | null
    outcomeCode: string | null
    failureCode: string | null
    updatedAt: Date
}

interface AttemptCallRow {
    id: string
    memberId: string
    attemptNumber: number
    launchId: string
    state: string
    claimRevision: number
    dialEffectRef: string | null
    failureCode: string | null
    startedAt: Date | null
    completedAt: Date | null
    callId: string | null
    callStatus: string | null
    aiSessionStatus: string | null
    callStartedAt: Date | null
    answeredAt: Date | null
    endedAt: Date | null
    durationSec: number | null
    transcript: string | null
    aiSummary: string | null
    aiOutcome: string | null
    aiOutcomeReason: string | null
    qualificationScore: number | null
    metadata: unknown
}

interface AuditRow {
    id: string
    actorId: string
    action: string
    details: unknown
    createdAt: Date
}

const CAMPAIGN_SELECT = Prisma.sql`
    SELECT c."id", c."name", c."scenarioRef", c."state",
           c."audienceSourceKind", c."audienceSourceRef", c."audienceSourceVersion",
           c."audienceFrozenAt", c."scheduledAt", c."startedAt", c."completedAt", c."cancelledAt",
           c."concurrentLimit", c."ratePerMinute", c."maxAttempts", c."retryBaseMs", c."retryMaxMs",
           c."failureCode", c."createdAt", c."updatedAt",
           COALESCE(p."total",0)::int AS "total",
           COALESCE(p."pending",0)::int AS "pending",
           COALESCE(p."waiting",0)::int AS "waiting",
           COALESCE(p."claimed",0)::int AS "claimed",
           COALESCE(p."running",0)::int AS "running",
           COALESCE(p."retryWait",0)::int AS "retryWait",
           COALESCE(p."succeeded",0)::int AS "succeeded",
           COALESCE(p."failed",0)::int AS "failed",
           COALESCE(p."excluded",0)::int AS "excluded",
           COALESCE(p."cancelled",0)::int AS "cancelled",
           COALESCE(cost."completedCalls",0)::int AS "completedCalls",
           COALESCE(cost."connectedDurationSec",0)::int AS "connectedDurationSec"
    FROM "AiCallCampaign" c
    LEFT JOIN LATERAL (
        SELECT COUNT(*) AS "total",
               COUNT(*) FILTER (WHERE m."state"='pending') AS "pending",
               COUNT(*) FILTER (WHERE m."state"='waiting') AS "waiting",
               COUNT(*) FILTER (WHERE m."state"='claimed') AS "claimed",
               COUNT(*) FILTER (WHERE m."state"='running') AS "running",
               COUNT(*) FILTER (WHERE m."state"='retry_wait') AS "retryWait",
               COUNT(*) FILTER (WHERE m."state"='succeeded') AS "succeeded",
               COUNT(*) FILTER (WHERE m."state"='failed') AS "failed",
               COUNT(*) FILTER (WHERE m."state"='excluded') AS "excluded",
               COUNT(*) FILTER (WHERE m."state"='cancelled') AS "cancelled"
        FROM "AiCallCampaignMember" m WHERE m."campaignId"=c."id"
    ) p ON TRUE
    LEFT JOIN LATERAL (
        SELECT COUNT(phone_call."id") FILTER (WHERE phone_call."endedAt" IS NOT NULL) AS "completedCalls",
               COALESCE(SUM(
                 GREATEST(0, EXTRACT(EPOCH FROM (phone_call."endedAt"-phone_call."answeredAt")))::int
               ) FILTER (WHERE phone_call."answeredAt" IS NOT NULL AND phone_call."endedAt" IS NOT NULL),0)::int
                 AS "connectedDurationSec"
        FROM "AiCallCampaignAttempt" a
        LEFT JOIN "Call" phone_call ON phone_call."id"=a."callId"
        WHERE a."campaignId"=c."id"
    ) cost ON TRUE
`

function iso(value: Date | null): string | null {
    return value ? value.toISOString() : null
}

function progress(row: CampaignProjectionRow): AiCallCampaignProgressV1 {
    const completed = row.succeeded + row.failed + row.excluded + row.cancelled
    return {
        total: row.total,
        pending: row.pending,
        waiting: row.waiting,
        claimed: row.claimed,
        running: row.running,
        retryWait: row.retryWait,
        succeeded: row.succeeded,
        failed: row.failed,
        excluded: row.excluded,
        cancelled: row.cancelled,
        completed,
        percent: row.total === 0 ? 0 : Math.round((completed / row.total) * 10_000) / 100,
    }
}

function summary(row: CampaignProjectionRow): AiCallCampaignSummaryV1 {
    return {
        id: row.id,
        name: row.name,
        scenarioId: row.scenarioRef,
        state: row.state,
        scheduledAt: iso(row.scheduledAt),
        startedAt: iso(row.startedAt),
        completedAt: iso(row.completedAt),
        cancelledAt: iso(row.cancelledAt),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        concurrentLimit: row.concurrentLimit,
        ratePerMinute: row.ratePerMinute,
        maxAttempts: row.maxAttempts,
        retryBaseMs: row.retryBaseMs,
        retryMaxMs: row.retryMaxMs,
        failureCode: row.failureCode,
        progress: progress(row),
        cost: {
            status: 'provider_billing_not_ingested',
            currency: null,
            amount: null,
            completedCalls: row.completedCalls,
            connectedDurationSec: row.connectedDurationSec,
            basis: 'crm_answered_interval_only',
        },
    }
}

function labelFromProvenance(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const label = (value as Record<string, unknown>).label
    return typeof label === 'string' && label.length <= 255 ? label : null
}

function callProjection(row: AttemptCallRow): AiCallCampaignCallV1 | null {
    if (!row.callId || !row.callStartedAt || !row.callStatus) return null
    const journal = readAiCallFinalizationJournal(row.metadata)
    return {
        id: row.callId,
        status: row.callStatus,
        sessionStatus: row.aiSessionStatus,
        startedAt: row.callStartedAt.toISOString(),
        answeredAt: iso(row.answeredAt),
        endedAt: iso(row.endedAt),
        durationSec: row.durationSec,
        transcript: row.transcript,
        summary: row.aiSummary,
        outcome: row.aiOutcome,
        outcomeReason: row.aiOutcomeReason,
        qualificationScore: row.qualificationScore,
        followUpState: journal?.followUp.state ?? null,
    }
}

export const aiCallCampaignProductPrismaPort = {
    async list(input: { state?: string; cursor?: string; limit: number }): Promise<{
        campaigns: AiCallCampaignSummaryV1[]
        nextCursor: string | null
    }> {
        const state: string | null = input.state ?? null
        const cursor: string | null = input.cursor ?? null
        const limit: number = input.limit + 1
        const rows = await database.$queryRaw<CampaignProjectionRow[]>`${CAMPAIGN_SELECT}
            WHERE (${state}::text IS NULL OR c."state"=${state})
              AND (${cursor}::text IS NULL OR c."id" < ${cursor})
            ORDER BY c."id" DESC
            LIMIT ${limit}
        `
        const hasMore = rows.length > input.limit
        const visible = hasMore ? rows.slice(0, input.limit) : rows
        return {
            campaigns: visible.map(summary),
            nextCursor: hasMore ? visible.at(-1)?.id ?? null : null,
        }
    },

    async detail(input: { campaignId: string; memberCursor?: string; memberLimit: number }): Promise<AiCallCampaignDetailV1 | null> {
        const campaigns = await database.$queryRaw<CampaignProjectionRow[]>`${CAMPAIGN_SELECT}
            WHERE c."id"=${input.campaignId}
        `
        const campaign = campaigns[0]
        if (!campaign) return null
        const memberRows = await database.$queryRawUnsafe<MemberRow[]>(`
            SELECT "id", "targetRef", "phoneE164", "provenance", "state", "excludedReason",
                   "attemptCount", "nextEligibleAt", "outcomeCode", "failureCode", "updatedAt"
            FROM "AiCallCampaignMember"
            WHERE "campaignId"=$1 AND ($2::text IS NULL OR "id">$2)
            ORDER BY "id" ASC LIMIT $3
        `, input.campaignId, input.memberCursor ?? null, input.memberLimit + 1)
        const hasMore = memberRows.length > input.memberLimit
        const visibleRows = hasMore ? memberRows.slice(0, input.memberLimit) : memberRows
        const memberIds = visibleRows.map((row) => row.id)
        const attempts = memberIds.length === 0 ? [] : await database.$queryRawUnsafe<AttemptCallRow[]>(`
            SELECT a."id", a."memberId", a."attemptNumber", a."launchId", a."state", a."claimRevision",
                   a."dialEffectRef", a."failureCode", a."startedAt", a."completedAt", a."callId",
                   phone_call."status"::text AS "callStatus", phone_call."aiSessionStatus"::text AS "aiSessionStatus",
                   phone_call."startedAt" AS "callStartedAt", phone_call."answeredAt", phone_call."endedAt", phone_call."durationSec",
                   phone_call."transcript", phone_call."aiSummary", phone_call."aiOutcome"::text AS "aiOutcome",
                   phone_call."aiOutcomeReason", phone_call."qualificationScore", phone_call."metadata"
            FROM "AiCallCampaignAttempt" a
            LEFT JOIN "Call" phone_call ON phone_call."id"=a."callId"
            WHERE a."memberId"=ANY($1::text[])
            ORDER BY a."memberId" ASC, a."attemptNumber" ASC
        `, memberIds)
        const attemptsByMember = new Map<string, AttemptCallRow[]>()
        for (const attempt of attempts) {
            const collection = attemptsByMember.get(attempt.memberId) ?? []
            collection.push(attempt)
            attemptsByMember.set(attempt.memberId, collection)
        }
        const members: AiCallCampaignMemberV1[] = visibleRows.map((member) => ({
            id: member.id,
            targetRef: member.targetRef,
            phoneE164: member.phoneE164,
            label: labelFromProvenance(member.provenance),
            state: member.state,
            excludedReason: member.excludedReason,
            attemptCount: member.attemptCount,
            nextEligibleAt: iso(member.nextEligibleAt),
            outcomeCode: member.outcomeCode,
            failureCode: member.failureCode,
            updatedAt: member.updatedAt.toISOString(),
            attempts: (attemptsByMember.get(member.id) ?? []).map((attempt) => ({
                id: attempt.id,
                attemptNumber: attempt.attemptNumber,
                launchId: attempt.launchId,
                state: attempt.state,
                claimRevision: attempt.claimRevision,
                providerEffectRef: attempt.dialEffectRef,
                failureCode: attempt.failureCode,
                startedAt: iso(attempt.startedAt),
                completedAt: iso(attempt.completedAt),
                call: callProjection(attempt),
            })),
        }))
        const auditRows = await database.$queryRawUnsafe<AuditRow[]>(`
            SELECT "id", "actorId", "action", "details", "createdAt"
            FROM "AiCallCampaignAuditEvent" WHERE "campaignId"=$1
            ORDER BY "createdAt" DESC, "id" DESC LIMIT 100
        `, input.campaignId)
        const audits: AiCallCampaignAuditEventV1[] = auditRows.map((event) => ({
            id: event.id,
            actorId: event.actorId,
            action: event.action,
            details: event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown>
                : {},
            createdAt: event.createdAt.toISOString(),
        }))
        const ops = await database.$queryRawUnsafe<Array<{
            activeLeases: number
            staleClaims: number
            lastActivityAt: Date
        }>>(`
            SELECT
              (SELECT COUNT(*)::int FROM "AiCallAdmissionLease" WHERE "campaignId"=$1 AND "releasedAt" IS NULL AND "leaseUntil">now()) AS "activeLeases",
              (SELECT COUNT(*)::int FROM "AiCallCampaignAttempt" WHERE "campaignId"=$1 AND "state" IN ('claimed','running') AND "claimUntil"<=now()) AS "staleClaims",
              GREATEST(c."updatedAt", COALESCE((SELECT MAX(a."updatedAt") FROM "AiCallCampaignAttempt" a WHERE a."campaignId"=$1), c."updatedAt")) AS "lastActivityAt"
            FROM "AiCallCampaign" c WHERE c."id"=$1
        `, input.campaignId)
        return {
            ...summary(campaign),
            audience: {
                sourceKind: campaign.audienceSourceKind,
                sourceRef: campaign.audienceSourceRef,
                sourceVersion: campaign.audienceSourceVersion,
                frozenAt: iso(campaign.audienceFrozenAt),
            },
            members,
            nextMemberCursor: hasMore ? visibleRows.at(-1)?.id ?? null : null,
            audit: audits,
            operations: {
                activeLeases: ops[0]?.activeLeases ?? 0,
                staleClaims: ops[0]?.staleClaims ?? 0,
                retryWaitMembers: campaign.retryWait,
                permanentFailures: campaign.failed,
                lastActivityAt: (ops[0]?.lastActivityAt ?? campaign.updatedAt).toISOString(),
                runtimeMode: readAiCallCampaignRuntimeMode(),
            },
        }
    },
}
