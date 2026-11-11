/**
 * Telegram MTProto (personal account) guarded ingress — the R-21 adoption.
 *
 * Every provider event this account observes (live inbound, the phone mirror
 * of an own message, catch-up and history import) is admitted here and then
 * written ONLY through Messaging's guarded atomic append
 * (`messaging.AppendGuardedChannelMessageCommand.v1`). Admission proves the
 * conversation's peer from Contacts; the proof never crosses this module's
 * boundary in either direction:
 *
 * - The caller hands over a provider observation (peer, account, connection,
 *   display name) that server code fetched from GramJS. It never passes an
 *   attribution, a contact id or an identity id.
 * - `proven` means Contacts resolved THIS peer's Telegram identity AND
 *   `messaging.EnsureConversationContactLinkCommand.v1` succeeded for exactly
 *   that identity, in this admission.
 * - `unproven` means the link was refused (driver, ownership or identity
 *   mismatch). It is used only while the admitted conversation carries a
 *   person binding, so the guard holds the event durably; a refusal never
 *   makes an event visible.
 * - A contradictory Contacts answer (no identity, another channel's or another
 *   peer's identity) and a transient (`*_STALE`) refusal are thrown before any
 *   append: today's HOLD, the event stays with the provider.
 *
 * After a proven admission, events held earlier in this conversation are
 * released with this admission's fresh proof — never with a read-back of the
 * binding. A release is counted first so a healthy conversation takes no extra
 * conversation lock.
 *
 * This file is server-only composition (A1): it carries no server-action
 * directive and lives outside the app layer, and it exports nothing that takes
 * a person proof.
 */
import {
    appendConversationIdentityCollisionV1,
    appendGuardedChannelMessageV1,
    ensureConversationContactLinkV1,
    heldChannelMessagesV1,
    patchChannelConversationV1,
    releaseHeldChannelMessagesV1,
    upsertChannelConversationV1,
} from '@/modules/messaging/public/v1'
import {
    APPEND_GUARDED_CHANNEL_MESSAGE_COMMAND_V1,
    ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1,
    GuardedChannelMessageCommandValidationError,
    GuardedChannelMessageError,
    HELD_CHANNEL_MESSAGES_QUERY_V1,
    PATCH_CHANNEL_CONVERSATION_COMMAND_V1,
    RELEASE_HELD_CHANNEL_MESSAGES_COMMAND_V1,
    UPSERT_CHANNEL_CONVERSATION_COMMAND_V1,
    type AppendGuardedChannelMessageResultV1,
    type ChannelMessageJsonV1,
    type GuardedMessageTypeV1,
    type GuardedProjectionV1,
    type GuardedSenderAttributionV1,
} from '@/contracts/messaging/v1'
import { isResolvedChannelContactResultV1, markChannelIdentityConflictV1, resolveChannelContactOperationV1 } from '@/modules/contacts/public/v1'
import { contactReachabilityV1 } from '@/modules/contacts/public/v1/contact-reachability'

/**
 * Where the observation came from. `catch-up` replays missed live events and
 * `import` replays provider history; only `import` writes with the `history`
 * projection, and the projection is never chosen per event by the caller.
 */
export type TelegramPrivateIngressPhase = 'inbound' | 'mirror' | 'catch-up' | 'import'

export type TelegramPrivateConversation = {
    id: string
    channel: string
    externalChatId: string
    chatType: string
    contactId: string | null
    contactIdentityId: string | null
    driverId: string | null
    metadata: unknown
}

/** One provider event of an admitted private conversation. No sender attribution: admission owns it. */
export interface TelegramGuardedEvent {
    direction: 'inbound' | 'outbound'
    type: GuardedMessageTypeV1
    content: string
    /** The exact provider-event key (`telegram:<account>:<peer>:<id>`, or the synthetic `local-<ts>` key). */
    externalId: string
    /** The validated provider time of the event. */
    sentAt: Date
    metadata: { [key: string]: ChannelMessageJsonV1 }
}

export interface AdmittedTelegramPrivateConversation {
    readonly conversation: TelegramPrivateConversation
    /** Whether this admission proved the peer; the proof itself never leaves this module. */
    readonly attribution: 'proven' | 'unproven'
    /**
     * Appends one event of this conversation through the guard, with the
     * attribution this admission proved. A guard refusal is rethrown as one
     * bounded `TELEGRAM_GUARDED_APPEND_*` code.
     */
    append(event: TelegramGuardedEvent): Promise<AppendGuardedChannelMessageResultV1>
}

