import { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'
import {
    CONTACT_OWNERSHIP_ADVISORY_CLASS_ID_V1,
    CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID_V1,
} from '@/modules/contacts/public/v1/contact-ownership-lock-contract'

import type { MatchedDriverConversationLinkPersistencePortV1 } from './link-matched-driver-to-conversation-handler'

function hasConfirmedRepresentativeDriver(customFields: unknown, driverId: string): boolean {
    if (!customFields || typeof customFields !== 'object' || Array.isArray(customFields)) return false
    const confirmations = (customFields as Record<string, unknown>).driverConfirmations
    if (!Array.isArray(confirmations)) return false
    return confirmations.some(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false
        const confirmation = item as Record<string, unknown>
        return confirmation.status === 'confirmed'
            && confirmation.representativeDriverId === driverId
    })
}

export const legacyPrismaMatchedDriverConversationLinkPortV1: MatchedDriverConversationLinkPersistencePortV1 = {
    async linkMatchedDriverToConversation({ chatId, driverId }) {
        let linked = false
        await prisma.$transaction(async transaction => {
            // Contact ownership and Chat association changes share CNT1. Holding it
            // from the first statement keeps canonical confirmation stable through
            // the owner-side Chat mutation.
            await transaction.$queryRaw(Prisma.sql`
                WITH "matched_driver_link_lock_policy" AS MATERIALIZED (
                    SELECT set_config('lock_timeout', '2000ms', true) AS configured
                )
                SELECT (
                    pg_advisory_xact_lock(
                        CAST(${CONTACT_OWNERSHIP_ADVISORY_CLASS_ID_V1} AS integer)
                            + octet_length(configured) * 0,
                        CAST(${CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID_V1} AS integer)
                    ) IS NULL
                ) AS admitted
                FROM "matched_driver_link_lock_policy"
            `)

            const chat = await transaction.chat.findUnique({
                where: { id: chatId },
                select: { contactId: true, driverId: true },
            })
            if (!chat) return

            // Never overwrite a different association, and never promote a
            // provider-specific Driver match into person truth without a
            // Contact-owned canonical confirmation.
            if (chat.driverId !== null && chat.driverId !== driverId) return
            if (chat.contactId === null) return
            const contact = await transaction.contact.findUnique({
                where: { id: chat.contactId },
                select: {
                    id: true,
                    isArchived: true,
                    mainDriverId: true,
                    customFields: true,
                },
            })
            if (
                !contact
                || contact.isArchived
                || contact.mainDriverId !== driverId
                || !hasConfirmedRepresentativeDriver(contact.customFields, driverId)
            ) return
            if (chat.driverId === driverId) {
                linked = true
                return
            }

            // Include the observed Contact binding as well as the null Driver
            // predicate. A concurrent legacy Contact relink therefore fails closed
            // even if it does not yet participate in CNT1.
            const updated = await transaction.chat.updateMany({
                where: { id: chatId, contactId: chat.contactId, driverId: null },
                data: { driverId },
            })
            if (updated.count === 1) {
                linked = true
                return
            }

            const existing = await transaction.chat.findUnique({
                where: { id: chatId },
                select: { contactId: true, driverId: true },
            })
            linked = existing?.contactId === chat.contactId
                && existing.driverId === driverId
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            maxWait: 2_000,
            timeout: 10_000,
        })
        return linked
    },
}
