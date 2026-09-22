/**
 * Isolated-PostgreSQL proof for the M2A1-S3 company-account writer.
 *
 * Gated behind YOKO_WHATSAPP_ACCOUNT_CONFIRMATION_POSTGRES_PROOF=1 and an
 * isolated DATABASE_URL. It never touches a production database.
 *
 * The in-memory writer tests prove the decision logic; this proof runs the same
 * writer against the real guards, so the statements it issues are shown to be
 * accepted — or refused — by the database that will enforce them in production.
 */
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
    confirmWhatsAppAccountBindingV1,
    readSlotConfirmationProjectionV1,
    recordWhatsAppAccountAttestationV1,
    WhatsAppAccountRefusalV1,
} from './whatsapp-account-writer'

const proof = process.env.YOKO_WHATSAPP_ACCOUNT_CONFIRMATION_POSTGRES_PROOF === '1' ? describe : describe.skip

const PRINCIPAL = 'identity-access:integration-admin-session'
const db = new PrismaClient()

let counter = 0
function freshPair() {
    counter += 1
    const suffix = String(counter).padStart(4, '0')
    return { pnUser: `7999000${suffix}`, lidUser: `1288776655${suffix}` }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function openBindingRow(connectionId: string) {
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        'SELECT * FROM "WhatsAppTransportBinding" WHERE "transportRef" = $1 AND "closedAt" IS NULL',
        connectionId,
    )
    return rows[0] ?? null
}

async function allBindingRows(connectionId: string) {
    return await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        'SELECT * FROM "WhatsAppTransportBinding" WHERE "transportRef" = $1 ORDER BY "bindingSeq"',
        connectionId,
    )
}

async function accountRow(accountId: string) {
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        'SELECT * FROM "WhatsAppAccount" WHERE "accountId" = $1', accountId,
    )
    return rows[0] ?? null
}

/** Seeds an account with a complete key set, the way the database demands: one transaction. */
async function seedAccount(pair: { pnUser: string; lidUser: string }) {
    const accountId = randomUUID()
    await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
            `INSERT INTO "WhatsAppAccount" ("accountId","accountKind","lifecycle","lifecycleVersion","lifecycleChangedBy","lifecycleReason")
             VALUES ($1,'whatsapp_user','pending_approval',1,'proof','seed')`, accountId,
        )
        await tx.$executeRawUnsafe(
            `INSERT INTO "WhatsAppAccountKey" ("keyKind","keyValue","accountId") VALUES ('whatsapp_pn_user',$1,$2)`, pair.pnUser, accountId,
        )
        await tx.$executeRawUnsafe(
            `INSERT INTO "WhatsAppAccountKey" ("keyKind","keyValue","accountId") VALUES ('whatsapp_lid_user',$1,$2)`, pair.lidUser, accountId,
        )
    })
    return accountId
}

/** Opens a pending binding with a deliberately short attestation window. */
async function seedShortWindowBinding(connectionId: string, accountId: string, pair: { pnUser: string; lidUser: string }, seconds: number) {
    const bindingId = randomUUID()
    await db.$executeRawUnsafe(
        `INSERT INTO "WhatsAppTransportBinding"
           ("bindingId","transportKind","transportRef","transportGeneration","accountId","bindingSeq","trustState",
            "attestationOrigin","attestedPnValue","attestedLidValue","claimedPnValue","claimedLidValue",
            "attestingInstanceId","attestedUntil")
         VALUES ($1,'whatsapp_web_slot',$2,1,$3,1,'pending','transport_asserted',$4,$5,$4,$5,'proof-instance', now() + ($6 || ' seconds')::interval)`,
        bindingId, connectionId, accountId, pair.pnUser, pair.lidUser, String(seconds),
    )
    return bindingId
}