/** Link refusals that prove the conversation is somebody else's: the event is held durably, not dropped. */
const LINK_REFUSALS_HELD_DURABLY = new Set([
    'CONTACT_CONVERSATION_DRIVER_MISMATCH',
    'CONTACT_CONVERSATION_OWNERSHIP_MISMATCH',
    'CONTACT_IDENTITY_LINK_MISMATCH',
])

const GUARDED_APPEND_REFUSAL_PREFIX = 'TELEGRAM_GUARDED_APPEND_'

function metadataRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

function concreteOpaqueId(value: unknown): string | null {
    if (typeof value !== 'string') return null
    return value !== '' && value === value.trim() && value !== 'legacy' ? value : null
}

/** A link refusal is thrown as `new Error('<CODE>')`; anything else is not one. */
function linkRefusalCode(error: unknown): string | null {
    const message = error instanceof Error ? error.message : null
    return message && LINK_REFUSALS_HELD_DURABLY.has(message) ? message : null
}

function hasPersonBinding(conversation: TelegramPrivateConversation): boolean {
    return conversation.contactId !== null || conversation.contactIdentityId !== null || conversation.driverId !== null
}

/** One bounded code for a guard refusal; nothing else of the error crosses. */
function guardedRefusal(error: unknown): Error | null {
    if (error instanceof GuardedChannelMessageError || error instanceof GuardedChannelMessageCommandValidationError) {
        return new Error(`${GUARDED_APPEND_REFUSAL_PREFIX}${error.code}`)
    }
    return null
}

function guardedLogCode(error: unknown): string {
    if (error instanceof GuardedChannelMessageError || error instanceof GuardedChannelMessageCommandValidationError) return error.code
    const code = (error as { code?: unknown } | null)?.code
    return typeof code === 'string' && /^P\d{4}$/u.test(code) ? code : 'UNCLASSIFIED'
}

async function rejectTelegramConversationCollision(
    chat: TelegramPrivateConversation,
    input: {
        phase: TelegramPrivateIngressPhase
        externalChatId: string
        peerId: string
        providerAccountId: string
        connectionId: string
    },
    reason: string,
): Promise<never> {
    const storedMetadata = metadataRecord(chat.metadata)
    const existingProviderAccountId = concreteOpaqueId(storedMetadata.providerAccountId)
    const existingConnectionId = concreteOpaqueId(storedMetadata.connectionId)
    const existingPeerId = concreteOpaqueId(storedMetadata.peerId)
    const evidence = {
        channel: 'telegram' as const,
        reason,
        phase: input.phase,
        externalChatId: input.externalChatId,
        existingExternalChatId: chat.externalChatId,
        incomingPeerId: input.peerId,
        existingPeerId,
        incomingProviderAccountId: input.providerAccountId,
        existingProviderAccountId,
        incomingConnectionId: input.connectionId,
        existingConnectionId,
    }
    await appendConversationIdentityCollisionV1({ chatId: chat.id, evidence })
    if (chat.contactId && chat.contactIdentityId) {
        try {
            await markChannelIdentityConflictV1({
                contactId: chat.contactId,
                identityId: chat.contactIdentityId,
                channel: 'telegram',
                reason,
                evidenceRoot: `channel-collision:telegram:${chat.externalChatId}:${input.providerAccountId}:${input.connectionId}:${input.peerId}:${reason}`,
                details: {
                    phase: input.phase,
                    incomingPeerId: input.peerId,
                    existingPeerId,
                    incomingProviderAccountId: input.providerAccountId,
                    existingProviderAccountId,
                    incomingConnectionId: input.connectionId,
                    existingConnectionId,
                },
            })
        } catch (error: unknown) {
            console.error(`[TG-IDENTITY] Failed to mark linked identity conflicted: code=${guardedLogCode(error)}`)
        }
    }
    throw new Error(`TELEGRAM_CONVERSATION_IDENTITY_COLLISION:${reason}`)
}

/**
 * Releases events held earlier in this conversation, with this admission's
 * fresh proof. Best effort: a failed release leaves them held for the next
 * proven admission and never costs the current event. An event held after the
 * count is released by the next proven admission. Released events are not
 * published one by one; the inbox shows them on its next refresh.
 */
