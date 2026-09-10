import 'server-only'

export interface MaxTransportTextInputV1 {
    target: string
    content: string
    providerAccountId: string
    connectionId?: string
    isPersonal: boolean
    quotedMsgId?: string
    uiChatId?: string
    clientMessageId?: string
}

function exactProviderAccountId(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const normalized = value.trim()
    if (!normalized || normalized === 'legacy' || normalized === 'max-default') return null
    return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * MAX-owned, server-only transport boundary. The personal scraper must prove
 * that the requested account is the authenticated live MAX Web account.
 */
export async function sendMaxTransportTextV1(input: MaxTransportTextInputV1): Promise<Record<string, unknown>> {
    if (!input.target || !input.content) {
        throw new Error('Target (chatId or phone) and message are required')
    }
    const providerAccountId = exactProviderAccountId(input.providerAccountId)
    if (!providerAccountId) {
        throw new Error('CONTACT_CONVERSATION_PROVIDER_ACCOUNT_UNPROVEN')
    }
    if (!input.isPersonal) {
        // No live bot transport exists yet. A configured database connection is
        // not delivery proof, so bot delivery remains unavailable.
        throw new Error('MAX_BOT_DELIVERY_TRANSPORT_UNAVAILABLE')
    }
    if (input.connectionId && input.connectionId !== 'scraper' && input.connectionId !== 'max_scraper') {
        throw new Error('CONTACT_CONVERSATION_PROVIDER_TRANSPORT_MISMATCH')
    }

    const target = input.target.replace(/\D/g, '')
    if (!target) throw new Error('Invalid target')

    const scraperUrl = process.env.MAX_SCRAPER_URL || 'http://localhost:3005'
    const response = await fetch(`${scraperUrl}/send-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chatId: target,
            message: input.content,
            quotedMsgId: input.quotedMsgId,
            uiChatId: input.uiChatId,
            clientMessageId: input.clientMessageId,
            providerAccountId,
        }),
    })
    const rawPayload: unknown = await response.json().catch(() => ({}))
    const payload = isRecord(rawPayload) ? rawPayload : {}
    const error = typeof payload.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : null
    const hasExplicitError = Object.prototype.hasOwnProperty.call(payload, 'error')
        && (typeof payload.error === 'string'
            ? payload.error.trim().length > 0
            : payload.error !== null && payload.error !== undefined)
    const hasExplicitFailure = payload.success === false || payload.failed === true || payload.failure === true
    if (!response.ok || hasExplicitFailure || hasExplicitError) {
        throw new Error(error || (response.ok ? 'MAX text delivery failed' : 'Failed to send message via Scraper'))
    }
    if (exactProviderAccountId(payload.providerAccountId) !== providerAccountId) {
        throw new Error('MAX_PROVIDER_ACCOUNT_PROOF_MISMATCH')
    }
    return payload
}
