/**
 * Prisma adapter for cash-order ingestion. Fixed SQL text only.
 *
 * Every statement is a literal with a fixed parameter count; page-sized sets
 * travel as array parameters through UNNEST, never as SQL built from values.
 * Every transaction bounds itself with SET LOCAL before its first real
 * statement, so a lock wait or a slow statement fails the operation instead of
 * outliving the run budget:
 *
 *   short operation  maxWait 2 s, timeout 2 s, statement 1.5 s, lock 0.5 s
 *   page write       maxWait 2 s, timeout 5 s, statement 3 s,   lock 1 s
 *
 * The connection metadata read selects no client id and no key.
 */

import { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'

import { CASH_ORDER_INGESTION_TIMING_V1 as T } from './cash-order-ingestion-budget'
import {
    cashOrderCheckpointIdV1,
    CashOrderLeaseLostError,
    CashOrderProgressConflictError,
    type CashOrderCheckpointV1,
    type CashOrderIngestionStoreV1,
    type CashOrderPageWriteResultV1,
} from './cash-order-ingestion-store'

type Transaction = Prisma.TransactionClient

async function shortOperation<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`SET LOCAL statement_timeout = '1500ms'`)
        await transaction.$executeRawUnsafe(`SET LOCAL lock_timeout = '500ms'`)
        return work(transaction)
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 2_000, timeout: 2_000 })
}

async function writeOperation<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`SET LOCAL statement_timeout = '3000ms'`)
        await transaction.$executeRawUnsafe(`SET LOCAL lock_timeout = '1000ms'`)
        return work(transaction)
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 2_000, timeout: 5_000 })
}

async function databaseNow(transaction: Transaction): Promise<Date> {
    const rows = await transaction.$queryRawUnsafe<Array<{ dbNow: Date }>>(`SELECT now() AS "dbNow"`)
    return rows[0].dbNow
}

/** The observedAt every accepted row of this transaction carries. */
async function transactionObservedAt(transaction: Transaction): Promise<Date> {
    const rows = await transaction.$queryRawUnsafe<Array<{ observedAt: Date }>>(
        `SELECT date_trunc('milliseconds', now()) AS "observedAt"`)
    return rows[0].observedAt
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString())

function date(value: unknown): Date | null {
    if (value === null || value === undefined) return null
    return value instanceof Date ? value : new Date(String(value))
}

function toCheckpoint(row: Record<string, unknown>): CashOrderCheckpointV1 {
    const text = (value: unknown) => (value === null || value === undefined ? null : String(value))
    return {
        id: String(row.id),
        provider: String(row.provider),
        externalParkId: String(row.externalParkId),
        leaseToken: text(row.leaseToken),
        leaseExpiresAt: date(row.leaseExpiresAt),
        lastRunMode: text(row.lastRunMode),
        lastRunStatus: text(row.lastRunStatus),
        lastRunStartedAt: date(row.lastRunStartedAt),
        lastRunFinishedAt: date(row.lastRunFinishedAt),
        consecutiveFailures: Number(row.consecutiveFailures),
        lastErrorCode: text(row.lastErrorCode),
        lastErrorSummary: text(row.lastErrorSummary),
        lastApiConnectionId: text(row.lastApiConnectionId),
        lastRunSummary: row.lastRunSummary !== null && typeof row.lastRunSummary === 'object'
            ? row.lastRunSummary as Record<string, unknown>
            : null,
        lastHotSuccessAt: date(row.lastHotSuccessAt),
        reconciliationPassStartedAt: date(row.reconciliationPassStartedAt),
        reconciliationFloorBookedAt: date(row.reconciliationFloorBookedAt),
        reconciliationCursorBookedAt: date(row.reconciliationCursorBookedAt),
        lastReconciliationCompletedAt: date(row.lastReconciliationCompletedAt),
        providerRetryNotBefore: date(row.providerRetryNotBefore),
        providerRetryConnectionId: text(row.providerRetryConnectionId),
    }
}

