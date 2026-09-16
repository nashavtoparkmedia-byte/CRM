/**
 * Isolated-PostgreSQL proof for the pilot migrations.
 *
 * Each migration is expand-only, so what has to be established is narrow: the
 * objects exist, the constraints actually refuse the data they are there to
 * refuse, and nothing pre-existing was rewritten. These are money-adjacent
 * invariants, which is why they live in the database rather than only in the
 * code that writes it.
 *
 * Gated behind YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL.
 */

import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const proof = process.env.YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF === '1' ? describe : describe.skip

let database: PrismaClient

async function columns(table: string, names: string[]): Promise<string[]> {
    const rows = await database.$queryRawUnsafe<Array<{ column_name: string; is_nullable: string }>>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = $1 AND column_name = ANY($2::text[]) ORDER BY column_name`,
        table, names,
    )
    // Expand-only means every added column must be optional; a NOT NULL column
    // would fail on a table that already has rows.
    for (const row of rows) expect(row.is_nullable).toBe('YES')
    return rows.map((row) => row.column_name)
}

proof('pilot migrations on real PostgreSQL', () => {
    beforeAll(async () => {
        database = new PrismaClient()
        await database.$connect()
    })
    // The constraint proofs insert fixed ids, so a previous run's rows would
    // make a uniqueness proof pass for the wrong reason.
    beforeEach(async () => {
        await database.$executeRawUnsafe(
            'TRUNCATE TABLE "CompensationCashOrder","CompensationPilotSubmission" RESTART IDENTITY CASCADE')
    })
    afterAll(async () => {
        await database.$executeRawUnsafe(
            'TRUNCATE TABLE "CompensationCashOrder","CompensationPilotSubmission" RESTART IDENTITY CASCADE')
        await database.$disconnect()
    })

    it('adds the driver eligibility columns as optional', async () => {
        expect(await columns('Driver', ['employmentType', 'isSelfEmployed', 'yandexHireDate']))
            .toEqual(['employmentType', 'isSelfEmployed', 'yandexHireDate'])
    })

    it('indexes the hire date the eligibility window reads', async () => {
        const rows = await database.$queryRawUnsafe<Array<{ indexname: string }>>(
            `SELECT indexname FROM pg_indexes WHERE tablename = 'Driver' AND indexname = 'Driver_yandexHireDate_idx'`)
        expect(rows).toHaveLength(1)
    })

    it('refuses a cash-order price the monetary parser could not read', async () => {
        await expect(database.$executeRawUnsafe(
            `INSERT INTO "CompensationCashOrder"
               ("id","provider","externalParkId","externalOrderId","externalDriverProfileId",
                "rawPrice","amountKopecks","endedAt","observedAt","createdAt","updatedAt")
             VALUES ('mig-o1','yandex_fleet','p','o','d','335.00',33500,NOW(),NOW(),NOW(),NOW())`,
        )).rejects.toThrow()
    })

    it('refuses a negative cash-order amount', async () => {
        await expect(database.$executeRawUnsafe(
            `INSERT INTO "CompensationCashOrder"
               ("id","provider","externalParkId","externalOrderId","externalDriverProfileId",
                "rawPrice","amountKopecks","endedAt","observedAt","createdAt","updatedAt")
             VALUES ('mig-o2','yandex_fleet','p','o2','d','335.0000',-1,NOW(),NOW(),NOW(),NOW())`,
        )).rejects.toThrow()
    })

    it('refuses a pilot claim outside the thousand-rouble cap', async () => {
        for (const claim of [0, 1001]) {
            await expect(database.$executeRawUnsafe(
                `INSERT INTO "CompensationPilotSubmission"
                   ("id","applicationId","telegramUserId","supportContactedAt","attachmentFileId",
                    "attachmentKind","claimedRubles","createdAt")
                 VALUES ($1,$2,'9005',NOW(),'f','photo',$3,NOW())`,
                `mig-p${claim}`, `app-${claim}`, claim,
            )).rejects.toThrow()
        }
    })

    it('refuses pilot evidence with no attachment', async () => {
        await expect(database.$executeRawUnsafe(
            `INSERT INTO "CompensationPilotSubmission"
               ("id","applicationId","telegramUserId","supportContactedAt","attachmentFileId",
                "attachmentKind","claimedRubles","createdAt")
             VALUES ('mig-p3','app-3','9006',NOW(),'','photo',300,NOW())`,
        )).rejects.toThrow()
    })
})
