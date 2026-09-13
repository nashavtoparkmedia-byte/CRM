/**
 * Prisma implementation of the Telegram identity repair port.
 *
 * The merge itself is delegated to the existing contact-to-contact merge, so
 * history remapping, identity de-duplication, the audit record and the archive
 * of the source all stay in one place rather than being re-implemented here.
 */

import { randomUUID } from 'node:crypto'

import { prisma } from '@/lib/prisma'

import { MERGE_CONTACTS_COMMAND_V1 } from '../../../../contracts/contacts/v1'
import type { TelegramIdentityRepairPortV1 } from '../../internal/telegram-identity-repair'
import { normalizePhoneE164 } from './phone-identity'

type MergeContacts = (command: unknown) => Promise<unknown>

/** Digits-only comparison, so stored formatting never hides an owner. */
function comparable(phone: string): string {
    const digits = phone.replace(/\D/g, '')
    return digits.slice(-10)
}

export function createLegacyPrismaTelegramIdentityRepairPortV1(
    mergeContactsV1: MergeContacts,
): TelegramIdentityRepairPortV1 {
    return {
        async runInTransaction(body) {
            // The merge takes its own ordered contact-pair lock inside, which is
            // what keeps concurrent repairs of one person from interleaving.
            return prisma.$transaction(async () => body(), { timeout: 30_000 })
        },

        normalizePhone(raw) {
            return normalizePhoneE164(raw)
        },

        async findTelegramIdentity(telegramUserId) {
            const identity = await prisma.contactIdentity.findFirst({
                where: { channel: 'telegram', externalId: telegramUserId },
                select: { id: true, contactId: true, isActive: true },
            })
            return identity
                ? { identityId: identity.id, contactId: identity.contactId, isActive: identity.isActive }
                : null
        },

        async findPhoneOwners(normalizedPhone) {
            const target = comparable(normalizedPhone)
            // Compared on digits rather than the stored string: the same line is
            // written both as +7… and 8… and those are one owner, not two.
            const rows = await prisma.$queryRawUnsafe<Array<{ contactId: string }>>(
                `SELECT DISTINCT cp."contactId"
                 FROM "ContactPhone" cp
                 JOIN "Contact" c ON c."id" = cp."contactId"
                 WHERE right(regexp_replace(cp."phone", '[^0-9]', '', 'g'), 10) = $1
                   AND cp."isActive" = true
                   AND c."isArchived" = false`,
                target,
            )
            return rows.map((row) => row.contactId)
        },

        async isContactBare(contactId) {
            const contact = await prisma.contact.findUnique({
                where: { id: contactId },
                select: {
                    yandexDriverId: true,
                    mainDriverId: true,
                    _count: { select: { phones: true, driverProfiles: true } },
                },
            })
            if (!contact) return false
            return contact.yandexDriverId === null
                && contact.mainDriverId === null
                && contact._count.phones === 0
                && contact._count.driverProfiles === 0
        },

        async attachPhoneToContact({ contactId, normalizedPhone, attestedAt }) {
            // Unique on (contactId, phone), so a replayed share is a no-op
            // rather than a second row for the same line.
            await prisma.contactPhone.upsert({
                where: { contactId_phone: { contactId, phone: normalizedPhone } },
                update: { isActive: true, verifiedAt: attestedAt },
                create: {
                    contactId,
                    phone: normalizedPhone,
                    source: 'telegram',
                    isActive: true,
                    verifiedAt: attestedAt,
                },
            })
        },

        async attachTelegramIdentityToContact({ contactId, telegramUserId }) {
            // Unique on (channel, externalId): one Telegram account cannot end
            // up owned by two contacts even under a concurrent replay.
            await prisma.contactIdentity.upsert({
                where: { channel_externalId: { channel: 'telegram', externalId: telegramUserId } },
                update: { contactId, isActive: true },
                create: {
                    contactId,
                    channel: 'telegram',
                    externalId: telegramUserId,
                    source: 'auto',
                    isActive: true,
                },
            })
        },

        async mergeContactIntoContact({ sourceContactId, survivorContactId, mergedBy }) {
            await mergeContactsV1({
                contract: MERGE_CONTACTS_COMMAND_V1,
                operation: 'contact_to_contact',
                sourceId: sourceContactId,
                targetId: survivorContactId,
                mergedBy,
            })
        },

        async recordManualReview(input) {
            // Same account, same reason, same moment is the same observation.
            await prisma.telegramIdentityReview.upsert({
                where: {
                    telegramUserId_reason_observedAt: {
                        telegramUserId: input.telegramUserId,
                        reason: input.reason,
                        observedAt: input.observedAt,
                    },
                },
                update: {},
                create: {
                    id: randomUUID(),
                    telegramUserId: input.telegramUserId,
                    normalizedPhone: input.normalizedPhone,
                    reason: input.reason,
                    identityContactId: input.identityContactId,
                    candidateContactIds: [...input.candidateContactIds],
                    observedAt: input.observedAt,
                },
            })
        },
    }
}
