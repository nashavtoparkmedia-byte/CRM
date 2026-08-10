import { ContactService } from '@/lib/ContactService'
import { prisma } from '@/lib/prisma'
import type { ContactConversationPersistencePortV1 } from './contact-conversation-handler'

export const legacyPrismaContactConversationPortV1: ContactConversationPersistencePortV1 = {
    async resolveChannelContact(input) {
        const resolved = await ContactService.resolveContact(
            input.channel,
            input.externalId,
            input.phone,
            input.displayName,
        )
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
        const contact = await prisma.contact.findUnique({ where: { id: input.contactId } })
        if (!contact || contact.isArchived) return { status: 'contact_not_found' }

        let identity
        if (input.identityId !== null) {
            identity = await prisma.contactIdentity.findFirst({
                where: {
                    id: input.identityId,
                    contactId: input.contactId,
                    channel: input.channel,
                    isActive: true,
                },
            })
            if (!identity) return { status: 'identity_not_found' }
        } else {
            identity = await prisma.contactIdentity.findFirst({
                where: {
                    contactId: input.contactId,
                    channel: input.channel,
                    isActive: true,
                },
                orderBy: { createdAt: 'asc' },
            })
        }

        if (!identity) {
            const phone = await prisma.contactPhone.findFirst({
                where: { contactId: input.contactId, isActive: true },
                orderBy: { isPrimary: 'desc' },
            })
            if (!phone) return { status: 'no_identity' }

            identity = await prisma.contactIdentity.create({
                data: {
                    contactId: input.contactId,
                    channel: input.channel,
                    externalId: phone.phone.replace('+', ''),
                    phoneId: phone.id,
                    source: 'manual',
                    confidence: 1.0,
                },
            })
        }

        return {
            status: 'ready',
            contact: { id: contact.id, displayName: contact.displayName },
            identity: {
                id: identity.id,
                channel: input.channel,
                externalId: identity.externalId,
            },
        }
    },

    async getPreferredActiveContactPhone(contactId) {
        const phone = await prisma.contactPhone.findFirst({
            where: { contactId, isActive: true },
            orderBy: { isPrimary: 'desc' },
        })
        return phone?.phone ?? null
    },
}
