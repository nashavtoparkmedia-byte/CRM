import { sendMaxTransportTextV1 } from '@/modules/max-channel/application/messaging-transport'
import {
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

export function assertMaxTransportBindingV1(input: MaxTransportBindingV1): void {
    const providerAccountId = optionalString(input.providerAccountId)
    const connectionId = optionalString(input.connectionId)
    if (!providerAccountId || providerAccountId === 'legacy' || providerAccountId === 'max-default') {
        throw new Error('CONTACT_CONVERSATION_PROVIDER_ACCOUNT_UNPROVEN')
    }
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
    if (providerAccountId !== connectionId) {
        throw new Error('CONTACT_CONVERSATION_PROVIDER_TRANSPORT_MISMATCH')
    }
    throw new Error('MAX_BOT_DELIVERY_TRANSPORT_UNAVAILABLE')
}

function isRealMaxMessageId(value: unknown): value is string {
    return typeof value === 'string' && /^d301[0-9a-f]+$/i.test(value)
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

    const proof = isRecord(raw.deliveryProof) ? raw.deliveryProof : null
    const expectedClientMessageId = optionalString(expected.clientMessageId)
    const validatedUiProof = Boolean(
        !externalId
        && confirmationFieldsAgree
        && expectedClientMessageId
        && proof?.kind === 'ui_send_action'
        && proof.actionConfirmed === true
        && proof.clientMessageId === expectedClientMessageId,
    )
    const validatedProviderProof = Boolean(externalId && confirmationFieldsAgree)

    return {
        outcome: validatedProviderProof || validatedUiProof ? 'delivered' : 'pending',
        externalId,
        resolvedChatId,
    }
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
        assertMaxTransportBindingV1({
            providerAccountId: input.options.providerAccountId,
            connectionId: input.options.connectionId,
            isPersonal: input.options.isPersonal === true,
        })
        const raw = await sendMaxTransportTextV1({
            target: input.target,
            content: input.content,
            providerAccountId: input.options.providerAccountId,
            connectionId: input.options.connectionId,
            isPersonal: input.options.isPersonal === true,
            quotedMsgId: input.options.quotedMsgId,
            uiChatId: input.options.uiChatId,
            clientMessageId: input.options.clientMessageId,
        })
        return validateMaxTextDeliveryResultV1(raw, {
            clientMessageId: input.options?.clientMessageId,
            providerAccountId: input.options.providerAccountId,
        })
    },
    async sendMedia(input) {
        assertMaxTransportBindingV1(input)
        const payload = await post('/send-media', {
            chatId: input.chatId,
            base64: input.base64,
            filename: input.filename,
            mimeType: input.mimeType,
            caption: input.caption,
            mediaType: input.mediaType,
            providerAccountId: input.providerAccountId,
        }, input.providerAccountId)
        return { externalId: typeof payload.externalId === 'string' ? payload.externalId : undefined }
    },
    async sendReaction(input) {
        assertMaxTransportBindingV1(input)
        return sendMaxReactionDeliveryV1({
            chatId: input.chatId,
            messageId: input.messageId,
            emoji: input.emoji,
            remove: input.remove,
            providerAccountId: input.providerAccountId,
        })
    },
    async deleteMessage(input) {
        assertMaxTransportBindingV1(input)
        await post('/delete-message', {
            chatId: Number(input.chatId),
            messageId: input.messageId,
            providerAccountId: input.providerAccountId,
        }, input.providerAccountId)
    },
}

export function registerMaxMessagingDeliveryCapabilityV1(): void {
    registerMaxChannelDeliveryV1(capability)
}
