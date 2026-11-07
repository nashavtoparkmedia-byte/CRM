/**
 * Prisma implementation of the Cash referral ledger store. Fixed SQL only.
 *
 * Every row of CashAccessEvent is appended inside a transaction that reads
 * the chain's last row, takes the database clock at millisecond precision
 * (the precision the column stores, so the hash is computed over exactly what
 * is kept), and inserts the next seq. Two writers on one chain cannot both
 * commit: UNIQUE(chainContactId, seq) refuses the second, which is reported
 * as a version conflict for the caller to retry. A repeated idempotency key
 * returns the row already written.
 *
 * Each statement below is written out in full, so the analyzer reads it end
 * to end as a read or write of one named table.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { prisma } from '@/lib/prisma'

import {
    cashAccessEventHashV1,
    type CashAccessEventKindV1,
    type CashAccessEventV1,
    type CashAccessJsonV1,
} from './compensation-referral-ledger'

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

export class CashAccessVersionConflictV1 extends Error {
    constructor(readonly chainContactId: string) {
        super('cash access chain moved on; retry')
    }
}

/** What a writer supplies; the seq, links, clock and hash are the store's. */
export interface CashAccessEventDraftV1 {
    chainContactId: string
    kind: CashAccessEventKindV1
    lineageDigest: string
    codeHash: string | null
    attributionId: string | null
    payload: { [key: string]: CashAccessJsonV1 }
    actor:
        | { kind: 'system'; id: string }
        | { kind: 'signed_staff_session'; id: string; capability: string; sessionId: string; authenticatedAt: Date }
    reason: string | null
    idempotencyKey: string
}

interface EventRow {
    id: string
    chainContactId: string
    seq: number
    kind: string
    lineageDigest: string
    codeHash: string | null
    attributionId: string | null
    payload: unknown
    actorKind: string
    actorId: string
    actorCapability: string | null
    actorSessionId: string | null
    actorAuthenticatedAt: Date | null
    reason: string | null
    idempotencyKey: string
    occurredAt: Date
    prevHash: string | null
    hash: string
}

function toEvent(row: EventRow): CashAccessEventV1 {
    return {
        id: String(row.id),
        chainContactId: String(row.chainContactId),
        seq: Number(row.seq),
        kind: String(row.kind) as CashAccessEventKindV1,
        lineageDigest: String(row.lineageDigest),
        codeHash: row.codeHash === null ? null : String(row.codeHash),
        attributionId: row.attributionId === null ? null : String(row.attributionId),
        payload: (row.payload ?? {}) as { [key: string]: CashAccessJsonV1 },
        actorKind: String(row.actorKind) as CashAccessEventV1['actorKind'],
        actorId: String(row.actorId),
        actorCapability: row.actorCapability === null ? null : String(row.actorCapability),
        actorSessionId: row.actorSessionId === null ? null : String(row.actorSessionId),
        actorAuthenticatedAt: row.actorAuthenticatedAt === null ? null : new Date(row.actorAuthenticatedAt),
        reason: row.reason === null ? null : String(row.reason),
        idempotencyKey: String(row.idempotencyKey),
        occurredAt: new Date(row.occurredAt),
        prevHash: row.prevHash === null ? null : String(row.prevHash),
        hash: String(row.hash),
    }
}

function isUniqueViolation(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code
    const message = error instanceof Error ? error.message : ''
    return code === 'P2002' || /23505|duplicate key value/.test(message)
}