async function releaseHeldWithFreshProof(chatId: string, proof: GuardedSenderAttributionV1 & { status: 'proven' }): Promise<void> {
    try {
        const held = await heldChannelMessagesV1({ contract: HELD_CHANNEL_MESSAGES_QUERY_V1, chatId })
        if (held.held === 0) return
        const released = await releaseHeldChannelMessagesV1({
            contract: RELEASE_HELD_CHANNEL_MESSAGES_COMMAND_V1,
            chatId,
            conversationKind: 'private',
            attribution: proof,
        })
        console.log(`[TG-GUARD] release chat=${chatId} outcome=${released.outcome} released=${released.released} remaining=${released.remaining} keyConflicts=${released.keyConflicts} senderMismatches=${released.senderMismatches}`)
    } catch (error: unknown) {
        console.warn(`[TG-GUARD] release failed chat=${chatId} code=${guardedLogCode(error)}`)
    }
}

function admittedConversation(
    conversation: TelegramPrivateConversation,
    attribution: GuardedSenderAttributionV1,
    phase: TelegramPrivateIngressPhase,
): AdmittedTelegramPrivateConversation {
    // History import replays the past silently; every other observation is live.
    const projection: GuardedProjectionV1 = phase === 'import' ? 'history' : 'live'
    return Object.freeze({
        conversation,
        attribution: attribution.status === 'proven' ? 'proven' as const : 'unproven' as const,
        async append(event: TelegramGuardedEvent): Promise<AppendGuardedChannelMessageResultV1> {
            try {
                return await appendGuardedChannelMessageV1({
                    contract: APPEND_GUARDED_CHANNEL_MESSAGE_COMMAND_V1,
                    chatId: conversation.id,
                    conversationKind: 'private',
                    attribution,
                    channel: 'telegram',
                    direction: event.direction,
                    type: event.type,
                    content: event.content,
                    externalId: event.externalId,
                    sentAt: event.sentAt,
                    metadata: event.metadata,
                    projection,
                })
            } catch (error: unknown) {
                throw guardedRefusal(error) ?? error
            }
        },
    })
}

/**
 * Admits one private GramJS conversation before any person/link/message write.
 * Telegram user ids are global-looking, but a CRM conversation is owned by the
 * exact authenticated account and transport that observed it. Legacy/unbound
 * rows are evidence gaps, not permission to claim the peer for this account.
 */
