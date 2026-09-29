import type { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'
import { isContactConfirmedMainDriverV1 } from '@/modules/contacts/public/v1'

import { canonicalTelegramBotConnectionIdV1 } from './bot-transport-config'

const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n

/**
 * Person/conversation proof: this Driver owns this exact Telegram peer.
 *
 * It deliberately carries NO transport fields. A Chat is the peer/conversation
 * identity shared by both Telegram transports, so "which transport is speaking"
 * is a separate question answered at runtime, never by stored conversation
 * metadata. Proving a person must not require an outbound routing proof.
 */
export interface PreparedDriverTelegramConversationAuthorityV1 {
    chatId: string
    contactId: string
    contactIdentityId: string
    driverId: string
    target: string
}

export interface PreparedManualDriverTelegramLinkAuthorityV1 {
    chatId: string
    contactId: string
    contactIdentityId: string
    /**
     * Provider-account provenance is DEFERRED and carries no authority, so the
     * Driver Bot flows this authority serves never request a provider account.
     * See docs/design/provider-account-identity-v1.md.
     */
    providerAccountId: null
    /** The canonical configured Driver Bot transport, never a Chat-derived one. */
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
        || prepared.providerAccountId !== null
        // Re-prove the transport against configuration under the fence. The
        // shared Chat never carried this binding, so there is nothing on the row
        // to compare against and nothing a concurrent writer could flip.
        || prepared.connectionId !== canonicalTelegramBotConnectionIdV1()
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
    // Chat.chatType is the canonical private/group source, so metadata.chatKind is
    // not consulted as a second source; and the shared Chat holds no transport
    // authority, so its stored connection/provider account are not compared here.
    if (
        chat.id !== prepared.chatId
        || chat.channel !== 'telegram'
        || chat.externalChatId !== `telegram:${target}`
        || chat.chatType !== 'private'
        || (chat.driverId !== null && chat.driverId !== driverId)
    ) {
        throw new Error('DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED')
    }
    if (
        chat.contactId !== prepared.contactId
        || chat.contactIdentityId !== prepared.contactIdentityId
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
 * Prove that an exact Driver owns an exact Telegram peer conversation.
 *
 * Reads Messaging's Chat binding and the Contacts-owned identity/contact state
 * directly. It deliberately does NOT call an outbound routing proof: routing is
 * a transport question, and a shared conversation must not have to name a
 * transport in order to prove a person. `Chat.chatType` is the canonical
 * private/group source; `metadata.chatKind` is never consulted, because no
 * production row carries it and no code path can add one to an existing row.
 *
 * A BotUserRegistry row, phone, caller-selected Driver, DriverTelegram row or
 * bare Telegram id is never sufficient on its own.
 */
export async function prepareDriverTelegramConversationAuthorityV1(
    input: { driverId: string; telegramId: bigint },
): Promise<PreparedDriverTelegramConversationAuthorityV1> {
    // Reads go through the module's own client. Accepting one as a parameter
    // would put a @prisma/client type in this context's public signature and
    // launder a private persistence type through the facade; the serialized
    // re-read under CNT1 is `revalidate…` below, which is not part of the
    // public surface.
    const client: ManualDriverTelegramLinkAuthorityReadClientV1 = prisma
    const driverId = exactIdentifier(input.driverId)
    if (!driverId) throw new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED')
    if (input.telegramId <= 0n || input.telegramId > MAX_SIGNED_BIGINT) {
        throw new Error('DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED')
    }
    const target = input.telegramId.toString()

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
        },
    })
    if (!chat) throw new Error('DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED')
    if (
        chat.channel !== 'telegram'
        || chat.externalChatId !== `telegram:${target}`
        || chat.chatType !== 'private'
        || (chat.driverId !== null && chat.driverId !== driverId)
    ) {
        throw new Error('DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED')
    }

    const contactId = exactIdentifier(chat.contactId)
    const contactIdentityId = exactIdentifier(chat.contactIdentityId)
    if (!contactId || !contactIdentityId) {
        throw new Error('DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH')
    }

    const identity = await client.contactIdentity.findUnique({
        where: { id: contactIdentityId },
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
        || identity.contactId !== contactId
        || identity.channel !== 'telegram'
        || identity.externalId !== target
        || identity.reachabilityStatus !== 'confirmed'
        || identityMetadata.conflictState === 'conflicted'
    ) {
        throw new Error('DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH')
    }

    if (!await isContactConfirmedMainDriverV1(contactId, driverId)) {
        throw new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED')
    }

    return { chatId: chat.id, contactId, contactIdentityId, driverId, target }
}

/**
 * Re-read the complete authority chain before a DriverTelegram side effect.
 * Persistence callers whose write opens a later transaction must also pass
 * this proof through the CNT1-scoped revalidator above.
 *
 * It composes the person/conversation proof with the canonical configured
 * Driver Bot transport. The transport is read from configuration, never from
 * the shared Chat, and no provider account is requested.
 */
export async function prepareManualDriverTelegramLinkAuthorityV1(input: {
    driverId: string
    telegramId: bigint
}): Promise<PreparedManualDriverTelegramLinkAuthorityV1> {
    const person = await prepareDriverTelegramConversationAuthorityV1(input)
    return {
        chatId: person.chatId,
        contactId: person.contactId,
        contactIdentityId: person.contactIdentityId,
        providerAccountId: null,
        connectionId: canonicalTelegramBotConnectionIdV1(),
        target: person.target,
        identityTarget: person.target,
    }
}