proof('company-account writer against the real guards', () => {
    beforeAll(async () => {
        await db.$connect()
    })

    afterAll(async () => {
        await db.$disconnect()
    })

    it('first coherent READY creates the account, its complete key set and a pending generation', async () => {
        const connectionId = `conn-${randomUUID()}`
        const pair = freshPair()
        const result = await recordWhatsAppAccountAttestationV1({ connectionId, instanceId: 'instance-1', ...pair, unchanged: null })
        expect(result).toMatchObject({ action: 'open_first_generation', accountLifecycle: 'pending_approval', generation: 1 })

        const binding = await openBindingRow(connectionId)
        expect(binding).toMatchObject({ trustState: 'pending', attestationOrigin: 'transport_asserted', bindingSeq: 1 })
        expect(binding?.attestedPnValue).toBe(pair.pnUser)
        expect(binding?.claimedLidValue).toBe(pair.lidUser)
        // The database stamps its own clock and leaves the confirmation empty.
        expect(binding?.openedAt).toBeInstanceOf(Date)
        expect(binding?.lastAttestedAt).toBeInstanceOf(Date)
        expect(binding?.operatorConfirmedAt).toBeNull()

        const account = await accountRow(binding?.accountId as string)
        expect(account).toMatchObject({ lifecycle: 'pending_approval', lifecycleVersion: 1 })
    })

    it('duplicate READY inside a live window writes nothing', async () => {
        const connectionId = `conn-${randomUUID()}`
        const pair = freshPair()
        await recordWhatsAppAccountAttestationV1({ connectionId, instanceId: 'instance-1', ...pair, unchanged: null })
        const before = await openBindingRow(connectionId)
        const result = await recordWhatsAppAccountAttestationV1({ connectionId, instanceId: 'instance-1', ...pair, unchanged: true })
        expect(result.outcome).toBe('attestation_still_fresh')
        const after = await openBindingRow(connectionId)
        expect(after?.attestedUntil).toEqual(before?.attestedUntil)
        expect(await allBindingRows(connectionId)).toHaveLength(1)
    })

    it('the same pair after a restart re-attests the open generation, with the signal null', async () => {
        const connectionId = `conn-${randomUUID()}`
        const pair = freshPair()
        const accountId = await seedAccount(pair)
        await seedShortWindowBinding(connectionId, accountId, pair, 900)
        const before = await openBindingRow(connectionId)

        const result = await recordWhatsAppAccountAttestationV1({ connectionId, instanceId: 'instance-after-restart', ...pair, unchanged: null })
        expect(result).toMatchObject({ action: 'reattest_open_generation', outcome: 'reattested' })

        const after = await openBindingRow(connectionId)
        expect(await allBindingRows(connectionId)).toHaveLength(1)
        expect(after?.bindingId).toBe(before?.bindingId)
        expect(after?.attestingInstanceId).toBe('instance-after-restart')
        expect((after?.attestedUntil as Date).getTime()).toBeGreaterThan((before?.attestedUntil as Date).getTime())
    })

    it('an expired pending generation is superseded, because the database refuses to revive it', async () => {
        const connectionId = `conn-${randomUUID()}`
        const pair = freshPair()
        const accountId = await seedAccount(pair)
        const expiring = await seedShortWindowBinding(connectionId, accountId, pair, 1)
        await sleep(1500)

        const result = await recordWhatsAppAccountAttestationV1({ connectionId, instanceId: 'instance-2', ...pair, unchanged: true })
        expect(result).toMatchObject({ action: 'supersede_expired_generation', generation: 2 })

        const rows = await allBindingRows(connectionId)
        expect(rows).toHaveLength(2)
        expect(rows[0]).toMatchObject({ bindingId: expiring, trustState: 'closed', closeReason: 'superseded' })
        expect(rows[0].closedAt).toBeInstanceOf(Date)
        expect(rows[1]).toMatchObject({ trustState: 'pending', bindingSeq: 2 })
        expect(Number(rows[1].transportGeneration)).toBe(2)
    })

    it('a re-pair mismatches the previous generation and opens the next one', async () => {
        const connectionId = `conn-${randomUUID()}`
        const first = freshPair()
        const second = freshPair()
        await recordWhatsAppAccountAttestationV1({ connectionId, instanceId: 'instance-1', ...first, unchanged: null })
        const result = await recordWhatsAppAccountAttestationV1({ connectionId, instanceId: 'instance-2', ...second, unchanged: false })
        expect(result).toMatchObject({ action: 'replace_mismatched_generation', generation: 2 })

        const rows = await allBindingRows(connectionId)
        expect(rows[0]).toMatchObject({ trustState: 'mismatched', closeReason: 'account_changed' })
        expect(rows[1].accountId).not.toBe(rows[0].accountId)
        expect(rows[1].attestedPnValue).toBe(second.pnUser)
    })

    it('refuses a split key set and leaves the foundation untouched', async () => {
        const connectionId = `conn-${randomUUID()}`
        const mine = freshPair()
        const other = freshPair()
        await seedAccount(mine)
        await seedAccount(other)
        await expect(recordWhatsAppAccountAttestationV1({
            connectionId, instanceId: 'instance-1', pnUser: mine.pnUser, lidUser: other.lidUser, unchanged: null,
        })).rejects.toBeInstanceOf(WhatsAppAccountRefusalV1)
        expect(await allBindingRows(connectionId)).toHaveLength(0)
    })

    it('confirmation promotes the account and the binding together, stamped by the database', async () => {
        const connectionId = `conn-${randomUUID()}`
        const pair = freshPair()
        await recordWhatsAppAccountAttestationV1({ connectionId, instanceId: 'instance-1', ...pair, unchanged: null })
        const binding = await openBindingRow(connectionId)

        const result = await confirmWhatsAppAccountBindingV1({ connectionId, bindingId: binding?.bindingId as string, principalId: PRINCIPAL })
        expect(result).toMatchObject({ outcome: 'confirmed', trustStateAfter: 'verified', accountLifecycle: 'active' })

        const after = await openBindingRow(connectionId)
        expect(after).toMatchObject({ trustState: 'verified', operatorConfirmedBy: PRINCIPAL })
        expect(after?.operatorConfirmedAt).toBeInstanceOf(Date)
        const account = await accountRow(after?.accountId as string)
        expect(account).toMatchObject({ lifecycle: 'active', lifecycleVersion: 2, lifecycleChangedBy: PRINCIPAL })
    })

    it('a duplicate confirmation changes nothing, because the database makes it write-once', async () => {
        const connectionId = `conn-${randomUUID()}`
        const pair = freshPair()
        await recordWhatsAppAccountAttestationV1({ connectionId, instanceId: 'instance-1', ...pair, unchanged: null })
        const bindingId = (await openBindingRow(connectionId))?.bindingId as string
        await confirmWhatsAppAccountBindingV1({ connectionId, bindingId, principalId: PRINCIPAL })
        const stamped = (await openBindingRow(connectionId))?.operatorConfirmedAt

        const again = await confirmWhatsAppAccountBindingV1({ connectionId, bindingId, principalId: 'identity-access:someone-else' })
        expect(again.outcome).toBe('already_confirmed')
        const after = await openBindingRow(connectionId)
        expect(after?.operatorConfirmedAt).toEqual(stamped)
        expect(after?.operatorConfirmedBy).toBe(PRINCIPAL)
    })

    it('refuses a confirmation whose attestation is stale by database time', async () => {
        const connectionId = `conn-${randomUUID()}`
        const pair = freshPair()
        const accountId = await seedAccount(pair)
        const bindingId = await seedShortWindowBinding(connectionId, accountId, pair, 1)
        await sleep(1500)

        const result = await confirmWhatsAppAccountBindingV1({ connectionId, bindingId, principalId: PRINCIPAL })
        expect(result.outcome).toBe('attestation_stale')
        const after = await openBindingRow(connectionId)
        expect(after?.trustState).toBe('pending')
        expect(after?.operatorConfirmedAt).toBeNull()
        expect(await accountRow(accountId)).toMatchObject({ lifecycle: 'pending_approval' })
    })

    it('refuses a binding that belongs to another slot', async () => {
        const mineConnection = `conn-${randomUUID()}`
        const otherConnection = `conn-${randomUUID()}`
        const pair = freshPair()
        await recordWhatsAppAccountAttestationV1({ connectionId: mineConnection, instanceId: 'instance-1', ...pair, unchanged: null })
        const bindingId = (await openBindingRow(mineConnection))?.bindingId as string

        const result = await confirmWhatsAppAccountBindingV1({ connectionId: otherConnection, bindingId, principalId: PRINCIPAL })
        expect(result.outcome).toBe('transport_mismatch')
        expect((await openBindingRow(mineConnection))?.operatorConfirmedAt).toBeNull()
    })

    it('two concurrent first READY observations leave exactly one open binding', async () => {
        const connectionId = `conn-${randomUUID()}`
        const pair = freshPair()
        const settled = await Promise.allSettled([
            recordWhatsAppAccountAttestationV1({ connectionId, instanceId: 'instance-a', ...pair, unchanged: null }),
            recordWhatsAppAccountAttestationV1({ connectionId, instanceId: 'instance-b', ...pair, unchanged: null }),
        ])
        expect(settled.some((outcome) => outcome.status === 'fulfilled')).toBe(true)
        const rows = await allBindingRows(connectionId)
        expect(rows.filter((row) => row.closedAt === null)).toHaveLength(1)
        expect(rows).toHaveLength(1)
    })

    it('the projection carries a display PN and never a LID', async () => {
        const connectionId = `conn-${randomUUID()}`
        const pair = freshPair()
        await recordWhatsAppAccountAttestationV1({ connectionId, instanceId: 'instance-1', ...pair, unchanged: null })
        const projection = await readSlotConfirmationProjectionV1(connectionId)
        expect(projection).toMatchObject({ trustState: 'pending', accountLifecycle: 'pending_approval', confirmable: true })
        const serialized = JSON.stringify(projection)
        expect(serialized).not.toContain(pair.lidUser)
        expect(serialized).not.toContain(pair.pnUser)
        expect(projection.pnDisplay).toContain('+')
    })
})
