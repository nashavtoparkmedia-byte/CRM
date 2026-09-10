import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'
import { isContactConfirmedMainDriverV1 } from '@/modules/contacts/public/v1'
import { prepareOutboundConversationV1 } from '@/modules/messaging/public/v1/outbound-conversation-identity-runtime'

const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n

export interface PreparedManualDriverTelegramLinkAuthorityV1 {
    chatId: string
    contactId: string
    contactIdentityId: string
    providerAccountId: string
    connectionId: string
    target: string
    identityTarget: string
}

function metadataRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

function exactIdentifier(value: unknown): string | null {
    return typeof value === 'string'
        && value.length > 0
        && value === value.trim()
        ? value
        : null
}

function hasConfirmedMainDriverAuthority(customFields: unknown, driverId: string): boolean {
    const contactFields = metadataRecord(customFields)
    const storedConfirmations = Array.isArray(contactFields.driverConfirmations)
        ? contactFields.driverConfirmations
        : []
    const hasExactConfirmation = storedConfirmations.some(item => {
        const confirmation = metadataRecord(item)
        return confirmation.status === 'confirmed'
            && confirmation.representativeDriverId === driverId
    })
    const hasUnresolvedConfirmation = storedConfirmations.some(item => {
        const confirmation = metadataRecord(item)
        return confirmation.status === 'needs_reconciliation'
            || (
                confirmation.status === 'confirmed'
                && confirmation.representativeDriverId !== driverId
            )
    })
    const identityConflicts = Array.isArray(contactFields.identityConflicts)
        ? contactFields.identityConflicts
        : []
    const hasOpenDriverContradiction = identityConflicts.some(item => {
        const conflict = metadataRecord(item)
        return conflict.status === 'open'
            && (
                conflict.conflictType === 'confirmed_driver_cluster_contradiction'
                || conflict.conflictType === 'fleet_authoritative_person_contradiction'
            )
    })
    return hasExactConfirmation
        && !hasUnresolvedConfirmation
        && !hasOpenDriverContradiction
}

type ManualDriverTelegramLinkAuthorityReadClientV1 = Pick<
    Prisma.TransactionClient,
    'chat' | 'contactIdentity' | 'contact'
>

/**
 * Re-read the authority proof after a caller has acquired Contacts' CNT1
 * advisory fence. The caller must keep that fence through its mapping write.
 */
