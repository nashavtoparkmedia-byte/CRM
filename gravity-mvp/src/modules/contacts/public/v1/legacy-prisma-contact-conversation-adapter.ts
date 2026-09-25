import { ContactService } from '@/lib/ContactService'
import { isSafeContactResolutionSuccess } from '@/lib/contacts/SafeContactResolutionExecutor'
import { prisma } from '@/lib/prisma'
import {
    lockContactOwnershipRows,
    runContactOwnershipTransaction,
} from '@/modules/contacts/internal/contact-ownership-coordinator'
import { identityEvidenceState, jsonRecord } from './contact-evidence-state'
import type { ContactConversationPersistencePortV1 } from './contact-conversation-handler'
import type { InboundConversationPeerIdentityPersistencePortV1 } from './inbound-conversation-peer-identity-handler'

export const legacyPrismaContactConversationPortV1: ContactConversationPersistencePortV1
    & InboundConversationPeerIdentityPersistencePortV1 = {
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

    /**
     * Resolve the identity an INBOUND peer speaks from, inside a conversation that already
     * exists. The conversation's linked identity is not necessarily the peer's identity: a
     * Chat can be linked to an identity whose externalId is the conversation key while the
     * peer is a different identity of the same Contact. Both rows are locked for the read.
     *
     * Reachability is not consulted: this never authorizes a send.
     */
    async resolveInboundConversationPeerIdentity(input) {
        return runContactOwnershipTransaction(async transaction => {
            await lockContactOwnershipRows(transaction, {
                contactIds: [input.contactId],
                identityIds: [input.linkedIdentityId],
                identities: [{ channel: input.channel, externalId: input.peerExternalId }],
            })
            const contact = await transaction.contact.findUnique({ where: { id: input.contactId } })
            if (!contact || contact.isArchived) return { status: 'contact_not_found' as const }

            // The conversation's own link must still name an active identity of this Contact
            // on this channel. Its conflict state is deliberately not consulted: a rejected
            // inbound event opens a conflict on that identity, and requiring it clean here
            // would let one rejection lock the conversation permanently.
            const linkedIdentity = await transaction.contactIdentity.findFirst({
                where: {
                    id: input.linkedIdentityId,
                    contactId: input.contactId,
                    channel: input.channel,
                    isActive: true,
                },
                select: { id: true },
            })
            if (!linkedIdentity) return { status: 'linked_identity_not_found' as const }

            // (channel, externalId) is globally unique, so this is the only identity that can
            // carry the peer. Requiring it to belong to this Contact answers "does this
            // Contact own the peer" and "does another Contact claim it" in one read.
            const peerIdentity = await transaction.contactIdentity.findFirst({
                where: {
                    channel: input.channel,
                    externalId: input.peerExternalId,
                    contactId: input.contactId,
                    isActive: true,
                },
            })
            if (!peerIdentity) return { status: 'peer_identity_not_found' as const }

            const hasOpenIdentityConflict = Array.isArray(jsonRecord(contact.customFields).identityConflicts)
                && (jsonRecord(contact.customFields).identityConflicts as unknown[]).some(item => {
                    const conflict = jsonRecord(item)
                    return conflict.status === 'open' && conflict.identityId === peerIdentity.id
                })
            if (
                identityEvidenceState(peerIdentity.metadata).conflictState === 'conflicted'
                || hasOpenIdentityConflict
            ) {
                return { status: 'peer_identity_conflicted' as const }
            }

            return {
                status: 'ready' as const,
                contact: { id: contact.id, displayName: contact.displayName },
                peerIdentity: {
                    kind: 'inbound_peer_identity' as const,
                    id: peerIdentity.id,
                    channel: input.channel,
                    externalId: peerIdentity.externalId,
                    providerAccountId: (() => {
                        const providerAccountId = identityEvidenceState(peerIdentity.metadata).providerAccountId
                        return providerAccountId === 'legacy' ? null : providerAccountId
                    })(),
                },
            }
        })
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

            // OPENING a conversation is first contact: nothing yet proves the
            // peer exists, so only delivery-confirmed provider reachability can
            // authorize it, and an operationally unknown result fails closed
            // just like a provider-confirmed negative one.
            //
            // REPLYING inside a conversation that is already bound to this exact
            // identity is a different question. The conversation's own delivered
            // history is the proof, so requiring a separate confirmation there
            // rejects ordinary replies on threads that have been carrying
            // messages for months. Every identity starts at 'unknown', so that
            // reading would reject a majority of live outbound traffic while
            // proving nothing the thread has not already demonstrated.
            if (input.purpose === 'open_conversation') {
                if (identity.reachabilityStatus === 'unreachable') {
                    return { status: 'identity_unreachable' as const }
                }
                if (identity.reachabilityStatus !== 'confirmed') {
                    return { status: 'identity_reachability_unknown' as const }
                }
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
