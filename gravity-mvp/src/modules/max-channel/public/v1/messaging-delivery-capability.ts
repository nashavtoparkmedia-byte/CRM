import { maxTextSendFailureMessageV1, readMaxTextSendFailureV1, sendMaxTransportTextV1 } from '@/modules/max-channel/application/messaging-transport'
import {
    channelDeliveryErrorV1,
    registerMaxChannelDeliveryV1,
    type MaxChannelDeliveryV1,
    type MaxTextDeliveryResultV1,
    type MaxTransportBindingV1,
} from '@/modules/messaging/public/v1/channel-delivery-runtime'
import { sendMaxReactionDeliveryV1 } from './reaction-delivery'

const scraperUrl = () => process.env.MAX_SCRAPER_URL || 'http://localhost:3005'

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * The scraper selects a live personal session by account id and echoes it back
 * for verification, so delivery genuinely cannot proceed without one. This is a
 * TRANSPORT capability requirement, not identity or conversation authority: it
 * decides whether a message can physically be sent, never whether a Contact or
 * ChannelIdentity may be admitted, re-parented or marked conflicted.
 */
function requireMaxTransportAccountV1(value: string | null | undefined): string {
    const account = optionalString(value)
    if (!account) throw new Error('MAX_TRANSPORT_ACCOUNT_REQUIRED')
    return account
}

export function assertMaxTransportBindingV1(input: MaxTransportBindingV1): void {
    const connectionId = optionalString(input.connectionId)
    // Provider-account provenance is deferred and asserts nothing here: for MAX
    // the stored connection is the constant 'max_scraper', so an account value
    // could never be checked against it. The transport shape checks below are
    // the real binding and are unchanged.
    // See docs/design/provider-account-identity-v1.md.
    if (input.isPersonal) {
        if (connectionId && connectionId !== 'scraper' && connectionId !== 'max_scraper') {
            throw new Error('CONTACT_CONVERSATION_PROVIDER_TRANSPORT_MISMATCH')
        }
        // The synchronous boundary can validate shape only. Every personal
        // operation below sends this exact account to the scraper, which binds
        // it to the live authenticated transport before touching MAX.
        return
    }
    if (!connectionId) throw new Error('CONTACT_CONVERSATION_TRANSPORT_UNBOUND')
    // Bot delivery has no implemented transport on MAX; a bound non-personal
    // conversation still cannot send.
    throw new Error('MAX_BOT_DELIVERY_TRANSPORT_UNAVAILABLE')
}

function isRealMaxMessageId(value: unknown): value is string {
    return typeof value === 'string' && /^d301[0-9a-f]+$/i.test(value)
}

/**
 * A reply goes out as a reply or not at all. The quoted message must carry a
 * real MAX provider id; a synthetic DOM-recovery id, or a quoted row with no id
 * at all (its context arrives without an id), is refused before anything is
 * dispatched instead of being sent as plain text.
 */
function assertMaxReplyTargetAddressableV1(options: {
    quotedMsgId?: string
    quotedText?: string
    quotedSentAt?: string
    quotedDirection?: string
}): void {
    const quotedMsgId = optionalString(options.quotedMsgId)
    const quotedContext = Boolean(
        optionalString(options.quotedText)
        || optionalString(options.quotedSentAt)
        || optionalString(options.quotedDirection),
    )
    if (quotedMsgId ? !isRealMaxMessageId(quotedMsgId) : quotedContext) {
        throw new Error(maxTextSendFailureMessageV1('MAX_REPLY_TARGET_NOT_ADDRESSABLE') ?? 'MAX_REPLY_TARGET_NOT_ADDRESSABLE')
    }
}

function validateMaxTextDeliveryResultV1(
    raw: unknown,
    expected: { clientMessageId?: string; providerAccountId: string },
): MaxTextDeliveryResultV1 {
    if (!isRecord(raw)) {
        throw new Error('MAX_PROVIDER_ACCOUNT_PROOF_MISMATCH')
    }

    const error = optionalString(raw.error)
    const hasExplicitError = Object.prototype.hasOwnProperty.call(raw, 'error')
        && (typeof raw.error === 'string'
            ? raw.error.trim().length > 0
            : raw.error !== null && raw.error !== undefined)
    const hasExplicitFailure = raw.success === false || raw.failed === true || raw.failure === true
    if (hasExplicitFailure || hasExplicitError) {
        throw new Error(error || 'MAX delivery failed')
    }
    if (optionalString(raw.providerAccountId) !== expected.providerAccountId) {
        throw new Error('MAX_PROVIDER_ACCOUNT_PROOF_MISMATCH')
    }

    const rawExternalId = optionalString(raw.externalId) || optionalString(raw.maxMessageId)
    const externalId = isRealMaxMessageId(rawExternalId) ? rawExternalId : null
    const resolvedChatId = optionalString(raw.resolvedChatId) || optionalString(raw.chatId)
    const confirmationFieldsAgree = raw.success === true
        && raw.deliveryConfirmed === true
        && raw.deliveryStatus === 'delivered'

    // Only a provider id correlated to this send confirms it: MAX's response to
    // the page's own op:64 request (provider_ack), or the page store's record of
    // the reply it just sent (provider_store_readback), naming that same id.
    // An id without that proof - the old answers took one from any frame - or
    // a UI action alone (the compose box clearing: on 2026-10-02 a message
    // typed while the socket was down was recorded delivered and never sent)
    // is a client action, nothing more.
    const proof = isRecord(raw.deliveryProof) ? raw.deliveryProof : null
    const proofKind = optionalString(raw.proofKind) ?? (proof ? optionalString(proof.kind) : null)
    const correlatedProviderProof = Boolean(
        externalId
        && confirmationFieldsAgree
        && (proofKind === 'provider_ack' || proofKind === 'provider_store_readback')
        && (!proof || optionalString(proof.providerMessageId) === externalId),
    )

    return {
        outcome: correlatedProviderProof ? 'delivered' : 'pending',
        externalId: correlatedProviderProof ? externalId : null,
        resolvedChatId,
        // S2: the typed evidence alone decides; a send is never 'delivered' here.
        evidence: correlatedProviderProof ? 'provider_ack' : 'client_action',
        providerMessageId: correlatedProviderProof ? externalId : null,
    }
}