export async function revalidatePreparedManualDriverTelegramLinkAuthorityV1(
    client: ManualDriverTelegramLinkAuthorityReadClientV1,
    input: { driverId: string; telegramId: bigint },
    prepared: PreparedManualDriverTelegramLinkAuthorityV1,
): Promise<void> {
    const driverId = exactIdentifier(input.driverId)
    const target = input.telegramId.toString()
    if (
        !driverId
        || input.telegramId <= 0n
        || input.telegramId > MAX_SIGNED_BIGINT
        || prepared.target !== target
        || prepared.identityTarget !== target
        || !exactIdentifier(prepared.chatId)
        || !exactIdentifier(prepared.contactId)
        || !exactIdentifier(prepared.contactIdentityId)
        || !exactIdentifier(prepared.providerAccountId)
        || prepared.providerAccountId === 'legacy'
        || !exactIdentifier(prepared.connectionId)
    ) {
        throw new Error('DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH')
    }

    const chat = await client.chat.findUnique({
        where: { externalChatId: `telegram:${target}` },
        select: {
            id: true,
            driverId: true,
            contactId: true,
            contactIdentityId: true,
            channel: true,
            externalChatId: true,
            chatType: true,
            metadata: true,
        },
    })
    if (!chat) throw new Error('DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED')
    const chatMetadata = metadataRecord(chat.metadata)
    if (
        chat.id !== prepared.chatId
        || chat.channel !== 'telegram'
        || chat.externalChatId !== `telegram:${target}`
        || chat.chatType !== 'private'
        || chatMetadata.chatKind !== 'private'
        || (chat.driverId !== null && chat.driverId !== driverId)
    ) {
        throw new Error('DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED')
    }
    if (
        chat.contactId !== prepared.contactId
        || chat.contactIdentityId !== prepared.contactIdentityId
        || chatMetadata.providerAccountId !== prepared.providerAccountId
        || chatMetadata.connectionId !== prepared.connectionId
    ) {
        throw new Error('DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH')
    }

    const identity = await client.contactIdentity.findUnique({
        where: { id: prepared.contactIdentityId },
        select: {
            id: true,
            contactId: true,
            channel: true,
            externalId: true,
            isActive: true,
            reachabilityStatus: true,
            metadata: true,
        },
    })
    const identityMetadata = metadataRecord(identity?.metadata)
    if (
        !identity
        || !identity.isActive
        || identity.id !== prepared.contactIdentityId
        || identity.contactId !== prepared.contactId
        || identity.channel !== 'telegram'
        || identity.externalId !== target
        || identity.reachabilityStatus !== 'confirmed'
        || identityMetadata.providerAccountId !== prepared.providerAccountId
        || identityMetadata.conflictState === 'conflicted'
    ) {
        throw new Error('DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH')
    }

    const contact = await client.contact.findUnique({
        where: { id: prepared.contactId },
        select: {
            id: true,
            isArchived: true,
            mainDriverId: true,
            customFields: true,
        },
    })
    const contactFields = metadataRecord(contact?.customFields)
    const hasOpenIdentityConflict = Array.isArray(contactFields.identityConflicts)
        && contactFields.identityConflicts.some(item => {
            const conflict = metadataRecord(item)
            return conflict.status === 'open' && conflict.identityId === identity.id
        })
    if (
        !contact
        || contact.id !== prepared.contactId
        || contact.isArchived
        || contact.mainDriverId !== driverId
        || hasOpenIdentityConflict
        || !hasConfirmedMainDriverAuthority(contact.customFields, driverId)
    ) {
        throw new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED')
    }
}

/**
 * Re-read the complete authority chain before a DriverTelegram side effect.
 * Persistence callers whose write opens a later transaction must also pass
 * this proof through the CNT1-scoped revalidator above. A BotUserRegistry row,
 * phone, caller-selected Driver, or bare Telegram id is never sufficient.
 */
export async function prepareManualDriverTelegramLinkAuthorityV1(input: {
    driverId: string
    telegramId: bigint
}): Promise<PreparedManualDriverTelegramLinkAuthorityV1> {
    const driverId = exactIdentifier(input.driverId)
    if (!driverId) throw new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED')
    if (input.telegramId <= 0n || input.telegramId > MAX_SIGNED_BIGINT) {
        throw new Error('DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED')
    }
    const target = input.telegramId.toString()
    const chat = await prisma.chat.findUnique({
        where: { externalChatId: `telegram:${target}` },
        select: {
            id: true,
            driverId: true,
            contactId: true,
            contactIdentityId: true,
            channel: true,
            externalChatId: true,
            chatType: true,
            metadata: true,
        },
    })
    if (!chat) throw new Error('DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED')

    const metadata = metadataRecord(chat.metadata)
    if (
        chat.channel !== 'telegram'
        || chat.externalChatId !== `telegram:${target}`
        || chat.chatType !== 'private'
        || metadata.chatKind !== 'private'
        || (chat.driverId !== null && chat.driverId !== driverId)
    ) {
        throw new Error('DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED')
    }

    const outbound = await prepareOutboundConversationV1(chat)
    if (
        outbound.channel !== 'telegram'
        || outbound.chatId !== chat.id
        || outbound.contactId !== chat.contactId
        || outbound.contactIdentityId !== chat.contactIdentityId
        || outbound.target !== target
        || outbound.identityTarget !== target
        || !exactIdentifier(outbound.providerAccountId)
        || !exactIdentifier(outbound.connectionId)
    ) {
        throw new Error('DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH')
    }

    if (!await isContactConfirmedMainDriverV1(outbound.contactId, driverId)) {
        throw new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED')
    }

    return {
        chatId: chat.id,
        contactId: outbound.contactId,
        contactIdentityId: outbound.contactIdentityId,
        providerAccountId: outbound.providerAccountId,
        connectionId: outbound.connectionId,
        target,
        identityTarget: target,
    }
}
