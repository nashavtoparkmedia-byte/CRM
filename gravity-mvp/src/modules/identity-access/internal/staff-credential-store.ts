import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { StaffPasswordVerifierV1 } from './staff-session-credentials'

/**
 * The one reader and writer of `StaffCredential` / `StaffCredentialEvent`
 * (identity_access). Every write is one transaction that first takes the
 * staff-credential advisory lock, so the set-level checks (the bootstrap
 * window, the last credentialed Администратор) cannot interleave.
 *
 * Only `findVerifier` selects the password verifier (salt and hash), and only
 * the password check calls it. Every other read and every write returns the
 * credential's status alone, so verifier material reaches nothing else.
 */

const STAFF_CREDENTIAL_ADVISORY_CLASS_ID = 0x594f4b4f // "YOKO"
const STAFF_CREDENTIAL_ADVISORY_OBJECT_ID = 0x53544631 // "STF1"

export type StaffCredentialEventKindV1 = 'password_set' | 'password_reset' | 'epoch_bump' | 'revoked' | 'login' | 'logout'

/** What everything but the password check needs: no verifier material. */
export interface StaffCredentialStatusV1 {
    userId: string
    registryCreatedAt: string
    sessionEpoch: number
    revokedAt: Date | null
}

const STATUS_SELECT = {
    userId: true,
    registryCreatedAt: true,
    sessionEpoch: true,
    revokedAt: true,
} as const

type Client = Prisma.TransactionClient | typeof prisma

async function lock(transaction: Prisma.TransactionClient): Promise<void> {
    await transaction.$queryRaw(Prisma.sql`
        SELECT (
            pg_advisory_xact_lock(
                CAST(${STAFF_CREDENTIAL_ADVISORY_CLASS_ID} AS integer),
                CAST(${STAFF_CREDENTIAL_ADVISORY_OBJECT_ID} AS integer)
            ) IS NULL
        ) AS admitted
    `)
}

/** The transaction-scoped view the staff operations decide and write through. */
export interface StaffCredentialTransactionV1 {
    find(userId: string): Promise<StaffCredentialStatusV1 | null>
    /** Ids holding a live (not revoked) credential. */
    liveUserIds(): Promise<Set<string>>
    upsertVerifier(input: {
        userId: string
        registryCreatedAt: string
        verifier: StaffPasswordVerifierV1
        actor: string
        now: Date
    }): Promise<StaffCredentialStatusV1>
    bumpEpoch(userId: string, actor: string, now: Date): Promise<StaffCredentialStatusV1 | null>
    revoke(userId: string, actor: string, now: Date): Promise<StaffCredentialStatusV1 | null>
    record(event: { userId: string, kind: StaffCredentialEventKindV1, actor: string, sid?: string | null }): Promise<void>
}

