/**
 * The published driver-link read against real PostgreSQL.
 *
 * The unit test proves the handler projects two fields. What only a real
 * database can prove is that the adapter never *selects* more than that: a
 * projection applied after a `SELECT *` would look identical from the outside
 * while still carrying the Telegram identity out of the owner's process. So the
 * row here is seeded with every sensitive column populated, and the result is
 * checked to contain none of them.
 *
 * Gated behind YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF=1 and an isolated
 * DATABASE_URL, the same gate the compensation proofs use.
 */

import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
    READ_DRIVER_TELEGRAM_PARK_LINKS_MAX_DRIVER_IDS_V1,
    READ_DRIVER_TELEGRAM_PARK_LINKS_QUERY_V1,
} from '../../../../contracts/telegram-channel/v1'
import { createReadDriverTelegramParkLinksHandlerV1 } from './driver-telegram-park-link-handler'
import { legacyPrismaDriverTelegramParkLinkReadPortV1 } from './legacy-prisma-driver-telegram-adapter'

const proof = process.env.YOKO_COMPENSATION_MONETARY_POSTGRES_PROOF === '1' ? describe : describe.skip

const PARK = 'ext-park-link-proof'
const LINKED = 'tg-link-proof-driver-1'
const NO_PARK = 'tg-link-proof-driver-2'
const UNLINKED = 'tg-link-proof-driver-3'
const TELEGRAM_ID = 770000000001n
const USERNAME = 'link-proof-username'
const SUBMITTED_PHONE = '+70000000001'

let database: PrismaClient

const read = () => createReadDriverTelegramParkLinksHandlerV1(legacyPrismaDriverTelegramParkLinkReadPortV1)

async function seedDriver(driverId: string): Promise<void> {
    await database.$executeRawUnsafe(
        `INSERT INTO "Driver" ("id","yandexDriverId","fullName","updatedAt")
         VALUES ($1,$2,'Link Proof Driver',NOW())`,
        driverId, `park-profile:${driverId}`,
    )
}

/** Every column that must not cross the boundary is populated on purpose. */
async function seedLink(driverId: string, telegramId: bigint, activeParkId: string | null): Promise<void> {
    await database.$executeRawUnsafe(
        `INSERT INTO "DriverTelegram"
           ("id","driverId","telegramId","username","phoneVerified","botState","carId","carLabel",
            "activeParkId","submittedPhone","submittedPhoneAt","createdAt")
         VALUES ($1,$2,$3,$4,true,'AWAITING_PHONE','car-link-proof','A123BC',$5,$6,NOW(),NOW())`,
        `link-${driverId}`, driverId, telegramId, USERNAME, activeParkId, SUBMITTED_PHONE,
    )
}

async function clear(): Promise<void> {
    await database.$executeRawUnsafe(`DELETE FROM "DriverTelegram" WHERE "driverId" LIKE 'tg-link-proof-%'`)
    await database.$executeRawUnsafe(`DELETE FROM "Driver" WHERE "id" LIKE 'tg-link-proof-%'`)
}

proof('the published driver Telegram park-link read on real PostgreSQL', () => {
    beforeAll(async () => {
        database = new PrismaClient()
        await database.$connect()
    })
    afterAll(async () => {
        await clear()
        await database.$disconnect()
    })
    beforeEach(async () => {
        await clear()
        for (const driverId of [LINKED, NO_PARK, UNLINKED]) await seedDriver(driverId)
        await seedLink(LINKED, TELEGRAM_ID, PARK)
        await seedLink(NO_PARK, TELEGRAM_ID + 1n, null)
    })

    it('returns the park for a linked driver and carries nothing else out of the owner', async () => {
        const result = await read()({
            contract: READ_DRIVER_TELEGRAM_PARK_LINKS_QUERY_V1,
            driverIds: [LINKED],
        })
        expect(result.links).toEqual([{ driverId: LINKED, activeParkId: PARK }])
        const serialized = JSON.stringify(result, (_key, value) =>
            typeof value === 'bigint' ? value.toString() : value)
        for (const forbidden of [
            TELEGRAM_ID.toString(), USERNAME, SUBMITTED_PHONE,
            'AWAITING_PHONE', 'car-link-proof', 'A123BC', 'phoneVerified',
        ]) {
            expect(serialized).not.toContain(forbidden)
        }
    })

    it('distinguishes a link with no park from a driver with no link at all', async () => {
        const result = await read()({
            contract: READ_DRIVER_TELEGRAM_PARK_LINKS_QUERY_V1,
            driverIds: [LINKED, NO_PARK, UNLINKED],
        })
        expect([...result.links].sort((a, b) => a.driverId.localeCompare(b.driverId))).toEqual([
            { driverId: LINKED, activeParkId: PARK },
            { driverId: NO_PARK, activeParkId: null },
        ])
    })

    it('never returns a driver the caller did not name', async () => {
        const result = await read()({
            contract: READ_DRIVER_TELEGRAM_PARK_LINKS_QUERY_V1,
            driverIds: [UNLINKED],
        })
        expect(result.links).toEqual([])
    })

    it('reads nothing at all, and writes nothing', async () => {
        const digest = async () => {
            const rows = await database.$queryRawUnsafe<Array<{ digest: string | null }>>(
                `SELECT md5(string_agg(t.line, E'\\n' ORDER BY t.line)) AS digest
                 FROM (SELECT "DriverTelegram"::text AS line FROM "DriverTelegram") t`,
            )
            return rows[0].digest
        }
        const before = await digest()
        await read()({
            contract: READ_DRIVER_TELEGRAM_PARK_LINKS_QUERY_V1,
            driverIds: [LINKED, NO_PARK, UNLINKED],
        })
        expect(await digest()).toBe(before)
    })

    it('answers a request at the full cap without widening it', async () => {
        const padded = [
            LINKED,
            ...Array.from(
                { length: READ_DRIVER_TELEGRAM_PARK_LINKS_MAX_DRIVER_IDS_V1 - 1 },
                (_, index) => `tg-link-proof-absent-${index}`,
            ),
        ]
        const result = await read()({
            contract: READ_DRIVER_TELEGRAM_PARK_LINKS_QUERY_V1,
            driverIds: padded,
        })
        expect(result.links).toEqual([{ driverId: LINKED, activeParkId: PARK }])
    })
})
