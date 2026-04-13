/**
 * One-time backfill: populate contactId for existing tasks via Driver → Contact lookup.
 *
 * Logic:
 *   For each Task where contactId IS NULL and driverId IS NOT NULL:
 *     1. Find Driver by driverId → get yandexDriverId
 *     2. Find Contact by yandexDriverId
 *     3. If Contact found → update Task.contactId
 *
 * Usage: npx tsx scripts/backfill-contact-id.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
    const tasks = await prisma.task.findMany({
        where: { contactId: null },
        select: { id: true, driverId: true },
    })

    console.log(`Found ${tasks.length} tasks without contactId`)

    let updated = 0
    let noDriver = 0
    let noContact = 0

    for (const task of tasks) {
        const driver = await prisma.driver.findUnique({
            where: { id: task.driverId },
            select: { yandexDriverId: true },
        })

        if (!driver?.yandexDriverId) {
            noDriver++
            continue
        }

        const contact = await prisma.contact.findUnique({
            where: { yandexDriverId: driver.yandexDriverId },
            select: { id: true },
        })

        if (!contact) {
            noContact++
            continue
        }

        await prisma.task.update({
            where: { id: task.id },
            data: { contactId: contact.id },
        })
        updated++

        if (updated % 50 === 0) {
            console.log(`  ...updated ${updated}`)
        }
    }

    console.log(`Done. Updated: ${updated}, No driver yandexId: ${noDriver}, No contact: ${noContact}`)
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect())
