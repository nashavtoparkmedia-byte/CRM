/**
 * Isolated-PostgreSQL proof for the cash-order ingestion migration.
 *
 * The migration is expand-only: two optional columns on the catalogue and one
 * new progress table. What has to be established is that the columns are
 * optional and carry no foreign key or index, that the landed catalogue read
 * is unaffected, and that the progress table refuses the states the runtime
 * must never produce.
 *
 * Gated behind YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL.
 */

import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const proof = process.env.YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF === '1' ? describe : describe.skip

let database: PrismaClient

proof('cash-order ingestion migration on real PostgreSQL', () => {
    beforeAll(async () => {
        database = new PrismaClient()
        await database.$connect()
    })
    beforeEach(async () => {
        await database.$executeRawUnsafe(
            'TRUNCATE TABLE "CompensationCashOrder","CompensationCashOrderIngestionCheckpoint" RESTART IDENTITY CASCADE')
    })
    afterAll(async () => {
        await database.$executeRawUnsafe(
            'TRUNCATE TABLE "CompensationCashOrder","CompensationCashOrderIngestionCheckpoint" RESTART IDENTITY CASCADE')
        await database.$disconnect()
    })

    it('adds provenance and booking time to the catalogue as optional columns', async () => {
        const rows = await database.$queryRawUnsafe<Array<{ column_name: string; is_nullable: string; data_type: string }>>(
            `SELECT column_name, is_nullable, data_type FROM information_schema.columns
             WHERE table_name = 'CompensationCashOrder'
               AND column_name IN ('providerBookedAt', 'sourceConnectionId')
             ORDER BY column_name`,
        )
        expect(rows).toEqual([
            { column_name: 'providerBookedAt', is_nullable: 'YES', data_type: 'timestamp with time zone' },
            { column_name: 'sourceConnectionId', is_nullable: 'YES', data_type: 'text' },
        ])
    })

    it('gives the catalogue no foreign key, so a credential delete never reaches it', async () => {
        const rows = await database.$queryRawUnsafe<Array<{ constraint_name: string }>>(
            `SELECT constraint_name FROM information_schema.table_constraints
             WHERE table_name = 'CompensationCashOrder' AND constraint_type = 'FOREIGN KEY'`,
        )
        expect(rows).toEqual([])
    })

    it('keeps the provider identity key and indexes neither new column', async () => {
        const rows = await database.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(
            `SELECT indexname, indexdef FROM pg_indexes
             WHERE tablename = 'CompensationCashOrder' ORDER BY indexname`,
        )
        expect(rows.map((row) => row.indexname)).toEqual([
            'CompensationCashOrder_driver_month_idx',
            'CompensationCashOrder_pkey',
            'CompensationCashOrder_provider_identity_key',
        ])
        const identity = rows.find((row) => row.indexname === 'CompensationCashOrder_provider_identity_key')
        expect(identity?.indexdef).toContain('(provider, "externalParkId", "externalOrderId")')
        for (const row of rows) {
            expect(row.indexdef).not.toContain('providerBookedAt')
            expect(row.indexdef).not.toContain('sourceConnectionId')
        }
    })

    it('leaves a row written the landed way readable through the landed catalogue query', async () => {
        await database.$executeRawUnsafe(
            `INSERT INTO "CompensationCashOrder"
               ("id","provider","externalParkId","externalOrderId","shortOrderIdDisplay",
                "externalDriverProfileId","rawPrice","amountKopecks","endedAt","observedAt","createdAt","updatedAt")
             VALUES ('mig-landed','yandex_fleet','park-1','order-1','101','profile-1','335.0000',33500,
                     '2026-09-15T10:00:00.000Z','2026-09-15T10:05:00.000Z',NOW(),NOW())`,
        )
        const landed = await database.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT "id","provider","externalParkId","externalOrderId","shortOrderIdDisplay",
                    "externalDriverProfileId","rawPrice","amountKopecks","endedAt"
             FROM "CompensationCashOrder"
             WHERE "externalParkId" = $1 AND "externalDriverProfileId" = $2
             ORDER BY "endedAt" DESC`,
            'park-1', 'profile-1',
        )
        expect(landed).toHaveLength(1)
        expect(Object.keys(landed[0]).sort()).toEqual([
            'amountKopecks', 'endedAt', 'externalDriverProfileId', 'externalOrderId', 'externalParkId',
            'id', 'provider', 'rawPrice', 'shortOrderIdDisplay',
        ])
        const added = await database.$queryRawUnsafe<Array<{ sourceConnectionId: string | null; providerBookedAt: Date | null }>>(
            `SELECT "sourceConnectionId","providerBookedAt" FROM "CompensationCashOrder" WHERE "id" = 'mig-landed'`,
        )
        expect(added).toEqual([{ sourceConnectionId: null, providerBookedAt: null }])
    })

    it('creates the progress table with exactly the reviewed columns', async () => {
        const rows = await database.$queryRawUnsafe<Array<{ column_name: string; is_nullable: string }>>(
            `SELECT column_name, is_nullable FROM information_schema.columns
             WHERE table_name = 'CompensationCashOrderIngestionCheckpoint' ORDER BY column_name`,
        )
        expect(rows).toHaveLength(23)
        const required = rows.filter((row) => row.is_nullable === 'NO').map((row) => row.column_name)
        expect(required).toEqual(['consecutiveFailures', 'createdAt', 'externalParkId', 'id', 'provider', 'updatedAt'])
    })

    it('allows one progress row per provider park', async () => {
        await database.$executeRawUnsafe(
            `INSERT INTO "CompensationCashOrderIngestionCheckpoint" ("id","provider","externalParkId")
             VALUES ('mig-c1','yandex_fleet','park-1')`,
        )
        await expect(database.$executeRawUnsafe(
            `INSERT INTO "CompensationCashOrderIngestionCheckpoint" ("id","provider","externalParkId")
             VALUES ('mig-c2','yandex_fleet','park-1')`,
        )).rejects.toThrow()
        const rows = await database.$queryRawUnsafe<Array<{ consecutiveFailures: number; leaseToken: string | null }>>(
            `SELECT "consecutiveFailures","leaseToken" FROM "CompensationCashOrderIngestionCheckpoint" WHERE "id" = 'mig-c1'`,
        )
        expect(rows).toEqual([{ consecutiveFailures: 0, leaseToken: null }])
    })

    it('refuses a run mode or status the runtime never writes', async () => {
        await expect(database.$executeRawUnsafe(
            `INSERT INTO "CompensationCashOrderIngestionCheckpoint" ("id","provider","externalParkId","lastRunMode")
             VALUES ('mig-c3','yandex_fleet','park-3','off')`,
        )).rejects.toThrow()
        await expect(database.$executeRawUnsafe(
            `INSERT INTO "CompensationCashOrderIngestionCheckpoint" ("id","provider","externalParkId","lastRunStatus")
             VALUES ('mig-c4','yandex_fleet','park-4','skipped')`,
        )).rejects.toThrow()
    })

    it('refuses a negative failure count', async () => {
        await expect(database.$executeRawUnsafe(
            `INSERT INTO "CompensationCashOrderIngestionCheckpoint" ("id","provider","externalParkId","consecutiveFailures")
             VALUES ('mig-c5','yandex_fleet','park-5',-1)`,
        )).rejects.toThrow()
    })

    it('refuses a lease token without an expiry, and an expiry without a token', async () => {
        await expect(database.$executeRawUnsafe(
            `INSERT INTO "CompensationCashOrderIngestionCheckpoint" ("id","provider","externalParkId","leaseToken")
             VALUES ('mig-c6','yandex_fleet','park-6','token')`,
        )).rejects.toThrow()
        await expect(database.$executeRawUnsafe(
            `INSERT INTO "CompensationCashOrderIngestionCheckpoint" ("id","provider","externalParkId","leaseExpiresAt")
             VALUES ('mig-c7','yandex_fleet','park-7',NOW())`,
        )).rejects.toThrow()
    })
})