async function appendInV1(tx: Tx, draft: CashAccessEventDraftV1): Promise<CashAccessEventV1> {
    const existing = await tx.$queryRawUnsafe<EventRow[]>(
        `SELECT "id","chainContactId","seq","kind","lineageDigest","codeHash","attributionId","payload","actorKind","actorId","actorCapability","actorSessionId","actorAuthenticatedAt","reason","idempotencyKey","occurredAt","prevHash","hash"
         FROM "CashAccessEvent"
         WHERE "idempotencyKey" = $1`,
        draft.idempotencyKey,
    )
    if (existing.length > 0) return toEvent(existing[0])

    const last = await tx.$queryRawUnsafe<Array<{ seq: number; hash: string }>>(
        `SELECT "seq","hash" FROM "CashAccessEvent"
         WHERE "chainContactId" = $1
         ORDER BY "seq" DESC
         LIMIT 1`,
        draft.chainContactId,
    )
    const clock = await tx.$queryRawUnsafe<Array<{ now: Date }>>(`SELECT date_trunc('milliseconds', now()) AS "now"`)
    const staff = draft.actor.kind === 'signed_staff_session' ? draft.actor : null
    const unhashed: Omit<CashAccessEventV1, 'hash'> = {
        id: randomUUID(),
        chainContactId: draft.chainContactId,
        seq: last.length === 0 ? 1 : Number(last[0].seq) + 1,
        kind: draft.kind,
        lineageDigest: draft.lineageDigest,
        codeHash: draft.codeHash,
        attributionId: draft.attributionId,
        payload: draft.payload,
        actorKind: draft.actor.kind,
        actorId: draft.actor.id,
        actorCapability: staff?.capability ?? null,
        actorSessionId: staff?.sessionId ?? null,
        // The column keeps milliseconds, so the hash covers exactly what is kept.
        actorAuthenticatedAt: staff === null ? null : new Date(Math.floor(staff.authenticatedAt.getTime())),
        reason: draft.reason,
        idempotencyKey: draft.idempotencyKey,
        occurredAt: new Date(clock[0].now),
        prevHash: last.length === 0 ? null : String(last[0].hash),
    }
    const hash = cashAccessEventHashV1(unhashed)
    try {
        await tx.$executeRawUnsafe(
            `INSERT INTO "CashAccessEvent"
               ("id","chainContactId","seq","kind","lineageDigest","codeHash","attributionId","payload","actorKind","actorId","actorCapability","actorSessionId","actorAuthenticatedAt","reason","idempotencyKey","occurredAt","prevHash","hash")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            unhashed.id,
            unhashed.chainContactId,
            unhashed.seq,
            unhashed.kind,
            unhashed.lineageDigest,
            unhashed.codeHash,
            unhashed.attributionId,
            JSON.stringify(unhashed.payload),
            unhashed.actorKind,
            unhashed.actorId,
            unhashed.actorCapability,
            unhashed.actorSessionId,
            unhashed.actorAuthenticatedAt,
            unhashed.reason,
            unhashed.idempotencyKey,
            unhashed.occurredAt,
            unhashed.prevHash,
            hash,
        )
    } catch (error) {
        if (isUniqueViolation(error)) throw new CashAccessVersionConflictV1(draft.chainContactId)
        throw error
    }
    return { ...unhashed, hash }
}

export type CashReferralCaptureOutcomeV1 = 'captured' | 'already_attributed' | 'unknown_code'

export interface CashReferralAttributionRowV1 {
    id: string
    inviterContactId: string
    inviterLineageDigest: string
    inviteeTelegramUserId: string
    inviteeDriverId: string | null
    inviteeContactId: string | null
    inviteePersonKey: string | null
    state: string
    reason: string | null
    capturedAt: Date
    decidedAt: Date | null
    version: number
}

interface AttributionRow {
    id: string
    inviterContactId: string
    inviterLineageDigest: string
    inviteeTelegramUserId: string
    inviteeDriverId: string | null
    inviteeContactId: string | null
    inviteePersonKey: string | null
    state: string
    reason: string | null
    capturedAt: Date
    decidedAt: Date | null
    version: number
}

function toAttribution(row: AttributionRow): CashReferralAttributionRowV1 {
    return {
        id: String(row.id),
        inviterContactId: String(row.inviterContactId),
        inviterLineageDigest: String(row.inviterLineageDigest),
        inviteeTelegramUserId: String(row.inviteeTelegramUserId),
        inviteeDriverId: row.inviteeDriverId === null ? null : String(row.inviteeDriverId),
        inviteeContactId: row.inviteeContactId === null ? null : String(row.inviteeContactId),
        inviteePersonKey: row.inviteePersonKey === null ? null : String(row.inviteePersonKey),
        state: String(row.state),
        reason: row.reason === null ? null : String(row.reason),
        capturedAt: new Date(row.capturedAt),
        decidedAt: row.decidedAt === null ? null : new Date(row.decidedAt),
        version: Number(row.version),
    }
}

/** The decision a writer records for one attribution. */
export interface CashReferralDecisionWriteV1 {
    attributionId: string
    expectedVersion: number
    state: 'pending' | 'needs_review' | 'not_qualified' | 'qualified' | 'rejected'
    reason: string | null
    inviteeContactId: string | null
    /** cashReferralPersonKeyDigestV1 of the park person key, never the key itself. */
    inviteePersonKey: string | null
    targetParkId: string | null
    factsSnapshot: { [key: string]: CashAccessJsonV1 }
    decision: { [key: string]: CashAccessJsonV1 }
    /** Grant the inviter: only for a qualified decision that is not already entitled. */
    grant: boolean
    /** Dismissal readings first seen at this decision, kept for the invitation. */
    observedDismissals: ReadonlyArray<{ profileKey: string; dismissedAt: Date; readAt: Date }>
    idempotencyKey: string
}

export type CashReferralDecisionWriteOutcomeV1 = 'written' | 'version_conflict' | 'person_already_qualified'

export const legacyPrismaCashReferralLedgerStoreV1 = {
    /** One contact's whole chain, oldest first. */
    async readChain(chainContactId: string): Promise<CashAccessEventV1[]> {
        const rows = await prisma.$queryRawUnsafe<EventRow[]>(
            `SELECT "id","chainContactId","seq","kind","lineageDigest","codeHash","attributionId","payload","actorKind","actorId","actorCapability","actorSessionId","actorAuthenticatedAt","reason","idempotencyKey","occurredAt","prevHash","hash"
             FROM "CashAccessEvent"
             WHERE "chainContactId" = $1
             ORDER BY "seq" ASC`,
            chainContactId,
        )
        return rows.map(toEvent)
    },

    /** Appends one row on its own. Retries are the caller's. */
    async append(draft: CashAccessEventDraftV1): Promise<CashAccessEventV1> {
        return prisma.$transaction((tx) => appendInV1(tx, draft))
    },

    /**
     * Issues a new referral code for a proven inviter: a 128-bit token the
     * caller shows once, and its sha256 kept in the inviter's chain.
     */
    async issueCode(input: { inviterContactId: string; lineageDigest: string }): Promise<{ token: string; codeHash: string }> {
        const token = `r_${randomBytes(16).toString('base64url')}`
        const codeHash = createHash('sha256').update(token, 'utf8').digest('hex')
        await prisma.$transaction((tx) => appendInV1(tx, {
            chainContactId: input.inviterContactId,
            kind: 'referral_code_issued',
            lineageDigest: input.lineageDigest,
            codeHash,
            attributionId: null,
            payload: {},
            actor: { kind: 'system', id: 'system:cash-referral' },
            reason: null,
            idempotencyKey: `code:${codeHash}`,
        }))
        return { token, codeHash }
    },

    /**
     * Records that one Telegram account opened a code. The first account to
     * open any code owns its attribution; nothing about the outcome may reach
     * the person who opened it.
     */
    async capture(input: { token: string; inviteeTelegramUserId: string; inviteeDriverId?: string | null }): Promise<CashReferralCaptureOutcomeV1> {
        const codeHash = createHash('sha256').update(input.token, 'utf8').digest('hex')
        return prisma.$transaction(async (tx) => {
            const issued = await tx.$queryRawUnsafe<Array<{ chainContactId: string; lineageDigest: string }>>(
                `SELECT "chainContactId","lineageDigest" FROM "CashAccessEvent"
                 WHERE "codeHash" = $1 AND "kind" = 'referral_code_issued'`,
                codeHash,
            )
            if (issued.length === 0) return 'unknown_code' as const
            const attributionId = randomUUID()
            const inserted = await tx.$queryRawUnsafe<Array<{ id: string }>>(
                `INSERT INTO "CashReferralAttribution"
                   ("id","inviterContactId","inviterLineageDigest","codeHash","inviteeTelegramUserId","inviteeDriverId","state","capturedAt","updatedAt")
                 VALUES ($1,$2,$3,$4,$5,$6,'captured',date_trunc('milliseconds', now()),date_trunc('milliseconds', now()))
                 ON CONFLICT ("inviteeTelegramUserId") DO NOTHING
                 RETURNING "id"`,
                attributionId,
                String(issued[0].chainContactId),
                String(issued[0].lineageDigest),
                codeHash,
                input.inviteeTelegramUserId,
                input.inviteeDriverId ?? null,
            )
            if (inserted.length === 0) return 'already_attributed' as const
            await appendInV1(tx, {
                chainContactId: String(issued[0].chainContactId),
                kind: 'referral_captured',
                lineageDigest: String(issued[0].lineageDigest),
                codeHash: null,
                attributionId,
                payload: {},
                actor: { kind: 'system', id: 'system:cash-referral' },
                reason: null,
                idempotencyKey: `capture:${attributionId}`,
            })
            return 'captured' as const
        })
    },

    async findAttribution(attributionId: string): Promise<CashReferralAttributionRowV1 | null> {
        const rows = await prisma.$queryRawUnsafe<AttributionRow[]>(
            `SELECT "id","inviterContactId","inviterLineageDigest","inviteeTelegramUserId","inviteeDriverId","inviteeContactId","inviteePersonKey","state","reason","capturedAt","decidedAt","version"
             FROM "CashReferralAttribution"
             WHERE "id" = $1`,
            attributionId,
        )
        return rows.length === 0 ? null : toAttribution(rows[0])
    },

    /**
     * Records the Driver an invited Telegram account was proven linked to, the
     * first time the bot route proves it. Never moves an invitation to another
     * Driver once set.
     */
    async attachInviteeDriver(input: { inviteeTelegramUserId: string; driverId: string }): Promise<boolean> {
        const changed = await prisma.$executeRawUnsafe(
            `UPDATE "CashReferralAttribution"
             SET "inviteeDriverId" = $2, "updatedAt" = date_trunc('milliseconds', now())
             WHERE "inviteeTelegramUserId" = $1 AND "inviteeDriverId" IS NULL`,
            input.inviteeTelegramUserId,
            input.driverId,
        )
        return changed > 0
    },

    /**
     * Invitations not yet decided for good, the longest unexamined first, so
     * every open invitation is examined within ceil(open / limit) passes. One
     * examined in the last 50 minutes waits, so two passes do not both take it.
     */
    async findUndecided(limit: number): Promise<CashReferralAttributionRowV1[]> {
        const rows = await prisma.$queryRawUnsafe<AttributionRow[]>(
            `SELECT "id","inviterContactId","inviterLineageDigest","inviteeTelegramUserId","inviteeDriverId","inviteeContactId","inviteePersonKey","state","reason","capturedAt","decidedAt","version"
             FROM "CashReferralAttribution"
             WHERE "state" IN ('captured','pending','needs_review','not_qualified')
               AND ("checkedAt" IS NULL OR "checkedAt" < now() - interval '50 minutes')
             ORDER BY "checkedAt" ASC NULLS FIRST, "capturedAt" ASC
             LIMIT $1`,
            limit,
        )
        return rows.map(toAttribution)
    },

    /** Stamps invitations as examined now. Changes no decision and no version. */
    async markExamined(attributionIds: readonly string[]): Promise<void> {
        if (attributionIds.length === 0) return
        await prisma.$executeRawUnsafe(
            `UPDATE "CashReferralAttribution"
             SET "checkedAt" = date_trunc('milliseconds', now())
             WHERE "id" = ANY($1::text[])`,
            [...attributionIds],
        )
    },

    /** The contacts that hold a ledger chain, in a stable order, for the chain check. */
    async listChainContacts(limit: number): Promise<string[]> {
        const rows = await prisma.$queryRawUnsafe<Array<{ chainContactId: string }>>(
            `SELECT DISTINCT "chainContactId" FROM "CashAccessEvent"
             ORDER BY "chainContactId" ASC
             LIMIT $1`,
            limit,
        )
        return rows.map((row) => String(row.chainContactId))
    },

    /** Whether another invitation already qualified this person. */
    async personAlreadyQualified(personKey: string, exceptAttributionId: string): Promise<boolean> {
        const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT "id" FROM "CashReferralAttribution"
             WHERE "inviteePersonKey" = $1 AND "state" = 'qualified' AND "id" <> $2
             LIMIT 1`,
            personKey,
            exceptAttributionId,
        )
        return rows.length > 0
    },

    /** Counts per state of one inviter's invitations: the inviter sees nothing else. */
    async countByInviter(inviterContactId: string): Promise<Record<string, number>> {
        const rows = await prisma.$queryRawUnsafe<Array<{ state: string; count: bigint | number }>>(
            `SELECT "state", count(*) AS "count" FROM "CashReferralAttribution"
             WHERE "inviterContactId" = $1
             GROUP BY "state"`,
            inviterContactId,
        )
        return Object.fromEntries(rows.map((row) => [String(row.state), Number(row.count)]))
    },

    /**
     * Records one decision: the attribution's new state, the decision row in
     * the inviter's chain, the readings first seen, and the grant when it is
     * one. All or nothing; a moved version or a person already qualified
     * elsewhere is reported instead of written.
     */
    async writeDecision(write: CashReferralDecisionWriteV1): Promise<CashReferralDecisionWriteOutcomeV1> {
        try {
            return await prisma.$transaction(async (tx) => {
                const rows = await tx.$queryRawUnsafe<AttributionRow[]>(
                    `UPDATE "CashReferralAttribution"
                     SET "state" = $3, "reason" = $4, "inviteeContactId" = $5, "inviteePersonKey" = $6, "targetParkId" = $7,
                         "factsSnapshot" = $8::jsonb, "decidedAt" = date_trunc('milliseconds', now()),
                         "version" = "version" + 1, "updatedAt" = date_trunc('milliseconds', now())
                     WHERE "id" = $1 AND "version" = $2
                     RETURNING "id","inviterContactId","inviterLineageDigest","inviteeTelegramUserId","inviteeDriverId","inviteeContactId","inviteePersonKey","state","reason","capturedAt","decidedAt","version"`,
                    write.attributionId,
                    write.expectedVersion,
                    write.state,
                    write.reason,
                    write.inviteeContactId,
                    write.inviteePersonKey,
                    write.targetParkId,
                    JSON.stringify(write.factsSnapshot),
                )
                if (rows.length === 0) return 'version_conflict' as const
                const attribution = toAttribution(rows[0])
                const chain = { chainContactId: attribution.inviterContactId, lineageDigest: attribution.inviterLineageDigest }
                for (const observed of write.observedDismissals) {
                    await appendInV1(tx, {
                        ...chain,
                        kind: 'invitee_dismissal_observed',
                        codeHash: null,
                        attributionId: attribution.id,
                        payload: { profileKey: observed.profileKey, dismissedAt: observed.dismissedAt.toISOString(), readAt: observed.readAt.toISOString() },
                        actor: { kind: 'system', id: 'system:cash-referral' },
                        reason: null,
                        // One observation per profile and stated dismissal, however often it is read.
                        idempotencyKey: `dismissal:${attribution.id}:${observed.profileKey}:${observed.dismissedAt.toISOString()}`,
                    })
                }
                await appendInV1(tx, {
                    ...chain,
                    kind: 'referral_decided',
                    codeHash: null,
                    attributionId: attribution.id,
                    payload: write.decision,
                    actor: { kind: 'system', id: 'system:cash-referral' },
                    reason: null,
                    idempotencyKey: write.idempotencyKey,
                })
                if (write.grant) {
                    await appendInV1(tx, {
                        ...chain,
                        kind: 'referral_entitlement_granted',
                        codeHash: null,
                        attributionId: attribution.id,
                        payload: {},
                        actor: { kind: 'system', id: 'system:cash-referral' },
                        reason: null,
                        idempotencyKey: `grant:${attribution.id}`,
                    })
                }
                return 'written' as const
            })
        } catch (error) {
            if (error instanceof CashAccessVersionConflictV1) return 'version_conflict'
            if (isUniqueViolation(error)) return 'person_already_qualified'
            throw error
        }
    },

    /** The ledger rows of one invitation: its sanctions and kept readings among them. */
    async readAttributionEvents(attributionId: string): Promise<CashAccessEventV1[]> {
        const rows = await prisma.$queryRawUnsafe<EventRow[]>(
            `SELECT "id","chainContactId","seq","kind","lineageDigest","codeHash","attributionId","payload","actorKind","actorId","actorCapability","actorSessionId","actorAuthenticatedAt","reason","idempotencyKey","occurredAt","prevHash","hash"
             FROM "CashAccessEvent"
             WHERE "attributionId" = $1
             ORDER BY "seq" ASC`,
            attributionId,
        )
        return rows.map(toEvent)
    },
}