function transactionView(tx: Prisma.TransactionClient): StaffCredentialTransactionV1 {
    return {
        async find(userId) {
            return tx.staffCredential.findUnique({ where: { userId }, select: STATUS_SELECT })
        },
        async liveUserIds() {
            const rows = await tx.staffCredential.findMany({ where: { revokedAt: null }, select: { userId: true } })
            return new Set(rows.map((row) => row.userId))
        },
        async upsertVerifier({ userId, registryCreatedAt, verifier, actor, now }) {
            // The two payloads are written out field by field: nothing else,
            // and no nested relation, can reach the credential row.
            return tx.staffCredential.upsert({
                where: { userId },
                create: {
                    userId,
                    registryCreatedAt,
                    algo: verifier.algo,
                    scryptN: verifier.n,
                    scryptR: verifier.r,
                    scryptP: verifier.p,
                    maxmemBytes: verifier.maxmemBytes,
                    salt: verifier.salt,
                    hash: verifier.hash,
                    sessionEpoch: 0,
                    revokedAt: null,
                    updatedAt: now,
                    updatedBy: actor,
                },
                // Every new password ends every session issued before it.
                update: {
                    registryCreatedAt,
                    algo: verifier.algo,
                    scryptN: verifier.n,
                    scryptR: verifier.r,
                    scryptP: verifier.p,
                    maxmemBytes: verifier.maxmemBytes,
                    salt: verifier.salt,
                    hash: verifier.hash,
                    sessionEpoch: { increment: 1 },
                    revokedAt: null,
                    updatedAt: now,
                    updatedBy: actor,
                },
                select: STATUS_SELECT,
            })
        },
        async bumpEpoch(userId, actor, now) {
            const existing = await tx.staffCredential.findUnique({ where: { userId }, select: { userId: true } })
            if (existing === null) return null
            return tx.staffCredential.update({
                where: { userId },
                data: { sessionEpoch: { increment: 1 }, updatedAt: now, updatedBy: actor },
                select: STATUS_SELECT,
            })
        },
        async revoke(userId, actor, now) {
            const existing = await tx.staffCredential.findUnique({ where: { userId }, select: { revokedAt: true } })
            if (existing === null) return null
            return tx.staffCredential.update({
                where: { userId },
                data: {
                    revokedAt: existing.revokedAt ?? now,
                    sessionEpoch: { increment: 1 },
                    updatedAt: now,
                    updatedBy: actor,
                },
                select: STATUS_SELECT,
            })
        },
        async record({ userId, kind, actor, sid }) {
            await tx.staffCredentialEvent.create({ data: { userId, kind, actor, sid: sid ?? null }, select: { id: true } })
        },
    }
}

export const prismaStaffCredentialStoreV1 = {
    /** One indexed read of the status; throws when the store is unreadable (callers treat that as unverifiable). */
    async findStatus(userId: string, client: Client = prisma): Promise<StaffCredentialStatusV1 | null> {
        return client.staffCredential.findUnique({ where: { userId }, select: STATUS_SELECT })
    },

    /**
     * The status and the password verifier, for the password check only
     * (login and an employee's own password change). Never returned further.
     */
    async findVerifier(userId: string): Promise<{ status: StaffCredentialStatusV1, verifier: StaffPasswordVerifierV1 } | null> {
        const row = await prisma.staffCredential.findUnique({
            where: { userId },
            select: { ...STATUS_SELECT, algo: true, scryptN: true, scryptR: true, scryptP: true, maxmemBytes: true, salt: true, hash: true },
        })
        if (row === null) return null
        return {
            status: { userId: row.userId, registryCreatedAt: row.registryCreatedAt, sessionEpoch: row.sessionEpoch, revokedAt: row.revokedAt },
            verifier: {
                algo: row.algo as 'scrypt',
                n: row.scryptN,
                r: row.scryptR,
                p: row.scryptP,
                maxmemBytes: row.maxmemBytes,
                salt: Buffer.from(row.salt),
                hash: Buffer.from(row.hash),
            },
        }
    },

    /** Whether any row exists, live or revoked (C-D4a, I-1). Throws when unreadable. */
    async anyRow(client: Client = prisma): Promise<boolean> {
        const row = await client.staffCredential.findFirst({ select: { userId: true } })
        return row !== null
    },

    /** All credential states, for the Администратор view. Never verifier material. */
    async states(client: Client = prisma): Promise<Array<{ userId: string, revoked: boolean }>> {
        const rows = await client.staffCredential.findMany({ select: { userId: true, revokedAt: true } })
        return rows.map((row) => ({ userId: row.userId, revoked: row.revokedAt !== null }))
    },

    /** Append one audit event outside a credential change (login). */
    async record(event: { userId: string, kind: StaffCredentialEventKindV1, actor: string, sid?: string | null }): Promise<void> {
        await prisma.staffCredentialEvent.create({
            data: { userId: event.userId, kind: event.kind, actor: event.actor, sid: event.sid ?? null },
            select: { id: true },
        })
    },

    /** Run `work` in one serialized transaction under the staff-credential advisory lock. */
    async locked<T>(work: (view: StaffCredentialTransactionV1) => Promise<T>): Promise<T> {
        return prisma.$transaction(async (tx) => {
            await lock(tx)
            return work(transactionView(tx))
        }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 })
    },
}

export type StaffCredentialStoreV1 = typeof prismaStaffCredentialStoreV1
