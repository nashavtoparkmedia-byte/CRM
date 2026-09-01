import { ContactService } from '@/lib/ContactService'
import { isSafeContactResolutionSuccess } from '@/lib/contacts/SafeContactResolutionExecutor'
import { prisma } from '@/lib/prisma'
import {
    lockContactOwnershipRows,
    runContactOwnershipTransaction,
} from '@/modules/contacts/internal/contact-ownership-coordinator'
import type { ContactConversationPersistencePortV1 } from './contact-conversation-handler'

export const legacyPrismaContactConversationPortV1: ContactConversationPersistencePortV1 = {
    async resolveChannelContact(input) {
        const resolved = await ContactService.resolveContact(
            input.channel,
            input.externalId,
            input.phone,
            input.displayName,
        )
        if (!isSafeContactResolutionSuccess(resolved) || !resolved.identity) {
            throw new Error(`CONTACT_RESOLUTION_BLOCKED:${resolved.status}`)
        }
        return {
            contact: resolved.contact,
            identity: {
                id: resolved.identity.id,
                channel: input.channel,
                externalId: resolved.identity.externalId,
            },
            isNew: resolved.isNew,
        }
    },

    async prepareContactConversationIdentity(input) {
        return runContactOwnershipTransaction(async transaction => {
            const scope = await lockContactOwnershipRows(transaction, {
                contactIds: [input.contactId],
                identityIds: input.identityId ? [input.identityId] : [],
                phoneIds: input.phoneId ? [input.phoneId] : [],
            })
            const contact = await transaction.contact.findUnique({ where: { id: input.contactId } })
            if (!contact || contact.isArchived) return { status: 'contact_not_found' as const }

            let identity
            if (input.identityId !== null) {
                identity = await transaction.contactIdentity.findFirst({
                where: {
                    id: input.identityId,
                    contactId: input.contactId,
                    channel: input.channel,
                    isActive: true,
                    ...(input.phoneId ? { phoneId: input.phoneId } : {}),
                },
            })
                if (!identity) return { status: 'identity_not_found' as const }
            } else {
                identity = await transaction.contactIdentity.findFirst({
                where: {
                    contactId: input.contactId,
                    channel: input.channel,
                    isActive: true,
                    ...(input.phoneId ? { phoneId: input.phoneId } : {}),
                },
                orderBy: { createdAt: 'asc' },
            })
            }

            if (!identity) {
                const phone = await transaction.contactPhone.findFirst({
                where: {
                    contactId: input.contactId,
                    isActive: true,
                    ...(input.phoneId ? { id: input.phoneId } : {}),
                },
                orderBy: { isPrimary: 'desc' },
            })
                if (!phone) {
                    return { status: input.phoneId ? 'phone_not_found' as const : 'no_identity' as const }
                }
                // A phone number is not a stable Telegram/MAX/WhatsApp user
                // identifier. Starting a provider conversation therefore
                // requires an existing opaque identity instead of fabricating
                // one from mutable phone digits.
                return { status: 'no_identity' as const }
            }

            return {
                status: 'ready' as const,
                contact: { id: contact.id, displayName: contact.displayName },
                identity: {
                    id: identity.id,
                    channel: input.channel,
                    externalId: identity.externalId,
                },
            }
        })
    },

    async getPreferredActiveContactPhone(contactId, phoneId) {
        const phone = await prisma.contactPhone.findFirst({
            where: { contactId, isActive: true, ...(phoneId ? { id: phoneId } : {}) },
            orderBy: { isPrimary: 'desc' },
        })
        return phone?.phone ?? null
    },
}