export const legacyPrismaCashOrderIngestionStoreV1: CashOrderIngestionStoreV1 = {
    async readDatabaseNow() {
        return shortOperation(databaseNow)
    },

    async readAuthoritySnapshot() {
        return shortOperation(async (transaction) => {
            const parks = await transaction.park.findMany({
                where: { active: true },
                select: { id: true, externalParkId: true },
            })
            const links = await transaction.parkConnection.findMany({
                where: { enabled: true, archivedAt: null, park: { active: true } },
                select: {
                    id: true,
                    parkId: true,
                    externalParkId: true,
                    park: { select: { externalParkId: true } },
                    apiConnection: { select: { id: true, parkId: true } },
                },
            })
            return {
                dbNow: await databaseNow(transaction),
                snapshot: {
                    parks: parks.map((park) => ({ id: park.id, externalParkId: park.externalParkId })),
                    links: links.map((link) => ({
                        linkId: link.id,
                        localParkId: link.parkId,
                        linkExternalParkId: link.externalParkId,
                        parkExternalParkId: link.park.externalParkId,
                        apiConnectionId: link.apiConnection.id,
                        apiConnectionParkId: link.apiConnection.parkId,
                    })),
                },
            }
        })
    },

    async readCheckpoints(provider, externalParkIds) {
        return shortOperation(async (transaction) => {
            const rows = await transaction.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `SELECT "id","provider","externalParkId","leaseToken","leaseExpiresAt","lastRunMode","lastRunStatus",
                        "lastRunStartedAt","lastRunFinishedAt","consecutiveFailures","lastErrorCode","lastErrorSummary",
                        "lastApiConnectionId","lastRunSummary","lastHotSuccessAt","reconciliationPassStartedAt",
                        "reconciliationFloorBookedAt","reconciliationCursorBookedAt","lastReconciliationCompletedAt",
                        "providerRetryNotBefore","providerRetryConnectionId"
                 FROM "CompensationCashOrderIngestionCheckpoint"
                 WHERE "provider" = $1 AND "externalParkId" = ANY($2::text[])`,
                provider, [...externalParkIds],
            )
            return { dbNow: await databaseNow(transaction), checkpoints: rows.map(toCheckpoint) }
        })
    },

    async acquireLease({ provider, externalParkId, token }) {
        return shortOperation(async (transaction) => {
            await transaction.$executeRawUnsafe(
                `INSERT INTO "CompensationCashOrderIngestionCheckpoint" ("id","provider","externalParkId","createdAt","updatedAt")
                 VALUES ($1, $2, $3, now(), now())
                 ON CONFLICT ("provider","externalParkId") DO NOTHING`,
                cashOrderCheckpointIdV1(provider, externalParkId), provider, externalParkId,
            )
            const rows = await transaction.$queryRawUnsafe<Array<Record<string, unknown>>>(
                `UPDATE "CompensationCashOrderIngestionCheckpoint"
                 SET "leaseToken" = $3, "leaseExpiresAt" = now() + interval '120 seconds', "updatedAt" = now()
                 WHERE "provider" = $1 AND "externalParkId" = $2
                   AND ("leaseToken" IS NULL OR "leaseExpiresAt" <= now())
                 RETURNING "id","provider","externalParkId","leaseToken","leaseExpiresAt","lastRunMode","lastRunStatus",
                           "lastRunStartedAt","lastRunFinishedAt","consecutiveFailures","lastErrorCode","lastErrorSummary",
                           "lastApiConnectionId","lastRunSummary","lastHotSuccessAt","reconciliationPassStartedAt",
                           "reconciliationFloorBookedAt","reconciliationCursorBookedAt","lastReconciliationCompletedAt",
                           "providerRetryNotBefore","providerRetryConnectionId"`,
                provider, externalParkId, token,
            )
            const dbNow = await databaseNow(transaction)
            return rows.length === 1
                ? { acquired: true as const, dbNow, checkpoint: toCheckpoint(rows[0]) }
                : { acquired: false as const, dbNow }
        })
    },

    async releaseLease({ checkpointId, token }) {
        await shortOperation(async (transaction) => {
            await transaction.$executeRawUnsafe(
                `UPDATE "CompensationCashOrderIngestionCheckpoint"
                 SET "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = now()
                 WHERE "id" = $1 AND "leaseToken" = $2`,
                checkpointId, token,
            )
        })
    },

    async writePage(write) {
        return writeOperation(async (transaction): Promise<CashOrderPageWriteResultV1> => {
            // Prove the lease before anything else. The row lock this takes is
            // held to commit, so a concurrent takeover waits and then finds the
            // renewed expiry; a takeover that committed first makes this match
            // nothing, and the page rolls back untouched.
            const renewed = await transaction.$executeRawUnsafe(
                `UPDATE "CompensationCashOrderIngestionCheckpoint"
                 SET "leaseExpiresAt" = now() + interval '120 seconds', "updatedAt" = now()
                 WHERE "id" = $1 AND "leaseToken" = $2 AND "leaseExpiresAt" > now()`,
                write.checkpointId, write.leaseToken,
            )
            if (renewed !== 1) throw new CashOrderLeaseLostError()

            const accepted = write.accepted
            const orderIds = accepted.map((row) => row.externalOrderId)
            let driverReassigned = 0
            let amountChanged = 0
            let endedAtChanged = 0
            let inserted = 0
            let updated = 0
            if (accepted.length > 0) {
                // Counters only: the upsert below does not depend on this read.
                const existing = await transaction.$queryRawUnsafe<Array<{
                    externalOrderId: string; externalDriverProfileId: string; amountKopecks: number; endedAt: Date
                }>>(
                    `SELECT "externalOrderId","externalDriverProfileId","amountKopecks","endedAt"
                     FROM "CompensationCashOrder"
                     WHERE "provider" = $1 AND "externalParkId" = $2 AND "externalOrderId" = ANY($3::text[])`,
                    write.provider, write.externalParkId, orderIds,
                )
                const byId = new Map(existing.map((row) => [row.externalOrderId, row]))
                for (const row of accepted) {
                    const before = byId.get(row.externalOrderId)
                    if (!before) continue
                    if (before.externalDriverProfileId !== row.externalDriverProfileId) driverReassigned += 1
                    if (Number(before.amountKopecks) !== row.amountKopecks) amountChanged += 1
                    if (new Date(before.endedAt).getTime() !== row.endedAt.getTime()) endedAtChanged += 1
                }

                // observedAt is this transaction's time on every accepted row,
                // rewritten even when nothing else changed, at the column's
                // millisecond precision. The guard compares times only; it
                // must never compare values.
                const written = await transaction.$queryRawUnsafe<Array<{ externalOrderId: string; inserted: boolean }>>(
                    `INSERT INTO "CompensationCashOrder" AS stored
                       ("id","provider","externalParkId","externalOrderId","shortOrderIdDisplay","externalDriverProfileId",
                        "rawPrice","amountKopecks","endedAt","observedAt","sourceConnectionId","providerBookedAt",
                        "createdAt","updatedAt")
                     SELECT page."id", $1, $2, page."externalOrderId", page."shortOrderIdDisplay",
                            page."externalDriverProfileId", page."rawPrice", page."amountKopecks",
                            page."endedAt"::timestamptz, date_trunc('milliseconds', now()), $3,
                            page."providerBookedAt"::timestamptz, now(), now()
                     FROM UNNEST($4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::integer[], $10::text[], $11::text[])
                       AS page("id","externalOrderId","shortOrderIdDisplay","externalDriverProfileId","rawPrice",
                               "amountKopecks","endedAt","providerBookedAt")
                     ON CONFLICT ("provider","externalParkId","externalOrderId") DO UPDATE SET
                       "shortOrderIdDisplay" = EXCLUDED."shortOrderIdDisplay",
                       "externalDriverProfileId" = EXCLUDED."externalDriverProfileId",
                       "rawPrice" = EXCLUDED."rawPrice",
                       "amountKopecks" = EXCLUDED."amountKopecks",
                       "endedAt" = EXCLUDED."endedAt",
                       "observedAt" = EXCLUDED."observedAt",
                       "sourceConnectionId" = EXCLUDED."sourceConnectionId",
                       "providerBookedAt" = COALESCE(EXCLUDED."providerBookedAt", stored."providerBookedAt"),
                       "updatedAt" = now()
                     WHERE stored."observedAt" <= EXCLUDED."observedAt"
                     RETURNING stored."externalOrderId", (stored.xmax = 0) AS "inserted"`,
                    write.provider,
                    write.externalParkId,
                    write.sourceConnectionId,
                    accepted.map((row) => row.id),
                    orderIds,
                    accepted.map((row) => row.shortOrderIdDisplay),
                    accepted.map((row) => row.externalDriverProfileId),
                    accepted.map((row) => row.rawPrice),
                    accepted.map((row) => row.amountKopecks),
                    accepted.map((row) => row.endedAt.toISOString()),
                    accepted.map((row) => iso(row.providerBookedAt)),
                )
                inserted = written.filter((row) => row.inserted).length
                updated = written.length - inserted
            }

            let removed = 0
            if (write.removedOrderIds.length > 0) {
                removed = await transaction.$executeRawUnsafe(
                    `DELETE FROM "CompensationCashOrder" AS stored
                     USING UNNEST($3::text[]) AS removal("externalOrderId")
                     WHERE stored."provider" = $1 AND stored."externalParkId" = $2
                       AND stored."externalOrderId" = removal."externalOrderId"
                       AND stored."observedAt" <= now()`,
                    write.provider, write.externalParkId, [...write.removedOrderIds],
                )
            }

            if (write.progress !== null) {
                const { expected, next } = write.progress
                const advanced = await transaction.$executeRawUnsafe(
                    `UPDATE "CompensationCashOrderIngestionCheckpoint"
                     SET "lastHotSuccessAt" = $3::timestamptz,
                         "reconciliationPassStartedAt" = $4::timestamptz,
                         "reconciliationFloorBookedAt" = $5::timestamptz,
                         "reconciliationCursorBookedAt" = $6::timestamptz,
                         "lastReconciliationCompletedAt" = $7::timestamptz,
                         "updatedAt" = now()
                     WHERE "id" = $1 AND "leaseToken" = $2
                       AND "lastHotSuccessAt" IS NOT DISTINCT FROM $8::timestamptz
                       AND "reconciliationPassStartedAt" IS NOT DISTINCT FROM $9::timestamptz
                       AND "reconciliationFloorBookedAt" IS NOT DISTINCT FROM $10::timestamptz
                       AND "reconciliationCursorBookedAt" IS NOT DISTINCT FROM $11::timestamptz
                       AND "lastReconciliationCompletedAt" IS NOT DISTINCT FROM $12::timestamptz`,
                    write.checkpointId,
                    write.leaseToken,
                    iso(next.lastHotSuccessAt),
                    iso(next.reconciliationPassStartedAt),
                    iso(next.reconciliationFloorBookedAt),
                    iso(next.reconciliationCursorBookedAt),
                    iso(next.lastReconciliationCompletedAt),
                    iso(expected.lastHotSuccessAt),
                    iso(expected.reconciliationPassStartedAt),
                    iso(expected.reconciliationFloorBookedAt),
                    iso(expected.reconciliationCursorBookedAt),
                    iso(expected.lastReconciliationCompletedAt),
                )
                if (advanced !== 1) throw new CashOrderProgressConflictError()
            }

            return {
                inserted,
                updated,
                guardedNoops: (accepted.length - inserted - updated) + (write.removedOrderIds.length - removed),
                removed,
                driverReassigned,
                amountChanged,
                endedAtChanged,
                observedAt: await transactionObservedAt(transaction),
            }
        })
    },

    async recordDeferral({ checkpointId, token, seconds, connectionId }) {
        const bounded = Math.max(0, Math.min(Math.floor(seconds), T.MAX_DEFERRAL_SECONDS))
        return shortOperation(async (transaction) => {
            const rows = await transaction.$queryRawUnsafe<Array<{ providerRetryNotBefore: Date }>>(
                `UPDATE "CompensationCashOrderIngestionCheckpoint"
                 SET "providerRetryNotBefore" = now() + ($3::integer * interval '1 second'),
                     "providerRetryConnectionId" = $4,
                     "updatedAt" = now()
                 WHERE "id" = $1 AND "leaseToken" = $2
                 RETURNING "providerRetryNotBefore"`,
                checkpointId, token, bounded, connectionId,
            )
            return rows.length === 1 ? rows[0].providerRetryNotBefore : null
        })
    },

    async finishBackgroundRun(input) {
        return shortOperation(async (transaction) => {
            await transaction.$executeRawUnsafe(
                `INSERT INTO "CompensationCashOrderIngestionCheckpoint" ("id","provider","externalParkId","createdAt","updatedAt")
                 VALUES ($1, $2, $3, now(), now())
                 ON CONFLICT ("provider","externalParkId") DO NOTHING`,
                cashOrderCheckpointIdV1(input.provider, input.externalParkId), input.provider, input.externalParkId,
            )
            const written = await transaction.$executeRawUnsafe(
                `UPDATE "CompensationCashOrderIngestionCheckpoint"
                 SET "lastRunMode" = $3,
                     "lastRunStatus" = $4,
                     "lastRunStartedAt" = $5::timestamptz,
                     "lastRunFinishedAt" = now(),
                     "consecutiveFailures" = CASE WHEN $6::boolean THEN "consecutiveFailures" + 1 ELSE 0 END,
                     "lastErrorCode" = $7,
                     "lastErrorSummary" = $8,
                     "lastApiConnectionId" = COALESCE($9, "lastApiConnectionId"),
                     "lastRunSummary" = jsonb_set(COALESCE("lastRunSummary", '{}'::jsonb), '{background}', $10::jsonb, true),
                     "updatedAt" = now()
                 WHERE "provider" = $1 AND "externalParkId" = $2
                   AND ("leaseToken" IS NULL OR "leaseExpiresAt" <= now() OR "leaseToken" = $11)`,
                input.provider,
                input.externalParkId,
                input.mode,
                input.status,
                input.startedAt.toISOString(),
                input.status === 'failed',
                input.errorCode,
                input.errorSummary === null ? null : input.errorSummary.slice(0, 500),
                input.apiConnectionId,
                JSON.stringify(input.summary),
                input.leaseToken ?? '',
            )
            return written === 1
        })
    },

    async recordTargetedSummary({ provider, externalParkId, summary }) {
        await shortOperation(async (transaction) => {
            await transaction.$executeRawUnsafe(
                `UPDATE "CompensationCashOrderIngestionCheckpoint"
                 SET "lastRunSummary" = jsonb_set(COALESCE("lastRunSummary", '{}'::jsonb), '{targeted}', $3::jsonb, true),
                     "updatedAt" = now()
                 WHERE "provider" = $1 AND "externalParkId" = $2`,
                provider, externalParkId, JSON.stringify(summary),
            )
        })
    },

    async recordDryRunProgress({ checkpointId, token, dryRun }) {
        return shortOperation(async (transaction) => {
            const written = await transaction.$executeRawUnsafe(
                `UPDATE "CompensationCashOrderIngestionCheckpoint"
                 SET "lastRunSummary" = jsonb_set(COALESCE("lastRunSummary", '{}'::jsonb), '{dryRun}', $3::jsonb, true),
                     "updatedAt" = now()
                 WHERE "id" = $1 AND "leaseToken" = $2`,
                checkpointId, token, JSON.stringify(dryRun),
            )
            return written === 1
        })
    },
}
