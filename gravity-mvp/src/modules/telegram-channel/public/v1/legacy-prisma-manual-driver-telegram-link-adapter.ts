import { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'
import {
    CONTACT_OWNERSHIP_ADVISORY_CLASS_ID_V1,
    CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID_V1,
} from '@/modules/contacts/public/v1/contact-ownership-lock-contract'

import type { ManualDriverTelegramLinkPersistencePortV1 } from './manual-driver-telegram-link-handler'
import {
    prepareManualDriverTelegramLinkAuthorityV1,
    revalidatePreparedManualDriverTelegramLinkAuthorityV1,
} from './manual-driver-telegram-link-authority'

export class ManualDriverTelegramLinkContradictionError extends Error {
    readonly code = 'DRIVER_TELEGRAM_LINK_CONTRADICTION'

    constructor() {
        super('The Driver or Telegram peer already has a different link')
        this.name = 'ManualDriverTelegramLinkContradictionError'
    }
}

function notFoundError(): Error & { code: 'P2025' } {
    return Object.assign(new Error('DriverTelegram link not found'), { code: 'P2025' as const })
}

export const legacyPrismaManualDriverTelegramLinkPortV1: ManualDriverTelegramLinkPersistencePortV1 = {
    async save(input) {
        const prepared = await prepareManualDriverTelegramLinkAuthorityV1(input)

        await prisma.$transaction(async transaction => {
            // This must be the first transaction statement. Contacts person
            // authority and Messaging's Contact/Chat binding changes share
            // CNT1, so the re-read below remains valid through the mapping
            // write and commit.
            await transaction.$queryRaw(Prisma.sql`
                WITH "manual_driver_telegram_lock_policy" AS MATERIALIZED (
                    SELECT set_config('lock_timeout', '2000ms', true) AS configured
                )
                SELECT (
                    pg_advisory_xact_lock(
                        CAST(${CONTACT_OWNERSHIP_ADVISORY_CLASS_ID_V1} AS integer)
                            + octet_length(configured) * 0,
                        CAST(${CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID_V1} AS integer)
                    ) IS NULL
                ) AS admitted
                FROM "manual_driver_telegram_lock_policy"
            `)
            // CNT1 serializes compliant Contacts/Messaging ownership writers.
            // Exact row locks also make legacy direct writers fail or wait;
            // none can change the proof between revalidation and commit.
            await transaction.$queryRaw(Prisma.sql`
                SELECT id FROM "Contact"
                WHERE id = ${prepared.contactId}
                FOR UPDATE
            `)
            await transaction.$queryRaw(Prisma.sql`
                SELECT id FROM "ContactIdentity"
                WHERE id = ${prepared.contactIdentityId}
                FOR UPDATE
            `)
            await transaction.$queryRaw(Prisma.sql`
                SELECT id FROM "Chat"
                WHERE id = ${prepared.chatId}
                FOR UPDATE
            `)
            await revalidatePreparedManualDriverTelegramLinkAuthorityV1(
                transaction,
                input,
                prepared,
            )

            const byDriver = await transaction.driverTelegram.findUnique({
                where: { driverId: input.driverId },
                select: { driverId: true, telegramId: true },
            })
            const byTelegram = await transaction.driverTelegram.findUnique({
                where: { telegramId: input.telegramId },
                select: { driverId: true, telegramId: true },
            })

            if (byDriver || byTelegram) {
                if (
                    byDriver?.driverId === input.driverId
                    && byDriver.telegramId === input.telegramId
                    && byTelegram?.driverId === input.driverId
                    && byTelegram.telegramId === input.telegramId
                ) return
                throw new ManualDriverTelegramLinkContradictionError()
            }

            // `phoneVerified` deliberately keeps its schema default. An
            // operator-selected Driver is not evidence that any phone belongs
            // to this Telegram identity.
            await transaction.driverTelegram.create({
                data: { driverId: input.driverId, telegramId: input.telegramId },
            })
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            maxWait: 2_000,
            timeout: 10_000,
        })
    },
    async remove(driverId) {
        const existing = await prisma.driverTelegram.findUnique({
            where: { driverId },
            select: { driverId: true, telegramId: true },
        })
        if (!existing) throw notFoundError()

        await prepareManualDriverTelegramLinkAuthorityV1(existing)
        const removed = await prisma.driverTelegram.deleteMany({
            where: {
                driverId: existing.driverId,
                telegramId: existing.telegramId,
            },
        })
        if (removed.count !== 1) throw notFoundError()
    },
}
