import { ContactService } from '@/lib/ContactService'
import { isSafeContactResolutionSuccess } from '@/lib/contacts/SafeContactResolutionExecutor'
import { prisma } from '@/lib/prisma'
import {
    lockContactOwnershipRows,
    runContactOwnershipTransaction,
} from '@/modules/contacts/internal/contact-ownership-coordinator'
import { identityEvidenceState, jsonRecord } from './contact-evidence-state'
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
            await lockContactOwnershipRows(transaction, {
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
                const identities = await transaction.contactIdentity.findMany({
                    where: {
                        contactId: input.contactId,
                        channel: input.channel,
                        isActive: true,
                        ...(input.phoneId ? { phoneId: input.phoneId } : {}),
                    },
                    orderBy: { createdAt: 'asc' },
                    take: 2,
                })
                if (identities.length > 1) return { status: 'identity_ambiguous' as const }
                identity = identities[0] ?? null
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

            const hasOpenIdentityConflict = Array.isArray(jsonRecord(contact.customFields).identityConflicts)
                && (jsonRecord(contact.customFields).identityConflicts as unknown[]).some(item => {
                    const conflict = jsonRecord(item)
                    return conflict.status === 'open' && conflict.identityId === identity.id
                })
            if (
                identityEvidenceState(identity.metadata).conflictState === 'conflicted'
                || hasOpenIdentityConflict
            ) {
                return { status: 'identity_conflicted' as const }
            }

            // Creating or opening an outbound conversation is a write-capable
            // operation. Only delivery-confirmed provider reachability can
            // authorize it; an operationally unknown result must fail closed
            // just like a provider-confirmed negative result.
            if (identity.reachabilityStatus === 'unreachable') {
                return { status: 'identity_unreachable' as const }
            }
            if (identity.reachabilityStatus !== 'confirmed') {
                return { status: 'identity_reachability_unknown' as const }
            }

            return {
                status: 'ready' as const,
                contact: { id: contact.id, displayName: contact.displayName },
                identity: {
                    id: identity.id,
                    channel: input.channel,
                    externalId: identity.externalId,
                    providerAliasValues: identityEvidenceState(identity.metadata).providerAliasValues,
                    providerAccountId: (() => {
                        const providerAccountId = identityEvidenceState(identity.metadata).providerAccountId
                        return providerAccountId === 'legacy' ? null : providerAccountId
                    })(),
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