function refusedBeforeDispatchV1(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error)
    const code = /^[A-Z][A-Z0-9_]+/.exec(message)?.[0] ?? 'MAX_SEND_REFUSED'
    return channelDeliveryErrorV1(message, 'terminal', code)
}

/** A failed send as Messaging's typed failure when its outcome is proven; any other error unchanged. */
function typedMaxTextSendFailureV1(error: unknown): unknown {
    const failure = readMaxTextSendFailureV1(error)
    if (!failure || !(error instanceof Error)) return error
    return channelDeliveryErrorV1(error.message, failure.outcome, failure.code)
}

async function post(
    path: string,
    body: Record<string, unknown>,
    expectedProviderAccountId: string,
): Promise<Record<string, unknown>> {
    const response = await fetch(`${scraperUrl()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(String(payload.error || `MAX request failed: ${response.status}`))
    if (optionalString(payload.providerAccountId) !== expectedProviderAccountId) {
        throw new Error('MAX_PROVIDER_ACCOUNT_PROOF_MISMATCH')
    }
    return payload
}

const capability: MaxChannelDeliveryV1 = {
    assertTransportBinding: assertMaxTransportBindingV1,
    async sendText(input) {
        let providerAccountId: string
        try {
            assertMaxTransportBindingV1({
                providerAccountId: input.options.providerAccountId,
                connectionId: input.options.connectionId,
                isPersonal: input.options.isPersonal === true,
            })
            providerAccountId = requireMaxTransportAccountV1(input.options.providerAccountId)
            assertMaxReplyTargetAddressableV1(input.options)
        } catch (error) {
            // A binding or reply-target refusal: nothing was dispatched, and a
            // repeat is refused again.
            throw refusedBeforeDispatchV1(error)
        }
        let raw: Record<string, unknown>
        try {
            raw = await sendMaxTransportTextV1({
                target: input.target,
                content: input.content,
                providerAccountId,
                connectionId: input.options.connectionId,
                isPersonal: input.options.isPersonal === true,
                quotedMsgId: input.options.quotedMsgId,
                uiChatId: input.options.uiChatId,
                clientMessageId: input.options.clientMessageId,
            })
        } catch (error) {
            throw typedMaxTextSendFailureV1(error)
        }
        return validateMaxTextDeliveryResultV1(raw, {
            clientMessageId: input.options?.clientMessageId,
            providerAccountId,
        })
    },
    async sendMedia(input) {
        assertMaxTransportBindingV1(input)
        const providerAccountId = requireMaxTransportAccountV1(input.providerAccountId)
        const payload = await post('/send-media', {
            chatId: input.chatId,
            base64: input.base64,
            filename: input.filename,
            mimeType: input.mimeType,
            caption: input.caption,
            mediaType: input.mediaType,
            providerAccountId,
        }, providerAccountId)
        return { externalId: typeof payload.externalId === 'string' ? payload.externalId : undefined }
    },
    async sendReaction(input) {
        assertMaxTransportBindingV1(input)
        return sendMaxReactionDeliveryV1({
            chatId: input.chatId,
            messageId: input.messageId,
            emoji: input.emoji,
            remove: input.remove,
            providerAccountId: requireMaxTransportAccountV1(input.providerAccountId),
        })
    },
    async deleteMessage(input) {
        assertMaxTransportBindingV1(input)
        const providerAccountId = requireMaxTransportAccountV1(input.providerAccountId)
        await post('/delete-message', {
            chatId: Number(input.chatId),
            messageId: input.messageId,
            providerAccountId,
        }, providerAccountId)
    },
}

export function registerMaxMessagingDeliveryCapabilityV1(): void {
    registerMaxChannelDeliveryV1(capability)
}