export async function admitTelegramPrivateConversation(input: {
    phase: TelegramPrivateIngressPhase
    peerId: string
    providerAccountId: string
    connectionId: string
    displayName: string | null
}): Promise<AdmittedTelegramPrivateConversation> {
    const peerId = concreteOpaqueId(input.peerId)
    const providerAccountId = concreteOpaqueId(input.providerAccountId)
    const connectionId = concreteOpaqueId(input.connectionId)
    if (!peerId || !/^\d+$/.test(peerId) || peerId === '0') {
        throw new Error('TELEGRAM_PEER_ID_UNPROVEN')
    }
    if (!providerAccountId || providerAccountId !== input.providerAccountId) {
        throw new Error('TELEGRAM_PROVIDER_ACCOUNT_ID_UNPROVEN')
    }
    if (!connectionId || connectionId !== input.connectionId) {
        throw new Error('TELEGRAM_CONNECTION_ID_UNPROVEN')
    }

    const externalChatId = `telegram:${peerId}`
    const admitted = await upsertChannelConversationV1({
        contract: UPSERT_CHANNEL_CONVERSATION_COMMAND_V1,
        externalChatId,
        channel: 'telegram',
        name: input.displayName ?? `TG ${peerId}`,
        chatType: 'private',
        metadata: {
            chatKind: 'private',
            peerId,
            providerAccountId,
            connectionId,
        },
    })
    const chat = admitted.conversation as TelegramPrivateConversation
    const storedMetadata = metadataRecord(chat.metadata)
    const storedConnectionId = concreteOpaqueId(storedMetadata.connectionId)
    const storedPeerId = concreteOpaqueId(storedMetadata.peerId)
    // Each arm rejects only on a CONTRADICTION that production rows can actually
    // express. A stored value that is simply absent is a legacy compatibility
    // state: those rows predate transport/peer stamping, and the conversation
    // adapter never writes metadata onto an existing row, so an "unproven" arm
    // would fire forever on every one of them and could never self-heal.
    // Measured 2026-09-12 over 167 production telegram Chat rows: 0 carry
    // providerAccountId, 0 carry peerId, 0 carry chatKind, 109 carry
    // connectionId, and all 167 carry chatType='private'.
    // Provider-account comparison is gone entirely: see
    // docs/design/provider-account-identity-v1.md.
    const reason = chat.channel !== 'telegram'
        ? 'channel_mismatch'
        : chat.externalChatId !== externalChatId
            ? 'conversation_key_mismatch'
            // A stored transport that disagrees is a real cross-transport claim.
            : storedConnectionId !== null && storedConnectionId !== connectionId
                ? 'transport_connection_mismatch'
                // A stored peer that disagrees means this conversation belongs to
                // somebody else. This is the cross-peer guard and it stays exact.
                : storedPeerId !== null && storedPeerId !== peerId
                    ? 'peer_identity_mismatch'
                    // chatType is carried by every production row; chatKind is
                    // only compared when the row actually has one.
                    : chat.chatType !== 'private'
                        || (storedMetadata.chatKind !== undefined && storedMetadata.chatKind !== 'private')
                        ? 'chat_kind_mismatch'
                        : null
    if (reason) {
        await rejectTelegramConversationCollision(chat, {
            phase: input.phase,
            externalChatId,
            peerId,
            providerAccountId,
            connectionId,
        }, reason)
    }

    const contactResult = await resolveChannelContactOperationV1(
        'telegram',
        peerId,
        null,
        input.displayName,
        { chatKind: 'private', providerAccountId },
    )
    if (
        !isResolvedChannelContactResultV1(contactResult)
        || !contactResult.identity
        || contactResult.identity.channel !== 'telegram'
        || contactResult.identity.externalId !== peerId
    ) {
        throw new Error(`CONTACT_RESOLUTION_BLOCKED:${contactResult.status}`)
    }
    try {
        await ensureConversationContactLinkV1({
            contract: ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1,
            chatId: chat.id,
            contactId: contactResult.contact.id,
            contactIdentityId: contactResult.identity.id,
        })
    } catch (error: unknown) {
        const refusal = linkRefusalCode(error)
        // A refusal in a conversation bound to nobody keeps today's HOLD: the
        // guard would show an unproven event there.
        if (!refusal || !hasPersonBinding(chat)) throw error
        console.warn(`[TG-GUARD] unproven chat=${chat.id} code=${refusal}`)
        return admittedConversation(chat, { status: 'unproven', reason: refusal }, input.phase)
    }
    if (input.phase === 'inbound') {
        await contactReachabilityV1.recordExactProviderReachability({
            identityId: contactResult.identity.id,
            contactId: contactResult.contact.id,
            channel: 'telegram',
            providerAccountId,
            providerTargetId: peerId,
            status: 'confirmed',
        })
    }

    const patched = await patchChannelConversationV1({
        contract: PATCH_CHANNEL_CONVERSATION_COMMAND_V1,
        selector: { chatId: chat.id },
        patch: { name: input.displayName ?? `TG ${peerId}` },
    })
    const proof = {
        status: 'proven' as const,
        contactId: contactResult.contact.id,
        contactIdentityId: contactResult.identity.id,
    }
    await releaseHeldWithFreshProof(chat.id, proof)
    return admittedConversation(patched.conversation as TelegramPrivateConversation, proof, input.phase)
}

/** The bounded refusal codes `append` may throw. */
export const TELEGRAM_GUARDED_APPEND_REFUSAL_CODES = Object.freeze([
    'TELEGRAM_GUARDED_APPEND_CONTENDED',
    'TELEGRAM_GUARDED_APPEND_CONVERSATION_NOT_FOUND',
    'TELEGRAM_GUARDED_APPEND_CONVERSATION_CHANNEL_MISMATCH',
    'TELEGRAM_GUARDED_APPEND_CONVERSATION_KIND_MISMATCH',
    'TELEGRAM_GUARDED_APPEND_INVALID_CONTRACT',
    'TELEGRAM_GUARDED_APPEND_UNSUPPORTED_CONTRACT_VERSION',
] as const)
