import { sendMaxMessage } from '@/app/max-actions'
import {
    registerMaxChannelDeliveryV1,
    type MaxChannelDeliveryV1,
    type MaxTextDeliveryResultV1,
} from '@/modules/messaging/public/v1/channel-delivery-runtime'
import { sendMaxReactionDeliveryV1 } from './reaction-delivery'

const scraperUrl = () => process.env.MAX_SCRAPER_URL || 'http://localhost:3005'

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null
}

function isRealMaxMessageId(value: unknown): value is string {
    return typeof value === 'string' && /^d301[0-9a-f]+$/i.test(value)
}

function validateMaxTextDeliveryResultV1(
    raw: unknown,
    expected: { clientMessageId?: string },
): MaxTextDeliveryResultV1 {
    if (!isRecord(raw)) {
        return { outcome: 'pending', externalId: null, resolvedChatId: null }
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

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`${scraperUrl()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(String(payload.error || `MAX request failed: ${response.status}`))
    return payload
}

const capability: MaxChannelDeliveryV1 = {
    async sendText(input) {
        const raw = await sendMaxMessage(input.target, input.content, input.options)
        return validateMaxTextDeliveryResultV1(raw, {
            clientMessageId: input.options?.clientMessageId,
        })
    },
    async sendMedia(input) {
        const payload = await post('/send-media', input)
        return { externalId: typeof payload.externalId === 'string' ? payload.externalId : undefined }
    },
    async sendReaction(input) {
        return sendMaxReactionDeliveryV1(input)
    },
}

export function registerMaxMessagingDeliveryCapabilityV1(): void {
    registerMaxChannelDeliveryV1(capability)
}
